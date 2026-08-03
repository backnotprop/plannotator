// Allow side-effect CSS imports (highlight.js themes, overlayscrollbars, etc.)
declare module '*.css';

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
