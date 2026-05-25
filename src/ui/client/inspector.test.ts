// @vitest-environment jsdom
/**
 * The inspector panel (DESIGN §11): selecting a node opens a compact metadata
 * drawer; deselecting (null) closes it. The graph click path is canvas-WebGL and
 * non-deterministic, so the e2e suite deliberately avoids clicking by coordinate —
 * this drives the same `overlays.showInspector(node)` contract that
 * `onSelectNode` (main.ts) wires the click to, but programmatically.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountOverlays } from './overlays.js';
import type { ViewNode } from './types.js';

const callbacks = () => ({
  onSetVisibleTypes: vi.fn(),
  onSearch: vi.fn(),
  onSearchDelete: vi.fn(),
  onScopeChange: vi.fn(),
  onThemeChange: vi.fn(),
  onInspectorClose: vi.fn(),
  onInspectorDelete: vi.fn(),
});

const obs: ViewNode = {
  id: 'o:42',
  type: 'lesson',
  label: 'cargo não resolve crates.io atrás do proxy',
  sizeDriver: 7,
  createdAt: '2026-05-25T12:00:00.000Z',
  sessionId: 's:9',
};

let root: HTMLElement;

beforeEach(() => {
  document.documentElement.dataset.theme = 'dark';
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

describe('overlays.showInspector', () => {
  it('opens the drawer and renders the node metadata on select', () => {
    const overlays = mountOverlays(root, callbacks());
    const inspector = root.querySelector('#inspector') as HTMLElement;
    expect(inspector.hidden).toBe(true); // hidden until a node is selected

    overlays.showInspector(obs);

    expect(inspector.hidden).toBe(false);
    expect(inspector.classList.contains('open')).toBe(true);
    expect(inspector.querySelector('.inspect-type')?.textContent).toBe('lesson');
    expect(inspector.querySelector('.inspect-content')?.textContent).toBe(obs.label);
    // id row is rendered verbatim so an operator can map back to the observation.
    expect(inspector.textContent).toContain('o:42');
  });

  it('closes the drawer on a null selection', () => {
    const overlays = mountOverlays(root, callbacks());
    const inspector = root.querySelector('#inspector') as HTMLElement;
    overlays.showInspector(obs);
    expect(inspector.hidden).toBe(false);

    overlays.showInspector(null);

    expect(inspector.hidden).toBe(true);
    expect(inspector.classList.contains('open')).toBe(false);
  });

  it('re-renders cleanly when switching from one node to another', () => {
    const overlays = mountOverlays(root, callbacks());
    const inspector = root.querySelector('#inspector') as HTMLElement;
    overlays.showInspector(obs);
    overlays.showInspector({ ...obs, id: 's:9', type: 'session', label: 'sessão de lançamento' });

    // No stale duplicate panels — replaceChildren rebuilds the body each time.
    expect(inspector.querySelectorAll('.inspect-type')).toHaveLength(1);
    expect(inspector.querySelector('.inspect-type')?.textContent).toBe('session');
    expect(inspector.querySelector('.inspect-content')?.textContent).toBe('sessão de lançamento');
  });

  it('wires the close and delete affordances to their callbacks', () => {
    const cb = callbacks();
    const overlays = mountOverlays(root, cb);
    overlays.showInspector(obs);
    const inspector = root.querySelector('#inspector') as HTMLElement;

    (inspector.querySelector('.inspect-delete') as HTMLButtonElement).click();
    expect(cb.onInspectorDelete).toHaveBeenCalledWith(obs);

    (inspector.querySelector('.inspect-close') as HTMLButtonElement).click();
    expect(cb.onInspectorClose).toHaveBeenCalledTimes(1);
  });
});
