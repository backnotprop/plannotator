/**
 * Pull requests in the Inbox, in the window, with the Inbox's doors stubbed
 * at `fetch` and the diff reader stubbed to record what it was given.
 * What regresses:
 *
 *  - "Review layer by layer" opening another diff than the layer's own, the
 *    whole stack asked as one layer, or Next layer not moving up the stack;
 *  - the verdict going anywhere but the agent's thread, or not naming the PR;
 *  - a teammate's PR (no agent thread here) offering a verdict that has
 *    nowhere to go;
 *  - the list not grouped by whose move it is, a stack drawn as several rows,
 *    or the waiting ones not folded.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullLink, InboxPullsAnswer } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const shown: { patch: string; title: string }[] = [];
if (hasDom) {
  mock.module('#guide-reader', () => ({
    default: (props: { snapshot: { review: { rawPatch: string }; guide: { title: string } } }) => {
      shown.push({ patch: props.snapshot.review.rawPatch, title: props.snapshot.guide.title });
      return null;
    },
  }));
}
const { PullReview } = (hasDom ? await import('./PullReview') : {}) as typeof import('./PullReview');
const { PullsPage } = (hasDom ? await import('./PullsPage') : {}) as typeof import('./PullsPage');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

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
    updated_at: '2026-11-03T09:00:00.000Z',
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
  last: { message_id: LAST, preview: 'The stack is up.', at: '2026-11-03T09:00:00.000Z' },
  guide: null,
};

const stack = [
  pull(412, { head: 'retry/schedule' }),
  pull(413, { head: 'retry/backoff', base: 'retry/schedule' }),
  pull(414, { head: 'retry/dunning', base: 'retry/backoff', state: 'draft' }),
];
const model: InboxPullsAnswer = {
  fetched_at: '2026-11-03T09:30:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [
    ...stack,
    pull(880, { repo: 'northwind/web-app', mine: false, requested: true, author: 'tomas', head: 'rtl', updated_at: '2026-11-03T10:00:00.000Z' }),
    pull(872, { repo: 'northwind/web-app', review: 'approved', approved_by: 'priya', head: 'vite' }),
    pull(869, { repo: 'northwind/web-app', reviewers: ['jun'], head: 'locale' }),
  ],
  links: { [stack[2]!.key]: link },
  projects: { 'github.com/northwind/billing-svc': ['prj_1'], 'github.com/northwind/web-app': ['prj_2'] },
  cards: {},
};
const STACK_ID = stack[2]!.key;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let asked: { key: string; scope: string }[] = [];
let posted: { path: string; body: Record<string, unknown> }[] = [];
const liveSession = (session: string, _project: string) => ({ session, host: 'claude-code', started_at: '2026-11-03T08:00:00.000Z', last_seen_at: '2026-11-03T09:59:00.000Z', busy: false, idle_since: null, last_thread: null });
/** Compose's live sessions: one in billing-svc (prj_1), one in another project; launch only when a test sets it. */
let sessionsAnswer: Record<string, unknown> = {};

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  asked = [];
  posted = [];
  sessionsAnswer = {
    serverSession: 's',
    home: '/home/dana',
    projects: [
      { project: { id: 'prj_1', name: 'billing-svc', root: '/home/dana/billing-svc' }, sessions: [liveSession('ses_billing', 'prj_1')] },
      { project: { id: 'prj_3', name: 'docs', root: '/home/dana/docs' }, sessions: [liveSession('ses_docs', 'prj_3')] },
    ],
  };
  shown.length = 0;
  window.localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (init?.method === 'POST') {
      posted.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      if (url.pathname.endsWith('/api/inbox/messages')) return Response.json({ thread_id: 'thr_new', message: {}, replayed: false });
      if (url.pathname.endsWith('/pulls/owner')) return Response.json({ ok: true });
      return Response.json({ reply: {}, questions: [], replayed: false });
    }
    if (url.pathname.endsWith('/api/inbox/sessions')) return Response.json(sessionsAnswer);
    if (url.pathname.endsWith('/pulls/diff')) {
      const key = url.searchParams.get('key')!;
      const scope = url.searchParams.get('scope')!;
      asked.push({ key, scope });
      const patch = `diff --git a/${scope}-${key.split('#')[1]}.ts b/${scope}-${key.split('#')[1]}.ts\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`;
      return Response.json({ serverSession: 's', key, scope, base: scope === 'stack' ? 'main' : 'x', head: 'y', patch });
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

/** The review, with its layer and scope in state as the route keeps them. */
function Review({ stackId, from, answer }: { stackId: string; from: string; answer: InboxPullsAnswer }) {
  const [at, setAt] = useState<{ key: string; scope: 'layer' | 'stack' }>({ key: from, scope: 'layer' });
  return <PullReview model={answer} modelError={null} stackId={stackId} layerKey={at.key} scope={at.scope} onLayer={(key, scope) => setAt({ key, scope })} onBack={() => {}} onSent={() => {}} />;
}

const el = <T extends Element = HTMLElement>(selector: string) => {
  const found = document.querySelector<T>(selector as never);
  if (!found) throw new Error(`${selector} did not render`);
  return found as unknown as T;
};

test.skipIf(!hasDom)('a layer opens its own diff; Whole stack asks for the stack up to it; Next layer moves up', async () => {
  mount(<Review stackId={STACK_ID} from={stack[0]!.key} answer={model} />);
  await settle();
  expect(asked).toEqual([{ key: stack[0]!.key, scope: 'layer' }]);
  expect(shown.at(-1)).toEqual({ patch: expect.stringContaining('layer-412.ts') as unknown as string, title: 'Layer 412' });
  expect(el('[data-pull-review-foot]').textContent).toContain('Layer 1 of 3');

  await act(async () => el<HTMLInputElement>('[data-pull-scope-choice="stack"] input').click());
  await settle();
  expect(asked.at(-1)).toEqual({ key: stack[0]!.key, scope: 'stack' });
  expect(shown.at(-1)!.patch).toContain('stack-412.ts');

  await act(async () => el<HTMLInputElement>('[data-pull-scope-choice="layer"] input').click());
  await settle();
  // Back to the layer: drawn from what was read, not asked again.
  expect(asked).toHaveLength(2);
  expect(shown.at(-1)!.patch).toContain('layer-412.ts');
  await act(async () => el(`[data-pull-next-layer="${stack[1]!.key}"]`).click());
  await settle();
  expect(asked.at(-1)).toEqual({ key: stack[1]!.key, scope: 'layer' });
  expect(shown.at(-1)!.patch).toContain('layer-413.ts');
  expect(el('[data-pull-review]').getAttribute('data-pull-review')).toBe(stack[1]!.key);
  expect(el('[data-pull-review-foot]').textContent).toContain('Layer 2 of 3');
});

test.skipIf(!hasDom)("Approve goes into the agent's thread as a reply to its last message, naming the layer", async () => {
  mount(<Review stackId={STACK_ID} from={stack[0]!.key} answer={model} />);
  await settle();
  await act(async () => el('[data-review-decision] [data-decision-primary]').click());
  await settle();
  expect(posted).toHaveLength(1);
  expect(posted[0]!.path).toBe(`/api/inbox/messages/${LAST}/reply`);
  expect(posted[0]!.body.words).toBe('I approved pull request #412 "Layer 412" (https://github.com/northwind/billing-svc/pull/412).');
  expect(typeof posted[0]!.body.idempotency_key).toBe('string');
});

test.skipIf(!hasDom)("a teammate's PR has no agent thread here: its diff reads without a verdict", async () => {
  const teammate = model.pulls.find((p) => p.number === 880)!;
  mount(<Review stackId={teammate.key} from={teammate.key} answer={model} />);
  await settle();
  expect(asked).toEqual([{ key: teammate.key, scope: 'layer' }]);
  expect(document.querySelector('[data-review-decision]')).toBeNull();
  expect(el<HTMLAnchorElement>('[data-pull-review-forge]').href).toBe(teammate.url);
  expect(document.querySelector('[data-pull-scope-choice]')).toBeNull();
});

test.skipIf(!hasDom)('the list: On you, Ready to land, then the waiting ones folded; a stack is one row with its chain', async () => {
  const opened: string[] = [];
  mount(
    <SidebarProvider>
    <PullsPage
      state={{ model, error: null, loading: false, refresh: () => {}, reload: () => {} }}
      stackId={null}
      project={null}
      projects={[]}
      projectNames={new Map()}
      phone={false}
      onOpenStack={(id) => id && opened.push(id)}
      onProject={() => {}}
      onReview={() => {}}
      onOpenThread={() => {}}
      onOpenGuide={() => {}}
      onLaunch={() => {}}
      onHanded={() => {}}
    />
    </SidebarProvider>,
  );
  await settle();
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-pulls-row]')].filter((r) => r.closest('[hidden]') === null);
  const moves = rows().map((r) => r.getAttribute('data-pulls-move'));
  expect(moves).toEqual(['on_you', 'on_you', 'ready']);
  expect(el('[data-pulls-on-you]').getAttribute('data-pulls-on-you')).toBe('2');
  const stackRow = rows().find((r) => r.getAttribute('data-pulls-layers') === '3')!;
  expect(stackRow).toBeDefined();
  expect(stackRow.querySelectorAll('.ib-pr-chain svg').length).toBe(3);
  expect(stackRow.textContent).toContain('start at #412');
  // The waiting one is folded under its count, and opens on a click.
  const fold = el('.ib-pr-foldbtn');
  expect(fold.textContent).toContain('1 waiting on others');
  await act(async () => fold.click());
  await settle();
  expect(rows().map((r) => r.getAttribute('data-pulls-move'))).toEqual(['on_you', 'on_you', 'ready', 'waiting']);
  await act(async () => stackRow.click());
  expect(opened).toEqual([STACK_ID]);
});

