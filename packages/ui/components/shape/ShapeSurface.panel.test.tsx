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

const hasDom = typeof document !== 'undefined';
const { ShapeSurface } = (hasDom ? await import('./ShapeSurface') : {}) as typeof import('./ShapeSurface');

const ID = 'shp_panel_test';
const AT = '2026-11-16T10:00:00.000Z';
const PICTURE = { html: '<p data-mark="whistle">One whistle</p><p data-mark="lid">The lid</p><span data-ref="1"></span>' };
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

function rig(session: ShapeLoaded['session'] = { state: 'live', agent: 'Claude Code' }): Rig {
  const board: ShapeBoard = { title: 'Kettle', claim: 'Built.', views: { picture: PICTURE, how: HOW }, refs: REFS };
  const data: ShapeLoaded = {
    shape: { v: 1, id: ID, title: 'Kettle', project: { name: 'app', root: '/work/app' }, session: null, thread: null, state: 'active', created: AT, updated: AT, latest: 1, drawing: null },
    version: { ...board, n: 1, at: AT, base: null, through: null, by: null, parts: shapeParts(board) },
    seen: 1,
    notes: [],
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
});
