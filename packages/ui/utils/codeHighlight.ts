/**
 * Syntax highlighting for markdown fences and suggestion snippets.
 *
 * There is exactly ONE highlighter in the app: the Shiki instance
 * `@pierre/diffs` already runs for the code-review diff pane
 * (`getSharedHighlighter`, driven by Shiki's JavaScript regex engine). Reusing
 * it rather than standing up a second one buys three things:
 *
 *   - Fences render in the SAME resolved theme as the diff pane, so a code
 *     block and a diff hunk finally agree about what "Kanagawa Wave" looks
 *     like. See `./syntaxTheme.ts`.
 *   - Zero added bundle weight. Pierre imports Shiki's full bundle, so every
 *     grammar and theme is already inlined; a separate fine-grained highlighter
 *     would have duplicated a subset of what is already there.
 *   - Every language Shiki bundles, not a hand-curated shortlist.
 *
 * The API is deliberately imperative (`applyHighlight(el, ...)`) because that is
 * exactly the shape the removed `hljs.highlightElement(el)` had. The annotation
 * layer reaches into these `<code>` elements to wrap `<mark>`s and to restore
 * plain text afterwards, so keeping the DOM contract identical keeps that code
 * working untouched.
 *
 * Language-less fences are never highlighted and never guessed at — see #1212.
 * There is no auto-detection anywhere in this module.
 */

import { themedLinesToHtml, tokenStyle, type ThemedTokenish } from './codeHighlightHtml';

type PierreModule = typeof import('@pierre/diffs');

/**
 * Structural class on every fenced-code `<code>` element.
 *
 * `blockTargeting`, the vim navigation layer and the print stylesheet all
 * address code blocks through `pre > code.pn-code`. It used to be `.hljs`,
 * which named a library the app no longer ships; the hook itself is unchanged,
 * only the name is. The `language-*` class alongside it is still how
 * `blockTargeting` reads a block's language back out of the DOM.
 */
export const CODE_BLOCK_CLASS = 'pn-code';

export function codeBlockClassName(language?: string): string {
  return `${CODE_BLOCK_CLASS} font-mono${language ? ` language-${language}` : ''}`;
}

/**
 * Plan fences soft-wrap long lines (`white-space: pre-wrap`), but a fence laid
 * out as a grid — box-drawing diagrams, `+---+` boxes, space-aligned columns —
 * is unreadable once a row wraps. Those keep the old unwrapped, horizontally
 * scrolling layout: the renderers mark them with `data-keep-layout`, which the
 * editor stylesheet turns back into `white-space: pre`.
 *
 * Signals: any box-drawing or block-element character, a tab between two
 * words, or a run of two or more spaces between two words (column alignment).
 * A double space after sentence punctuation is prose, not alignment, and
 * leading indentation is never interior, so ordinary code still wraps.
 */
const ALIGNED_LAYOUT = /[\u2500-\u259F]|\S\t+\S|[^\s.!?] {2,}\S/;

export function codeBlockKeepsLayout(content: string): boolean {
  return ALIGNED_LAYOUT.test(content);
}

let pierre: PierreModule | undefined;
let pierreLoad: Promise<PierreModule | undefined> | undefined;

/** `${lang} ${theme}` pairs attached to the shared highlighter. */
const ready = new Set<string>();
/** Pairs the highlighter refused (unknown grammar or theme), with the error it gave. Never retried. */
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

/**
 * Highlighted markup for `code`, or `null` when it cannot be produced right now
 * (highlighter not loaded yet, grammar/theme not attached yet, or the tokens do
 * not reconstruct the input exactly).
 *
 * Synchronous by design: once a (lang, theme) pair is attached, every later
 * block using it highlights during the same tick, so there is no flicker on
 * cached highlights.
 */
export function highlightToHtml(code: string, lang: string, theme: string): string | null {
  const lines = themedLines(code, lang, theme);
  if (!lines) return null;
  return themedLinesToHtml(lines, code);
}

/** Shiki's tokens for `code`, or null when the pair is not attached (or the tokenizer threw). */
function themedLines(code: string, lang: string, theme: string): ThemedTokenish[][] | null {
  const mod = pierre;
  if (!mod || !ready.has(pairKey(lang, theme))) return null;
  const highlighter = mod.getHighlighterIfLoaded();
  if (!highlighter) {
    // The shared highlighter was disposed out from under us; everything we
    // believed was attached is gone with it.
    ready.clear();
    return null;
  }
  try {
    return highlighter.codeToTokens(code, { lang, theme }).tokens as ThemedTokenish[][];
  } catch {
    ready.delete(pairKey(lang, theme));
    return null;
  }
}

/** One styled stretch of a highlighted string: `code.slice(start, end)` drawn in `style`. */
export interface HighlightRun {
  start: number;
  end: number;
  style: string;
}

