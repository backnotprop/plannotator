/**
 * The App-facing hook through its real wiring shape (DOM-gated):
 *
 *  - the Settings opt-out aborts every registered tool and re-enabling
 *    re-registers them, and the default leaves NO cookie behind (the
 *    zero-footprint rule: nothing is written until the user opts out);
 *  - a successful add_comments stamps browser-agent, records activity (the
 *    indicator's only trigger), and its own response already carries the
 *    new comment's seq and the pending_unsent nudge even though React has
 *    not committed the state yet (optimistic overlay);
 *  - reveal { annotationId, path } waits for the navigated document to
 *    COMMIT before looking the comment up: with an open() that only sets
 *    state, a lookup right after the await would read the stale document
 *    and answer not_found after moving the human's view;
 *  - folder sessions list the file browser's tree and treat its selection as
 *    the open sibling.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { WEBMCP_TOOLS_COOKIE, getWebMcpActivity, resetWebMcpActivity, setWebMcpToolsEnabled } from '@plannotator/ui/webmcp';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import type { ModelContextLike, ModelContextToolDescriptor } from '@plannotator/ui/webmcp';
import type { Annotation } from '@plannotator/ui/types';
import type { CachedDocState } from '@plannotator/ui/hooks/useLinkedDoc';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useDocumentWebMcp') : null;

interface FakeContext extends ModelContextLike {
  tools: Map<string, ModelContextToolDescriptor>;
}

function fakeContext(): FakeContext {
  const tools = new Map<string, ModelContextToolDescriptor>();
  return {
    tools,
    registerTool(tool, options) {
      tools.set(tool.name, tool);
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => { tools.delete(tool.name); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      });
    },
  };
}

const originalDescriptor = hasDom ? Object.getOwnPropertyDescriptor(document, 'modelContext') : undefined;

const PLAN = '# Plan\n\nRotate the key.\n';
const ROOT = '/docs/plan.md';
const SIBLING = '/docs/rollout.md';
const SIBLING_TEXT = '# Rollout\n\nShip behind a flag.\n';
/** In the folder tree, but its load fails (the fetch error path). */
const BROKEN = '/docs/notes/broken.md';
const SIBLING_ANN: Annotation = { id: 'sib-1', blockId: 'blk', startOffset: 0, endOffset: 4, type: 'COMMENT' as Annotation['type'], text: 'why?', originalText: 'Ship', createdA: 1, author: 'ramos' };

interface HarnessProps {
  folder?: boolean;
  onAdd?: (a: Annotation) => void;
  onSelect?: (id: string | null) => void;
}

/**
 * Mirrors App: the open document and its annotations are React STATE, and
 * linkedDoc.open only schedules a state update, so the hook sees the new
 * document on a later commit, exactly as with useLinkedDoc.
 */
