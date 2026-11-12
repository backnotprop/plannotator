import type { InboxThread } from '@plannotator/core/inbox-types';
import type { Block } from '@plannotator/ui/types';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import { areLanguagesAttached, areThemesAttached, getFiletypeFromFileName, getHighlighterIfLoaded } from '@pierre/diffs';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { ensureHighlight, forgetHighlightRejection, highlightRejection } from '@plannotator/ui/utils/codeHighlight';
import { failedChunkUrl } from '@plannotator/ui/components/LazyBlockBoundary';
import { getMathRenderer, loadMathRenderer } from '@plannotator/ui/utils/math';
import { isGraphvizLanguage, isMermaidLanguage } from '@plannotator/ui/components/diagramLanguages';
import { DEFAULT_SYNTAX_THEME, resolveFenceTheme } from '@plannotator/ui/utils/syntaxTheme';

export const DRAW_READY_CAP_MS = 4000;
let capMs = DRAW_READY_CAP_MS;
export function __setDrawReadyCapForTests(ms: number | undefined): void {
  capMs = ms ?? DRAW_READY_CAP_MS;
}

type ThemePair = { dark: string; light: string };

let theme = resolveFenceTheme('plannotator', 'dark');
let diffThemes: ThemePair = DEFAULT_SYNTAX_THEME;
export function setThreadFenceTheme(next: string): void {
  theme = next;
}
export function setDiffThemes(next: ThemePair | undefined): void {
  diffThemes = next ?? DEFAULT_SYNTAX_THEME;
}

const MATH_HINT = /\$[^\s$][^$\n]*\$|\$\$|\\\(|\\\[/;
const FENCE_HINT = /```|~~~/;

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
        if (block.language && !isMermaidLanguage(block.language) && !isGraphvizLanguage(block.language)) langs.add(block.language);
      } else if (block.type === 'math') math = true;
      else if (block.type === 'directive') walk(parseMarkdownToBlocks(block.content, { frontmatter: false }));
      else if (block.type !== 'html' && MATH_HINT.test(block.content)) math = true;
    }
  };
  walk(parseMarkdownToBlocks(body, { frontmatter: false }));
  return { langs: [...langs], math };
}

let parsed = new Map<string, { body: string; needs: Needs }>();

const stalled = new WeakSet<Promise<unknown>>();

const gone = new Set<string>();
const checked = new WeakSet<Promise<boolean>>();

function grammar(lang: string, themes: readonly string[]): Promise<unknown>[] {
  return themes.map((name) => {
    const key = `${lang} ${name}`;
    if (gone.has(key)) return ensureHighlight(lang, name);
    forgetHighlightRejection(lang, name);
    const load = ensureHighlight(lang, name);
    if (!checked.has(load)) {
      checked.add(load);
      void load.then((ok) => {
        if (!ok) checkGone(lang, name, key);
      });
    }
    return load;
  });
}

function checkGone(lang: string, name: string, key: string): void {
  const url = failedChunkUrl(highlightRejection(lang, name)?.cause);
  if (url === null || typeof fetch !== 'function') return;
  fetch(url, { method: 'HEAD', cache: 'no-store' }).then(
    (response) => {
      if (response.status === 404) gone.add(key);
    },
    () => {},
  );
}

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

const read = new Map<string, { text: string; needs: Needs }>();
const READ_KEPT = 8;

export function attachmentDrawReady(kind: string, name: string, text: string, highlight = true): Promise<void> {
  if (kind === 'code') {
    if (!highlight) return Promise.resolve();
    const lang = getFiletypeFromFileName(name);
    if (lang === 'text' || lang === 'ansi') return Promise.resolve();
    return waitFor([lang], [DEFAULT_SYNTAX_THEME.dark, DEFAULT_SYNTAX_THEME.light], false);
  }
  if (kind === 'markdown' || kind === 'text') {
    const seen = read.get(name);
    const found = seen && seen.text === text ? seen.needs : needs(text);
    read.delete(name);
    read.set(name, { text, needs: found });
    if (read.size > READ_KEPT) read.delete(read.keys().next().value!);
    return waitFor(found.langs, [theme], found.math);
  }
  return Promise.resolve();
}

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

export function diffReadyNow(langs: readonly string[]): boolean {
  if (langs.length === 0) return true;
  return getHighlighterIfLoaded() !== undefined && areThemesAttached(diffThemes) && areLanguagesAttached([...langs]);
}

export function diffDrawReady(langs: readonly string[]): Promise<void> {
  return waitFor(langs, [diffThemes.dark, diffThemes.light], false);
}
