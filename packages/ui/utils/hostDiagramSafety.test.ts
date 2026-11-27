// What a host gets from a diagram whose source names a picture, an icon, a
// link, a stylesheet or a font on another site, under the engine switch as it
// ships ('pele-where-safe'): drawn by Pele, and the same source drawn down the
// Mermaid fallback. Asserted on the svg that reaches the page and on what a
// host's `accept` check (`DiagramSvgAcceptContext`) is handed.
//
// What regresses if these fail:
// - with `diagramRemoteLoads: false`, a reference to another site reaches the
//   page from either engine;
// - Pele starts drawing a picture, an icon or a link the source asks for (its
//   `images: false` / `links: false`, or our label step, stops holding);
// - a future engine change moves a fence between Pele and Mermaid, or changes
//   what a host's `accept` sees, without a test saying so: under Pele the
//   check is handed an svg the outside reference was already removed from, so
//   a check that refuses such references lets the diagram draw; under Mermaid
//   it is handed the reference and refuses.
//
// Mermaid here is a stand-in that answers with the markup real Mermaid writes
// for each case; happy-dom cannot run Mermaid or DOMPurify. What real Mermaid
// fetches while it draws, before any sanitizer, and the DOMPurify parse are
// proven in a browser by tests/e2e/diagram-remote-loads.spec.ts.
//
// DOM-gated (DOM_TESTS=1).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { loadRealPele, setPeleInBuildForTests } from '../test-setup/pele';
import { DIAGRAM_ENGINE_MODE, diagramEngineMode } from './diagram-engine';
import { renderDiagram, type DiagramRenderResult } from './diagram-render';
import { resetDiagramRemoteLoads, setDiagramRemoteLoads } from './diagramRemoteLoadsPolicy';
import { __setMermaidRuntimeLoaderForTests, setMermaidRuntime } from './mermaid';
import { __setPeleRuntimeLoaderForTests, type PeleRuntime } from './pele';

const hasDom = typeof document !== 'undefined';
const FAR = 'https://far.test';
const XHTML = 'http://www.w3.org/1999/xhtml';

interface HostileCase {
  readonly source: string;
  /** Which engine draws it as shipped. */
  readonly drawnBy: 'pele' | 'mermaid';
  /** What real Mermaid writes for it (abbreviated), with `ID` for the svg's id. */
  readonly mermaid: string;
}

const label = (inner: string) => `<foreignObject width="80" height="24"><div xmlns="${XHTML}"><span class="nodeLabel">${inner}</span></div></foreignObject>`;

