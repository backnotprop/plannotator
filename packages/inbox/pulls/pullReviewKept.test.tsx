/**
 * What the Pull requests review keeps of the person's unsent work (line comments, global comments, Viewed ticks), with
 * the Inbox's doors stubbed at `fetch` and the diff reader stubbed to hand out its seams. What regresses:
 *
 *  - `updated_at` moving with the same head (a label, a teammate's comment, a review) deleting the work, reading the
 *    diff again, or taking the reader down (its scroll, a comment being typed);
 *  - a new head commit keeping line comments or Viewed, or losing global comments;
 *  - another layer of the stack moving taking this layer's work;
 *  - an upgrade losing what an older Inbox kept under the PR's last update;
 *  - a list that names no head, or is behind the patch on screen, losing the work or carrying it over a real commit.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullLink, InboxPullsAnswer } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
interface ReaderProps {
  comments?: { onSave: (annotation: unknown) => unknown };
  viewed?: { files: ReadonlySet<string>; onToggle: (path: string) => void };
}
let reader: ReaderProps | undefined;
/** How many times a reader came up: one that goes down loses its scroll and what is being typed in it. */
let readerMounts = 0;
if (hasDom) {
  mock.module('#guide-reader', () => ({
    default: (props: ReaderProps) => {
      reader = props;
      useEffect(() => {
        readerMounts += 1;
      }, []);
      return null;
    },
  }));
}
const { PullReview } = (hasDom ? await import('./PullReview') : {}) as typeof import('./PullReview');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const STORE = 'plannotator-inbox-pull-review:';
const PATH = 'src/retry.ts';
const GLOBAL = { id: 'g1', type: 'comment', scope: 'general', filePath: '', lineStart: 0, lineEnd: 0, side: 'new', text: 'Split this PR.', createdAt: 1 };
const LINE = { id: 'l1', type: 'comment', scope: 'line', filePath: PATH, lineStart: 12, lineEnd: 12, side: 'new', text: 'Cap the backoff.', createdAt: 2 };

// The window remembers diffs it read by layer: each test has layers of its own.
let nextNumber = 100;
function layers(fields: Partial<InboxPull> = {}): { low: InboxPull; top: InboxPull } {
  const n = (nextNumber += 2);
  const base = (number: number, head: string, on: string): InboxPull => ({
    key: `github.com/northwind/billing-svc#${number}`,
    platform: 'github',
    host: 'github.com',
    repo: 'northwind/billing-svc',
    number,
    url: `https://github.com/northwind/billing-svc/pull/${number}`,
    title: `Layer ${number}`,
    author: 'dana',
    mine: true,
    requested: false,
    state: 'open',
    base: on,
    head,
    head_repo: 'northwind/billing-svc',
    additions: 4,
    deletions: 1,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: 'success',
    updated_at: '2026-11-03T09:00:00Z',
    merged_at: null,
  });
  return { low: { ...base(n, `low-${n}`, 'main'), head_sha: 'c'.repeat(40) }, top: { ...base(n + 1, `top-${n}`, `low-${n}`), head_sha: A, ...fields } };
}

