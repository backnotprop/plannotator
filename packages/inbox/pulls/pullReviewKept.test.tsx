import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, useEffect, useState, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullLink, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { PlatformPostProps } from '../guide/platform-post-types';
import { SidebarProvider } from '../shell/sidebar';

const hasDom = typeof document !== 'undefined';
interface ReaderProps {
  comments?: { annotations?: { id: string }[]; onSave: (annotation: unknown) => unknown; onDelete?: (id: string) => void };
  viewed?: { files: ReadonlySet<string>; onToggle: (path: string) => void };
}
let reader: ReaderProps | undefined;
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
  // The real review-app dialog and submit, by a path in a variable (the window's strict typecheck must not follow it).
  const seam: string = '../guide/PlatformPost.tsx';
  const real = (await import(seam)) as Record<string, unknown>;
  mock.module('#platform-post', () => real);
}
const { PullReview } = (hasDom ? await import('./PullReview') : {}) as typeof import('./PullReview');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const STORE = 'plannotator-inbox-pull-review:';
const PATH = 'src/retry.ts';
const GLOBAL = { id: 'g1', type: 'comment', scope: 'general', filePath: '', lineStart: 0, lineEnd: 0, side: 'new', text: 'Split this PR.', createdAt: 1 };
const LINE = { id: 'l1', type: 'comment', scope: 'line', filePath: PATH, lineStart: 12, lineEnd: 12, side: 'new', text: 'Cap the backoff.', createdAt: 2 };

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
let diffHead: string | null = A;
let diffReads = 0;
let diffBase = 'main';
let diffHold: Promise<void> | null = null;
let diffCode = 'b';
let diffAt = 12;
let diffFiles: string | null = null;
let diffFails: { code: string; status: number } | null = null;
let postHold: Promise<void> | null = null;
let postAnswer: ((body: Record<string, unknown>) => Response | null) | null = null;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let forge: { commits: Map<string, string>; landed: Landed[]; reviews: { commit: string; action: unknown; body: string }[]; gitlab?: boolean } | null = null;
interface Landed {
  commit: string;
  line: number;
  body: string;
  code: string | null;
}
function codeAt(patch: string, line: number, side: unknown): string | null {
  const hunk = /@@ -(\d+) \+(\d+) @@\n-(.*)\n\+(.*)\n/.exec(patch);
  if (!hunk) return null;
  return side === 'LEFT' ? (Number(hunk[1]) === line ? hunk[3]! : null) : Number(hunk[2]) === line ? hunk[4]! : null;
}
function forgeTakes(body: Record<string, unknown>): Response {
  const commit = String(body.head_sha);
  const patch = forge!.commits.get(commit);
  const gone = () => Response.json({ error: 'The commit you read is no longer on this pull request.', code: 'pull_commit_gone' }, { status: 409 });
  if (patch === undefined) return gone();
  const inline = (body.fileComments ?? []) as { line: number; side: string; body: string }[];
  // GitHub's docs: COMMENT and REQUEST_CHANGES need a body. Its 422 gives no reason the Inbox can use.
  if (!forge!.gitlab && body.action !== 'approve' && !String(body.body ?? '').trim()) return Response.json({ error: 'Failed to submit PR review: gh: Validation Failed (HTTP 422)', code: 'pull_review_failed' }, { status: 502 });
  if (inline.some((c) => codeAt(patch, c.line, c.side) === null)) return gone();
  forge!.reviews.push({ commit, action: body.action, body: String(body.body ?? '') });
  forge!.landed.push(...inline.map((c) => ({ commit, line: c.line, body: c.body, code: codeAt(patch, c.line, c.side) })));
  return Response.json({ ok: true, prUrl: '', submission: { status: 'complete' } });
}
const outdatedAtForge = (head: string, comment: Landed) => codeAt(forge!.commits.get(head)!, comment.line, 'RIGHT') !== comment.code;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  diffHead = A;
  diffReads = 0;
  reader = undefined;
  readerMounts = 0;
  diffHold = null;
  diffCode = 'b';
  diffAt = 12;
  diffFiles = null;
  forge = null;
  diffFails = null;
  postAnswer = null;
  postHold = null;
  posted = [];
  window.localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push({ path: url.pathname, body });
      if (postHold) await postHold;
      const scripted = postAnswer?.(body);
      if (scripted) return scripted;
      if (forge && url.pathname.endsWith('/pulls/review')) return forgeTakes(body);
      return Response.json({ ok: true, prUrl: '', submission: { status: 'complete' } });
    }
    if (url.pathname.endsWith('/pulls/details')) return Response.json({ serverSession: 's', key: url.searchParams.get('key'), description: null, labels: [], reviewers: [], checks: [], comments: [] });
    if (!url.pathname.endsWith('/pulls/diff')) return Response.json({});
    diffReads += 1;
    const scope = url.searchParams.get('scope')!;
    if (diffHold) await diffHold;
    if (diffFails) return Response.json({ error: 'The forge did not answer.', code: diffFails.code }, { status: diffFails.status });
    const patch = `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n@@ -${diffAt} +${diffAt} @@\n-a\n+${diffCode}\n${diffFiles ? `diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-x\n+y\n` : ''}`;
    if (diffHead) forge?.commits.set(diffHead, patch);
    return Response.json({ serverSession: 's', key: url.searchParams.get('key'), scope, base: diffBase, head: 'y', patch, head_sha: diffHead });
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

let reread: (change: (p: InboxPull) => InboxPull) => void = () => {};

function Review({ pulls, layerKey, scope }: { pulls: InboxPull[]; layerKey: string; scope: 'layer' | 'stack' }) {
  const [now, setNow] = useState(pulls);
  reread = (change) => setNow((was) => was.map(change));
  const answer: InboxPullsAnswer = {
    fetched_at: '2026-11-03T09:30:00Z',
    hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
    pulls: now,
    links: Object.fromEntries(now.filter((p) => p.mine).map((p) => [p.key, link])),
    projects: { 'github.com/northwind/billing-svc': ['prj_1'] },
    cards: {},
  };
  return <PullReview model={answer} modelError={null} stackId={now.at(-1)!.key} layerKey={layerKey} scope={scope} onLayer={() => {}} onBack={() => {}} onSent={() => {}} />;
}

function close() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

async function open(pulls: InboxPull[], layer: InboxPull, scope: 'layer' | 'stack' = 'layer') {
  diffBase = scope === 'stack' ? pulls[0]!.base : layer.base;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<SidebarProvider><div className="pn-inbox"><Review pulls={pulls} layerKey={layer.key} scope={scope} /></div></SidebarProvider>);
  });
  await settle();
}

async function work() {
  await act(async () => void reader!.comments!.onSave(GLOBAL));
  await act(async () => void reader!.comments!.onSave(LINE));
  await act(async () => reader!.viewed!.onToggle(PATH));
}

