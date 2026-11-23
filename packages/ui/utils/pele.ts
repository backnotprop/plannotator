/**
 * The Pele runtime slot (https://pele.run, MIT, pinned 1.3.0): a second
 * engine for Mermaid-syntax fences. Mermaid stays the engine for every fence
 * unless `diagram-engine.ts` says otherwise.
 *
 * Pele's library is in a build only when `PELE_IN_BUILD` (below) is true,
 * which is when `DIAGRAM_ENGINE_MODE` is not `'mermaid'`. While it is
 * `'mermaid'` (shipped) the `import('pele/lazy')` sits in a branch every
 * bundler sees is dead, so no build output carries any of Pele, the
 * single-file builds that inline every dynamic import included
 * (`tests/entry-assets.test.ts` reads the artifacts; the review diagram
 * engine's `guardBundle` refuses it). Tests reach the library through
 * `__setPeleRuntimeLoaderForTests(peleRuntimeFrom)` (`test-setup/pele.ts`).
 *
 * Loaded through `pele/lazy`: the core (parser front, layout, svg writer)
 * arrives on the first Pele render, and each diagram type's code arrives on
 * that type's first render, as its own chunk. Pele renders synchronously
 * once a type is loaded, with no DOM: the text measurer below is the only
 * browser API it is handed.
 */
import type { RenderOptions, RenderResult, TextMeasurer } from 'pele';
import type * as PeleLazy from 'pele/lazy';
import { DIAGRAM_ENGINE_MODE } from './diagram-engine';
import { MERMAID_LABEL_WRAP_WIDTH } from './mermaid';

export const PELE_SOURCE_LIMIT = 100_000;
export const PELE_OUTPUT_LIMIT = 1_000_000;
export const PELE_MAX_EDGES = 5_000;

export interface PeleRuntime {
  /** Whether Pele has a renderer for the source's diagram type (loads that type's chunk when it has). */
  supports(source: string): Promise<boolean>;
  render(source: string, options: RenderOptions): Promise<RenderResult>;
}

let runtimePromise: Promise<PeleRuntime> | undefined;
/** `pele/lazy`'s own `supports()` knows only the types already loaded, so
 * the check is: a type is detected, and its chunk loads. */
export function peleRuntimeFrom(pele: typeof PeleLazy): PeleRuntime {
  return {
    async supports(source: string) {
      const type = pele.detectType(source);
      return type !== null && (await pele.load(type));
    },
    render: pele.renderAsync,
  };
}

/**
 * Whether Pele's library is part of the build: false while
 * `DIAGRAM_ENGINE_MODE` is `'mermaid'`. Flipping the mode is the one change
 * that brings it back, as lazy chunks (`PELE.md`, "Turning Pele on").
 */
export const PELE_IN_BUILD: boolean = DIAGRAM_ENGINE_MODE !== 'mermaid';

/** A conditional on a constant, so Rollup drops the import, and with it
 * every Pele chunk, from a build where `PELE_IN_BUILD` is false. */
function importPele(): Promise<PeleRuntime> {
  return PELE_IN_BUILD
    ? import('pele/lazy').then(peleRuntimeFrom)
    : Promise.reject(new Error("Pele is not part of this build: DIAGRAM_ENGINE_MODE is 'mermaid'."));
}

let loader: () => Promise<PeleRuntime> = importPele;

/** The runtime, imported on first use; a failed import is forgotten so a Retry imports again. */
export function loadPeleRuntime(): Promise<PeleRuntime> {
  if (runtimePromise === undefined) {
    runtimePromise = loader();
    void runtimePromise.catch(() => {
      runtimePromise = undefined;
    });
  }
  return runtimePromise;
}

/** Test hook: stand in for the import (a failing chunk, a counting loader). */
export function __setPeleRuntimeLoaderForTests(next: (() => Promise<PeleRuntime>) | undefined): void {
  loader = next ?? importPele;
  runtimePromise = undefined;
}

/** A document-unique id prefix for one render, accessibility title and description ids included. */
export function peleSvgId(renderId: string): string {
  return `plannotator-pele-${renderId.replace(/[^a-zA-Z0-9_-]/gu, '-')}`;
}

/**
 * The label wrap width Mermaid gets (`MERMAID_LABEL_WRAP_WIDTH`), for every
 * type that reads one from its config section, so a label breaks where it
 * breaks under Mermaid.
 */
const WRAP_CONFIG = Object.fromEntries(
  ['flowchart', 'state', 'class', 'er', 'requirement', 'block', 'mindmap'].map((section) => [
    section,
    { wrappingWidth: MERMAID_LABEL_WRAP_WIDTH },
  ]),
);

export interface PeleFonts {
  readonly sans: string;
  readonly mono: string;
}

/** The app's font stacks, read off the document; Pele's own defaults without one. */
export function peleFonts(): PeleFonts {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return { sans: 'sans-serif', mono: 'monospace' };
  }
  const style = getComputedStyle(document.documentElement);
  return {
    sans: style.getPropertyValue('--font-sans').trim() || 'sans-serif',
    mono: style.getPropertyValue('--font-mono').trim() || 'monospace',
  };
}

/** Render one source: links and images off, the app's fonts, measured on a canvas when there is one. */
export function renderPeleSource(
  runtime: PeleRuntime,
  source: string,
  renderId: string,
  fonts: PeleFonts = peleFonts(),
  wrapMeasurer?: (base: TextMeasurer | undefined) => TextMeasurer | undefined,
): Promise<RenderResult> {
  const base = canvasMeasurer(fonts);
  const measurer = wrapMeasurer === undefined ? base : wrapMeasurer(base);
  return runtime.render(source, {
    idPrefix: peleSvgId(renderId),
    fontFamily: fonts.sans,
    fontFamilyMono: fonts.mono,
    ...(measurer === undefined ? {} : { measurer }),
    links: false,
    images: false,
    limit: PELE_SOURCE_LIMIT,
    outputLimit: PELE_OUTPUT_LIMIT,
    maxEdges: PELE_MAX_EDGES,
    responsive: false,
    config: WRAP_CONFIG,
  });
}

export function canvasMeasurer(fonts: PeleFonts): TextMeasurer | undefined {
  if (typeof document === 'undefined') return undefined;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = document.createElement('canvas').getContext('2d');
  } catch {
    return undefined;
  }
  if (context === null || typeof context.measureText !== 'function') return undefined;
  const ctx = context;
  return {
    width(text, size, style) {
      const italic = (style & 2) !== 0 ? 'italic ' : '';
      const bold = (style & 1) !== 0 ? 'bold ' : '';
      const family = (style & 4) !== 0 ? fonts.mono : fonts.sans;
      ctx.font = `${italic}${bold}${size}px ${family}`;
      return ctx.measureText(text).width;
    },
  };
}
