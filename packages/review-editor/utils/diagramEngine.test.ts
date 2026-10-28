/**
 * The on-demand diagram engine loader: the advert is read strictly, the
 * engine is imported once per page (concurrent fences share the import), the
 * host carries the page's own modules and the runtime URLs before the import,
 * and a failed or mismatched import is forgotten so the next fence retries.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import * as MathSlot from '@plannotator/ui/utils/math';
import {
  __resetDiagramEngineForTests,
  loadDiagramEngine,
  parseDiagramEngineUrls,
  peekDiagramEngine,
} from './diagramEngine';
import { DIAGRAM_ENGINE_HOST_KEY, DIAGRAM_ENGINE_SHARED_MODULES, type DiagramEngineHost } from './diagramEngineContract';

const URLS = {
  engine: '/assets/diagram-engine/engine-aaaa.js',
  mermaid: '/assets/diagram-engine/mermaid-bbbb.js',
  graphviz: '/assets/diagram-engine/graphviz-cccc.js',
};
const ENGINE = { apiVersion: 1, DiagramFence: () => null };

afterEach(() => __resetDiagramEngineForTests());

describe('parseDiagramEngineUrls', () => {
  test('takes three same-origin paths', () => {
    expect(parseDiagramEngineUrls(URLS)).toEqual(URLS);
  });

  test('absent or malformed adverts read as no engine', () => {
    expect(parseDiagramEngineUrls(undefined)).toBeNull();
    expect(parseDiagramEngineUrls(null)).toBeNull();
    expect(parseDiagramEngineUrls('x')).toBeNull();
    expect(parseDiagramEngineUrls({ engine: URLS.engine, mermaid: URLS.mermaid })).toBeNull();
    expect(parseDiagramEngineUrls({ ...URLS, engine: '//evil.example/engine.js' })).toBeNull();
    expect(parseDiagramEngineUrls({ ...URLS, engine: 'https://evil.example/engine.js' })).toBeNull();
    expect(parseDiagramEngineUrls({ ...URLS, mermaid: '/a b.js' })).toBeNull();
    expect(parseDiagramEngineUrls({ ...URLS, graphviz: 7 })).toBeNull();
  });
});

describe('loadDiagramEngine', () => {
  test('imports once for concurrent and later callers, after installing the host', async () => {
    const imported: string[] = [];
    let hostAtImport: DiagramEngineHost | undefined;
    const importer = async (url: string) => {
      imported.push(url);
      hostAtImport = (globalThis as Record<string, unknown>)[DIAGRAM_ENGINE_HOST_KEY] as DiagramEngineHost;
      return ENGINE;
    };
    expect(peekDiagramEngine(URLS)).toBeNull();
    const [a, b] = await Promise.all([loadDiagramEngine(URLS, importer), loadDiagramEngine(URLS, importer)]);
    expect(a).toBe(ENGINE as never);
    expect(b).toBe(a);
    expect(await loadDiagramEngine(URLS, importer)).toBe(a);
    expect(imported).toEqual([URLS.engine]);
    expect(peekDiagramEngine(URLS)).toBe(a);

    // The engine gets the page's own instances (one React, one math slot)
    // and the runtimes' URLs, never its own copies.
    expect(Object.keys(hostAtImport!.modules).sort()).toEqual([...DIAGRAM_ENGINE_SHARED_MODULES].sort());
    expect((hostAtImport!.modules.react as typeof React).useState).toBe(React.useState);
    expect((hostAtImport!.modules['ui:utils/math'] as typeof MathSlot).getMathRenderer).toBe(MathSlot.getMathRenderer);
    // The engine's first read of each runtime URL is the plain URL.
    expect(hostAtImport!.runtimeUrls.mermaid).toBe(URLS.mermaid);
    expect(hostAtImport!.runtimeUrls.graphviz).toBe(URLS.graphviz);
  });

  test('a runtime URL read again (after a failed runtime import) carries a new retry query', async () => {
    let host: DiagramEngineHost | undefined;
    await loadDiagramEngine(URLS, async () => {
      host = (globalThis as Record<string, unknown>)[DIAGRAM_ENGINE_HOST_KEY] as DiagramEngineHost;
      return ENGINE;
    });
    expect(host!.runtimeUrls.mermaid).toBe(URLS.mermaid);
    expect(host!.runtimeUrls.mermaid).toBe(`${URLS.mermaid}?r=1`);
    expect(host!.runtimeUrls.mermaid).toBe(`${URLS.mermaid}?r=2`);
    // Each runtime counts its own reads.
    expect(host!.runtimeUrls.graphviz).toBe(URLS.graphviz);
    expect(host!.runtimeUrls.graphviz).toBe(`${URLS.graphviz}?r=1`);
  });

  test('a failed import is forgotten, and each retry imports a new URL', async () => {
    // Chromium keeps a failed import() per URL, so a retry of the same URL
    // would replay the failure without fetching.
    const imported: string[] = [];
    const flaky = async (url: string) => {
      imported.push(url);
      if (imported.length < 3) throw new Error('offline');
      return ENGINE;
    };
    await expect(loadDiagramEngine(URLS, flaky)).rejects.toThrow('offline');
    expect(peekDiagramEngine(URLS)).toBeNull();
    await expect(loadDiagramEngine(URLS, flaky)).rejects.toThrow('offline');
    expect(await loadDiagramEngine(URLS, flaky)).toBe(ENGINE as never);
    expect(imported).toEqual([URLS.engine, `${URLS.engine}?r=1`, `${URLS.engine}?r=2`]);
    // Loaded under its advertised URL, whatever query the import used.
    expect(peekDiagramEngine(URLS)).toBe(ENGINE as never);
    expect(await loadDiagramEngine(URLS, flaky)).toBe(ENGINE as never);
    expect(imported).toHaveLength(3);
  });

  test('an engine that does not match this page is refused', async () => {
    await expect(loadDiagramEngine(URLS, async () => ({ apiVersion: 2, DiagramFence: () => null }))).rejects.toThrow('does not match');
    await expect(loadDiagramEngine(URLS, async () => ({ apiVersion: 1 }))).rejects.toThrow('does not match');
    expect(peekDiagramEngine(URLS)).toBeNull();
  });

  test('another engine URL (a new server) imports again', async () => {
    const imported: string[] = [];
    const importer = async (url: string) => {
      imported.push(url);
      return ENGINE;
    };
    await loadDiagramEngine(URLS, importer);
    const next = { ...URLS, engine: '/assets/diagram-engine/engine-dddd.js' };
    await loadDiagramEngine(next, importer);
    expect(imported).toEqual([URLS.engine, next.engine]);
    expect(peekDiagramEngine(URLS)).toBeNull();
    expect(peekDiagramEngine(next)).toBe(ENGINE as never);
  });
});
