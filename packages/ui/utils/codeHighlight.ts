/**
 * Syntax highlighting for markdown fences and suggestion snippets.
 *
 * There is exactly ONE highlighter in the app: the instance `@pierre/diffs`
 * already runs for the code-review diff pane (`getSharedHighlighter`, on the
 * backend `CODE_HIGHLIGHTER` names: Pierre's Highlights, or Shiki's JavaScript
 * regex engine). Reusing it rather than standing up a second one buys three
 * things:
 *
 *   - Fences render in the SAME resolved theme as the diff pane, so a code
 *     block and a diff hunk finally agree about what "Kanagawa Wave" looks
 *     like. See `./syntaxTheme.ts`.
 *   - Zero added bundle weight. Pierre already bundles its highlighter and
 *     every theme; a separate one would duplicate a subset of it.
 *   - Every language the backend bundles, not a hand-curated shortlist.
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

import { CODE_HIGHLIGHTER } from '@plannotator/core/code-highlighter';

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

/** Shiki's `FontStyle` bitmask. Inlined so this module needs no shiki types. */
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface ThemedTokenish {
  content: string;
  color?: string;
  bgColor?: string;
  fontStyle?: number;
  htmlStyle?: Record<string, string> | string;
}

function tokenStyle(token: ThemedTokenish): string {
  if (typeof token.htmlStyle === 'string') return token.htmlStyle;
  const parts: string[] = [];
  if (token.htmlStyle) {
    for (const [prop, value] of Object.entries(token.htmlStyle)) parts.push(`${prop}:${value}`);
  }
  if (token.color) parts.push(`color:${token.color}`);
  if (token.bgColor) parts.push(`background-color:${token.bgColor}`);
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle > 0) {
    if (fontStyle & FONT_STYLE_ITALIC) parts.push('font-style:italic');
    if (fontStyle & FONT_STYLE_BOLD) parts.push('font-weight:bold');
    const decorations: string[] = [];
    if (fontStyle & FONT_STYLE_UNDERLINE) decorations.push('underline');
    if (fontStyle & FONT_STYLE_STRIKETHROUGH) decorations.push('line-through');
    if (decorations.length) parts.push(`text-decoration:${decorations.join(' ')}`);
  }
  return parts.join(';');
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

  // Invariant: the rendered text must be byte-identical to the source. The
  // annotation layer addresses these blocks by text offset, so a tokenizer that
  // normalised line endings (or dropped a trailing newline) would silently
  // misplace every highlight in the block. Bail to plain text instead.
  let html = '';
  let plain = '';
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      html += '\n';
      plain += '\n';
    }
    for (const token of lines[i]!) {
      plain += token.content;
      const style = tokenStyle(token);
      html += style
        ? `<span style="${style}">${escapeHtml(token.content)}</span>`
        : escapeHtml(token.content);
    }
  }
  return plain === code ? html : null;
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
 * Attach `lang` + `theme` to the shared highlighter. Resolves `false` for a
 * theme (or, under Shiki, a grammar) the backend does not know, which is a
 * normal outcome for a fence tagged with something made up: that block simply
 * stays plain. Highlights renders an unknown language as text in the theme's
 * foreground colour instead, and resolves `true`.
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
        preferredHighlighter: CODE_HIGHLIGHTER,
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

/**
 * Drop-in replacement for `hljs.highlightElement(el)`.
 *
 * Writes plain text immediately so the block has its final size and content on
 * the very first paint (no layout shift, no empty flash), then swaps in
 * highlighted markup when the grammar is attached. When the grammar is already
 * attached the highlighted markup is written straight away with no intermediate
 * plain state.
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
    el.textContent = code;
    notifyHighlightSwap(el);
    return;
  }

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

/** Test seam: forget every cached attachment and module handle. */
export function __resetCodeHighlightCacheForTests(): void {
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
