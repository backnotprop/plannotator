/**
 * "Review layer by layer" with global comments (a comment on the whole review, `scope: 'general'`), with the Inbox's
 * doors stubbed at `fetch`, the diff reader stubbed to hand out its comment seam, and the real review-app dialog.
 * What regresses:
 *
 *  - the agent's reply losing the Global comments section, or putting it after the files';
 *  - a global comment posted from This layer missing the review body;
 *  - a global comment posted from Whole stack marked as a full-stack line comment: listed under "Cannot post inline"
 *    and never posted, then cleared with the line comments that did not go either;
 *  - a new push dropping the global comments with the line comments;
 *  - choosing a global comment in a narrow window not opening the comments sheet.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullLink, InboxPullsAnswer } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
/** The reader's comment seam as the review last gave it. */
let reader: { onShowGlobalComment?: (id: string) => void; draftScope: string } | undefined;
if (hasDom) {
  mock.module('#guide-reader', () => ({
    default: (props: { comments?: typeof reader }) => {
      reader = props.comments;
      return null;
    },
  }));
  // The real review-app dialog and submit, by a path in a variable (the window's strict typecheck must not follow it).
  const seam: string = '../guide/PlatformPost.tsx';
  const real = (await import(seam)) as Record<string, unknown>;
  mock.module('#platform-post', () => real);
}
const { PullReview } = (hasDom ? await import('./PullReview') : {}) as typeof import('./PullReview');

const SHA = 'a'.repeat(40);
/** The head the diff door answers with. */
let diffHead = SHA;
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
/** The person's stack, its thread tied to the bottom layer (no head read: the agent's verdict alone). */
const own = [pull(412, { head: 'retry/schedule' }), pull(413, { head: 'retry/backoff', base: 'retry/schedule' })];
/** A teammate's stack, posted to GitHub (no agent here). */
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
const kept = (key: string) => (JSON.parse(window.localStorage.getItem(key) ?? 'null') as { comments: { id: string }[] } | null)?.comments.map((c) => c.id) ?? null;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  diffHead = SHA;
  reader = undefined;
  window.localStorage.clear();
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
      return Response.json({ serverSession: 's', key, scope, base: 'main', head: 'y', patch, ...(scope === 'layer' ? { head_sha: diffHead } : {}) });
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
});

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<div className="pn-inbox">{node}</div>);
  });
}

/** The review of one layer; `push` moves the layer to a new head commit, as the list and the diff read it again. */
let push: (head: string) => void = () => {};
function Review({ layer, scope }: { layer: InboxPull; scope: 'layer' | 'stack' }) {
  const [answer, setAnswer] = useState(model);
  push = (head) => {
    diffHead = head;
    setAnswer({ ...model, pulls: model.pulls.map((p) => (p.key === layer.key ? { ...p, head_sha: head } : p)) });
  };
  const stackId = (own.some((p) => p.key === layer.key) ? own : theirs).at(-1)!.key;
  return <PullReview model={answer} modelError={null} stackId={stackId} layerKey={layer.key} scope={scope} onLayer={() => {}} onBack={() => {}} onSent={() => {}} />;
}

const el = <T extends Element = HTMLElement>(selector: string) => {
  const found = document.querySelector<T>(selector as never);
  if (!found) throw new Error(`${selector} did not render`);
  return found as unknown as T;
};
const dialogButton = (words: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === words);
  if (!found) throw new Error(`no "${words}" in the dialog: ${[...document.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent).join(' | ')}`);
  return found;
};
const commentCount = () => el('[aria-controls][aria-expanded].ib-vcomments').getAttribute('aria-label');

test.skipIf(!hasDom)("send to the agent: the reply's Global comments come before the files' comments", async () => {
  keepBoth(own[0]!, 'layer');
  mount(<Review layer={own[0]!} scope="layer" />);
  await settle();
  const primary = el('[data-review-decision] [data-decision-primary]');
  expect(primary.textContent).toContain('Send Feedback');
  await act(async () => primary.click());
  await settle();
  expect(posted.map((p) => p.path)).toEqual([`/api/inbox/messages/${LAST}/reply`]);
  const feedback = String(posted[0]!.body.feedback);
  const global = feedback.indexOf('## Global comments');
  expect(global).toBeGreaterThanOrEqual(0);
  expect(feedback.indexOf(GLOBAL.text)).toBeGreaterThan(global);
  expect(feedback.indexOf('## src/retry.ts')).toBeGreaterThan(feedback.indexOf(GLOBAL.text));
  expect(kept(storeKey(own[0]!, 'layer'))).toBeNull();
});

