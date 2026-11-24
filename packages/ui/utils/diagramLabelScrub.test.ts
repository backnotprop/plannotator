/**
 * What a diagram's labels and styles may do once drawn: never navigate or
 * submit, never pin anything to the window. Mermaid's own label pass
 * (`MERMAID_CONFIG.dompurifyConfig`), the post-pass (`scrubDiagramSvg`) and
 * the style filter (`keepContainedDeclarations`, used on `style` attributes
 * and on every rule `scopeDiagramCss` keeps). The DOMPurify parse and the
 * mounts' confinement are proven in a browser by
 * tests/e2e/diagram-label-scrub.spec.ts and diagram-label-scrub-webkit.spec.ts.
 *
 * What regresses if these fail:
 * - Mermaid's label pass stops dropping an image map, a form or its controls
 *   (or a directive could replace that config);
 * - a label keeps an element or attribute that navigates or submits when
 *   clicked once mounted;
 * - a `position` that takes an element out of the diagram (`fixed`,
 *   `sticky`, `var(--p)`, an escaped spelling) survives in a style or a rule,
 *   or the declarations around it are lost;
 * - a label loses something that only loads (a picture), which drew before;
 * - a real diagram comes out different at all.
 *
 * The DOM-gated block runs with DOM_TESTS=1.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInertSvg } from '../test-setup/diagramSvg';
import { keepContainedDeclarations, scopeDiagramCss, scrubDiagramSvg } from './diagram-render';
import { MERMAID_CONFIG } from './mermaid';

const hasDom = typeof document !== 'undefined';
const FIXTURES = join(import.meta.dir, '..', 'test-setup', 'fixtures', 'diagrams');
const SVG = 'http://www.w3.org/2000/svg';
const XHTML = 'http://www.w3.org/1999/xhtml';

describe("Mermaid's own label pass", () => {
  test('drops what navigates or submits, keeps what only loads, and a directive cannot replace it', () => {
    const config = MERMAID_CONFIG.dompurifyConfig as { FORBID_TAGS?: string[]; FORBID_ATTR?: string[] } | undefined;
    const tags = config?.FORBID_TAGS ?? [];
    const attrs = config?.FORBID_ATTR ?? [];
    for (const tag of ['style', 'form', 'button', 'input', 'select', 'option', 'optgroup', 'datalist', 'textarea', 'map', 'area', 'base']) {
      expect([tag, tags.includes(tag)]).toEqual([tag, true]);
    }
    for (const attr of ['action', 'formaction', 'ping', 'target', 'usemap', 'for', 'accesskey']) expect([attr, attrs.includes(attr)]).toEqual([attr, true]);
    // A picture or media in a label draws as it did on main (the page's own policy decides what loads).
    for (const tag of ['img', 'picture', 'source', 'video', 'audio', 'image']) expect([tag, tags.includes(tag)]).toEqual([tag, false]);
    for (const attr of ['src', 'srcset', 'href', 'background', 'poster']) expect([attr, attrs.includes(attr)]).toEqual([attr, false]);
    expect(MERMAID_CONFIG.secure).toContain('dompurifyConfig');
    expect(MERMAID_CONFIG.secure).toContain('securityLevel');
  });
});

describe('keepContainedDeclarations', () => {
  test('drops every position that is not static, relative or absolute, however it is spelled', () => {
    const escaping = [
      'position: fixed',
      'position:sticky',
      'position: -webkit-sticky',
      'POSITION: FIXED !important',
      'position: var(--p)',
      'position: inherit',
      'position: revert',
      'position: \\66ixed',
      'posit\\69on: fixed',
      'position:/* x */fixed',
    ];
    for (const declaration of escaping) {
      expect([declaration, keepContainedDeclarations(`color: red; ${declaration}; top: 0`)]).toEqual([declaration, 'color: red; top: 0']);
    }
  });

  test('splits where the browser would, so a declaration cannot hide behind a quote, a comment or an escape', () => {
    // A comment holding a quote, a string cut by a line break, an escaped quote outside a string.
    expect(keepContainedDeclarations("color:red/*'*/;position:fixed")).toBe('color:red');
    expect(keepContainedDeclarations('content:"a\n;position:fixed')).toBe('content:"a');
    expect(keepContainedDeclarations("x:\\';position:fixed;color:red")).toBe("x:\\'; color:red");
    // A nested rule in a body.
    expect(keepContainedDeclarations('color:red;.nodeLabel{position:fixed}')).toBe('color:red');
  });

  test('keeps a contained position, and leaves a list with nothing refused byte for byte', () => {
    for (const text of [
      'position: relative; left: 2px',
      'position:absolute!important;top:0;',
      'position: static',
      'display: table-cell; white-space: nowrap; line-height: 1.5; max-width: 200px; text-align: center;',
      'content: "{"; color: red',
      'fill: url(#grad); stroke: #333',
    ]) {
      expect(keepContainedDeclarations(text)).toBe(text);
    }
    expect(keepContainedDeclarations('position: fixed')).toBeNull();
  });

  test("a kept rule of the diagram's sheet loses the same declarations, and Mermaid's own rules are untouched", () => {
    const own = '#r .node rect{fill:#fff;stroke:#333;}#r .label{position:relative;}#r div.mermaidTooltip{position:absolute;}';
    expect(scopeDiagramCss(own, 'r')).toBe(own);
    expect(scopeDiagramCss('#r .nodeLabel{position:fixed;inset:0;color:red}', 'r')).toBe('#r .nodeLabel{inset:0; color:red}');
    expect(scopeDiagramCss('#r .bad > *{position:var(--p) !important}#r .ok{color:red}', 'r')).toBe('#r .ok{color:red}');
    expect(scopeDiagramCss('@media screen{#r .x{position:sticky;top:0}}', 'r')).toBe('@media screen{#r .x{top:0}}');
  });
});

