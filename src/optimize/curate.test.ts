/**
 * Curation heuristic tests (#146) — the $0/offline durability spine.
 *
 * Table-driven against the REAL ground-truth examples from the owner's store: the
 * heuristic must DROP the mechanical trivia shapes (install one-offs, action/event
 * logs) and KEEP genuinely durable decisions/lessons — including the deliberately
 * hard cases (a durable decision that cites an issue number; a durable decision
 * that uses past-tense "migrated"). The semantic tool-config cluster (CodeRabbit)
 * is intentionally KEPT by the heuristic — that is the LLM-judge's job (see
 * llm-judge.test.ts), so this suite asserts the heuristic does NOT brittly
 * denylist it.
 */
import { describe, expect, it } from 'vitest';
import type { Observation } from '../store/index.js';
import { curateObservations, scoreDurability } from './curate.js';

let nextId = 1;
function obs(content: string, kind: 'decision' | 'lesson' = 'decision'): Observation {
  return {
    id: nextId++,
    sessionId: 1,
    kind,
    content,
    source: 'consolidate',
    createdAt: '2026-06-15T00:00:00.000Z',
  };
}

describe('scoreDurability — heuristic spine', () => {
  describe('DURABLE → keep (verdict: durable)', () => {
    const durable: Array<[string, string]> = [
      [
        'Coupa OAuth migration (past-tense "migrated", no #ref)',
        'Coupa API Keys are deprecated. All Coupa API authentication was migrated to OAuth 2.0 Client Credentials grant type (D18), using native HTTP Connector OAuth capabilities for token management.',
      ],
      [
        'naming convention',
        "Standardized the company name as 'PG Consulting' for all client-facing and internal documentation, explicitly avoiding 'PG Consultoria' to ensure consistency.",
      ],
      [
        'architecture migration with a D-ref (not a #ref)',
        'The correlation mechanism for SolFirmaId was migrated from Mule Object Store to Coupa Custom Object ID 28 due to platform requirements (D17).',
      ],
      [
        'architecture principle',
        'Decouple the user interface/channel from the core backend logic to overcome immediate integration blockers.',
      ],
      [
        'durable lesson',
        'Relying on hardcoded defaults for critical configurations makes the effective configuration opaque and uncontrollable; always prefer explicit environment variables.',
      ],
      // BORDERLINE-DURABLE (product-review adj. #3): a real decision that CITES an issue
      // number must SURVIVE — guards against action-log over-firing on issue-ref alone.
      [
        'decision citing an issue number',
        'Adopted the worktree-isolation strategy over in-place edits to fix the regression in #321.',
      ],
      // SEED REGRESSION GUARD (W4): the existing integration seed must keep scoring durable,
      // or optimize.integration.test.ts breaks. "Chose" must NOT be an action-log verb.
      ['seed decision', 'Chose SQLite + sqlite-vec over a separate vector DB'],
      ['seed lesson', 'vec0 rowid must be bound as BigInt or it is rejected'],
      // Tool-config cluster: heuristic KEEPS these (judge territory) — proves no brittle denylist.
      [
        "CodeRabbit 'Chill' profile",
        "Configure CodeRabbit with a 'Chill' profile when another assertive AI reviewer is active.",
      ],
      [
        'CodeRabbit config-as-code',
        "Prioritize CodeRabbit's configuration-as-code (.coderabbit.yaml) over UI settings for versioning and portability.",
      ],
      [
        'CodeRabbit disable cosmetics',
        "Disable cosmetic features like 'poem' and 'in_progress_fortune' in CodeRabbit to keep PR threads clean.",
      ],
      [
        'CodeRabbit enable prompts',
        'Enable enable_prompt_for_ai_agents in CodeRabbit so other AI agents can read its inline comments.',
      ],
    ];
    it.each(durable)('keeps: %s', (_label, content) => {
      expect(scoreDurability(obs(content)).verdict).toBe('durable');
    });
  });

  describe('TRIVIA → drop via install-oneoff', () => {
    const items: Array<[string, string, string]> = [
      [
        '.dmg / installer',
        'For Tray app installation on Apple Silicon, the specific installer to use is the `aarch64.dmg` package.',
        'install-oneoff',
      ],
      [
        'quarantine xattr',
        'On macOS, removing the com.apple.quarantine extended attribute is required for the application to launch.',
        'install-oneoff',
      ],
      [
        'restart Claude Code',
        'Post-update, restarting Claude Code is a mandatory step to ensure new configurations are loaded.',
        'install-oneoff',
      ],
    ];
    it.each(items)('drops: %s', (_label, content, signal) => {
      const r = scoreDurability(obs(content));
      expect(r.verdict).toBe('trivia');
      expect(r.signals).toContain(signal);
    });
  });

  describe('TRIVIA → drop via action-log', () => {
    const items: Array<[string, string]> = [
      [
        'quantified "successfully published"',
        'All 5 client application packages were successfully published to the client Bitbucket repositories, incorporating the latest VOLTA implementation.',
      ],
      [
        'prioritized remediation with #refs',
        'Prioritized immediate remediation of a critical production bug over merging an existing PR, leading to a superseding solution (#968 & #970 over #955).',
      ],
    ];
    it.each(items)('drops: %s', (_label, content) => {
      const r = scoreDurability(obs(content));
      expect(r.verdict).toBe('trivia');
      expect(r.signals).toContain('action-log');
    });

    it('does NOT fire on a durable decision that merely cites one issue (no completion verb)', () => {
      const r = scoreDurability(
        obs('Adopted the X approach over Y to fix the regression in #321.'),
      );
      expect(r.verdict).toBe('durable');
    });
  });
});

describe('curateObservations — heuristic-only (no LLM)', () => {
  it('keeps durable, drops trivia, and reports store-wide counts', async () => {
    nextId = 1;
    const durable1 = obs('Chose SQLite + sqlite-vec over a separate vector DB');
    const trivia1 = obs('Uninstalled the CodeRabbit plugin due to data governance risks.');
    const durable2 = obs('Standardized the company name as PG Consulting.');
    const trivia2 = obs('Use the `aarch64.dmg` installer on Apple Silicon.');
    const all = [durable1, trivia1, durable2, trivia2];

    const { keep, estimate } = await curateObservations(all, {});

    expect(keep.has(durable1.id)).toBe(true);
    expect(keep.has(durable2.id)).toBe(true);
    expect(keep.has(trivia1.id)).toBe(false);
    expect(keep.has(trivia2.id)).toBe(false);
    expect(estimate.keptCount).toBe(2);
    expect(estimate.droppedCount).toBe(2);
    expect(estimate.judgeUsed).toBe(false);
    expect(estimate.usage).toBeUndefined();
  });

  it('empty input → empty keep, zero counts, no judge', async () => {
    const { keep, estimate } = await curateObservations([], {});
    expect(keep.size).toBe(0);
    expect(estimate).toMatchObject({ keptCount: 0, droppedCount: 0, judgeUsed: false });
  });
});
