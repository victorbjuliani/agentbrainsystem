/**
 * Gated apply — the ONLY thing in the optimize engine that writes to a real file,
 * and therefore the highest-blast-radius code in the project (issue #20).
 *
 * It applies a SINGLE already-approved candidate at a time (the interactive
 * approval UX is #21's job; the contract here is "apply receives one approved
 * candidate"). Every edit is wrapped in the same write-safety envelope:
 *
 *   1. ALLOWLIST  — resolve the candidate's target through `resolveTarget`. Only a
 *      project CLAUDE.md or an auto-memory entry under the project's memory dir is
 *      ever writable; anything else is REFUSED (returns `forbidden-target`).
 *   2. FAIL-CLOSED GUARD — for an existing auto-memory entry whose frontmatter
 *      `metadata.type` is `user` or `feedback`, REFUSE (`protected-memory-type`).
 *      A refusal is explicit, never a silent skip (see ADR-0006).
 *   3. BACKUP — copy the current file to `<file>.abs-bak-<ts>` before any change.
 *   4. ATOMIC WRITE — write the new content to a temp file in the same dir, then
 *      `rename` it into place (atomic on the same filesystem).
 *   5. ROLLBACK — on ANY failure mid-operation, restore from the backup so the
 *      original file is left intact (or removed again if it did not exist before).
 *
 * Diffs from #18 are append-only, so applying = current content + the candidate's
 * `proposedText`. We re-read the current content at apply time and confirm it still
 * matches what the diff was generated against (a hash/length check), refusing with
 * `target-modified` if the file changed underneath us — never blindly clobbering.
 */
import { constants as FS } from 'node:fs';
import * as nodeFsp from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isProtectedMemoryType, parseFrontmatterType, resolveTarget } from './targets.js';
import type { ApplyResult, OptimizeCandidate } from './types.js';

/**
 * The minimal filesystem surface the applier needs. Injectable so a test can make
 * the atomic `rename` (or any step) fail and assert the original file is left
 * intact — without monkey-patching the read-only `node:fs/promises` namespace.
 * Defaults to the real Node API.
 */
export interface ApplierFs {
  stat: typeof nodeFsp.stat;
  /** `lstat` (does NOT follow symlinks) — used to refuse a symlinked target. */
  lstat: typeof nodeFsp.lstat;
  readFile: typeof nodeFsp.readFile;
  writeFile: typeof nodeFsp.writeFile;
  copyFile: typeof nodeFsp.copyFile;
  /** `chmod` — used to lock the backup down to 0o600 (a copy of a sensitive file). */
  chmod: typeof nodeFsp.chmod;
  rename: typeof nodeFsp.rename;
  mkdir: typeof nodeFsp.mkdir;
  rm: typeof nodeFsp.rm;
  /** `readdir` — used to prune old `.abs-bak-*` backups down to the retention cap. */
  readdir: typeof nodeFsp.readdir;
}

/** The real Node filesystem, used unless a test injects a seam. */
const DEFAULT_FS: ApplierFs = {
  stat: nodeFsp.stat,
  lstat: nodeFsp.lstat,
  readFile: nodeFsp.readFile,
  writeFile: nodeFsp.writeFile,
  copyFile: nodeFsp.copyFile,
  chmod: nodeFsp.chmod,
  rename: nodeFsp.rename,
  mkdir: nodeFsp.mkdir,
  rm: nodeFsp.rm,
  readdir: nodeFsp.readdir,
};

/**
 * Keep at most this many `.abs-bak-*` copies per file. Each backup is a plaintext
 * copy of a possibly-sensitive file (CLAUDE.md / auto-memory); without a cap they
 * accumulate next to the original forever (#114). Five is enough to recover from a
 * bad recent apply while bounding the on-disk sprawl of secrets.
 */
export const MAX_BACKUPS_PER_FILE = 5;