/** One html label, the way Mermaid writes it. */
function label(html: string): SVGSVGElement {
  const svg = parseInertSvg(
    `<svg xmlns="${SVG}" id="r"><g class="node"><foreignObject width="100" height="24"><div xmlns="${XHTML}" style="display: table-cell; white-space: nowrap;"><span class="nodeLabel"><p>${html}</p></span></div></foreignObject></g></svg>`,
  );
  if (!svg) throw new Error('did not parse');
  return svg;
}

describe.if(hasDom)('what a label may hold once mounted', () => {
  test('drops what navigates or submits and keeps its words', () => {
    const svg = label(
      '<img src="https://example.org/a.png" usemap="#m"/><map name="m"><area shape="default" href="https://example.org/x"/></map>' +
      '<label for="app-button" accesskey="k">press</label>' +
        '<form action="https://example.org/f" target="_top"><button formaction="https://example.org/g">Go</button><input type="submit" value="Send"/>' +
        '<select><option>One</option></select><textarea>Note</textarea></form><base href="https://example.org/"/>' +
        '<a href="https://example.org/a" ping="https://example.org/p" target="_blank">link</a>',
    );
    scrubDiagramSvg(svg);
    const tags = Array.from(svg.querySelectorAll('*')).map((e) => e.localName);
    for (const tag of ['map', 'area', 'form', 'button', 'input', 'select', 'option', 'textarea', 'base']) {
      expect([tag, tags.includes(tag)]).toEqual([tag, false]);
    }
    const navigating = Array.from(svg.querySelectorAll('*')).flatMap((e) =>
      e.getAttributeNames().filter((n) => ['action', 'formaction', 'ping', 'target', 'usemap', 'for', 'accesskey'].includes(n)).map((n) => `${e.localName}@${n}`),
    );
    expect(navigating).toEqual([]);
    expect(svg.querySelector('a')!.hasAttribute('href')).toBe(false);
    expect(svg.querySelector('p')?.textContent).toBe('pressGoOneNotelink');
  });

  test('keeps what only loads, as main did', () => {
    const svg = label(
      '<img src="https://example.org/a.png" srcset="https://example.org/b.png 2x" width="20"/>' +
        '<video poster="https://example.org/p.png"></video><table background="https://example.org/t.png"><tr><td>x</td></tr></table>' +
        '<span id="bg" style="background: url(https://example.org/bg.png); color: red">s</span>',
    );
    scrubDiagramSvg(svg);
    expect(svg.querySelector('img')!.getAttribute('src')).toBe('https://example.org/a.png');
    expect(svg.querySelector('img')!.getAttribute('srcset')).toBe('https://example.org/b.png 2x');
    expect(svg.querySelector('video')!.getAttribute('poster')).toBe('https://example.org/p.png');
    expect(svg.querySelector('table')!.getAttribute('background')).toBe('https://example.org/t.png');
    expect(svg.querySelector('#bg')!.getAttribute('style')).toBe('background: url(https://example.org/bg.png); color: red');
  });

  test("a label's style loses only a position that leaves the diagram", () => {
    const svg = label(
      '<span id="a" style="position: fixed; inset: 0; z-index: 50">a</span>' +
        '<span id="b" style="--p: fixed"><span id="c" style="position: var(--p); top: 0">c</span></span>' +
        '<span id="d" style="position: fixed">d</span>' +
        '<span id="e" style="color:red;font-size:18px">e</span>',
    );
    scrubDiagramSvg(svg);
    const style = (id: string) => svg.querySelector(`#${id}`)!.getAttribute('style');
    expect(style('a')).toBe('inset: 0; z-index: 50');
    // A custom property alone moves nothing; the declaration that reads it goes.
    expect(style('b')).toBe('--p: fixed');
    expect(style('c')).toBe('top: 0');
    expect(style('d')).toBeNull();
    expect(style('e')).toBe('color:red;font-size:18px');
  });

  test('every captured real diagram comes out with the same elements and attributes', () => {
    // What regresses: a rule here that touches Mermaid's own output (a class, a style, a reference).
    for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith('.svg'))) {
      const markup = readFileSync(join(FIXTURES, file), 'utf8');
      const raw = parseInertSvg(markup)!;
      const clean = parseInertSvg(markup)!;
      scrubDiagramSvg(clean);
      const shape = (svg: SVGSVGElement) =>
        Array.from(svg.querySelectorAll('*'))
          .filter((e) => e.localName !== 'a')
          .map((e) => `${e.localName} ${Array.from(e.attributes).map((a) => `${a.name}=${a.value}`).sort().join(' ')}`);
      expect([file, shape(clean)]).toEqual([file, shape(raw)]);
      // The sheet too: the position filter leaves every one of Mermaid's rule bodies whole. Pele's
      // captured svg (`pele-*.svg`) has no sheet: its styling is inline, covered by the shape check above.
      if (file.startsWith('pele-')) continue;
      const bodies = Array.from(raw.querySelectorAll('style')).flatMap((s) => Array.from((s.textContent ?? '').matchAll(/\{([^{}]*)\}/gu), (m) => m[1] ?? ''));
      expect(bodies.length).toBeGreaterThan(0);
      expect([file, bodies.filter((body) => keepContainedDeclarations(body) !== body)]).toEqual([file, []]);
    }
  });
});