// --- the review's findings (#2590): who a verdict may go to ---

const OTHER_LAST = 'msg_01M4H6G73M9H3Z32T859E72XYZ';
const linkTo = (thread: string, last: string): InboxPullLink => ({ ...link, thread_id: thread, last: { message_id: last, preview: 'Up.', at: '2026-11-03T09:00:00.000Z' } });

test.skipIf(!hasDom)("a teammate's layer in a stack with the person's linked one: no verdict, Open on GitHub", async () => {
  const mine = pull(1, { head: 'b1' });
  const theirs = pull(2, { head: 'b2', base: 'b1', mine: false, requested: true, author: 'tomas' });
  const answer: InboxPullsAnswer = { ...model, pulls: [mine, theirs], links: { [mine.key]: link } };
  mount(<Review stackId={theirs.key} from={theirs.key} answer={answer} />);
  await settle();
  expect(asked).toEqual([{ key: theirs.key, scope: 'layer' }]);
  expect(document.querySelector('[data-review-decision]')).toBeNull();
  expect(el('[data-pull-review-readonly]').getAttribute('data-pull-review-readonly')).toBe('teammate');
  expect(el<HTMLAnchorElement>('[data-pull-review-forge]').href).toBe(theirs.url);
});

test.skipIf(!hasDom)("a layer's verdict goes to its own thread, not the stack's top one", async () => {
  const low = pull(31, { head: 'c1' });
  const top = pull(32, { head: 'c2', base: 'c1' });
  const answer: InboxPullsAnswer = { ...model, pulls: [low, top], links: { [low.key]: linkTo('thr_low', LAST), [top.key]: linkTo('thr_top', OTHER_LAST) } };
  mount(<Review stackId={top.key} from={low.key} answer={answer} />);
  await settle();
  await act(async () => el('[data-review-decision] [data-decision-primary]').click());
  await settle();
  expect(posted.map((p) => p.path)).toEqual([`/api/inbox/messages/${LAST}/reply`]);
  expect(String(posted[0]!.body.words)).toContain('pull request #31');
});