const drawn = () => (reader!.comments!.annotations ?? []).map((c) => c.id).sort();
const onScreen = () => ({
  comments: document.querySelector('.ib-vcomments')?.getAttribute('aria-label'),
  viewed: [...reader!.viewed!.files],
});
const ALL_KEPT = { comments: 'Comments, 2', viewed: [PATH] };
const AFTER_PUSH = { comments: 'Comments, 2', viewed: [] };
const stored = (p: InboxPull, scope: 'layer' | 'stack', suffix: string) => {
  const raw = JSON.parse(window.localStorage.getItem(`${STORE}${p.key}:${scope}:${suffix}`) ?? 'null') as { comments: { id: string }[]; viewed: string[] } | null;
  return raw && { comments: raw.comments.map((c) => c.id).sort(), viewed: raw.viewed };
};
const outdatedIn = (p: InboxPull, scope: 'layer' | 'stack', suffix: string) =>
  (JSON.parse(window.localStorage.getItem(`${STORE}${p.key}:${scope}:${suffix}`) ?? '{"comments":[]}') as { comments: { id: string; outdated?: boolean }[] }).comments.filter((c) => c.outdated).map((c) => c.id);
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

  test.skipIf(!hasDom)(`${scope}: a new head keeps every comment, not the ticks, and reads the diff again`, async () => {
    const { low, top } = layers();
    await open([low, top], top, scope);
    await work();
    const reads = diffReads;
    diffHead = B;
    await act(async () => reread((p) => moved(p, top, { head_sha: B, updated_at: '2026-11-03T10:00:00Z' })));
    await settle();
    expect(onScreen()).toEqual(AFTER_PUSH);
    expect(stored(top, scope, A)).toBeNull();
    expect(stored(top, scope, B)).toEqual({ comments: ['g1', 'l1'], viewed: [] });
    expect(diffReads).toBe(reads + 1);
  });

  test.skipIf(!hasDom)(`${scope}: over a new commit the old patch and its work stay until the read lands, then a new reader comes up`, async () => {
    const { low, top } = layers();
    await open([low, top], top, scope);
    await work();
    const mounts = readerMounts;
    let land = () => {};
    diffHold = new Promise((resolve) => (land = resolve));
    diffHead = B;
    diffCode = 'c';
    await act(async () => reread((p) => moved(p, top, { head_sha: B })));
    await settle();
    expect(document.querySelector('[aria-busy="true"]')?.textContent ?? null).toBeNull();
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(stored(top, scope, A)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
    expect(readerMounts).toBe(mounts);
    await act(async () => land());
    await settle();
    expect(onScreen()).toEqual(AFTER_PUSH);
    expect(readerMounts).toBe(mounts + 1);
  });

  test.skipIf(!hasDom)(`${scope}: a retarget reads again with the reader up and the work kept`, async () => {
    const { low, top } = layers();
    await open([low, top], top, scope);
    await work();
    const reads = diffReads;
    const mounts = readerMounts;
    diffBase = 'trunk';
    await act(async () => reread((p) => (p.key === (scope === 'stack' ? low.key : top.key) ? { ...p, base: 'trunk' } : p)));
    await settle();
    expect(diffReads).toBe(reads + 1);
    expect(readerMounts).toBe(mounts);
    expect(onScreen()).toEqual(ALL_KEPT);
  });

  test.skipIf(!hasDom)(`${scope}: a retarget that changes the code brings a new reader, keeping the work`, async () => {
    const { low, top } = layers();
    await open([low, top], top, scope);
    await work();
    const mounts = readerMounts;
    diffBase = 'trunk';
    diffCode = 'c';
    await act(async () => reread((p) => (p.key === (scope === 'stack' ? low.key : top.key) ? { ...p, base: 'trunk' } : p)));
    await settle();
    expect(readerMounts).toBe(mounts + 1);
    expect(onScreen()).toEqual(ALL_KEPT);
  });

  test.skipIf(!hasDom)(`${scope}: a re-read that fails leaves the patch, the words and Post, says nothing, and goes again on the next list read`, async () => {
    const { low, top } = layers({ mine: false, author: 'tomas' });
    await open([low, top], top, scope);
    await act(async () => void reader!.comments!.onSave(GLOBAL));
    const mounts = readerMounts;
    const reads = diffReads;
    diffFails = { code: 'pull_diff_failed', status: 502 };
    await act(async () => reread((p) => moved(p, top, { head_sha: B })));
    await settle();
    expect(diffReads).toBe(reads + 1);
    expect(readerMounts).toBe(mounts);
    expect(document.querySelector('[data-pull-diff-error]')?.textContent ?? null).toBeNull();
    expect(document.querySelector('[data-review-posts] [data-decision-primary]')).not.toBeNull();
    expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
    diffFails = null;
    diffHead = B;
    diffCode = 'c';
    await act(async () => reread((p) => moved(p, top, { updated_at: '2026-11-03T10:00:00Z' })));
    await settle();
    expect(diffReads).toBe(reads + 2);
    expect(readerMounts).toBe(mounts + 1);
    expect(stored(top, scope, B)).toEqual({ comments: ['g1'], viewed: [] });
  });

  test.skipIf(!hasDom)(`${scope}: a re-read naming no head leaves the patch and the words, and goes again on the next list read`, async () => {
    const { low, top } = layers();
    await open([low, top], top, scope);
    await work();
    const mounts = readerMounts;
    const reads = diffReads;
    diffHead = null;
    diffCode = 'c';
    await act(async () => reread((p) => moved(p, top, { head_sha: B })));
    await settle();
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(readerMounts).toBe(mounts);
    expect(stored(top, scope, A)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
    diffHead = B;
    await act(async () => reread((p) => moved(p, top, { updated_at: '2026-11-03T10:00:00Z' })));
    await settle();
    expect(diffReads).toBe(reads + 2);
    expect(onScreen()).toEqual(AFTER_PUSH);
  });

  test.skipIf(!hasDom)(`${scope}: a first read that fails goes again on the next list read; one too large does not`, async () => {
    const { low, top } = layers();
    diffFails = { code: 'pull_diff_failed', status: 502 };
    await open([low, top], top, scope);
    expect(document.querySelector('[data-pull-diff-error]')).not.toBeNull();
    diffFails = null;
    const reads = diffReads;
    await act(async () => reread((p) => moved(p, top, { updated_at: '2026-11-03T10:00:00Z' })));
    await settle();
    expect(diffReads).toBe(reads + 1);
    expect(document.querySelector('[data-pull-diff-error]')?.textContent ?? null).toBeNull();
    close();
    const other = layers();
    diffFails = { code: 'pull_diff_too_large', status: 413 };
    await open([other.low, other.top], other.top, scope);
    const after = diffReads;
    await act(async () => reread((p) => moved(p, other.top, { updated_at: '2026-11-03T10:00:00Z' })));
    await settle();
    expect(diffReads).toBe(after);
  });

  test.skipIf(!hasDom)(`${scope}: a diff that cannot be read still shows the words kept, and touches none of them`, async () => {
    const { low, top } = layers();
    const legacy = '2026-11-02T08:00:00Z';
    window.localStorage.setItem(`${STORE}${top.key}:${scope}:${legacy}`, JSON.stringify({ comments: [LINE], viewed: [] }));
    window.localStorage.setItem(`${STORE}${top.key}:${scope}:${B}`, JSON.stringify({ comments: [GLOBAL], viewed: [] }));
    diffFails = { code: 'pull_diff_too_large', status: 413 };
    await open([low, top], top, scope);
    expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 2');
    expect(stored(top, scope, legacy)).toEqual({ comments: ['l1'], viewed: [] });
    expect(stored(top, scope, B)).toEqual({ comments: ['g1'], viewed: [] });
  });

  test.skipIf(!hasDom)(`${scope}: head reads failing still show the words kept`, async () => {
    const { low, top } = layers({ head_sha: null });
    window.localStorage.setItem(`${STORE}${top.key}:${scope}:${B}`, JSON.stringify({ comments: [GLOBAL, LINE], viewed: [PATH] }));
    window.localStorage.setItem(`${STORE}${top.key}:${scope}:2026-11-02T08:00:00Z`, JSON.stringify({ comments: [{ ...LINE, id: 'l2' }], viewed: [] }));
    diffHead = null;
    await open([low, top], top, scope);
    expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 3');
    expect(stored(top, scope, B)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
  });

  test.skipIf(!hasDom)(`${scope}: words shown from another head are not shown twice once written, and stay gone once deleted`, async () => {
    const { low, top } = layers();
    window.localStorage.setItem(`${STORE}${top.key}:${scope}:${B}`, JSON.stringify({ comments: [GLOBAL, LINE], viewed: [PATH] }));
    diffHead = null;
    await open([low, top], top, scope);
    await act(async () => void reader!.comments!.onDelete!(GLOBAL.id));
    await act(async () => void reader!.comments!.onDelete!(LINE.id));
    expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
    expect(stored(top, scope, B)).toEqual({ comments: [], viewed: [PATH] });
    close();
    diffHead = null;
    await open([low, top], top, scope);
    expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
  });

  test.skipIf(!hasDom)(`${scope}: the head read failing once or first naming a head leaves the reader on the same code, and no label`, async () => {
    const { low, top } = layers({ head_sha: null });
    diffHead = null;
    await open([low, top], top, scope);
    await work();
    const mounts = readerMounts;
    diffHead = A;
    await act(async () => reread((p) => moved(p, top, { head_sha: A })));
    await settle();
    expect(readerMounts).toBe(mounts);
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(outdatedIn(top, scope, A)).toEqual([]);
  });

  test.skipIf(!hasDom)(`${scope}: a list flipping back to an older head brings back no older patch and deletes nothing`, async () => {
    const { low, top } = layers();
    await open([low, top], top, scope);
    diffHead = B;
    diffCode = 'c';
    await act(async () => reread((p) => moved(p, top, { head_sha: B })));
    await settle();
    await work();
    const mounts = readerMounts;
    await act(async () => reread((p) => moved(p, top, { head_sha: A })));
    await settle();
    expect(readerMounts).toBe(mounts);
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(stored(top, scope, B)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
  });

  test.skipIf(!hasDom)(`${scope}: the list behind the patch: work on the newer patch stays when the list catches up, with no second read`, async () => {
    const { low, top } = layers();
    diffHead = B;
    await open([low, top], top, scope);
    await work();
    const reads = diffReads;
    const mounts = readerMounts;
    await act(async () => reread((p) => moved(p, top, { head_sha: B, updated_at: '2026-11-03T10:00:00Z' })));
    await settle();
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(stored(top, scope, B)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
    expect(diffReads).toBe(reads);
    expect(readerMounts).toBe(mounts);
  });

  test.skipIf(!hasDom)(`${scope}: the list catching up with the patch on another base still reads`, async () => {
    const { low, top } = layers();
    diffHead = B;
    await open([low, top], top, scope);
    await work();
    const reads = diffReads;
    diffBase = 'trunk';
    await act(async () => reread((p) => {
      const on = p.key === (scope === 'stack' ? low.key : top.key) ? { ...p, base: 'trunk' } : p;
      return moved(on, top, { head_sha: B });
    }));
    await settle();
    expect(diffReads).toBe(reads + 1);
    expect(onScreen()).toEqual(ALL_KEPT);
  });

  test.skipIf(!hasDom)(`${scope}: two quick pushes: a list landing on a head still behind the patch deletes nothing`, async () => {
    const C = 'd'.repeat(40);
    const { low, top } = layers();
    diffHead = C;
    await open([low, top], top, scope);
    await work();
    const mounts = readerMounts;
    await act(async () => reread((p) => moved(p, top, { head_sha: B })));
    await settle();
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(stored(top, scope, C)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
    expect(readerMounts).toBe(mounts);
  });

  test.skipIf(!hasDom)(`${scope}: a window that remembers an older diff leaves what another window kept on a newer one`, async () => {
    const { low, top } = layers();
    await open([low, top], top, scope);
    close();
    const reads = diffReads;
    window.localStorage.setItem(`${STORE}${top.key}:${scope}:${B}`, JSON.stringify({ comments: [GLOBAL, LINE], viewed: [PATH] }));
    await open([low, top], top, scope);
    expect(diffReads).toBe(reads);
    expect(stored(top, scope, B)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
  });

  test.skipIf(!hasDom)(`${scope}: work kept on another head moves here once this head is read, even with the key unchanged by the read`, async () => {
    const { low, top } = layers();
    window.localStorage.setItem(`${STORE}${top.key}:${scope}:${B}`, JSON.stringify({ comments: [GLOBAL, LINE], viewed: [PATH] }));
    await open([low, top], top, scope);
    expect(onScreen()).toEqual(AFTER_PUSH);
    expect(stored(top, scope, B)).toBeNull();
  });

  test.skipIf(!hasDom)(`${scope}: a 64-digit head is a head: a new one clears its ticks`, async () => {
    const X = 'a'.repeat(64);
    const Y = 'b'.repeat(64);
    const { low, top } = layers({ head_sha: X });
    diffHead = X;
    await open([low, top], top, scope);
    await work();
    diffHead = Y;
    await act(async () => reread((p) => moved(p, top, { head_sha: Y })));
    await settle();
    expect(onScreen()).toEqual(AFTER_PUSH);
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
    expect(outdatedIn(top, scope, A)).toEqual(['l1']);
  });

  test.skipIf(!hasDom)(`${scope}: what an older Inbox kept on a PR that has not changed since carries no label`, async () => {
    const { low, top } = layers();
    window.localStorage.setItem(`${STORE}${top.key}:${scope}:${top.updated_at}`, JSON.stringify({ comments: [GLOBAL, LINE], viewed: [PATH] }));
    await open([low, top], top, scope);
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(stored(top, scope, A)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
    expect(outdatedIn(top, scope, A)).toEqual([]);
  });

  test.skipIf(!hasDom)(`${scope}: migrating while the list is behind: the old entry moves whole to the patch's head`, async () => {
    const { low, top } = layers();
    diffHead = B;
    window.localStorage.setItem(`${STORE}${top.key}:${scope}:2026-11-02T08:00:00Z`, JSON.stringify({ comments: [GLOBAL, LINE], viewed: [PATH] }));
    await open([low, top], top, scope);
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(stored(top, scope, B)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
  });

  test.skipIf(!hasDom)(`${scope}: a list read naming no head loses nothing; the same head after it keeps, a new one clears the ticks`, async () => {
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
    expect(onScreen()).toEqual(AFTER_PUSH);
    expect(stored(top, scope, A)).toBeNull();
  });
}

test.skipIf(!hasDom)('a list that never named a head: a push seen in the patch clears the ticks; the same patch keeps', async () => {
  const { low, top } = layers({ head_sha: null });
  await open([low, top], top);
  await work();
  const mounts = readerMounts;
  await act(async () => reread((p) => moved(p, top, { updated_at: '2026-11-03T10:00:00Z' })));
  await settle();
  expect(onScreen()).toEqual(ALL_KEPT);
  expect(readerMounts).toBe(mounts);
  diffHead = B;
  await act(async () => reread((p) => moved(p, top, { updated_at: '2026-11-03T11:00:00Z' })));
  await settle();
  expect(onScreen()).toEqual(AFTER_PUSH);
  expect(stored(top, 'layer', A)).toBeNull();
});

test.skipIf(!hasDom)('no head named by the list or the patch: kept while unknown; moved to the first head named, labelled only if the code changed', async () => {
  const { low, top } = layers({ head_sha: null });
  diffHead = null;
  await open([low, top], top, 'stack');
  await work();
  expect(onScreen()).toEqual(ALL_KEPT);
  diffHead = A;
  await act(async () => reread((p) => moved(p, top, { head_sha: A, updated_at: '2026-11-03T10:00:00Z' })));
  await settle();
  expect(onScreen()).toEqual(ALL_KEPT);
  expect(stored(top, 'stack', A)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
  expect(outdatedIn(top, 'stack', A)).toEqual([]);
  diffBase = 'trunk';
  diffCode = 'c';
  await act(async () => reread((p) => (p.key === low.key ? { ...p, base: 'trunk' } : p)));
  await settle();
  expect(outdatedIn(top, 'stack', A)).toEqual(['l1']);
});

async function openPost() {
  await act(async () => document.querySelector<HTMLElement>('[data-review-posts] [data-decision-primary]')!.click());
  await settle();
}
const inDialog = (words: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === words);
  if (!found) throw new Error(`no "${words}" in the dialog: ${[...document.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent).join(' | ')}`);
  return found;
};
const reviews = () => posted.filter((p) => p.path.endsWith('/pulls/review'));
const onlyAt = (head: string) => (body: Record<string, unknown>) =>
  body.head_sha === head ? null : Response.json({ error: 'This pull request has new commits since you read it.', code: 'pull_moved' }, { status: 409 });
async function typeInDialog(words: string) {
  const box = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, words);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const ON_GITLAB = { mine: false, author: 'tomas', platform: 'gitlab', host: 'gitlab.com' } as const;

test.skipIf(!hasDom)('GitLab: a dialog open over a new commit posts at the head its lines are on: refused, with what was typed kept, then rebuilt', async () => {
  const { low, top } = layers(ON_GITLAB);
  await open([low, top], top);
  await work();
  await openPost();
  await typeInDialog('Looks close.');
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  postAnswer = (body) => onlyAt(B)(body) as Response;
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews().map((r) => r.body.head_sha)).toEqual([A]);
  expect(reviews().some((r) => r.body.head_sha === B && (r.body.fileComments as unknown[] | undefined)?.length)).toBe(false);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('new commits since you read it');
  expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!.value).toBe('Looks close.');
  await act(async () => inDialog('Cancel').click());
  await settle();
  posted = [];
  postAnswer = null;
  await openPost();
  expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!.value).toBe('Looks close.');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews()).toHaveLength(1);
  expect(reviews()[0]!.body.head_sha).toBe(B);
  expect(reviews()[0]!.body.fileComments ?? []).toEqual([]);
  expect(String(reviews()[0]!.body.body)).toContain('Looks close.');
  expect(String(reviews()[0]!.body.body)).toContain(GLOBAL.text);
});

test.skipIf(!hasDom)('GitLab: a failed post, a new commit, then Retry Failed: the old lines never go at the new head', async () => {
  const { low, top } = layers(ON_GITLAB);
  await open([low, top], top);
  await work();
  await openPost();
  postAnswer = () => Response.json({ error: 'GitHub refused it.', code: 'pull_review_failed' }, { status: 502 });
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews()).toHaveLength(1);
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  postAnswer = (body) => onlyAt(B)(body) as Response;
  await act(async () => inDialog('Retry Failed').click());
  await settle();
  expect(reviews().map((r) => r.body.head_sha)).toEqual([A, A]);
  await act(async () => inDialog('Cancel').click());
  await settle();
  posted = [];
  postAnswer = null;
  await openPost();
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews().map((r) => r.body.head_sha)).toEqual([B]);
  expect(reviews()[0]!.body.fileComments ?? []).toEqual([]);
});

for (const [what, answer, button] of [
  ['partly posted', () => Response.json({ ok: true, prUrl: '', submission: { status: 'partial', postedFileCommentCount: 0, failedFileComments: [{ comment: { path: PATH, line: 12, side: 'RIGHT', body: LINE.text }, error: 'No such line.' }], reviewBodyPosted: false, approval: 'not-requested', retry: { action: 'comment', fileComments: [{ path: PATH, line: 12, side: 'RIGHT', body: LINE.text }] } } }), 'Review partially posted'],
  ['of unknown result', () => Response.json({ ok: true }), 'Automatic retry blocked'],
] as const) {
  test.skipIf(!hasDom)(`GitLab: a post ${what}, then a new commit: reopening builds a plan of the new head, without the old lines`, async () => {
    const { low, top } = layers(ON_GITLAB);
    await open([low, top], top);
    await work();
    await openPost();
    postAnswer = answer;
    await act(async () => inDialog('Post Comments').click());
    await settle();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(button);
    diffHead = B;
    diffCode = 'c';
    await act(async () => reread((p) => moved(p, top, { head_sha: B })));
    await settle();
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"], [role="dialog"] [data-slot="dialog-close"]')?.click());
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle();
    posted = [];
    postAnswer = null;
    if (!document.querySelector('[role="dialog"]')) await openPost();
    await act(async () => inDialog('Post Comments').click());
    await settle();
    expect(reviews().map((r) => r.body.head_sha)).toEqual([B]);
    expect(reviews()[0]!.body.fileComments ?? []).toEqual([]);
  });
}

test.skipIf(!hasDom)('a post partly posted, the same head: reopening keeps its narrowed retry', async () => {
  const { low, top } = layers({ mine: false, author: 'tomas' });
  await open([low, top], top);
  await work();
  await openPost();
  postAnswer = () => Response.json({ ok: true, prUrl: '', submission: { status: 'partial', postedFileCommentCount: 0, failedFileComments: [{ comment: { path: PATH, line: 12, side: 'RIGHT', body: LINE.text }, error: 'No such line.' }], reviewBodyPosted: false, approval: 'not-requested', retry: { action: 'comment', fileComments: [{ path: PATH, line: 12, side: 'RIGHT', body: LINE.text }] } } });
  await act(async () => inDialog('Post Comments').click());
  await settle();
  await act(async () => inDialog('Close').click());
  await settle();
  await openPost();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Review partially posted');
});

test.skipIf(!hasDom)('a post of unknown result holds the dialog; closed and reopened it can go again, and the Inbox saying it is already there ends it', async () => {
  const { low, top } = layers({ mine: false, author: 'tomas' });
  await open([low, top], top);
  await work();
  await openPost();
  postAnswer = () => Response.json({ ok: true });
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Automatic retry blocked');
  expect(stored(top, 'layer', A)?.comments).toEqual(['g1', 'l1']);
  await act(async () => inDialog('Close').click());
  await settle();
  await openPost();
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Automatic retry blocked');
  postAnswer = () => Response.json({ error: 'This review is already on the pull request.', code: 'already_posted' }, { status: 409 });
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(document.querySelector('[data-pull-review-posted]')?.textContent ?? '').toContain('posted');
  expect(stored(top, 'layer', A)?.comments ?? []).toEqual([]);
});

test.skipIf(!hasDom)('head unknown: an older Inbox entry on a PR updated since is labelled once written', async () => {
  const { low, top } = layers({ head_sha: null });
  diffHead = null;
  window.localStorage.setItem(`${STORE}${top.key}:layer:2026-11-02T08:00:00Z`, JSON.stringify({ comments: [LINE], viewed: [] }));
  await open([low, top], top);
  await act(async () => reader!.viewed!.onToggle(PATH));
  expect(outdatedIn(top, 'layer', top.updated_at)).toEqual(['l1']);
  expect(stored(top, 'layer', top.updated_at)).toEqual({ comments: ['l1'], viewed: [PATH] });
});

test.skipIf(!hasDom)('Whole stack approved, then the list catches up with the patch: still done, and no second Approve', async () => {
  const { low, top } = layers({ mine: false, author: 'tomas' });
  diffHead = B;
  await open([low, top], top, 'stack');
  await openPost();
  await act(async () => inDialog('Approve').click());
  await settle();
  expect(reviews().map((r) => r.body.head_sha)).toEqual([B]);
  expect(document.querySelector('[data-review-posted-done]')).not.toBeNull();
  await act(async () => reread((p) => moved(p, top, { head_sha: B, updated_at: '2026-11-03T10:00:00Z' })));
  await settle();
  expect(document.querySelector('[data-review-posted-done]')).not.toBeNull();
  expect(document.querySelector('[data-review-posts] [data-decision-primary]')?.textContent ?? null).toBeNull();
});

test.skipIf(!hasDom)("a comment from an older Inbox posts in the review body, labelled, never inline on today's line", async () => {
  const { low, top } = layers({ mine: false, author: 'tomas' });
  window.localStorage.setItem(`${STORE}${top.key}:layer:2026-11-02T08:00:00Z`, JSON.stringify({ comments: [LINE], viewed: [] }));
  await open([low, top], top);
  await act(async () => document.querySelector<HTMLElement>('[data-review-posts] [data-decision-primary]')!.click());
  await settle();
  const post = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Post Comments')!;
  await act(async () => post.click());
  await settle();
  const sent = posted.filter((p) => p.path.endsWith('/pulls/review'));
  expect(sent).toHaveLength(1);
  expect(String(sent[0]!.body.body)).toContain('[Outdated');
  expect(String(sent[0]!.body.body)).toContain(LINE.text);
  expect(sent[0]!.body.fileComments ?? []).toEqual([]);
});

test.skipIf(!hasDom)('a comment from an older Inbox reaches the agent labelled too: its line number may point at other code', async () => {
  const { low, top } = layers();
  window.localStorage.setItem(`${STORE}${top.key}:layer:2026-11-02T08:00:00Z`, JSON.stringify({ comments: [LINE], viewed: [] }));
  await open([low, top], top);
  await act(async () => document.querySelector<HTMLElement>('[data-review-decision] [data-decision-primary]')!.click());
  await settle();
  const reply = posted.find((p) => p.path === `/api/inbox/messages/${LAST}/reply`);
  expect(String(reply?.body.feedback)).toContain('[Outdated');
});

test.skipIf(!hasDom)('opened afresh while the list is still behind: work kept on the newer patch is not taken for stale', async () => {
  const { low, top } = layers();
  diffHead = B;
  window.localStorage.setItem(`${STORE}${top.key}:layer:${B}`, JSON.stringify({ comments: [GLOBAL, LINE], viewed: [PATH] }));
  await open([low, top], top);
  expect(onScreen()).toEqual(ALL_KEPT);
});

for (const fails of [true, false]) {
  test.skipIf(!hasDom)(`a patch naming no head keeps its words while the list moves and the read ${fails ? 'fails' : 'waits'}; when the read lands they are labelled, never placed on the new lines`, async () => {
    const { low, top } = layers();
    diffHead = null;
    await open([low, top], top);
    await act(async () => void reader!.comments!.onSave(LINE));
    let land = () => {};
    if (fails) diffFails = { code: 'pull_diff_failed', status: 502 };
    else diffHold = new Promise((resolve) => (land = resolve));
    await act(async () => reread((p) => moved(p, top, { head_sha: B })));
    await settle();
    expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
    await act(async () => void reader!.comments!.onSave({ ...LINE, id: 'l2', lineStart: 20, lineEnd: 20 }));
    expect(stored(top, 'layer', A)?.comments).toEqual(['l1', 'l2']);
    expect(stored(top, 'layer', B)).toBeNull();
    diffFails = null;
    diffHead = B;
    diffCode = 'c';
    await act(async () => land());
    await act(async () => reread((p) => moved(p, top, { updated_at: '2026-11-03T10:00:00Z' })));
    await settle();
    expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 2');
    expect(stored(top, 'layer', A)).toBeNull();
    expect(outdatedIn(top, 'layer', B)).toEqual(['l1', 'l2']);
  });
}

test.skipIf(!hasDom)('other code naming no head after the list moved comes up under the list; the old words stay in view, not on it', async () => {
  const { low, top } = layers();
  diffHead = null;
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
  expect(stored(top, 'layer', A)?.comments).toEqual(['l1']);
  expect(drawn()).toEqual([]);
  await act(async () => void reader!.comments!.onSave({ ...LINE, id: 'l2' }));
  expect(stored(top, 'layer', B)?.comments).toEqual(['l1', 'l2']);
  expect(drawn()).toEqual(['l2']);
});

for (const scope of ['layer', 'stack'] as const) {
  test.skipIf(!hasDom)(`${scope}: an old entry, the list not moved but the forge ahead of it: labelled when it moves to the patch's head`, async () => {
    const { low, top } = layers();
    diffHead = B;
    window.localStorage.setItem(`${STORE}${top.key}:${scope}:${top.updated_at}`, JSON.stringify({ comments: [LINE], viewed: [] }));
    await open([low, top], top, scope);
    expect(stored(top, scope, top.updated_at)).toBeNull();
    expect(outdatedIn(top, scope, B)).toEqual(['l1']);
  });
}

test.skipIf(!hasDom)("an old entry with the forge ahead of the list posts in the review body at the new head, never inline on today's line", async () => {
  const { low, top } = layers({ mine: false, author: 'tomas' });
  diffHead = B;
  window.localStorage.setItem(`${STORE}${top.key}:layer:${top.updated_at}`, JSON.stringify({ comments: [LINE], viewed: [] }));
  await open([low, top], top);
  await openPost();
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews()).toHaveLength(1);
  expect(reviews()[0]!.body.head_sha).toBe(B);
  expect(reviews()[0]!.body.fileComments ?? []).toEqual([]);
  expect(String(reviews()[0]!.body.body)).toContain('[Outdated');
});

test.skipIf(!hasDom)('a remembered diff of an older head is not drawn once a newer one was read: the work on the newer stays in view', async () => {
  const { low, top } = layers();
  await open([low, top], top);
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  await work();
  close();
  const reads = diffReads;
  await open([low, { ...top, head_sha: A }], { ...top, head_sha: A });
  expect(diffReads).toBe(reads + 1);
  expect(onScreen()).toEqual(ALL_KEPT);
  expect(stored(top, 'layer', B)).toEqual({ comments: ['g1', 'l1'], viewed: [PATH] });
});

test.skipIf(!hasDom)('the diff read last is drawn again at once, with no read', async () => {
  const { low, top } = layers();
  await open([low, top], top);
  close();
  const reads = diffReads;
  await open([low, top], top);
  expect(diffReads).toBe(reads);
  expect(reader).toBeDefined();
});

async function openRemembered(fields: Partial<InboxPull> = {}) {
  const { low, top } = layers(fields);
  await open([low, top], top);
  close();
  window.localStorage.setItem(`${STORE}${top.key}:layer:${B}`, JSON.stringify({ comments: [GLOBAL], viewed: [] }));
  await open([low, top], top);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
  return { low, top };
}

test.skipIf(!hasDom)('a verdict takes the words it carried out of the entry they were kept in: they do not come back', async () => {
  const { low, top } = await openRemembered();
  await act(async () => document.querySelector<HTMLElement>('[data-review-decision] [data-decision-primary]')!.click());
  await settle();
  expect(posted.filter((p) => p.path === `/api/inbox/messages/${LAST}/reply`)).toHaveLength(1);
  expect(stored(top, 'layer', B)).toBeNull();
  close();
  await open([low, top], top);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
});

test.skipIf(!hasDom)('a post takes the words that went out of the entry they were kept in: they do not come back', async () => {
  const { low, top } = await openRemembered({ mine: false, author: 'tomas' });
  await openPost();
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(String(reviews()[0]!.body.body)).toContain(GLOBAL.text);
  expect(stored(top, 'layer', B)).toBeNull();
  close();
  await open([low, top], top);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
});

test.skipIf(!hasDom)('the posted banner goes when a new head comes: it spoke of the code before', async () => {
  const { low, top } = layers({ mine: false, author: 'tomas' });
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(GLOBAL));
  await openPost();
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(document.querySelector('[data-pull-review-posted]')).not.toBeNull();
  await act(async () => reread((p) => moved(p, top, { updated_at: '2026-11-03T10:00:00Z' })));
  await settle();
  expect(document.querySelector('[data-pull-review-posted]')).not.toBeNull();
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  expect(document.querySelector('[data-pull-review-posted]')?.textContent ?? null).toBeNull();
});

