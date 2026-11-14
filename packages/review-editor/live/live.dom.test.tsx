import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessage } from '@plannotator/core/inbox-types';
import { LiveComposer } from './LiveComposer';
import { LiveThreadCard } from './LiveThreadCard';
import { placeThreads, type LiveAgent } from './model';
import type { LiveReviewActions } from './useLiveReview';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
}

async function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

const PI: LiveAgent = { host: 'pi', session: 'ses-pi', label: null, busy: false, project: 'billing', here: true };
const CC: LiveAgent = { host: 'claude-code', session: 'ses-cc', label: 'auth fix', busy: false, project: 'billing', here: true };

const at = '2026-11-14T05:00:00.000Z';
const message = (over: Partial<InboxMessage>): InboxMessage =>
  ({ id: 'm', project_id: 'p', thread_id: 'root', reply_to: null, author: { kind: 'person' }, subject: null, body: '', created_at: at, resolved_at: null, idempotency_key: null, ...over }) as InboxMessage;

const anchor = { file: 'src/billing.ts', side: 'new' as const, line_start: 4, line_end: 4, code: ['  if (amount < 0) throw new Error();'], context_before: ['export function charge(amount) {'], context_after: ['  return charge(amount);'] };

function actionsRef(over: Partial<LiveReviewActions> = {}) {
  return {
    current: { agents: [PI, CC], defaultTo: CC, loadAgents: () => {}, reply: mock(async () => {}), resolve: mock(async () => {}), sendComments: mock(async () => {}), reveal: () => {}, revealLines: () => {}, error: null, ...over },
  } as React.MutableRefObject<LiveReviewActions>;
}

describe.skipIf(!hasDom)('the review thread composer', () => {
  test('@ picks a connected agent and the send carries it as a tag', async () => {
    const onSend = mock(async (_words: string, _tags: unknown[]) => {});
    const el = await render(<LiveComposer agents={[PI, CC]} placeholder="Reply" sendLabel="Reply" onSend={onSend} />);
    const box = el.querySelector('textarea')!;
    await type(box, 'Can you check this @');
    await press(box, 'ArrowDown');
    await press(box, 'Enter');
    expect(box.value).toBe('Can you check this @Pi ');
    await press(box, 'Enter', { metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toBe('Can you check this @Pi');
    expect(onSend.mock.calls[0]![1]).toEqual([{ host: 'pi', session: 'ses-pi', label: 'Pi' }]);
  });

  test('with words but no tag, nothing is tagged and the words go', async () => {
    const onSend = mock(async (_words: string, _tags: unknown[]) => {});
    const el = await render(<LiveComposer agents={[PI]} placeholder="Reply" sendLabel="Reply" onSend={onSend} />);
    await type(el.querySelector('textarea')!, 'Thanks');
    await act(async () => el.querySelector<HTMLButtonElement>('button')!.click());
    expect(onSend.mock.calls[0]).toEqual(['Thanks', []]);
  });
});

describe.skipIf(!hasDom)('a thread whose code changed', () => {
  test('stays on its lines with the old code shown inline, never hidden', async () => {
    const messages = [message({ id: 'c1', reply_to: 'root', body: 'Use RangeError.', review_anchor: anchor }), message({ id: 'a1', reply_to: 'c1', body: 'Done.', author: { kind: 'agent', host: 'pi', session: 'ses-pi', name: null } as never, created_at: '2026-11-14T05:01:00.000Z' })];
    const patch = ['@@ -1,4 +1,4 @@', ' export function charge(amount) {', '-  if (amount < 0) throw new Error();', '+  if (amount <= 0) throw new RangeError("amount");', '   return charge(amount);', ' }'].join('\n');
    const [thread] = placeThreads(messages, [{ path: 'src/billing.ts', patch }]);
    expect(thread!.now).toEqual({ place: 'changed', line_start: 2, line_end: 2 });
    const el = await render(<LiveThreadCard thread={thread!} messages={messages} actions={actionsRef()} />);
    expect(el.querySelector('[data-live-thread]')?.getAttribute('data-place')).toBe('changed');
    expect(el.querySelector('[data-live-changed] pre')?.textContent).toBe('  if (amount < 0) throw new Error();');
    expect([...el.querySelectorAll('[data-live-message]')].map((m) => m.textContent)).toEqual([expect.stringContaining('Use RangeError.'), expect.stringContaining('Done.')]);
    expect(el.querySelector('[data-live-delivery]')?.textContent).toBe('· Read');
  });

  test('a resolved thread folds to one line and opens again', async () => {
    const messages = [message({ id: 'c1', reply_to: 'root', body: 'Rename it.', review_anchor: anchor, review_resolved: { at } })];
    const [thread] = placeThreads(messages, []);
    const el = await render(<LiveThreadCard thread={thread!} messages={messages} actions={actionsRef()} />);
    expect(el.querySelector('[data-live-thread]')?.hasAttribute('data-resolved')).toBe(true);
    await act(async () => el.querySelector<HTMLButtonElement>('button')!.click());
    expect(el.querySelector('[data-live-resolve]')?.textContent).toBe('Reopen');
  });
});
