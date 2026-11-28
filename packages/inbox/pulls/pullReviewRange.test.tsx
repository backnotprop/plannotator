/**
 * The PR page's "Layers i–j" and Since you looked (approval "inbox-pr-dashboard", q-0a2467a4 and q-6cf84c0b). What
 * regresses:
 *  - a range reading anything but the range's compare (`scope=range`, `from` its lowest layer), or not named in the bar
 *    and the rail; a range the list no longer holds as one reading it anyway;
 *  - a read diff not marking its layers looked at the head it showed;
 *  - Since you looked not offered while the layer's head moved since the person opened it, offered when it did not,
 *    or reading anything but the compare from the commit they opened;
 *  - a phone's layer sheet without them (a phone would have no way to either);
 *  - changes asked on a range or a since view of the live session that wrote the review losing `/review-recheck`'s
 *    block (#3431), or a range's words not naming what it covered.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { link, model, pull, STACK_ID } from './pullReviewFixtures';
import type { PullViewScope } from './viewScope';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  mock.module('#guide-reader', () => ({ default: () => null, PullChangesTree: () => null }));
  await (await import('./platformPostSeam')).realPlatformPost();
}
const { PullReview } = (hasDom ? await import('./PullReview') : {}) as typeof import('./PullReview');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { resetLookedVisits } = (hasDom ? await import('../prs/looked') : {}) as typeof import('../prs/looked');
const { PHONE_QUERY } = (hasDom ? await import('../phone') : {}) as typeof import('../phone');

const OLD = 'b'.repeat(40);
const HEAD = (n: number) => String(n).padStart(40, 'a');
const key = (n: number) => `github.com/northwind/billing-svc#${n}`;
// The fixtures' stack (#412 ← #413 ← #414), each with its head named.
const named: InboxPullsAnswer = { ...model, pulls: model.pulls.map((p) => ({ ...p, head_sha: HEAD(p.number) })) };

let root: Root;
let host: HTMLElement;
let savedFetch: typeof fetch;
let asked: { key: string; scope: string; from: string | null }[];
let moved: { key: string; scope: PullViewScope }[];
let replies: { path: string; body: { words?: string; feedback?: string } }[];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  asked = [];
  moved = [];
  replies = [];
  window.localStorage.clear();
  resetLookedVisits();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (url.pathname.endsWith('/reply')) {
      replies.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({ serverSession: 's', message: { id: 'msg_r' } });
    }
    if (url.pathname.endsWith('/pulls/diff')) {
      const k = url.searchParams.get('key')!;
      const scope = url.searchParams.get('scope')!;
      asked.push({ key: k, scope, from: url.searchParams.get('from') });
      const patch = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n';
      return Response.json({ serverSession: 's', key: k, scope, base: 'x', head: 'y', patch, head_sha: HEAD(Number(k.split('#')[1])) });
    }
    if (url.pathname.endsWith('/pulls/details')) return Response.json({ serverSession: 's', key: url.searchParams.get('key'), description: null, labels: [], reviewers: [], checks: [], comments: [] });
    return Response.json({});
  }) as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = savedFetch;
});

async function open(layerKey: string, scope: PullViewScope, answer: InboxPullsAnswer = named) {
  await act(async () => {
    root.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <PullReview model={answer} modelError={null} stackId={STACK_ID} layerKey={layerKey} scope={scope} onLayer={(k, s) => moved.push({ key: k, scope: s })} onBack={() => {}} onSent={() => {}} />
        </div>
      </SidebarProvider>,
    );
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
}
const looked = () => JSON.parse(window.localStorage.getItem('plannotator-inbox-pull-looked') ?? '{}') as Record<string, { sha: string }>;

test.if(hasDom)("a range reads the range's compare and is named in the bar and the rail", async () => {
  await open(key(414), `range:${key(413)}`);
  expect(asked).toEqual([{ key: key(414), scope: 'range', from: key(413) }]);
  expect(host.querySelector('[data-pull-review-title]')?.textContent).toContain('Layers 2–3 as one diff');
  expect(host.querySelector('[data-pull-layer-range]')?.textContent).toContain('Layers 2–3');
});

test.if(hasDom)('a range the list no longer holds as one reads the layer', async () => {
  const later = { ...named, pulls: named.pulls.map((p) => (p.number === 413 ? { ...p, state: 'merged' as const } : p)) };
  await open(key(414), `range:${key(413)}`, later);
  expect(asked).toEqual([{ key: key(414), scope: 'layer', from: null }]);
  expect(host.querySelector('[data-pull-layer-range]')).toBeNull();
});

test.if(hasDom)('a read diff marks the layers it shows looked at, at their heads', async () => {
  await open(key(414), `range:${key(413)}`);
  expect(looked()).toEqual({ [key(413)]: expect.objectContaining({ sha: HEAD(413) }), [key(414)]: expect.objectContaining({ sha: HEAD(414) }) });
});

test.if(hasDom)('Since you looked: offered while the head moved since the person opened it, and reads from that commit', async () => {
  window.localStorage.setItem('plannotator-inbox-pull-looked', JSON.stringify({ [key(413)]: { sha: OLD, at: 1 }, [key(412)]: { sha: HEAD(412), at: 1 } }));
  await open(key(412), 'layer');
  expect(host.querySelector('[data-pull-since]')).toBeNull();
  await open(key(413), 'layer');
  const since = host.querySelector<HTMLButtonElement>(`[data-pull-since="${OLD}"]`);
  expect(since?.textContent).toContain('Since you looked');
  // Opening the layer marked it looked; what changed is still offered for this head.
  expect(looked()[key(413)]?.sha).toBe(HEAD(413));
  act(() => since!.click());
  expect(moved).toEqual([{ key: key(413), scope: `since:${OLD}` }]);
  asked = [];
  await open(key(413), `since:${OLD}`);
  expect(asked).toEqual([{ key: key(413), scope: 'since', from: OLD }]);
  expect(host.querySelector(`[data-pull-since="${OLD}"]`)?.getAttribute('aria-pressed')).toBe('true');
});

test.if(hasDom)("a phone's layer sheet offers Since you looked and names the range", async () => {
  const saved = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query === PHONE_QUERY, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  try {
    window.localStorage.setItem('plannotator-inbox-pull-looked', JSON.stringify({ [key(414)]: { sha: OLD, at: 1 } }));
    await open(key(414), `range:${key(413)}`);
    act(() => host.querySelector<HTMLButtonElement>('[data-pull-details-button]')!.click());
    expect(host.querySelector('.ib-prd-top [data-pull-layer-range]')?.textContent).toContain('Layers 2–3');
    act(() => host.querySelector<HTMLButtonElement>(`.ib-prd-top [data-pull-since="${OLD}"]`)!.click());
    expect(moved).toEqual([{ key: key(414), scope: `since:${OLD}` }]);
  } finally {
    window.matchMedia = saved;
  }
});

test.if(hasDom)('a PR never opened offers nothing since', async () => {
  await open(key(413), 'layer');
  expect(host.querySelector('[data-pull-since]')).toBeNull();
});

test.if(hasDom)('a PR with no stack rail gets its own row back from Since you looked', async () => {
  const single = { ...named, pulls: [pull(880, { repo: 'northwind/web-app', head_sha: HEAD(880) })], links: {} };
  window.localStorage.setItem('plannotator-inbox-pull-looked', JSON.stringify({ 'github.com/northwind/web-app#880': { sha: OLD, at: 1 } }));
  const k = 'github.com/northwind/web-app#880';
  await act(async () => {
    root.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <PullReview model={single} modelError={null} stackId={k} layerKey={k} scope={`since:${OLD}`} onLayer={(kk, s) => moved.push({ key: kk, scope: s })} onBack={() => {}} onSent={() => {}} />
        </div>
      </SidebarProvider>,
    );
  });
  act(() => host.querySelector<HTMLButtonElement>('[data-pull-layer-own]')!.click());
  expect(moved).toEqual([{ key: k, scope: 'layer' }]);
});

const RECHECK = '`review-recheck`';
// The fixtures' link on #414, now carrying the guided review its live session wrote.
const reviewed: InboxPullsAnswer = { ...named, links: { [key(414)]: { ...link, guide: { message_id: 'msg_g', title: 'Retries', steps: 3, review: true, session: 'ses_1' } } } };
async function askChanges() {
  await act(async () => host.querySelector<HTMLButtonElement>('[data-review-decision]:not([data-review-posts]) [data-decision-caret]')!.click());
  const item = [...document.querySelectorAll<HTMLButtonElement>('[data-decision-popover] button, [data-decision-popover] [role="menuitem"]')].find((b) => /Request changes/.test(b.textContent ?? ''));
  await act(async () => item!.click());
  const box = document.querySelector<HTMLTextAreaElement>('[data-decision-note-input]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Split the retry out.');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => document.querySelector<HTMLButtonElement>('[data-decision-composer-send]')!.click());
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
}

test.if(hasDom)("changes asked on a range or since view, of the session that wrote the review, carry the recheck block", async () => {
  await open(key(414), `range:${key(413)}`, reviewed);
  await askChanges();
  expect(replies.map((r) => r.path)).toEqual([`/api/inbox/messages/${link.last!.message_id}/reply`]);
  expect(replies[0]!.body.words).toContain(`I reviewed the stack from retry/schedule up to pull request #414`);
  expect(String(replies[0]!.body.feedback)).toContain(RECHECK);

  replies = [];
  window.localStorage.setItem('plannotator-inbox-pull-looked', JSON.stringify({ [key(414)]: { sha: OLD, at: 1 } }));
  await open(key(414), `since:${OLD}`, reviewed);
  await askChanges();
  expect(replies).toHaveLength(1);
  expect(replies[0]!.body.words).toContain('I reviewed pull request #414');
  expect(String(replies[0]!.body.feedback)).toContain(RECHECK);
});

test.if(hasDom)('changes asked on a range of a session that did not write the review carry no recheck block', async () => {
  await open(key(414), `range:${key(413)}`);
  await askChanges();
  expect(replies).toHaveLength(1);
  expect(JSON.stringify(replies[0]!.body)).not.toContain(RECHECK);
});