const CASES: Record<string, HostileCase> = {
  'flowchart picture node': {
    source: `flowchart LR\n  A@{ img: "${FAR}/shape.png", label: "pic", w: 40, h: 40 } --> B`,
    drawnBy: 'pele',
    mermaid: `<g class="node" id="ID-flowchart-A-0"><image href="${FAR}/shape.png" width="40" height="40"/></g>`,
  },
  'picture beside words in a label': {
    source: `flowchart LR\n  A["<img src='${FAR}/img.png' width=20 height=20> pic"] --> B`,
    drawnBy: 'pele',
    mermaid: `<g class="node" id="ID-flowchart-A-0">${label(`<img src="${FAR}/img.png" width="20" height="20"/> pic`)}</g>`,
  },
  'a label that is only a picture': {
    source: `flowchart LR\n  A["<img src='${FAR}/only.png' width=20 height=20>"] --> B`,
    drawnBy: 'mermaid',
    mermaid: `<g class="node" id="ID-flowchart-A-0">${label(`<img src="${FAR}/only.png" width="20" height="20"/>`)}</g>`,
  },
  'sequence actor icon from a URL': {
    source: `sequenceDiagram\n  participant A\n  properties A: {"icon": "${FAR}/icon.png"}\n  A->>B: hi`,
    drawnBy: 'pele',
    mermaid: `<g class="actor"><image href="${FAR}/icon.png" width="24" height="24"/><text class="actor">A</text></g>`,
  },
  'flowchart classDef with url()': {
    source: `flowchart TD\n  A --> B\n  classDef bad fill:url(${FAR}/cd.svg),background-image:url(${FAR}/cd.png)\n  class A bad`,
    drawnBy: 'mermaid',
    mermaid: `<style>#ID .bad&gt;*{fill:url(${FAR}/cd.svg)!important;background-image:url(${FAR}/cd.png)!important}</style><g class="node bad" id="ID-flowchart-A-0"><rect style="fill:url(${FAR}/cd.svg) !important;background-image:url(${FAR}/cd.png) !important"/></g>`,
  },
  'state style with url()': {
    source: `stateDiagram-v2\n  [*] --> s1\n  style s1 background-image:url(//far.test/ssb.png)`,
    drawnBy: 'pele',
    mermaid: `<g class="node statediagram-state" id="ID-state-s1-0"><rect style="background-image:url(//far.test/ssb.png) !important"/></g>`,
  },
  'click link with an href': {
    source: `flowchart LR\n  A --> B\n  click A "${FAR}/go" _blank\n  click B href "${FAR}/go2"`,
    drawnBy: 'pele',
    mermaid: `<a xlink:href="${FAR}/go" target="_blank"><g class="node" id="ID-flowchart-A-0"><rect/></g></a><a href="${FAR}/go2"><g class="node" id="ID-flowchart-B-1"><rect/></g></a>`,
  },
  'svg image and use pointing at another site': {
    source: `flowchart LR\n  A["<svg width=20 height=20><image href='${FAR}/svgimg.png' width=20 height=20></image><use href='${FAR}/sprite.svg#x'></use></svg> x"] --> B`,
    drawnBy: 'pele',
    mermaid: `<g class="node" id="ID-flowchart-A-0">${label(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image href="${FAR}/svgimg.png" width="20" height="20"/><use href="${FAR}/sprite.svg#x"/></svg> x`)}</g>`,
  },
  'stylesheet and font in a style block': {
    source: `%%{init: {"themeCSS": "@import url(${FAR}/s.css); @font-face { font-family: x; src: url(${FAR}/f.woff2) } .node { background: url(${FAR}/tc.png) }"}}%%\nflowchart LR\n  A --> B`,
    drawnBy: 'pele',
    mermaid: `<style>@import url(${FAR}/s.css); @font-face { font-family: x; src: url(${FAR}/f.woff2) } #ID .node { background: url(${FAR}/tc.png) } #ID .node rect { fill: #eee }</style><g class="node" id="ID-flowchart-A-0"><rect/></g>`,
  },
};

/** Every place in the drawn tree that names another site: an attribute, a `<style>`'s text, a loading element's reference. Words in a label are not references. */
function outsideReferences(root: Element): string[] {
  const out: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attribute of Array.from(el.attributes)) {
      if (attribute.value.includes('far.test')) out.push(`${el.localName}@${attribute.name}`);
    }
    if (el.localName === 'style' && (el.textContent ?? '').includes('far.test')) out.push('style');
  }
  for (const el of Array.from(root.querySelectorAll('img, image, use, feImage, video, audio, source, track, iframe, object, embed, link, script'))) {
    for (const name of ['src', 'href', 'xlink:href', 'srcset', 'poster']) {
      const value = (el.getAttribute(name) ?? '').trim();
      if (value !== '' && !value.startsWith('#') && !value.startsWith('data:image/')) out.push(`${el.localName}@${name}`);
    }
  }
  return [...new Set(out)].sort();
}

