/**
 * Builds the isolated scaffold the live Claude Code smoke runs against — mirrors the
 * Step-0 spike: a throwaway store (ABS_HOME) + a copy of the fixture project + a
 * settings.json whose hooks point at the BUILT binary. HOME is left intact (auth), so
 * isolation is store + settings only.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../..');
export const CLI = resolve(REPO_ROOT, 'dist/cli/cli.js');
const FIXTURE_SRC = resolve(HERE, 'fixture-project');

export interface LiveScaffold {
  proj: string;
  absHome: string;
  settingsPath: string;
  /** Count observations in the isolated store (capture gate). */
  observationCount(): number;
  cleanup(): void;
}

/** Build an isolated store + project copy + settings.json pointing at the BUILT binary. */
export function makeScaffold(): LiveScaffold {
  const root = mkdtempSync(join(tmpdir(), 'abs-live-'));
  const absHome = join(root, 'abs');
  const proj = join(root, 'proj');
  mkdirSync(absHome, { recursive: true });
  cpSync(FIXTURE_SRC, proj, { recursive: true });
  const settingsPath = join(root, 'settings.json');
  const cmd = (event: string) => `node ${CLI} hook ${event}`;
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionEnd: [
          { matcher: '', hooks: [{ type: 'command', command: cmd('session-end'), timeout: 30 }] },
        ],
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: cmd('user-prompt-submit'), timeout: 10 }],
          },
        ],
      },
    }),
  );
  return {
    proj,
    absHome,
    settingsPath,
    observationCount(): number {
      const out = execFileSync('node', [CLI, 'status'], {
        env: { ...process.env, ABS_HOME: absHome },
        encoding: 'utf8',
      });
      const m = out.match(/"observations":\s*(\d+)/);
      return m ? Number(m[1]) : 0;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