test.skipIf(!hasDom)("an unlinked layer of the person's stack falls back to the stack's thread", async () => {
  const low = pull(41, { head: 'd1' });
  const top = pull(42, { head: 'd2', base: 'd1' });
  const answer: InboxPullsAnswer = { ...model, pulls: [low, top], links: { [top.key]: linkTo('thr_top', OTHER_LAST) } };
  mount(<Review stackId={top.key} from={low.key} answer={answer} />);
  await settle();
  await act(async () => el('[data-review-decision] [data-decision-primary]').click());
  await settle();
  expect(posted.map((p) => p.path)).toEqual([`/api/inbox/messages/${OTHER_LAST}/reply`]);
});

test.skipIf(!hasDom)('comments kept from before a new push are dropped; the ones of this push are kept', async () => {
  const layer = stack[0]!;
  const store = 'plannotator-inbox-pull-review:';
  const comment = { id: 'c1', type: 'comment', filePath: 'a.ts', lineStart: 1, lineEnd: 1, side: 'new', text: 'old line', createdAt: 1 };
  window.localStorage.setItem(`${store}${layer.key}:layer:2026-11-01T00:00:00.000Z`, JSON.stringify({ comments: [comment], viewed: [] }));
  window.localStorage.setItem(`${store}${layer.key}:layer:${layer.updated_at}`, JSON.stringify({ comments: [{ ...comment, id: 'c2' }], viewed: [] }));
  mount(<Review stackId={STACK_ID} from={layer.key} answer={model} />);
  await settle();
  expect(window.localStorage.getItem(`${store}${layer.key}:layer:2026-11-01T00:00:00.000Z`)).toBeNull();
  expect(window.localStorage.getItem(`${store}${layer.key}:layer:${layer.updated_at}`)).not.toBeNull();
});