const asked: string[] = [];
const mermaidStandIn = {
  initialize: () => {},
  render: async (renderId: string, source: string) => {
    asked.push(source);
    const hit = Object.values(CASES).find((c) => c.source === source);
    const body = hit === undefined ? '<g class="node"><rect/></g>' : hit.mermaid.replaceAll('ID', renderId);
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="${renderId}" class="flowchart" viewBox="0 0 100 50">${body}</svg>` };
  },
} as unknown as Parameters<typeof setMermaidRuntime>[0];

/** Pele's loader as a build with it has it, or one that draws nothing, so every fence goes down the Mermaid fallback. */
const peleGivesUp: PeleRuntime = { supports: async () => false, render: async () => Promise.reject(new Error('not drawn')) };
type Path = 'pele' | 'mermaid fallback';
function usePath(path: Path): void {
  __setPeleRuntimeLoaderForTests(path === 'pele' ? loadRealPele : async () => peleGivesUp);
}

const theme = { colorTheme: 'github', mode: 'light' } as const;
let seq = 0;
const engineOf = (result: DiagramRenderResult): string => {
  if (result.ok === false) return `failed: ${result.message}`;
  return result.svgNode.classList.contains('pele') ? 'pele' : 'mermaid';
};

let restoreParser: (() => void) | undefined;
beforeAll(() => {
  if (!hasDom) return;
  restoreParser = installInertDiagramSvgParser();
  setPeleInBuildForTests(true);
  setMermaidRuntime(mermaidStandIn, 'host');
});
afterEach(() => {
  resetDiagramRemoteLoads();
  if (hasDom) setPeleInBuildForTests(true);
});
afterAll(() => {
  if (!hasDom) return;
  restoreParser?.();
  setPeleInBuildForTests(false);
  __setMermaidRuntimeLoaderForTests(undefined);
});

describe.if(hasDom)('host diagram safety, as shipped', () => {
  test('the switch ships as Pele where safe, and these tests run under it', () => {
    expect(DIAGRAM_ENGINE_MODE).toBe('pele-where-safe');
    expect(diagramEngineMode()).toBe('pele-where-safe');
  });

  test('which engine draws each hostile source', async () => {
    usePath('pele');
    const drawn: Record<string, string> = {};
    for (const [name, c] of Object.entries(CASES)) drawn[name] = engineOf(await renderDiagram('mermaid', `who-${++seq}`, c.source, theme));
    expect(drawn).toEqual(Object.fromEntries(Object.entries(CASES).map(([name, c]) => [name, c.drawnBy])));
  });

  test('remote loads off: nothing that reaches the page names another site, on either path', async () => {
    setDiagramRemoteLoads(false);
    for (const path of ['pele', 'mermaid fallback'] as const) {
      usePath(path);
      for (const [name, c] of Object.entries(CASES)) {
        const result = await renderDiagram('mermaid', `off-${++seq}`, c.source, theme);
        if (result.ok === false) throw new Error(`${path} / ${name}: ${result.message}`);
        expect([path, name, outsideReferences(result.svgNode)]).toEqual([path, name, []]);
      }
    }
  });

  test('remote loads on (the default): Pele draws none of them; down the fallback the http(s) references stay, as before Pele', async () => {
    const seen: Record<Path, Record<string, string[]>> = { pele: {}, 'mermaid fallback': {} };
    for (const path of ['pele', 'mermaid fallback'] as const) {
      usePath(path);
      for (const [name, c] of Object.entries(CASES)) {
        const result = await renderDiagram('mermaid', `on-${++seq}`, c.source, theme);
        if (result.ok === false) throw new Error(`${path} / ${name}: ${result.message}`);
        // As shipped, a fence Pele cannot draw goes down the fallback even on the Pele path.
        seen[path][name] = outsideReferences(result.svgNode);
      }
    }
    const fallback = {
      'flowchart picture node': ['image@href'],
      'picture beside words in a label': ['img@src'],
      'a label that is only a picture': ['img@src'],
      'sequence actor icon from a URL': ['image@href'],
      'flowchart classDef with url()': ['rect@style'],
      'state style with url()': ['rect@style'],
      // An `<a>` never keeps its link, whatever the setting.
      'click link with an href': [],
      'svg image and use pointing at another site': ['image@href', 'use@href'],
      // A `<style>` keeps no rule that fetches, whatever the setting.
      'stylesheet and font in a style block': [],
    };
    expect(seen['mermaid fallback']).toEqual(fallback);
    expect(seen.pele).toEqual(
      Object.fromEntries(Object.entries(CASES).map(([name, c]) => [name, c.drawnBy === 'pele' ? [] : fallback[name as keyof typeof fallback]])),
    );
  });
});

describe.if(hasDom)("a host's accept check (DiagramSvgAcceptContext), as shipped", () => {
  /** A host check that refuses any svg naming another site, recording what it was handed. */
  function refusingCheck() {
    const handed: { args: number; references: string[] }[] = [];
    const accept = (...args: unknown[]): boolean => {
      const svg = args[0] as SVGSVGElement;
      const references = outsideReferences(svg);
      handed.push({ args: args.length, references });
      return references.length === 0;
    };
    return { accept: accept as (svg: SVGSVGElement) => boolean, handed };
  }

  test('it is handed the drawn svg alone, never the source; under Pele the outside reference is already gone, so the fence draws', async () => {
    usePath('pele');
    for (const [name, c] of Object.entries(CASES)) {
      if (c.drawnBy !== 'pele') continue;
      const { accept, handed } = refusingCheck();
      asked.length = 0;
      const result = await renderDiagram('mermaid', `accept-pele-${++seq}`, c.source, theme, { accept });
      expect([name, handed]).toEqual([name, [{ args: 1, references: [] }]]);
      expect([name, engineOf(result)]).toEqual([name, 'pele']);
      expect(asked).toEqual([]);
    }
  });

  test('down the Mermaid fallback it is handed the outside reference, and refuses: the block shows the source', async () => {
    for (const path of ['pele', 'mermaid fallback'] as const) {
      usePath(path);
      for (const [name, c] of Object.entries(CASES)) {
        if (path === 'pele' && c.drawnBy === 'pele') continue;
        const { accept, handed } = refusingCheck();
        const result = await renderDiagram('mermaid', `accept-mermaid-${++seq}`, c.source, theme, { accept });
        expect(handed).toHaveLength(1);
        expect(handed[0]!.args).toBe(1);
        // The check runs before the post-pass, so it sees what Mermaid wrote, even what the post-pass would drop.
        if (handed[0]!.references.length > 0) expect([path, name, result.ok === false && result.refused === true]).toEqual([path, name, true]);
        else expect([path, name, result.ok]).toEqual([path, name, true]);
      }
    }
  });

  test('every case that reaches Mermaid hands the check a reference to refuse; none that reaches Pele does', async () => {
    const refusedBy: Record<Path, string[]> = { pele: [], 'mermaid fallback': [] };
    for (const path of ['pele', 'mermaid fallback'] as const) {
      usePath(path);
      for (const [name, c] of Object.entries(CASES)) {
        const { accept } = refusingCheck();
        const result = await renderDiagram('mermaid', `refused-${++seq}`, c.source, theme, { accept });
        if (result.ok === false && result.refused === true) refusedBy[path].push(name);
      }
    }
    expect(refusedBy['mermaid fallback']).toEqual(Object.keys(CASES));
    expect(refusedBy.pele).toEqual(Object.entries(CASES).filter(([, c]) => c.drawnBy === 'mermaid').map(([name]) => name));
  });

  test('a refusal of a fence Pele drew is final: it does not fall back to Mermaid', async () => {
    usePath('pele');
    asked.length = 0;
    const result = await renderDiagram('mermaid', `final-${++seq}`, 'flowchart LR\n  A --> B', theme, { accept: () => false });
    expect(result.ok === false && result.refused === true).toBe(true);
    expect(asked).toEqual([]);
  });
});
