/**
 * The Mark read / Archive toast on a phone: one line and Undo, never the
 * desktop's sentence, its second line and Reply (on an iPhone those wrapped
 * to 171 px over the reply foot). The desktop toast is unchanged.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { markReadToast } from './markRead';

const hasDom = typeof document !== 'undefined';
const { InboxToast } = (hasDom ? await import('./components/Toast') : {}) as typeof import('./components/Toast');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(phone: boolean, onUndo: () => void, onReply: () => void): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // An agent stopped on the thread: the desktop warns and offers Reply.
  const copy = markReadToast({ subject: 'Stripe 409 on the retry worker', author: { name: 'Claude Code', host: 'claude-code' } as never, questions: { open: 1, picked: 0, stopped: 1, holds_up: [], prompt: null } as never }, 1);
  act(() => root!.render(<InboxToast toast={{ id: 1, ...copy, onUndo, onReply }} onDismiss={() => {}} phone={phone} />));
  return host.querySelector('[data-inbox-toast]') as HTMLElement;
}

test.skipIf(!hasDom)('a phone: the short line and Undo, which undoes', () => {
  let undone = 0;
  const toast = render(true, () => undone++, () => {});
  expect(toast.querySelector('.ib-tline')?.textContent).toBe('Read. Moved to Quiet.');
  expect(toast.querySelector('small')).toBeNull();
  const buttons = [...toast.querySelectorAll('button')].map((b) => b.textContent?.trim());
  expect(buttons).toEqual(['Undo']);
  act(() => (toast.querySelector('[data-toast-undo]') as HTMLButtonElement).click());
  expect(undone).toBe(1);
});

test.skipIf(!hasDom)('a desktop window: the sentence, its details, Reply, Undo and the close', () => {
  const toast = render(false, () => {}, () => {});
  expect(toast.querySelector('.ib-tline')).toBeNull();
  expect(toast.querySelector('.ib-tmsg span')?.textContent).toContain('moved to Quiet');
  expect(toast.querySelector('small')?.textContent).toContain('was stopped on it');
  expect(toast.querySelector('[data-toast-reply]')).not.toBeNull();
  expect(toast.querySelector('[data-toast-undo]')).not.toBeNull();
  expect(toast.querySelector('[aria-label="Dismiss"]')).not.toBeNull();
});
