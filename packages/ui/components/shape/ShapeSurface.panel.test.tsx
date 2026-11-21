/**
 * The board's side panel is References only, and a part's Ask answers in that part's own comment box (the owner,
 * 2026-11-16: "The thread panel needs to leave this slide out. Also Ask AI, I don't think it needs to be here
 * either", "Honestly, it's just the reference panel"). DOM-gated (tests/dom-test-list.txt). What regresses if these
 * fail:
 * - the panel grows tabs again (Ask, Thread), a chat box, or the dock its Chat button;
 * - a part's Ask stops answering where the person can read it: its answer, streamed into the box it was asked from,
 *   kept on the part when the box opens again, and listed in the whole board's box;
 * - an answer that comes later (the agent's `shape answer`) arrives unseen: the pill says so and Show opens it;
 * - a Change it no longer says where it stands (sent, waits) once the panel's list is gone.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shapeParts, type ShapeBoard, type ShapeNote, type ShapeNoteInput, type ShapeRef } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type { ShapeEvent, ShapeHost, ShapeLoaded } from './types';
import { boxKey, talkOn } from './talk';

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');

const ID = 'shp_panel_test';
const AT = '2026-11-16T10:00:00.000Z';
const PICTURE = { html: '<p data-mark="whistle">One whistle</p><p data-mark="lid" data-code="src/lid.ts#L3">The lid</p><span data-ref="1"></span>' };
const HOW = { html: '<p data-mark="steam">Steam</p>' };
const REFS: ShapeRef[] = [{ n: 1, kind: 'link', title: 'Kettle notes', target: 'https://example.com/kettle' }];

interface Rig {
  host: ShapeHost;
  /** What the board was asked, and the gate each answer waits on. */
  asked: ShapeNoteInput[];
  release: (answer: string | null) => void;
  /** An event from the host (the agent's later answer). */
  emit: (event: ShapeEvent) => void;
}

function rig(session: ShapeLoaded['session'] = { state: 'live', agent: 'Claude Code' }, stored: { notes: ShapeNote[]; finished?: boolean } | null = null): Rig {
  const board: ShapeBoard = { title: 'Kettle', claim: 'Built.', views: { picture: PICTURE, how: HOW }, refs: REFS };
  const data: ShapeLoaded = {
    shape: { v: 1, id: ID, title: 'Kettle', project: { name: 'app', root: '/work/app' }, session: null, thread: null, state: stored?.finished ? 'finished' : 'active', created: AT, updated: AT, latest: 1, drawing: null },
    version: { ...board, n: 1, at: AT, base: null, through: null, by: null, parts: shapeParts(board) },
    seen: 1,
    notes: stored?.notes ?? [],
    session,
  };
  const asked: ShapeNoteInput[] = [];
  let open: ((answer: string | null) => void) | null = null;
  const listeners: ((event: ShapeEvent) => void)[] = [];
  let n = 0;
  const note = (input: ShapeNoteInput, kind: ShapeNote['kind'], extra: Partial<ShapeNote> = {}): ShapeNote =>
    ({ id: `shn_${++n}`, kind, v: 1, view: input.view ?? null, part: input.part ?? null, quote: input.quote ?? null, text: input.text, from: kind === 'answer' ? 'agent' : 'you', re: null, delivered: null, at: AT, ...extra }) as ShapeNote;
  const host = {
    load: async () => data,
    version: async () => data.version,
    note: async (_id: string, input: ShapeNoteInput) => note(input, 'change'),
    ask: async (_id: string, input: ShapeNoteInput, onText: (text: string) => void) => {
      asked.push(input);
      const question = note(input, 'ask');
      onText('Because the lid');
      const answer = await new Promise<string | null>((done) => (open = done));
      return { question, answer: answer === null ? null : note({ ...input, text: answer }, 'answer', { re: question.id }) };
    },
    seen: () => {},
    events: (_id: string, listener: (event: ShapeEvent) => void) => {
      listeners.push(listener);
      return () => {};
    },
  } as ShapeHost;
  return {
    host,
    asked,
    release: (answer) => act(() => open?.(answer)) as unknown as void,
    emit: (event) => act(() => listeners.forEach((l) => l(event))) as unknown as void,
  };
}

