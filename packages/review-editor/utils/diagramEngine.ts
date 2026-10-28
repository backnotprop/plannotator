/**
 * Loads code review's diagram engine on demand (see ./diagramEngineContract).
 *
 * Nothing here runs until a Markdown preview or a guide overview renders a
 * diagram fence AND the server advertised the engine. Then, once per page:
 * the host object (the page's React and ui modules, the runtime URLs) goes on
 * `globalThis`, and the engine file is imported by URL. A failed import is
 * dropped from the memo, so the next fence that mounts (a view switch, a
 * Retry) tries again; until then fences show as code.
 *
 * Every try after a failure imports the URL with a new query (`?r=1`, `?r=2`):
 * Chromium keeps a failed dynamic `import()` per URL and answers the same
 * failure again without fetching, so a Retry of the same URL would do
 * nothing. The first try keeps the plain URL, so the server's immutable
 * caching still applies; the server matches on the path alone. The runtime
 * URLs on the host follow the same rule (see `retryingUrl`).
 *
 * The namespace imports below are what the engine uses instead of its own
 * copies. They name modules the page already carries, so they cost the page
 * only the export names they keep alive.
 */
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import * as ThemeProviderModule from '@plannotator/ui/components/ThemeProvider';
import * as ConfigIndex from '@plannotator/ui/config';
import * as Identity from '@plannotator/ui/utils/identity';
import * as MathSlot from '@plannotator/ui/utils/math';
import {
  DIAGRAM_ENGINE_API_VERSION,
  DIAGRAM_ENGINE_HOST_KEY,
  type DiagramEngineHost,
  type DiagramEngineModule,
  type DiagramEngineSharedModule,
  type DiagramEngineUrls,
} from './diagramEngineContract';

export type DiagramEngineImporter = (url: string) => Promise<unknown>;

const importByUrl: DiagramEngineImporter = (url) => import(/* @vite-ignore */ url);

function sharedModules(): Record<DiagramEngineSharedModule, unknown> {
  return {
    react: React,
    'react/jsx-runtime': JsxRuntime,
    'react-dom': ReactDOM,
    'ui:components/ThemeProvider': ThemeProviderModule,
    'ui:config/index': ConfigIndex,
    'ui:utils/identity': Identity,
    'ui:utils/math': MathSlot,
  };
}

/** A same-origin absolute path, as the review server advertises them. */
const isServedPath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\s\\]/.test(value);

/** The `/api/diff` advert, or null when absent or malformed (fences then show as code). */
export function parseDiagramEngineUrls(value: unknown): DiagramEngineUrls | null {
  if (!value || typeof value !== 'object') return null;
  const { engine, mermaid, graphviz } = value as Record<string, unknown>;
  if (!isServedPath(engine) || !isServedPath(mermaid) || !isServedPath(graphviz)) return null;
  return { engine, mermaid, graphviz };
}

function asEngine(value: unknown): DiagramEngineModule {
  const mod = value as Partial<DiagramEngineModule> | null;
  if (!mod || mod.apiVersion !== DIAGRAM_ENGINE_API_VERSION || typeof mod.DiagramFence !== 'function') {
    throw new Error('The diagram engine this server sent does not match this page.');
  }
  return mod as DiagramEngineModule;
}

let memo: { url: string; promise: Promise<DiagramEngineModule> } | null = null;
let loaded: { url: string; engine: DiagramEngineModule } | null = null;
/** Failed imports per engine URL, for the retry query. */
const engineFailures = new Map<string, number>();

/** `url` on try 0, then `url?r=1`, `url?r=2`… (the advert never carries a query). */
export function withRetryQuery(url: string, tries: number): string {
  return tries > 0 ? `${url}${url.includes('?') ? '&' : '?'}r=${tries}` : url;
}

/**
 * The runtime URLs as the engine reads them: `import(host.runtimeUrls.mermaid)`
 * at call time. ui's renderer slot keeps a loaded runtime and shares one in
 * flight, so it reads the URL again only after an import failed (its own
 * automatic re-attempt, a later fence, its Retry). So the first read is the
 * plain URL and every later read carries a new retry query, which is what
 * makes Chromium fetch again.
 */
function retryingRuntimeUrls(urls: DiagramEngineUrls): DiagramEngineHost['runtimeUrls'] {
  const reads = { mermaid: 0, graphviz: 0 };
  const read = (kind: keyof typeof reads) => withRetryQuery(urls[kind], reads[kind]++);
  return Object.defineProperties({} as DiagramEngineHost['runtimeUrls'], {
    mermaid: { enumerable: true, get: () => read('mermaid') },
    graphviz: { enumerable: true, get: () => read('graphviz') },
  });
}

/** The engine, if it already loaded from these URLs (so a fence mounted
 * after the load renders it on its first render, with no code flash). */
export function peekDiagramEngine(urls: DiagramEngineUrls): DiagramEngineModule | null {
  return loaded && loaded.url === urls.engine ? loaded.engine : null;
}

/** Import the engine once; concurrent and later callers share the import. */
export function loadDiagramEngine(urls: DiagramEngineUrls, importer: DiagramEngineImporter = importByUrl): Promise<DiagramEngineModule> {
  if (memo && memo.url === urls.engine) return memo.promise;
  const host: DiagramEngineHost = {
    apiVersion: DIAGRAM_ENGINE_API_VERSION,
    modules: sharedModules(),
    runtimeUrls: retryingRuntimeUrls(urls),
  };
  (globalThis as Record<string, unknown>)[DIAGRAM_ENGINE_HOST_KEY] = host;
  const tries = engineFailures.get(urls.engine) ?? 0;
  const promise = importer(withRetryQuery(urls.engine, tries)).then(asEngine);
  const entry = { url: urls.engine, promise };
  memo = entry;
  promise.then(
    (engine) => {
      if (memo === entry) loaded = { url: urls.engine, engine };
    },
    () => {
      engineFailures.set(urls.engine, tries + 1);
      if (memo === entry) memo = null;
    },
  );
  return promise;
}

/** Test hook: forget the engine and the host. */
export function __resetDiagramEngineForTests(): void {
  memo = null;
  loaded = null;
  engineFailures.clear();
  delete (globalThis as Record<string, unknown>)[DIAGRAM_ENGINE_HOST_KEY];
}
