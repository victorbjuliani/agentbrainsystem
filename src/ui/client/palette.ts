/**
 * The graph's color taxonomy (issue #11, DESIGN §4 / §11). One source of truth
 * for node-type to accent so the canvas paint, the filter pills, and the legend
 * never drift. Colors are read from CSS custom properties at runtime so a theme
 * toggle recolors the canvas without hardcoded hex in the renderer (DESIGN §10:
 * no inline hex outside the palette).
 */
import type { NodeType } from '../graph-types.js';
import type { TypeMeta } from './types.js';

/**
 * Taxonomy in render/legend order. Every type is conditional: a pill is active
 * when the current payload holds nodes of that type and dims (`pill-absent`) when
 * it does not (see overlays `syncFromData`). `lesson`/`decision` are populated by
 * `consolidate` (#12) and surface here once present (#35).
 */
export const TAXONOMY: readonly TypeMeta[] = [
  { type: 'session', label: 'session', cssVar: '--accent-session' },
  { type: 'user', label: 'user', cssVar: '--accent-user' },
  { type: 'assistant', label: 'assistant', cssVar: '--accent-assistant' },
  { type: 'tool', label: 'tool', cssVar: '--accent-tool' },
  { type: 'lesson', label: 'lesson', cssVar: '--accent-lesson' },
  { type: 'decision', label: 'decision', cssVar: '--accent-decision' },
] as const;

const VAR_BY_TYPE: Record<NodeType, string> = {
  session: '--accent-session',
  user: '--accent-user',
  assistant: '--accent-assistant',
  tool: '--accent-tool',
  lesson: '--accent-lesson',
  decision: '--accent-decision',
};

/** Resolve a CSS custom property off :root to its computed value (a hex/oklch string). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The accent hex for a node type, read live from CSS so theme swaps are honored. */
export function colorForType(type: NodeType): string {
  return cssVar(VAR_BY_TYPE[type]) || '#8b5cf6';
}

/**
 * Convert a `#rrggbb` (or `#rgb`) hex to `rgba(r,g,b,a)`. Used for halos/dimming
 * where we need an alpha channel the canvas understands regardless of source
 * color space. Falls back to the input string if it is not a hex we recognize.
 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) return hex;
  let h = m[1];
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
