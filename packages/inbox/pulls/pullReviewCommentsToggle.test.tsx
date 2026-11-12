import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullLink, InboxPullsAnswer } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
let reader: { onShowGlobalComment?: (id: string) => void; onSave: (annotation: Record<string, unknown>) => Promise<boolean>; draftScope: string } | undefined;
if (hasDom) {
  mock.module('#guide-reader', () => ({
    default: (props: { comments?: typeof reader }) => {
      reader = props.comments;
      return null;
    },
  }));
  const seam: string = '../guide/PlatformPost.tsx';
  const real = (await import(seam)) as Record<string, unknown>;
  mock.module('#platform-post', () => real);
}
const { PullReview } = (hasDom ? await import('./PullReview') : {}) as typeof import('./PullReview');

const SHA = 'a'.repeat(40);
const PUSHED = '2026-11-03T09:00:00.000Z';
const STORE = 'plannotator-inbox-pull-review:';

function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  const repo = fields.repo ?? 'northwind/billing-svc';
  return {
    key: `github.com/${repo}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title: `Layer ${number}`,
    author: 'dana',
    mine: true,
    requested: false,
    state: 'open',
    base: 'main',
    head: `b${number}`,
    head_repo: repo,
    additions: 4,
    deletions: 1,
    files: 1,
    review: null,
    approved_by: null,
    reviewers: [],
    checks: 'success',
    updated_at: PUSHED,
    merged_at: null,
    ...fields,
  };
}

const LAST = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const link: InboxPullLink = {
  via: 'url',
  thread_id: 'thr_retries',
  thread_subject: 'Retry the failed charges',
  project_id: 'prj_1',
  agent: { host: 'claude-code', session: 'ses_1', name: null },
  last: { message_id: LAST, preview: 'The stack is up.', at: PUSHED },
  guide: null,
};
const own = [pull(412, { head: 'retry/schedule' }), pull(413, { head: 'retry/backoff', base: 'retry/schedule' })];
const theirs = [
  pull(880, { repo: 'northwind/web-app', mine: false, author: 'tomas', head: 'rtl', head_sha: SHA }),
  pull(881, { repo: 'northwind/web-app', mine: false, author: 'tomas', head: 'rtl-2', base: 'rtl', head_sha: SHA }),
];
const model: InboxPullsAnswer = {
  fetched_at: '2026-11-03T09:30:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [...own, ...theirs],
  links: { [own[0]!.key]: link },
  projects: { 'github.com/northwind/billing-svc': ['prj_1'], 'github.com/northwind/web-app': ['prj_2'] },
  cards: {},
};

const GLOBAL = { id: 'g1', type: 'comment', scope: 'general', filePath: '', lineStart: 0, lineEnd: 0, side: 'new', text: 'Split the retry policy out of this PR.', createdAt: 1 };
const LINE = { id: 'l1', type: 'comment', scope: 'line', filePath: 'src/retry.ts', lineStart: 12, lineEnd: 12, side: 'new', text: 'Cap the backoff.', createdAt: 2 };
const storeKey = (p: InboxPull, scope: 'layer' | 'stack', at = p.head_sha ?? SHA) => `${STORE}${p.key}:${scope}:${at}`;
const keepBoth = (p: InboxPull, scope: 'layer' | 'stack', at?: string) => window.localStorage.setItem(storeKey(p, scope, at), JSON.stringify({ comments: [GLOBAL, LINE], viewed: [] }));

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let savedMatchMedia: typeof window.matchMedia;
const savedRect = hasDom ? HTMLElement.prototype.getBoundingClientRect : undefined;
const { PHONE_QUERY } = (hasDom ? await import('../phone') : {}) as typeof import('../phone');

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  reader = undefined;
  window.localStorage.clear();
  savedMatchMedia = window.matchMedia;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (init?.method === 'POST') {
      posted.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      if (url.pathname.endsWith('/pulls/review')) return Response.json({ ok: true, prUrl: '', submission: { status: 'complete' } });
      return Response.json({ reply: {}, questions: [], replayed: false });
    }
    if (url.pathname.endsWith('/pulls/diff')) {
      const key = url.searchParams.get('key')!;
      const scope = url.searchParams.get('scope')!;
      const patch = 'diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -12 +12 @@\n-a\n+b\n';
      return Response.json({ serverSession: 's', key, scope, base: 'main', head: 'y', patch, ...(scope === 'layer' ? { head_sha: SHA } : {}) });
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
  window.matchMedia = savedMatchMedia;
  HTMLElement.prototype.getBoundingClientRect = savedRect!;
});

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<SidebarProvider><div className="pn-inbox">{node}</div></SidebarProvider>);
  });
}

function Review({ layer, scope }: { layer: InboxPull; scope: 'layer' | 'stack' }) {
  const stackId = (own.some((p) => p.key === layer.key) ? own : theirs).at(-1)!.key;
  return <PullReview model={model} modelError={null} stackId={stackId} layerKey={layer.key} scope={scope} onLayer={() => {}} onBack={() => {}} onSent={() => {}} />;
}

const el = <T extends Element = HTMLElement>(selector: string) => {
  const found = document.querySelector<T>(selector as never);
  if (!found) throw new Error(`${selector} did not render`);
  return found as unknown as T;
};

function paneWidth(width: number) {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const rect = savedRect!.call(this);
    return this.hasAttribute('data-pull-review') ? ({ ...rect.toJSON(), width, right: width } as DOMRect) : rect;
  };
}
function aPhone() {
  window.matchMedia = ((query: string) => ({ matches: query === PHONE_QUERY, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
}
const pane = () => el('[data-pull-review]');
const button = () => el('.ib-vcomments');
const columnOpen = () => {
  const open = button().getAttribute('aria-expanded') === 'true';
  expect(pane().classList.contains('ib-prr-panel-shut')).toBe(!open);
  expect(pane().classList.contains('ib-panel-open')).toBe(false);
  return open;
};
const newComment = (fields: Record<string, unknown>) => ({ type: 'comment', side: 'new', createdAt: 5, ...fields });

test.skipIf(!hasDom)('a wide window: the column starts closed, and the bar\'s Comments button opens and closes it', async () => {
  keepBoth(own[0]!, 'layer');
  paneWidth(1920);
  mount(<Review layer={own[0]!} scope="layer" />);
  await settle();
  expect(pane().classList.contains('ib-fold')).toBe(false);
  expect(button().getAttribute('aria-label')).toBe('Comments, 2');
  expect(columnOpen()).toBe(false);
  await act(async () => button().click());
  expect(columnOpen()).toBe(true);
  expect(document.querySelector('.ib-gpanel .ib-sheet-h')).toBeNull();
  await act(async () => button().click());
  expect(columnOpen()).toBe(false);
});

test.skipIf(!hasDom)('a wide window: a new line comment, and a new global comment, open the closed column', async () => {
  paneWidth(1920);
  mount(<Review layer={theirs[0]!} scope="layer" />);
  await settle();
  expect(columnOpen()).toBe(false);
  await act(async () => void (await reader!.onSave(newComment({ id: 'n1', scope: 'line', filePath: 'src/retry.ts', lineStart: 12, lineEnd: 12, text: 'Why 12?' }))));
  await settle();
  expect(columnOpen()).toBe(true);
  expect(button().getAttribute('aria-label')).toBe('Comments, 1');
  await act(async () => button().click());
  expect(columnOpen()).toBe(false);
  await act(async () => void (await reader!.onSave(newComment({ id: 'n2', scope: 'general', filePath: '', lineStart: 0, lineEnd: 0, text: 'Ship it after the rename.' }))));
  await settle();
  expect(columnOpen()).toBe(true);
  await act(async () => button().click());
  await act(async () => void (await reader!.onSave(newComment({ id: 'n2', scope: 'general', filePath: '', lineStart: 0, lineEnd: 0, text: 'Ship it after the rename, please.' }))));
  await settle();
  expect(columnOpen()).toBe(false);
});

test.skipIf(!hasDom)('a wide window: a global comment chosen in the guide opens the column on it', async () => {
  keepBoth(own[0]!, 'layer');
  paneWidth(1920);
  mount(<Review layer={own[0]!} scope="layer" />);
  await settle();
  expect(columnOpen()).toBe(false);
  await act(async () => reader!.onShowGlobalComment!(GLOBAL.id));
  await settle();
  expect(columnOpen()).toBe(true);
});

test.skipIf(!hasDom)('a phone: the Comments sheet stays closed on a new comment, and its button opens it', async () => {
  aPhone();
  mount(<Review layer={theirs[0]!} scope="layer" />);
  await settle();
  expect(pane().classList.contains('ib-fold')).toBe(true);
  expect(button().getAttribute('aria-expanded')).toBe('false');
  await act(async () => void (await reader!.onSave(newComment({ id: 'n1', scope: 'line', filePath: 'src/retry.ts', lineStart: 12, lineEnd: 12, text: 'Why 12?' }))));
  await settle();
  expect(button().getAttribute('aria-expanded')).toBe('false');
  expect(pane().classList.contains('ib-panel-open')).toBe(false);
  await act(async () => button().click());
  expect(button().getAttribute('aria-expanded')).toBe('true');
  expect(pane().classList.contains('ib-panel-open')).toBe(true);
  expect(pane().classList.contains('ib-prr-panel-shut')).toBe(false);
});
