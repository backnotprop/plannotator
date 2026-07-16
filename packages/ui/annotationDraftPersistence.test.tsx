/**
 * End-to-end draft persistence tests for direct edits (Phase 2a of #887).
 *
 * These run the REAL stack at both ends: the actual useAnnotationDraft hook
 * mounted in React on one side, and the actual saveDraft/loadDraft/deleteDraft
 * disk layer (packages/shared/draft.ts) on the other, joined by a fetch shim
 * that mirrors the servers' /api/draft pass-through handlers. Every test is a
 * full cycle — save → bytes on disk → reload in a fresh mount → restore — so
 * a serialization change, a guard regression, or a wire-format drift fails
 * here, not in a user's browser.
 *
 * Requires DOM_TESTS=1 (happy-dom preload). Run:
 *   DOM_TESTS=1 bun test annotationDraftPersistence
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useAnnotationDraft, type DraftEditedDocument, type DraftSavedFileChange } from './hooks/useAnnotationDraft';
import { AnnotationType, type Annotation } from './types';
import { saveDraft, loadDraft, deleteDraft, contentHash, getDraftGeneration } from '../shared/draft';

const hasDom = typeof document !== 'undefined';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAN = `# Test Plan

* star bullet

the second step

\`\`\`ts
const a = 1;
\`\`\`
`;

// Deliberately gnarly: fence edits, trailing space, unicode, smart quotes.
// The round trip must be byte-identical or the Direct Edits diff lies.
const EDITED = `# Test Plan

* star bullet — edited

the second step

\`\`\`ts
const a = 2; // touched
\`\`\`

new paragraph with trailing space${' '}
and "smart" quotes…
`;

const ANNOTATION: Annotation = {
  id: 'ann-1',
  blockId: 'block-2',
  startOffset: 4,
  endOffset: 19,
  type: AnnotationType.COMMENT,
  text: 'tighten this step',
  originalText: 'the second step',
  createdA: 1718000000000,
  author: 'tater',
};

const SOURCE_SAVE = {
  enabled: true,
  kind: 'local-text-file',
  scope: 'folder-file',
  path: '/repo/docs/a.md',
  basename: 'a.md',
  language: 'markdown',
  hash: 'sha256:after',
  mtimeMs: 1718000001000,
  size: 6,
  eol: 'lf',
} as const;

const SAVED_FILE_CHANGE: DraftSavedFileChange = {
  key: 'file:/repo/docs/a.md',
  path: '/repo/docs/a.md',
  basename: 'a.md',
  beforeText: 'before\n',
  afterText: 'after\n',
  beforeHash: 'sha256:before',
  afterHash: 'sha256:after',
  sourceSave: SOURCE_SAVE,
};

// Server-side draft key: contentHash of the as-submitted plan, exactly as
// packages/server/index.ts computes it.
const DRAFT_KEY = contentHash(PLAN);
const DEBOUNCE_WAIT_MS = 650; // hook debounce is 500ms

// ---------------------------------------------------------------------------
// Real-disk fetch shim (mirrors the /api/draft handlers in all three servers)
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let dataDir = '';
let prevDataDirEnv: string | undefined;

function installFetchShim() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/draft')) {
      const parsedUrl = new URL(url, 'http://localhost');
      const method = init?.method ?? 'GET';
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
  dataDir = mkdtempSync(join(tmpdir(), 'plannotator-draft-test-'));
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
});

// ---------------------------------------------------------------------------
// Hook harness
// ---------------------------------------------------------------------------

type HookOptions = Parameters<typeof useAnnotationDraft>[0];
type HookResult = ReturnType<typeof useAnnotationDraft>;

const options = (over: Partial<HookOptions> = {}): HookOptions => ({
  annotations: [],
  globalAttachments: [],
  isApiMode: true,
  isSharedSession: false,
  submitted: false,
  ...over,
});

function Harness({ opts, resultRef }: { opts: HookOptions; resultRef: { current: HookResult | null } }) {
  resultRef.current = useAnnotationDraft(opts);
  return null;
}

interface Session {
  result: { current: HookResult | null };
  rerender: (opts: HookOptions) => Promise<void>;
  unmount: () => Promise<void>;
}

const tick = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

/** Mounts a fresh hook instance and flushes the on-mount draft GET. */
async function mountSession(opts: HookOptions): Promise<Session> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const resultRef: { current: HookResult | null } = { current: null };
  let root: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness opts={opts} resultRef={resultRef} />);
  });
  await tick(0); // let the GET .then chain settle (sets hasMountedRef)
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

