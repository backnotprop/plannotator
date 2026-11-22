/**
 * `configurePlannotatorUI({ diagramRemoteLoads: false })`: a diagram loads
 * nothing from another host. Mermaid's label pass (`mermaidConfigForRemoteLoads`),
 * the directive keys it refuses, and the post-pass (`scrubDiagramSvg`,
 * `scopeDiagramCss`). The label pass's attribute hook (happy-dom does not run
 * DOMPurify hooks faithfully), that no request leaves the page, and what
 * still loads before any sanitizer are proven in a browser by
 * tests/e2e/diagram-remote-loads.spec.ts.
 *
 * What regresses if these fail:
 * - the default (every Plannotator app) is no longer exactly as before;
 * - a late `configurePlannotatorUI` call does not reach the next render;
 * - Mermaid's label pass keeps media or a picture from another host while it
 *   measures, or a directive can set CSS again (`themeCSS`, the font family);
 * - a reference to another host, or a declaration that loads (`url(`,
 *   `-webkit-image-set("…")`, an escaped `url`), survives the post-pass;
 * - a `data:` picture, a `#fragment` or a colour stops drawing.
 *
 * The DOM-gated block runs with DOM_TESTS=1.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configurePlannotatorUI } from '../configure';
import { parseInertSvg } from '../test-setup/diagramSvg';
import { cssLoads, isLocalReference, scopeDiagramCss, scrubDiagramSvg } from './diagram-render';
import { getDiagramRemoteLoads, resetDiagramRemoteLoads, setDiagramRemoteLoads } from './diagramRemoteLoadsPolicy';
import { MERMAID_CONFIG, MERMAID_NO_REMOTE_LABEL_MARK, mermaidConfigForRemoteLoads } from './mermaid';
import { __resetMermaidThemeForTests, applyMermaidTheme, mermaidThemeKey } from './mermaidTheme';

const hasDom = typeof document !== 'undefined';
const FIXTURES = join(import.meta.dir, '..', 'test-setup', 'fixtures', 'diagrams');
const SVG = 'http://www.w3.org/2000/svg';
const XHTML = 'http://www.w3.org/1999/xhtml';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

afterEach(() => {
  resetDiagramRemoteLoads();
  __resetMermaidThemeForTests();
});

type LabelPass = { FORBID_TAGS?: string[]; FORBID_ATTR?: string[] } & Record<string, unknown>;

describe('the option', () => {
  test('is on unless a host turns it off, and a call at any time reaches the next read', () => {
    expect(getDiagramRemoteLoads()).toBe(true);
    configurePlannotatorUI({});
    expect(getDiagramRemoteLoads()).toBe(true);
    configurePlannotatorUI({ diagramRemoteLoads: false });
    expect(getDiagramRemoteLoads()).toBe(false);
    configurePlannotatorUI({});
    expect(getDiagramRemoteLoads()).toBe(false);
    configurePlannotatorUI({ diagramRemoteLoads: true });
    expect(getDiagramRemoteLoads()).toBe(true);
  });

  test('on, the Mermaid config is the very same object; off, the label pass and the refused keys grow and nothing else changes', () => {
    expect(mermaidConfigForRemoteLoads(MERMAID_CONFIG, true)).toBe(MERMAID_CONFIG);
    const off = mermaidConfigForRemoteLoads(MERMAID_CONFIG, false);
    const base = MERMAID_CONFIG.dompurifyConfig as LabelPass;
    const pass = off.dompurifyConfig as LabelPass;
    for (const tag of ['picture', 'source', 'track', 'audio', 'video', ...(base.FORBID_TAGS ?? [])]) expect([tag, pass.FORBID_TAGS?.includes(tag)]).toEqual([tag, true]);
    for (const attr of ['srcset', 'poster', 'background', ...(base.FORBID_ATTR ?? [])]) expect([attr, pass.FORBID_ATTR?.includes(attr)]).toEqual([attr, true]);
    // A data: picture in a label still draws: img and svg image stay, the hook narrows src / href.
    for (const tag of ['img', 'image']) expect([tag, pass.FORBID_TAGS?.includes(tag)]).toEqual([tag, false]);
    expect(pass[MERMAID_NO_REMOTE_LABEL_MARK]).toBe(true);
    for (const key of ['themeCSS', 'fontFamily', 'altFontFamily', ...(MERMAID_CONFIG.secure ?? [])]) expect([key, off.secure?.includes(key)]).toEqual([key, true]);
    const { dompurifyConfig: _a, secure: _b, ...rest } = off;
    const { dompurifyConfig: _c, secure: _d, ...baseRest } = MERMAID_CONFIG;
    expect(rest).toEqual(baseRest);
    // Without the hook (two copies of DOMPurify), a label loses every picture, reference and style.
    const fallback = mermaidConfigForRemoteLoads(MERMAID_CONFIG, false, false).dompurifyConfig as LabelPass;
    for (const tag of ['img', 'image', 'svg']) expect(fallback.FORBID_TAGS).toContain(tag);
    for (const attr of ['src', 'href', 'xlink:href', 'style']) expect(fallback.FORBID_ATTR).toContain(attr);
  });

  test('is read at each render: the runtime is re-initialized when it changes, and never by default', () => {
    const calls: unknown[] = [];
    const runtime = { initialize: (config: unknown) => { calls.push(config); } };
    const key = mermaidThemeKey('plannotator', 'light');
    // No theme tokens in this process: the static config path.
    expect(applyMermaidTheme(runtime, key)).toBe('static');
    expect(calls).toEqual([]);
    setDiagramRemoteLoads(false);
    expect(applyMermaidTheme(runtime, key)).toBe('static');
    expect(calls).toHaveLength(1);
    expect((calls[0] as typeof MERMAID_CONFIG).secure).toContain('themeCSS');
    expect(applyMermaidTheme(runtime, key)).toBe('unchanged');
    setDiagramRemoteLoads(true);
    expect(applyMermaidTheme(runtime, key)).toBe('static');
    expect(calls[1]).toBe(MERMAID_CONFIG);
    // A fresh runtime with the option off is initialized before its first render.
    const fresh: unknown[] = [];
    setDiagramRemoteLoads(false);
    applyMermaidTheme({ initialize: (config: unknown) => { fresh.push(config); } }, key);
    expect(fresh).toHaveLength(1);
  });
});

describe('cssLoads', () => {
  test('finds every spelling of a load', () => {
    const loads = [
      'background: url(https://example.org/a.png)',
      'background: URL( "//example.org/a.png" )',
      'background: u\\72l(https://example.org/a.png)',
      'background: \\75 rl(https://example.org/a.png)',
      'background: url(\\1 https://example.org/a.png)',
      'background-image: -webkit-image-set("https://example.org/a.png" 1x)',
      'background-image: image-set("https://example.org/a.png" 1x)',
      'background-image: cross-fade(url(#a), url(#b))',
      'mask: element(#x)',
      'cursor: url(data:image/png;base64,AA), auto',
      '@import "https://example.org/x.css"',
      'src: local(x)',
      'background: url(/*c*/https://example.org/a.png)',
    ];
    for (const css of loads) expect([css, cssLoads(css)]).toEqual([css, true]);
  });

  test('leaves what draws locally alone', () => {
    const local = ['color: red', 'fill: url(#grad)', 'fill: url( "#g" )', 'font-family: "Image Sans", serif', 'stroke-dasharray: 5 5', 'content: "image"', ''];
    for (const css of local) expect([css, cssLoads(css)]).toEqual([css, false]);
  });
});

