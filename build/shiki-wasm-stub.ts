function unavailable(): never {
  throw new Error(
    "shiki/wasm is not bundled by Plannotator: the Oniguruma engine is stubbed out " +
      "in favour of Shiki's JavaScript regex engine (preferredHighlighter: 'shiki-js'). " +
      'Remove the `shiki/wasm` alias in the app vite config to re-enable it.',
  );
}

export default unavailable;
