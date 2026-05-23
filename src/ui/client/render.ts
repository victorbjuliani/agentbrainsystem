/**
 * The force-graph renderer (issue #11) — the hero of the UI (DESIGN §0, §11).
 *
 * Owns the canvas: a custom `nodeCanvasObject` paints luminous nodes with a glow
 * halo as elevation (DESIGN §8 — glow, not shadow), an ambient DESYNCHRONIZED
 * breathing pulse (§9 #2), and a synapse highlight on hover/select that lights
 * connected edges + neighbours and dims the rest (§9 #3). Edges are neutral and
 * subordinate to nodes (§11). All ambient motion is gated behind
 * prefers-reduced-motion.
 */
import ForceGraph from 'force-graph';
import type { NodeType } from '../graph-types.js';
import { type Box, isPointOccluded, toCanvasBox } from './occlusion.js';
import { colorForType, cssVar, withAlpha } from './palette.js';
import type { ViewEdge, ViewGraph, ViewNode } from './types.js';

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Extra px grown around each panel so a label drawn just below a node still counts
 *  as covered (the label baseline sits a few px under the node center). */
const LABEL_OCCLUSION_MARGIN = 14;

/** A panel is an occluder only while it is actually painted (the inspector lingers
 *  at opacity 0 when closed; banners carry `hidden`). */
function isPanelVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  const s = getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
}

/** Is the light theme active? Read live so a theme toggle re-routes the paint. */
function isLightTheme(): boolean {
  return document.documentElement.dataset.theme === 'light';
}

/** Stable per-node id (force-graph may pass the resolved object or the raw id). */
function endpointId(end: string | ViewNode): string {
  return typeof end === 'string' ? end : end.id;
}

export interface RendererCallbacks {
  onSelect(node: ViewNode | null): void;
}

export interface Renderer {
  setData(graph: ViewGraph): void;
  /** Visibility predicate from the type-filter pills. */
  setVisibleTypes(types: Set<NodeType>): void;
  /** Programmatically select a node (or clear with null) — drives the synapse + inspector. */
  select(node: ViewNode | null): void;
  /** Re-read palette CSS vars after a theme switch and repaint. */
  refreshTheme(): void;
  fit(): void;
  resize(w: number, h: number): void;
}