describe('isLocalReference', () => {
  test('keeps a fragment or a data: picture, read the way a browser reads a URL', () => {
    for (const ref of ['#a', ' #a', '\t#a', PNG, 'DATA:image/jpeg;base64,AA', 'data:image/webp,AA', ' data:image/\tpng;base64,AA']) expect([ref, isLocalReference(ref)]).toEqual([ref, true]);
    for (const ref of ['https://example.org/a.png', '//example.org/a.png', 'a.png', 'data:image/svg+xml,<svg/>', 'data:text/html,x', 'javascript:x', '\u0001https://example.org/', '']) {
      expect([ref, isLocalReference(ref)]).toEqual([ref, false]);
    }
  });
});

describe("the diagram's sheet", () => {
  test('off, a kept rule loses each declaration that loads; on, it is as before', () => {
    const css = '#r .a{color:red;background-image:-webkit-image-set("https://example.org/a.png" 1x)}#r .b{fill:url(#g)}';
    // The base keeps the string form (it only knows url( and the plain functions)...
    expect(scopeDiagramCss(css, 'r')).toBe(css);
    // ...off, the declaration goes and the rest of the rule stays.
    expect(scopeDiagramCss(css, 'r', { remoteLoads: false })).toBe('#r .a{color:red}#r .b{fill:url(#g)}');
    expect(scopeDiagramCss('#r .a{background:u\\72l(https://example.org/x)}', 'r', { remoteLoads: false })).toBe('');
  });
});