let root: Root | null = null;
let unbridge: (() => void) | null = null;
let wide: PropertyDescriptor | undefined;
beforeAll(() => {
  if (!hasDom) return;
  unbridge = bridgeSanitizerDom();
  // A wide board: this DOM measures everything as 0 wide, which reads as a phone.
  wide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
});
afterAll(() => {
  unbridge?.();
  if (wide) Object.defineProperty(HTMLElement.prototype, 'clientWidth', wide);
  else if (hasDom) delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const wait = (ms = 20) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await wait();
  }
  throw new Error(`timed out waiting for ${what}`);
}
function inDrawing<T extends Element>(selector: string): T | null {
  for (const el of document.querySelectorAll('*')) {
    const found = el.shadowRoot?.querySelector<T>(selector);
    if (found) return found;
  }
  return null;
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); });
const popover = () => document.querySelector<HTMLElement>('[data-comment-popover]');
const talk = () => popover()?.querySelector<HTMLElement>('[data-shape-talk]') ?? null;
const box = () => popover()!.querySelector<HTMLTextAreaElement>('textarea')!;
const button = (scope: ParentNode, words: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === words) ?? null;

async function mount(host: ShapeHost, props: Partial<React.ComponentProps<typeof ShapeSurface>> = {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(<ShapeSurface host={host} id={ID} readFirst {...props} />));
  await until(() => !!document.querySelector('.shp-dock') && !!inDrawing('[data-mark="whistle"]'), 'the board');
  await wait();
}