function Harness({ folder = false, onAdd, onSelect }: HarnessProps) {
  const [openPath, setOpenPath] = React.useState<string | null>(null);
  const [annotations, setAnnotations] = React.useState<Annotation[]>([]);
  const [activeFile, setActiveFile] = React.useState<string | null>(null);
  const [openError, setOpenError] = React.useState<string | null>(null);
  const isSibling = openPath === SIBLING;
  const markdown = isSibling ? SIBLING_TEXT : PLAN;
  hookModule!.useDocumentWebMcp({
    isApiMode: true, isSharedSession: false, goalSetupMode: false, annotateMode: folder, annotateSource: folder ? 'folder' : null,
    liveApp: null, livePageUrl: '', archiveMode: false, gate: false, submitted: null, renderAs: 'markdown', rawHtml: '',
    displayedMarkdown: markdown, blocks: parseMarkdownToBlocks(markdown), allAnnotations: annotations,
    isEditingMarkdown: false, editorDiffersFromBaseline: false, sourceStale: false, sourceFilePath: ROOT, sourceInfo: undefined,
    versionInfo: null,
    linkedDoc: {
      isActive: isSibling,
      filepath: openPath,
      error: openError,
      getDocAnnotations: () => new Map<string, CachedDocState>([[SIBLING, { annotations: isSibling ? annotations : [SIBLING_ANN], globalAttachments: [], markdown: SIBLING_TEXT }]]),
      open: async (path) => {
        // Only state updates, applied on a later commit; nothing is visible
        // to the caller when this promise resolves. A failed load lands in
        // the error state like useLinkedDoc, it never rejects.
        await Promise.resolve();
        if (path === BROKEN) {
          setOpenError('Failed to load document');
          return;
        }
        setActiveFile(path);
        setOpenPath(path);
        setAnnotations([SIBLING_ANN]);
      },
    },
    fileBrowserDirs: folder ? [{ path: '/docs', tree: [
      { name: 'plan.md', path: 'plan.md', type: 'file' },
      { name: 'notes', path: 'notes', type: 'folder', children: [
        { name: 'rollout.md', path: 'notes/rollout.md', type: 'file' },
        { name: 'broken.md', path: 'notes/broken.md', type: 'file' },
      ] },
    ] }] : [],
    fileBrowserActiveFile: activeFile,
    viewerRef: { current: null }, scrollViewport: null,
    addAnnotation: (a) => { onAdd?.(a); setAnnotations((prev) => [...prev, a]); },
    editAnnotation: (id, patch) => setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a))),
    deleteAnnotation: (id) => setAnnotations((prev) => prev.filter((a) => a.id !== id)),
    selectAnnotation: (id) => onSelect?.(id),
    showBanner: () => {},
  });
  return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
// The settings storage seam, observed directly: what the opt-out writes is
// the footprint under test, so the assertions read the backend the code
// writes through rather than happy-dom's cookie jar.
const stored = new Map<string, string>();

async function mount(props: HarnessProps): Promise<FakeContext> {
  const ctx = fakeContext();
  Object.defineProperty(document, 'modelContext', { configurable: true, value: ctx });
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Harness {...props} />);
  });
  return ctx;
}

// Deliberately NOT wrapped in act(): a tool call that navigates waits for a
// React commit, and act() would hold that commit until the callback settled,
// which is the deadlock a real page never has. React commits on its own
// scheduler here, as in the browser; the trailing act() drains what is left.
async function call(ctx: FakeContext, name: string, input: unknown): Promise<any> {
  const response = await ctx.tools.get(`plannotator.${name}`)!.execute(input, { signal: new AbortController().signal });
  await act(async () => {});
  return response;
}

beforeEach(() => {
  resetWebMcpActivity();
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
    removeItem: (key) => { stored.delete(key); },
  });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  setWebMcpToolsEnabled(true);
  resetStorageBackend();
  if (originalDescriptor) Object.defineProperty(document, 'modelContext', originalDescriptor);
  else delete (document as unknown as Record<string, unknown>).modelContext;
});

