import { describe, expect, it } from 'vitest';
import { type Box, isPointOccluded, toCanvasBox } from './occlusion.js';

describe('toCanvasBox', () => {
  const canvas: Box = { left: 100, top: 50, right: 1100, bottom: 850 };

  it('translates a viewport rect into canvas-origin space', () => {
    const panel: Box = { left: 120, top: 70, right: 320, bottom: 170 };
    expect(toCanvasBox(panel, canvas)).toEqual({ left: 20, top: 20, right: 220, bottom: 120 });
  });

  it('grows the box by margin on every edge so a label just below still counts', () => {
    const panel: Box = { left: 120, top: 70, right: 320, bottom: 170 };
    expect(toCanvasBox(panel, canvas, 10)).toEqual({ left: 10, top: 10, right: 230, bottom: 130 });
  });

  it('handles a canvas not anchored at the viewport origin', () => {
    const offsetCanvas: Box = { left: 0, top: 0, right: 800, bottom: 600 };
    const panel: Box = { left: 40, top: 40, right: 240, bottom: 140 };
    expect(toCanvasBox(panel, offsetCanvas)).toEqual({
      left: 40,
      top: 40,
      right: 240,
      bottom: 140,
    });
  });
});

describe('isPointOccluded', () => {
  const occluders: Box[] = [
    { left: 0, top: 0, right: 200, bottom: 100 }, // top-left scope panel
    { left: 700, top: 80, right: 1000, bottom: 500 }, // right-side inspector
  ];

  it('is true when the point lands inside a panel', () => {
    expect(isPointOccluded(100, 50, occluders)).toBe(true);
    expect(isPointOccluded(850, 300, occluders)).toBe(true);
  });

  it('is false in the open canvas between panels', () => {
    expect(isPointOccluded(400, 400, occluders)).toBe(false);
  });

  it('treats the edges as inclusive (a label grazing the panel is still hidden)', () => {
    expect(isPointOccluded(200, 100, occluders)).toBe(true);
    expect(isPointOccluded(700, 80, occluders)).toBe(true);
  });

  it('never occludes against an empty panel set', () => {
    expect(isPointOccluded(100, 50, [])).toBe(false);
  });
});
