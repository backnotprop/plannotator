/**
 * Code review's "Semantic changes" switch in the Inbox (reviewAnalysis.ts): config.json's value, read from the
 * page's first settings read, decides whether a reader gets a semantic client, on an address whose cookie says
 * nothing (or says on); and a change made in the Inbox goes back to config.json.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '@plannotator/ui/config';
import type { SemDiffClient } from '@plannotator/review-editor/semDiff/semDiffClient';
import { loadSemDiffAdvert, resetSemDiffAdvertForTests } from './semDiffAdvert';
import { readSettingsAtLoad, takeSettingsAtLoad } from './settingsAtLoad';
import { resetReviewAnalysisForTests } from './reviewAnalysis';
import { inboxServerSync } from './theme';
import { useSemDiffClient } from './guide/useSemDiffClient';

const hasDom = typeof document !== 'undefined';
const realFetch = globalThis.fetch;
const roots: Root[] = [];

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const ADVERT = { advert: { runtime: '/assets/sem-diff/runtime.js', grammars: { typescript: '/assets/sem-diff/typescript.wasm' } } };

/** The Inbox's routes: the engine's advert at once, the settings read when `answerSettings` is called. */
function fakeInbox(): { answerSettings: (semantic: boolean | null) => void; posts: Record<string, unknown>[] } {
  let answer: (body: unknown) => void = () => {};
  const settings = new Promise<unknown>((resolve) => {
    answer = resolve;
  });
  const posts: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/inbox/sem-diff')) return json(ADVERT);
    if (url.includes('/api/inbox/settings') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({});
    }
    if (url.includes('/api/inbox/settings')) return json(await settings);
    return new Response('not here', { status: 404 });
  }) as unknown as typeof fetch;
  return { answerSettings: (semantic) => answer({ review_analysis: { semantic_diff: semantic } }), posts };
}

function Probe({ seen }: { seen: (SemDiffClient | null)[] }) {
  seen.push(useSemDiffClient());
  return null;
}

async function reader(): Promise<(SemDiffClient | null)[]> {
  const seen: (SemDiffClient | null)[] = [];
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  await act(async () => root.render(<Probe seen={seen} />));
  return seen;
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  takeSettingsAtLoad()?.catch(() => {});
  globalThis.fetch = realFetch;
  resetSemDiffAdvertForTests();
  resetReviewAnalysisForTests();
  configStore.seed('diffSemantic', true);
  configStore.seed('semanticDiffEnabled', true);
});

test.skipIf(!hasDom)('"Semantic changes" off in config.json: a reader on an address whose cookie says on never gets a semantic client', async () => {
  resetSemDiffAdvertForTests();
  resetReviewAnalysisForTests();
  configStore.seed('diffSemantic', true);
  configStore.seed('semanticDiffEnabled', true);
  const inbox = fakeInbox();
  await loadSemDiffAdvert();
  readSettingsAtLoad();
  // The reader draws while the settings read is still out.
  const seen = await reader();
  inbox.answerSettings(false);
  await settle();
  expect(configStore.get('semanticDiffEnabled')).toBe(false);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((client) => client === null)).toBe(true);
});

test.skipIf(!hasDom)('"Semantic changes" on in config.json: the reader gets its client once the settings read answers', async () => {
  resetSemDiffAdvertForTests();
  resetReviewAnalysisForTests();
  configStore.seed('diffSemantic', true);
  configStore.seed('semanticDiffEnabled', false);
  const inbox = fakeInbox();
  await loadSemDiffAdvert();
  readSettingsAtLoad();
  const seen = await reader();
  inbox.answerSettings(true);
  await settle();
  expect(configStore.get('semanticDiffEnabled')).toBe(true);
  expect(seen.at(-1)).not.toBeNull();
});

test.skipIf(!hasDom)('turning "Semantic changes" off in the Inbox writes config.json through the settings route', async () => {
  const inbox = fakeInbox();
  inboxServerSync({ reviewAnalysis: { semanticDiff: false } });
  await settle();
  expect(inbox.posts.map((body) => body.review_analysis)).toEqual([{ semantic_diff: false }]);
});
