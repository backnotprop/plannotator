/**
 * The contract between the review page and its diagram engine.
 *
 * Code review draws Mermaid and Graphviz fences (Markdown preview, guide
 * overviews) with ui's DiagramBlock, but the engine never rides in the
 * single-file review page: the Mermaid and Graphviz runtimes are ~6.7 MB,
 * and the page build inlines every dynamic import. So the engine is built as
 * three separate files (apps/review/diagram-engine), served by the review
 * server, and imported by URL only when a preview or guide overview actually
 * holds a diagram (owner approval "review-diagrams-on-demand").
 *
 * - `engine`: DiagramBlock's React layer (canvas, overlay, popout, the
 *   renderer slot). It brings no React and none of ui's stateful modules of
 *   its own: those are the page's, handed over in `DiagramEngineHost.modules`
 *   before the import, so hooks, the theme context and the config store are
 *   the page's own instances.
 * - `mermaid` / `graphviz`: the runtimes, imported by the engine from the
 *   URLs in `DiagramEngineHost.runtimeUrls` on the first diagram of each kind.
 *
 * Type-only for the engine side; this module imports nothing at runtime.
 */
import type { ComponentType } from 'react';
import type { Block } from '@plannotator/ui/types';

/** Where the page puts the host before importing the engine. */
export const DIAGRAM_ENGINE_HOST_KEY = '__plannotatorDiagramEngineHost';

/** Bumped when the engine's exports or the host shape change incompatibly. */
export const DIAGRAM_ENGINE_API_VERSION = 1;

/** The server's advert (`diagramEngine` on `/api/diff`): absolute paths on the
 *  review server, each named by its content hash. Absent: the host cannot
 *  serve the engine, and diagram fences show as code. */
export interface DiagramEngineUrls {
  engine: string;
  mermaid: string;
  graphviz: string;
}

/**
 * The page's modules the engine uses instead of bundling its own copies.
 * `ui:` keys are paths under packages/ui without the extension. Each is
 * React itself or stateful (the theme context, the config store, the
 * identity and math slots); a second copy would split that state. These are
 * exactly the stateful modules the diagram components import directly; what
 * those import in turn (the store's settings, storage, the theme registry)
 * then never enters the engine. The engine build fails when it would bundle
 * a stateful ui module or a React context of its own anyway
 * (apps/review/diagram-engine/build.ts).
 */
export const DIAGRAM_ENGINE_SHARED_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'ui:components/ThemeProvider',
  'ui:config/index',
  'ui:utils/identity',
  'ui:utils/math',
] as const;

export type DiagramEngineSharedModule = (typeof DIAGRAM_ENGINE_SHARED_MODULES)[number];

export interface DiagramEngineHost {
  apiVersion: typeof DIAGRAM_ENGINE_API_VERSION;
  modules: Record<DiagramEngineSharedModule, unknown>;
  /** Read by the engine at each runtime import. A read after the first may
   *  carry a retry query (`?r=1`), so a failed import is fetched again. */
  runtimeUrls: { mermaid: string; graphviz: string };
}

export type DiagramEngineKind = 'mermaid' | 'graphviz';

export interface DiagramFenceProps {
  kind: DiagramEngineKind;
  block: Block;
}

/** What the engine module exports. */
export interface DiagramEngineModule {
  apiVersion: number;
  DiagramFence: ComponentType<DiagramFenceProps>;
}
