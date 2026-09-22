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
import { resetDraftTransport, setDraftTransport } from './hooks/useAnnotationDraft';
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

  test.skipIf(!hasDom)('auto-view suppression round-trips, and an older draft without it restores empty', async () => {
    // Guards the "come back to this" contract across a reload: a file the
    // reviewer un-viewed must still be off-limits to auto-view after the draft
    // comes back. The second half guards backward compatibility — a draft
    // written before the field must restore, not throw or resurrect state.
    const s1 = await mountSession(options());
    await s1.rerender(options({
      annotations: [ANNOTATION],
      viewedFiles: new Set(['src/a.ts']),
      autoViewSuppressed: new Set(['src/b.ts']),
    }));
    await tick(DEBOUNCE_WAIT_MS);
    const saved = loadDraft(DRAFT_KEY) as { autoViewSuppressed?: string[] } | null;
    expect(saved!.autoViewSuppressed).toEqual(['src/b.ts']);
    await s1.unmount();

    const s2 = await mountSession(options());
    // restoreDraft clears the banner, so it is a state update like any other.
    let restoredSuppressed: string[] = [];
    await act(async () => { restoredSuppressed = s2.result.current!.restoreDraft().autoViewSuppressed; });
    expect(restoredSuppressed).toEqual(['src/b.ts']);
    await s2.unmount();

    // A draft written by a build that predates the field.
    deleteDraft(DRAFT_KEY);
    saveDraft(DRAFT_KEY, {
      codeAnnotations: [ANNOTATION],
      viewedFiles: ['src/a.ts'],
      draftGeneration: 1,
      ts: Date.now(),
    });
    const s3 = await mountSession(options());
    let restored = { viewedFiles: [] as string[], autoViewSuppressed: [] as string[] };
    await act(async () => { restored = s3.result.current!.restoreDraft(); });
    expect(restored.viewedFiles).toEqual(['src/a.ts']);
    expect(restored.autoViewSuppressed).toEqual([]);
    await s3.unmount();
  });

  test.skipIf(!hasDom)('suppression alone does not keep an otherwise empty draft alive', async () => {
    // Deliberate edge (#948 semantics stay untouched): the un-view set is not
    // content. A session with nothing but suppression is still empty and still
    // tombstones, so clear-everything keeps meaning what it means today.
    const s = await mountSession(options());
    await s.rerender(options({ annotations: [ANNOTATION] }));
    await tick(DEBOUNCE_WAIT_MS);
    expect(loadDraft(DRAFT_KEY)).not.toBeNull();

    await s.rerender(options({ annotations: [], autoViewSuppressed: new Set(['src/b.ts']) }));
    await tick(DEBOUNCE_WAIT_MS);
    expect(loadDraft(DRAFT_KEY)).toBeNull();
    await s.unmount();
  });
});

describe('PR draft served for a changed patch (#1590)', () => {
  test.skipIf(!hasDom)('restoreDraft reports the server patchChanged flag so the host re-checks anchors; absent means false', async () => {
    // The review server adds patchChanged when it serves a PR draft through
    // the target key for a different patch. Losing it on the way through the
    // hook would restore stale line comments as if nothing had moved.
    saveDraft(DRAFT_KEY, { codeAnnotations: [ANNOTATION], draftGeneration: 1, ts: Date.now(), patchChanged: true });
    const s = await mountSession(options());
    expect(s.result.current!.draftBanner).not.toBeNull();
    let restored: ReturnType<HookResult['restoreDraft']> | null = null;
    await act(async () => { restored = s.result.current!.restoreDraft(); });
    expect(restored!.patchChanged).toBe(true);
    expect(restored!.annotations).toHaveLength(1);
    await s.unmount();

    deleteDraft(DRAFT_KEY);
    saveDraft(DRAFT_KEY, { codeAnnotations: [ANNOTATION], draftGeneration: 1, ts: Date.now() });
    const s2 = await mountSession(options());
    let plain: ReturnType<HookResult['restoreDraft']> | null = null;
    await act(async () => { plain = s2.result.current!.restoreDraft(); });
    expect(plain!.patchChanged).toBe(false);
    await s2.unmount();
  });
});