describe.skipIf(!hasDom)('useDocumentWebMcp', () => {
  test('the opt-out unregisters and re-registers the catalog, and the default leaves no cookie', async () => {
    const ctx = await mount({});
    expect([...ctx.tools.keys()].sort()).toEqual([
      'plannotator.add_comments', 'plannotator.nudge_user', 'plannotator.read_document',
      'plannotator.remove_comments', 'plannotator.reveal', 'plannotator.update_comment',
    ]);
    expect(getWebMcpActivity().calls).toBe(0);
    expect(stored.has(WEBMCP_TOOLS_COOKIE)).toBe(false);

    await act(async () => { setWebMcpToolsEnabled(false); });
    expect(ctx.tools.size).toBe(0);
    expect(stored.get(WEBMCP_TOOLS_COOKIE)).toBe('false');

    await act(async () => { setWebMcpToolsEnabled(true); });
    expect(ctx.tools.size).toBe(6);
    expect(stored.has(WEBMCP_TOOLS_COOKIE)).toBe(false);
  });

  test('add_comments stamps browser-agent, records activity, and its own response already reflects the new comment', async () => {
    const added: Annotation[] = [];
    const ctx = await mount({ onAdd: (a) => added.push(a) });
    const response = await call(ctx, 'add_comments', { comments: [{ quote: 'Rotate the key', text: 'Grace window?' }] });
    expect(response.ok).toBe(true);
    expect(added[0]).toMatchObject({ source: 'browser-agent', author: 'browser-agent', originalText: 'Rotate the key', text: 'Grace window?' });
    expect(getWebMcpActivity()).toEqual({ calls: 1, lastTool: 'add_comments' });
    expect(typeof response.data.results[0].annotation.seq).toBe('number');
    const codes = response.nudges.map((n: { code: string }) => n.code);
    expect(codes).toContain('pending_unsent');
    // The agent's own write is never "new" to it.
    expect(codes).not.toContain('annotations_new');
  });

  test('reveal { annotationId, path } navigates, waits for the commit, then selects the comment', async () => {
    const selected: Array<string | null> = [];
    const ctx = await mount({ folder: true, onSelect: (id) => selected.push(id) });
    const response = await call(ctx, 'reveal', { annotationId: SIBLING_ANN.id, path: SIBLING });
    expect(response).toMatchObject({ ok: true, data: { revealed: 'annotation', navigated: true, path: SIBLING } });
    expect(selected).toEqual([SIBLING_ANN.id]);
  });

  test('reveal { path } answers promptly for a path the session cannot open', async () => {
    const ctx = await mount({ folder: true });
    // Not in the tree or the cache: not_found at once, no commit wait.
    const startUnknown = Date.now();
    const unknown = await call(ctx, 'reveal', { section: 'rollout', path: '/elsewhere/ghost.md' });
    expect(unknown.ok === false && unknown.error.code).toBe('not_found');
    expect(Date.now() - startUnknown).toBeLessThan(1000);
    // In the tree, but the load fails: the linked-doc error state fails the
    // waiter instead of letting it run out the 5s timeout.
    const startBroken = Date.now();
    const broken = await call(ctx, 'reveal', { section: 'rollout', path: BROKEN });
    expect(broken.ok === false && broken.error.code).toBe('not_found');
    expect(Date.now() - startBroken).toBeLessThan(1000);
  });

  test('the agent removing its own comment is not reported back as a human removal', async () => {
    const ctx = await mount({});
    const added = await call(ctx, 'add_comments', { comments: [{ text: 'agent note' }] });
    const id = added.data.results[0].annotation.id;
    const removed = await call(ctx, 'remove_comments', { ids: [id] });
    expect(removed.data.results[0].ok).toBe(true);
    expect(removed.nudges.map((n: { code: string }) => n.code)).not.toContain('annotations_removed');
    const read = await call(ctx, 'read_document', { include: ['annotations'] });
    expect(read.nudges.map((n: { code: string }) => n.code)).not.toContain('annotations_removed');
  });

  test('folder sessions list the file browser tree and report its selection as the open sibling', async () => {
    const ctx = await mount({ folder: true });
    const listed = await call(ctx, 'list_documents', {});
    expect(listed.data.documents.map((d: { path: string }) => d.path)).toEqual(['/docs/notes/broken.md', '/docs/notes/rollout.md', '/docs/plan.md', '/docs/rollout.md']);
    // Navigating makes the browser selection the open document; the sibling
    // it left is no longer "open" and the nudges say the human moved.
    await call(ctx, 'reveal', { section: 'rollout', path: SIBLING });
    const read = await call(ctx, 'read_document', { include: ['outline'] });
    expect(read.data.document.path).toBe(SIBLING);
    expect(read.data.outline.map((o: { id: string }) => o.id)).toEqual(['rollout']);
  });
});