for (const scope of ['layer', 'stack'] as const) {
  test.skipIf(!hasDom)(`${scope}: a retarget that changes the code, same head: the line comments are labelled, also after a reload; new ones are not`, async () => {
    const { low, top } = layers();
    await open([low, top], top, scope);
    await work();
    diffBase = 'trunk';
    diffCode = 'c';
    const retargeted = (p: InboxPull) => (p.key === (scope === 'stack' ? low.key : top.key) ? { ...p, base: 'trunk' } : p);
    await act(async () => reread(retargeted));
    await settle();
    expect(onScreen()).toEqual(ALL_KEPT);
    expect(outdatedIn(top, scope, A)).toEqual(['l1']);
    await act(async () => void reader!.comments!.onSave({ ...LINE, id: 'l2' }));
    expect(outdatedIn(top, scope, A)).toEqual(['l1']);
    close();
    await open([retargeted(low), retargeted(top)], retargeted(top), scope);
    expect(outdatedIn(top, scope, A)).toEqual(['l1']);
    expect(stored(top, scope, A)?.comments).toEqual(['g1', 'l1', 'l2']);
  });
}

test.skipIf(!hasDom)('a retarget while away: the stamp kept with the comment labels it on the next visit, with nothing written since', async () => {
  const { low, top } = layers();
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  close();
  diffBase = 'trunk';
  diffCode = 'c';
  const after = { ...top, base: 'trunk' };
  await open([low, after], after);
  expect(outdatedIn(top, 'layer', A)).toEqual(['l1']);
});