/**
 * `highlightToHtml` as data: the styled runs over `code`, by offset, or null
 * under the same conditions. For a renderer that lays its own marks over the
 * colours (the config-file diff view), where an HTML string cannot be split.
 * Unstyled text has no run.
 */
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
  // The same invariant as highlightToHtml: offsets must name the source's own characters.
  return plain === code ? runs : null;
}

/**
 * Attach `lang` + `theme` to the shared highlighter. Resolves `false` for
 * grammars or themes Shiki does not know, which is a normal outcome for a fence
 * tagged with something made up: that block simply stays plain.
 */
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

/**
 * Let a pair that failed to attach try again on its next `ensureHighlight`.
 *
 * A host whose grammars are fetched on first use (a code-split build) can lose
 * one to a server that was away for a moment; without this the pair stays
 * plain for the life of the page. Nothing in ui calls it: a pair that failed
 * stays rejected unless the host asks.
 */
export function forgetHighlightRejection(lang: string, theme: string): void {
  rejected.delete(pairKey(lang, theme));
}

/**
 * Why a pair failed to attach: `{ cause }`, the error its load gave, or null
 * when it has not failed. A host whose grammars are fetched on first use can
 * tell a chunk its server no longer has (asking again cannot help) from one a
 * dropped link lost. Nothing in ui calls it.
 */
export function highlightRejection(lang: string, theme: string): { cause: unknown } | null {
  const key = pairKey(lang, theme);
  return rejected.has(key) ? { cause: rejected.get(key) } : null;
}

/** Monotonic stamp per element so a slow async highlight from a previous
 *  content/theme never lands on top of a newer one. */
const renderSeq = new WeakMap<HTMLElement, number>();
let seqCounter = 0;

type HighlightSwapListener = (el: HTMLElement) => void;
const swapListeners = new Set<HighlightSwapListener>();

/**
 * Observe every write `applyHighlight` makes to a `<code>` element.
 *
 * Each write REPLACES the element's children, which destroys anything the
 * annotation layer wrapped inside it — a whole-fence `<mark data-bind-id>` is
 * gone the moment the palette changes or the first async grammar attach lands.
 * Listeners run SYNCHRONOUSLY, immediately after the write, so re-applying a
 * mark from a listener is ordered by construction rather than by a timer: a
 * restore that ran before the swap is re-established in the same task the swap
 * happened in, and a restore that runs after it finds the mark already there.
 *
 * Returns an unsubscribe function.
 */
export function onCodeHighlightSwap(listener: HighlightSwapListener): () => void {
  swapListeners.add(listener);
  return () => {
    swapListeners.delete(listener);
  };
}

function notifyHighlightSwap(el: HTMLElement): void {
  if (swapListeners.size === 0) return;
  for (const listener of Array.from(swapListeners)) {
    // A misbehaving observer must never take syntax highlighting down with it.
    try {
      listener(el);
    } catch {}
  }
}

// ── Fences off screen (opt-in: configurePlannotatorUI({ deferOffscreenCodeHighlight: true })) ──
//
// Highlighted markup costs far more than the code's own text: Shiki's tokens
// (~5 ms per 100 lines with the JavaScript engine) and then a span per token
// for the browser to parse, style and lay out (a long agent thread with a
// few hundred fences is ~400K spans, ~2 s of layout). With this on, a fence
// keeps its plain text (the same characters, the same size) until it comes
// near the screen, and is highlighted before the frame that first draws it:
//
//   - A ResizeObserver watches each waiting fence. Its first notice comes
//     after layout and before paint, so a fence on screen when it is drawn
//     (or when it stops being hidden) is highlighted before that paint.
//   - A scroll anywhere (capture) runs before the frame that shows the new
//     place, so a fence scrolled into view is highlighted before it shows.
//   - The rest are highlighted in idle time, nearest first, a slice at a time,
//     so they are done soon after the thread opens and print, find and copy
//     see finished fences.
//
// Nothing changes how a fence looks: the plain text is what every fence shows
// today until its grammar is attached, and a fence on screen is never drawn
// plain. A host that does not turn it on keeps the synchronous highlight.

let deferOffscreen = false;

/** Turn the off-screen deferral on or off (configurePlannotatorUI). Off finishes every waiting fence now. */
export function setDeferOffscreenCodeHighlight(on: boolean): void {
  deferOffscreen = on;
  if (!on) flushPendingHighlights();
}

/**
 * A maker of a fence's markup off the main thread (a host's Web Worker): the
 * same characters `highlightToHtml` gives (`./codeHighlightHtml` from the same
 * tokens), or null when it cannot make them. Used only for fences waiting off
 * screen: their tokens are made there, and only the markup is written here. A
 * fence that comes near before its markup is back is highlighted here, as
 * without a worker.
 */