const LAST = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const link: InboxPullLink = {
  via: 'url',
  thread_id: 'thr_retries',
  thread_subject: 'Retry the failed charges',
  project_id: 'prj_1',
  agent: { host: 'claude-code', session: 'ses_1', name: null },
  last: { message_id: LAST, preview: 'The stack is up.', at: '2026-11-03T09:00:00Z' },
  guide: null,
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** The head the diff door answers with for This layer. */
let diffHead: string | null = A;
let diffReads = 0;
/** The base the diff door answers with: the layer's own, as it does for a layer. */
let diffBase = 'main';

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  diffHead = A;
  diffReads = 0;
  reader = undefined;
  readerMounts = 0;
  window.localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (!url.pathname.endsWith('/pulls/diff')) return Response.json({});
    diffReads += 1;
    const scope = url.searchParams.get('scope')!;
    const patch = `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n@@ -12 +12 @@\n-a\n+b\n`;
    return Response.json({ serverSession: 's', key: url.searchParams.get('key'), scope, base: diffBase, head: 'y', patch, ...(scope === 'layer' ? { head_sha: diffHead } : {}) });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The list read again with these changes to its layers. */
let reread: (change: (p: InboxPull) => InboxPull) => void = () => {};

function Review({ pulls, layerKey, scope }: { pulls: InboxPull[]; layerKey: string; scope: 'layer' | 'stack' }) {
  const [now, setNow] = useState(pulls);
  reread = (change) => setNow((was) => was.map(change));
  const answer: InboxPullsAnswer = {
    fetched_at: '2026-11-03T09:30:00Z',
    hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
    pulls: now,
    links: Object.fromEntries(now.map((p) => [p.key, link])),
    projects: { 'github.com/northwind/billing-svc': ['prj_1'] },
    cards: {},
  };
  return <PullReview model={answer} modelError={null} stackId={now.at(-1)!.key} layerKey={layerKey} scope={scope} onLayer={() => {}} onBack={() => {}} onSent={() => {}} />;
}

async function open(pulls: InboxPull[], layer: InboxPull, scope: 'layer' | 'stack' = 'layer') {
  diffBase = layer.base;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<div className="pn-inbox"><Review pulls={pulls} layerKey={layer.key} scope={scope} /></div>);
  });
  await settle();
}

/** Writes a line comment and a global comment and ticks Viewed, through the reader's seams as the person does. */
async function work() {
  await act(async () => void reader!.comments!.onSave(GLOBAL));
  await act(async () => void reader!.comments!.onSave(LINE));
  await act(async () => reader!.viewed!.onToggle(PATH));
}

const onScreen = () => ({
  comments: document.querySelector('.ib-vcomments')?.getAttribute('aria-label'),
  viewed: [...reader!.viewed!.files],
});
const ALL_KEPT = { comments: 'Comments, 2', viewed: [PATH] };
const ONLY_GLOBAL = { comments: 'Comments, 1', viewed: [] };
const stored = (p: InboxPull, scope: 'layer' | 'stack', suffix: string) => {
  const raw = JSON.parse(window.localStorage.getItem(`${STORE}${p.key}:${scope}:${suffix}`) ?? 'null') as { comments: { id: string }[]; viewed: string[] } | null;
  return raw && { comments: raw.comments.map((c) => c.id).sort(), viewed: raw.viewed };
};
const moved = (p: InboxPull, top: InboxPull, fields: Partial<InboxPull>) => (p.key === top.key ? { ...p, ...fields } : p);