test.skipIf(!hasDom)('a retarget that changes the code posts its line comments in the review body, none inline', async () => {
  const { low, top } = layers({ mine: false, author: 'tomas' });
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  diffBase = 'trunk';
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { base: 'trunk' })));
  await settle();
  await openPost();
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews().map((r) => r.body.head_sha)).toEqual([A]);
  expect(reviews()[0]!.body.fileComments ?? []).toEqual([]);
  expect(String(reviews()[0]!.body.body)).toContain('[Outdated');
});

test.skipIf(!hasDom)('an older entry, a list naming no head, a read naming one: labelled, and in the review body once the list catches up', async () => {
  const { low, top } = layers({ mine: false, author: 'tomas', head_sha: null });
  diffHead = B;
  window.localStorage.setItem(`${STORE}${top.key}:layer:${top.updated_at}`, JSON.stringify({ comments: [LINE], viewed: [] }));
  await open([low, top], top);
  expect(outdatedIn(top, 'layer', B)).toEqual(['l1']);
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  await openPost();
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews()[0]!.body.fileComments ?? []).toEqual([]);
  expect(String(reviews()[0]!.body.body)).toContain('[Outdated');
});

test.skipIf(!hasDom)('an edit vouches for nothing: an older comment edited while no head is known still gets its label', async () => {
  const { low, top } = layers({ head_sha: null });
  diffHead = null;
  window.localStorage.setItem(`${STORE}${top.key}:layer:${top.updated_at}`, JSON.stringify({ comments: [LINE], viewed: [] }));
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave({ ...LINE, text: 'Cap it at 30 s.' }));
  diffHead = B;
  await act(async () => reread((p) => moved(p, top, { review: 'approved' as InboxPull['review'] })));
  await settle();
  expect(outdatedIn(top, 'layer', B)).toEqual(['l1']);
});

test.skipIf(!hasDom)('an older entry that moved clean is then on that patch: a retarget labels it', async () => {
  const { low, top } = layers();
  window.localStorage.setItem(`${STORE}${top.key}:layer:${top.updated_at}`, JSON.stringify({ comments: [LINE], viewed: [] }));
  await open([low, top], top);
  expect(outdatedIn(top, 'layer', A)).toEqual([]);
  diffBase = 'trunk';
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { base: 'trunk' })));
  await settle();
  expect(outdatedIn(top, 'layer', A)).toEqual(['l1']);
});

test.skipIf(!hasDom)('failing head reads, new code, the list not moved: the old comment reaches the agent labelled', async () => {
  const { low, top } = layers();
  diffHead = null;
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { updated_at: '2026-11-03T10:00:00Z' })));
  await settle();
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
  await act(async () => document.querySelector<HTMLElement>('[data-review-decision] [data-decision-primary]')!.click());
  await settle();
  const reply = posted.find((p) => p.path === `/api/inbox/messages/${LAST}/reply`);
  expect(String(reply?.body.feedback)).toContain('[Outdated');
});

test.skipIf(!hasDom)('failing head reads, the list moved, the same patch: leaving and coming back keeps the line comment, and a verdict carries it', async () => {
  const { low, top } = layers();
  diffHead = null;
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  const after = { ...top, head_sha: B };
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  close();
  await open([low, after], after);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
  expect(stored(top, 'layer', A)?.comments).toEqual(['l1']);
  await act(async () => document.querySelector<HTMLElement>('[data-review-decision] [data-decision-primary]')!.click());
  await settle();
  const reply = posted.find((p) => p.path === `/api/inbox/messages/${LAST}/reply`);
  expect(String(reply?.body.feedback)).toContain(LINE.text);
  expect(stored(top, 'layer', A)).toBeNull();
});

test.skipIf(!hasDom)('opening writes nothing: another head\'s words in view stay where they are until the person writes', async () => {
  const { low, top } = layers();
  diffHead = null;
  window.localStorage.setItem(`${STORE}${top.key}:layer:${B}`, JSON.stringify({ comments: [GLOBAL], viewed: [] }));
  await open([low, top], top);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
  expect(stored(top, 'layer', A)).toBeNull();
  expect(stored(top, 'layer', B)).toEqual({ comments: ['g1'], viewed: [] });
});

test.skipIf(!hasDom)('a diff that cannot be read and a list that stops naming the head: the words under the name in use stay in view', async () => {
  const { low, top } = layers();
  diffFails = { code: 'pull_diff_too_large', status: 502 };
  window.localStorage.setItem(`${STORE}${top.key}:layer:${A}`, JSON.stringify({ comments: [LINE], viewed: [] }));
  await open([low, top], top);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
  await act(async () => reread((p) => moved(p, top, { head_sha: null, updated_at: '2026-11-03T10:00:00Z' })));
  await settle();
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
});

async function refusedOverNewHead() {
  const { low, top } = layers(ON_GITLAB);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  await openPost();
  await typeInDialog('This needs a rethink.');
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  postAnswer = (body) => onlyAt(B)(body) as Response;
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews().map((r) => r.body.head_sha)).toEqual([A]);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('new commits since you read it');
  posted = [];
}

test.skipIf(!hasDom)('GitLab: reopened after a refusal, the words typed for a review stay that review, with the comments in its body', async () => {
  await refusedOverNewHead();
  await act(async () => inDialog('Cancel').click());
  await settle();
  await openPost();
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews().map((r) => [r.body.action, r.body.head_sha])).toEqual([['comment', B]]);
  expect(String(reviews()[0]!.body.body)).toContain('This needs a rethink.');
});

test.skipIf(!hasDom)('GitLab: Retry on a refused plan, the new commit in: sends nothing, and shows the new plan to post', async () => {
  await refusedOverNewHead();
  await act(async () => inDialog('Retry Failed').click());
  await settle();
  expect(reviews()).toEqual([]);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews().map((r) => [r.body.action, r.body.head_sha])).toEqual([['comment', B]]);
  expect(reviews()[0]!.body.fileComments ?? []).toEqual([]);
  expect(String(reviews()[0]!.body.body)).toContain('This needs a rethink.');
});

test.skipIf(!hasDom)('GitLab: Retry on a refused plan, the new commit not read yet: refused again, no plan of a commit nobody read', async () => {
  const { low, top } = layers({ mine: false, author: 'tomas' });
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  await openPost();
  postAnswer = () => Response.json({ error: 'This pull request has new commits since you read it.', code: 'pull_moved' }, { status: 409 });
  await act(async () => inDialog('Post Comments').click());
  await settle();
  await act(async () => inDialog('Retry Failed').click());
  await settle();
  expect(reviews().map((r) => r.body.head_sha)).toEqual([A, A]);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('new commits since you read it');
});

const note = () => document.querySelector('[data-code-annotation-note]')?.textContent ?? null;
const TEAMMATE = { mine: false, author: 'tomas' } as const;
async function pushedOver(change: () => void, fields: Partial<InboxPull> = TEAMMATE) {
  forge = { commits: new Map(), landed: [], reviews: [], gitlab: fields.platform === 'gitlab' };
  const { low, top } = layers(fields);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  diffHead = B;
  change();
  const after = { ...top, head_sha: B };
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  return { low, top, after };
}
const postIt = async () => {
  await openPost();
  await act(async () => inDialog('Post Comments').click());
  await settle();
};

test.skipIf(!hasDom)('a push that leaves the code: the comment stays drawn with no label, and posts at the commit read', async () => {
  const { top } = await pushedOver(() => {});
  expect(drawn()).toEqual(['l1']);
  expect(note()).toBeNull();
  expect(stored(top, 'layer', B)?.comments).toEqual(['l1']);
  await postIt();
  expect(forge!.landed).toEqual([{ commit: A, line: 12, body: LINE.text, code: 'b' }]);
  expect(outdatedAtForge(B, forge!.landed[0]!)).toBe(false);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
});

