/**
 * A selection made with a finger on an HTML page, and a pin revealed above a
 * card that floats over the frame.
 *
 * A long press and its handles send no mouseup, so the bridge reads the
 * selection from `selectionchange`, as the Markdown viewer does. These evaluate
 * the SHIPPED functions out of the bridge's string with small fakes; the real
 * selection is driven in tests/e2e/inbox-html-phone.spec.ts. The bridge is
 * vendored whole and imports nothing, so its query and wait are written out in
 * it: these use the shared constants, and fail if the two drift.
 *
 * The viewer half is DOM-gated: a viewer that never asks posts nothing, so
 * Plannotator's plan, review and annotate surfaces are unchanged.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TOUCH_PRIMARY_QUERY, TOUCH_SELECTION_SETTLE_MS } from '../../utils/touchSelection';
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SCRIPT } from './bridge-script';
import type { ViewerHandle } from '../Viewer';

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

/** A range at character offsets: two ranges are the same when their offsets are. */
class FakeRange {
  static START_TO_START = 0;
  static END_TO_END = 2;
  constructor(
    readonly start: number,
    readonly end: number,
  ) {}
  compareBoundaryPoints(how: number, other: FakeRange): number {
    return how === FakeRange.START_TO_START ? other.start - this.start : other.end - this.end;
  }
}

function bridge(options: { coarse: boolean }) {
  const calls: string[] = [];
  const listeners: Array<() => void> = [];
  const timers = new Map<number, { run: () => void; wait: number }>();
  let timerId = 0;
  const queries: string[] = [];
  const world = {
    selection: { isCollapsed: true, rangeCount: 0, range: null as FakeRange | null, text: '' },
    pendingRange: null as FakeRange | null,
  };
  const fakeWindow = {
    getSelection: () => ({
      isCollapsed: world.selection.isCollapsed,
      rangeCount: world.selection.rangeCount,
      getRangeAt: () => world.selection.range,
      toString: () => world.selection.text,
    }),
    matchMedia: (query: string) => {
      queries.push(query);
      return { matches: options.coarse };
    },
  };
  const fakeDocument = {
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'selectionchange') listeners.push(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      if (type === 'selectionchange') listeners.splice(listeners.indexOf(fn), 1);
    },
  };
  const api = new Function(
    'window',
    'document',
    'Range',
    'setTimeout',
    'clearTimeout',
    'clearMultiTargets',
    'clearPendingPin',
    'handleSelection',
    'world',
    `var touchSelectionOn = false;
     var touchSelectionTimer = 0;
     ${extractFunction('isReportedRange').replaceAll('pendingRange', 'world.pendingRange')}
     ${extractFunction('takeTouchSelection')}
     ${extractFunction('onTouchSelectionChange')}
     ${extractFunction('setTouchSelection')}
     return { setTouchSelection: setTouchSelection };`,
  )(
    fakeWindow,
    fakeDocument,
    FakeRange,
    (run: () => void, wait: number) => {
      timerId += 1;
      timers.set(timerId, { run, wait });
      return timerId;
    },
    (id: number) => timers.delete(id),
    () => calls.push('clearMultiTargets'),
    () => calls.push('clearPendingPin'),
    () => calls.push('handleSelection'),
    world,
  ) as { setTouchSelection: (active: boolean) => void };

  return {
    ...api,
    calls,
    listeners,
    timers,
    queries,
    world,
    select(start: number, end: number, text = 'some words') {
      const range = new FakeRange(start, end);
      world.selection = { isCollapsed: start === end, rangeCount: 1, range, text };
      return range;
    },
    /** A selectionchange, and the wait running out. */
    settle() {
      for (const fn of [...listeners]) fn();
      for (const timer of [...timers.values()]) timer.run();
      timers.clear();
    },
  };
}

describe('touch selection in the bridge', () => {
  // Failure to catch: the selection bridge listening on a desktop, or a viewer's pointer query drifting from the shared one.
  test('it listens only where it is asked and the main pointer is a finger', () => {
    const mouse = bridge({ coarse: false });
    mouse.setTouchSelection(true);
    expect(mouse.listeners).toHaveLength(0);
    expect(mouse.queries).toEqual([TOUCH_PRIMARY_QUERY]);

    const phone = bridge({ coarse: true });
    expect(phone.listeners).toHaveLength(0);
    phone.setTouchSelection(true);
    expect(phone.listeners).toHaveLength(1);
    phone.setTouchSelection(false);
    expect(phone.listeners).toHaveLength(0);
  });

  // Failure to catch: reporting each handle movement, or a wait that drifts from the Markdown viewer's.
  test('a selection is read once it rests, after the same wait as Markdown', () => {
    const phone = bridge({ coarse: true });
    phone.setTouchSelection(true);
    phone.select(0, 4);
    phone.listeners[0]!();
    phone.listeners[0]!();
    expect(phone.timers.size).toBe(1);
    expect([...phone.timers.values()][0]!.wait).toBe(TOUCH_SELECTION_SETTLE_MS);
    expect(phone.calls).toEqual([]);
    [...phone.timers.values()][0]!.run();
    expect(phone.calls).toEqual(['clearMultiTargets', 'clearPendingPin', 'handleSelection']);
  });

  // Failure to catch: a pin selects its element's text, so reading that back would turn every pin into a selection draft.
  test('the selection a pin made is not reported again, and new words over it are', () => {
    const phone = bridge({ coarse: true });
    phone.setTouchSelection(true);
    phone.world.pendingRange = phone.select(10, 40);
    phone.settle();
    expect(phone.calls).toEqual([]);

    phone.select(12, 30);
    phone.settle();
    expect(phone.calls).toContain('handleSelection');
  });

  // Failure to catch: a focus move out of the frame collapsing the selection and taking the card and its words with it.
  test('a collapsed or blank selection is not taken', () => {
    const phone = bridge({ coarse: true });
    phone.setTouchSelection(true);
    phone.select(5, 5);
    phone.settle();
    phone.select(5, 9, '  \n ');
    phone.settle();
    expect(phone.calls).toEqual([]);
  });
});

