/**
 * A thread, an attachment or a diff is drawn once its code and math can be
 * drawn finished (#2593).
 *
 * The window's scripts are code-split (build/pack-inbox.ts): Pierre's
 * highlighter, each Shiki grammar and KaTeX are chunks the Inbox serves on
 * first use. Inlined, they were there before the first thread opened, so a
 * fence painted highlighted and math painted typeset at once. Split, ui's
 * CodeBlock and math components would paint plain code or TeX source first and
 * swap the finished markup in when the chunk lands, and Pierre's file and diff
 * views would paint their lines plain first. So a read waits for what it needs,
 * then draws: no plain frame, as before. Something with no code or math is not
 * held up, and a language or KaTeX already loaded costs nothing.
 *
 * A chunk that fails is asked for again on the next open (the Inbox may be
 * back). A chunk that stalls holds a read at most DRAW_READY_CAP_MS once: later
 * opens draw at once while it is still on its way, and ui swaps the finished
 * markup in when it lands.
 */

import type { InboxThread } from '@plannotator/core/inbox-types';
import type { Block } from '@plannotator/ui/types';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import { areLanguagesAttached, areThemesAttached, getFiletypeFromFileName, getHighlighterIfLoaded } from '@pierre/diffs';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { ensureHighlight, forgetHighlightRejection } from '@plannotator/ui/utils/codeHighlight';
import { getMathRenderer, loadMathRenderer } from '@plannotator/ui/utils/math';
import { isGraphvizLanguage, isMermaidLanguage } from '@plannotator/ui/components/diagramLanguages';
import { DEFAULT_SYNTAX_THEME, resolveFenceTheme } from '@plannotator/ui/utils/syntaxTheme';

/**
 * A safety cap, never reached in use (a grammar arrives in a few ms over loopback, ~100 ms over a tailnet):
 * a chunk that never answers must not keep a thread closed. Past it the thread draws, and ui swaps the
 * finished markup in when the chunk lands.
 */
export const DRAW_READY_CAP_MS = 4000;
let capMs = DRAW_READY_CAP_MS;
/** Test seam: a shorter cap (undefined: back to DRAW_READY_CAP_MS). */
export function __setDrawReadyCapForTests(ms: number | undefined): void {
  capMs = ms ?? DRAW_READY_CAP_MS;
}

type ThemePair = { dark: string; light: string };

/** The fence theme the window draws in now, kept by WarmCodeHighlight (inside the ThemeProvider). */
let theme = resolveFenceTheme('plannotator', 'dark');
/** The theme pair Pierre's diff views draw in now (usePierreTheme's `syntaxTheme`, else Pierre's own). */
let diffThemes: ThemePair = DEFAULT_SYNTAX_THEME;
export function setThreadFenceTheme(next: string): void {
  theme = next;
}
export function setDiffThemes(next: ThemePair | undefined): void {
  diffThemes = next ?? DEFAULT_SYNTAX_THEME;
}

