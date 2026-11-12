function unavailable(): never {
  throw new Error(
    '@pierre/highlights is not bundled by Plannotator: code is highlighted with Shiki ' +
      "(preferredHighlighter: 'shiki-js'). Remove the `@pierre/highlights` aliases in the app vite config to re-enable it.",
  );
}

export const codeToTokens = unavailable;
export const isSupportedLanguage = unavailable;

export class LiveTokenizer {
  constructor() {
    unavailable();
  }
}

export const themes = new Proxy({}, { get: unavailable, has: unavailable, ownKeys: unavailable, getOwnPropertyDescriptor: unavailable });