describe('direct-edit draft persistence', () => {
  test.skipIf(!hasDom)('full lifecycle: edits + annotation persist to disk and survive a reload', async () => {
    // Session 1: an annotation exists and the user has direct edits.
    const s1 = await mountSession(options({
      annotations: [ANNOTATION],
      getEditedMarkdown: () => EDITED,
    }));
    act(() => s1.result.current!.scheduleDraftSave());
    await tick(DEBOUNCE_WAIT_MS);
    await s1.unmount();

    // The bytes on disk are the contract between sessions.
    const onDisk = loadDraft(DRAFT_KEY) as Record<string, unknown> | null;
    expect(onDisk).not.toBeNull();
    expect(onDisk!.annotations).toEqual([ANNOTATION]);
    expect(onDisk!.editedMarkdown).toBe(EDITED);
    expect(typeof onDisk!.ts).toBe('number');

    // Session 2: fresh page — no in-memory state, only the draft on disk.
    const s2 = await mountSession(options());
    expect(s2.result.current!.draftBanner).toEqual({
      count: 1,
      timeAgo: 'just now',
      hasEdits: true,
    });

    let restored: ReturnType<HookResult['restoreDraft']>;
    act(() => {
      restored = s2.result.current!.restoreDraft();
    });
    expect(restored!.annotations).toEqual([ANNOTATION]);
    expect(restored!.editedMarkdown).toBe(EDITED); // byte-identical
    expect(s2.result.current!.draftBanner).toBeNull();
    await s2.unmount();
  });

  test.skipIf(!hasDom)('edits-only draft saves despite zero annotations and banners as edits', async () => {
    // Regression trap: the old all-empty skip guard would have dropped this.
    const s1 = await mountSession(options({ getEditedMarkdown: () => EDITED }));
    act(() => s1.result.current!.scheduleDraftSave());
    await tick(DEBOUNCE_WAIT_MS);
    await s1.unmount();

    const onDisk = loadDraft(DRAFT_KEY) as Record<string, unknown> | null;
    expect(onDisk).not.toBeNull();
    expect(onDisk!.annotations).toEqual([]);
    expect(onDisk!.editedMarkdown).toBe(EDITED);

    const s2 = await mountSession(options());
    expect(s2.result.current!.draftBanner).toEqual({
      count: 0,
      timeAgo: 'just now',
      hasEdits: true,
    });
    let restored: ReturnType<HookResult['restoreDraft']>;
    act(() => {
      restored = s2.result.current!.restoreDraft();
    });
    expect(restored!.editedMarkdown).toBe(EDITED);
    expect(restored!.annotations).toEqual([]);
    await s2.unmount();
  });

  test.skipIf(!hasDom)('saved file changes persist and restore after a reload', async () => {
    const s1 = await mountSession(options({
      getSavedFileChanges: () => [SAVED_FILE_CHANGE],
    }));
    act(() => s1.result.current!.scheduleDraftSave());
    await tick(DEBOUNCE_WAIT_MS);
    await s1.unmount();

    const onDisk = loadDraft(DRAFT_KEY) as Record<string, unknown> | null;
    expect(onDisk).not.toBeNull();
    expect(onDisk!.savedFileChanges).toEqual([SAVED_FILE_CHANGE]);
    expect(onDisk!.editedDocuments).toBeUndefined();

    const s2 = await mountSession(options());
    expect(s2.result.current!.draftBanner).toEqual({
      count: 0,
      timeAgo: 'just now',
      hasEdits: true,
    });

    let restored: ReturnType<HookResult['restoreDraft']>;
    act(() => {
      restored = s2.result.current!.restoreDraft();
    });
    expect(restored!.savedFileChanges).toEqual([SAVED_FILE_CHANGE]);
    expect(restored!.editedDocuments).toEqual([]);
    expect(restored!.editedMarkdown).toBeNull();
    await s2.unmount();
  });

  test.skipIf(!hasDom)('dirty source drafts carry their already-saved edit context', async () => {
    const dirtyWithSavedChange: DraftEditedDocument = {
      key: SAVED_FILE_CHANGE.key,
      sourceSave: SOURCE_SAVE,
      sessionOpenText: SAVED_FILE_CHANGE.beforeText,
      diskBaseline: SAVED_FILE_CHANGE.afterText,
      currentText: 'after\nmore unsaved work\n',
      savedChange: SAVED_FILE_CHANGE,
    };

    const s1 = await mountSession(options({
      getEditedDocuments: () => [dirtyWithSavedChange],
      getSavedFileChanges: () => [SAVED_FILE_CHANGE],
    }));
    act(() => s1.result.current!.scheduleDraftSave());
    await tick(DEBOUNCE_WAIT_MS);
    await s1.unmount();

    const s2 = await mountSession(options());
    let restored: ReturnType<HookResult['restoreDraft']>;
    act(() => {
      restored = s2.result.current!.restoreDraft();
    });

    expect(restored!.editedDocuments).toEqual([dirtyWithSavedChange]);
    expect(restored!.savedFileChanges).toEqual([SAVED_FILE_CHANGE]);
    await s2.unmount();
  });

  test.skipIf(!hasDom)('bad saved-change metadata does not drop the dirty source draft', async () => {
    const dirtyDraft = {
      key: SAVED_FILE_CHANGE.key,
      sourceSave: SOURCE_SAVE,
      sessionOpenText: SAVED_FILE_CHANGE.beforeText,
      diskBaseline: SAVED_FILE_CHANGE.afterText,
      currentText: 'after\nmore unsaved work\n',
      savedChange: { key: SAVED_FILE_CHANGE.key },
    };
    saveDraft(DRAFT_KEY, {
      annotations: [],
      globalAttachments: [],
      editedDocuments: [dirtyDraft],
      ts: Date.now(),
    });

    const session = await mountSession(options());
    let restored: ReturnType<HookResult['restoreDraft']>;
    act(() => {
      restored = session.result.current!.restoreDraft();
    });

    expect(restored!.editedDocuments).toEqual([{
      key: dirtyDraft.key,
      sourceSave: SOURCE_SAVE,
      sessionOpenText: dirtyDraft.sessionOpenText,
      diskBaseline: dirtyDraft.diskBaseline,
      currentText: dirtyDraft.currentText,
    }]);
    expect(restored!.savedFileChanges).toEqual([]);
    await session.unmount();
  });

  test.skipIf(!hasDom)('dirty source drafts restore older nested saved-change records from the document source', async () => {
    const { sourceSave: _sourceSave, ...olderSavedChange } = SAVED_FILE_CHANGE;
    const dirtyDraft = {
      key: SAVED_FILE_CHANGE.key,
      sourceSave: SOURCE_SAVE,
      sessionOpenText: SAVED_FILE_CHANGE.beforeText,
      diskBaseline: SAVED_FILE_CHANGE.afterText,
      currentText: 'after\nmore unsaved work\n',
      savedChange: olderSavedChange,
    };
    saveDraft(DRAFT_KEY, {
      annotations: [],
      globalAttachments: [],
      editedDocuments: [dirtyDraft],
      ts: Date.now(),
    });

    const session = await mountSession(options());
    let restored: ReturnType<HookResult['restoreDraft']>;
    act(() => {
      restored = session.result.current!.restoreDraft();
    });

    expect(restored!.editedDocuments).toEqual([{
      key: dirtyDraft.key,
      sourceSave: SOURCE_SAVE,
      sessionOpenText: dirtyDraft.sessionOpenText,
      diskBaseline: dirtyDraft.diskBaseline,
      currentText: dirtyDraft.currentText,
      savedChange: SAVED_FILE_CHANGE,
    }]);
    expect(restored!.savedFileChanges).toEqual([]);
    await session.unmount();
  });

  test.skipIf(!hasDom)('discarding everything deletes the draft from disk', async () => {
    // The user committed edits, then discarded them (no annotations either).
    // A stale draft must not resurrect the discarded content on refresh.
    const edits: { value: string | null } = { value: EDITED };
    const session = await mountSession(options({ getEditedMarkdown: () => edits.value }));
    act(() => session.result.current!.scheduleDraftSave());
    await tick(DEBOUNCE_WAIT_MS);
    expect(loadDraft(DRAFT_KEY)).not.toBeNull();

    edits.value = null; // discard (App's handleDiscardEdits nulls the ref…)
    act(() => session.result.current!.scheduleDraftSave()); // …then schedules
    await tick(DEBOUNCE_WAIT_MS);
    expect(loadDraft(DRAFT_KEY)).toBeNull();
    await session.unmount();

    const s2 = await mountSession(options());
    expect(s2.result.current!.draftBanner).toBeNull();
    await s2.unmount();
  });

  test.skipIf(!hasDom)('clearing saved file changes deletes an edits-only draft', async () => {
    const saved: { value: DraftSavedFileChange[] } = { value: [SAVED_FILE_CHANGE] };
    const session = await mountSession(options({ getSavedFileChanges: () => saved.value }));
    act(() => session.result.current!.scheduleDraftSave());
    await tick(DEBOUNCE_WAIT_MS);
    expect(loadDraft(DRAFT_KEY)).not.toBeNull();

    saved.value = [];
    act(() => session.result.current!.scheduleDraftSave());
    await tick(DEBOUNCE_WAIT_MS);
    expect(loadDraft(DRAFT_KEY)).toBeNull();
    await session.unmount();
  });

  test.skipIf(!hasDom)('legacy tuple drafts still load, with no edits', async () => {
    saveDraft(DRAFT_KEY, { a: [['C', 'orig text', 'a comment', null]], ts: Date.now() });

    const session = await mountSession(options());
    expect(session.result.current!.draftBanner).toEqual({
      count: 1,
      timeAgo: 'just now',
      hasEdits: false,
    });
    let restored: ReturnType<HookResult['restoreDraft']>;
    act(() => {
      restored = session.result.current!.restoreDraft();
    });
    expect(restored!.editedMarkdown).toBeNull();
    expect(restored!.annotations).toHaveLength(1);
    expect(restored!.annotations[0].originalText).toBe('orig text');
    expect(restored!.annotations[0].text).toBe('a comment');
    expect(restored!.annotations[0].type).toBe(AnnotationType.COMMENT);
    await session.unmount();
  });

  test.skipIf(!hasDom)('closing the page flushes a pending save — no lost debounce window', async () => {
    // Tab close inside the 500ms debounce would silently drop the last
    // keystrokes; pagehide/visibilitychange must flush the pending save.
    const session = await mountSession(options({
      annotations: [ANNOTATION],
      getEditedMarkdown: () => EDITED,
    }));
    act(() => session.result.current!.scheduleDraftSave());
    expect(loadDraft(DRAFT_KEY)).toBeNull(); // debounce hasn't elapsed
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await tick(0); // immediate — far inside the 500ms window
    const onDisk = loadDraft(DRAFT_KEY) as Record<string, unknown> | null;
    expect(onDisk).not.toBeNull();
    expect(onDisk!.editedMarkdown).toBe(EDITED);
    await session.unmount();
  });

  test.skipIf(!hasDom)('submitting cancels a pending save — no ghost draft after approve', async () => {
    // The server deletes the draft when handling approve/deny. A debounced
    // save landing after that would re-create it and ghost a "Draft
    // Recovered" banner into the NEXT session for this same plan.
    const session = await mountSession(options({
      annotations: [ANNOTATION],
      getEditedMarkdown: () => EDITED,
    }));
    act(() => session.result.current!.scheduleDraftSave());
    // Submit lands inside the debounce window.
    await session.rerender(options({
      annotations: [ANNOTATION],
      getEditedMarkdown: () => EDITED,
      submitted: true,
    }));
    await tick(DEBOUNCE_WAIT_MS);
    expect(loadDraft(DRAFT_KEY)).toBeNull();
    await session.unmount();
  });

  test.skipIf(!hasDom)('fresh session after a tombstone saves with a newer draft generation', async () => {
    deleteDraft(DRAFT_KEY, 2);

    const session = await mountSession(options({
      annotations: [ANNOTATION],
      getEditedMarkdown: () => EDITED,
    }));
    expect(session.result.current!.getDraftGeneration()).toBeGreaterThan(2);
    act(() => session.result.current!.scheduleDraftSave());
    await tick(DEBOUNCE_WAIT_MS);

    const onDisk = loadDraft(DRAFT_KEY) as Record<string, unknown> | null;
    expect(onDisk).not.toBeNull();
    expect(onDisk!.draftGeneration).toBeGreaterThan(2);
    expect(onDisk!.annotations).toEqual([ANNOTATION]);
    await session.unmount();
  });

  test.skipIf(!hasDom)('restored generated drafts continue saving with newer generations', async () => {
    const original = { ...ANNOTATION, text: 'old note' };
    const updated = { ...ANNOTATION, text: 'updated note' };
    deleteDraft(DRAFT_KEY, 2);
    saveDraft(DRAFT_KEY, {
      annotations: [original],
      globalAttachments: [],
      draftGeneration: 3,
      ts: Date.now(),
    });

    const session = await mountSession(options());
    expect(session.result.current!.draftBanner).toEqual({
      count: 1,
      timeAgo: 'just now',
      hasEdits: false,
    });
    act(() => {
      session.result.current!.restoreDraft();
    });
    await session.rerender(options({ annotations: [updated] }));
    act(() => session.result.current!.scheduleDraftSave());
    await tick(DEBOUNCE_WAIT_MS);

    const onDisk = loadDraft(DRAFT_KEY) as Record<string, unknown> | null;
    expect(onDisk).not.toBeNull();
    expect(onDisk!.draftGeneration).toBeGreaterThan(3);
    expect(onDisk!.annotations).toEqual([updated]);
    await session.unmount();
  });
});
