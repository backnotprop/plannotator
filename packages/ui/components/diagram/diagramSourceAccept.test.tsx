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
 * - with no check, or one that accepts, anything changes;
 * - a fence already drawn, then refused (its source edited in place, or a
 *   stricter check swapped in), keeps its old drawing, its Expand or an open
 *   pop-out, instead of showing exactly what a fresh refusal shows; or a
 *   parse error stops keeping the last good render;
 * - a caller can change the shared refused result for everyone;
 * - an answer outlives the mounted diagram it was given for (an accept from
 *   one mount reused on a remount after the host's answer changed), or the
 *   host is asked again on a re-render or when the pop-out opens.
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
import { __setPeleInBuildForTests, DIAGRAM_REFUSED_RESULT, renderDiagram, type DiagramTheme } from '../../utils/diagram-render';
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
/** Renders held until released (`holdRenders`), and a source naming BROKEN does not parse. */
const held: Array<() => void> = [];
let holdRenders = false;
const fakeMermaid = {
  initialize() {},
  render: async (_id: string, source: string) => {
    calls.mermaidRenders.push(source);
    if (holdRenders) await new Promise<void>((resolve) => held.push(resolve));
    if (source.includes('BROKEN')) throw new Error('Parse error on line 2');
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
  holdRenders = false;
  installCountingEngines();
});
afterEach(async () => {
  for (const release of held.splice(0)) release();
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
    expect(has(el, 'svg')).toBe(false);
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

const acceptAll: DiagramSourceAccept = () => true;
const refuseAll: DiagramSourceAccept = () => false;
const REFUSED_SOURCE = 'flowchart LR\n  X --> Y';
/** Refuses REFUSED_SOURCE only. */
const refuseX: DiagramSourceAccept = (_kind, source) => source !== REFUSED_SOURCE;
const PARSE_ERROR_WORDS = ['does not parse', 'last good render'];
const has = (root: ParentNode, selector: string) => root.querySelector(selector) !== null;

async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await settle(10);
    }
  }
}

/** What a block a check refused from the start shows, for comparison. */
async function freshRefusal(block: Block): Promise<string> {
  const probeHost = document.createElement('div');
  document.body.appendChild(probeHost);
  const probeRoot = createRoot(probeHost);
  await act(async () => probeRoot.render(withCheck(refuseAll, <MermaidBlock block={block} />)));
  await settle();
  const html = visible(probeHost);
  await act(async () => probeRoot.unmount());
  probeHost.remove();
  return html;
}

function expectRefusedLikeFresh(el: HTMLElement, source: string): void {
  // Booleans, not nodes: a failing match on a node prints the whole svg.
  expect(has(el, 'svg')).toBe(false);
  expect(has(el, '[data-diagram-expand]')).toBe(false);
  expect(has(el, '[data-diagram-parse-error]')).toBe(false);
  expect(Array.from(el.querySelectorAll('pre code')).map((c) => c.textContent)).toEqual([source]);
  for (const words of PARSE_ERROR_WORDS) expect(el.textContent).not.toContain(words);
}