/** `$…$`, `\(…\)`, `\[…\]` or `$$`: a body that may hold math (over-matching only loads KaTeX once). */
const MATH_HINT = /\$[^\s$][^$\n]*\$|\$\$|\\\(|\\\[/;
const FENCE_HINT = /```|~~~/;

/** What a Markdown text needs before it draws finished: the fence languages ui highlights, and KaTeX. */
interface Needs {
  langs: readonly string[];
  math: boolean;
}
const NOTHING: Needs = { langs: [], math: false };

export function needs(body: string): Needs {
  if (!FENCE_HINT.test(body) && !MATH_HINT.test(body)) return NOTHING;
  const langs = new Set<string>();
  let math = false;
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      if (block.type === 'code') {
        // Diagrams draw through their own runtime, never as a highlighted fence.
        if (block.language && !isMermaidLanguage(block.language) && !isGraphvizLanguage(block.language)) langs.add(block.language);
      } else if (block.type === 'math') math = true;
      else if (block.type === 'directive') walk(parseMarkdownToBlocks(block.content, { frontmatter: false }));
      else if (block.type !== 'html' && MATH_HINT.test(block.content)) math = true;
    }
  };
  walk(parseMarkdownToBlocks(body, { frontmatter: false }));
  return { langs: [...langs], math };
}

/** The last thread read's needs per message id, with the body they were read from: a re-read parses only what changed. */
let parsed = new Map<string, { body: string; needs: Needs }>();

/** A load that outlived the cap once and is still on its way: later reads do not wait for it again. */
const stalled = new WeakSet<Promise<unknown>>();

/** `lang` attached in every theme of `themes`, asking again for a pair that failed before. */
function grammar(lang: string, themes: readonly string[]): Promise<unknown>[] {
  return themes.map((name) => {
    forgetHighlightRejection(lang, name);
    return ensureHighlight(lang, name);
  });
}

/** Resolves when every load has settled, or at the cap; a load that stalled once is not waited for again. */
function settle(loads: Promise<unknown>[]): Promise<void> {
  const live = loads.filter((load) => !stalled.has(load));
  if (live.length === 0) return Promise.resolve();
  const done = new Set<Promise<unknown>>();
  for (const load of live) {
    const mark = () => void done.add(load);
    load.then(mark, mark);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>(
    (resolve) =>
      (timer = setTimeout(() => {
        for (const load of live) {
          if (done.has(load)) continue;
          stalled.add(load);
          const clear = () => void stalled.delete(load);
          load.then(clear, clear);
        }
        resolve();
      }, capMs)),
  );
  return Promise.race([Promise.all(live.map((load) => load.then(undefined, () => undefined))).then(() => undefined), cap]).finally(() => clearTimeout(timer));
}

function waitFor(langs: Iterable<string>, themes: readonly string[], math: boolean): Promise<void> {
  const loads: Promise<unknown>[] = [];
  for (const lang of langs) loads.push(...grammar(lang, themes));
  if (math && !getMathRenderer()) loads.push(loadMathRenderer());
  return settle(loads);
}

/** Resolves when every fence of the thread can paint highlighted and its math typeset (or at the cap). Never rejects. */
export function threadDrawReady(thread: InboxThread): Promise<void> {
  const langs = new Set<string>();
  let math = false;
  const next = new Map<string, { body: string; needs: Needs }>();
  for (const message of thread.messages) {
    const body = message.body ?? '';
    const seen = parsed.get(message.id);
    const found = seen && seen.body === body ? seen.needs : needs(body);
    next.set(message.id, { body, needs: found });
    for (const lang of found.langs) langs.add(lang);
    if (found.math) math = true;
  }
  parsed = next;
  return waitFor(langs, [theme], math);
}

/**
 * The same for an attachment the pane draws: a Markdown or text file through ui's Viewer (its fences and math),
 * a code file through Pierre's file view (its language, in Pierre's own themes). `highlight` false: a code file
 * too long to highlight, drawn plain on purpose.
 */
export function attachmentDrawReady(kind: string, name: string, text: string, highlight = true): Promise<void> {
  if (kind === 'code') {
    if (!highlight) return Promise.resolve();
    const lang = getFiletypeFromFileName(name);
    if (lang === 'text' || lang === 'ansi') return Promise.resolve();
    return waitFor([lang], [DEFAULT_SYNTAX_THEME.dark, DEFAULT_SYNTAX_THEME.light], false);
  }
  if (kind === 'markdown' || kind === 'text') {
    const found = needs(text);
    return waitFor(found.langs, [theme], found.math);
  }
  return Promise.resolve();
}

/** A guided or code review's diff languages, as Pierre names them: each file's, before and after a rename. */
export function diffLanguages(rawPatch: string): string[] {
  const langs = new Set<string>();
  for (const file of parseDiffToFiles(rawPatch)) {
    for (const path of [file.path, file.oldPath]) {
      if (!path) continue;
      const lang = getFiletypeFromFileName(path);
      if (lang !== 'text' && lang !== 'ansi') langs.add(lang);
    }
  }
  return [...langs];
}

/** Whether Pierre would draw these languages' diff lines highlighted on its first render, as things stand. */
export function diffReadyNow(langs: readonly string[]): boolean {
  if (langs.length === 0) return true;
  return getHighlighterIfLoaded() !== undefined && areThemesAttached(diffThemes) && areLanguagesAttached([...langs]);
}

/** The same wait for a review's diff: its languages, in the diff themes. */
export function diffDrawReady(langs: readonly string[]): Promise<void> {
  return waitFor(langs, [diffThemes.dark, diffThemes.light], false);
}
