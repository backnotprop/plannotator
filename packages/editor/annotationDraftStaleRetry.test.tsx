/**
 * Session draft saves the server refuses (useAnnotationDraft + the default
 * /api/draft transport).
 *
 *  - Stale: two sessions on the same file. Session A (text v1) and session B
 *    (text v2, restored from A's path copy at generation 20). A's feedback at
 *    generation 25 deletes the path copy and B's content copy and tombstones
 *    them. Without the retry B's next saves (21..25) were silently refused,
 *    and a crash then lost B's comments. The client adopts the server's
 *    generation and saves again.
 *  - Decided: the session itself was decided (another tab sent it). Its
 *    refusal is never retried, or the sent comments would come back.
 *
 * The fetch shim routes /api/draft to REAL annotate draft sessions
 * (packages/shared/annotate-draft.ts, saveRequest shapes the response) over a
 * temp PLANNOTATOR_DATA_DIR, so the refusals are the server's own.
 *
 * Requires DOM (happy-dom) — runs under DOM_TESTS=1.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnnotateDraftSession, type AnnotateDraftSession } from '@plannotator/shared/annotate-draft';
import { contentHash } from '@plannotator/shared/draft';
import { useAnnotationDraft } from '@plannotator/ui/hooks/useAnnotationDraft';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';

const hasDom = typeof document !== 'undefined';
const originalFetch = globalThis.fetch;
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
let tempDir: string | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  globalThis.fetch = originalFetch;
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  if (hasDom) document.body.replaceChildren();
});

const comment = (id: string): Annotation => ({
  id,
  blockId: '',
  startOffset: 0,
  endOffset: 4,
  type: AnnotationType.COMMENT,
  text: id,
  originalText: 'Body',
  createdA: 1,
});

let flushPendingSave: () => void = () => {};

function Harness({ annotations }: { annotations: Annotation[] }) {
  ({ flushPendingSave } = useAnnotationDraft({ annotations, globalAttachments: [], isApiMode: true, isSharedSession: false, submitted: false }));
  return null;
}

const tick = (ms: number) => act(async () => new Promise<void>((r) => setTimeout(r, ms)));

function sandboxFile(): string {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-stale-retry-')));
  process.env.PLANNOTATOR_DATA_DIR = join(tempDir, 'data');
  const filePath = join(tempDir, 'notes.md');
  writeFileSync(filePath, 'v2');
  return filePath;
}

/** Route /api/draft to `session`; returns the generations POSTed. */
function serve(session: AnnotateDraftSession): number[] {
  const posted: number[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.pathname !== '/api/draft') return Response.json({});
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body));
      posted.push(body.draftGeneration);
      const result = session.saveRequest(body);
      return Response.json(result.body, { status: result.status });
    }
    const loaded = session.load();
    return loaded.found
      ? Response.json(loaded.draft)
      : Response.json({ found: false, draftGeneration: loaded.draftGeneration }, { status: 404 });
  }) as typeof fetch;
  return posted;
}

async function mountHarness(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<Harness annotations={[]} />); });
  await tick(50);
}

describe.if(hasDom)('session draft saves the server refuses', () => {
  test('a stale refusal adopts the server generation and saves again', async () => {
    const filePath = sandboxFile();
    const sessionA = createAnnotateDraftSession({ contentKey: contentHash('v1'), filePath });
    const sessionB = createAnnotateDraftSession({ contentKey: contentHash('v2'), filePath });
    // A saved at generation 20; B restores from that path copy.
    sessionA.save({ annotations: [comment('from-a')], globalAttachments: [], draftGeneration: 20, ts: 1 });
    const posted = serve(sessionB);
    await mountHarness();

    // A decides at generation 25 while B is still open.
    sessionA.settle(25);

    // B's reviewer adds a comment: the save at 21 is refused, then retried above 25.
    await act(async () => { root?.render(<Harness annotations={[comment('from-b')]} />); });
    await tick(700);

    expect(posted[0]).toBe(21);
    expect(posted.at(-1)).toBeGreaterThan(25);
    const recovered = sessionB.load();
    expect(recovered.found).toBe(true);
    if (recovered.found) {
      expect((recovered.draft.annotations as Annotation[]).map((a) => a.id)).toEqual(['from-b']);
    }
  });

  test('a decided refusal is not retried', async () => {
    const filePath = sandboxFile();
    const session = createAnnotateDraftSession({ contentKey: contentHash('v2'), filePath });
    const posted = serve(session);
    await mountHarness();

    // Another tab of this review sent the decision.
    session.settle(6);

    await act(async () => { root?.render(<Harness annotations={[comment('already-sent')]} />); });
    await tick(700);

    expect(posted).toHaveLength(1);
    const after = createAnnotateDraftSession({ contentKey: contentHash('v2'), filePath }).load();
    expect(after.found).toBe(false);
  });

  test('an agent close: the comment typed just before it is flushed and kept', async () => {
    const filePath = sandboxFile();
    const session = createAnnotateDraftSession({ contentKey: contentHash('v2'), filePath });
    const posted = serve(session);
    await mountHarness();

    // The reviewer types; the debounced save has not fired yet when the
    // agent closes the session (App flushes on the session-closed event).
    await act(async () => { root?.render(<Harness annotations={[comment('typed-at-close')]} />); });
    session.closeKeepingDraft();
    await act(async () => { flushPendingSave(); });
    await tick(50);

    expect(posted).toHaveLength(1);
    const kept = createAnnotateDraftSession({ contentKey: contentHash('v2'), filePath }).load();
    expect(kept.found).toBe(true);
    if (kept.found) expect((kept.draft.annotations as Annotation[]).map((a) => a.id)).toEqual(['typed-at-close']);
  });
});
