/**
 * The message box: controlled, sends on Enter, and keeps its Enter to itself,
 * so a page's own Mod+Enter cannot fire from inside it.
 * Requires DOM (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatComposerProps } from './ChatComposer';

const hasDom = typeof document !== 'undefined';
const composerModule = hasDom ? await import('./ChatComposer') : null;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

function composer(props: Partial<ChatComposerProps> = {}) {
  const { ChatComposer } = composerModule!;
  render(<ChatComposer value="hello" onChange={() => {}} onSend={() => {}} {...props} />);
}

const field = () => document.querySelector('textarea')!;
const button = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

function keyDown(init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    field().dispatchEvent(event);
  });
  return event;
}

function type(text: string) {
  const el = field();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Everything a page could hear above the box, in the bubble phase. */
function listenAbove() {
  const heard: string[] = [];
  const onWindow = () => heard.push('window');
  const onDocument = () => heard.push('document');
  window.addEventListener('keydown', onWindow);
  document.addEventListener('keydown', onDocument);
  cleanups.push(() => {
    window.removeEventListener('keydown', onWindow);
    document.removeEventListener('keydown', onDocument);
  });
  return heard;
}

describe.if(hasDom)('the submit key stays in the box', () => {
  test.each([
    ['Mod+Enter on a Mac', { metaKey: true }],
    ['Mod+Enter elsewhere', { ctrlKey: true }],
    ['plain Enter', {}],
  ])('%s sends once and never reaches the page', (_name, chord) => {
    let sent = 0;
    composer({ onSend: () => (sent += 1) });
    const heard = listenAbove();
    const event = keyDown({ key: 'Enter', ...chord });
    expect(sent).toBe(1);
    expect(heard).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  test('Shift+Mod+Enter neither sends nor reaches the page', () => {
    let sent = 0;
    composer({ onSend: () => (sent += 1) });
    const heard = listenAbove();
    keyDown({ key: 'Enter', metaKey: true, shiftKey: true });
    expect(sent).toBe(0);
    expect(heard).toEqual([]);
  });

  test('Shift+Enter is a new line: it does not send and the field keeps it', () => {
    let sent = 0;
    composer({ onSend: () => (sent += 1) });
    const heard = listenAbove();
    const event = keyDown({ key: 'Enter', shiftKey: true });
    expect(sent).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    expect(heard).toEqual([]);
  });

  test('Enter that confirms an IME composition does not send and stays in the box', () => {
    let sent = 0;
    composer({ onSend: () => (sent += 1) });
    const heard = listenAbove();
    keyDown({ key: 'Enter', isComposing: true });
    expect(sent).toBe(0);
    expect(heard).toEqual([]);
  });

  test('other keys are the page\'s, so Escape can still reach it', () => {
    composer();
    const heard = listenAbove();
    keyDown({ key: 'Escape' });
    expect(heard).toEqual(['document', 'window']);
  });

  test('a host that prevents Enter keeps it from sending', () => {
    let sent = 0;
    composer({
      onSend: () => (sent += 1),
      onKeyDown: (event) => event.preventDefault(),
    });
    keyDown({ key: 'Enter' });
    expect(sent).toBe(0);
  });
});

describe.if(hasDom)('a controlled composer', () => {
  test('shows the value it is given and reports typing without changing itself', () => {
    const typed: string[] = [];
    composer({ value: 'fixed', onChange: (next) => typed.push(next) });
    type('fixed!');
    expect(typed).toEqual(['fixed!']);
    expect(field().value).toBe('fixed');
  });

  test('a host holding the value drives the field, and can clear it after Send', () => {
    const { ChatComposer } = composerModule!;
    function Host() {
      const [value, setValue] = useState('');
      return <ChatComposer value={value} onChange={setValue} onSend={() => setValue('')} />;
    }
    render(<Host />);
    type('hello');
    expect(field().value).toBe('hello');
    keyDown({ key: 'Enter' });
    expect(field().value).toBe('');
  });
});

describe.if(hasDom)('slots and states', () => {
  test('the context line sits under the box, above the Send row', () => {
    composer({ below: <span data-context>docs/plan.md</span>, toolbar: <span data-tool /> });
    const context = document.querySelector('[data-context]')!;
    const row = document.querySelector('[data-chat-composer-toolbar]')!;
    expect(field().compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(context.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.querySelector('[data-tool]')).not.toBeNull();
  });

  test('no picker of its own: an @ is plain text and the field makes no menu promise', () => {
    const typed: string[] = [];
    composer({ value: '', onChange: (next) => typed.push(next) });
    type('@someone');
    expect(typed).toEqual(['@someone']);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(field().hasAttribute('aria-autocomplete')).toBe(false);
    expect(field().hasAttribute('aria-expanded')).toBe(false);
  });

  test('busy swaps Send for Stop', () => {
    let stopped = 0;
    composer({ busy: true, onStop: () => (stopped += 1) });
    expect(button('Send')).toBeNull();
    act(() => button('Stop')!.click());
    expect(stopped).toBe(1);
  });

  test('the Send button sends', () => {
    let sent = 0;
    composer({ onSend: () => (sent += 1) });
    act(() => button('Send')!.click());
    expect(sent).toBe(1);
  });

  test('pasted files go to the host when it takes them, and stay the browser\'s when not', () => {
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    const paste = () => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { files: [file], getData: () => '' },
      });
      act(() => {
        field().dispatchEvent(event);
      });
      return event;
    };
    composer();
    expect(paste().defaultPrevented).toBe(false);
    act(() => root!.unmount());
    host!.remove();

    const got: (readonly File[])[] = [];
    composer({ onFiles: (files) => got.push(files) });
    expect(paste().defaultPrevented).toBe(true);
    expect(got).toEqual([[file]]);
  });
});
