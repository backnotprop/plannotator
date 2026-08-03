// Vite globals injected at build time
declare const __APP_VERSION__: string;

// Image asset module declarations live in ../globals.d.ts (the package's
// ambient-declaration home, /// <reference>'d by each asset-importing
// component so consumer compilers load them too). Declaring them here as
// well would be a duplicate-identifier error under skipLibCheck: false.