function label(html: string): SVGSVGElement {
  const svg = parseInertSvg(
    `<svg xmlns="${SVG}" id="r"><g class="node"><foreignObject width="100" height="24"><div xmlns="${XHTML}"><span class="nodeLabel"><p>${html}</p></span></div></foreignObject></g></svg>`,
  );
  if (!svg) throw new Error('did not parse');
  return svg;
}

const LOADING_LABEL =
  `<img id="remote" src="https://example.org/a.png" srcset="https://example.org/b.png 2x"/><img id="local" src="${PNG}"/><img id="svgdata" src="data:image/svg+xml,x"/>` +
  '<video id="v" poster="https://example.org/p.png"></video><table id="t" background="https://example.org/t.png"><tr><td>x</td></tr></table>' +
  '<span id="bg" style="background: url(https://example.org/bg.png); color: red">s</span>' +
  '<span id="set" style="background-image: -webkit-image-set(&quot;https://example.org/w.png&quot; 1x); font-weight: bold">w</span>' +
  '<svg><rect id="far" fill="url(https://example.org/p.svg#a)"/><rect id="near" fill="url(#g)"/><image id="im" href="https://example.org/i.png"/><image id="imd" href="' + PNG + '"/></svg>';

describe.if(hasDom)('what a label may hold once mounted', () => {
  test('off: only a fragment or a data: picture is kept, and every declaration that loads goes', () => {
    setDiagramRemoteLoads(false);
    const svg = label(LOADING_LABEL);
    scrubDiagramSvg(svg);
    const q = (id: string) => svg.querySelector(`#${id}`)!;
    expect(q('remote').hasAttribute('src')).toBe(false);
    expect(q('remote').hasAttribute('srcset')).toBe(false);
    expect(q('local').getAttribute('src')).toBe(PNG);
    expect(q('svgdata').hasAttribute('src')).toBe(false);
    expect(q('v').hasAttribute('poster')).toBe(false);
    expect(q('t').hasAttribute('background')).toBe(false);
    expect(q('bg').getAttribute('style')).toBe('color: red');
    expect(q('set').getAttribute('style')).toBe('font-weight: bold');
    expect(q('far').hasAttribute('fill')).toBe(false);
    expect(q('near').getAttribute('fill')).toBe('url(#g)');
    expect(q('im').hasAttribute('href')).toBe(false);
    expect(q('imd').getAttribute('href')).toBe(PNG);
  });

  test('on: exactly as before (remote pictures kept for the page to decide, data: references dropped)', () => {
    const svg = label(LOADING_LABEL);
    scrubDiagramSvg(svg);
    const q = (id: string) => svg.querySelector(`#${id}`)!;
    expect(q('remote').getAttribute('src')).toBe('https://example.org/a.png');
    expect(q('remote').getAttribute('srcset')).toBe('https://example.org/b.png 2x');
    expect(q('local').hasAttribute('src')).toBe(false);
    expect(q('bg').getAttribute('style')).toBe('background: url(https://example.org/bg.png); color: red');
    expect(q('far').getAttribute('fill')).toBe('url(https://example.org/p.svg#a)');
  });

  test('every captured real diagram comes out the same with the option off', () => {
    for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith('.svg'))) {
      const markup = readFileSync(join(FIXTURES, file), 'utf8');
      const on = parseInertSvg(markup)!;
      scrubDiagramSvg(on);
      setDiagramRemoteLoads(false);
      const off = parseInertSvg(markup)!;
      scrubDiagramSvg(off);
      resetDiagramRemoteLoads();
      expect([file, off.outerHTML]).toEqual([file, on.outerHTML]);
    }
  });
});
