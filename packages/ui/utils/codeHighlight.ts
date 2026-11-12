import { themedLinesToHtml, tokenStyle, type ThemedTokenish } from './codeHighlightHtml';

type PierreModule = typeof import('@pierre/diffs');

export const CODE_BLOCK_CLASS = 'pn-code';

export function codeBlockClassName(language?: string): string {
  return `${CODE_BLOCK_CLASS} font-mono${language ? ` language-${language}` : ''}`;
}

const ALIGNED_LAYOUT = /[\u2500-\u259F]|\S\t+\S|[^\s.!?] {2,}\S/;

export function codeBlockKeepsLayout(content: string): boolean {
  return ALIGNED_LAYOUT.test(content);
}

let pierre: PierreModule | undefined;
let pierreLoad: Promise<PierreModule | undefined> | undefined;

const ready = new Set<string>();
const rejected = new Map<string, unknown>();
const inflight = new Map<string, Promise<boolean>>();

const pairKey = (lang: string, theme: string) => `${lang} ${theme}`;

function loadPierre(): Promise<PierreModule | undefined> {
  pierreLoad ??= import('@pierre/diffs').then(
    (mod) => {
      pierre = mod;
      return mod;
    },
    () => undefined,
  );
  return pierreLoad;
}

export function highlightToHtml(code: string, lang: string, theme: string): string | null {
  const lines = themedLines(code, lang, theme);
  if (!lines) return null;
  return themedLinesToHtml(lines, code);
}

const TOKENIZE_TIME_LIMIT_MS = 500;
const TOKENIZE_PASSES = 3;

function themedLines(code: string, lang: string, theme: string): ThemedTokenish[][] | null {
  const mod = pierre;
  if (!mod || !ready.has(pairKey(lang, theme))) return null;
  const highlighter = mod.getHighlighterIfLoaded();
  if (!highlighter) {
    ready.clear();
    return null;
  }
  try {
    let tokens: ThemedTokenish[][] = [];
    for (let pass = 0; pass < TOKENIZE_PASSES; pass++) {
      const started = performance.now();
      tokens = highlighter.codeToTokens(code, { lang, theme, tokenizeTimeLimit: TOKENIZE_TIME_LIMIT_MS }).tokens as ThemedTokenish[][];
      if (performance.now() - started < TOKENIZE_TIME_LIMIT_MS - 10) break;
    }
    return tokens;
  } catch {
    ready.delete(pairKey(lang, theme));
    return null;
  }
}

export interface HighlightRun {
  start: number;
  end: number;
  style: string;
}

export function highlightToRuns(code: string, lang: string, theme: string): HighlightRun[] | null {
  const lines = themedLines(code, lang, theme);
  if (!lines) return null;
  const runs: HighlightRun[] = [];
  let at = 0;
  let plain = '';
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      at += 1;
      plain += '\n';
    }
    for (const token of lines[i]!) {
      const style = tokenStyle(token);
      if (style) runs.push({ start: at, end: at + token.content.length, style });
      at += token.content.length;
      plain += token.content;
    }
  }
  return plain === code ? runs : null;
}

export function ensureHighlight(lang: string, theme: string): Promise<boolean> {
  const key = pairKey(lang, theme);
  if (ready.has(key)) return Promise.resolve(true);
  if (rejected.has(key)) return Promise.resolve(false);
  const existing = inflight.get(key);
  if (existing) return existing;

  const load = loadPierre()
    .then(async (mod) => {
      if (!mod) return false;
      await mod.getSharedHighlighter({
        themes: [theme],
        langs: [lang],
        preferredHighlighter: 'shiki-js',
      });
      ready.add(key);
      return true;
    })
    .catch((cause: unknown) => {
      rejected.set(key, cause);
      return false;
    })
    .then((ok) => {
      inflight.delete(key);
      return ok;
    });

  inflight.set(key, load);
  return load;
}

export function forgetHighlightRejection(lang: string, theme: string): void {
  rejected.delete(pairKey(lang, theme));
}