export interface CodeHighlightWorker {
  html(code: string, lang: string, theme: string): Promise<string | null>;
}

let highlightWorker: CodeHighlightWorker | null = null;

/** Set (or clear) the background maker of waiting fences' markup (configurePlannotatorUI). */
export function setCodeHighlightWorker(next: CodeHighlightWorker | null): void {
  highlightWorker = next;
}

interface PendingHighlight {
  code: string;
  lang: string;
  theme: string;
  seq: number;
  /** The worker's markup: undefined while it is being made (or with no worker), null when it could not. */
  html?: string | null;
  /** Sent to the worker. */
  asked?: boolean;
}

/** Fences drawn plain, waiting to come near the screen (or for idle time). */
const pending = new Map<HTMLElement, PendingHighlight>();
let sizes: ResizeObserver | null = null;
let watching = false;
let backlog: { cancel: () => void } | null = null;

/** How far beyond the window's own height (above and below) a fence counts as near: one more screen each way. */
const NEAR_SCREENS = 1;
/** Idle work per slice; one fence is always done even when it takes longer. */
const BACKLOG_SLICE_MS = 8;
/** requestIdleCallback's timeout, and the pause between slices where there is no requestIdleCallback (Safari). */
const BACKLOG_TIMEOUT_MS = 1000;
const BACKLOG_GAP_MS = 32;

function canDefer(): boolean {
  return deferOffscreen && typeof window !== 'undefined' && typeof ResizeObserver === 'function';
}

function viewHeight(): number {
  return window.innerHeight || document.documentElement?.clientHeight || 0;
}

/** Distance from the window's view (0 inside it), or null when the fence is not drawn (hidden, detached). */
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

/**
 * Highlight every waiting fence near the view. All reads first, then the writes: one layout, not one per fence.
 * Fences drawn but farther away are left to the idle backlog.
 */
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

/** One idle slice: the nearest waiting fences until the slice's time is used. Whether drawn fences are left. */
function drainBacklog(): boolean {
  const height = viewHeight();
  const order: [HTMLElement, PendingHighlight, number][] = [];
  for (const [el, job] of pending) {
    if (!el.isConnected) {
      forgetPending(el);
      continue;
    }
    // A fence not drawn now (inside a hidden part) waits for its ResizeObserver notice, and one whose markup the
    // worker is still making waits for it (its arrival asks for another slice).
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

/** Listen while fences wait, stop when none is left. Reads no layout (it runs once per fence as fences mount). */
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
  // Observed again, so its first notice (after the next layout, before that paint) decides whether it is near.
  sizes.unobserve(el);
  sizes.observe(el);
  settle();
}

/**
 * Highlight now every fence still waiting (all of them, or those inside `root`), for a reader of the
 * DOM that needs the finished markup: print, or a host that lays ranges over the text (search hits).
 */
export function flushPendingHighlights(root?: Node): void {
  for (const [el, job] of [...pending]) {
    if (root && !root.contains(el)) continue;
    highlightPending(el, job);
  }
  if (typeof window !== 'undefined') settle();
}

/** Whether `el` waits for the view (tests). */
export function isHighlightPending(el: HTMLElement): boolean {
  return pending.has(el);
}

/**
 * Drop-in replacement for `hljs.highlightElement(el)`.
 *
 * Writes plain text immediately so the block has its final size and content on
 * the very first paint (no layout shift, no empty flash), then swaps in
 * highlighted markup when the grammar is attached. When the grammar is already
 * attached the highlighted markup is written straight away with no intermediate
 * plain state. With `deferOffscreenCodeHighlight` on, a fence away from the
 * view stays plain until it comes near, and is highlighted before it shows.
 */
export function applyHighlight(
  el: HTMLElement,
  code: string,
  lang: string | undefined,
  theme: string,
): void {
  const seq = ++seqCounter;
  renderSeq.set(el, seq);

  // #1212: a fence with no language stays plain. Never guess.
  if (!lang) {
    if (pending.has(el)) forgetPending(el);
    el.textContent = code;
    notifyHighlightSwap(el);
    return;
  }

  if (canDefer()) {
    // What it waited to show is not what it shows now (a new theme waits for its own attach first).
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

/** Test seam: forget every cached attachment and module handle (and every fence waiting for the view). */
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

/**
 * Test seam: stand in for `@pierre/diffs` so a test can drive real swaps
 * (including WHEN the async one lands) without loading Shiki's full bundle.
 * Pass `undefined` to go back to the real dynamic import.
 */
export function __setCodeHighlightModuleForTests(mod: PierreModule | undefined): void {
  ready.clear();
  rejected.clear();
  inflight.clear();
  pierre = mod;
  pierreLoad = mod ? Promise.resolve(mod) : undefined;
}
