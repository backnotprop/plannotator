/**
 * The Inbox's `CodeHighlightWorker` (@plannotator/ui/utils/codeHighlight): the markup of a code fence waiting off
 * screen is made in a Web Worker (codeHighlight.worker.ts, fenceMarkup.ts), so a long thread's fences are not
 * tokenized on the page. The page then only writes the markup, in idle time or as the fence comes near.
 *
 * The worker starts on the first fence that waits, once per page. It has no grammars of its own: each request
 * carries those the page's highlighter has attached and the worker has not been sent (all of them, so a grammar
 * that injects into another one is there too), and the request's theme, as Pierre resolved them. Anything that
 * fails (no Worker, a CSP that refuses it, a grammar that does not clone) answers null, and the page highlights
 * that fence itself, as it did before.
 */
import { AttachedLanguages, ResolvedLanguages, getResolvedThemes } from '@pierre/diffs';
import type { CodeHighlightWorker } from '@plannotator/ui/utils/codeHighlight';
import type { FenceLanguage, FenceMarkupReply, FenceMarkupRequest } from './fenceMarkup';

/** The page's attached grammars, by name, as Pierre resolved them (what the worker must have too). */
export interface FenceGrammars {
  attached: () => Iterable<string>;
  resolved: (name: string) => FenceLanguage | undefined;
  theme: (name: string) => FenceMarkupRequest['themes'];
}

const pierreGrammars: FenceGrammars = {
  attached: () => AttachedLanguages,
  resolved: (name) => ResolvedLanguages.get(name) as FenceLanguage | undefined,
  // Pierre resolves a theme as its own DiffsTheme (since 1.6); the worker's Shiki loads the TextMate theme inside
  // it, under the name the page asks for.
  theme: (name) => getResolvedThemes([name as never]).flatMap((theme) => (theme.textmate ? [{ ...theme.textmate, name }] : [])),
};

export function createInboxCodeHighlightWorker(start: () => Promise<Worker>, grammars: FenceGrammars = pierreGrammars): CodeHighlightWorker {
  let started: Promise<Worker | null> | null = null;
  let broken = false;
  let nextId = 0;
  const waiting = new Map<number, (html: string | null) => void>();
  const sentLangs = new Set<string>();
  const sentThemes = new Set<string>();
  const fail = () => {
    broken = true;
    for (const done of waiting.values()) done(null);
    waiting.clear();
  };
  const worker = () =>
    (started ??= start().then(
      (w) => {
        w.addEventListener('message', (event: MessageEvent<FenceMarkupReply>) => {
          const done = waiting.get(event.data?.id);
          if (!done) return;
          waiting.delete(event.data.id);
          done(typeof event.data.html === 'string' ? event.data.html : null);
        });
        w.addEventListener('error', fail);
        w.addEventListener('messageerror', fail);
        return w;
      },
      () => {
        fail();
        return null;
      },
    ));
  return {
    async html(code, lang, theme) {
      if (broken) return null;
      const w = await worker();
      if (!w || broken) return null;
      const langs: FenceLanguage[] = [];
      for (const name of grammars.attached()) {
        if (sentLangs.has(name)) continue;
        const resolved = grammars.resolved(name);
        if (resolved) langs.push(resolved);
      }
      let themes: FenceMarkupRequest['themes'] = [];
      if (!sentThemes.has(theme)) {
        try {
          themes = grammars.theme(theme);
        } catch {
          return null;
        }
      }
      const id = ++nextId;
      return new Promise<string | null>((resolve) => {
        waiting.set(id, resolve);
        try {
          w.postMessage({ id, code, lang, theme, langs, themes } satisfies FenceMarkupRequest);
        } catch {
          waiting.delete(id);
          resolve(null);
          return;
        }
        for (const lang of langs) sentLangs.add(lang.name);
        sentThemes.add(theme);
      });
    },
  };
}
