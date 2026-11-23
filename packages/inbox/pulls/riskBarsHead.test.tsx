/**
 * The risk bars belong to the head their judgment was made at (approval "review-risk-bars"). The window holds the
 * last risk answer when a read fails, so after a push it can still hold the earlier head's judgment. What regresses:
 *  - that judgment's bars (diff marks, tree marks, the header's "N places") drawn on the new head's diff, against
 *    lines that may say something else now;
 *  - a judgment from a server that sends no head losing its bars on the head the list shows.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPullRiskJudgment, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { model, pull } from './pullReviewFixtures';

const hasDom = typeof document !== 'undefined';
/** What the diff reader was last given to mark at line ends, and the tree's risk files. */
let lineMarks: unknown[] | undefined;
let treeRisk: { files: ReadonlySet<string> } | null | undefined;
if (hasDom) {
  mock.module('#guide-reader', () => ({
    default: (props: { lineMarks?: unknown[] }) => {
      lineMarks = props.lineMarks;
      return null;
    },
    PullChangesTree: (props: { risk?: { files: ReadonlySet<string> } | null }) => {
      treeRisk = props.risk;
      return null;
    },
  }));
  await (await import('./platformPostSeam')).realPlatformPost();
}
const { PullReview } = (hasDom ? await import('./PullReview') : {}) as typeof import('./PullReview');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

const FIRST = '1'.repeat(40);
const PUSHED = '2'.repeat(40);
const theirs = pull(731, { repo: 'northwind/ledger', author: 'ada-novak', mine: false, requested: true, head: 'ledger/rounding' });
const answerAt = (head: string, updated_at: string): InboxPullsAnswer => ({ ...model, pulls: [...model.pulls, { ...theirs, head_sha: head, updated_at }] });
const PATCH = 'diff --git a/src/round.ts b/src/round.ts\n--- a/src/round.ts\n+++ b/src/round.ts\n@@ -1,2 +1,2 @@\n export const places = 2;\n-export const round = Math.floor;\n+export const round = Math.round;\n';
const judgment = (head?: string): InboxPullRiskJudgment => ({
  level: 'high',
  why: 'Every charge rounds another way.',
  where: [{ file: 'src/round.ts', side: 'new', lines: [2, 2], why: 'Rounding changes for every amount.' }],
  ...(head ? { head } : {}),
});

let root: Root;
let host: HTMLElement;
let savedFetch: typeof fetch;
/** The head the diff door reads at, and what the risk door answers (null: it fails). */
let diffHead = FIRST;
let risk: InboxPullRiskJudgment | null = null;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  lineMarks = undefined;
  treeRisk = undefined;
  window.localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (url.pathname.endsWith('/pulls/risk')) {
      if (!risk) return Response.json({ code: 'internal', error: 'The Inbox could not answer.' }, { status: 500 });
      return Response.json({ rules: 'Anything that changes money.', provider: 'pi-sdk', model: null, agents: [], judgments: { [theirs.key]: risk }, failed: {}, pending: 0, last_failure: null });
    }
    if (url.pathname.endsWith('/pulls/diff')) {
      return Response.json({ serverSession: 's', key: theirs.key, scope: 'layer', base: 'main', head: theirs.head, patch: PATCH, head_sha: diffHead });
    }
    if (url.pathname.endsWith('/pulls/details')) return Response.json({ serverSession: 's', key: theirs.key, description: null, labels: [], reviewers: [], checks: [], comments: [] });
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

async function open(answer: InboxPullsAnswer) {
  await act(async () => {
    root.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <PullReview model={answer} modelError={null} stackId={theirs.key} layerKey={theirs.key} scope="layer" onLayer={() => {}} onBack={() => {}} onSent={() => {}} />
        </div>
      </SidebarProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}
const drawn = () => ({ diff: lineMarks?.length ?? 0, tree: treeRisk?.files.size ?? 0, places: host.querySelector('[data-pull-risk-places]') !== null });

test.if(hasDom)('a push, then a risk read that fails: the earlier head’s bars are not drawn on the new diff', async () => {
  diffHead = FIRST;
  risk = judgment(FIRST);
  await open(answerAt(FIRST, '2026-11-03T11:00:00.000Z'));
  expect(drawn()).toEqual({ diff: 1, tree: 1, places: true });
  // A new push: the list and the diff are at the new head, and the next risk read fails, so the window still holds
  // the judgment made at the first head.
  diffHead = PUSHED;
  risk = null;
  await open(answerAt(PUSHED, '2026-11-03T11:05:00.000Z'));
  expect(drawn()).toEqual({ diff: 0, tree: 0, places: false });
});

test.if(hasDom)('a judgment for another head than the diff’s draws nothing; one with no head (an older server) draws as before', async () => {
  diffHead = PUSHED;
  risk = judgment(FIRST);
  await open(answerAt(PUSHED, '2026-11-03T12:00:00.000Z'));
  expect(drawn()).toEqual({ diff: 0, tree: 0, places: false });
  act(() => root.unmount());
  root = createRoot(host);
  risk = judgment();
  await open(answerAt(PUSHED, '2026-11-03T12:05:00.000Z'));
  expect(drawn()).toEqual({ diff: 1, tree: 1, places: true });
});