for (const [what, change] of [
  ['changes the code at its line', () => (diffCode = 'c')],
  ['takes its line out of the diff', () => (diffAt = 40)],
] as const) {
  test.skipIf(!hasDom)(`a push that ${what}: in the panel, labelled, not drawn; it lands on the code it was written on, and the forge calls it outdated`, async () => {
    const { low, after, top } = await pushedOver(change);
    expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
    expect(drawn()).toEqual([]);
    expect(note()).toBe('Written on older code');
    close();
    await open([low, after], after);
    expect(drawn()).toEqual([]);
    expect(note()).toBe('Written on older code');
    expect(stored(top, 'layer', B)?.comments).toEqual(['l1']);
    await postIt();
    expect(forge!.landed).toEqual([{ commit: A, line: 12, body: LINE.text, code: 'b' }]);
    expect(outdatedAtForge(B, forge!.landed[0]!)).toBe(true);
    expect(stored(top, 'layer', B)).toBeNull();
  });
}

test.skipIf(!hasDom)('comments read on two commits, and words: each comment lands at its own commit, the words at the new head', async () => {
  await pushedOver(() => (diffCode = 'c'));
  await act(async () => void reader!.comments!.onSave({ ...LINE, id: 'l2', text: 'On the new code.' }));
  await openPost();
  await typeInDialog('Close, two things.');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(forge!.landed.map((c) => [c.commit, c.body, c.code])).toEqual([
    [A, LINE.text, 'b'],
    [B, 'On the new code.', 'c'],
  ]);
  expect(forge!.reviews.find((r) => r.commit === B)!.body).toContain('Close, two things.');
  expect(forge!.reviews.find((r) => r.commit === A)!.body).not.toContain('Close, two things.');
});

test.skipIf(!hasDom)('an approval with a comment read on an older commit: the comment goes there as a comment, the approval at the head on screen', async () => {
  await pushedOver(() => (diffCode = 'c'));
  await act(async () => document.querySelector<HTMLElement>('[data-review-posts] [data-decision-caret]')!.click());
  await settle();
  const choice = [...document.querySelectorAll<HTMLElement>('[data-decision-popover] button, [data-decision-popover] [role="menuitem"]')].find((b) => /approve/i.test(b.textContent ?? ''));
  if (!choice) throw new Error(`no approve in: ${document.querySelector('[data-decision-popover]')?.textContent}`);
  await act(async () => choice.click());
  await settle();
  await act(async () => inDialog('Approve').click());
  await settle();
  expect(forge!.reviews.map((r) => [r.action, r.commit])).toEqual([
    ['comment', A],
    ['approve', B],
  ]);
  expect(forge!.landed.map((c) => [c.commit, c.code])).toEqual([[A, 'b']]);
});

for (const [what, change, inline, inBody] of [
  ['the same code', () => {}, [{ commit: B, line: 12, body: LINE.text, code: 'b' }], false],
  ['other code', () => (diffCode = 'c'), [], true],
] as const) {
  test.skipIf(!hasDom)(`the commit read has gone (a force-push), ${what}: nothing lost, and nothing on a moved line`, async () => {
    await pushedOver(change);
    forge!.commits.delete(A);
    await postIt();
    expect(forge!.landed).toEqual(inline as unknown as Landed[]);
    const review = forge!.reviews.at(-1)!;
    expect(review.commit).toBe(B);
    expect(review.body.includes('[Outdated')).toBe(inBody);
    expect(review.body.includes(LINE.text)).toBe(inBody);
    expect(document.querySelector('[role="dialog"]')?.textContent ?? null).toBeNull();
    expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
  });
}

for (const [what, change, inline, inBody] of [
  ['the same code goes inline at the head', () => {}, [[B, 'b']], false],
  ['other code goes in the body, labelled', () => (diffCode = 'c'), [], true],
] as const) {
  test.skipIf(!hasDom)(`GitLab, a push: ${what}, and nothing at the older commit`, async () => {
    await pushedOver(change, ON_GITLAB);
    await postIt();
    expect(forge!.landed.map((c) => [c.commit, c.code])).toEqual(inline as unknown as [string, string][]);
    expect(forge!.reviews.map((r) => r.commit)).toEqual([B]);
    expect(forge!.reviews[0]!.body.includes('[Outdated')).toBe(inBody);
  });
}

test.skipIf(!hasDom)('a retarget and a push while away: its lines cannot be vouched for at the commit read, so the body, labelled', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  close();
  diffHead = B;
  diffBase = 'trunk';
  diffCode = 'c';
  const after = { ...top, head_sha: B, base: 'trunk' };
  await open([low, after], after);
  expect(outdatedIn(top, 'layer', B)).toEqual(['l1']);
  await postIt();
  expect(forge!.landed).toEqual([]);
  expect(forge!.reviews.map((r) => r.commit)).toEqual([B]);
  expect(forge!.reviews[0]!.body).toContain('[Outdated');
});

test.skipIf(!hasDom)('a retarget that leaves the line alone, same head: it stays on its line and posts inline', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  diffFiles = 'extra';
  diffBase = 'trunk';
  await act(async () => reread((p) => moved(p, top, { base: 'trunk' })));
  await settle();
  expect(outdatedIn(top, 'layer', A)).toEqual([]);
  expect(drawn()).toEqual(['l1']);
  await postIt();
  expect(forge!.landed.map((c) => [c.commit, c.line])).toEqual([[A, 12]]);
});

test.skipIf(!hasDom)('a dialog open over a push: no refusal, and what was read goes at the commit read', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  await openPost();
  await typeInDialog('As read.');
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(forge!.landed.map((c) => [c.commit, c.code])).toEqual([[A, 'b']]);
  expect(forge!.reviews.map((r) => r.commit)).toEqual([A]);
  expect(document.querySelector('[role="dialog"]')?.textContent ?? null).toBeNull();
});

test.skipIf(!hasDom)('Approve in a dialog open over a push goes at the commit read, and the new head still offers it', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await openPost();
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  await act(async () => inDialog('Approve').click());
  await settle();
  expect(forge!.reviews.map((r) => [r.action, r.commit])).toEqual([['approve', A]]);
  expect(document.querySelector('[data-pull-review-posted]')?.textContent).toContain('Approved on GitHub');
  expect(document.querySelector('[data-review-posted-done]')?.textContent ?? null).toBeNull();
  expect(document.querySelector('[data-review-posts] [data-decision-primary]')?.textContent).toContain('Approve');
});

test.skipIf(!hasDom)('a force-push under an open dialog: refused with the words kept; Retry shows the plan of the new head, nothing approved by itself', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  await openPost();
  await typeInDialog('Kept words.');
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  forge.commits.delete(A);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(forge.reviews).toEqual([]);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('no longer on this pull request');
  await act(async () => inDialog('Retry Failed').click());
  await settle();
  expect(forge.reviews).toEqual([]);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(forge.reviews.map((r) => [r.action, r.commit])).toEqual([['comment', B]]);
  expect(forge.reviews[0]!.body).toContain('Kept words.');
  expect(forge.reviews[0]!.body).toContain('[Outdated');
  expect(forge.reviews[0]!.body).toContain(LINE.text);
});

test.skipIf(!hasDom)('the older comment went and the review failed: it is not posted twice, and the words are still there to send', async () => {
  const { top } = await pushedOver(() => (diffCode = 'c'));
  await openPost();
  await typeInDialog('The words.');
  postAnswer = (body) => (body.head_sha === B ? Response.json({ error: 'GitHub refused it.', code: 'pull_review_failed' }, { status: 502 }) : null);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(forge!.landed.map((c) => c.commit)).toEqual([A]);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
  expect(stored(top, 'layer', B)?.comments ?? []).toEqual([]);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(`#${top.number} — read at ${A.slice(0, 7)}`);
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(`${top.repo}#${top.number} — read at`);
  postAnswer = null;
  await act(async () => inDialog('Retry Failed').click());
  await settle();
  expect(forge!.landed.map((c) => c.commit)).toEqual([A]);
  expect(forge!.reviews.map((r) => r.commit)).toEqual([A, B]);
  expect(forge!.reviews[1]!.body).toContain('The words.');
});

test.skipIf(!hasDom)('the older commit fails for another reason: says so, nothing lost, nothing sent at the head, Retry goes again', async () => {
  await pushedOver(() => (diffCode = 'c'));
  await openPost();
  await typeInDialog('The words.');
  postAnswer = () => Response.json({ error: 'GitHub is down.', code: 'pull_review_failed' }, { status: 502 });
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('GitHub is down.');
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
  postAnswer = null;
  await act(async () => inDialog('Retry Failed').click());
  await settle();
  expect(forge!.reviews.map((r) => r.commit)).toEqual([A, B]);
});

test.skipIf(!hasDom)('after a push the agent reads a comment off this diff as outdated, and one still on it as is', async () => {
  const { low, after } = await pushedOver(() => (diffCode = 'c'), {});
  close();
  await open([low, after], after);
  await act(async () => document.querySelector<HTMLElement>('[data-review-decision] [data-decision-primary]')!.click());
  await settle();
  const reply = posted.find((p) => p.path === `/api/inbox/messages/${LAST}/reply`);
  expect(String(reply?.body.feedback)).toContain('[Outdated');
  expect(String(reply?.body.feedback)).toContain(LINE.text);
});

test.skipIf(!hasDom)('an older Inbox comment labelled stale is not drawn on the diff, and says so in the panel', async () => {
  const { low, top } = layers();
  window.localStorage.setItem(`${STORE}${top.key}:layer:2026-11-02T08:00:00Z`, JSON.stringify({ comments: [LINE], viewed: [] }));
  await open([low, top], top);
  expect(outdatedIn(top, 'layer', A)).toEqual(['l1']);
  expect(drawn()).toEqual([]);
  expect(note()).toBe('Written on older code');
});

test.skipIf(!hasDom)('written while no head was named, the same patch then named, then a push: it posts at the commit that patch named', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers();
  diffHead = null;
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  diffHead = A;
  await act(async () => reread((p) => moved(p, top, { updated_at: '2026-11-03T10:00:00Z' })));
  await settle();
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  await act(async () => document.querySelector<HTMLElement>('[data-review-destination-choice="forge"]')?.click());
  await settle();
  await postIt();
  expect(forge.landed).toEqual([{ commit: A, line: 12, body: LINE.text, code: 'b' }]);
});

test.skipIf(!hasDom)('comments on two older commits, one still there and one gone: one lands, the other is in the review, and neither twice', async () => {
  await pushedOver(() => (diffCode = 'c'));
  await act(async () => void reader!.comments!.onSave({ ...LINE, id: 'l2', text: 'Read at B.' }));
  const C = 'd'.repeat(40);
  diffHead = C;
  diffCode = 'e';
  await act(async () => reread((p) => ({ ...p, head_sha: p.title.endsWith(String(p.number)) && p.base !== 'main' ? C : p.head_sha })));
  await settle();
  forge!.commits.delete(B);
  await postIt();
  expect(forge!.landed.map((c) => [c.commit, c.body])).toEqual([[A, LINE.text]]);
  expect(forge!.reviews.map((r) => r.commit)).toEqual([A, C]);
  expect(forge!.reviews[1]!.body).toContain('[Outdated');
  expect(forge!.reviews[1]!.body).toContain('Read at B.');
  expect(forge!.reviews[1]!.body).not.toContain(LINE.text);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
});

test.skipIf(!hasDom)('the whole stack read before a push: its lines are of the stack, not of one commit, so nothing is posted at the older commit', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top, 'stack');
  await act(async () => void reader!.comments!.onSave(LINE));
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  await postIt();
  expect(forge.reviews.some((r) => r.commit === A)).toBe(false);
  expect(forge.landed.some((c) => c.commit === A)).toBe(false);
  expect(document.body.textContent).not.toContain('read at aaaaaaa');
});

