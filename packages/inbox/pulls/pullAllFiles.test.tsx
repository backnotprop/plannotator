/**
 * The PR page rail's Changes | All files (the owner's take A on #2639). What regresses:
 *  - the switch missing from the rail's head, or offered with no head commit to list the repository at;
 *  - All files asking for another commit than the patch on screen was read at, or another PR's;
 *  - a file the PR does not change not opening in place of the diff, or the diff not coming back on Changes or on a
 *    changed file picked in All files;
 *  - the review app's reads (`/api/repo-files`, `/api/repo-file`) not reaching the Inbox's routes for this PR, or
 *    anything else (its live stream) being fetched through them;
 *  - the choice not remembered as the review app remembers it.
 * The review app's real tree (guide/PullRepoParts.tsx) draws All files; the diff reader and the file view are stubs.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { pullRepoFetch } from './RailScope';

const hasDom = typeof document !== 'undefined';
const reveals: (string | null)[] = [];
if (hasDom) {
  // By a path in a variable: the window's strict typecheck must not follow it into review-editor.
  const seam: string = '../guide/PullRepoParts.tsx';
  const real = (await import(seam)) as Record<string, unknown>;
  mock.module('#guide-reader', () => ({
    default: (props: { reveal?: { path: string } | null }) => {
      reveals.push(props.reveal?.path ?? null);
      return <div className="w-full" data-stub-reader="" />;
    },
    PullAllFiles: real.PullAllFiles,
    PullRepoFile: (props: { path: string; sha: string; pullKey: string }) => (
      <div className="ib-prp-repofile" data-pull-repo-file={props.path} data-sha={props.sha} data-key={props.pullKey} />
    ),
  }));
}
const { PullReview } = (hasDom ? await import('./PullReview') : {}) as typeof import('./PullReview');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { storage, setStorageBackend, resetStorageBackend } = (hasDom ? await import('@plannotator/ui/utils/storage') : {}) as typeof import('@plannotator/ui/utils/storage');
/** The window's storage, in memory (the test page keeps no cookies). */
const kept = new Map<string, string>();
const { TREE_SCOPE_COOKIE } = (hasDom ? await import('@plannotator/review-editor/hooks/useTreeScope') : {}) as typeof import('@plannotator/review-editor/hooks/useTreeScope');

const HEAD = 'a'.repeat(40);
const LISTED = 'c'.repeat(40);
const pr: InboxPull = {
  key: 'github.com/northwind/billing-svc#412',
  platform: 'github',
  host: 'github.com',
  repo: 'northwind/billing-svc',
  number: 412,
  url: 'https://github.com/northwind/billing-svc/pull/412',
  title: 'Retry the failed charges',
  author: 'dana',
  mine: true,
  requested: false,
  state: 'open',
  base: 'main',
  head: 'retry/schedule',
  head_repo: 'northwind/billing-svc',
  head_sha: LISTED,
  additions: 1,
  deletions: 1,
  files: 1,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: 'success',
  updated_at: '2026-11-03T09:00:00.000Z',
  merged_at: null,
};
const model = (pull: InboxPull): InboxPullsAnswer => ({
  fetched_at: '2026-11-03T09:30:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [pull],
  links: {},
  projects: { 'github.com/northwind/billing-svc': ['prj_1'] },
  cards: {},
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let reads: string[] = [];
/** The head the diff door names (`head_sha`); null: none. */
let diffHead: string | null = HEAD;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  reads = [];
  reveals.length = 0;
  diffHead = HEAD;
  kept.clear();
  setStorageBackend({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v), removeItem: (k) => void kept.delete(k) });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    reads.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/pulls/diff')) {
      const patch = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n';
      return Response.json({ serverSession: 's', key: pr.key, scope: 'layer', base: 'main', head: pr.head, patch, ...(diffHead ? { head_sha: diffHead } : {}) });
    }
    if (url.pathname.endsWith('/pulls/repo-files')) {
      return Response.json({ available: true, revision: { kind: 'commit', label: url.searchParams.get('snapshot')!.slice(0, 7) }, total: 3, live: false, paths: ['README.md', 'src/app.ts', 'src/other.ts'] });
    }
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  resetStorageBackend();
});

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(pull: InboxPull) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <PullReview model={model(pull)} modelError={null} stackId={pull.key} layerKey={pull.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />
        </div>
      </SidebarProvider>,
    );
  });
}
const el = (selector: string) => {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`${selector} did not render`);
  return found;
};
const listed = () => reads.filter((read) => read.includes('/pulls/repo-files'));