describe('in-place switch onto another draft target (#1590)', () => {
  // A host that behaves like the review App: it owns the annotation list,
  // appends whatever the hook auto-merges after a switch, and can be edited.
  interface Host {
    result: { current: HookResult | null };
    ids: () => string[];
    setAnnotations: (next: CodeAnnotation[]) => Promise<void>;
    setViewed: (next: Set<string>) => Promise<void>;
    adopt: (state: { found: boolean; draftGeneration: number | null }) => Promise<void>;
    unmount: () => Promise<void>;
  }

  const ann = (id: string) => ({ ...(ANNOTATION as object), id }) as unknown as CodeAnnotation;

  async function mountHost(initial: CodeAnnotation[]): Promise<Host> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const resultRef: { current: HookResult | null } = { current: null };
    const control: {
      setAnnotations?: React.Dispatch<React.SetStateAction<CodeAnnotation[]>>;
      setViewed?: React.Dispatch<React.SetStateAction<Set<string>>>;
      annotations: CodeAnnotation[];
    } = { annotations: initial };
    function MergingHost() {
      const [annotations, setAnnotations] = React.useState<CodeAnnotation[]>(initial);
      const [viewedFiles, setViewed] = React.useState<Set<string>>(new Set());
      control.setAnnotations = setAnnotations;
      control.setViewed = setViewed;
      control.annotations = annotations;
      resultRef.current = useCodeAnnotationDraft(options({
        annotations,
        viewedFiles,
        onDraftTargetMerge: (items) => setAnnotations((prev) => [...prev, ...items.annotations]),
      }));
      return null;
    }
    let root: Root;
    await act(async () => {
      root = createRoot(host);
      root.render(<MergingHost />);
    });
    await tick(0);
    return {
      result: resultRef,
      ids: () => control.annotations.map((a) => a.id),
      setAnnotations: async (next) => { await act(async () => { control.setAnnotations!(next); }); },
      setViewed: async (next) => { await act(async () => { control.setViewed!(next); }); },
      adopt: async (state) => { await act(async () => { resultRef.current!.adoptDraftTarget(state); }); },
      unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); },
    };
  }

  const diskIds = () =>
    ((loadDraft(DRAFT_KEY) as { codeAnnotations?: Array<{ id: string }> } | null)?.codeAnnotations ?? []).map((a) => a.id);

  test.skipIf(!hasDom)('adopting the target floor lets the next autosave land past an old tombstone', async () => {
    const h = await mountHost([]);
    // The target just switched onto was submitted at generation 40 earlier.
    saveDraft(DRAFT_KEY, { codeAnnotations: [ANNOTATION], draftGeneration: 39, ts: Date.now() });
    deleteDraft(DRAFT_KEY, 40);
    await h.adopt({ found: false, draftGeneration: 40 });
    await h.setAnnotations([ann('new-after-switch')]);
    await tick(DEBOUNCE_WAIT_MS);
    const saved = loadDraft(DRAFT_KEY) as { draftGeneration?: number } | null;
    expect(diskIds()).toEqual(['new-after-switch']);
    expect(saved!.draftGeneration!).toBeGreaterThan(40);
    await h.unmount();
  });

  test.skipIf(!hasDom)('no edit: the switch merges the target\'s unsent items into the session and saves both, with no blocking banner', async () => {
    const h = await mountHost([ann('mine')]);
    saveDraft(DRAFT_KEY, { codeAnnotations: [ann('waiting-on-b')], draftGeneration: 12, ts: Date.now() });
    await h.adopt({ found: true, draftGeneration: 12 });
    await h.setViewed(new Set(['src/b.ts'])); // the switch replaces viewed files
    await tick(DEBOUNCE_WAIT_MS);
    expect(h.ids()).toEqual(['mine', 'waiting-on-b']);
    expect(diskIds()).toEqual(['mine', 'waiting-on-b']);
    expect(h.result.current!.draftBanner).toBeNull();
    // Nothing is left waiting: later edits keep saving.
    await h.setAnnotations([ann('mine'), ann('waiting-on-b'), ann('later')]);
    await tick(DEBOUNCE_WAIT_MS);
    expect(diskIds()).toEqual(['mine', 'waiting-on-b', 'later']);
    await h.unmount();
  });

  test.skipIf(!hasDom)('an emptied session does not delete the target\'s draft; its items are merged in instead', async () => {
    const h = await mountHost([]);
    await h.setAnnotations([ann('mine')]);
    await h.setAnnotations([]); // engaged, then emptied
    await tick(DEBOUNCE_WAIT_MS);
    saveDraft(DRAFT_KEY, { codeAnnotations: [ann('waiting-on-b')], draftGeneration: 20, ts: Date.now() });
    await h.adopt({ found: true, draftGeneration: 20 });
    await h.setViewed(new Set());
    await tick(DEBOUNCE_WAIT_MS);
    expect(h.ids()).toEqual(['waiting-on-b']);
    expect(diskIds()).toEqual(['waiting-on-b']);
    await h.unmount();
  });

  test.skipIf(!hasDom)('a comment deleted this session is not merged back from a target saved before the delete', async () => {
    const h = await mountHost([ann('keep'), ann('x')]);
    await h.setAnnotations([ann('keep')]); // x deleted
    saveDraft(DRAFT_KEY, { codeAnnotations: [ann('keep'), ann('x'), ann('y')], draftGeneration: 30, ts: Date.now() });
    await h.adopt({ found: true, draftGeneration: 30 });
    await tick(0);
    expect(h.ids()).toEqual(['keep', 'y']);
    await h.unmount();
  });

  test.skipIf(!hasDom)('switching back onto a target holding only this session\'s own items merges nothing', async () => {
    let merges = 0;
    const s = await mountSession(options({ annotations: [ann('mine')], onDraftTargetMerge: () => { merges += 1; } }));
    saveDraft(DRAFT_KEY, { codeAnnotations: [ann('mine')], draftGeneration: 3, ts: Date.now() });
    await act(async () => { s.result.current!.adoptDraftTarget({ found: true, draftGeneration: 3 }); });
    await tick(0);
    expect(merges).toBe(0);
    expect(s.result.current!.draftBanner).toBeNull();
    await s.unmount();
  });

  describe('switching again while the previous target\'s load is still in flight', () => {
    // A transport whose loads resolve only when the test says so, so a slow
    // B load can be made to land after the switch to C.
    function deferredTransport() {
      const loads: Array<(v: { data: unknown; generation: number | null }) => void> = [];
      const saves: Array<{ codeAnnotations?: Array<{ id: string }> }> = [];
      setDraftTransport({
        load: () => new Promise((resolve) => { loads.push(resolve); }),
        save: async (body) => { saves.push(body as { codeAnnotations?: Array<{ id: string }> }); },
        remove: async () => {},
      });
      return { loads, saves };
    }

    afterEach(() => { resetDraftTransport(); });

    test.skipIf(!hasDom)('A→B(draft, slow)→C(no draft): nothing stale is merged, and C keeps saving', async () => {
      const t = deferredTransport();
      const h = await mountHost([ann('mine')]);
      t.loads.shift()?.({ data: null, generation: null }); // the page-load GET
      await tick(0);
      await h.adopt({ found: true, draftGeneration: 5 }); // B: load in flight
      await h.setViewed(new Set(['b.ts']));
      await h.adopt({ found: false, draftGeneration: null }); // C
      await h.setAnnotations([ann('mine'), ann('on-c')]);
      await tick(DEBOUNCE_WAIT_MS);
      expect(t.saves.at(-1)?.codeAnnotations?.map((a) => a.id)).toEqual(['mine', 'on-c']);
      // B's load finally lands: ignored.
      await act(async () => { t.loads.shift()?.({ data: { codeAnnotations: [ann('stale-b')], draftGeneration: 5, ts: 1 }, generation: null }); });
      await tick(0);
      expect(h.ids()).toEqual(['mine', 'on-c']);
      expect(h.result.current!.draftBanner).toBeNull();
      await h.unmount();
    });

    test.skipIf(!hasDom)('A→B(draft, slow)→C(draft): only C\'s items merge; B resolving late is ignored', async () => {
      const t = deferredTransport();
      const h = await mountHost([ann('mine')]);
      t.loads.shift()?.({ data: null, generation: null });
      await tick(0);
      await h.adopt({ found: true, draftGeneration: 5 }); // B
      await h.adopt({ found: true, draftGeneration: 7 }); // C
      const [bLoad, cLoad] = [t.loads.shift()!, t.loads.shift()!];
      await act(async () => { cLoad({ data: { codeAnnotations: [ann('on-c')], draftGeneration: 7, ts: 1 }, generation: null }); });
      await act(async () => { bLoad({ data: { codeAnnotations: [ann('stale-b')], draftGeneration: 5, ts: 1 }, generation: null }); });
      await tick(DEBOUNCE_WAIT_MS);
      expect(h.ids()).toEqual(['mine', 'on-c']);
      expect(t.saves.at(-1)?.codeAnnotations?.map((a) => a.id)).toEqual(['mine', 'on-c']);
      await h.unmount();
    });

    test.skipIf(!hasDom)('a failed target load settles too: saving resumes instead of sticking', async () => {
      const loads: Array<(v: unknown) => void> = [];
      const rejects: Array<(e: unknown) => void> = [];
      const saves: Array<{ codeAnnotations?: Array<{ id: string }> }> = [];
      setDraftTransport({
        load: () => new Promise((resolve, reject) => { loads.push(resolve as (v: unknown) => void); rejects.push(reject); }),
        save: async (body) => { saves.push(body as { codeAnnotations?: Array<{ id: string }> }); },
        remove: async () => {},
      });
      const h = await mountHost([ann('mine')]);
      loads.shift()?.({ data: null, generation: null });
      rejects.shift();
      await tick(0);
      await h.adopt({ found: true, draftGeneration: 5 });
      await h.setViewed(new Set(['b.ts']));
      await tick(DEBOUNCE_WAIT_MS);
      expect(saves).toEqual([]); // not written over B's unread draft
      await act(async () => { rejects.shift()?.(new Error('offline')); });
      await tick(DEBOUNCE_WAIT_MS);
      expect(saves.at(-1)?.codeAnnotations?.map((a) => a.id)).toEqual(['mine']);
      await h.unmount();
    });
  });
});