test.skipIf(!hasDom)('after a reload, other code at its line under the same head and base: labelled, and on no line of that commit', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  close();
  const again = { ...top, key: `${top.key}-again` };
  window.localStorage.setItem(`${STORE}${again.key}:layer:${A}`, window.localStorage.getItem(`${STORE}${top.key}:layer:${A}`)!);
  diffCode = 'c';
  await open([low, again], again);
  expect(outdatedIn(again, 'layer', A)).toEqual(['l1']);
  expect(drawn()).toEqual([]);
  expect(note()).toBe('Written on older code');
  await postIt();
  expect(forge.landed).toEqual([]);
  expect(forge.reviews.map((r) => r.commit)).toEqual([A]);
  expect(forge.reviews[0]!.body).toContain('[Outdated');
  expect(forge.reviews[0]!.body).toContain(LINE.text);
});

test.skipIf(!hasDom)('the older comment went and the review at the head was refused: reopened, the words stay a comment, never an Approve', async () => {
  await pushedOver(() => (diffCode = 'c'));
  await openPost();
  await typeInDialog('The words.');
  postAnswer = (body) => (body.head_sha === B ? Response.json({ error: 'This pull request has new commits since you read it.', code: 'pull_moved' }, { status: 409 }) : null);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
  postAnswer = null;
  await act(async () => inDialog('Cancel').click());
  await settle();
  await openPost();
  expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!.value).toBe('The words.');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(forge!.reviews.at(-1)).toMatchObject({ commit: B, action: 'comment' });
  expect(forge!.reviews.at(-1)!.body).toContain('The words.');
});

test.skipIf(!hasDom)('words left in a follow-up nobody sent do not turn a later Approve into a comment', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await openPost();
  await act(async () => inDialog('Approve').click());
  await settle();
  await act(async () => document.querySelector<HTMLElement>('[data-review-post-followup]')!.click());
  await settle();
  await typeInDialog('Half a thought.');
  await act(async () => inDialog('Cancel').click());
  await settle();
  diffHead = B;
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  await openPost();
  expect(inDialog('Approve').textContent).toBe('Approve');
});

const pickVerdict = async (name: RegExp) => {
  await act(async () => document.querySelector<HTMLElement>('[data-review-posts] [data-decision-caret]')!.click());
  await settle();
  const choice = [...document.querySelectorAll<HTMLElement>('[data-decision-popover] button, [data-decision-popover] [role="menuitem"]')].find((b) => name.test(b.textContent ?? ''));
  if (!choice) throw new Error(`no ${name} in: ${document.querySelector('[data-decision-popover]')?.textContent}`);
  await act(async () => choice.click());
  await settle();
};

test.skipIf(!hasDom)('Request changes with every comment on an older commit and no words: the comment there, and the verdict really goes at the head', async () => {
  await pushedOver(() => (diffCode = 'c'));
  await pickVerdict(/Request changes/);
  await act(async () => document.querySelector<HTMLInputElement>('[role="dialog"] input[value="request_changes"]')?.click());
  await settle();
  await act(async () => inDialog('Request Changes').click());
  await settle();
  expect(forge!.reviews.map((r) => [r.action, r.commit])).toEqual([['comment', A], ['request_changes', B]]);
  expect(forge!.reviews[1]!.body).toBe('See inline comments.');
  expect(forge!.landed.map((c) => [c.commit, c.line, c.body])).toEqual([[A, 12, LINE.text]]);
  expect(document.querySelector('[data-pull-review-posted]')?.textContent).toContain('Changes requested on GitHub');
});

test.skipIf(!hasDom)('a comment on lines outside the diff never goes at an older commit: it goes in the main comment at the head, and is sent', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave({ ...LINE, outsideDiff: true }));
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  await postIt();
  expect(forge.landed).toEqual([]);
  expect(forge.reviews.map((r) => r.commit)).toEqual([B]);
  expect(forge.reviews[0]!.body).toContain(LINE.text);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
});

test.skipIf(!hasDom)('a push lands while the post is in flight: what went does not come back on a reload, and never goes twice', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  await openPost();
  let release = () => {};
  postHold = new Promise<void>((done) => (release = done));
  await act(async () => void inDialog('Post Comments').click());
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  expect(stored(top, 'layer', B)?.comments).toEqual(['l1']);
  await act(async () => void reader!.comments!.onSave({ ...LINE, id: 'l3', lineStart: 13, lineEnd: 13, text: 'Written meanwhile.' }));
  postHold = null;
  await act(async () => release());
  await settle();
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
  expect(stored(top, 'layer', B)?.comments).toEqual(['l3']);
  expect(stored(top, 'layer', A)?.comments ?? []).toEqual([]);
  close();
  await open([low, { ...top, head_sha: B }], { ...top, head_sha: B });
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
  expect(forge.landed.map((c) => c.body)).toEqual([LINE.text]);
});

test.skipIf(!hasDom)("another window's comment, come in under an open dialog: not sent, and not lost", async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  await openPost();
  const another = { ...LINE, id: 'l2', text: 'From the other window.', anchorSnapshot: 'x', readHead: B, readBase: top.base };
  window.localStorage.setItem(`${STORE}${top.key}:layer:${B}`, JSON.stringify({ comments: [another], viewed: [] }));
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 2');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(forge.landed.map((c) => c.body)).toEqual([LINE.text]);
  expect(forge.reviews.some((r) => r.body.includes('From the other window.'))).toBe(false);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
  expect(stored(top, 'layer', B)?.comments).toEqual(['l2']);
});

test.skipIf(!hasDom)("another window's comment on the same older commit, come in under an open dialog: not in this plan, so it stays", async () => {
  const { top } = await pushedOver(() => (diffCode = 'c'));
  await openPost();
  const C = 'd'.repeat(40);
  const another = { ...LINE, id: 'l2', text: 'From the other window.', anchorSnapshot: 'x', readHead: A, readBase: top.base };
  window.localStorage.setItem(`${STORE}${top.key}:layer:${C}`, JSON.stringify({ comments: [another], viewed: [] }));
  diffHead = C;
  diffCode = 'e';
  await act(async () => reread((p) => moved(p, top, { head_sha: C })));
  await settle();
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 2');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(forge!.landed.map((c) => c.body)).toEqual([LINE.text]);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 1');
  expect(stored(top, 'layer', C)?.comments).toEqual(['l2']);
});

test.skipIf(!hasDom)('the older review is already there (its answer was lost): it counts as gone, and the verdict and words still go', async () => {
  await pushedOver(() => (diffCode = 'c'));
  await openPost();
  await typeInDialog('The words.');
  postAnswer = (body) => (body.head_sha === A ? Response.json({ error: 'This review is already on the pull request.', code: 'already_posted' }, { status: 409 }) : null);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(forge!.reviews.map((r) => [r.commit, r.body])).toEqual([[B, 'The words.']]);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
  expect(document.querySelector('[data-pull-review-posted]')?.textContent).toContain('Review posted on GitHub');
});

test.skipIf(!hasDom)('an edited comment stays what it was read on: edited before a push, it lands at the commit read', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  await act(async () => void reader!.comments!.onSave({ ...LINE, text: 'Cap it at a minute.' }));
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  await postIt();
  expect(forge.landed).toEqual([{ commit: A, line: 12, body: 'Cap it at a minute.', code: 'b' }]);
});

test.skipIf(!hasDom)('a retarget and a push with the line unchanged: another base, so it lands at the new head, not at the commit read', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  diffHead = B;
  diffBase = 'trunk';
  await act(async () => reread((p) => moved(p, top, { head_sha: B, base: 'trunk' })));
  await settle();
  await postIt();
  expect(forge.landed.map((c) => [c.commit, c.line])).toEqual([[B, 12]]);
});

test.skipIf(!hasDom)('a file-level comment on a file gone from the diff: labelled in the panel, still kept', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave({ ...LINE, id: 'f1', scope: 'file', lineStart: 0, lineEnd: 0, filePath: 'other.ts', text: 'Why this file?' }));
  await act(async () => void reader!.comments!.onSave({ ...LINE, id: 'f2', scope: 'file', lineStart: 0, lineEnd: 0, text: 'This file is fine.' }));
  await act(async () => document.querySelector<HTMLElement>('.ib-vcomments')!.click());
  await settle();
  const notes = [...document.querySelectorAll('[data-code-annotation-note]')].map((n) => n.textContent);
  expect(notes).toEqual(['Written on older code']);
  expect(stored(top, 'layer', A)?.comments.sort()).toEqual(['f1', 'f2']);
});

test.skipIf(!hasDom)('GitHub refuses the older commit with a push under the open dialog: a comment planned for the head still goes there, and nothing is lost', async () => {
  forge = { commits: new Map(), landed: [], reviews: [] };
  const { low, top } = layers(TEAMMATE);
  const C = 'd'.repeat(40);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  diffHead = B;
  diffCode = 'c';
  await act(async () => reread((p) => moved(p, top, { head_sha: B })));
  await settle();
  await act(async () => void reader!.comments!.onSave({ ...LINE, id: 'l2', text: 'Read at B.' }));
  await openPost();
  diffHead = C;
  diffCode = 'e';
  await act(async () => reread((p) => moved(p, top, { head_sha: C })));
  await settle();
  forge.commits.delete(A);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(forge.landed.map((c) => [c.commit, c.body])).toEqual([[B, 'Read at B.']]);
  expect(forge.reviews.map((r) => r.commit)).toEqual([B]);
  expect(forge.reviews[0]!.body).toContain('[Outdated');
  expect(forge.reviews[0]!.body).toContain(LINE.text);
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
});

test.skipIf(!hasDom)('the verdict refused after the older comment went, then Cancel: the header still offers it, and it goes at the head', async () => {
  await pushedOver(() => (diffCode = 'c'));
  await pickVerdict(/Request changes/);
  await act(async () => document.querySelector<HTMLInputElement>('[role="dialog"] input[value="request_changes"]')?.click());
  await settle();
  postAnswer = (body) => (body.head_sha === B ? Response.json({ error: 'GitHub refused it.', code: 'pull_review_failed' }, { status: 502 }) : null);
  await act(async () => inDialog('Request Changes').click());
  await settle();
  expect(forge!.landed.map((c) => c.commit)).toEqual([A]);
  postAnswer = null;
  await act(async () => inDialog('Cancel').click());
  await settle();
  expect(document.querySelector('.ib-vcomments')?.getAttribute('aria-label')).toBe('Comments, 0');
  await pickVerdict(/Request changes/);
  expect(inDialog('Request Changes').disabled).toBe(true);
  await typeInDialog('Please mirror the icons.');
  await act(async () => inDialog('Request Changes').click());
  await settle();
  expect(forge!.reviews.at(-1)).toMatchObject({ commit: B, action: 'request_changes', body: 'Please mirror the icons.' });
  expect(document.querySelector('[data-pull-review-posted]')?.textContent).toContain('Changes requested on GitHub');
});

async function postDialog(kept: readonly Record<string, unknown>[], answer: (head: string) => Response, head = B, fields: Partial<PlatformPostProps['pull']> = {}, anchor: PlatformPostProps['anchor'] = 'diff') {
  const seam: string = '../guide/PlatformPost.tsx';
  const { default: PlatformPost } = (await import(seam)) as { default: ComponentType<PlatformPostProps> };
  const pull = { key: 'github.com/o/r#7', url: 'https://github.com/o/r/pull/7', number: 7, title: 'PR 7', repo: 'o/r', host: 'github.com', platform: 'github' as const, head_sha: head, mine: false };
  const sent: { head: string; inline: string[]; body: string }[] = [];
  const went: string[][] = [];
  const posted: string[][] = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const draw = (comments: readonly Record<string, unknown>[], at: string, opened = true) =>
    act(async () => {
      root!.render(
        <div className="pn-inbox">
          <PlatformPost
            pull={{ ...pull, ...fields, head_sha: at }}
            open={opened ? OPENED : null}
            comments={comments as never}
            anchor={anchor}
            post={async (request) => {
              const body = request as { head_sha: string; fileComments?: { body: string }[]; body?: string };
              sent.push({ head: body.head_sha, inline: (body.fileComments ?? []).map((c) => c.body), body: body.body ?? '' });
              return answer(body.head_sha);
            }}
            onClose={() => {}}
            onWent={(comments) => went.push(comments.map((c) => c.id))}
            onPosted={(result) => posted.push(result.posted.map((c) => c.id))}
          />
        </div>,
      );
    });
  await draw(kept, head);
  await settle();
  return { sent, went, posted, redraw: draw };
}
const OPENED = { action: 'comment', chooseEvent: false } as const;
const TOOK = () => Response.json({ ok: true, prUrl: '', submission: { status: 'complete' } });
const GONE = () => Response.json({ error: 'The commit you read is no longer on this pull request.', code: 'pull_commit_gone' }, { status: 409 });
const FAILED = () => Response.json({ error: 'GitHub refused it.', code: 'pull_review_failed' }, { status: 502 });
const OLD = { ...LINE, id: 'old', text: 'Old words.', postAt: A, postHere: false };
const NOW = { ...LINE, id: 'now', text: 'Words at the head.' };