test.skipIf(!hasDom)('Changes | All files: the repository at the head read, a file opened in place of the diff, and back', async () => {
  mount(pr);
  await settle();
  // The rail's head is the review app's switch: Changes with the PR's count, on.
  expect(el('[data-tree-scope="changes"]').textContent).toBe('Changes1');
  expect(el('[data-tree-scope="changes"]').getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('[data-review-files]')).not.toBeNull();
  expect(listed()).toEqual([]);

  await act(async () => el('[data-tree-scope="all"]').click());
  await settle();
  // At the head the patch on screen was read at, for this PR, through the Inbox's route.
  expect(listed()).toEqual([`/api/inbox/pulls/repo-files?key=${encodeURIComponent(pr.key)}&snapshot=${HEAD}`]);
  expect(el('[data-tree-scope="all"]').getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('[data-review-files]')).toBeNull();
  // Remembered as the review app remembers it.
  expect(storage.getItem(TREE_SCOPE_COOKIE)).toBe('all');

  // A file the PR does not change opens in place of the diff, at that head.
  await act(async () => el('[data-repo-file="README.md"]').click());
  await settle();
  expect(el('[data-pull-repo-file]').getAttribute('data-pull-repo-file')).toBe('README.md');
  expect(el('[data-pull-repo-file]').getAttribute('data-sha')).toBe(HEAD);
  expect(el('.ib-gbody').hasAttribute('data-repo-open')).toBe(true);

  // A changed file picked in All files: the diff again, on it.
  await act(async () => el('[data-repo-folder="src"]').click());
  await settle();
  await act(async () => el('[data-repo-file="src/app.ts"] button').click());
  await settle();
  expect(document.querySelector('[data-pull-repo-file]')).toBeNull();
  expect(el('.ib-gbody').hasAttribute('data-repo-open')).toBe(false);
  expect(reveals.at(-1)).toBe('src/app.ts');

  // Changes: the PR's own files again, and the diff.
  await act(async () => el('[data-repo-file="README.md"]').click());
  await settle();
  await act(async () => el('[data-tree-scope="changes"]').click());
  await settle();
  expect(document.querySelector('[data-review-files]')).not.toBeNull();
  expect(document.querySelector('[data-pull-repo-file]')).toBeNull();
  expect(storage.getItem(TREE_SCOPE_COOKIE)).toBeNull();
});

test.skipIf(!hasDom)('no head commit known: no switch, the file count as before', async () => {
  diffHead = null;
  const { head_sha: _gone, ...noHead } = pr;
  mount(noHead as InboxPull);
  await settle();
  expect(document.querySelector('[data-tree-scope-switch]')).toBeNull();
  expect(el('.ib-prp-fileshead').textContent).toBe('1 file');
});

test.skipIf(!hasDom)("the review app's reads go to this PR's routes; nothing else goes through them", async () => {
  const asked: string[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return Response.json({});
  }) as typeof fetch;
  try {
    const read = pullRepoFetch('github.com/n/b#7');
    await read('/api/repo-files?snapshot=abc&dir=src');
    await read('/api/repo-file?snapshot=abc&path=src%2Fa.ts');
    await expect(read('/api/repo-files/stream?snapshot=abc')).rejects.toThrow();
    await expect(read('https://example.com/api/repo-files?snapshot=abc')).rejects.toThrow();
  } finally {
    globalThis.fetch = saved;
  }
  expect(asked).toEqual([
    `/api/inbox/pulls/repo-files?key=${encodeURIComponent('github.com/n/b#7')}&snapshot=abc&dir=src`,
    `/api/inbox/pulls/repo-file?key=${encodeURIComponent('github.com/n/b#7')}&snapshot=abc&path=src%2Fa.ts`,
  ]);
});
