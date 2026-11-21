/**
 * A code fence's highlighted markup, made away from the page: the core of the Inbox's highlight worker
 * (`codeHighlight.worker.ts`), kept free of worker globals so a test runs it as it is.
 *
 * It must give the page's own characters (`highlightToHtml` in @plannotator/ui/utils/codeHighlight), so it
 * runs what the page runs: Shiki's core with its JavaScript regex engine (the page's Pierre highlighter is a
 * Shiki highlighter on that engine), `shiki` pinned in package.json to the version @pierre/diffs resolves
 * (codeHighlightWorker.test.ts fails when they part), the grammars and themes the page already resolved (sent
 * with the requests), and ui's markup builder (`themedLinesToHtml`) over the tokens.
 */
import { createHighlighterCore, type LanguageRegistration, type ThemeRegistrationResolved } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { themedLinesToHtml } from '@plannotator/ui/utils/codeHighlightHtml';

/** A grammar as Pierre resolves it: its name and the registrations it needs (itself and what it embeds). */
export interface FenceLanguage {
  name: string;
  data: LanguageRegistration[];
}

export interface FenceMarkupRequest {
  id: number;
  code: string;
  lang: string;
  theme: string;
  /** Grammars and themes this maker has not been sent yet. */
  langs?: FenceLanguage[];
  themes?: ThemeRegistrationResolved[];
}

export interface FenceMarkupReply {
  id: number;
  /** The markup, or null when it could not be made (the page highlights the fence itself). */
  html: string | null;
}

export function createFenceMarkup(): (request: FenceMarkupRequest) => Promise<FenceMarkupReply> {
  const highlighter = createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine() });
  const langs = new Set<string>();
  const themes = new Set<string>();
  const warm = new Set<string>();
  return async (request) => {
    try {
      const shiki = await highlighter;
      for (const lang of request.langs ?? []) {
        if (langs.has(lang.name)) continue;
        shiki.loadLanguageSync(lang.data);
        langs.add(lang.name);
      }
      for (const theme of request.themes ?? []) {
        if (themes.has(theme.name)) continue;
        shiki.loadThemeSync(theme);
        themes.add(theme.name);
      }
      // In JavaScriptCore (Safari, Bun) Shiki's JavaScript engine colours a grammar's first fence in a realm
      // differently from every later one (Chromium does not). The page has drawn fences before; this realm
      // has not, so its first fence in each grammar is made twice and the second is kept.
      if (!warm.has(request.lang)) {
        shiki.codeToTokens(request.code, { lang: request.lang, theme: request.theme });
        warm.add(request.lang);
      }
      const { tokens } = shiki.codeToTokens(request.code, { lang: request.lang, theme: request.theme });
      return { id: request.id, html: themedLinesToHtml(tokens, request.code) };
    } catch {
      return { id: request.id, html: null };
    }
  };
}