describe('a pin revealed above a card', () => {
  function reveal(box: { top: number; bottom: number }, covered: number, scrollers: Array<{ scrollTop: number; max: number; overflowY?: string }>) {
    const nodes = scrollers.map((s) => {
      let top = s.scrollTop;
      return {
        s,
        parentElement: null as unknown,
        get scrollTop() {
          return top;
        },
        set scrollTop(value: number) {
          top = Math.max(0, Math.min(s.max, value));
        },
      };
    });
    nodes.forEach((node, i) => {
      node.parentElement = nodes[i + 1] ?? null;
    });
    const el = {
      parentElement: nodes[0] ?? null,
      getBoundingClientRect: () => ({ ...box, height: box.bottom - box.top }),
    };
    new Function(
      'window',
      'document',
      'getComputedStyle',
      'el',
      'covered',
      `${extractFunction('revealAbove')}; revealAbove(el, covered);`,
    )({ innerHeight: 600 }, { scrollingElement: null }, (node: { s: { overflowY?: string } }) => ({ overflowY: node.s.overflowY ?? 'auto' }), el, covered);
    return nodes.map((n) => n.scrollTop);
  }

  // Failure to catch: the page jumping under a person who pinned something already in sight.
  test('a pin in sight moves nothing', () => {
    expect(reveal({ top: 100, bottom: 200 }, 250, [{ scrollTop: 50, max: 1000 }])).toEqual([50]);
  });

  // Failure to catch: the pin sitting under the card with the comment about it.
  test('a pin under the card comes into the clear part of the page', () => {
    // 350 px are clear: a 100 px pin centred there is at 125-225, so from 500 it moves by 375.
    expect(reveal({ top: 500, bottom: 600 }, 250, [{ scrollTop: 10, max: 1000 }])).toEqual([385]);
  });

  // Failure to catch: an inner scroller at its end swallowing the move, when the page around it could still scroll.
  test('what one scroller cannot take goes to the next, past ones that do not scroll', () => {
    expect(reveal({ top: 500, bottom: 600 }, 250, [{ scrollTop: 0, max: 100 }, { scrollTop: 0, max: 0, overflowY: 'visible' }, { scrollTop: 0, max: 1000 }])).toEqual([100, 0, 275]);
  });
});

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;
const mountedRoots: Array<{ unmount: () => void }> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe.if(hasDom)('HtmlViewer touchSelection', () => {
  async function mount(touchSelection?: boolean) {
    const HtmlViewer = htmlViewerModule!.HtmlViewer;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    const handle = React.createRef<ViewerHandle>();
    const element = (value?: boolean) => (
      <HtmlViewer ref={handle} rawHtml="<html><body><p>Target</p></body></html>" annotations={[]} onAddAnnotation={() => {}} onSelectAnnotation={() => {}} selectedAnnotationId={null} {...(value === undefined ? {} : { touchSelection: value })} />
    );
    await act(async () => {
      root.render(element(touchSelection));
    });
    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    const posted: Array<Record<string, unknown>> = [];
    (iframe.contentWindow as unknown as { postMessage: (data: unknown) => void }).postMessage = (data: unknown) => {
      if (data && typeof data === 'object') posted.push(data as Record<string, unknown>);
    };
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type: 'plannotator-bridge-ready', protocolVersion: BRIDGE_PROTOCOL_VERSION } }));
    });
    return {
      posted,
      handle,
      rerender: (value: boolean) =>
        act(async () => {
          root.render(element(value));
        }),
    };
  }
  const asked = (posted: Array<Record<string, unknown>>) => posted.filter((m) => m.type === 'plannotator-bridge-set-touch-selection');

  // Failure to catch: the plan, review and annotate surfaces gaining a message they never had.
  test('a viewer that does not ask posts nothing', async () => {
    const { posted } = await mount();
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.filter((m) => String(m.type).includes('touch'))).toEqual([]);
  });

  // Failure to catch: the listener staying on when the Inbox leaves the phone layout.
  test('a viewer that asks turns it on when the bridge is ready, and off again', async () => {
    const { posted, rerender } = await mount(true);
    expect(asked(posted).map((m) => m.active)).toEqual([true]);
    await rerender(false);
    expect(asked(posted).map((m) => m.active)).toEqual([true, false]);
  });

  // Failure to catch: revealPin() with no argument changing for the surface that centres its pin.
  test('revealPin says how much is covered only when told', async () => {
    const { posted, handle } = await mount();
    posted.length = 0;
    handle.current!.revealPin!();
    handle.current!.revealPin!({ clearBottom: 240 });
    const reveals = posted.filter((m) => String(m.type).endsWith('reveal-pin'));
    expect(reveals).toHaveLength(2);
    expect('clearBottom' in reveals[0]!).toBe(false);
    expect(reveals[1]!.clearBottom).toBe(240);
  });
});