test.skipIf(!hasDom)('the dialog: a rebuild takes the plan as it stood, not what came in under it; those comments are neither sent nor forgotten', async () => {
  const { sent, went, posted, redraw } = await postDialog([OLD, NOW], (head) => (head === A ? GONE() : TOOK()));
  const C = 'd'.repeat(40);
  const another = { ...LINE, id: 'other', text: 'From the other window.', postAt: A, postHere: false };
  await redraw([OLD, { ...NOW, postAt: B, postHere: false }, another], C);
  await settle();
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(sent.map((s) => s.head)).toEqual([A, B]);
  expect(sent[1]!.inline).toEqual(['Words at the head.']);
  expect(sent[1]!.body).toContain('Old words.');
  expect(JSON.stringify(sent)).not.toContain('From the other window.');
  expect(went).toEqual([]);
  expect(posted).toEqual([['old', 'now']]);
});

test.skipIf(!hasDom)('the dialog: the review at the head refused: only what the older commit took is forgotten, and nothing counts as posted', async () => {
  const { went, posted } = await postDialog([OLD, NOW], (head) => (head === A ? TOOK() : FAILED()));
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(went).toEqual([['old']]);
  expect(posted).toEqual([]);
});

test.skipIf(!hasDom)('the dialog: a comment read on the commit it posts at is an ordinary comment of that review, in one request', async () => {
  const { sent, posted } = await postDialog([{ ...NOW, postAt: B, postHere: true }], TOOK);
  await typeInDialog('The words.');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(sent).toEqual([{ head: B, inline: ['Words at the head.'], body: 'The words.' }]);
  expect(posted).toEqual([['now']]);
});

test.skipIf(!hasDom)('the dialog: both reviews taken: the older comment counts as posted too, so a later review never carries it', async () => {
  const { went, posted } = await postDialog([OLD, NOW], TOOK);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(went).toEqual([['old']]);
  expect(posted).toEqual([['old', 'now']]);
});

const words = (p: InboxPull, suffix: string) => (JSON.parse(window.localStorage.getItem(`${STORE}${p.key}:layer:${suffix}`) ?? '{"comments":[]}') as { comments: { id: string; text: string }[] }).comments.map((c) => c.text).sort();
const inAnotherWindow = (p: InboxPull, suffix: string, change: (comments: { id: string; text: string }[]) => { id: string; text: string }[]) => {
  const name = `${STORE}${p.key}:layer:${suffix}`;
  const was = JSON.parse(window.localStorage.getItem(name)!) as { comments: { id: string; text: string }[]; viewed: string[] };
  window.localStorage.setItem(name, JSON.stringify({ ...was, comments: change(was.comments) }));
  return name;
};
const inline = (body: Record<string, unknown>) => ((body.fileComments ?? []) as { body: string }[]).map((c) => c.body);
const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? '';
const bodyWentLineRefused = () =>
  Response.json({ ok: true, prUrl: '', submission: { status: 'partial', postedFileCommentCount: 0, failedFileComments: [{ comment: { path: PATH, line: 12, side: 'RIGHT', body: LINE.text }, error: 'No such line.' }], reviewBodyPosted: true, approval: 'not-requested', retry: { action: 'comment', fileComments: [{ path: PATH, line: 12, side: 'RIGHT', body: LINE.text }] } } });

test.skipIf(!hasDom)('partly posted, on the page: what went leaves at once; the refused comment edited goes in its new words, once; nothing is left', async () => {
  const { low, top } = layers(ON_GITLAB);
  await open([low, top], top);
  await work();
  await openPost();
  postAnswer = bodyWentLineRefused;
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(String(reviews()[0]!.body.body)).toContain(GLOBAL.text);
  expect(words(top, A)).toEqual([LINE.text]);
  await act(async () => inDialog('Close').click());
  await settle();
  await act(async () => void reader!.comments!.onSave({ ...LINE, text: 'New words.' }));
  await openPost();
  expect(dialogText()).toContain('Review partially posted');
  expect(dialogText()).toContain('New words.');
  expect(dialogText()).not.toContain(LINE.text);
  posted = [];
  postAnswer = null;
  await act(async () => inDialog('Retry Unposted').click());
  await settle();
  expect(reviews().map((r) => inline(r.body))).toEqual([['New words.']]);
  expect(reviews()[0]!.body.body ?? '').toBe('');
  expect(stored(top, 'layer', A)?.comments ?? []).toEqual([]);
  expect(document.querySelector('[data-pull-review-posted]')).not.toBeNull();
});

test.skipIf(!hasDom)('an edit while the post is on its way: the old words went, the new ones stay, on screen and stored, and go next', async () => {
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  await openPost();
  let answer = () => {};
  postHold = new Promise<void>((done) => (answer = done));
  await act(async () => inDialog('Post Comments').click());
  await act(async () => void reader!.comments!.onSave({ ...LINE, text: 'Edited on the way.' }));
  postHold = null;
  await act(async () => answer());
  await settle();
  expect(reviews().map((r) => inline(r.body))).toEqual([[LINE.text]]);
  expect(words(top, A)).toEqual(['Edited on the way.']);
  expect(drawn()).toEqual(['l1']);
  posted = [];
  await act(async () => document.querySelector<HTMLElement>('[data-review-posts] [data-decision-primary]')!.click());
  await settle();
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews().map((r) => inline(r.body))).toEqual([['Edited on the way.']]);
  expect(stored(top, 'layer', A)).toBeNull();
});

test.skipIf(!hasDom)('another window edits a comment under the open dialog: its new words go, and nothing is left', async () => {
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  await openPost();
  inAnotherWindow(top, A, (comments) => comments.map((c) => ({ ...c, text: 'From the other window.' })));
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews().map((r) => inline(r.body))).toEqual([['From the other window.']]);
  expect(stored(top, 'layer', A)).toBeNull();
  expect(drawn()).toEqual([]);
});

test.skipIf(!hasDom)('another window deletes a comment under the open dialog: it does not go; with none left nothing goes and nothing says posted', async () => {
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  await act(async () => void reader!.comments!.onSave({ ...LINE, id: 'l2', text: 'The other one.' }));
  await openPost();
  inAnotherWindow(top, A, (comments) => comments.filter((c) => c.id !== 'l2'));
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews().map((r) => inline(r.body))).toEqual([[LINE.text]]);
  expect(drawn()).toEqual([]);
  close();
  posted = [];
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  await openPost();
  inAnotherWindow(top, A, () => []);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews()).toEqual([]);
  expect(document.querySelector('[data-pull-review-posted]')).toBeNull();
});

test.skipIf(!hasDom)('another window writes: this one shows it, and its next save does not write over it', async () => {
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave(LINE));
  const key = inAnotherWindow(top, A, (comments) => [...comments.map((c) => ({ ...c, text: 'Edited there.' })), { ...LINE, id: 'l2', text: 'Written there.' }]);
  await act(async () => void window.dispatchEvent(new StorageEvent('storage', { key })));
  await settle();
  expect(drawn()).toEqual(['l1', 'l2']);
  await act(async () => void reader!.comments!.onSave({ ...LINE, id: 'l3', text: 'Written here.' }));
  expect(words(top, A)).toEqual(['Edited there.', 'Written here.', 'Written there.']);
});

/** Nothing more can be stored while `run` runs (happy-dom's storage takes no stub of its own method). */
async function withStorageFull(run: () => Promise<void>) {
  const real = window.localStorage;
  const full = new Proxy(real, {
    get(target, name) {
      if (name === 'setItem') return () => { throw new Error('QuotaExceededError'); };
      const value = Reflect.get(target, name) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.defineProperty(window, 'localStorage', { value: full, configurable: true });
  try {
    await run();
  } finally {
    Object.defineProperty(window, 'localStorage', { value: real, configurable: true, writable: true });
  }
}

test.skipIf(!hasDom)('storage full: what this window holds is the only copy, so it goes, and another window saying something does not wipe it', async () => {
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top);
  await withStorageFull(async () => {
    await act(async () => void reader!.comments!.onSave(LINE));
    await act(async () => void window.dispatchEvent(new StorageEvent('storage', { key: `${STORE}${top.key}:layer:${A}` })));
    expect(drawn()).toEqual(['l1']);
    await openPost();
    await act(async () => inDialog('Post Comments').click());
    await settle();
  });
  expect(reviews().map((r) => inline(r.body))).toEqual([[LINE.text]]);
});

test.skipIf(!hasDom)('Whole stack: a typed review went, and the line comment it could only offer to copy stays', async () => {
  const { low, top } = layers(TEAMMATE);
  await open([low, top], top, 'stack');
  await act(async () => void reader!.comments!.onSave(LINE));
  await openPost();
  await typeInDialog('The words.');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews().map((r) => r.body.body)).toEqual(['The words.']);
  expect(stored(top, 'stack', A)?.comments).toEqual(['l1']);
  expect(drawn()).toEqual(['l1']);
});

const FIRST = { ...LINE, id: 'first', text: 'First.', lineStart: 12, lineEnd: 12 };
const SECOND = { ...LINE, id: 'second', text: 'Second.', lineStart: 13, lineEnd: 13 };
const FILE = { ...LINE, id: 'file', scope: 'file', text: 'On the file.' };
const inlineAt = (c: typeof FIRST) => ({ path: PATH, line: c.lineStart, side: 'RIGHT', body: c.text });
const partly = (comments: (typeof FIRST)[], fields: Record<string, unknown> = {}) =>
  Response.json({ ok: true, prUrl: '', submission: { status: 'partial', postedFileCommentCount: 1, failedFileComments: comments.map((c) => ({ comment: inlineAt(c), error: 'No such line.' })), reviewBodyPosted: false, approval: 'not-requested', retry: { action: 'comment', fileComments: comments.map(inlineAt) }, ...fields } });
const ON_GITLAB_DIALOG = { platform: 'gitlab', host: 'gitlab.com' } as const;
const reopen = async (redraw: (comments: readonly Record<string, unknown>[], at: string, opened?: boolean) => Promise<void>, comments: readonly Record<string, unknown>[]) => {
  await redraw(comments, B, false);
  await settle();
  await redraw(comments, B, true);
  await settle();
};

test.skipIf(!hasDom)('the dialog, partly posted: the comment the forge took is forgotten at once and not sent again, with or without a host that drops it', async () => {
  const answers = [() => partly([SECOND]), TOOK];
  const { sent, went, posted, redraw } = await postDialog([FIRST, SECOND], () => answers.shift()!(), B, ON_GITLAB_DIALOG);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(went).toEqual([['first']]);
  expect(posted).toEqual([]);
  await reopen(redraw, [FIRST, SECOND]);
  await act(async () => inDialog('Retry Unposted').click());
  await settle();
  expect(sent.map((s) => s.inline)).toEqual([['First.', 'Second.'], ['Second.']]);
  expect(posted).toEqual([['first', 'second']]);
});

test.skipIf(!hasDom)('the dialog, partly posted, the retry of unknown result: reopening offers the narrowed retry again, and the Inbox saying it is there ends it', async () => {
  const already = () => Response.json({ error: 'This review is already on the pull request.', code: 'already_posted' }, { status: 409 });
  const answers = [() => partly([SECOND]), () => Response.json({ ok: true }), already];
  const { sent, posted, redraw } = await postDialog([FIRST, SECOND], () => answers.shift()!(), B, ON_GITLAB_DIALOG);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  await act(async () => inDialog('Retry Unposted').click());
  await settle();
  expect(dialogText()).toContain('Automatic retry blocked');
  await reopen(redraw, [FIRST, SECOND]);
  await act(async () => inDialog('Retry Unposted').click());
  await settle();
  expect(sent.map((s) => s.inline)).toEqual([['First.', 'Second.'], ['Second.'], ['Second.']]);
  expect(posted).toEqual([['first', 'second']]);
});

test.skipIf(!hasDom)('the dialog, partly posted: a count that disagrees with what it asks for again says nothing went, so nothing is forgotten', async () => {
  const { sent, went, posted, redraw } = await postDialog([FIRST, SECOND], () => partly([SECOND], { postedFileCommentCount: 0 }), B, ON_GITLAB_DIALOG);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(went).toEqual([]);
  await reopen(redraw, [FIRST, SECOND]);
  await act(async () => inDialog('Retry Unposted').click());
  await settle();
  expect(sent.at(-1)!.inline).toEqual(['First.', 'Second.']);
  expect(posted).toEqual([]);
});

test.skipIf(!hasDom)('the dialog, partly posted: the refused comment deleted: nothing is left to retry, nothing goes, and the main comment that went is not sent again', async () => {
  const { sent, posted, redraw } = await postDialog([FIRST, SECOND], () => partly([SECOND], { reviewBodyPosted: true }), B, ON_GITLAB_DIALOG);
  await typeInDialog('The main comment.');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(sent).toHaveLength(1);
  await reopen(redraw, []);
  expect(dialogText()).not.toContain('Review partially posted');
  expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value).toBe('');
  expect(inDialog('Post Comments').disabled).toBe(true);
  expect(sent).toHaveLength(1);
  expect(posted).toEqual([]);
});

