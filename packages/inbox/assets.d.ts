// Vite inlines these as data URLs in the window's and the surface's builds (assetsInlineLimit).
declare module '*.webp' {
  const src: string;
  export default src;
}
