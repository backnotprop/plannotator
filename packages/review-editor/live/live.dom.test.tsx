import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessage, InboxQuestionRecord } from '@plannotator/core/inbox-types';
import { inboxOtherStillOpenLine, inboxStillOpenLine } from '@plannotator/core/inbox-questions';
import { LiveComposer } from './LiveComposer';
import { LiveThreadCard } from './LiveThreadCard';
import { LiveThreadsTab } from './LiveThreadsTab';
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
    current: { agents: [PI, CC], defaultTo: CC, loadAgents: () => {}, reply: mock(async () => {}), resolve: mock(async () => {}), sendComments: mock(async () => {}), reveal: () => {}, takeBack: mock(async () => {}), postToPR: null, posted: new Set<string>(), revealLines: () => {}, error: null, ...over },
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

describe.skipIf(!hasDom)('a long thread', () => {
  test('shows its first message and the last two, with how many are folded between', async () => {
    const agent = { kind: 'agent', host: 'pi', session: 's', name: null } as never;
    const messages = [
      message({ id: 'c1', reply_to: 'root', body: 'First.', review_anchor: anchor }),
      message({ id: 'a1', reply_to: 'c1', body: 'Two.', author: agent, created_at: '2026-11-14T05:01:00.000Z' }),
      message({ id: 'p1', reply_to: 'a1', body: 'Three.', created_at: '2026-11-14T05:02:00.000Z' }),
      message({ id: 'a2', reply_to: 'p1', body: 'Four.', author: agent, created_at: '2026-11-14T05:03:00.000Z' }),
      message({ id: 'p2', reply_to: 'a2', body: 'Five.', created_at: '2026-11-14T05:04:00.000Z' }),
    ];
    const [thread] = placeThreads(messages, []);
    const el = await render(<LiveThreadCard thread={thread!} messages={messages} actions={actionsRef()} />);
    const bodies = () => [...el.querySelectorAll('[data-live-message]')].map((m) => m.getAttribute('data-live-message'));
    expect(bodies()).toEqual(['c1', 'a2', 'p2']);
    expect(el.querySelector('[data-live-earlier]')?.textContent).toBe('2 earlier replies');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-live-earlier]')!.click());
    expect(bodies()).toEqual(['c1', 'a1', 'p1', 'a2', 'p2']);
  });
});

describe.skipIf(!hasDom)('a thread by keyboard', () => {
  test('Reply opens the box with focus in it, @ tags, Mod+Enter sends, and focus comes back to Reply; Escape on an empty box closes it too', async () => {
    const messages = [message({ id: 'c1', reply_to: 'root', body: 'Rename it.', review_anchor: anchor })];
    const [thread] = placeThreads(messages, []);
    const actions = actionsRef();
    const el = await render(<LiveThreadCard thread={thread!} messages={messages} actions={actions} />);
    const reply = el.querySelector<HTMLButtonElement>('[data-live-reply]')!;
    reply.focus();
    await act(async () => reply.click());
    const box = el.querySelector<HTMLTextAreaElement>('[data-live-composer] textarea')!;
    expect(document.activeElement).toBe(box);
    await type(box, 'On it? @');
    await press(box, 'ArrowDown');
    await press(box, 'Enter');
    await press(box, 'Enter', { metaKey: true });
    await act(async () => {});
    expect(actions.current.reply).toHaveBeenCalledWith('c1', 'On it? @Pi', [{ host: 'pi', session: 'ses-pi', label: 'Pi' }]);
    expect(document.activeElement).toBe(el.querySelector('[data-live-reply]'));
    await act(async () => el.querySelector<HTMLButtonElement>('[data-live-reply]')!.click());
    await press(el.querySelector<HTMLTextAreaElement>('[data-live-composer] textarea')!, 'Escape');
    expect(el.querySelector('[data-live-composer]')).toBeNull();
    expect(document.activeElement).toBe(el.querySelector('[data-live-reply]'));
  });
});

describe.skipIf(!hasDom)('who wrote each message', () => {
  test('a message shows its sender as the Inbox does: the reply glyph for you, the brand mark for a known agent, the neutral glyph for an unknown one', async () => {
    const messages = [
      message({ id: 'c1', reply_to: 'root', body: 'Why?', review_anchor: anchor }),
      message({ id: 'a1', reply_to: 'c1', body: 'Because.', author: { kind: 'agent', host: 'pi', session: 's', name: null } as never, created_at: '2026-11-14T05:01:00.000Z' }),
      message({ id: 'a2', reply_to: 'a1', body: 'Also.', author: { kind: 'agent', host: 'some-new-agent', session: 't', name: null } as never, created_at: '2026-11-14T05:02:00.000Z' }),
    ];
    const [thread] = placeThreads(messages, []);
    const el = await render(<LiveThreadCard thread={thread!} messages={messages} actions={actionsRef()} />);
    const glyph = (id: string) => {
      const svg = el.querySelector(`[data-live-message="${id}"] [data-live-mark] svg`);
      return svg ? (svg.getAttribute('data-icon') ?? 'brand') : null;
    };
    expect(['c1', 'a1', 'a2'].map(glyph)).toEqual(['reply', 'brand', 'code']);
  });
});

