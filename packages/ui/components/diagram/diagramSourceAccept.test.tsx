/**
 * A host's source check (`DiagramSourceAcceptContext`), asked before any
 * engine work.
 *
 * What regresses if these fail:
 * - a fence the host refused still loads an engine (Pele, Mermaid or
 *   Graphviz), is parsed, or is drawn: the check stops being the place a host
 *   can keep a diagram's author from making the reader's browser fetch;
 * - a refusal looks different from an `accept` refusal (it must be the same
 *   `refused` result: the source as code, no error panel, no Expand);
 * - a check that throws lets the fence draw (it must refuse), or breaks the
 *   page;
 * - the check is asked again on every re-render (a theme change), or is handed
 *   a rewritten source instead of the fence as written;
 * - with no check, or one that accepts, anything changes.
 *
 * The engines are stand-ins behind their loader seams, so a load is counted
 * and the real libraries never load. The switch is as shipped
 * ('pele-where-safe'): Pele is asked first and gives up, Mermaid draws.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiagramKind } from '@plannotator/core/diagram-anchor';
import type { Block } from '../../types';
import { installInertDiagramSvgParser } from '../../test-setup/diagramSvg';
import { __setPeleInBuildForTests, type DiagramTheme } from '../../utils/diagram-render';
import { __setGraphvizRuntimeLoaderForTests } from '../../utils/graphviz';
import { __setMermaidRuntimeLoaderForTests } from '../../utils/mermaid';
import { __setPeleRuntimeLoaderForTests, type PeleRuntime } from '../../utils/pele';
import { GraphvizBlock } from '../GraphvizBlock';
import { MermaidBlock } from '../MermaidBlock';
import { DiagramSourceAcceptContext, type DiagramSourceAccept } from '../diagramSourceAccept';
import { DiagramSvgAcceptContext } from '../diagramSvgAccept';
import { useDiagramRender, type DiagramRenderState } from './useDiagramRender';

const hasDom = typeof document !== 'undefined';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" data-sentinel="diagram"><rect width="10" height="10"/></svg>';

const FLOW = 'flowchart LR\n  A --> B';
const mermaidBlock: Block = { id: 'm1', type: 'code', language: 'mermaid', content: FLOW, order: 0, startLine: 1 };
const dotBlock: Block = { id: 'g1', type: 'code', language: 'dot', content: 'digraph { A -> B }', order: 0, startLine: 1 };

/** What each engine was asked to do. */
const calls = { peleLoads: 0, peleSupports: [] as string[], mermaidLoads: 0, mermaidRenders: [] as string[], vizLoads: 0, vizRenders: 0 };

const peleGivesUp: PeleRuntime = {
  supports: async (source: string) => {
    calls.peleSupports.push(source);
    return false;
  },
  render: async () => Promise.reject(new Error('not drawn')),
};
const fakeMermaid = {
  initialize() {},
  render: async (_id: string, source: string) => {
    calls.mermaidRenders.push(source);
    return { svg: SVG };
  },
} as never;
const fakeViz = {
  render: () => {
    calls.vizRenders += 1;
    return { status: 'success', output: SVG, errors: [] };
  },
} as never;

function installCountingEngines(): void {
  __setPeleRuntimeLoaderForTests(() => {
    calls.peleLoads += 1;
    return Promise.resolve(peleGivesUp);
  });
  __setMermaidRuntimeLoaderForTests(() => {
    calls.mermaidLoads += 1;
    return Promise.resolve(fakeMermaid);
  });
  __setGraphvizRuntimeLoaderForTests(() => {
    calls.vizLoads += 1;
    return Promise.resolve(fakeViz);
  });
}

let restoreParser: (() => void) | null = null;
const svgProto = (hasDom ? SVGElement.prototype : {}) as unknown as Record<string, unknown>;
const savedSvg = { getBBox: svgProto['getBBox'], getScreenCTM: svgProto['getScreenCTM'] };
beforeAll(() => {
  if (!hasDom) return;
  restoreParser = installInertDiagramSvgParser();
  __setPeleInBuildForTests(true);
  svgProto['getBBox'] = () => ({ x: 0, y: 0, width: 40, height: 20 });
  svgProto['getScreenCTM'] = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
});
afterAll(() => {
  if (!hasDom) return;
  restoreParser?.();
  __setPeleInBuildForTests(undefined);
  __setPeleRuntimeLoaderForTests(undefined);
  __setMermaidRuntimeLoaderForTests(undefined);
  __setGraphvizRuntimeLoaderForTests(undefined);
  svgProto['getBBox'] = savedSvg.getBBox;
  svgProto['getScreenCTM'] = savedSvg.getScreenCTM;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  if (!hasDom) return;
  calls.peleLoads = 0;
  calls.peleSupports = [];
  calls.mermaidLoads = 0;
  calls.mermaidRenders = [];
  calls.vizLoads = 0;
  calls.vizRenders = 0;
  installCountingEngines();
});
afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = null;
  }
  host?.remove();
  host = null;
});

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () => r.render(element));
  await settle();
  return host;
}