test.skipIf(!hasDom)('the dialog, partly posted with the body gone: a comment that rides the body, new since, goes in the retry and only then counts as gone', async () => {
  const answers = [() => partly([SECOND], { reviewBodyPosted: true }), () => partly([SECOND], { reviewBodyPosted: false, postedFileCommentCount: 0, retry: { action: 'comment', fileComments: [inlineAt(SECOND)], body: 'x' } }), TOOK];
  const { sent, went, posted, redraw } = await postDialog([FIRST, SECOND], () => answers.shift()!(), B, ON_GITLAB_DIALOG);
  await typeInDialog('The main comment.');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  await reopen(redraw, [FIRST, SECOND, FILE]);
  await act(async () => inDialog('Retry Unposted').click());
  await settle();
  expect(sent[1]!.inline).toEqual(['Second.']);
  expect(sent[1]!.body).toContain('On the file.');
  expect(sent[1]!.body).not.toContain('The main comment.');
  expect(went).toEqual([['first']]);
  await act(async () => inDialog('Retry Unposted').click());
  await settle();
  expect(posted).toEqual([['first', 'second', 'file']]);
});

test.skipIf(!hasDom)('the dialog, partly posted: a refused comment edited shows its new words among the failures, and one that rides the body is rebuilt too', async () => {
  const answers = [() => partly([SECOND], { reviewBodyPosted: false, postedFileCommentCount: 1, retry: { action: 'comment', fileComments: [inlineAt(SECOND)], body: 'held back' } }), TOOK];
  const { sent, redraw } = await postDialog([FIRST, SECOND, FILE], () => answers.shift()!(), B, ON_GITLAB_DIALOG);
  await act(async () => inDialog('Post Comments').click());
  await settle();
  await reopen(redraw, [FIRST, { ...SECOND, text: 'Second, again.' }, { ...FILE, text: 'On the file, again.' }]);
  expect(dialogText()).toContain('Second, again.');
  expect(dialogText()).not.toContain('Second.');
  await act(async () => inDialog('Retry Unposted').click());
  await settle();
  expect(sent[1]!.inline).toEqual(['Second, again.']);
  expect(sent[1]!.body).toBe(`**${PATH}:** On the file, again.`);
});

test.skipIf(!hasDom)('storage full when a push moves the words to the new head: the old entry keeps them', async () => {
  const { low, top } = layers({ ...TEAMMATE, head_sha: B });
  diffHead = B;
  window.localStorage.setItem(`${STORE}${top.key}:layer:${A}`, JSON.stringify({ comments: [LINE], viewed: [] }));
  await withStorageFull(async () => {
    await open([low, top], top);
    expect(stored(top, 'layer', A)?.comments).toEqual(['l1']);
    expect(drawn()).toEqual(['l1']);
  });
});

const seedSplit = (top: InboxPull) => {
  window.localStorage.setItem(`${STORE}${top.key}:layer:${B}`, JSON.stringify({ comments: [{ ...LINE, text: 'Old words.', readHead: A, readBase: 'main' }], viewed: [] }));
  window.localStorage.setItem(`${STORE}${top.key}:layer:${A}`, JSON.stringify({ comments: [{ ...LINE, text: 'Edited there.', readHead: A, readBase: 'main' }], viewed: [] }));
};
const annotations = () => (reader!.comments!.annotations ?? []) as { id: string; text?: string }[];
const listed = (top: InboxPull) => words(top, B);

test.skipIf(!hasDom)('one comment in two entries in different words: a read moves both to the new head, as two comments, and reading again adds none', async () => {
  const { low, top } = layers({ ...TEAMMATE, head_sha: B });
  diffHead = B;
  seedSplit(top);
  await open([low, top], top);
  expect(listed(top)).toEqual(['Edited there.', 'Old words.']);
  expect(window.localStorage.getItem(`${STORE}${top.key}:layer:${A}`)).toBeNull();
  const ids = JSON.parse(window.localStorage.getItem(`${STORE}${top.key}:layer:${B}`)!).comments.map((c: { id: string }) => c.id);
  expect(new Set(ids).size).toBe(2);
  close();
  await open([low, top], top);
  expect(JSON.parse(window.localStorage.getItem(`${STORE}${top.key}:layer:${B}`)!).comments.map((c: { id: string }) => c.id)).toEqual(ids);
});

test.skipIf(!hasDom)('one comment in two entries in the same words stays one', async () => {
  const { low, top } = layers({ ...TEAMMATE, head_sha: B });
  diffHead = B;
  window.localStorage.setItem(`${STORE}${top.key}:layer:${A}`, JSON.stringify({ comments: [{ ...LINE, readHead: A, readBase: 'main', outdated: true }], viewed: [] }));
  window.localStorage.setItem(`${STORE}${top.key}:layer:${B}`, JSON.stringify({ comments: [{ ...LINE, readHead: A, readBase: 'main' }], viewed: [] }));
  await open([low, top], top);
  expect(listed(top)).toEqual([LINE.text]);
});

for (const [what, stays] of [['the older', 'Edited there.'], ['the edit', 'Old words.']] as const) {
  test.skipIf(!hasDom)(`both versions on screen, with the other entry still there: ${what} deleted does not come back`, async () => {
    const { low, top } = layers({ ...TEAMMATE, head_sha: B });
    diffHead = B;
    await open([low, top], top);
    await act(async () => void reader!.comments!.onSave({ ...LINE, text: 'Old words.' }));
    const key = `${STORE}${top.key}:layer:${A}`;
    window.localStorage.setItem(key, JSON.stringify({ comments: [{ ...LINE, text: 'Edited there.', readHead: A, readBase: 'main' }], viewed: [] }));
    await act(async () => void window.dispatchEvent(new StorageEvent('storage', { key })));
    await settle();
    const gone = annotations().find((c) => c.text !== stays)!;
    expect(annotations().length).toBe(2);
    await act(async () => void reader!.comments!.onDelete?.(gone.id));
    expect(annotations().length).toBe(1);
    close();
    await open([low, top], top);
    expect(annotations().map((c) => c.text)).toEqual([stays]);
  });
}

test.skipIf(!hasDom)('both versions posted from the window that sees both: each goes once, and neither comes back from the other entry', async () => {
  const { low, top } = layers({ ...TEAMMATE, head_sha: B });
  diffHead = B;
  await open([low, top], top);
  await act(async () => void reader!.comments!.onSave({ ...LINE, text: 'Old words.' }));
  const key = `${STORE}${top.key}:layer:${A}`;
  window.localStorage.setItem(key, JSON.stringify({ comments: [{ ...LINE, text: 'Edited there.', readHead: B, readBase: 'main' }], viewed: [] }));
  await act(async () => void window.dispatchEvent(new StorageEvent('storage', { key })));
  await settle();
  await openPost();
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(reviews().flatMap((r) => inline(r.body)).sort()).toEqual(['Edited there.', 'Old words.']);
  expect(words(top, A)).toEqual([]);
  expect(words(top, B)).toEqual([]);
});

const moveTo = async (redraw: (comments: readonly Record<string, unknown>[], at: string, opened?: boolean) => Promise<void>, comments: readonly Record<string, unknown>[], at: string) => {
  await redraw(comments, B, false);
  await settle();
  await redraw(comments, at, true);
  await settle();
};

test.skipIf(!hasDom)('the dialog, partly posted with the main comment gone, then a new commit: the main comment is not sent again', async () => {
  const answers = [() => partly([SECOND], { reviewBodyPosted: true }), TOOK];
  const { sent, redraw } = await postDialog([FIRST, SECOND], () => answers.shift()!(), B, ON_GITLAB_DIALOG);
  await typeInDialog('The main comment.');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  await reopen(redraw, [SECOND]);
  expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value).toBe('The main comment.');
  await moveTo(redraw, [SECOND], 'd'.repeat(40));
  expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value).toBe('');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(sent[1]!.inline).toEqual(['Second.']);
  expect(sent[1]!.body).toBe('');
});

test.skipIf(!hasDom)('the dialog, partly posted with the main comment gone, the retry refused over a new commit: pressing again builds the new plan without it', async () => {
  const moved = () => Response.json({ error: 'This pull request has new commits since you read it.', code: 'pull_moved' }, { status: 409 });
  const answers = [() => partly([SECOND], { reviewBodyPosted: true }), moved, TOOK];
  const { sent, redraw } = await postDialog([FIRST, SECOND], () => answers.shift()!(), B, ON_GITLAB_DIALOG);
  await typeInDialog('The main comment.');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  await act(async () => inDialog('Retry Unposted').click());
  await settle();
  await redraw([SECOND], 'd'.repeat(40));
  await settle();
  await act(async () => inDialog('Retry Unposted').click());
  await settle();
  expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value).toBe('');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(sent.at(-1)!.body).toBe('');
});

test.skipIf(!hasDom)('the dialog, partly posted with the main comment not gone, then a new commit: what was typed stays, to go', async () => {
  const { redraw } = await postDialog([FIRST, SECOND], () => partly([SECOND], { reviewBodyPosted: false, postedFileCommentCount: 1 }), B, ON_GITLAB_DIALOG);
  await typeInDialog('The main comment.');
  await act(async () => inDialog('Post Comments').click());
  await settle();
  await moveTo(redraw, [SECOND], 'd'.repeat(40));
  expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value).toBe('The main comment.');
});

test.skipIf(!hasDom)('over the server limit of file comments: the dialog says so in plain words and nothing is forgotten', async () => {
  const { went, posted } = await postDialog([NOW], () => Response.json({ error: 'fileLevelComments: at most 500 comments, each { path, body }.', field: 'fileLevelComments' }, { status: 422 }));
  await act(async () => inDialog('Post Comments').click());
  await settle();
  expect(dialogText()).toContain('This review has too many file comments to post at once (500 at most). Nothing was sent.');
  expect(dialogText()).not.toContain('fileLevelComments');
  expect(went).toEqual([]);
  expect(posted).toEqual([]);
});