/** Options the applier needs to resolve + guard a candidate's target. */
export interface ApplyOptions {
  /** Project root whose CLAUDE.md / auto-memory dir are the only legal targets. */
  projectRoot: string;
  /** Claude Code projects root (defaults to `~/.claude/projects` in the caller). */
  projectsDir: string;
  /**
   * The content the candidate's diff was generated against. When provided, the
   * applier refuses (`target-modified`) if the file no longer matches it, so a
   * stale candidate cannot clobber a file edited since generation. Optional: when
   * omitted the current content is appended to as-is.
   */
  expectedBaseContent?: string;
}

/** The applier contract #21 wires the CLI/MCP into. */
export interface Applier {
  apply(candidate: OptimizeCandidate, options: ApplyOptions): Promise<ApplyResult>;
}

/**
 * The single concrete applier behind the `Applier` interface. The two "appliers"
 * the issue asks for (CLAUDE.md + auto-memory) are not two classes — they are the
 * two target KINDS this one applier resolves and writes, with identical
 * write-safety. Splitting them into separate classes would duplicate the
 * backup/atomic/rollback envelope, the riskiest code, for no benefit.
 */
export class GatedApplier implements Applier {
  private readonly fs: ApplierFs;

  /** Inject a filesystem seam for tests; defaults to the real Node API. */
  constructor(fs: ApplierFs = DEFAULT_FS) {
    this.fs = fs;
  }