describe.if(hasDom)('a fence already drawn, then refused by its source', () => {
  test('its source edited in place to a refused one: exactly a fresh refusal, the old drawing gone', async () => {
    const el = await mount(withCheck(refuseX, <MermaidBlock block={mermaidBlock} />));
    expect(el.querySelector('svg[data-sentinel="diagram"]')).not.toBeNull();
    expect(el.querySelector('[data-diagram-expand]')).not.toBeNull();
    const refusedBlock = { ...mermaidBlock, content: REFUSED_SOURCE };
    await rerender(withCheck(refuseX, <MermaidBlock block={refusedBlock} />));
    expectRefusedLikeFresh(el, REFUSED_SOURCE);
    expect(visible(el)).toBe(await freshRefusal(refusedBlock));
    expect(calls.mermaidRenders).toEqual([FLOW]);
  });

  test('a stricter check swapped in: exactly a fresh refusal, the old drawing gone', async () => {
    const el = await mount(withCheck(acceptAll, <MermaidBlock block={mermaidBlock} />));
    expect(el.querySelector('svg[data-sentinel="diagram"]')).not.toBeNull();
    await rerender(withCheck(refuseAll, <MermaidBlock block={mermaidBlock} />));
    expectRefusedLikeFresh(el, FLOW);
    expect(visible(el)).toBe(await freshRefusal(mermaidBlock));
  });

  test('after "Show source", a refusal still shows only what a fresh refusal shows', async () => {
    const el = await mount(withCheck(acceptAll, <MermaidBlock block={mermaidBlock} />));
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Show source"]')!.click());
    await rerender(withCheck(refuseAll, <MermaidBlock block={mermaidBlock} />));
    expectRefusedLikeFresh(el, FLOW);
    expect(visible(el)).toBe(await freshRefusal(mermaidBlock));
  });

  test('refused, then accepted again: drawn afresh, never the drawing from before the refusal', async () => {
    const el = await mount(withCheck(acceptAll, <MermaidBlock block={mermaidBlock} />));
    expect(el.querySelector('svg[data-sentinel="diagram"]')).not.toBeNull();
    await rerender(withCheck(refuseAll, <MermaidBlock block={mermaidBlock} />));
    expect(has(el, 'svg')).toBe(false);
    holdRenders = true;
    const accepting: DiagramSourceAccept = () => true;
    await rerender(withCheck(accepting, <MermaidBlock block={mermaidBlock} />));
    // While the new render is in flight: the pending source, not the old drawing.
    expect(has(el, 'svg')).toBe(false);
    expect(el.querySelector('[data-diagram-pending]')).not.toBeNull();
    for (const release of held.splice(0)) release();
    await waitFor(() => expect(el.querySelector('svg[data-sentinel="diagram"]')).not.toBeNull());
    expect(el.querySelector('[data-diagram-expand]')).not.toBeNull();
    for (const words of PARSE_ERROR_WORDS) expect(el.textContent).not.toContain(words);
  });

  test('a parse error after a good render still keeps the last good render (unchanged)', async () => {
    const el = await mount(withCheck(acceptAll, <MermaidBlock block={mermaidBlock} />));
    expect(el.querySelector('svg[data-sentinel="diagram"]')).not.toBeNull();
    await rerender(withCheck(acceptAll, <MermaidBlock block={{ ...mermaidBlock, content: `${FLOW}\n  BROKEN` }} />));
    expect(el.querySelector('svg[data-sentinel="diagram"]')).not.toBeNull();
    expect(el.querySelector('[data-diagram-parse-error]')?.textContent).toContain('last good render');
  });

  test('an open pop-out closes when its fence is refused, and stays closed when accepted again', async () => {
    const el = await mount(withCheck(acceptAll, <MermaidBlock block={mermaidBlock} />));
    await act(async () => el.querySelector<HTMLButtonElement>('[data-diagram-expand]')!.click());
    await waitFor(() => expect(document.querySelector('[data-diagram-popout] svg[data-sentinel="diagram"]')).not.toBeNull());
    await rerender(withCheck(refuseAll, <MermaidBlock block={mermaidBlock} />));
    expect(has(document, '[data-diagram-popout]')).toBe(false);
    expect(has(document, 'svg[data-sentinel="diagram"]')).toBe(false);
    expectRefusedLikeFresh(el, FLOW);
    await rerender(withCheck(() => true, <MermaidBlock block={mermaidBlock} />));
    await waitFor(() => expect(el.querySelector('svg[data-sentinel="diagram"]')).not.toBeNull());
    expect(has(document, '[data-diagram-popout]')).toBe(false);
  });

  test('a stricter check on the hook alone: the state is a fresh refusal at once, with no drawing kept', async () => {
    const seen: DiagramRenderState[] = [];
    await mount(withCheck(acceptAll, <Probe kind="mermaid" source={FLOW} theme={THEME} seen={seen} />));
    expect(seen.at(-1)!.svgNode).not.toBeNull();
    const before = seen.length;
    await rerender(withCheck(refuseAll, <Probe kind="mermaid" source={FLOW} theme={THEME} seen={seen} />));
    // Every state from the swap on, the first included, holds no drawing.
    for (const state of seen.slice(before)) {
      expect(state.svgNode === null).toBe(true);
      expect(state.error?.refused).toBe(true);
      expect(state.pending).toBe(false);
    }
  });
});

describe.if(hasDom)('the shared refused result', () => {
  test('no caller can change it: a later refusal, by source or by svg, is still the same refusal', async () => {
    expect(() => {
      (DIAGRAM_REFUSED_RESULT as { message: string }).message = 'changed';
    }).toThrow();
    expect(() => {
      (DIAGRAM_REFUSED_RESULT as { refused?: boolean }).refused = false;
    }).toThrow();
    const bySvg = await renderDiagram('mermaid', 'frozen-accept', FLOW, THEME, { accept: () => false });
    expect(bySvg).toEqual({ ok: false, message: 'The diagram is shown as its source.', line: null, runtimeUnavailable: false, refused: true });
    const seen: DiagramRenderState[] = [];
    await mount(withCheck(refuseAll, <Probe kind="mermaid" source={FLOW} theme={THEME} seen={seen} />));
    expect(seen.at(-1)!.error).toEqual({ message: 'The diagram is shown as its source.', line: null, runtimeUnavailable: false, refused: true });
  });
});

describe.if(hasDom)('how long an answer lasts, and how often the host is asked', () => {
  test('an accept does not outlive the mount: the same function, now refusing, refuses on a remount and no engine loads', async () => {
    let allow = true;
    const stable: DiagramSourceAccept = () => allow;
    const first = await mount(withCheck(stable, <MermaidBlock block={mermaidBlock} />));
    expect(has(first, 'svg[data-sentinel="diagram"]')).toBe(true);
    await act(async () => root!.unmount());
    root = null;
    host?.remove();
    allow = false;
    Object.assign(calls, { peleLoads: 0, peleSupports: [], mermaidLoads: 0, mermaidRenders: [], vizLoads: 0, vizRenders: 0 });
    const second = await mount(withCheck(stable, <MermaidBlock block={mermaidBlock} />));
    expectRefusedLikeFresh(second, FLOW);
    expect(engineUntouched()).toEqual(NOTHING);
  });

  test('one fence: asked once at mount, not again on a re-render or when the pop-out opens, once more on a remount', async () => {
    const asked: string[] = [];
    const check: DiagramSourceAccept = (_kind, source) => (asked.push(source), true);
    const el = await mount(withCheck(check, <MermaidBlock block={mermaidBlock} />));
    expect(asked).toEqual([FLOW]);
    await rerender(withCheck(check, <MermaidBlock block={{ ...mermaidBlock }} />));
    expect(asked).toEqual([FLOW]);
    await act(async () => el.querySelector<HTMLButtonElement>('[data-diagram-expand]')!.click());
    await waitFor(() => expect(has(document, '[data-diagram-popout] svg[data-sentinel="diagram"]')).toBe(true));
    expect(asked).toEqual([FLOW]);
    await act(async () => root!.unmount());
    root = null;
    host?.remove();
    await mount(withCheck(check, <MermaidBlock block={mermaidBlock} />));
    expect(asked).toEqual([FLOW, FLOW]);
  });
});