export function highlightRejection(lang: string, theme: string): { cause: unknown } | null {
  const key = pairKey(lang, theme);
  return rejected.has(key) ? { cause: rejected.get(key) } : null;
}

const renderSeq = new WeakMap<HTMLElement, number>();
let seqCounter = 0;

type HighlightSwapListener = (el: HTMLElement) => void;
const swapListeners = new Set<HighlightSwapListener>();

export function onCodeHighlightSwap(listener: HighlightSwapListener): () => void {
  swapListeners.add(listener);
  return () => {
    swapListeners.delete(listener);
  };
}

function notifyHighlightSwap(el: HTMLElement): void {
  if (swapListeners.size === 0) return;
  for (const listener of Array.from(swapListeners)) {
    try {
      listener(el);
    } catch {}
  }
}

let deferOffscreen = false;

export function setDeferOffscreenCodeHighlight(on: boolean): void {
  deferOffscreen = on;
  if (!on) flushPendingHighlights();
}

export interface CodeHighlightWorker {
  html(code: string, lang: string, theme: string): Promise<string | null>;
}

let highlightWorker: CodeHighlightWorker | null = null;

export function setCodeHighlightWorker(next: CodeHighlightWorker | null): void {
  highlightWorker = next;
}

interface PendingHighlight {
  code: string;
  lang: string;
  theme: string;
  seq: number;
  html?: string | null;
  asked?: boolean;
}

const pending = new Map<HTMLElement, PendingHighlight>();
let sizes: ResizeObserver | null = null;
let watching = false;
let backlog: { cancel: () => void } | null = null;

const NEAR_SCREENS = 1;
const BACKLOG_SLICE_MS = 8;
const BACKLOG_TIMEOUT_MS = 1000;
const BACKLOG_GAP_MS = 32;

function canDefer(): boolean {
  return deferOffscreen && typeof window !== 'undefined' && typeof ResizeObserver === 'function';
}

function viewHeight(): number {
  return window.innerHeight || document.documentElement?.clientHeight || 0;
}

function distanceFromView(el: HTMLElement, height: number): number | null {
  const box = el.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  if (box.bottom < 0) return -box.bottom;
  if (box.top > height) return box.top - height;
  return 0;
}

function forgetPending(el: HTMLElement): void {
  pending.delete(el);
  sizes?.unobserve(el);
}

function highlightPending(el: HTMLElement, job: PendingHighlight): void {
  forgetPending(el);
  if (renderSeq.get(el) !== job.seq || !el.isConnected) return;
  const html = typeof job.html === 'string' ? job.html : highlightToHtml(job.code, job.lang, job.theme);
  if (html === null) return;
  el.innerHTML = html;
  notifyHighlightSwap(el);
}

function highlightNear(): void {
  const height = viewHeight();
  const reach = height * NEAR_SCREENS;
  const due: [HTMLElement, PendingHighlight][] = [];
  let farther = false;
  for (const [el, job] of pending) {
    if (!el.isConnected) {
      forgetPending(el);
      continue;
    }
    const distance = distanceFromView(el, height);
    if (distance === null) continue;
    if (distance <= reach) due.push([el, job]);
    else farther = true;
  }
  for (const [el, job] of due) highlightPending(el, job);
  if (farther) scheduleBacklog();
  settle();
}

function drainBacklog(): boolean {
  const height = viewHeight();
  const order: [HTMLElement, PendingHighlight, number][] = [];
  for (const [el, job] of pending) {
    if (!el.isConnected) {
      forgetPending(el);
      continue;
    }
    if (job.asked && job.html === undefined) continue;
    const distance = distanceFromView(el, height);
    if (distance !== null) order.push([el, job, distance]);
  }
  order.sort((a, b) => a[2] - b[2]);
  const end = performance.now() + BACKLOG_SLICE_MS;
  let done = 0;
  for (const [el, job] of order) {
    highlightPending(el, job);
    done++;
    if (performance.now() >= end) break;
  }
  return done < order.length;
}

