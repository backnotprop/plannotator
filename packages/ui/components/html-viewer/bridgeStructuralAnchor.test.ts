/**
 * Structural anchors in the bridge (DOM-gated): a comment on an element with
 * no text and no stable id (an SVG chart's bar) keeps its place across a
 * reload of the SAME document, and nowhere else.
 *
 * Evaluates the SHIPPED functions out of the bridge's string against parsed
 * documents; "a reload" is the same source parsed again. What would regress:
 * a marker lost on every reload for the common chart (bars with no ids), or,
 * worse, a marker drawn on a neighbouring bar after the page changed.
 */
import { describe, expect, test } from 'bun:test';
import { BRIDGE_SCRIPT } from './bridge-script';
import { parseHtmlElementAnchor } from './useHtmlAnnotation';

const hasDom = typeof document !== 'undefined' && typeof DOMParser !== 'undefined';

function extractFunction(name: string): string {
  const start = BRIDGE_SCRIPT.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`bridge no longer defines ${name}`);
  let depth = 0;
  for (let i = BRIDGE_SCRIPT.indexOf('{', start); i < BRIDGE_SCRIPT.length; i += 1) {
    if (BRIDGE_SCRIPT[i] === '{') depth += 1;
    else if (BRIDGE_SCRIPT[i] === '}') {
      depth -= 1;
      if (depth === 0) return BRIDGE_SCRIPT.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces around ${name}`);
}

const constant = (name: string): number => {
  const match = new RegExp(`var ${name} = (\\d+);`).exec(BRIDGE_SCRIPT);
  if (!match) throw new Error(`bridge no longer defines ${name}`);
  return Number(match[1]);
};

interface Anchor {
  selector: string;
  tagName: string;
  structure?: unknown;
}

/** The bridge's structural anchor code in one loaded page. `on`: the host asked for structural anchors. */
function bridgeIn(doc: Document, on = true) {
  const overlayNodes = new Set<Element>();
  const api = new Function(
    'document',
    'overlayNodes',
    'isViewerOverlayNode',
    'structuralAnchors',
    'STRUCTURE_MAX_DEPTH',
    'STRUCTURE_MAX_ATTRS',
    'STRUCTURE_MAX_NAME',
    'STRUCTURE_MAX_VALUE',
    `${['structureChildren', 'structurePath', 'structureDigest', 'structureSignature', 'buildAnchorStructure', 'resolveAnchorStructure'].map(extractFunction).join('\n')}
     return { build: buildAnchorStructure, resolve: resolveAnchorStructure };`,
  )(
    doc,
    overlayNodes,
    (node: Element) => overlayNodes.has(node),
    on,
    constant('STRUCTURE_MAX_DEPTH'),
    constant('STRUCTURE_MAX_ATTRS'),
    constant('STRUCTURE_MAX_NAME'),
    constant('STRUCTURE_MAX_VALUE'),
  ) as { build: (el: Element) => unknown; resolve: (anchor: Anchor) => Element | null };
  return {
    overlayNodes,
    /** The anchor as the window keeps it: what the bridge built, through the window's own validation. */
    anchorOf: (el: Element): Anchor | null => {
      const structure = api.build(el);
      return structure ? (parseHtmlElementAnchor({ selector: el.tagName.toLowerCase(), tagName: el.tagName.toLowerCase(), structure }) as Anchor | null) : null;
    },
    resolve: api.resolve,
  };
}

/** A chart whose bars carry no ids and no text: only where they sit and what they look like. */
const chart = (bars: string[]) =>
  `<!doctype html><html><head><title>t</title></head><body><p>Signups</p><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 270"><line x1="0" x2="640" y1="236" y2="236"/>${bars.join('')}</svg></body></html>`;
const bar = (x: number, height: number, fill = 'var(--chart-2)') => `<rect x="${x}" y="${236 - height}" width="22" height="${height}" rx="3" fill="${fill}"/>`;
const BARS = [bar(40, 180), bar(140, 196), bar(240, 118), bar(340, 170)];
const load = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const rects = (doc: Document) => Array.from(doc.querySelectorAll('rect'));

describe.if(hasDom)('structural anchors (the bridge)', () => {
  test('a bar with no id is found again after a reload of the same document: that bar, by its place and its signature', () => {
    const before = load(chart(BARS));
    const pinned = rects(before)[2]!;
    const anchor = bridgeIn(before).anchorOf(pinned)!;
    expect(anchor).not.toBeNull();
    const after = load(chart(BARS));
    const found = bridgeIn(after).resolve(anchor);
    expect(found).toBe(rects(after)[2]!);
    expect(found!.getAttribute('height')).toBe('118');
  });

  test('a changed document: the path now lands on another bar, which is refused, and the old bar one place on is never taken', () => {
    const before = load(chart(BARS));
    const anchor = bridgeIn(before).anchorOf(rects(before)[2]!)!;
    // A bar was added ahead of it: the same bar now sits one place further on.
    const after = load(chart([bar(0, 90), ...BARS]));
    expect(rects(after)[3]!.getAttribute('height')).toBe('118');
    expect(bridgeIn(after).resolve(anchor)).toBeNull();
    // The bar is gone and its place is empty.
    expect(bridgeIn(load(chart(BARS.slice(0, 2)))).resolve(anchor)).toBeNull();
  });

  test('the same place with other attributes is refused: one more, one fewer, another value, another tag, another namespace', () => {
    const before = load(chart(BARS));
    const anchor = bridgeIn(before).anchorOf(rects(before)[2]!)!;
    const at = (third: string) => bridgeIn(load(chart([BARS[0]!, BARS[1]!, third, BARS[3]!]))).resolve(anchor);
    expect(at(BARS[2]!)).not.toBeNull();
    expect(at(bar(240, 119))).toBeNull();
    expect(at(BARS[2]!.replace('<rect ', '<rect opacity="0.5" '))).toBeNull();
    expect(at(BARS[2]!.replace(' rx="3"', ''))).toBeNull();
    expect(at(BARS[2]!.replace('<rect ', '<circle ').replace('/>', '></circle>'))).toBeNull();
    // The same tag name and attributes outside SVG.
    const html = load('<!doctype html><html><head><title>t</title></head><body><p>Signups</p><div><i></i><i></i><i></i><rect x="240" y="118" width="22" height="118" rx="3" fill="var(--chart-2)"></rect></div></body></html>');
    const forged = { ...anchor, structure: { ...(anchor.structure as object), path: [1, 1, 3] } };
    expect(html.querySelector('rect')).not.toBeNull();
    expect(bridgeIn(html).resolve(forged)).toBeNull();
  });

  test('a long attribute value is held as a digest: the same value matches, a value that differs only past the cap does not', () => {
    const d = `M0 0 ${'L10 10 '.repeat(200)}`;
    const page = (value: string) => chart([`<path d="${value}"/>`]);
    const before = load(page(d));
    const anchor = bridgeIn(before).anchorOf(before.querySelector('path')!)!;
    expect(JSON.stringify(anchor.structure).length).toBeLessThan(200);
    expect(bridgeIn(load(page(d))).resolve(anchor)).not.toBeNull();
    expect(bridgeIn(load(page(`${d.slice(0, -2)}9 `))).resolve(anchor)).toBeNull();
  });

  test("the viewer's own overlays are not counted, and are never anchored", () => {
    const before = load(chart(BARS));
    const anchor = bridgeIn(before).anchorOf(rects(before)[2]!)!;
    const after = load(chart(BARS));
    const bridge = bridgeIn(after);
    const overlay = after.createElement('div');
    after.body.insertBefore(overlay, after.body.firstChild);
    bridge.overlayNodes.add(overlay);
    expect(bridge.resolve(anchor)).toBe(rects(after)[2]!);
    expect(bridge.anchorOf(overlay)).toBeNull();
  });

  test("a bar pinned from the keyboard (the viewer's hover class on it) is found again after a reload", () => {
    const before = load(chart(BARS));
    const anchor = bridgeIn(before);
    const pinned = rects(before)[2]!;
    pinned.classList.add('plannotator-pinpoint-hover');
    const plain = bridgeIn(load(chart(BARS)));
    expect(plain.resolve(anchor.anchorOf(pinned)!)).not.toBeNull();
    const styled = (cls: string) => chart([BARS[0]!, BARS[1]!, BARS[2]!.replace('<rect ', `<rect class="${cls}" `), BARS[3]!]);
    const own = load(styled('bar'));
    own.querySelectorAll('rect')[2]!.classList.add('plannotator-pinpoint-hover');
    const ownAnchor = bridgeIn(own).anchorOf(own.querySelectorAll('rect')[2]!)!;
    expect(bridgeIn(load(styled('bar'))).resolve(ownAnchor)).not.toBeNull();
    expect(bridgeIn(load(chart(BARS))).resolve(ownAnchor)).toBeNull();
  });

  test('an element past the caps gets no anchor, and a host that did not ask gets none and resolves none', () => {
    const many = Array.from({ length: constant('STRUCTURE_MAX_ATTRS') + 1 }, (_, i) => `data-a${i}="v"`).join(' ');
    const wide = load(chart([`<rect ${many}/>`]));
    expect(bridgeIn(wide).anchorOf(wide.querySelector('rect')!)).toBeNull();
    const doc = load(chart(BARS));
    const anchor = bridgeIn(doc).anchorOf(rects(doc)[2]!)!;
    expect(bridgeIn(doc, false).anchorOf(rects(doc)[2]!)).toBeNull();
    expect(bridgeIn(doc, false).resolve(anchor)).toBeNull();
  });

  test('a structural anchor is resolved by its path and signature only: never by its selector', () => {
    const body = extractFunction('resolveAnchorElement');
    expect(body.indexOf('if (anchor.structure) return resolveAnchorStructure(anchor);')).toBeGreaterThan(0);
    expect(body.indexOf('if (anchor.structure) return resolveAnchorStructure(anchor);')).toBeLessThan(body.indexOf('resolveAnchorSelector(anchor)'));
  });
});
