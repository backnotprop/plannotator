/**
 * Draft persistence tests for the code-review annotation autosave
 * (useCodeAnnotationDraft), exercising the REAL stack: the actual hook mounted
 * in React on one side, the actual saveDraft/loadDraft/deleteDraft disk layer
 * (packages/shared/draft.ts) on the other, joined by a fetch shim that mirrors
 * the review server's /api/draft pass-through handlers.
 *
 * Regression guard for #948: deleting every annotation must remove the draft
 * from disk (not leave a stale one that the recovery banner re-offers on
 * refresh). Also guards that a fresh, unengaged session never deletes an
 * unrestored draft sitting on disk at mount.
 *
 * Requires DOM_TESTS=1 (happy-dom preload). Run:
 *   DOM_TESTS=1 bun test codeAnnotationDraftPersistence
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useCodeAnnotationDraft } from './hooks/useCodeAnnotationDraft';
import type { CodeAnnotation } from './types';
import { saveDraft, loadDraft, deleteDraft, getDraftGeneration } from '../shared/draft';

const hasDom = typeof document !== 'undefined';

const DRAFT_KEY = 'code-annotation-draft-test';
const DEBOUNCE_WAIT_MS = 650; // hook debounce is 500ms

const ANNOTATION = {
  id: 'a1',
  filePath: 'src/index.ts',
  lineStart: 10,
  lineEnd: 10,
  side: 'new',
  type: 'comment',
  comment: 'fix this',
  originalText: 'const x = 1;',
} as unknown as CodeAnnotation;

// ---------------------------------------------------------------------------
// Real-disk fetch shim (mirrors the review server's /api/draft handlers)
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let dataDir = '';
let prevDataDirEnv: string | undefined;
// Records every /api/draft request so tests can assert on what the hook actually
// sent (e.g. that an external-annotation clear issued no DELETE).
const draftCalls: { method: string; url: string }[] = [];

function installFetchShim() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/draft')) {
      const parsedUrl = new URL(url, 'http://localhost');
      const method = init?.method ?? 'GET';
      draftCalls.push({ method, url });
      if (method === 'GET') {
        const data = loadDraft(DRAFT_KEY);
        return data
          ? new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
          : new Response(
              JSON.stringify({
                found: false,
                ...(getDraftGeneration(DRAFT_KEY) !== null ? { draftGeneration: getDraftGeneration(DRAFT_KEY) } : {}),
              }),
              { status: 404, headers: { 'Content-Type': 'application/json' } },
            );
      }
      if (method === 'POST') {
        saveDraft(DRAFT_KEY, JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (method === 'DELETE') {
        const rawGeneration = parsedUrl.searchParams.get('generation');
        const generation = rawGeneration === null ? undefined : Number(rawGeneration);
        deleteDraft(DRAFT_KEY, Number.isFinite(generation) && generation >= 0 ? generation : undefined);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;
}

beforeAll(() => {
  if (!hasDom) return;
  dataDir = mkdtempSync(join(tmpdir(), 'plannotator-code-draft-test-'));
  prevDataDirEnv = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  installFetchShim();
});

afterAll(() => {
  if (!hasDom) return;
  globalThis.fetch = realFetch;
  if (prevDataDirEnv === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = prevDataDirEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  if (!hasDom) return;
  deleteDraft(DRAFT_KEY);
  draftCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Hook harness (the review hook is reactive — it autosaves on prop change)
// ---------------------------------------------------------------------------

type HookOptions = Parameters<typeof useCodeAnnotationDraft>[0];
type HookResult = ReturnType<typeof useCodeAnnotationDraft>;

const options = (over: Partial<HookOptions> = {}): HookOptions => ({
  annotations: [],
  viewedFiles: new Set<string>(),
  isApiMode: true,
  submitted: false,
  ...over,
});

function Harness({ opts, resultRef }: { opts: HookOptions; resultRef: { current: HookResult | null } }) {
  resultRef.current = useCodeAnnotationDraft(opts);
  return null;
}

interface Session {
  result: { current: HookResult | null };
  rerender: (opts: HookOptions) => Promise<void>;
  unmount: () => Promise<void>;
}

const tick = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

async function mountSession(opts: HookOptions): Promise<Session> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const resultRef: { current: HookResult | null } = { current: null };
  let root: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness opts={opts} resultRef={resultRef} />);
  });
  await tick(0); // let the on-mount GET .then chain settle (sets hasMountedRef)
  return {
    result: resultRef,
    rerender: async (next: HookOptions) => {
      await act(async () => {
        root.render(<Harness opts={next} resultRef={resultRef} />);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('code-review annotation draft persistence', () => {
  test.skipIf(!hasDom)('deleting every annotation removes the draft so it does not resurrect (#948)', async () => {
    // Session 1: mount empty (lets the on-mount GET settle so hasMountedRef is
    // set), then the user adds an annotation -> it autosaves to disk.
    const s1 = await mountSession(options());
    await s1.rerender(options({ annotations: [ANNOTATION] }));
    await tick(DEBOUNCE_WAIT_MS);
    const afterSave = loadDraft(DRAFT_KEY) as { codeAnnotations?: unknown[] } | null;
    expect(afterSave).not.toBeNull();
    expect(afterSave!.codeAnnotations).toHaveLength(1);

    // User deletes the last annotation -> list empty. Pre-fix the autosave
    // skipped, leaving the stale draft on disk; now it must delete it.
    await s1.rerender(options({ annotations: [] }));
    await tick(DEBOUNCE_WAIT_MS);
    expect(loadDraft(DRAFT_KEY)).toBeNull();
    await s1.unmount();

    // Session 2: fresh page -> no draft on disk -> no recovery banner.
    const s2 = await mountSession(options());
    expect(s2.result.current!.draftBanner).toBeNull();
    await s2.unmount();
  });

  test.skipIf(!hasDom)('external (source-tagged) annotation churn does not arm engagement or delete the draft', async () => {
    // External-tool annotations (SSE-sourced) arrive via allAnnotations without
    // user action. They must NOT count as "the user had content", or clearing
    // them would fire a tombstone delete. (Regression guard for the engagement
    // signal being keyed on user-authored annotations only.)
    const EXTERNAL = { ...(ANNOTATION as object), id: 'ext1', source: 'eslint' } as unknown as CodeAnnotation;

    const s = await mountSession(options());
    // External annotation appears, then disappears — pure external churn.
    await s.rerender(options({ annotations: [EXTERNAL] }));
    await tick(DEBOUNCE_WAIT_MS);
    await s.rerender(options({ annotations: [] }));
    await tick(DEBOUNCE_WAIT_MS);

    // Engagement is keyed on user-authored annotations, so the external clear must
    // NOT have issued an empty-state DELETE. (If external annotations armed the
    // flag, a draft holding real user work in an interleaved session could be
    // wiped.) Assert directly on the wire: no DELETE was sent.
    expect(draftCalls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    await s.unmount();
  });

  test.skipIf(!hasDom)('a fresh, unengaged session does not delete an unrestored draft on disk', async () => {
    // A draft from a previous session sits on disk.
    saveDraft(DRAFT_KEY, {
      codeAnnotations: [ANNOTATION],
      viewedFiles: [],
      draftGeneration: 1,
      ts: Date.now(),
    });

    // Mount fresh: the user has NOT restored, so annotations are empty. The
    // empty-state autosave must NOT fire a delete (the guard keys on having had
    // annotations this session, which we haven't).
    const s = await mountSession(options());
    expect(s.result.current!.draftBanner).toEqual({ count: 1, viewedCount: 0, timeAgo: 'just now' });

    // Re-render still-empty (new Set identity) to actually run the autosave
    // effect through the guard path, then wait past the debounce.
    await s.rerender(options({ viewedFiles: new Set<string>() }));
    await tick(DEBOUNCE_WAIT_MS);

    // The unrestored draft survives — the banner can still offer it.
    const stillThere = loadDraft(DRAFT_KEY) as { codeAnnotations?: unknown[] } | null;
    expect(stillThere).not.toBeNull();
    expect(stillThere!.codeAnnotations).toHaveLength(1);
    await s.unmount();
  });
});