function scheduleBacklog(): void {
  if (backlog !== null || pending.size === 0) return;
  const run = () => {
    backlog = null;
    if (drainBacklog()) scheduleBacklog();
    settle();
  };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  const cancelIdle = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
  if (typeof idle === 'function') {
    const id = idle(run, { timeout: BACKLOG_TIMEOUT_MS });
    backlog = { cancel: () => cancelIdle?.(id) };
  } else {
    const id = setTimeout(run, BACKLOG_GAP_MS);
    backlog = { cancel: () => clearTimeout(id) };
  }
}

const onViewMoved = () => highlightNear();
const onBeforePrint = () => flushPendingHighlights();

function settle(): void {
  if (pending.size > 0 && !watching) {
    watching = true;
    document.addEventListener('scroll', onViewMoved, { capture: true, passive: true });
    window.addEventListener('resize', onViewMoved);
    window.addEventListener('beforeprint', onBeforePrint);
  } else if (pending.size === 0) {
    backlog?.cancel();
    backlog = null;
    if (watching) {
      watching = false;
      document.removeEventListener('scroll', onViewMoved, { capture: true });
      window.removeEventListener('resize', onViewMoved);
      window.removeEventListener('beforeprint', onBeforePrint);
    }
  }
}

function waitForView(el: HTMLElement, job: PendingHighlight): void {
  sizes ??= new ResizeObserver(() => highlightNear());
  pending.set(el, job);
  const worker = highlightWorker;
  if (worker) {
    job.asked = true;
    const landed = (html: string | null) => {
      job.html = html;
      if (pending.get(el) === job) scheduleBacklog();
    };
    worker.html(job.code, job.lang, job.theme).then(landed, () => landed(null));
  }
  sizes.unobserve(el);
  sizes.observe(el);
  settle();
}

export function flushPendingHighlights(root?: Node): void {
  for (const [el, job] of [...pending]) {
    if (root && !root.contains(el)) continue;
    highlightPending(el, job);
  }
  if (typeof window !== 'undefined') settle();
}

export function isHighlightPending(el: HTMLElement): boolean {
  return pending.has(el);
}

export function applyHighlight(
  el: HTMLElement,
  code: string,
  lang: string | undefined,
  theme: string,
): void {
  const seq = ++seqCounter;
  renderSeq.set(el, seq);

  if (!lang) {
    if (pending.has(el)) forgetPending(el);
    el.textContent = code;
    notifyHighlightSwap(el);
    return;
  }

  if (canDefer()) {
    if (pending.has(el)) forgetPending(el);
    el.textContent = code;
    notifyHighlightSwap(el);
    const job = { code, lang, theme, seq };
    if (pierre && ready.has(pairKey(lang, theme))) waitForView(el, job);
    else
      void ensureHighlight(lang, theme).then((ok) => {
        if (ok && renderSeq.get(el) === seq && el.isConnected) waitForView(el, job);
      });
    return;
  }
  if (pending.has(el)) forgetPending(el);

  const immediate = highlightToHtml(code, lang, theme);
  if (immediate !== null) {
    el.innerHTML = immediate;
    notifyHighlightSwap(el);
    return;
  }

  el.textContent = code;
  notifyHighlightSwap(el);
  void ensureHighlight(lang, theme).then((ok) => {
    if (!ok || renderSeq.get(el) !== seq || !el.isConnected) return;
    const html = highlightToHtml(code, lang, theme);
    if (html === null) return;
    el.innerHTML = html;
    notifyHighlightSwap(el);
  });
}

export function __resetCodeHighlightCacheForTests(): void {
  for (const el of [...pending.keys()]) forgetPending(el);
  backlog?.cancel();
  backlog = null;
  if (watching && typeof window !== 'undefined') settle();
  ready.clear();
  rejected.clear();
  inflight.clear();
  pierre = undefined;
  pierreLoad = undefined;
}

export function __setCodeHighlightModuleForTests(mod: PierreModule | undefined): void {
  ready.clear();
  rejected.clear();
  inflight.clear();
  pierre = mod;
  pierreLoad = mod ? Promise.resolve(mod) : undefined;
}
