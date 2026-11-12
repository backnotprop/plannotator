import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import * as ThemeProviderModule from '@plannotator/ui/components/ThemeProvider';
import * as ConfigIndex from '@plannotator/ui/config';
import * as Identity from '@plannotator/ui/utils/identity';
import * as MathSlot from '@plannotator/ui/utils/math';
import * as CommentDraftScope from '@plannotator/ui/utils/commentDraftScope';
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
    'ui:utils/commentDraftScope': CommentDraftScope,
  };
}

const isServedPath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\s\\]/.test(value);

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
const engineFailures = new Map<string, number>();

export function withRetryQuery(url: string, tries: number): string {
  return tries > 0 ? `${url}${url.includes('?') ? '&' : '?'}r=${tries}` : url;
}

function retryingRuntimeUrls(urls: DiagramEngineUrls): DiagramEngineHost['runtimeUrls'] {
  const reads = { mermaid: 0, graphviz: 0 };
  const read = (kind: keyof typeof reads) => withRetryQuery(urls[kind], reads[kind]++);
  return Object.defineProperties({} as DiagramEngineHost['runtimeUrls'], {
    mermaid: { enumerable: true, get: () => read('mermaid') },
    graphviz: { enumerable: true, get: () => read('graphviz') },
  });
}

export function peekDiagramEngine(urls: DiagramEngineUrls): DiagramEngineModule | null {
  return loaded && loaded.url === urls.engine ? loaded.engine : null;
}

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

export function __resetDiagramEngineForTests(): void {
  memo = null;
  loaded = null;
  engineFailures.clear();
  delete (globalThis as Record<string, unknown>)[DIAGRAM_ENGINE_HOST_KEY];
}
