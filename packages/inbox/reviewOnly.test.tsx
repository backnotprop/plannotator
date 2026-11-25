/**
 * The Inbox for code review only in the window (reviewOnly.ts, components/ReviewWelcome.tsx, components/FullInboxRow.tsx,
 * sidebarItems.ts).
 *
 * What regresses: the sidebar keeping the full Inbox's items while code review only (or hiding the Inbox row while
 * something there waits on the person); a load on a page only the full Inbox has not going to Reviews; the welcome not
 * shown when due, shown twice, or not claimed as it opens; its words, order or switch not the approved ones; its switch
 * not saving at once, or Start reviewing, Escape or a click outside turning anything on; the dialog not labelled; the
 * Settings row not saving at once, both ways (no confirmation).
 *
 * The sidebar and the route part run anywhere; the rest is DOM-gated: DOM_TESTS=1 (happy-dom), from
 * tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { drawnSidebarItems } from './sidebarItems';

const hasDom = typeof document !== 'undefined';
const { reviewOnlyHome, reviewOnlyOf } = (hasDom ? await import('./reviewOnly') : {}) as typeof import('./reviewOnly');
const { ReviewWelcome } = (hasDom ? await import('./components/ReviewWelcome') : {}) as typeof import('./components/ReviewWelcome');
const { FullInboxRow } = (hasDom ? await import('./components/FullInboxRow') : {}) as typeof import('./components/FullInboxRow');

const BASE = { board: true, plans: true, grid: true, scheduled: true, reviews: true, usage: true, artifacts: true, agents: true, tags: true, phone: false } as const;

describe('the sidebar', () => {
  test('code review only: Search, Reviews, Drafts, Usage, Feedback, Settings and the icons; the full Inbox: everything it had', () => {
    const full = drawnSidebarItems(BASE);
    const only = drawnSidebarItems({ ...BASE, reviewOnly: true });
    for (const item of ['inbox', 'starred', 'projects', 'agents', 'tags', 'board', 'plans', 'grid', 'scheduled', 'artifacts', 'new-message', 'copy-prompt'] as const) {
      expect(full.has(item)).toBe(true);
      expect(only.has(item)).toBe(false);
    }
    for (const item of ['search', 'reviews', 'drafts', 'usage', 'feedback', 'settings'] as const) expect(only.has(item)).toBe(true);
  });

  test('the Inbox row comes back while something there waits on the person', () => {
    expect(drawnSidebarItems({ ...BASE, reviewOnly: true, inboxWaits: true }).has('inbox')).toBe(true);
    expect(drawnSidebarItems({ ...BASE, reviewOnly: true, inboxWaits: false }).has('inbox')).toBe(false);
  });
});

describe.skipIf(!hasDom)('Reviews is home', () => {
  test('a load on the Inbox, or on a page only the full Inbox has, goes to Reviews; a thread and Settings stay', () => {
    const reviews = { page: 'reviews', project: null, thread: null };
    for (const page of ['inbox', 'board', 'artifacts', 'scheduled', 'plans', 'grid', 'tour'] as const) expect(reviewOnlyHome({ page, project: null, thread: null } as never)).toEqual(reviews as never);
    expect(reviewOnlyHome({ page: 'inbox', project: null, thread: 'thr_1' } as never)).toBeNull();
    expect(reviewOnlyHome({ page: 'settings', project: null, thread: null } as never)).toBeNull();
    expect(reviewOnlyHome({ page: 'reviews', project: null, thread: null } as never)).toBeNull();
  });

  test('only `full_inbox: { on: false }` is code review only; an older Inbox (no field) is the full Inbox', () => {
    expect(reviewOnlyOf({ full_inbox: { on: false } })).toBe(true);
    expect(reviewOnlyOf({ full_inbox: { on: true } })).toBe(false);
    expect(reviewOnlyOf({})).toBe(false);
    expect(reviewOnlyOf(null)).toBe(false);
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts: Record<string, unknown>[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/api/inbox/settings')) posts.push(body);
    const full = (body.full_inbox as { on?: boolean } | undefined)?.on;
    return new Response(JSON.stringify(full === undefined ? {} : { full_inbox: { on: full, chosen: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="review-welcome"]');

function render(node: React.ReactNode) {
  if (!host) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    act(() => void (root = createRoot(host!)));
  }
  act(() => root!.render(<>{node}</>));
}

const Welcome = ({ due = true, full = false }: { due?: boolean; full?: boolean }) => (
  <>
    <main className="ib-main">
      <h1>Reviews</h1>
    </main>
    <ReviewWelcome due={due} fullInbox={full} phone={false} />
  </>
);

describe.skipIf(!hasDom)('the welcome', () => {
  test('when due: opens at once, claimed as it opens; the approved words in order, labelled by its title', async () => {
    render(<Welcome />);
    await wait(20);
    const d = dialog()!;
    expect(d).not.toBeNull();
    expect(posts).toEqual([{ review_welcome: true }]);
    const title = document.getElementById(d.getAttribute('aria-labelledby')!)!;
    expect(title.textContent).toBe('Welcome to the code review Inbox');
    expect([...d.querySelectorAll('#ib-rwel-feats li')].map((li) => li.textContent)).toEqual([
      'Filter PRs by your own risk rules',
      'A review curator works with you on everything you ship',
      'A guided review walks you through each change',
      'Big pictures of what changed and why',
    ]);
    for (const svg of d.querySelectorAll('#ib-rwel-feats svg')) expect(svg.getAttribute('aria-hidden')).toBe('true');
    const sw = d.querySelector<HTMLButtonElement>('[data-review-welcome-full]')!;
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(document.getElementById(sw.getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('The full Plannotator Inbox');
    expect(document.getElementById(sw.getAttribute('aria-describedby')!)!.textContent!.trim()).toBe(
      "Your agents send you questions, decisions and finished work. It's off for now: turn it on here, or any time in Settings.",
    );
    const buttons = [...d.querySelectorAll('button:not([role="switch"])')].map((b) => b.textContent);
    expect(buttons).toEqual(['Start reviewing']);
  });

  test('not due: nothing opens and nothing is claimed', async () => {
    render(<Welcome due={false} />);
    await wait(20);
    expect(dialog()).toBeNull();
    expect(posts).toEqual([]);
  });

  for (const [how, close] of [
    ['Start reviewing', (d: HTMLDialogElement) => d.querySelector<HTMLButtonElement>('[data-review-welcome-start]')!.click()],
    ['Escape', (d: HTMLDialogElement) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
    ['a click outside', (d: HTMLDialogElement) => d.dispatchEvent(new MouseEvent('click', { bubbles: true }))],
  ] as const) {
    test(`${how} closes it, turns nothing on, and it never opens again on this load`, async () => {
      render(<Welcome />);
      await wait(20);
      act(() => close(dialog()!));
      expect(dialog()).toBeNull();
      render(<Welcome />);
      await wait(20);
      expect(dialog()).toBeNull();
      expect(posts).toEqual([{ review_welcome: true }]);
    });
  }

  test('its switch turns the full Inbox on at once, and off again; the dialog stays open', async () => {
    render(<Welcome />);
    await wait(20);
    const sw = () => dialog()!.querySelector<HTMLButtonElement>('[data-review-welcome-full]')!;
    act(() => sw().click());
    expect(sw().getAttribute('aria-checked')).toBe('true');
    await wait(20);
    act(() => sw().click());
    await wait(20);
    expect(posts.slice(1)).toEqual([{ full_inbox: { on: true } }, { full_inbox: { on: false } }]);
    expect(dialog()).not.toBeNull();
  });
});

describe.skipIf(!hasDom)("Settings' Full Inbox row", () => {
  test('saves at once both ways, no confirmation: back to the full Inbox, and to code review only again', async () => {
    render(<FullInboxRow saved={false} />);
    const sw = () => document.querySelector<HTMLButtonElement>('[data-settings-full-inbox] [role="switch"]')!;
    expect(document.getElementById(sw().getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('Full Inbox');
    expect(sw().getAttribute('aria-checked')).toBe('false');
    act(() => sw().click());
    expect(sw().getAttribute('aria-checked')).toBe('true');
    await wait(20);
    expect(posts).toEqual([{ full_inbox: { on: true } }]);
    expect(document.querySelector('dialog')).toBeNull();
    // Every window takes the answer from `event: capabilities`: the row follows it.
    render(<FullInboxRow saved={true} />);
    act(() => sw().click());
    await wait(20);
    expect(posts).toEqual([{ full_inbox: { on: true } }, { full_inbox: { on: false } }]);
  });
});
