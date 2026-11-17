// Allow side-effect CSS imports (overlayscrollbars, fontsource, etc.)
declare module '*.css';

// A stylesheet as text, put into the page only while its component is mounted (the canvas's Excalidraw sheet).
declare module '*.css?inline' {
  const css: string;
  export default css;
}

// Image asset imports (sprites, screenshots). Consumers compiling this shipped
// source need these ambient declarations too — each asset-importing component
// carries a /// <reference> to this file so any program that includes it gets them.
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.webp' {
  const src: string;
  export default src;
}
// Video asset imports (announcement demo recordings). Inlined as data URIs by
// the single-file build (assetsInlineLimit), so the import resolves to a string.
declare module '*.webm' {
  const src: string;
  export default src;
}
