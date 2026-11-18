export const KEEPING_PLACE = 'data-keeping-place';

const HOLD_MS = 1_500;
const OPENED_MS = 20_000;
const INTENT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

export interface FileHosts {
  hosts(): Iterable<{ path: string; host: HTMLElement }>;
}

interface RowKey {
  path: string;
  column: string;
  side: 'old' | 'new';
  line: string;
}

type Anchor = { kind: 'row'; key: RowKey } | { kind: 'element'; element: Element } | { kind: 'host'; path: string };

interface Hold {
  anchor: Anchor;
  target: number;
  until: number;
  lastTop: number;
  stop: () => void;
}

const registry = new Map<HTMLElement, Set<FileHosts>>();
const holds = new Map<HTMLElement, Hold>();
let opened: { host: HTMLElement; y: number; at: number } | null = null;

const rectOf = (element: Element) => Element.prototype.getBoundingClientRect.call(element);
const isDocument = (scroller: HTMLElement) => scroller === document.documentElement || scroller === document.scrollingElement;
const viewTop = (scroller: HTMLElement) => (isDocument(scroller) ? 0 : rectOf(scroller).top);
const viewBottom = (scroller: HTMLElement) => (isDocument(scroller) ? window.innerHeight : rectOf(scroller).bottom);

export function registerFileHosts(scroller: HTMLElement, hosts: FileHosts): () => void {
  let set = registry.get(scroller);
  if (!set) registry.set(scroller, (set = new Set()));
  set.add(hosts);
  return () => {
    set!.delete(hosts);
    if (set!.size === 0) registry.delete(scroller);
  };
}

export function noteOpened(host: HTMLElement, y: number): void {
  opened = { host, y, at: performance.now() };
}

function* allHosts(scroller: HTMLElement) {
  for (const hosts of registry.get(scroller) ?? []) yield* hosts.hosts();
}

function keyOf(path: string, row: Element): RowKey | null {
  const code = row.closest('[data-code]');
  const line = row.getAttribute('data-line');
  if (!code || line == null) return null;
  const column = code.hasAttribute('data-deletions') ? 'deletions' : code.hasAttribute('data-additions') ? 'additions' : 'unified';
  const side = (row.getAttribute('data-line-type') ?? '').includes('deletion') || column === 'deletions' ? 'old' : 'new';
  return { path, column, side, line };
}

function rowsOf(host: HTMLElement): Element[] {
  return [...(host.shadowRoot?.querySelectorAll('[data-code] [data-line]') ?? [])];
}

function hostOf(scroller: HTMLElement, path: string): HTMLElement | null {
  for (const entry of allHosts(scroller)) if (entry.path === path && entry.host.isConnected) return entry.host;
  return null;
}

function findRow(scroller: HTMLElement, key: RowKey): Element | null {
  const host = hostOf(scroller, key.path);
  if (!host) return null;
  for (const row of rowsOf(host)) {
    const found = keyOf(key.path, row);
    if (found && found.column === key.column && found.side === key.side && found.line === key.line) return row;
  }
  return null;
}