export function createRenderer(mount: HTMLElement, cb: RendererCallbacks): Renderer {
  const graph: ForceGraph<ViewNode, ViewEdge> = new ForceGraph<ViewNode, ViewEdge>(mount);

  let data: ViewGraph = { nodes: [], links: [] };
  let visibleTypes: Set<NodeType> | null = null;
  let hoverNode: ViewNode | null = null;
  let selectedNode: ViewNode | null = null;
  /** Ids one hop from the focused node (hover or selection) — the synapse set. */
  let neighbourIds = new Set<string>();
  let litLinks = new Set<ViewEdge>();
  /** Adjacency built once per dataset for O(1) neighbour lookups. */
  const adjacency = new Map<string, Set<string>>();
  const linksByNode = new Map<string, ViewEdge[]>();

  /** Floating-panel rects in canvas-screen space — refreshed once per frame so a
   *  node label that falls under a panel is suppressed instead of bleeding through
   *  the glass (DESIGN §11 follow-up). See occlusion.ts for the pure geometry. */
  let occluders: Box[] = [];

  function refreshOccluders(): void {
    const canvasEl = mount.querySelector('canvas');
    if (!canvasEl) {
      occluders = [];
      return;
    }
    const canvasRect = canvasEl.getBoundingClientRect();
    const panels = document.querySelectorAll<HTMLElement>(
      '#overlays .overlay, #status-banner, #error-banner',
    );
    const next: Box[] = [];
    for (const panel of panels) {
      if (!isPanelVisible(panel)) continue;
      const r = panel.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      next.push(toCanvasBox(r, canvasRect, LABEL_OCCLUSION_MARGIN));
    }
    occluders = next;
  }

  const t0 = performance.now();
  const elapsed = (): number => (performance.now() - t0) / 1000;

  function focused(): ViewNode | null {
    return hoverNode ?? selectedNode;
  }

  function isVisible(node: ViewNode): boolean {
    return visibleTypes === null || visibleTypes.has(node.type);
  }

  function rebuildAdjacency(): void {
    adjacency.clear();
    linksByNode.clear();
    for (const link of data.links) {
      const s = endpointId(link.source);
      const t = endpointId(link.target);
      if (!adjacency.has(s)) adjacency.set(s, new Set());
      if (!adjacency.has(t)) adjacency.set(t, new Set());
      adjacency.get(s)?.add(t);
      adjacency.get(t)?.add(s);
      if (!linksByNode.has(s)) linksByNode.set(s, []);
      if (!linksByNode.has(t)) linksByNode.set(t, []);
      linksByNode.get(s)?.push(link);
      linksByNode.get(t)?.push(link);
    }
  }

  function recomputeFocus(): void {
    const node = focused();
    neighbourIds = new Set();
    litLinks = new Set();
    if (!node) return;
    neighbourIds = new Set(adjacency.get(node.id) ?? []);
    neighbourIds.add(node.id);
    for (const link of linksByNode.get(node.id) ?? []) litLinks.add(link);
  }

  // --- Node paint -----------------------------------------------------------
  function paintNode(node: ViewNode, ctx: CanvasRenderingContext2D, scale: number): void {
    if (!isVisible(node)) return;
    const color = colorForType(node.type);
    const focusNode = focused();
    const inSynapse = focusNode !== null && neighbourIds.has(node.id);
    const isFocus = focusNode !== null && node.id === focusNode.id;

    const light = isLightTheme();

    // Dimming: synapse (§9 #3) dims non-neighbours. The floor is theme-aware: on the
    // pale light canvas a 0.22 core nearly vanishes, so light holds a higher floor.
    let dim = 1;
    if (focusNode) dim = inSynapse ? 1 : light ? 0.35 : 0.22;

    // Breathing (§9 #2): subtle scale+opacity loop, desync per node, gated by RM.
    let breath = 1;
    let breathGlow = 0;
    if (!REDUCED_MOTION) {
      const wave = Math.sin(elapsed() * node.breathRate + node.phase);
      breath = 1 + wave * 0.045; // ±4.5% scale
      breathGlow = (wave + 1) * 0.5; // 0..1
    }

    const r = node.radius * breath;
    const emphasised = isFocus || inSynapse;
    const cx = node.x ?? 0;
    const cy = node.y ?? 0;

    // Elevation (DESIGN §8): GLOW on dark, SHADOW on light.
    if (light) {
      // Soft dark shadow under the node = elevation on the pale canvas (a luminous
      // halo would just wash out). Emphasis additionally gets a low-alpha accent
      // bloom + (below) an accent rim, so the synapse still "lights up" with color.
      const shadowR = r * 1.9;
      const shadow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, shadowR);
      shadow.addColorStop(0, withAlpha('#14101b', 0.18 * dim));
      shadow.addColorStop(1, withAlpha('#14101b', 0));
      ctx.beginPath();
      ctx.fillStyle = shadow;
      ctx.arc(cx, cy, shadowR, 0, Math.PI * 2);
      ctx.fill();
      if (emphasised) {
        const bloomR = r * 2.6;
        const bloom = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, bloomR);
        bloom.addColorStop(0, withAlpha(color, 0.4 * dim));
        bloom.addColorStop(1, withAlpha(color, 0));
        ctx.beginPath();
        ctx.fillStyle = bloom;
        ctx.arc(cx, cy, bloomR, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Glow halo as elevation. Emphasis (focus/in-synapse) burns brighter + wider.
      const haloAlpha = (emphasised ? 0.65 : 0.28 + breathGlow * 0.12) * dim;
      const haloR = r * (emphasised ? 3.8 : 2.4);
      const grad = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, haloR);
      grad.addColorStop(0, withAlpha(color, haloAlpha));
      grad.addColorStop(1, withAlpha(color, 0));
      ctx.beginPath();
      ctx.fillStyle = grad;
      ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Core disc — on light, stays fully saturated/opaque (only dimmed by synapse) so
    // the type color reads against the shadow rather than a washed-out halo.
    ctx.beginPath();
    ctx.fillStyle = withAlpha(color, dim);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Accent rim on emphasised light nodes — reinforces the "lit" cue in color.
    if (light && emphasised && !isFocus) {
      ctx.beginPath();
      ctx.strokeStyle = withAlpha(color, 0.9 * dim);
      ctx.lineWidth = 1 / scale;
      ctx.arc(cx, cy, r + 0.75 / scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Bright rim on the focused node — reads as "selected".
    if (isFocus) {
      ctx.beginPath();
      ctx.strokeStyle = withAlpha(cssVar('--node-rim') || '#ffffff', 0.9);
      ctx.lineWidth = 1.5 / scale;
      ctx.arc(node.x ?? 0, node.y ?? 0, r + 1.5 / scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Label: mono, only when zoomed in enough OR the node is emphasised (§11 — labels
    // appear on hover/zoom, fade out on zoom-out to reduce noise).
    const showLabel = (scale > 1.6 || emphasised) && dim > 0.5;
    // Suppress labels that fall under a floating panel — text bleeding through the
    // glass reads as broken (DESIGN §11 follow-up). The node glow under a panel is
    // fine; only the label is hidden, and only when it would actually be covered.
    let labelOccluded = false;
    if (showLabel && occluders.length > 0) {
      const sp = graph.graph2ScreenCoords(node.x ?? 0, node.y ?? 0);
      labelOccluded = isPointOccluded(sp.x, sp.y, occluders);
    }
    if (showLabel && !labelOccluded) {
      const fontSize = Math.max(10 / scale, 2.2);
      ctx.font = `${fontSize}px 'JetBrains Mono', ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = withAlpha(cssVar('--label-fg') || '#fafaf9', dim);
      const text = node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label;
      ctx.fillText(text, node.x ?? 0, (node.y ?? 0) + r + 2 / scale);
    }
  }

  // Pointer hit area must track the *unbreathed* visible radius.
  function paintPointer(node: ViewNode, color: string, ctx: CanvasRenderingContext2D): void {
    if (!isVisible(node)) return;
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(node.x ?? 0, node.y ?? 0, node.radius + 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Link paint -------------------------------------------------------------
  function linkColor(link: ViewEdge): string {
    const base =
      link.kind === 'similarity'
        ? cssVar('--edge-similarity') || 'rgba(94,234,212,0.18)'
        : cssVar('--edge-containment') || 'rgba(196,181,253,0.15)';
    // Lit edges (synapse) brighten; if a focus exists, non-lit edges fade further.
    if (focused()) {
      if (litLinks.has(link)) return withAlpha(colorForType('assistant'), 0.7);
      return withAlpha('#c4b5fd', 0.05);
    }
    return base;
  }

  function linkWidth(link: ViewEdge): number {
    const w = link.kind === 'similarity' ? 0.4 + link.weight * 1.4 : 0.6;
    return litLinks.has(link) ? w + 1 : w;
  }

  function linkVisible(link: ViewEdge): boolean {
    const s = link.source;
    const t = link.target;
    if (typeof s === 'object' && !isVisible(s)) return false;
    if (typeof t === 'object' && !isVisible(t)) return false;
    return true;
  }

  graph
    .backgroundColor('rgba(0,0,0,0)')
    .nodeId('id')
    .nodeRelSize(1)
    // Refresh panel rects once per frame (before nodes paint) so label occlusion
    // tracks pan/zoom, resize, and the inspector opening/closing — all for free.
    .onRenderFramePre(() => refreshOccluders())
    .nodeCanvasObject(paintNode)
    .nodePointerAreaPaint(paintPointer)
    .nodeVisibility(isVisible)
    .linkColor(linkColor)
    .linkWidth(linkWidth)
    .linkVisibility(linkVisible)
    // Synapse flow pulse: particles travel along lit edges (the "signal traveling").
    .linkDirectionalParticles((l: ViewEdge) => (!REDUCED_MOTION && litLinks.has(l) ? 2 : 0))
    .linkDirectionalParticleWidth(1.6)
    .linkDirectionalParticleSpeed((l: ViewEdge) => 0.006 + (l.weight ?? 0.5) * 0.004)
    .linkDirectionalParticleColor(() => withAlpha(colorForType('assistant'), 0.9))
    .onNodeHover((node) => {
      hoverNode = node ?? null;
      mount.style.cursor = node ? 'pointer' : 'grab';
      recomputeFocus();
    })
    .onNodeClick((node) => {
      selectedNode = node;
      recomputeFocus();
      cb.onSelect(node);
    })
    .onBackgroundClick(() => {
      selectedNode = null;
      recomputeFocus();
      cb.onSelect(null);
    });

  // Looser charge so the organism spreads out and keeps a gentle drift (§9 #1).
  const charge = graph.d3Force('charge');
  // ForceFn is an indexable interface; d3-force's charge exposes `.strength()`.
  if (typeof charge?.strength === 'function') charge.strength(-120);
  graph.d3VelocityDecay(0.28);
  // force-graph repaints on its own rAF loop every frame, so nodeCanvasObject runs
  // continuously and the breathing/particles animate without a manual ticker. A long
  // cooldown keeps the physics gently alive (the graph never fully freezes, §9 #1);
  // under reduced motion we let it settle fast and rely on functional repaints only.
  graph.cooldownTime(REDUCED_MOTION ? 3000 : 30000);

  return {
    setData(next: ViewGraph): void {
      data = next;
      selectedNode = null;
      hoverNode = null;
      rebuildAdjacency();
      recomputeFocus();
      graph.graphData(data);
      // Fit once the initial layout has had a moment to expand.
      window.setTimeout(() => graph.zoomToFit(400, 60), REDUCED_MOTION ? 50 : 600);
    },
    setVisibleTypes(types: Set<NodeType>): void {
      visibleTypes = types;
      graph.nodeVisibility(isVisible);
    },
    select(node: ViewNode | null): void {
      selectedNode = node;
      recomputeFocus();
      if (node && node.x !== undefined && node.y !== undefined) {
        graph.centerAt(node.x, node.y, 400);
        graph.zoom(Math.max(graph.zoom(), 2.2), 400);
      }
    },
    refreshTheme(): void {
      // Nudge the render loop so the canvas repaints with the new palette CSS vars
      // (matters under reduced motion, where the loop would otherwise be settled).
      graph.resumeAnimation();
    },
    fit(): void {
      graph.zoomToFit(400, 60);
    },
    resize(w: number, h: number): void {
      graph.width(w).height(h);
    },
  };
}
