// Vite inlines these as data URLs in the single-file build.
declare module '*.webp' {
  const src: string;
  export default src;
}