// --- ownership is explicit (owner direction on #2590): No agent yet, Hand to an agent, Launch an agent ---

function Page({ answer, stackId, onLaunch, onHanded }: { answer: InboxPullsAnswer; stackId: string; onLaunch?: (keys: readonly string[], body: string) => void; onHanded?: (session: string) => void }) {
  return (
    <SidebarProvider>
      <PullsPage
        state={{ model: answer, error: null, loading: false, refresh: () => {}, reload: () => {} }}
        stackId={stackId}
        project={null}
        projects={[]}
        projectNames={new Map()}
        phone={false}
        onOpenStack={() => {}}
        onProject={() => {}}
        onReview={() => {}}
        onOpenThread={() => {}}
        onOpenGuide={() => {}}
        onLaunch={(keys, body) => onLaunch?.(keys, body)}
        onHanded={(session) => onHanded?.(session)}
      />
    </SidebarProvider>
  );
}

test.skipIf(!hasDom)("No agent yet: Hand to an agent lists only the project's live sessions, and the pick starts its thread and keeps it as the stack's", async () => {
  const handed: string[] = [];
  mount(<Page answer={{ ...model, links: {} }} stackId={STACK_ID} onHanded={(s) => handed.push(s)} />);
  await settle();
  expect(el('[data-pulls-no-agent]').textContent).toContain('No agent yet');
  expect(document.querySelector('[data-pulls-reply]')).toBeNull();
  // Launch shows only while the Inbox can launch (compose's sessions answer says so).
  expect(document.querySelector('[data-pulls-launch]')).toBeNull();
  await act(async () => el('[data-pulls-hand]').click());
  await settle();
  const offered = [...document.querySelectorAll('[data-pulls-hand-session]')].map((b) => b.getAttribute('data-pulls-hand-session'));
  expect(offered).toEqual(['ses_billing']);
  await act(async () => el('[data-pulls-hand-session="ses_billing"]').click());
  await settle();
  const start = posted.find((p) => p.path.endsWith('/api/inbox/messages'))!;
  expect(start.body.to).toEqual({ host: 'claude-code', session: 'ses_billing' });
  // The words name every open layer, bottom up, and say verdicts come to this thread.
  const body = String(start.body.body);
  expect(body.split('\n').filter((line) => /^\d\. #/.test(line)).map((line) => line.slice(0, 7))).toEqual(['1. #412', '2. #413', '3. #414']);
  expect(body).toContain(stack[0]!.url);
  const owner = posted.find((p) => p.path.endsWith('/pulls/owner'))!;
  expect(owner.body).toMatchObject({ keys: stack.map((l) => l.key), thread_id: 'thr_new' });
  expect(handed).toEqual(['ses_billing']);
});

test.skipIf(!hasDom)("Launch an agent opens compose with the hand-off's words and the stack's PRs, once the Inbox can launch", async () => {
  sessionsAnswer = { ...sessionsAnswer, launch: { agents: [{ agent: 'claude-code', name: 'Claude Code' }], projects: [] } };
  const launched: { keys: readonly string[]; body: string }[] = [];
  mount(<Page answer={{ ...model, links: {} }} stackId={STACK_ID} onLaunch={(keys, body) => launched.push({ keys, body })} />);
  await settle();
  await act(async () => el('[data-pulls-launch]').click());
  expect(launched).toHaveLength(1);
  expect(launched[0]!.keys).toEqual(stack.map((l) => l.key));
  expect(launched[0]!.body).toContain(stack[2]!.url);
  expect(posted.filter((p) => p.path.endsWith('/api/inbox/messages'))).toHaveLength(0);
});

test.skipIf(!hasDom)("a teammate's PR can be handed over for discussion: the words forbid pushing and approving", async () => {
  const theirs = model.pulls.find((p) => p.number === 880)!;
  sessionsAnswer = { ...sessionsAnswer, projects: [{ project: { id: 'prj_2', name: 'web-app', root: '/home/dana/web-app' }, sessions: [liveSession('ses_web', 'prj_2')] }] };
  mount(<Page answer={{ ...model, links: {} }} stackId={theirs.key} />);
  await settle();
  expect(el('[data-pulls-no-agent]').textContent).toContain('the verdict stays on GitHub');
  await act(async () => el('[data-pulls-hand]').click());
  await settle();
  await act(async () => el('[data-pulls-hand-session="ses_web"]').click());
  await settle();
  const body = String(posted.find((p) => p.path.endsWith('/api/inbox/messages'))!.body.body);
  expect(body).toContain("tomas's");
  expect(body).toMatch(/don't push to the branch, comment on the pull request, or approve it/);
});

test.skipIf(!hasDom)('the Board is optional: no Board chip without a card; a quiet chip when the Board is on and a card links the PR', async () => {
  mount(<Page answer={model} stackId={STACK_ID} />);
  await settle();
  expect(document.querySelector('[data-pulls-card]')).toBeNull();
  expect(document.querySelector('[data-pulls-thread]')).not.toBeNull();
  act(() => root?.unmount());
  host?.remove();
  const opened: string[] = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <SidebarProvider>
          <PullsPage
            state={{ model: { ...model, cards: { [stack[1]!.key]: { id: 'crd_1', title: 'Retries', column: 'in_review' } } }, error: null, loading: false, refresh: () => {}, reload: () => {} }}
            stackId={STACK_ID}
            project={null}
            projects={[]}
            projectNames={new Map()}
            phone={false}
            onOpenStack={() => {}}
            onProject={() => {}}
            onReview={() => {}}
            onOpenThread={() => {}}
            onOpenGuide={() => {}}
            onOpenCard={(id) => opened.push(id)}
            onLaunch={() => {}}
            onHanded={() => {}}
          />
        </SidebarProvider>
      </div>,
    );
  });
  await settle();
  await act(async () => el('[data-pulls-card="crd_1"]').click());
  expect(opened).toEqual(['crd_1']);
});
