/**
 * Frame auto-height measurement in the bridge (`measureContentHeight`).
 *
 * Regression: the bridge reported `document.body.scrollHeight`, which omits a
 * child's top margin that collapses through a margin-less body (and the same
 * at the bottom), so a page like `body{margin:0}` + `.card{margin-top:40px}`
 * was cut short by its margins. The fix must also not read anything sized by
 * the frame itself (documentElement.scrollHeight never drops below the frame's
 * viewport, and an html{height:100%} root IS the frame's height), or the frame
 * could grow but never shrink.
 *
 * happy-dom has no layout, so this evaluates the SHIPPED function against a
 * small hand-built box model. The real-layout check (Chromium, collapsed
 * margins, html{height:100%} growing and shrinking) was done by hand when the
 * fix landed; these cases pin the arithmetic and the chain-walk rules.
 */
import { describe, expect, test } from 'bun:test';
import { BRIDGE_SCRIPT } from './bridge-script';

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`bridge no longer defines ${name}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces around ${name}`);
}

interface FakeBox {
  top: number;
  bottom: number;
  style?: Record<string, string>;
  children?: FakeBox[];
  scrollHeight?: number;
}

interface FakeEl {
  box: FakeBox;
  scrollHeight: number;
  clientTop: number;
  lastElementChild: FakeEl | null;
  previousElementSibling: FakeEl | null;
  getBoundingClientRect(): { top: number; bottom: number };
}

const DEFAULT_STYLE: Record<string, string> = {
  display: 'block',
  position: 'static',
  float: 'none',
  overflowY: 'visible',
  marginBottom: '0px',
  paddingBottom: '0px',
  borderBottomWidth: '0px',
};

function build(box: FakeBox): FakeEl {
  const el: FakeEl = {
    box,
    scrollHeight: box.scrollHeight ?? box.bottom - box.top,
    clientTop: 0,
    lastElementChild: null,
    previousElementSibling: null,
    getBoundingClientRect: () => ({ top: box.top, bottom: box.bottom }),
  };
  let prev: FakeEl | null = null;
  for (const childBox of box.children ?? []) {
    const child = build(childBox);
    child.previousElementSibling = prev;
    prev = child;
  }
  el.lastElementChild = prev;
  return el;
}

/** Run the shipped measure against a fake body (and a root that, like an
 *  html{height:100%} root, is as tall as the frame: the measure must not care). */
function measure(bodyBox: FakeBox, opts: { scrollY?: number; frameHeight?: number } = {}): number {
  const body = build(bodyBox);
  const frameHeight = opts.frameHeight ?? 600;
  const root = {
    scrollHeight: frameHeight,
    clientHeight: frameHeight,
    getBoundingClientRect: () => ({ top: 0, bottom: frameHeight }),
  };
  const fakeDocument = { body, documentElement: root };
  const fakeWindow = {
    pageYOffset: opts.scrollY ?? 0,
    innerHeight: frameHeight,
    getComputedStyle: (el: FakeEl | typeof root) => ({
      ...DEFAULT_STYLE,
      ...('box' in el ? el.box.style : {}),
    }),
  };
  const fn = new Function(
    'document',
    'window',
    `${extractFunction(BRIDGE_SCRIPT, 'lastInFlowChild')}
     ${extractFunction(BRIDGE_SCRIPT, 'measureContentHeight')}
     return measureContentHeight();`,
  );
  return fn(fakeDocument, fakeWindow) as number;
}

describe('measureContentHeight (bridge frame auto-height)', () => {
  test('a top margin collapsed through a margin-less body is counted', () => {
    // body{margin:0} > .card{margin-top:40px;height:560px}: body's box starts
    // at 40 and is 560 tall, so body.scrollHeight alone said 560.
    const card = { top: 40, bottom: 600 };
    expect(measure({ top: 40, bottom: 600, children: [card] })).toBe(600);
  });

  test('a bottom margin collapsed through body (and nested blocks) is counted', () => {
    const p = { top: 125, bottom: 175, style: { marginBottom: '45px' } };
    const wrapper = { top: 125, bottom: 175, children: [p] };
    const script = { top: 0, bottom: 0, style: { display: 'none' } };
    const overlay = { top: 0, bottom: 20, style: { position: 'fixed' } };
    const body = { top: 25, bottom: 175, children: [wrapper, script, overlay] };
    expect(measure(body)).toBe(220);
  });

  test('the frame height does not feed back into the measure (html{height:100%})', () => {
    const body = { top: 30, bottom: 230, children: [{ top: 30, bottom: 230 }] };
    // Same content, frame grown far past it, or shrunk below it: same answer,
    // so the frame can shrink back after content collapses.
    expect(measure(body, { frameHeight: 600 })).toBe(230);
    expect(measure(body, { frameHeight: 5000 })).toBe(230);
    expect(measure(body, { frameHeight: 100 })).toBe(230);
  });

  test('margins inside a scroll container, flex body or padded block are not added', () => {
    const inner = { top: 0, bottom: 2000, style: { marginBottom: '10px' } };
    const scroller = { top: 0, bottom: 300, style: { overflowY: 'auto' }, children: [inner] };
    expect(measure({ top: 0, bottom: 300, children: [scroller] })).toBe(300);

    const flexChild = { top: 30, bottom: 130, style: { marginBottom: '30px' } };
    expect(
      measure({ top: 0, bottom: 160, style: { display: 'flex' }, children: [flexChild] }),
    ).toBe(160);
  });

  test('overflow past body and page scroll are measured in document coordinates', () => {
    // body is 100 tall but its content scrolls to 900; the frame is scrolled 50.
    expect(measure({ top: -50, bottom: 50, scrollHeight: 900 }, { scrollY: 50 })).toBe(900);
  });
});
