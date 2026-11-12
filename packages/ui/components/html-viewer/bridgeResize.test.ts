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
    expect(measure({ top: -50, bottom: 50, scrollHeight: 900 }, { scrollY: 50 })).toBe(900);
  });
});

describe('nextResizeHeight (feedback guard)', () => {
  const next = new Function(
    `${extractFunction(BRIDGE_SCRIPT, 'nextResizeHeight')}
     return nextResizeHeight;`,
  )() as (state: object, h: number, viewport: number) => number | null;

  function settle(measureAt: (viewport: number) => number, startViewport = 600) {
    const state = { last: 0, excess: 0, awaiting: false };
    let viewport = startViewport;
    const posted: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const h = next(state, measureAt(viewport), viewport);
      if (h === null) break;
      posted.push(h);
      viewport = h;
    }
    return { posted, viewport, state };
  }

  test('frame-coupled content stops growing after one grow', () => {
    const { posted } = settle((viewport) => viewport + 16);
    expect(posted).toEqual([616]);
    expect(settle((viewport) => viewport * 2).posted).toEqual([1200]);
  });

  test('ordinary content grows, shrinks, and grows again after a hold', () => {
    expect(settle(() => 760).posted).toEqual([760]);
    expect(settle(() => 110).posted).toEqual([110]);

    const coupled = settle((viewport) => viewport + 16);
    const h = next(coupled.state, 2000, coupled.viewport);
    expect(h).toBe(2000);
  });
});
