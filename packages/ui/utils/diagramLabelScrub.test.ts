/**
 * The sanitizer's post-pass over what a diagram's labels may hold once
 * mounted (`scrubDiagramSvg`), on markup parsed inert (happy-dom cannot host
 * DOMPurify; the DOMPurify parse and Mermaid's own label pass are proven in a
 * browser by tests/e2e/diagram-label-scrub.spec.ts).
 *
 * What regresses if these fail:
 * - a label keeps an element that loads (a picture, media) or navigates the
 *   tab when clicked (an image map, a form, a button);
 * - an attribute that loads or navigates survives on any element
 *   (`background`, `poster`, `srcset`, `action`, an http(s) `href`, …);
 * - a `style` keeps a declaration that fetches or pins the label to the
 *   window, or loses the declarations around it;
 * - a label keeps a class of the page's own (`fixed inset-0`), or loses one
 *   of Mermaid's;
 * - a real diagram comes out different at all.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInertSvg } from '../test-setup/diagramSvg';
import { scrubDiagramSvg } from './diagram-render';

const hasDom = typeof document !== 'undefined';
const FIXTURES = join(import.meta.dir, '..', 'test-setup', 'fixtures', 'diagrams');
const SVG = 'http://www.w3.org/2000/svg';
const XHTML = 'http://www.w3.org/1999/xhtml';

/** One html label, the way Mermaid writes it. */
function label(html: string): SVGSVGElement {
  const svg = parseInertSvg(
    `<svg xmlns="${SVG}" id="r"><g class="node"><foreignObject width="100" height="24"><div xmlns="${XHTML}" style="display: table-cell; white-space: nowrap;"><span class="nodeLabel"><p>${html}</p></span></div></foreignObject></g></svg>`,
  );
  if (!svg) throw new Error('did not parse');
  return svg;
}

describe.if(hasDom)('what a label may hold once mounted', () => {
  test('drops what loads and what navigates, and keeps the words of a form', () => {
    const svg = label(
      '<img src="https://evil.test/a.png" usemap="#m"/><map name="m"><area shape="default" href="https://evil.test/x"/></map>' +
        '<video poster="https://evil.test/p.png"><source src="https://evil.test/v.mp4"/><track src="https://evil.test/t.vtt"/></video>' +
        '<audio src="https://evil.test/a.mp3"></audio><picture><source srcset="https://evil.test/s.png"/></picture>' +
        '<form action="https://evil.test/f"><button formaction="https://evil.test/g">Go</button><input type="image" src="https://evil.test/i.png"/>' +
        '<select><option>One</option></select><textarea>Note</textarea></form>',
    );
    scrubDiagramSvg(svg);
    const tags = Array.from(svg.querySelectorAll('*')).map((e) => e.localName);
    for (const tag of ['img', 'map', 'area', 'video', 'source', 'track', 'audio', 'picture', 'form', 'button', 'input', 'select', 'option', 'textarea']) {
      expect([tag, tags.includes(tag)]).toEqual([tag, false]);
    }
    expect(svg.querySelector('p')?.textContent).toBe('GoOneNote');
  });

  test('no element keeps an attribute that loads or navigates; a #fragment link stays', () => {
    const svg = label(
      '<table background="https://evil.test/t.png"><tr><td background="https://evil.test/d.png">x</td></tr></table>' +
        '<blockquote cite="https://evil.test/c">q</blockquote><a href="https://evil.test/a" ping="https://evil.test/p">link</a>' +
        '<object data="https://evil.test/o"></object><span longdesc="https://evil.test/l" lowsrc="https://evil.test/w">s</span>',
    );
    const g = svg.querySelector('g')!;
    const image = document.createElementNS(SVG, 'image');
    image.setAttribute('href', 'https://evil.test/i.png');
    const use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', '#r');
    const pattern = document.createElementNS(SVG, 'pattern');
    pattern.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '//evil.test/p.svg#a');
    g.append(image, use, pattern);
    scrubDiagramSvg(svg);
    const refs = Array.from(svg.querySelectorAll('*')).flatMap((e) => Array.from(e.attributes).filter((a) => /href|src|background|cite|ping|data$|longdesc|lowsrc/.test(a.name)).map((a) => `${e.localName}@${a.name}=${a.value}`));
    expect(refs).toEqual(['use@href=#r']);
    // The elements themselves (and their words) stay.
    expect(svg.querySelector('td')?.textContent).toBe('x');
    expect(svg.querySelector('a')?.textContent).toBe('link');
  });

  test('a style keeps every declaration but one that fetches or pins the label to the window', () => {
    const svg = label(
      '<span id="a" style="color: red; background: url(https://evil.test/bg.png); font-weight: bold">a</span>' +
        '<span id="b" style="background-image: image-set(&quot;https://evil.test/i.png&quot; 1x)">b</span>' +
        '<span id="c" style="b\\61ckground: u\\72l(//evil.test/e.png); color: blue">c</span>' +
        '<span id="d" style="position: fixed; inset: 0; z-index: 50">d</span>' +
        '<span id="e" style="position:-webkit-sticky;top:0">e</span>' +
        '<span id="f" style="position: relative; left: 2px; fill: url(#grad)">f</span>' +
        '<span id="g" style="color:red;font-size:18px">g</span>',
    );
    scrubDiagramSvg(svg);
    const style = (id: string) => svg.querySelector(`#${id}`)!.getAttribute('style');
    expect(style('a')).toBe('color: red; font-weight: bold');
    expect(style('b')).toBeNull();
    expect(style('c')).toBe('color: blue');
    expect(style('d')).toBe('inset: 0; z-index: 50');
    expect(style('e')).toBe('top:0');
    // Nothing refused: left byte for byte.
    expect(style('f')).toBe('position: relative; left: 2px; fill: url(#grad)');
    expect(style('g')).toBe('color:red;font-size:18px');
  });

  test('a presentation attribute that fetches goes; a marker reference stays', () => {
    const svg = label('x');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('fill', 'url(https://evil.test/p.svg#a)');
    path.setAttribute('filter', 'url(//evil.test/f.svg#b)');
    path.setAttribute('marker-end', 'url(#r_arrowhead)');
    svg.querySelector('g')!.append(path);
    scrubDiagramSvg(svg);
    expect(path.hasAttribute('fill')).toBe(false);
    expect(path.hasAttribute('filter')).toBe(false);
    expect(path.getAttribute('marker-end')).toBe('url(#r_arrowhead)');
  });

  test('inside a label only Mermaid\'s own classes stay; a class outside the labels is untouched', () => {
    const svg = label(
      '<div class="fixed inset-0 z-50 bg-red-500">cover</div><i class="fa fa-car"></i>' +
        '<span class="katex"><span class="katex-mathml">m</span></span><svg class="fixed w-screen"></svg>',
    );
    svg.querySelector('g')!.setAttribute('class', 'node hot fixed');
    scrubDiagramSvg(svg);
    const classes = Array.from(svg.querySelectorAll('foreignObject [class]')).map((e) => `${e.localName}.${e.getAttribute('class')}`);
    expect(classes).toEqual(['span.nodeLabel', 'i.fa fa-car', 'span.katex', 'span.katex-mathml']);
    expect(svg.querySelector('foreignObject div div, foreignObject p > div')!.hasAttribute('class')).toBe(false);
    // The node group is svg, outside every label: classDef classes stay.
    expect(svg.querySelector('g')!.getAttribute('class')).toBe('node hot fixed');
  });

  test('every captured real diagram comes out with the same elements and attributes', () => {
    // What regresses: a label rule that touches Mermaid's own output (a class, a style, a reference).
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
    }
  });
});
