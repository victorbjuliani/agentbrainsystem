/**
 * Label-occlusion geometry (DESIGN §11 follow-up).
 *
 * On-canvas node labels that fall *under* a floating overlay panel render as text
 * bleeding through the glass surface — it reads as broken. The renderer suppresses
 * a label whose screen-space anchor lands inside any visible panel's rect.
 *
 * These helpers are intentionally pure (DOM-free) so the geometry is unit-tested in
 * isolation; the renderer feeds them live panel + canvas rects each frame. Mirrors
 * the `node-size.ts` split: math here, paint in `render.ts`.
 */

/** Minimal rect shape — a subset of DOMRect, so callers can pass a DOMRect directly. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Translate a panel's viewport rect into the canvas's screen-coordinate space
 * (origin = canvas top-left — the same space `graph2ScreenCoords` returns) and grow
 * it by `margin` px so a label drawn just *below* a node still counts as covered.
 */
export function toCanvasBox(panel: Box, canvas: Box, margin = 0): Box {
  return {
    left: panel.left - canvas.left - margin,
    top: panel.top - canvas.top - margin,
    right: panel.right - canvas.left + margin,
    bottom: panel.bottom - canvas.top + margin,
  };
}

/** Is the screen-space point inside any occluder box (edges inclusive)? */
export function isPointOccluded(x: number, y: number, occluders: readonly Box[]): boolean {
  for (const b of occluders) {
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return true;
  }
  return false;
}
