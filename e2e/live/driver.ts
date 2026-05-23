/**
 * The ONLY unit that knows the `claude` CLI. Spawns a real headless session with the
 * store + hooks isolated (ABS_HOME + merged --settings; HOME left intact so auth works —
 * proven in the Step-0 spike) and parses `--output-format stream-json
 * --include-hook-events` into typed fields.
 */
import { spawn } from 'node:child_process';

const FENCE = '<recalled-memory>';

export interface StreamEvents {
  /** additionalContext injected by the UserPromptSubmit hook (the recalled-memory block), if any. */
  promptSubmitInjection?: string;
  /** Concatenated assistant text turns. */
  assistantText: string;
  /** The final `result` payload text. */
  resultText: string;
  /** Every hook_event name seen (for asserting the hook fired). */
  hookEvents: string[];
}

/** Pull additionalContext out of a hook_response `output` (a JSON string). */
function extractInjection(output: unknown): string | undefined {
  if (typeof output !== 'string') return undefined;
  try {
    const o = JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: string } };
    return o.hookSpecificOutput?.additionalContext;
  } catch {
    return undefined;
  }
}

/**
 * Parse newline-delimited stream-json. Tolerant: blank/garbage lines are skipped.
 *
 * `--settings` MERGES onto the user's real settings, so several UserPromptSubmit hooks
 * may fire; only agentbrainsystem's carries the recalled-memory fence. We therefore keep
 * the injection that contains the fence and never let a fence-less one overwrite it.
 */
export function parseStream(raw: string): StreamEvents {
  const ev: StreamEvents = { assistantText: '', resultText: '', hookEvents: [] };
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type === 'system' && o.subtype === 'hook_response') {
      const name = String(o.hook_event ?? '');
      if (name) ev.hookEvents.push(name);
      if (name === 'UserPromptSubmit') {
        const inj = extractInjection(o.output);
        // Prefer the fenced (recalled-memory) injection; never overwrite it with a
        // fence-less one from another merged hook.
        if (inj && (!ev.promptSubmitInjection || inj.includes(FENCE))) {
          if (!ev.promptSubmitInjection?.includes(FENCE)) ev.promptSubmitInjection = inj;
        }
      }
    } else if (o.type === 'assistant') {
      const content =
        (o.message as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
      for (const c of content) if (c.type === 'text' && c.text) ev.assistantText += `${c.text}\n`;
    } else if (o.type === 'result') {
      ev.resultText = String((o as { result?: unknown }).result ?? '');
    }
  }
  return ev;
}

export interface RunOptions {
  prompt: string;
  cwd: string;
  absHome: string;
  settingsPath: string;
  /** Defaults to `haiku`. */
  model?: string;
  /** Add stream-json + hook events (Session B). Session A omits it. */
  streamHooks?: boolean;
  /**
   * Appended to the system prompt. Used to pin the answer language (the spawned `claude`
   * otherwise inherits the user's global CLAUDE.md, which may force another language).
   */
  appendSystemPrompt?: string;
}

export interface RunResult {
  raw: string;
  code: number;
  events: StreamEvents;
}

/** Spawn one real `claude -p` session. Returns raw stdout + parsed events. */
export function runClaude(opts: RunOptions): Promise<RunResult> {
  const args = [
    '-p',
    opts.prompt,
    '--model',
    opts.model ?? 'haiku',
    '--settings',
    opts.settingsPath,
    '--mcp-config',
    '{"mcpServers":{}}',
    '--strict-mcp-config',
  ];
  if (opts.appendSystemPrompt) {
    args.push('--append-system-prompt', opts.appendSystemPrompt);
  }
  if (opts.streamHooks) {
    args.push('--output-format', 'stream-json', '--include-hook-events', '--verbose');
  }
  // Isolate the store: ABS_HOME points hooks at the scaffold, but ABS_DB_PATH takes
  // PRIORITY over ABS_HOME in loadConfig (config.ts) — a leaked parent ABS_DB_PATH would
  // make the spawned hooks write to that external DB (mutating real data, invalidating the
  // result). Strip it (and the LLM vars) so the scaffold is the only store, matching the
  // e2e/harness.ts hygiene.
  const env: NodeJS.ProcessEnv = { ...process.env, ABS_HOME: opts.absHome };
  for (const k of ['ABS_DB_PATH', 'ABS_LLM_BASE_URL', 'ABS_LLM_MODEL', 'ABS_LLM_API_KEY']) {
    delete env[k];
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn('claude', args, { cwd: opts.cwd, env });
    let raw = '';
    child.stdout.on('data', (d) => {
      raw += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // `null` means the child was killed by a signal, not a clean exit — surface it as a
      // non-zero code so a signal-aborted session fails the certification deterministically
      // instead of being read as success (the GIF capture does not assert exit codes).
      resolvePromise({ raw, code: code ?? -1, events: parseStream(raw) });
    });
  });
}
