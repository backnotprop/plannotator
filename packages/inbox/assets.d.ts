// Vite inlines these as data URLs in the window's and the surface's builds (assetsInlineLimit).
declare module '*.webp' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}

/** A file as one string (Vite and Bun). */
declare module '*?raw' {
  const text: string;
  export default text;
}

/** A Web Worker Vite builds and inlines (a blob URL at run time, no file to serve). Bun cannot load it. */
declare module '*?worker&inline' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
