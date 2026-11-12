import { afterEach, describe, expect, test } from 'bun:test';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { cleanWindowRecord, INBOX_DEBUG_ON_HEADER } from '../shared/inbox/debug-log';
import { learnDebugLog } from './debugLog';
import { VOICE_MISS_GAP_MS, watchVoiceMisses } from './voiceMiss';
import { voicePressProps, type VoicePoint } from './voicePress';
import type { VoicePhase, VoiceView } from './voiceSession';

const hasDom = typeof document !== 'undefined';
const BUFFER = 'plannotator-inbox-debug-buffer';

type Rec = Record<string, unknown>;
const stored = (): Rec[] => JSON.parse(window.localStorage.getItem(BUFFER) ?? '[]') as Rec[];
const misses = () => stored().filter((r) => r.ev === 'voice_miss');
const settle = () => new Promise((done) => setTimeout(done, 350));

const debugOn = () => learnDebugLog(new Response('{}', { status: 200, headers: { [INBOX_DEBUG_ON_HEADER]: '1' } }));
const debugOff = () => learnDebugLog(new Response('{}', { status: 200 }));

const restore: (() => void)[] = [];
afterEach(() => {
  debugOff();
  for (const undo of restore.splice(0).reverse()) undo();
});

function setup() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
  const button = document.createElement('button');
  button.className = 'ib-vmic';
  button.getBoundingClientRect = () => ({ left: 100, top: 100, right: 136, bottom: 136, width: 36, height: 36, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect;
  const other = document.createElement('div');
  const send = document.createElement('button');
  send.append(document.createElement('span'));
  document.body.append(button, other, send);
  restore.push(() => {
    globalThis.fetch = realFetch;
    button.remove();
    other.remove();
    send.remove();
    window.localStorage.removeItem(BUFFER);
  });
  let phase: VoicePhase = 'listening';
  let mode: VoiceView['mode'] = 'tap';
  const rects: number[] = [];
  const realRect = button.getBoundingClientRect;
  button.getBoundingClientRect = () => {
    rects.push(1);
    return realRect.call(button);
  };
  let clock = 1_000;
  const tap = (x: number, y: number, on: Element = other) => on.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true }));
  return {
    button,
    send,
    tap,
    rectReads: () => rects.length,
    setPhase: (next: VoicePhase) => void (phase = next),
    setMode: (next: VoiceView['mode']) => void (mode = next),
    tick: (ms: number) => void (clock += ms),
    watch: () => {
      const stop = watchVoiceMisses(button, () => ({ phase, mode }), () => clock);
      restore.push(stop);
      return stop;
    },
  };
}

