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
import { colorForType, cssVar, withAlpha } from './palette.js';
import type { ViewEdge, ViewGraph, ViewNode } from './types.js';

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Map sizeDriver to a world radius with a gentle sqrt curve — sessions read a touch
 * larger as hubs, but no giant outliers (DESIGN §11). Exported so main.ts derives
 * the same radius when projecting the wire payload (one source of truth).
 */
export function radiusFor(type: NodeType, sizeDriver: number): number {
  const base = type === 'session' ? 5 : 3;
  return base + Math.sqrt(Math.max(0, sizeDriver)) * 1.6;
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

    // Dimming: synapse (§9 #3) dims non-neighbours ~40%.
    let dim = 1;
    if (focusNode) dim = inSynapse ? 1 : 0.4;

    // Breathing (§9 #2): subtle scale+opacity loop, desync per node, gated by RM.
    let breath = 1;
    let breathGlow = 0;
    if (!REDUCED_MOTION) {
      const wave = Math.sin(elapsed() * node.breathRate + node.phase);
      breath = 1 + wave * 0.045; // ±4.5% scale
      breathGlow = (wave + 1) * 0.5; // 0..1
    }

    const r = node.radius * breath;

    // Glow halo as elevation (DESIGN §8). Emphasis when focused/in-synapse; ambient otherwise.
    const emphasised = isFocus || inSynapse;
    const haloAlpha = (emphasised ? 0.55 : 0.28 + breathGlow * 0.12) * dim;
    const haloR = r * (emphasised ? 3.4 : 2.4);
    const grad = ctx.createRadialGradient(
      node.x ?? 0,
      node.y ?? 0,
      r * 0.4,
      node.x ?? 0,
      node.y ?? 0,
      haloR,
    );
    grad.addColorStop(0, withAlpha(color, haloAlpha));
    grad.addColorStop(1, withAlpha(color, 0));
    ctx.beginPath();
    ctx.fillStyle = grad;
    ctx.arc(node.x ?? 0, node.y ?? 0, haloR, 0, Math.PI * 2);
    ctx.fill();

    // Core disc.
    ctx.beginPath();
    ctx.fillStyle = withAlpha(color, dim);
    ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2);
    ctx.fill();

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
    if (showLabel) {
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
