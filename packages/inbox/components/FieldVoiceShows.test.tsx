/**
 * When a field's mic shows (FieldVoice.tsx): the Other answers in question cards and Decision mode, and a guided
 * review's line comment, all draw this one.
 *
 * What regresses: a mic at rest beside every field; no mic when the person is in the field; the mic outside the field's
 * box, or before the field (Tab would not reach it right after); the mic gone while its take still runs; the mic left
 * behind once focus has gone and nothing runs; Tab from the field to the mic hiding the mic under the move; a press
 * moving focus off the field (a phone's keyboard would close); room for the mic missing, so the words would run under it;
 * any of it with voice off.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { FieldVoice } = (hasDom ? await import('./FieldVoice') : {}) as typeof import('./FieldVoice');
const { adoptVoiceSettings, browserDeps } = (hasDom ? await import('../voice') : {}) as typeof import('../voice');

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const restore: Array<() => void> = [];

beforeEach(() => {
  if (!hasDom) return;
  const had = { ...browserDeps };
  // The microphone never finishes opening: a take that runs until it is cancelled.
  Object.assign(browserDeps, { open: () => new Promise(() => {}), prompts: async () => false });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).includes('/voice/status') ? Response.json({ state: 'ready', plan: null }) : Response.json({})) as typeof fetch;
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({}) } });
  const hadWorklet = (globalThis as Record<string, unknown>).AudioWorkletNode;
  (globalThis as Record<string, unknown>).AudioWorkletNode = class {};
  restore.push(() => {
    Object.assign(browserDeps, had);
    globalThis.fetch = savedFetch;
    (globalThis as Record<string, unknown>).AudioWorkletNode = hadWorklet;
    for (const [owner, name] of [[window, 'isSecureContext'], [navigator, 'mediaDevices']] as const) delete (owner as unknown as Record<string, unknown>)[name];
    adoptVoiceSettings(null);
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  while (restore.length > 0) restore.pop()!();
});

const voiceOn = (on: boolean) => adoptVoiceSettings({ on, phones_only: false, engine: 'codex', key: { source: null, last4: null }, computer: null, intro_due: false });

/** A host as the question card and the review toolbar draw one: the field, then its tools, in one positioned box. */
function Host() {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div>
      <div className="relative" data-test-box="">
        <textarea ref={ref} aria-label="Other answer" />
        <FieldVoice textareaRef={ref} />
      </div>
      <button type="button" data-test-next="">
        Next
      </button>
    </div>
  );
}

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Host />));
  return {
    field: host.querySelector('textarea')!,
    next: host.querySelector<HTMLButtonElement>('[data-test-next]')!,
    mic: () => host!.querySelector<HTMLButtonElement>('[data-voice-mic]'),
  };
}

const focus = (el: HTMLElement) => act(async () => el.focus());
/** Focus leaving `from` for `to`, as the browser reports it (the event names where it goes). */
const move = (from: HTMLElement, to: HTMLElement | null) =>
  act(async () => {
    from.dispatchEvent(new FocusEvent('blur', { relatedTarget: to }));
    from.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: to }));
    if (to) {
      to.dispatchEvent(new FocusEvent('focus', { relatedTarget: from }));
      to.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: from }));
    }
  });

test.skipIf(!hasDom)('at rest no mic is drawn, and the field keeps the room one takes', async () => {
  voiceOn(true);
  const { field, mic } = await mount();
  expect(mic()).toBeNull();
  expect(field.hasAttribute('data-field-voice-room')).toBe(true);
});

test.skipIf(!hasDom)('in the field the mic shows inside its box, right after it, as a named button; it goes when focus leaves', async () => {
  voiceOn(true);
  const { field, next, mic } = await mount();
  await focus(field);
  const button = mic();
  expect(button).not.toBeNull();
  expect(button!.tagName).toBe('BUTTON');
  expect(button!.getAttribute('aria-label')).toBe('Dictate: hold to talk, or tap');
  expect(button!.closest('[data-test-box]')).toBe(field.parentElement);
  expect(field.compareDocumentPosition(button!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(button!.closest('[data-field-voice-mic]')!.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await move(field, next);
  expect(mic()).toBeNull();
});

test.skipIf(!hasDom)('Tab from the field to the mic keeps the mic; leaving the mic for elsewhere hides it', async () => {
  voiceOn(true);
  const { field, next, mic } = await mount();
  await focus(field);
  await move(field, mic()!);
  expect(mic()).not.toBeNull();
  await move(mic()!, field);
  expect(mic()).not.toBeNull();
  await move(field, mic()!);
  await move(mic()!, next);
  expect(mic()).toBeNull();
});

test.skipIf(!hasDom)('a press keeps the field’s focus; the mic stays while its take runs, focus gone, and goes once it ends', async () => {
  voiceOn(true);
  const { field, next, mic } = await mount();
  await focus(field);
  const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 });
  const mouse = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    mic()!.dispatchEvent(down);
    mic()!.dispatchEvent(mouse);
  });
  expect(down.defaultPrevented).toBe(true);
  expect(mouse.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(field);
  await act(async () => void mic()!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1 })));
  expect(mic()!.getAttribute('data-state')).toBe('live');
  await move(field, next);
  expect(mic()).not.toBeNull();
  await act(async () => (host!.querySelector<HTMLButtonElement>('[data-voice-cancel]') ?? mic()!).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(mic()).toBeNull();
});

test.skipIf(!hasDom)('with voice off nothing shows in the field and no room is kept', async () => {
  voiceOn(false);
  const { field, mic } = await mount();
  await focus(field);
  expect(mic()).toBeNull();
  expect(field.hasAttribute('data-field-voice-room')).toBe(false);
});