async function rerender(element: React.ReactElement): Promise<void> {
  const r = root!;
  await act(async () => r.render(element));
  await settle();
}

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const withCheck = (check: DiagramSourceAccept | null, children: React.ReactNode) => (
  <DiagramSourceAcceptContext.Provider value={check}>{children}</DiagramSourceAcceptContext.Provider>
);

/** The block as a person sees it, with the per-render ids taken out. */
const visible = (el: HTMLElement) => el.innerHTML.replace(/diagram-[\w-]+?-\d+/g, 'ID').replace(/plannotator-pele-[\w-]+/g, 'ID');

const engineUntouched = () => ({ ...calls });
const NOTHING = { peleLoads: 0, peleSupports: [], mermaidLoads: 0, mermaidRenders: [], vizLoads: 0, vizRenders: 0 };

/** `useDiagramRender`'s state, as the viewer gets it. */
function Probe({ kind, source, theme, seen }: { kind: DiagramKind; source: string; theme: DiagramTheme; seen: DiagramRenderState[] }) {
  const state = useDiagramRender(kind, 'probe', source, theme);
  seen.push(state);
  return null;
}
const THEME: DiagramTheme = { colorTheme: 'plannotator', mode: 'dark' };

describe.if(hasDom)('a host source check (DiagramSourceAcceptContext)', () => {
  test('refused: the result is `refused` and no engine is loaded, asked to parse, or drawn', async () => {
    const seen: DiagramRenderState[] = [];
    await mount(withCheck(() => false, <Probe kind="mermaid" source={FLOW} theme={THEME} seen={seen} />));
    const last = seen.at(-1)!;
    expect(last.pending).toBe(false);
    expect(last.svgNode).toBeNull();
    expect(last.error).toEqual({ message: 'The diagram is shown as its source.', line: null, runtimeUnavailable: false, refused: true });
    expect(engineUntouched()).toEqual(NOTHING);
  });

  test('refused: a Mermaid fence and a dot fence show their source as code, with no engine work and nothing put in the page', async () => {
    const before = document.body.querySelectorAll('*').length;
    const el = await mount(
      withCheck(
        () => false,
        <>
          <MermaidBlock block={mermaidBlock} />
          <GraphvizBlock block={dotBlock} />
        </>,
      ),
    );
    expect(engineUntouched()).toEqual(NOTHING);
    expect(Array.from(el.querySelectorAll('pre code')).map((c) => c.textContent)).toEqual([mermaidBlock.content, dotBlock.content]);
    expect(el.querySelector('svg')).toBeNull();
    // No error panel, no pending line, no Expand (so no popout), as with an `accept` refusal.
    expect(el.querySelector('[data-diagram-pending]')).toBeNull();
    expect(el.querySelector('[data-diagram-expand]')).toBeNull();
    expect(el.textContent).not.toContain('error');
    // Nothing outside the block either (Mermaid's temporary render node, say).
    expect(document.body.querySelectorAll('*').length - before).toBe(el.querySelectorAll('*').length + 1);
  });

  test('refused looks exactly like a refused drawn svg (`DiagramSvgAcceptContext`)', async () => {
    const bySource = visible(await mount(withCheck(() => false, <MermaidBlock block={mermaidBlock} />)));
    await act(async () => root!.unmount());
    root = null;
    host?.remove();
    const bySvg = visible(await mount(<DiagramSvgAcceptContext.Provider value={() => false}><MermaidBlock block={mermaidBlock} /></DiagramSvgAcceptContext.Provider>));
    expect(bySource).toBe(bySvg);
  });

  test('a theme change re-renders a refused fence without asking again and without any engine', async () => {
    const asked: string[] = [];
    const check: DiagramSourceAccept = (_kind, source) => (asked.push(source), false);
    const seen: DiagramRenderState[] = [];
    await mount(withCheck(check, <Probe kind="mermaid" source={FLOW} theme={THEME} seen={seen} />));
    await rerender(withCheck(check, <Probe kind="mermaid" source={FLOW} theme={{ colorTheme: 'github', mode: 'light' }} seen={seen} />));
    await rerender(withCheck(check, <Probe kind="mermaid" source={FLOW} theme={{ colorTheme: 'github', mode: 'light', shadowAmount: 1 }} seen={seen} />));
    expect(asked).toEqual([FLOW]);
    expect(seen.at(-1)!.error?.refused).toBe(true);
    expect(engineUntouched()).toEqual(NOTHING);
    // A new source is asked about.
    await rerender(withCheck(check, <Probe kind="mermaid" source={`${FLOW}\n  B --> C`} theme={THEME} seen={seen} />));
    expect(asked).toEqual([FLOW, `${FLOW}\n  B --> C`]);
  });

  test('accepted: drawn exactly as with no check, and the check is handed the kind and the source', async () => {
    const plain = visible(await mount(<MermaidBlock block={mermaidBlock} />));
    const plainCalls = engineUntouched();
    expect(plainCalls.mermaidRenders).toEqual([FLOW]);
    expect(plain).toContain('data-sentinel="diagram"');
    await act(async () => root!.unmount());
    root = null;
    host?.remove();
    installCountingEngines();
    calls.peleLoads = 0;
    calls.peleSupports = [];
    calls.mermaidLoads = 0;
    calls.mermaidRenders = [];
    const asked: [DiagramKind, string][] = [];
    const checked = visible(await mount(withCheck((kind, source) => (asked.push([kind, source]), true), <MermaidBlock block={mermaidBlock} />)));
    expect(checked).toBe(plain);
    expect(engineUntouched()).toEqual(plainCalls);
    expect(asked).toEqual([['mermaid', FLOW]]);
  });

  test('no check: the engine loads and draws, as before', async () => {
    const seenNone: DiagramRenderState[] = [];
    await mount(<Probe kind="graphviz" source={dotBlock.content} theme={THEME} seen={seenNone} />);
    expect(seenNone.at(-1)!.error).toBeNull();
    expect(seenNone.at(-1)!.svgNode?.getAttribute('data-sentinel')).toBe('diagram');
    expect(calls.vizLoads).toBe(1);
    expect(calls.vizRenders).toBe(1);
  });

  test('a check that throws refuses, and the page goes on (the next fence still draws when the check accepts it)', async () => {
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...args: unknown[]) => void warned.push(args);
    try {
      const check: DiagramSourceAccept = (kind) => {
        if (kind === 'mermaid') throw new Error('host check broke');
        return true;
      };
      const el = await mount(
        withCheck(
          check,
          <>
            <MermaidBlock block={mermaidBlock} />
            <GraphvizBlock block={dotBlock} />
          </>,
        ),
      );
      expect(calls.peleLoads).toBe(0);
      expect(calls.mermaidLoads).toBe(0);
      expect(calls.mermaidRenders).toEqual([]);
      expect(el.querySelector('[data-diagram-block="mermaid"] pre code')?.textContent).toBe(mermaidBlock.content);
      expect(el.querySelector('[data-diagram-block="mermaid"] svg')).toBeNull();
      expect(el.querySelector('[data-diagram-block="graphviz"] svg[data-sentinel="diagram"]')).not.toBeNull();
      expect(warned.length).toBe(1);
    } finally {
      console.warn = warn;
    }
  });

  test('only `true` accepts: a check answering something else refuses', async () => {
    const seen: DiagramRenderState[] = [];
    const sloppy = (() => 'yes') as unknown as DiagramSourceAccept;
    await mount(withCheck(sloppy, <Probe kind="mermaid" source={FLOW} theme={THEME} seen={seen} />));
    expect(seen.at(-1)!.error?.refused).toBe(true);
    expect(engineUntouched()).toEqual(NOTHING);
  });

  test('one fence refused and one accepted: the engines load for the accepted one only, and never see the refused source', async () => {
    const refusedSource = 'flowchart LR\n  X --> Y';
    const el = await mount(
      withCheck(
        (_kind, source) => source !== refusedSource,
        <>
          <MermaidBlock block={{ ...mermaidBlock, id: 'refused', content: refusedSource }} />
          <MermaidBlock block={mermaidBlock} />
        </>,
      ),
    );
    expect(calls.peleLoads).toBe(1);
    expect(calls.peleSupports).toEqual([FLOW]);
    expect(calls.mermaidLoads).toBe(1);
    expect(calls.mermaidRenders).toEqual([FLOW]);
    expect(el.querySelector('[data-block-id="refused"] svg')).toBeNull();
    expect(el.querySelector('[data-block-id="m1"] svg[data-sentinel="diagram"]')).not.toBeNull();
  });

  test('a sankey with a header row: the check gets the fence as written, header included', async () => {
    const sankey = 'sankey-beta\nSource,Target,Value\nA,B,10\nB,C,5';
    const asked: string[] = [];
    await mount(withCheck((_kind, source) => (asked.push(source), false), <MermaidBlock block={{ ...mermaidBlock, content: sankey }} />));
    expect(asked).toEqual([sankey]);
    expect(engineUntouched()).toEqual(NOTHING);
  });
});
