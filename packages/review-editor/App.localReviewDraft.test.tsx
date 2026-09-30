/** Real App switch wiring: a late response must not release autosave over an
 * unread draft or replace the newer target. Only the Vite worker is stubbed. */
import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import { configStore } from '@plannotator/ui/config';
import type { CodeAnnotation } from '@plannotator/ui/types';

mock.module('./workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));
const hasDom = typeof document !== 'undefined';
const App = hasDom ? (await import('./App')).default : null!;
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  resetStorageBackend();
});

const HEAD = '1'.repeat(40);
const PARENT = '2'.repeat(40);
const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
const view = (target: string, diffType = 'since-base') => ({
  rawPatch: patch, gitRef: 'HEAD', snapshotId: `snapshot-${target}`,
  localDraftTarget: target, origin: 'claude-code', diffType, base: 'main',
  gitContext: {
    vcsType: 'git', currentBranch: 'feature', defaultBranch: 'main', worktrees: [],
    diffOptions: [{ id: 'since-base', label: 'All changes' }],
  },
  draftState: { found: true, draftGeneration: 20 },
});
const note = (target: string): CodeAnnotation => ({
  id: target, type: 'comment', scope: 'general', filePath: '', lineStart: 0, lineEnd: 0,
  side: 'new', text: `Feedback on ${target}`, createdAt: 1, localReviewTarget: target,
});
const tick = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 60 && !check(); i++) await tick();
  expect(check()).toBe(true);
}
const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
  .find(b => b.textContent?.trim() === text);

class StubEventSource {
  readyState = 1;
  onmessage = null;
  onerror = null;
  onopen = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

for (const lateResponse of ['superseded', 'failure', 'success'] as const) {
  test.skipIf(!hasDom)(`a late ${lateResponse} switch cannot discard the newer target's unread comments`, async () => {
    const memory = new Map<string, string>([
      ['plannotator-plan-look-choice-resolved', 'true'],
      ['plannotator-announce-tui-herdr-seen', '1'],
      ['plannotator-guide-intro-seen', '2'],
      ['plannotator-guide-hint-acked', 'true'],
      ['plannotator-edit-mode-announcement-seen', '3'],
      ['plannotator-token-hover-announcement-seen', '1'],
      ['plannotator-review-dest-spotlight-seen', '1'],
    ]);
    setStorageBackend({
      getItem: key => memory.get(key) ?? null,
      setItem: (key, value) => { memory.set(key, value); },
      removeItem: key => { memory.delete(key); },
    });
    configStore.loadFromBackend();
    let finishOldSwitch!: (response: Response) => void;
    let finishDraftLoad!: (response: Response) => void;
    const writes: Array<{ target: string | null; ids: string[] }> = [];
    const clients = new Set<string | null>();
    let decisionClient: string | null | undefined;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/diff') return Response.json(view('local-a'));
      if (url.pathname === '/api/diff/switch') {
        const { diffType } = JSON.parse(String(init?.body));
        if (diffType === `commit:${HEAD}`) return new Promise<Response>(resolve => { finishOldSwitch = resolve; });
        return Response.json(view('local-c', diffType));
      }
      if (url.pathname === '/api/draft') {
        clients.add(url.searchParams.get('client'));
        const target = url.searchParams.get('target');
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          writes.push({ target, ids: body.codeAnnotations.map((a: CodeAnnotation) => a.id) });
          return Response.json({ ok: true });
        }
        if (target === 'local-c') return new Promise<Response>(resolve => { finishDraftLoad = resolve; });
        return Response.json({ codeAnnotations: [note('local-a')], draftGeneration: 1, ts: Date.now() });
      }
      if (url.pathname === '/api/commits') return Response.json({
        commits: [HEAD, PARENT].map((sha, i) => ({
          sha, shortSha: sha.slice(0, 7), subject: `Commit ${i}`, author: 'Test',
          authorEmail: 'test@example.invalid', committedAt: 1, isHead: i === 0, isPastBase: false,
        })), hasMore: false, base: 'main',
      });
      if (url.pathname === '/api/feedback') {
        decisionClient = url.searchParams.get('client');
        return Response.json({ ok: true });
      }
      if (url.pathname === '/api/diff/fresh') return Response.json({ fresh: true });
      if (url.pathname === '/api/ai/capabilities') return Response.json({ available: false, providers: [] });
      return Response.json({});
    }) as typeof fetch;
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<App />));
    await waitFor(() => !!button('Restore'));
    await act(async () => button('Restore')!.click());
    await act(async () => button('Commits')!.click());
    await waitFor(() => !!finishOldSwitch);
    // Commit clicks stay enabled during loading: start a newer switch to C.
    await act(async () => document.querySelector<HTMLButtonElement>(`button[title^="${PARENT}"]`)!.click());
    await waitFor(() => !!finishDraftLoad);
    await act(async () => finishOldSwitch(lateResponse === 'superseded'
      ? Response.json({ superseded: true })
      : lateResponse === 'failure'
        ? Response.json({ error: 'failed' }, { status: 500 })
        : Response.json(view('local-b', `commit:${HEAD}`))));
    await tick(650);
    expect(writes.filter(w => w.target !== 'local-a')).toEqual([]);
    await act(async () => finishDraftLoad(Response.json({
      codeAnnotations: [note('local-c')], draftGeneration: 20, ts: Date.now(),
    })));
    await tick(650);
    expect(writes.at(-1)).toEqual({ target: 'local-c', ids: ['local-a', 'local-c'] });
    // Target loads, saves and decisions must share the same page identity.
    expect(clients.size).toBe(1);
    expect([...clients][0]).toBeTruthy();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-decision-primary]')!.click());
    await waitFor(() => decisionClient !== undefined);
    expect(decisionClient).toBe([...clients][0]);
  });
}
