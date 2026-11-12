import { createHighlighterCore, type LanguageRegistration, type ThemeRegistrationResolved } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { themedLinesToHtml } from '@plannotator/ui/utils/codeHighlightHtml';

export interface FenceLanguage {
  name: string;
  data: LanguageRegistration[];
}

export interface FenceMarkupRequest {
  id: number;
  code: string;
  lang: string;
  theme: string;
  langs?: FenceLanguage[];
  themes?: ThemeRegistrationResolved[];
}

export interface FenceMarkupReply {
  id: number;
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
