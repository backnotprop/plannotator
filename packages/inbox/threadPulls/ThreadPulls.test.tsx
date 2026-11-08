/**
 * A thread's PRs in the window (approval "inbox-pr-binding", 2026-11-08): the
 * row's mark, the thread's button and its card, over a stubbed fetch (no
 * Inbox, no forge).
 *
 * What regresses: a count that is missing, wrong or past "9+"; the mark
 * showing a merged PR while one is still open; a screen reader hearing
 * nothing of the PRs; the button drawn on a thread with none; a stack shown
 * out of order or mixed into Related; a remove that sends the wrong ref or
 * cannot be undone; a refused add that says nothing; and a change to another
 * thread making this one read again.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxThreadPullWire, InboxThreadPullsAnswer, InboxThreadPullsSummary, InboxThreadPullState } from '@plannotator/core/inbox-types';
import { inboxThreadPullGroups, inboxThreadPullWire, parseInboxThreadPullRef } from '@plannotator/core/inbox-types';
import { pullsMarkWords, threadPullsBus } from './model';

const hasDom = typeof document !== 'undefined';
const { RowPullsMark, ThreadPullsButton } = (hasDom ? await import('./ThreadPulls') : {}) as typeof import('./ThreadPulls');

const THREAD = 'msg_01M5PR0000000000000000001';
const OTHER = 'msg_01M5PR0000000000000000002';

let n = 0;
function pull(ref: string, state: InboxThreadPullState, base: string, head: string, extra: Partial<InboxThreadPullWire> = {}): InboxThreadPullWire {
  const parsed = parseInboxThreadPullRef(ref);
  if (!('key' in parsed)) throw new Error(ref);
  n += 1;
  return {
    ...inboxThreadPullWire({
      id: `${THREAD}:${parsed.key}`,
      project_id: 'prj_1',
      thread_id: THREAD,
      pull: parsed.key,
      url: parsed.url,
      added_by: { kind: 'agent', session: 'ses_a', host: 'claude-code', name: null },
      added_at: `2026-11-08T10:0${n}:00.000Z`,
      state,
      title: `Title of ${ref}`,
      base,
      head,
      read_at: null,
    }),
    ...extra,
  };
}

function answerOf(pulls: InboxThreadPullWire[], removed: InboxThreadPullWire[] = []): InboxThreadPullsAnswer {
  return { pulls, groups: inboxThreadPullGroups(pulls), removed };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let reads: string[] = [];
let posts: { path: string; body: Record<string, unknown> }[] = [];
let answer: InboxThreadPullsAnswer = answerOf([]);
let postAnswer: (body: Record<string, unknown>) => Response = () => Response.json(answer);

beforeEach(() => {
  if (!hasDom) return;
  n = 0;
  reads = [];
  posts = [];
  answer = answerOf([]);
  postAnswer = () => Response.json(answer);
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return postAnswer(posts.at(-1)!.body);
    }
    reads.push(path);
    return Response.json(answer);
  }) as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  for (const el of document.querySelectorAll('[data-pr-popover]')) el.remove();
  globalThis.fetch = savedFetch;
});

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

function render(node: React.ReactNode) {
  act(() => root!.render(node));
}

const popover = () => document.querySelector<HTMLElement>('[data-pr-popover]');
const click = async (el: Element | null) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe.skipIf(!hasDom)('the row mark', () => {
  const summary = (count: number, state: InboxThreadPullState): InboxThreadPullsSummary => ({ count, headline: { key: 'github.com/northwind/billing-svc#431', state } });

  test('one PR: its state icon and no count; several: the count over the corner, "9+" past nine', () => {
    render(<RowPullsMark threadId={THREAD} summary={summary(1, 'merged')} />);
    const mark = host!.querySelector('[data-pr-mark]')!;
    expect(mark.getAttribute('data-pr-mark')).toBe('merged');
    expect(mark.querySelector('.ib-prc-n')).toBeNull();
    render(<RowPullsMark threadId={THREAD} summary={summary(3, 'open')} />);
    expect(host!.querySelector('.ib-prc-n')!.textContent).toBe('3');
    render(<RowPullsMark threadId={THREAD} summary={summary(14, 'draft')} />);
    expect(host!.querySelector('.ib-prc-n')!.textContent).toBe('9+');
  });

  test('a screen reader hears the PRs in the row: the count and the one in play', () => {
    render(<RowPullsMark threadId={THREAD} summary={summary(3, 'open')} />);
    expect(host!.querySelector('[data-pr-mark] .ib-sr')!.textContent).toBe('3 pull requests, #431 open');
    expect(pullsMarkWords(summary(1, 'merged'), '#12')).toBe('Pull request #12, merged');
    expect(pullsMarkWords(summary(1, 'unknown'), '#12')).toBe('Pull request #12');
  });

  test('no PRs, no mark, and no read', async () => {
    render(<RowPullsMark threadId={THREAD} summary={undefined} />);
    await settle();
    expect(host!.querySelector('[data-pr-mark]')).toBeNull();
    expect(reads).toEqual([]);
  });
});

describe.skipIf(!hasDom)("the thread's button and its card", () => {
  test('a thread with no PRs has no button', async () => {
    render(<ThreadPullsButton threadId={THREAD} summary={undefined} />);
    await settle();
    expect(host!.querySelector('[data-pr-button]')).toBeNull();
  });

  test('the button shows the PR in play with the count; its card lists the stack base first, then Related, with states', async () => {
    const base = pull('northwind/billing-svc#430', 'merged', 'main', 'model');
    const related = pull('northwind/web-app#1309', 'closed', 'main', 'flag');
    const top = pull('northwind/billing-svc#431', 'open', 'model', 'schedule', { checks: 'failing', review: 'review_required' });
    answer = answerOf([top, related, base]);
    render(<ThreadPullsButton threadId={THREAD} summary={undefined} />);
    await settle();
    expect(reads).toEqual([`/api/inbox/threads/${THREAD}/pulls`]);
    const button = host!.querySelector('[data-pr-button]')!;
    expect(button.getAttribute('data-pr-button')).toBe('open');
    expect(button.querySelector('.ib-prc-n')!.textContent).toBe('3');
    expect(button.getAttribute('aria-label')).toBe('3 pull requests, #431 open');
    await click(button);
    const card = popover()!;
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.querySelector('.ib-prpop-head')!.textContent).toContain('2 repositories');
    const groups = [...card.querySelectorAll('[data-pr-group]')].map((g) => [g.getAttribute('data-pr-group'), [...g.querySelectorAll('[data-pr-row]')].map((r) => r.getAttribute('data-pr-row'))]);
    expect(groups).toEqual([
      ['stack', ['northwind/billing-svc#430', 'northwind/billing-svc#431']],
      ['related', ['northwind/web-app#1309']],
    ]);
    expect([...card.querySelectorAll('.ib-prpop-gh')].map((h) => h.textContent)).toEqual(['Stack of 2', 'Related']);
    const open = card.querySelector('[data-pr-row="northwind/billing-svc#431"] .ib-prpop-sub')!.textContent;
    expect(open).toContain('Open');
    expect(open).toContain('checks failing');
    expect(open).toContain('review required');
    expect(card.querySelector('[data-pr-row="northwind/billing-svc#430"] .ib-prpop-sub')!.textContent).toContain('Merged');
  });

  test('a stack alone says "Stack of N" in its head', async () => {
    answer = answerOf([pull('o/r#1', 'merged', 'main', 'a'), pull('o/r#2', 'open', 'a', 'b'), pull('o/r#3', 'draft', 'b', 'c')]);
    render(<ThreadPullsButton threadId={THREAD} summary={undefined} />);
    await settle();
    await click(host!.querySelector('[data-pr-button]'));
    expect(popover()!.querySelector('.ib-prpop-head')!.textContent).toBe('o/rStack of 3');
  });

  test('remove sends that ref, says so with Undo, and Undo adds it back', async () => {
    const a = pull('o/r#1', 'open', 'main', 'a');
    const b = pull('o/web#2', 'open', 'main', 'b');
    answer = answerOf([a, b]);
    postAnswer = (body) => {
      if (body.remove) answer = answerOf([a], [{ ...b, removed_by: { kind: 'person' }, removed_at: '2026-11-08T11:00:00.000Z' }]);
      if (body.add) answer = answerOf([a, b]);
      return Response.json(answer);
    };
    render(<ThreadPullsButton threadId={THREAD} summary={undefined} />);
    await settle();
    await click(host!.querySelector('[data-pr-button]'));
    await click(popover()!.querySelector('[data-pr-remove="o/web#2"]'));
    expect(posts).toEqual([{ path: `/api/inbox/threads/${THREAD}/pulls`, body: { remove: ['o/web#2'] } }]);
    expect(popover()!.querySelector('[data-pr-removed]')!.textContent).toContain('Removed o/web#2');
    // One PR left: the button's count goes.
    expect(host!.querySelector('[data-pr-button] .ib-prc-n')).toBeNull();
    await click(popover()!.querySelector('[data-pr-undo]'));
    expect(posts.at(-1)!.body).toEqual({ add: ['o/web#2'] });
    expect(popover()!.querySelector('[data-pr-removed]')).toBeNull();
    expect(host!.querySelector('[data-pr-button] .ib-prc-n')!.textContent).toBe('2');
  });

  test("the person adds a PR by its ref; a refused one says why and keeps what they typed", async () => {
    answer = answerOf([pull('o/r#1', 'open', 'main', 'a')]);
    postAnswer = (body) => {
      const add = body.add as string[];
      if (add.includes('#5')) return Response.json({ error: "'#5' is not a full PR ref. Write owner/repo#123, group/project!45 or the PR's URL; nothing was changed.", code: 'validation_error' }, { status: 422 });
      answer = answerOf([...answer.pulls, pull(add[0]!, 'unknown', 'main', 'z')]);
      return Response.json(answer);
    };
    render(<ThreadPullsButton threadId={THREAD} summary={undefined} />);
    await settle();
    await click(host!.querySelector('[data-pr-button]'));
    const input = popover()!.querySelector<HTMLInputElement>('[data-pr-add-input]')!;
    await type(input, '#5');
    await click(popover()!.querySelector('[data-pr-add]'));
    expect(popover()!.querySelector('[data-pr-error]')!.textContent).toContain("'#5' is not a full PR ref");
    expect(input.value).toBe('#5');
    await type(input, 'acme/api!3');
    await click(popover()!.querySelector('[data-pr-add]'));
    expect(posts.at(-1)!.body).toEqual({ add: ['acme/api!3'] });
    expect(popover()!.querySelector('[data-pr-error]')).toBeNull();
    expect(input.value).toBe('');
    expect(popover()!.querySelectorAll('[data-pr-row]')).toHaveLength(2);
  });

  test("a change to this thread's PRs reads them again; another thread's does not", async () => {
    answer = answerOf([pull('o/r#1', 'open', 'main', 'a')]);
    render(<ThreadPullsButton threadId={THREAD} summary={undefined} />);
    await settle();
    expect(reads).toHaveLength(1);
    await act(async () => threadPullsBus.emit(OTHER));
    await settle();
    expect(reads).toHaveLength(1);
    answer = answerOf([pull('o/r#1', 'merged', 'main', 'a'), pull('o/r#2', 'open', 'main', 'b')]);
    await act(async () => threadPullsBus.emit(THREAD));
    await settle();
    expect(reads).toHaveLength(2);
    expect(host!.querySelector('[data-pr-button]')!.getAttribute('data-pr-button')).toBe('open');
    expect(host!.querySelector('[data-pr-button] .ib-prc-n')!.textContent).toBe('2');
  });

  test('Escape closes the card and puts focus back on the button', async () => {
    answer = answerOf([pull('o/r#1', 'open', 'main', 'a'), pull('o/r#2', 'open', 'main', 'b')]);
    render(<ThreadPullsButton threadId={THREAD} summary={undefined} />);
    await settle();
    const button = host!.querySelector<HTMLButtonElement>('[data-pr-button]')!;
    await click(button);
    expect(popover()).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