describe.skipIf(!hasDom)('voice_miss in the debug log', () => {
  test('a near miss of a live mic is one line: distance, side, phase, mode and size, and the filter keeps all of it', async () => {
    const mic = setup();
    debugOn();
    mic.watch();
    mic.tap(118, 146);
    await settle();
    const lines = misses();
    expect(lines).toHaveLength(1);
    const { t: _t, page: _page, seq: _seq, ev: _ev, ...fields } = lines[0]!;
    expect(fields).toEqual({ px: 10, edge: 'below', phase: 'listening', mode: 'tap', w: 36, h: 36, other: false });
    expect(cleanWindowRecord(lines[0])).toEqual({ side: 'window', ...lines[0] });
  });

  test('a far tap, a tap on the mic itself and a tap while the mic is not live leave no line', async () => {
    const mic = setup();
    debugOn();
    mic.watch();
    mic.tap(118, 170);
    mic.tick(VOICE_MISS_GAP_MS);
    mic.tap(118, 118, mic.button);
    mic.tick(VOICE_MISS_GAP_MS);
    mic.setPhase('sending');
    mic.tap(118, 146);
    mic.tick(VOICE_MISS_GAP_MS);
    mic.setPhase('opening');
    mic.tap(90, 118);
    await settle();
    expect(misses().map((r) => [r.edge, r.px, r.phase])).toEqual([['left', 10, 'opening']]);
  });

  test('a tap on a neighbouring control is still logged, marked other; a second finger during a hold says hold', async () => {
    const mic = setup();
    debugOn();
    mic.watch();
    mic.tap(142, 118, mic.send.firstElementChild!);
    mic.tick(VOICE_MISS_GAP_MS);
    mic.setMode('hold');
    mic.tap(118, 150);
    mic.tick(VOICE_MISS_GAP_MS);
    mic.setPhase('opening');
    mic.setMode(null);
    mic.tap(118, 92);
    await settle();
    expect(misses().map((r) => [r.edge, r.px, r.mode, r.other])).toEqual([
      ['right', 6, 'tap', true],
      ['below', 14, 'hold', false],
      ['above', 8, undefined, false],
    ]);
    for (const line of misses()) expect(cleanWindowRecord(line)).toMatchObject({ other: line.other });
  });

  test("the phone's ::after (inset -4px) is part of the mic: 3px past the rect is a hit, 6px past is a 2px miss", async () => {
    const mic = setup();
    const realStyle = window.getComputedStyle;
    window.getComputedStyle = ((element: Element, pseudo?: string | null) =>
      pseudo === '::after' ? ({ content: '""', position: 'absolute', top: '-4px', right: '-4px', bottom: '-4px', left: '-4px' } as CSSStyleDeclaration) : realStyle(element, pseudo)) as typeof window.getComputedStyle;
    restore.push(() => void (window.getComputedStyle = realStyle));
    debugOn();
    mic.watch();
    mic.tap(118, 97);
    mic.tick(VOICE_MISS_GAP_MS);
    mic.tap(118, 94);
    await settle();
    expect(misses().map((r) => [r.edge, r.px, r.w])).toEqual([['above', 2, 36]]);
  });

  test('off: no listener is added, and a near miss leaves nothing stored', async () => {
    const mic = setup();
    debugOff();
    const added: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: [EventListenerOrEventListenerObject, (boolean | AddEventListenerOptions)?]) => {
      added.push(type);
      realAdd(type, ...rest);
    }) as typeof document.addEventListener;
    restore.push(() => void (document.addEventListener = realAdd));
    mic.watch();
    mic.tap(118, 146);
    await settle();
    expect(added).not.toContain('pointerdown');
    expect(mic.rectReads()).toBe(0);
    expect(window.localStorage.getItem(BUFFER)).toBeNull();
  });

  test('debug turned off mid-take: the listener goes with it', async () => {
    const mic = setup();
    debugOn();
    mic.watch();
    debugOff();
    debugOn();
    mic.tap(118, 146);
    await settle();
    expect(misses()).toEqual([]);
  });

  test('at most one line per 300 ms', async () => {
    const mic = setup();
    debugOn();
    mic.watch();
    mic.tap(118, 146);
    mic.tick(100);
    mic.tap(118, 148);
    mic.tick(VOICE_MISS_GAP_MS - 101);
    mic.tap(118, 150);
    mic.tick(1);
    mic.tap(140, 118);
    await settle();
    expect(misses().map((r) => [r.edge, r.px])).toEqual([
      ['below', 10],
      ['right', 4],
    ]);
  });
});

describe.skipIf(!hasDom)('voice_press offset', () => {
  const pointer = (button: Element, x: number, y: number) =>
    ({ button: 0, clientX: x, clientY: y, pointerId: 1, currentTarget: button, preventDefault: () => {} }) as unknown as ReactPointerEvent<HTMLButtonElement>;

  test('on: a press and its release carry the point\'s offset from the centre; off: no layout is read; lost: no point', () => {
    const mic = setup();
    const seen: (VoicePoint | undefined)[] = [];
    const props = voicePressProps({ press: (at) => seen.push(at), release: (at) => seen.push(at), lost: () => seen.push(undefined), toggle: () => {} });
    debugOff();
    props.onPointerDown(pointer(mic.button, 130, 110));
    props.onPointerUp(pointer(mic.button, 130, 110));
    expect(mic.rectReads()).toBe(0);
    debugOn();
    props.onPointerDown(pointer(mic.button, 130, 110));
    props.onPointerUp(pointer(mic.button, 112.4, 141));
    props.onPointerCancel();
    expect(seen).toEqual([undefined, undefined, { dx: 12, dy: -8 }, { dx: -6, dy: 23 }, undefined]);
    expect(cleanWindowRecord({ t: 1, ev: 'voice_press', input: 'press', phase: 'listening', mode: 'tap', dx: 12, dy: -8 })).toMatchObject({ dx: 12, dy: -8 });
  });
});