test.skipIf(!hasDom)('post from This layer: the global comment goes in the review body, the line comment inline', async () => {
  keepBoth(theirs[0]!, 'layer');
  mount(<Review layer={theirs[0]!} scope="layer" />);
  await settle();
  await act(async () => el('[data-review-posts] [data-decision-primary]').click());
  await settle();
  await act(async () => dialogButton('Post Comments').click());
  await settle();
  const sent = posted.filter((p) => p.path.endsWith('/pulls/review'));
  expect(sent).toHaveLength(1);
  expect(String(sent[0]!.body.body)).toContain(GLOBAL.text);
  expect(sent[0]!.body.fileComments).toEqual([{ path: 'src/retry.ts', line: 12, side: 'RIGHT', body: LINE.text }]);
  expect(kept(storeKey(theirs[0]!, 'layer'))).toBeNull();
});

test.skipIf(!hasDom)('post from Whole stack: the global comment goes in the body, not under "Cannot post inline"; the line comment stays', async () => {
  keepBoth(theirs[1]!, 'stack');
  mount(<Review layer={theirs[1]!} scope="stack" />);
  await settle();
  await act(async () => el('[data-review-posts] [data-decision-primary]').click());
  await settle();
  // Only the line comment is offered to copy: its lines map to no single PR's diff.
  const dialog = el('[role="dialog"]').textContent ?? '';
  expect(dialog).toContain('Cannot post inline (1)');
  expect(dialog).toContain('1 finding from full-stack view');
  // No main comment typed: the global comment alone is enough to post.
  await act(async () => dialogButton('Post Comments').click());
  await settle();
  const sent = posted.filter((p) => p.path.endsWith('/pulls/review'));
  expect(sent).toHaveLength(1);
  expect(String(sent[0]!.body.body)).toContain(GLOBAL.text);
  expect(String(sent[0]!.body.body)).not.toContain(LINE.text);
  expect(sent[0]!.body.fileComments ?? []).toEqual([]);
  // Only what went is cleared: the line comment is still the person's.
  expect(kept(storeKey(theirs[1]!, 'stack'))).toEqual([LINE.id]);
  expect(commentCount()).toBe('Comments, 1');
});

test.skipIf(!hasDom)('a new push keeps the global comments; the line comments go, as before', async () => {
  keepBoth(own[0]!, 'layer');
  mount(<Review layer={own[0]!} scope="layer" />);
  await settle();
  expect(commentCount()).toBe('Comments, 2');
  const draftScope = reader!.draftScope;
  const later = 'b'.repeat(40);
  act(() => push(later));
  await settle();
  expect(kept(storeKey(own[0]!, 'layer'))).toBeNull();
  expect(kept(storeKey(own[0]!, 'layer', later))).toEqual([GLOBAL.id]);
  expect(commentCount()).toBe('Comments, 1');
  expect(el('[data-review-decision] [data-decision-primary]').textContent).toContain('Send Feedback');
  // The unsaved words of a global comment are kept under the same name across the push.
  expect(reader!.draftScope).toBe(draftScope);
});

test.skipIf(!hasDom)('a narrow window: choosing a global comment in the guide opens the comments sheet on it', async () => {
  keepBoth(own[0]!, 'layer');
  mount(<Review layer={own[0]!} scope="layer" />);
  await settle();
  // Unmeasured (happy-dom) reads as narrow: the panel is folded behind the Comments button.
  const button = el('.ib-vcomments');
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(reader?.onShowGlobalComment).toBeFunction();
  await act(async () => reader!.onShowGlobalComment!(GLOBAL.id));
  await settle();
  expect(el('.ib-vcomments').getAttribute('aria-expanded')).toBe('true');
  expect(el('[data-pull-review]').classList.contains('ib-panel-open')).toBe(true);
});