/** Point at a part (Annotate on) and type into its box. */
async function pick(mark: string) {
  if (document.querySelector('.shp-tstrip button')?.getAttribute('aria-pressed') !== 'true') await click(document.querySelector('.shp-tstrip button')!);
  await click(inDrawing(`[data-mark="${mark}"]`)!);
  await until(() => !!popover(), `the box on ${mark}`);
}
async function type(words: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(box(), words);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** A finished board's stored talk: an Ask on the whistle with its answer, and a Change it on the whole board. */
function finishedNotes(): ShapeNote[] {
  return [
    { id: 'shn_q', kind: 'ask', v: 1, view: 'picture', part: 'whistle', quote: 'One whistle', text: 'Why one whistle?', from: 'you', re: null, delivered: null, at: AT },
    { id: 'shn_a', kind: 'answer', v: 1, view: 'picture', part: 'whistle', quote: null, text: 'Because the lid holds the steam.', from: 'agent', re: 'shn_q', delivered: null, at: AT },
    { id: 'shn_c', kind: 'change', v: 1, view: null, part: null, quote: null, text: 'Make it red', from: 'you', re: null, delivered: AT, at: AT },
  ] as unknown as ShapeNote[];
}
function inDrawingAll<T extends Element = HTMLElement>(selector: string): T[] {
  for (const el of document.querySelectorAll('*')) {
    const found = el.shadowRoot?.querySelectorAll<T>(selector);
    if (found?.length) return [...found];
  }
  return [];
}
const esc = () => act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
/** A laid-out drawing (this DOM lays nothing out): every part has a box, so its bubble has a corner. */
async function laidOut(run: () => Promise<void>) {
  const real = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.hasAttribute('data-mark')) {
      const top = this.getAttribute('data-mark') === 'lid' ? 160 : 100;
      return { left: 100, top, right: 300, bottom: top + 30, width: 200, height: 30, x: 100, y: top, toJSON: () => ({}) } as DOMRect;
    }
    return real.call(this);
  };
  try {
    await run();
  } finally {
    Element.prototype.getBoundingClientRect = real;
  }
}
async function closeBox() {
  await act(async () => box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await until(() => !popover(), 'the box closed');
}

describe.if(hasDom)('the side panel and the answers', () => {
  test('the panel is References only: no tabs, no chat; the dock has the views, Annotate and References, no Chat', async () => {
    const { host } = rig();
    await mount(host);
    const dock = document.querySelector<HTMLElement>('.shp-dock')!;
    expect([...dock.querySelectorAll<HTMLButtonElement>('.shp-tbtn')].map((b) => b.title)).toEqual(['Shape', 'How it works', 'Annotate: point at a part to change it or ask about it', 'References']);
    expect(dock.querySelector('button[title="Chat"], .shp-tbtn.chat')).toBeNull();
    await click(button(dock, 'References1') ?? dock.querySelector('button[title="References"]')!);
    const panel = document.querySelector<HTMLElement>('.shp-sidep.open')!;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute('aria-label')).toBe('References');
    expect(panel.querySelectorAll('[role="tab"], [role="tablist"]')).toHaveLength(0);
    expect(panel.querySelector('.shp-sidep-title')!.textContent).toBe('References');
    expect(panel.querySelector('textarea')).toBeNull();
    expect(panel.textContent).toContain('Kettle notes');
    for (const gone of ['Ask', 'Thread', 'Chat']) expect(button(panel, gone)).toBeNull();
  });

  test("the board lays out by its own size, not the window's: the panel's width reads it", async () => {
    const { host } = rig();
    await mount(host);
    const root = document.querySelector<HTMLElement>('.shp-root')!;
    // This DOM measures the board 1400 wide (beforeAll); the window is happy-dom's own.
    expect(root.style.getPropertyValue('--shp-w')).toBe('1400px');
    // The References panel's width comes from the same measure: 31% of the board, between 360 and 440.
    expect(root.style.getPropertyValue('--pw')).toBe('434px');
    const css = await Bun.file(new URL('./shape.css', import.meta.url)).text();
    // No other size on the board reads the window directly (a board in a thread's pane is narrower than it). The
    // comment box's talk is the window's: the box opens over everything, where the window is its room.
    const board = css.split('\n').filter((line) => !line.startsWith('.shp-talk')).join('\n');
    expect(board.replace(/var\(--shp-[wh], 100d?v[wh]\)/g, '').match(/\d(d?vw|d?vh)\b/g)).toBeNull();
  });

  test('an older place that names the Ask or Thread panel opens none', async () => {
    const { host } = rig();
    await mount(host, { initialPanel: 'ask' as never });
    expect(document.querySelector('.shp-sidep.open')).toBeNull();
  });

  test("a part's Ask answers in the part's own box, kept there when it opens again, and in the whole board's box", async () => {
    const r = rig();
    await mount(r.host);
    await pick('whistle');
    await type('Why one whistle?');
    await click(button(popover()!, 'Ask')!);
    // The box stays on the part, its words cleared; the answer streams in above them.
    await until(() => !!talk()?.textContent?.includes('Because the lid'), 'the streamed answer');
    expect(r.asked.map((a) => [a.part, a.text])).toEqual([['whistle', 'Why one whistle?']]);
    expect(popover()!.textContent).toContain('One whistle');
    expect(box().value).toBe('');
    expect(talk()!.textContent).toContain('Why one whistle?');
    expect(talk()!.textContent).toContain('Ask this session · Claude Code');
    r.release('Because the lid holds the steam.');
    await until(() => !!talk()?.textContent?.includes('holds the steam'), 'the answer');
    await wait();
    // Read where it was asked: no pill.
    expect(document.querySelector('[data-shape-answer-ready]')).toBeNull();
    await closeBox();
    // The same part again: its question and answer are there.
    await pick('whistle');
    expect(talk()!.textContent).toContain('Why one whistle?');
    expect(talk()!.textContent).toContain('holds the steam');
    await closeBox();
    // Another part has none of it.
    await pick('lid');
    expect(talk()).toBeNull();
    await closeBox();
    // The whole board's box lists every question with its answer.
    await click(document.querySelector('.shp-general')!);
    await until(() => !!popover(), 'the whole board box');
    expect(talk()!.textContent).toContain('Why one whistle?');
    expect(talk()!.textContent).toContain('holds the steam');
  });

  test('an answer that comes later: the pill says Answer ready, and Show opens it in the whole board\'s box', async () => {
    const r = rig();
    await mount(r.host);
    await pick('whistle');
    await type('Who boils it?');
    await click(button(popover()!, 'Ask')!);
    await until(() => r.asked.length === 1, 'the ask');
    // Nothing answers now: the question waits for the agent.
    r.release(null);
    await wait();
    await closeBox();
    r.emit({ type: 'note', note: { id: 'shn_answer', kind: 'answer', v: 1, view: 'picture', part: 'whistle', quote: null, text: 'The agent boils it.', from: 'agent', re: 'shn_1', delivered: null, at: AT } as unknown as ShapeNote });
    await until(() => !!document.querySelector('[data-shape-answer-ready]'), 'the pill');
    await click(button(document.querySelector('[data-shape-answer-ready]')!, 'Show')!);
    await until(() => !!talk(), 'the whole board box');
    expect(talk()!.textContent).toContain('Who boils it?');
    expect(talk()!.textContent).toContain('The agent boils it.');
    expect(document.querySelector('[data-shape-answer-ready]')).toBeNull();
  });

  test("Answer ready stays while an answer is unread, and goes once the last is opened from its part's bubble", async () => {
    const ask = (id: string, part: string, text: string) => ({ id, kind: 'ask', v: 1, view: 'picture', part, quote: null, text, from: 'you', re: null, delivered: null, at: AT }) as unknown as ShapeNote;
    const answer = (id: string, part: string, re: string, text: string) => ({ id, kind: 'answer', v: 1, view: 'picture', part, quote: null, text, from: 'agent', re, delivered: null, at: AT }) as unknown as ShapeNote;
    const r = rig(undefined, { notes: [ask('shn_q1', 'whistle', 'Who boils it?'), ask('shn_q2', 'lid', 'Why red?')] });
    await laidOut(async () => {
      await mount(r.host);
      r.emit({ type: 'note', note: answer('shn_a1', 'whistle', 'shn_q1', 'The agent boils it.') });
      r.emit({ type: 'note', note: answer('shn_a2', 'lid', 'shn_q2', 'It shows heat.') });
      const pill = () => document.querySelector('[data-shape-answer-ready]');
      await until(() => !!pill(), 'the pill');
      const bubbleOn = (part: string) => inDrawingAll<HTMLButtonElement>('[data-shp-talk-bubble]').find((b) => b.getAttribute('data-shp-talk-bubble')!.endsWith(part))!;
      // One of two opened: the other is still unread, so the pill stays.
      await click(bubbleOn('whistle'));
      await until(() => !!talk()?.textContent?.includes('The agent boils it.'), "the whistle's box");
      await wait();
      expect(pill()).not.toBeNull();
      await closeBox();
      // The last opened: nothing is left unread, so the pill goes.
      await click(bubbleOn('lid'));
      await until(() => !!talk()?.textContent?.includes('It shows heat.'), "the lid's box");
      await wait();
      expect(pill()).toBeNull();
    });
  });

  test('with the box tool on, a press that travels from a comment bubble draws no box', async () => {
    const r = rig(undefined, { notes: finishedNotes() });
    await laidOut(async () => {
      await mount(r.host, { boxSelect: {} });
      await click(document.querySelector('.shp-tstrip button[aria-label="Comment"]')!);
      await wait();
      const press = (el: EventTarget, type: string, x: number) =>
        el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, composed: true, button: 0, clientX: x, clientY: 10 }), { pointerType: 'mouse', pointerId: 1 }));
      const dragFrom = (el: EventTarget) => act(async () => {
        press(el, 'pointerdown', 10);
        press(window, 'pointermove', 90);
      });
      const band = () => document.querySelector('.shp-box-band');
      await dragFrom(inDrawing('[data-shp-talk-bubble]')!);
      expect(band()).toBeNull();
      press(window, 'pointerup', 90);
      // From the board itself it does.
      await dragFrom(document.querySelector('.shp-stage')!);
      expect(band()).not.toBeNull();
      // Ended: the drag eats the click that follows it for 60 ms; let that pass before the next test clicks.
      press(window, 'pointerup', 90);
      await act(() => new Promise((done) => setTimeout(done, 80)));
    });
  });

  test("a Change it says where it stands in the part's box", async () => {
    const r = rig();
    await mount(r.host);
    await pick('lid');
    await type('Make it red');
    await click(button(popover()!, 'Change it')!);
    await until(() => !popover(), 'the box closed');
    await wait();
    await pick('lid');
    expect(talk()!.textContent).toContain('Change: Make it red');
    expect(talk()!.textContent).toContain('Sent to Claude Code');
  });
  test('a finished board: Global comment and a part\'s comment bubble open what was asked to read, with no words to type', async () => {
    const { host } = rig({ state: 'gone', agent: 'Claude Code' }, { notes: finishedNotes(), finished: true });
    await laidOut(() => mount(host));
    const readBox = () => document.querySelector<HTMLElement>('[data-shape-talkbox]');
    const noWords = (box: HTMLElement) => {
      expect(box.querySelector('textarea')).toBeNull();
      for (const gone of ['Ask', 'Change it', 'Show me']) expect(button(box, gone)).toBeNull();
    };
    // Global comment: every question and change, with its answer.
    const general = document.querySelector<HTMLButtonElement>('.shp-general')!;
    expect(general.disabled).toBe(false);
    await click(general);
    await until(() => !!readBox(), 'the whole board to read');
    expect(readBox()!.textContent).toContain('Why one whistle?');
    expect(readBox()!.textContent).toContain('Because the lid holds the steam.');
    expect(readBox()!.textContent).toContain('Change: Make it red');
    noWords(readBox()!);
    // Esc closes it, and only it; the focus goes back to Global comment.
    await esc();
    await until(() => !readBox(), 'the box closed');
    expect(document.querySelector('.shp-root')).not.toBeNull();
    expect(document.activeElement).toBe(general);
    // The part asked about has a bubble; it opens the part's own talk, to read.
    const bubble = inDrawing<HTMLButtonElement>('[data-shp-talk-bubble]')!;
    expect(bubble.getAttribute('aria-label')).toBe('Comments on Shape · “One whistle”');
    await click(bubble);
    await until(() => !!readBox(), "the part's box");
    expect(readBox()!.textContent).toContain('Because the lid holds the steam.');
    expect(readBox()!.textContent).not.toContain('Make it red');
    noWords(readBox()!);
    await click(readBox()!.querySelector('button[aria-label="Close"]')!);
    expect(readBox()).toBeNull();
    expect(inDrawing('[data-shp-talk-bubble]')).toBe(bubble);
  });

  test("a finished board's parts keep their own click: a part with code opens its code, and nothing points", async () => {
    const opened: string[] = [];
    const { host } = rig({ state: 'gone', agent: 'Claude Code' }, { notes: finishedNotes(), finished: true });
    await laidOut(() => mount(host, { onCode: (at) => (opened.push(`${at.path}:${at.line}`), true) }));
    expect(inDrawing('.board')!.classList.contains('pinpointing')).toBe(false);
    await click(inDrawing('[data-mark="lid"]')!);
    expect(opened).toEqual(['src/lid.ts:3']);
    // The part that was asked about does not open its talk on a plain click: its bubble does.
    await click(inDrawing('[data-mark="whistle"]')!);
    await wait();
    expect(document.querySelector('[data-shape-talkbox]')).toBeNull();
  });

  test('a comment bubble: after an Ask and a Change it, from the stored talk again, at a box over no part, with a dot for a new answer', async () => {
    const r = rig();
    await laidOut(async () => {
      await mount(r.host);
      expect(inDrawing('[data-shp-talk-bubble]')).toBeNull();
      await pick('whistle');
      await type('Why one whistle?');
      await click(button(popover()!, 'Ask')!);
      await until(() => r.asked.length === 1, 'the ask');
      await until(() => !!inDrawing('[data-shp-talk-bubble]'), 'the bubble after an Ask');
      r.release(null);
      await wait();
      await closeBox();
      await pick('lid');
      await type('Make it red');
      await click(button(popover()!, 'Change it')!);
      await until(() => inDrawingAll('[data-shp-talk-bubble]').length === 2, 'a bubble after a Change it too');
      // A later answer: its part's bubble gets a dot, and says so.
      r.emit({ type: 'note', note: { id: 'shn_answer', kind: 'answer', v: 1, view: 'picture', part: 'whistle', quote: null, text: 'The agent boils it.', from: 'agent', re: 'shn_1', delivered: null, at: AT } as unknown as ShapeNote });
      const whistle = () => inDrawingAll<HTMLButtonElement>('[data-shp-talk-bubble]').find((b) => b.getAttribute('data-shp-talk-bubble')!.endsWith('whistle'))!;
      await until(() => !!whistle()?.querySelector('[data-dot]'), 'the dot');
      expect(whistle().getAttribute('aria-label')).toContain('new answer');
      // Opened: the part's comment box (the board is not finished), with the answer; the dot goes.
      await click(whistle());
      await until(() => !!talk()?.textContent?.includes('The agent boils it.'), "the part's box from its bubble");
      expect(box()).not.toBeNull();
      await wait();
      expect(whistle().querySelector('[data-dot]')).toBeNull();
      // Closed, the focus is back on the bubble it was opened from.
      let focused = 0;
      whistle().addEventListener('focus', () => focused++);
      await closeBox();
      expect(focused).toBe(1);
    });
    act(() => root?.unmount());
    document.body.innerHTML = '';
    // Again from what the board stores: a part's bubble, and a box over no part's at the box's corner.
    const boxNote = { id: 'shn_box', kind: 'ask', v: 1, view: 'picture', part: null, quote: null, text: 'What is this gap?', from: 'you', re: null, delivered: null, at: AT, box: { x: 0.5, y: 0.5, w: 0.2, h: 0.1 } } as unknown as ShapeNote;
    const again = rig(undefined, { notes: [...finishedNotes(), boxNote] });
    await laidOut(() => mount(again.host));
    const keys = inDrawingAll('[data-shp-talk-bubble]').map((b) => b.getAttribute('data-shp-talk-bubble'));
    expect(keys).toEqual(['p:picture\u0000whistle', 'b:picture|0.5,0.5,0.2,0.1']);
    // The box's bubble opens its own question to read.
    await click(inDrawingAll('[data-shp-talk-bubble]')[1]!);
    await until(() => !!document.querySelector('[data-shape-talkbox]'), "the box's talk");
    expect(document.querySelector('[data-shape-talkbox]')!.textContent).toContain('What is this gap?');
    expect(document.querySelector('[data-shape-talkbox]')!.textContent).not.toContain('Why one whistle?');
  });

  test('one Esc closes one thing: with References open, the Global comment read box first, then the panel', async () => {
    const { host } = rig({ state: 'gone', agent: 'Claude Code' }, { notes: finishedNotes(), finished: true });
    await mount(host);
    await click(document.querySelector('.shp-dock button[title="References"]')!);
    expect(document.querySelector('.shp-sidep.open')).not.toBeNull();
    await click(document.querySelector('.shp-general')!);
    await until(() => !!document.querySelector('[data-shape-talkbox]'), 'the read box');
    await esc();
    expect(document.querySelector('[data-shape-talkbox]')).toBeNull();
    expect(document.querySelector('.shp-sidep.open')).not.toBeNull();
    await esc();
    expect(document.querySelector('.shp-sidep.open')).toBeNull();
  });

  test('a finished board with nothing asked: Global comment stays off', async () => {
    const { host } = rig({ state: 'gone', agent: 'Claude Code' }, { notes: [], finished: true });
    await mount(host);
    expect(document.querySelector<HTMLButtonElement>('.shp-general')!.disabled).toBe(true);
  });

  test('References opens beside the board while the dock fits left of it, else as a sheet under a dock kept on top', async () => {
    const widths = (board: number, dock: number) => {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => board });
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return (this as HTMLElement).classList.contains('shp-dock') ? dock : 0; } });
    };
    try {
      // 1400 wide, a 400 px dock: room beside the 434 px panel.
      widths(1400, 400);
      const { host } = rig();
      await mount(host);
      await click(document.querySelector('.shp-dock button[title="References"]')!);
      expect(document.querySelector('.shp-sidep.open')!.classList.contains('sheet')).toBe(false);
      expect(document.querySelector('.shp-root')!.classList.contains('panel-sheet')).toBe(false);
      act(() => root?.unmount());
      document.body.innerHTML = '';
      // 760 wide (no phone): 760 - 360 - 12 leaves 388, less than the dock and its edges: a sheet.
      widths(760, 400);
      await mount(rig().host);
      await click(document.querySelector('.shp-dock button[title="References"]')!);
      const panel = document.querySelector<HTMLElement>('.shp-sidep.open')!;
      expect(panel.classList.contains('sheet')).toBe(true);
      expect(document.querySelector('.shp-root')!.classList.contains('panel-sheet')).toBe(true);
      expect(document.querySelector('.shp-root')!.classList.contains('phone')).toBe(false);
      // The dock stays in reach over the sheet: its References button closes it.
      await click(document.querySelector('.shp-dock button[title="References"]')!);
      expect(document.querySelector('.shp-sidep.open')).toBeNull();
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
    }
  });

  test("a part's box stays inside the board's own box, not only the window", async () => {
    const r = rig();
    await mount(r.host);
    // The board's surface in a pane from x 400 to 1000 (beside References it ends left of the panel); the part at its left edge.
    const board = document.querySelector<HTMLElement>('.shp-surface')!;
    board.getBoundingClientRect = () => ({ left: 400, top: 0, right: 1000, bottom: 760, width: 600, height: 760, x: 400, y: 0, toJSON: () => ({}) }) as DOMRect;
    const part = inDrawing<HTMLElement>('[data-mark="whistle"]')!;
    part.getBoundingClientRect = () => ({ left: 410, top: 100, right: 430, bottom: 120, width: 20, height: 20, x: 410, y: 100, toJSON: () => ({}) }) as DOMRect;
    await pick('whistle');
    await wait();
    const left = parseFloat(popover()!.style.left);
    // Centred on the part it would start at 228, over the list beside the pane; it starts at the board's edge.
    expect(left).toBeGreaterThanOrEqual(408);
    expect(left + parseFloat(popover()!.style.width)).toBeLessThanOrEqual(992);
  });

  test('an Ask from a box over no part answers in that box', () => {
    const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
    const mine = boxKey('picture', box);
    const entries = [
      { id: 'a', label: 'Shape', words: 'Here?', change: false, answer: 'Yes.', streaming: false, view: 'picture', part: null, box: mine },
      { id: 'b', label: 'Shape', words: 'There?', change: false, answer: '', streaming: false, view: 'picture', part: null, box: boxKey('picture', { ...box, x: 0.5 }) },
      { id: 'c', label: 'The whole board', words: 'All?', change: false, answer: '', streaming: false, view: null, part: null, box: null },
    ];
    expect(talkOn(entries, { view: 'picture', part: null, box: mine }).map((e) => e.id)).toEqual(['a']);
    expect(talkOn(entries, null).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(talkOn(entries, { view: 'picture', part: null, box: null })).toEqual([]);
  });
});
