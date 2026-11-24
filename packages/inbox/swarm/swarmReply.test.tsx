/**
 * The Swarm badge in a thread's reply box (swarm/SwarmReplyBadge.tsx). What this catches: a press that does not put
 * `/swarm` in the reply's words, or does not take it out; typed `/swarm` that does not light the badge; a badge that
 * stays in a thread that is a swarm already (where it would only say what the thread line says).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createReplyText, type ReplyText } from '../replyText';

const hasDom = typeof document !== 'undefined';
const { SwarmReplyBadge } =(hasDom ? await import('./SwarmReplyBadge') : {}) as typeof import('./SwarmReplyBadge');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(text: ReplyText, swarmOn = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    // As the thread pane does: a change goes through the reply's own change (`changeReply`), which sets the store.
    root.render(<SwarmReplyBadge text={text} onChange={(words) => text.set(words)} swarmOn={swarmOn} />);
  });
  return host;
}

const badge = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-swarm-badge]');

test.skipIf(!hasDom)('a press puts /swarm in the reply, another takes it out; typing it lights the badge', () => {
  const text = createReplyText('Bring in help for the refunds.');
  const el = render(text);
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('false');
  act(() => badge(el)!.click());
  expect(text.get()).toBe('Bring in help for the refunds. /swarm ');
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('true');
  act(() => badge(el)!.click());
  expect(text.get().trim()).toBe('Bring in help for the refunds.');
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('false');
  act(() => text.set('/swarm the refunds'));
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('true');
});

test.skipIf(!hasDom)('in a thread that is a swarm already the badge shows only while the words carry /swarm', () => {
  const text = createReplyText('Carry on.');
  const el = render(text, true);
  expect(badge(el)).toBeNull();
  act(() => text.set('Carry on. /swarm'));
  expect(badge(el)?.getAttribute('aria-pressed')).toBe('true');
});
