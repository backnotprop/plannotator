/**
 * The free layout kept for the window (sessionStorage: one layout a browser tab, kept across reloads, gone with the
 * tab). Only a layout of two panes or more is kept: one pane is the address alone, as without the switch. What is read
 * back is checked whole (the engine's own tree check, then every pane with a thread, the active one among them);
 * anything else reads as no layout.
 */
import { naryTree, parseStoredLayoutTree } from '@plannotator/vendor-pierre-layouts';
import type { LayoutNode } from '@plannotator/vendor-pierre-layouts';
import { EMPTY_LAYOUT, PANE_MIN_HEIGHT, PANE_MIN_WIDTH, panesOf, paneCount, type FreeLayout } from './layoutModel';

/** Every pane at today's minimums: a layout kept under another minimum (440 px before) draws by the current rule. */
function withMinimums(node: LayoutNode): LayoutNode {
  if (node.type === 'pane') return node.minWidth === PANE_MIN_WIDTH && node.minHeight === PANE_MIN_HEIGHT ? node : { ...node, minWidth: PANE_MIN_WIDTH, minHeight: PANE_MIN_HEIGHT };
  if (node.type !== 'split') return node;
  return { ...node, children: node.children.map(withMinimums) };
}

export const LAYOUT_KEY = 'plannotator.inbox.layout';

interface Saved {
  v: 1;
  tree: { version: 3; root: unknown };
  threads: Record<string, string>;
  active: string;
  recent: string[];
  serial: number;
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The layout as stored text, or null when there is nothing to keep (fewer than two panes). */
export function encodeLayout(layout: FreeLayout): string | null {
  if (!layout.root || !layout.active || paneCount(layout) < 2) return null;
  const saved: Saved = { v: 1, tree: { version: 3, root: layout.root }, threads: { ...layout.threads }, active: layout.active, recent: [...layout.recent], serial: layout.serial };
  return JSON.stringify(saved);
}

/** The layout stored text holds, or the empty layout when it holds none that checks out. */
export function decodeLayout(text: string | null): FreeLayout {
  if (!text) return EMPTY_LAYOUT;
  try {
    const saved = JSON.parse(text) as Partial<Saved>;
    if (saved?.v !== 1 || !saved.threads || typeof saved.threads !== 'object') return EMPTY_LAYOUT;
    const root = withMinimums(parseStoredLayoutTree(saved.tree, naryTree).root);
    const ids = panesOf(root).map((pane) => pane.id);
    const threads = saved.threads as Record<string, unknown>;
    const shown = Object.values(threads);
    if (ids.length < 2 || ids.length !== Object.keys(threads).length) return EMPTY_LAYOUT;
    if (!ids.every((id) => typeof threads[id] === 'string' && threads[id] !== '')) return EMPTY_LAYOUT;
    if (new Set(shown).size !== shown.length) return EMPTY_LAYOUT;
    if (typeof saved.active !== 'string' || !ids.includes(saved.active)) return EMPTY_LAYOUT;
    const recent = Array.isArray(saved.recent) ? saved.recent.filter((id): id is string => typeof id === 'string' && ids.includes(id)) : [];
    const serial = typeof saved.serial === 'number' && Number.isFinite(saved.serial) ? Math.max(1, Math.floor(saved.serial)) : ids.length + 1;
    if (panesOf(root).some((pane) => pane.hidden)) return EMPTY_LAYOUT;
    return { root, threads: threads as Record<string, string>, active: saved.active, recent: [saved.active, ...recent.filter((id) => id !== saved.active)], serial };
  } catch {
    return EMPTY_LAYOUT;
  }
}

export function loadLayout(): FreeLayout {
  try {
    return decodeLayout(storage()?.getItem(LAYOUT_KEY) ?? null);
  } catch {
    return EMPTY_LAYOUT;
  }
}

export function saveLayout(layout: FreeLayout): void {
  const store = storage();
  if (!store) return;
  try {
    const text = encodeLayout(layout);
    if (text === null) store.removeItem(LAYOUT_KEY);
    else if (store.getItem(LAYOUT_KEY) !== text) store.setItem(LAYOUT_KEY, text);
  } catch {
    // A full or blocked storage keeps the layout for this page only.
  }
}