for (const scope of ['layer', 'stack'] as const) {
  test.skipIf(!hasDom)(`${scope}: updated_at moving with the same head keeps everything and leaves the reader alone`, async () => {
    const { low, top } = layers();
    await open([low, top], top, scope);
    await work();
    const reads = diffReads;
    const mounts = readerMounts;
    await act(async () => reread((p) => moved(p, top, { updated_at: '2026-11-03T10:00:00Z' })));
    await settle();
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(stored(top, scope, A)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
    expect(diffReads).toBe(reads);
    expect(readerMounts).toBe(mounts);
  });

  test.skipIf(!hasDom)(`${scope}: a new head starts clean but for the global comments, and reads the diff again`, async () => {
    const { low, top } = layers();
    await open([low, top], top, scope);
    await work();
    const reads = diffReads;
    diffHead = B;
    await act(async () => reread((p) => moved(p, top, { head_sha: B, updated_at: '2026-11-03T10:00:00Z' })));
    await settle();
    expect(onScreen()).toEqual(ONLY_GLOBAL);
    expect(stored(top, scope, A)).toBeNull();
    expect(stored(top, scope, B)).toEqual({ comments: ['g1'], viewed: [] });
    expect(diffReads).toBe(reads + 1);
  });

  test.skipIf(!hasDom)(`${scope}: another layer's new commit changes nothing on this one`, async () => {
    const { low, top } = layers();
    await open([low, top], top, scope);
    await work();
    const reads = diffReads;
    const mounts = readerMounts;
    await act(async () => reread((p) => (p.key === low.key ? { ...p, head_sha: B, updated_at: '2026-11-03T10:00:00Z' } : p)));
    await settle();
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(diffReads).toBe(reads);
    expect(readerMounts).toBe(mounts);
  });

  test.skipIf(!hasDom)(`${scope}: what an older Inbox kept under the PR's last update survives the upgrade`, async () => {
    const { low, top } = layers();
    const legacy = '2026-11-02T08:00:00Z';
    window.localStorage.setItem(`${STORE}${top.key}:${scope}:${legacy}`, JSON.stringify({ comments: [GLOBAL, LINE], viewed: [PATH] }));
    await open([low, top], top, scope);
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(stored(top, scope, legacy)).toBeNull();
    expect(stored(top, scope, A)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
  });

  test.skipIf(!hasDom)(`${scope}: a list read naming no head loses nothing; the same head after it keeps, a new one clears`, async () => {
    const { low, top } = layers();
    await open([low, top], top, scope);
    await work();
    const mounts = readerMounts;
    await act(async () => reread((p) => moved(p, top, { head_sha: null, updated_at: '2026-11-03T10:00:00Z' })));
    await settle();
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(stored(top, scope, A)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
    await act(async () => reread((p) => moved(p, top, { head_sha: A })));
    await settle();
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(readerMounts).toBe(mounts);
    await act(async () => reread((p) => moved(p, top, { head_sha: null })));
    await settle();
    diffHead = B;
    await act(async () => reread((p) => moved(p, top, { head_sha: B })));
    await settle();
    expect(onScreen()).toEqual(ONLY_GLOBAL);
    expect(stored(top, scope, A)).toBeNull();
  });
}

test.skipIf(!hasDom)('a list that never named a head: a push seen in the patch starts clean; the same patch keeps', async () => {
  const { low, top } = layers({ head_sha: null });
  await open([low, top], top);
  await work();
  const mounts = readerMounts;
  // The list only says the PR changed: the diff is read behind the reader, and its head is still A.
  await act(async () => reread((p) => moved(p, top, { updated_at: '2026-11-03T10:00:00Z' })));
  await settle();
  expect(onScreen()).toEqual(ALL_KEPT);
  expect(readerMounts).toBe(mounts);
  // A commit landed: the next read names a new head.
  diffHead = B;
  await act(async () => reread((p) => moved(p, top, { updated_at: '2026-11-03T11:00:00Z' })));
  await settle();
  expect(onScreen()).toEqual(ONLY_GLOBAL);
  expect(stored(top, 'layer', A)).toBeNull();
});

test.skipIf(!hasDom)('Whole stack with no head named yet: kept while unknown, then under the first head named', async () => {
  const { low, top } = layers({ head_sha: null });
  await open([low, top], top, 'stack');
  await work();
  expect(onScreen()).toEqual(ALL_KEPT);
  await act(async () => reread((p) => moved(p, top, { head_sha: A })));
  await settle();
  expect(onScreen()).toEqual(ALL_KEPT);
  expect(stored(top, 'stack', A)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
});

test.skipIf(!hasDom)('the list behind the patch: comments written on the newer patch stay when the list catches up, with no second read', async () => {
  const { low, top } = layers();
  diffHead = B;
  await open([low, top], top);
  await work();
  const reads = diffReads;
  const mounts = readerMounts;
  await act(async () => reread((p) => moved(p, top, { head_sha: B, updated_at: '2026-11-03T10:00:00Z' })));
  await settle();
  expect(onScreen()).toEqual(ALL_KEPT);
  expect(diffReads).toBe(reads);
  expect(readerMounts).toBe(mounts);
});

test.skipIf(!hasDom)('opened afresh while the list is still behind: work kept on the newer patch is not taken for stale', async () => {
  const { low, top } = layers();
  diffHead = B;
  window.localStorage.setItem(`${STORE}${top.key}:layer:${B}`, JSON.stringify({ comments: [GLOBAL, LINE], viewed: [PATH] }));
  await open([low, top], top);
  expect(onScreen()).toEqual(ALL_KEPT);
});