function pick(scroller: HTMLElement): Anchor | null {
  const top = viewTop(scroller);
  const bottom = viewBottom(scroller);
  const onScreen = (box: DOMRect) => box.bottom > top && box.top < bottom;
  if (opened && performance.now() - opened.at < OPENED_MS && opened.host.isConnected && onScreen(rectOf(opened.host))) {
    const entry = [...allHosts(scroller)].find(({ host }) => host === opened!.host);
    let best: { key: RowKey; distance: number } | null = null;
    for (const row of entry ? rowsOf(entry.host) : []) {
      const box = rectOf(row);
      if (box.height === 0 || !onScreen(box)) continue;
      const key = keyOf(entry!.path, row);
      const distance = Math.abs(box.top + box.height / 2 - opened.y);
      if (key && (!best || distance < best.distance)) best = { key, distance };
    }
    if (best) return { kind: 'row', key: best.key };
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && scroller.contains(active) && (active.isContentEditable || active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) {
    if (onScreen(rectOf(active))) return { kind: 'element', element: active };
  }
  let first: { key: RowKey; top: number } | null = null;
  for (const { path, host } of allHosts(scroller)) {
    if (!host.isConnected || !onScreen(rectOf(host))) continue;
    for (const row of rowsOf(host)) {
      const box = rectOf(row);
      if (box.height === 0 || box.top < top || box.top >= bottom) continue;
      const key = keyOf(path, row);
      if (key && (!first || box.top < first.top)) first = { key, top: box.top };
    }
  }
  return first ? { kind: 'row', key: first.key } : null;
}

function nextHost(scroller: HTMLElement, path: string): HTMLElement | null {
  const hosts = [...allHosts(scroller)].filter(({ host }) => host.isConnected);
  const index = hosts.findIndex((entry) => entry.path === path);
  const sorted = hosts.sort((a, b) => rectOf(a.host).top - rectOf(b.host).top);
  const here = index < 0 ? null : rectOf(hosts[index]!.host).top;
  return here == null ? null : sorted.find(({ host }) => rectOf(host).top > here)?.host ?? null;
}

function anchorTop(scroller: HTMLElement, hold: Hold): number | null {
  const { anchor } = hold;
  if (anchor.kind === 'element') return anchor.element.isConnected ? rectOf(anchor.element).top : null;
  if (anchor.kind === 'host') {
    const host = hostOf(scroller, anchor.path);
    return host ? rectOf(host).top : null;
  }
  const row = findRow(scroller, anchor.key);
  if (row) return rectOf(row).top;
  const next = nextHost(scroller, anchor.key.path);
  if (!next) return null;
  const path = [...allHosts(scroller)].find(({ host }) => host === next)?.path;
  if (!path) return null;
  hold.anchor = { kind: 'host', path };
  hold.target = rectOf(next).top;
  return hold.target;
}

export function isKeepingPlace(scroller: HTMLElement): boolean {
  return holds.has(scroller);
}

export function letGoOfPlace(scroller: HTMLElement): void {
  holds.get(scroller)?.stop();
}

export interface KeepPlaceHooks {
  onStop?: () => void;
}

export function keepPlace(scroller: HTMLElement, hooks: KeepPlaceHooks = {}): void {
  const held = holds.get(scroller);
  if (held) {
    held.until = performance.now() + HOLD_MS;
    return;
  }
  const anchor = pick(scroller);
  if (!anchor) return hooks.onStop?.();
  let frame = 0;
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => settle());
  const hold: Hold = {
    anchor,
    target: 0,
    until: performance.now() + HOLD_MS,
    lastTop: scroller.scrollTop,
    stop: () => {
      if (holds.get(scroller) !== hold) return;
      holds.delete(scroller);
      scroller.removeAttribute(KEEPING_PLACE);
      cancelAnimationFrame(frame);
      observer?.disconnect();
      scroller.removeEventListener('scroll', scrolled);
      for (const type of INTENT) window.removeEventListener(type, hold.stop, { capture: true });
      hooks.onStop?.();
    },
  };
  const at = anchorTop(scroller, hold);
  if (at == null) return hooks.onStop?.();
  hold.target = at;
  const settle = () => {
    if (holds.get(scroller) !== hold) return;
    const now = anchorTop(scroller, hold);
    if (now == null) return hold.stop();
    const delta = now - hold.target;
    if (Math.abs(delta) >= 0.5) {
      scroller.scrollTop += delta;
      hold.lastTop = scroller.scrollTop;
    }
  };
  const scrolled = () => {
    if (scroller.scrollTop === hold.lastTop) return;
    const now = anchorTop(scroller, hold);
    if (now != null && Math.abs(now - hold.target) <= 1) {
      hold.lastTop = scroller.scrollTop;
      return;
    }
    hold.stop();
  };
  const observed = new WeakSet<Element>();
  const watch = () => {
    const boxes: Element[] = [...scroller.querySelectorAll('[data-guide-file-shell] > div')];
    for (const { host } of allHosts(scroller)) boxes.push(host);
    for (const box of boxes) {
      if (observed.has(box)) continue;
      observed.add(box);
      observer?.observe(box);
    }
  };
  const step = () => {
    if (holds.get(scroller) !== hold) return;
    if (performance.now() > hold.until) return hold.stop();
    watch();
    settle();
    frame = requestAnimationFrame(step);
  };
  holds.set(scroller, hold);
  scroller.setAttribute(KEEPING_PLACE, '');
  scroller.addEventListener('scroll', scrolled, { passive: true });
  for (const type of INTENT) window.addEventListener(type, hold.stop, { capture: true, passive: true });
  watch();
  settle();
  frame = requestAnimationFrame(step);
}
