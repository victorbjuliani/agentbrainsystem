/**
 * Target resolution + allowlist — the safety boundary for WHERE the optimize
 * engine may write (issues #18, #20).
 *
 * The engine may touch EXACTLY two kinds of file and nothing else:
 *   1. a project's root `CLAUDE.md`
 *   2. a Claude Code auto-memory entry under
 *      `~/.claude/projects/<slug>/memory/<name>.md`
 * where `<slug>` is the Claude Code project slug = the absolute project path with
 * every `/` replaced by `-` (e.g. `/Users/x/Devs/abs` -> `-Users-x-Devs-abs`). This
 * mirrors the same encoding the ingest layer reads from.
 *
 * `resolveTarget` is the allowlist resolver: it recomputes the canonical absolute
 * path for a candidate's declared kind and refuses (returns null) if the
 * candidate's `absPath` is not byte-identical to it. So a candidate that points at
 * source code / AGENTS.md / an arbitrary doc — even one that LOOKS like one of the
 * two kinds — cannot be applied. This is enforced in code AND tested (#20).
 *
 * Auto-memory entries are markdown with YAML frontmatter carrying
 * `metadata.type: user | feedback | project | reference`. `parseFrontmatterType`
 * extracts that type with a tiny, dependency-free reader (the frontmatter we read
 * is simple key/value + a one-level `metadata:` block — no need for a YAML dep,
 * keeping the module $0/offline). The fail-closed guard (#20) refuses to touch a
 * `user` / `feedback` entry.
 */
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { AutoMemoryType, OptimizeTarget } from './types.js';

/** The fixed basename of a project's instruction file. */
const CLAUDE_MD = 'CLAUDE.md';
/** Auto-memory entries live under `<slug>/memory/`. */
const MEMORY_SUBDIR = 'memory';
/** Auto-memory frontmatter types the engine MUST refuse to modify (fail-closed). */
export const PROTECTED_MEMORY_TYPES: ReadonlySet<AutoMemoryType> = new Set(['user', 'feedback']);

/**
 * Compute the Claude Code project slug for an absolute project path: replace every
 * path separator with `-`. The path is resolved first so a relative input or a
 * trailing slash cannot produce a different slug than ingest would.
 */
export function projectSlug(projectRoot: string): string {
  const abs = resolve(projectRoot);
  return abs.split(sep).join('-');
}

/** Canonical absolute path to a project's root CLAUDE.md. */
export function claudeMdPath(projectRoot: string): string {
  return join(resolve(projectRoot), CLAUDE_MD);
}

/** Canonical absolute path to the project's auto-memory directory. */
export function autoMemoryDir(projectRoot: string, projectsDir: string): string {
  return join(resolve(projectsDir), projectSlug(projectRoot), MEMORY_SUBDIR);
}

/** Canonical absolute path to one named auto-memory entry. */
export function autoMemoryEntryPath(
  projectRoot: string,
  projectsDir: string,
  name: string,
): string {
  return join(autoMemoryDir(projectRoot, projectsDir), name);
}

/**
 * Allowlist resolver. Given a candidate's declared target plus the project context,
 * recompute the canonical path for the declared KIND and confirm the candidate's
 * `absPath` matches it exactly. Returns the (validated) target on success, or null
 * when the candidate points anywhere outside the two permitted kinds.
 *
 * For `auto-memory` the candidate may target any *.md inside the project's memory
 * dir, but it must stay strictly within that dir (no `..` escape) — checked by
 * resolving and confirming the canonical memory dir is a path prefix.
 */
export function resolveTarget(
  target: OptimizeTarget,
  projectRoot: string,
  projectsDir: string,
): OptimizeTarget | null {
  if (!isAbsolute(target.absPath)) return null;
  const candidatePath = resolve(target.absPath);

  if (target.kind === 'claude-md') {
    return candidatePath === claudeMdPath(projectRoot)
      ? { ...target, absPath: candidatePath }
      : null;
  }

  if (target.kind === 'auto-memory') {
    const dir = autoMemoryDir(projectRoot, projectsDir);
    const withinDir = candidatePath === dir || candidatePath.startsWith(dir + sep);
    if (!withinDir || !candidatePath.endsWith('.md')) return null;
    return { ...target, absPath: candidatePath };
  }

  // Unknown kind — refuse. (Exhaustiveness guard for future kinds.)
  return null;
}

/**
 * Extract the `metadata.type` from a markdown file's YAML frontmatter, or
 * `undefined` when there is no frontmatter or no type. Dependency-free: handles
 * both an inline `type:` at the top level (rare) and the canonical one-level
 * `metadata:` block:
 *
 *   ---
 *   metadata:
 *     type: user
 *   ---
 *
 * Anything that is not one of the four known types yields `undefined`.
 */
export function parseFrontmatterType(fileContent: string): AutoMemoryType | undefined {
  const fm = extractFrontmatter(fileContent);
  if (fm === null) return undefined;

  let inMetadata = false;
  for (const rawLine of fm.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    // Enter/exit the `metadata:` block by indentation.
    if (indent === 0) {
      inMetadata = /^metadata\s*:\s*$/.test(trimmed);
      // A top-level `type: x` (uncommon) is also honoured.
      const top = matchType(trimmed);
      if (top) return top;
      continue;
    }
    if (inMetadata) {
      const nested = matchType(trimmed);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** True when a memory entry's frontmatter type is one the engine must NOT modify. */
export function isProtectedMemoryType(type: AutoMemoryType | undefined): boolean {
  return type !== undefined && PROTECTED_MEMORY_TYPES.has(type);
}

/** Pull the YAML frontmatter body (between the leading `---` fences), or null. */
function extractFrontmatter(content: string): string | null {
  const normalised = content.replace(/^﻿/, '');
  if (!normalised.startsWith('---')) return null;
  const lines = normalised.split('\n');
  // First line must be exactly the opening fence.
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      return lines.slice(1, i).join('\n');
    }
  }
  return null; // unterminated frontmatter — treat as none
}

/** Parse a `type: <value>` line into a known AutoMemoryType, else undefined. */
function matchType(line: string): AutoMemoryType | undefined {
  const m = /^type\s*:\s*["']?([a-zA-Z]+)["']?\s*$/.exec(line);
  if (!m) return undefined;
  const value = m[1]?.toLowerCase();
  if (value === 'user' || value === 'feedback' || value === 'project' || value === 'reference') {
    return value;
  }
  return undefined;
}