// The still-open sentence in each form the Inbox writes, from the Inbox's own composers: 1 or 2 open, none answered,
// some answered earlier, and (with answers sent) the others still open.
const openQ = { answer: null, revision: 0, sent_revision: 0, superseded_by: null, set_aside: false } as unknown as InboxQuestionRecord;
const sentQ = { answer: { kind: 'choice', value: 'a' }, revision: 1, sent_revision: 1, superseded_by: null, set_aside: false } as unknown as InboxQuestionRecord;
const STILL_OPEN_FORMS = [
  inboxStillOpenLine([openQ]),
  inboxStillOpenLine([openQ, openQ]),
  inboxStillOpenLine([sentQ, openQ]),
  inboxStillOpenLine([sentQ, openQ, openQ]),
];
const OTHER_OPEN_FORMS = [inboxOtherStillOpenLine([openQ]), inboxOtherStillOpenLine([openQ, openQ])];

describe.skipIf(!hasDom)("a person's reply while an agent's question is open", () => {
  const asker = { kind: 'agent', host: 'pi', session: 's', name: null } as never;
  const threadWith = (sentence: string) => [
    message({ id: 'c1', reply_to: 'ask', body: `Use a RangeError.\n\n${sentence}`, review_anchor: anchor }),
    message({ id: 'a1', reply_to: 'c1', body: 'Keep both checks?', author: asker, created_at: '2026-11-14T05:01:00.000Z' }),
    message({ id: 'p1', reply_to: 'a1', body: `Keep both.\n\n${sentence}`, created_at: '2026-11-14T05:02:00.000Z' }),
  ];
  const bodyOf = (el: HTMLElement, id: string) => el.querySelector(`[data-live-message="${id}"] [data-live-body]`)?.textContent?.trim();

  test("shows the person's words and never the Inbox's sentence for the agent, in each of its forms; the agent's message as written", async () => {
    expect(new Set(STILL_OPEN_FORMS).size).toBe(4);
    for (const sentence of STILL_OPEN_FORMS) {
      const messages = threadWith(sentence);
      const [thread] = placeThreads(messages, []);
      const el = await render(<LiveThreadCard thread={thread!} messages={messages} actions={actionsRef()} />);
      expect(bodyOf(el, 'c1')).toBe('Use a RangeError.');
      expect(bodyOf(el, 'p1')).toBe('Keep both.');
      expect(bodyOf(el, 'a1')).toBe('Keep both checks?');
      expect(el.textContent).not.toContain(sentence);
      await act(async () => root?.unmount());
      root = null;
      host?.remove();
    }
  });

  test("the resolved thread's line and the Threads tab's row show the comment's words only", async () => {
    const sentence = STILL_OPEN_FORMS[0]!;
    const messages = threadWith(sentence).map((m) => (m.id === 'c1' ? { ...m, review_resolved: { at } } : m));
    const [thread] = placeThreads(messages, []);
    const card = await render(<LiveThreadCard thread={thread!} messages={messages} actions={actionsRef()} />);
    expect(card.querySelector('[data-live-thread][data-resolved]')?.textContent).toContain('Use a RangeError.');
    expect(card.textContent).not.toContain(sentence);
    await act(async () => root?.unmount());
    host?.remove();
    const tab = await render(<LiveThreadsTab placed={[thread!]} unsent={[]} order={[]} focused={null} onStep={() => {}} threadUrl={null} pr={null} actions={actionsRef()} />);
    expect(tab.querySelector('[data-live-row="c1"]')?.textContent).toContain('Use a RangeError.');
    expect(tab.textContent).not.toContain(sentence);
  });

  test('a reply that sent answers keeps them on the page; only the sentence about the other open questions goes', async () => {
    for (const sentence of OTHER_OPEN_FORMS) {
      const answered = `Answered 1 question.\n\nKeep both.\n\n${sentence}\n\n## Answers to your questions\n\n1 of 2 questions answered.\n\n### Q1. Keep both checks?\nAnswer: Yes`;
      const messages = [...threadWith(STILL_OPEN_FORMS[0]!).slice(0, 2), message({ id: 'p1', reply_to: 'a1', body: answered, created_at: '2026-11-14T05:02:00.000Z' })];
      const [thread] = placeThreads(messages, []);
      const el = await render(<LiveThreadCard thread={thread!} messages={messages} actions={actionsRef()} />);
      const reply = el.querySelector('[data-live-message="p1"] [data-live-body]')?.textContent ?? '';
      expect(reply).toContain('Keep both.');
      expect(reply).toContain('Answer: Yes');
      expect(reply).not.toContain(sentence);
      await act(async () => root?.unmount());
      root = null;
      host?.remove();
    }
  });
});