  /** Whether a path currently exists (file or dir). */
  private async exists(absPath: string): Promise<boolean> {
    try {
      await this.fs.stat(absPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Read a file or return '' when it does not exist (read errors propagate). */
  private async readOrEmpty(absPath: string): Promise<string> {
    try {
      return await this.fs.readFile(absPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  /**
   * Whether the path is itself a symlink (does NOT follow it). Target resolution is
   * purely lexical (`path.resolve`), so a pre-planted symlink at the target would be
   * silently followed by copyFile+rename and write through to its destination
   * (e.g. ~/.ssh/authorized_keys). We refuse such targets. A non-existent path is
   * not a symlink (ENOENT → false); any other lstat error propagates.
   */
  private async isSymlink(absPath: string): Promise<boolean> {
    try {
      return (await this.fs.lstat(absPath)).isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async apply(candidate: OptimizeCandidate, options: ApplyOptions): Promise<ApplyResult> {
    // 1. Allowlist — refuse anything outside the two permitted target kinds.
    const resolved = resolveTarget(candidate.target, options.projectRoot, options.projectsDir);
    if (resolved === null) {
      return { applied: false, absPath: candidate.target.absPath, refused: 'forbidden-target' };
    }
    const absPath = resolved.absPath;

    // 1b. Symlink refusal — resolution above is purely lexical, so a symlink planted
    // at the target would be followed on write. Refuse explicitly BEFORE any backup
    // or write (never follow it, never write through to its destination).
    if (await this.isSymlink(absPath)) {
      return { applied: false, absPath, refused: 'symlink-target' };
    }

    const fileExists = await this.exists(absPath);
    const current = fileExists ? await this.readOrEmpty(absPath) : '';

    // 2. Fail-closed guard — refuse a user|feedback auto-memory entry EXPLICITLY.
    if (resolved.kind === 'auto-memory' && fileExists) {
      const type = parseFrontmatterType(current);
      if (isProtectedMemoryType(type)) {
        return { applied: false, absPath, refused: 'protected-memory-type' };
      }
    }

    // Stale-candidate guard — refuse if the file changed since generation.
    if (options.expectedBaseContent !== undefined && current !== options.expectedBaseContent) {
      return { applied: false, absPath, refused: 'target-modified' };
    }

    // Append-only: new content = current + the candidate's proposed block.
    const nextContent = current + candidate.proposedText;

    return this.writeSafely(absPath, current, nextContent, fileExists);
  }

  /**
   * Perform the backup -> atomic-write -> (rollback-on-failure) envelope. On
   * success returns the backup path. On ANY failure the original file is restored
   * (or removed, if it did not exist before) and the error is rethrown.
   */
  private async writeSafely(
    absPath: string,
    originalContent: string,
    nextContent: string,
    fileExisted: boolean,
  ): Promise<ApplyResult> {
    const dir = dirname(absPath);
    await this.fs.mkdir(dir, { recursive: true });

    const stamp = `${Date.now()}-${process.pid}`;
    const backupPath = fileExisted ? `${absPath}.abs-bak-${stamp}` : undefined;
    const tempPath = join(dir, `.abs-tmp-${stamp}`);

    // BACKUP first (only when there is an original to back up). The backup is a copy
    // of a possibly-sensitive file (CLAUDE.md / memory), so lock it to 0o600 rather
    // than inheriting the source mode under a loose umask.
    if (backupPath) {
      await this.fs.copyFile(absPath, backupPath, FS.COPYFILE_EXCL);
      await this.fs.chmod(backupPath, 0o600);
    }

    try {
      // ATOMIC WRITE: write temp, then rename into place (same-dir = atomic).
      await this.fs.writeFile(tempPath, nextContent, { encoding: 'utf8', mode: 0o644 });
      await this.fs.rename(tempPath, absPath);
    } catch (err) {
      // ROLLBACK — leave the original file exactly as it was.
      await this.rollback(absPath, tempPath, backupPath, fileExisted, originalContent);
      throw err;
    }

    // Write succeeded → prune older backups for this file down to the cap so
    // plaintext copies of sensitive files don't accumulate forever (#114). The
    // just-created backup is the newest and is always kept.
    if (backupPath) await this.pruneBackups(absPath);

    return backupPath ? { applied: true, absPath, backupPath } : { applied: true, absPath };
  }

  /**
   * Delete all but the newest {@link MAX_BACKUPS_PER_FILE} `<file>.abs-bak-*`
   * copies in the file's directory. The suffix begins with `Date.now()`, so a
   * lexicographic sort of the fixed-width millisecond stamp is chronological.
   * Best-effort: a failure here never affects the (already-committed) write.
   */
  private async pruneBackups(absPath: string): Promise<void> {
    const dir = dirname(absPath);
    const prefix = `${basename(absPath)}.abs-bak-`;
    try {
      const backups = (await this.fs.readdir(dir)).filter((name) => name.startsWith(prefix)).sort(); // ascending → oldest first
      const excess = backups.length - MAX_BACKUPS_PER_FILE;
      for (let i = 0; i < excess; i++) {
        await this.fs.rm(join(dir, backups[i] as string), { force: true }).catch(() => {});
      }
    } catch {
      // readdir failed (e.g. dir vanished) — pruning is non-critical, never throw.
    }
  }

  /**
   * Restore the original on a mid-write failure: drop the temp file, then either
   * restore from the backup (file existed) or remove the target (it did not). A
   * best-effort second restore from the captured `originalContent` covers the rare
   * case where the rename half-succeeded.
   */
  private async rollback(
    absPath: string,
    tempPath: string,
    backupPath: string | undefined,
    fileExisted: boolean,
    originalContent: string,
  ): Promise<void> {
    await this.fs.rm(tempPath, { force: true }).catch(() => {});

    if (fileExisted && backupPath) {
      // Restore the byte-for-byte backup over whatever is at absPath now.
      try {
        await this.fs.copyFile(backupPath, absPath);
      } catch {
        // Last resort: rewrite the captured original content.
        await this.fs.writeFile(absPath, originalContent, 'utf8').catch(() => {});
      }
      await this.fs.rm(backupPath, { force: true }).catch(() => {});
    } else if (!fileExisted) {
      // The file did not exist before — ensure we leave nothing behind.
      await this.fs.rm(absPath, { force: true }).catch(() => {});
    }
  }
}
