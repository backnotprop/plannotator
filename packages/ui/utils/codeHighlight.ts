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

/** Shiki's `FontStyle` bitmask. Inlined so this module needs no shiki types. */
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

let pierre: PierreModule | undefined;
let pierreLoad: Promise<PierreModule | undefined> | undefined;

/** `${lang} ${theme}` pairs attached to the shared highlighter. */
const ready = new Set<string>();
/** Pairs the highlighter refused (unknown grammar or theme). Never retried. */
const rejected = new Set<string>();
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
  const mod = pierre;
  if (!mod || !ready.has(pairKey(lang, theme))) return null;
  const highlighter = mod.getHighlighterIfLoaded();
  if (!highlighter) {
    // The shared highlighter was disposed out from under us; everything we
    // believed was attached is gone with it.
    ready.clear();
    return null;
  }
  let lines: ThemedTokenish[][];
  try {
    lines = highlighter.codeToTokens(code, { lang, theme }).tokens as ThemedTokenish[][];
  } catch {
    ready.delete(pairKey(lang, theme));
    return null;
  }

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
    .catch(() => {
      rejected.add(key);
      return false;
    })
    .then((ok) => {
      inflight.delete(key);
      return ok;
    });

  inflight.set(key, load);
  return load;
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
