/**
 * Catalog contract with a fake adapter, no DOM. Named for invariants:
 *
 *  - no tool name in any built set is a decision verb (approve / deny /
 *    submit / send / close / stage / viewed); write tools are absent once the
 *    session is read-only or decided; list_documents exists only in folder
 *    sessions; every read tool carries readOnlyHint and read_document carries
 *    untrustedContentHint; names match the spec pattern; descriptions and
 *    parameter descriptions stay within the LLM-reader budgets.
 *  - anchoring cascade: inReplyTo inherits the parent anchor, quote resolves
 *    by text (ambiguous with two matches, disambiguated by section), section
 *    alone anchors on the heading, none is a document-level note.
 *  - ownership: update_comment / remove_comments refuse human-authored ids.
 *  - idempotency: a repeated requestId returns the existing comment.
 *  - windowing: 16k default cut at a block boundary with a continuation
 *    nudge; `since` marks novelty; comment-only surfaces never yield a
 *    DELETION and quote-verify against the page text.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation, type Block } from '@plannotator/ui/types';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import {
  BROWSER_AGENT_SOURCE,
  TOOL_DESCRIPTION_MAX_CHARS,
  TOOL_NAME_PATTERN,
  TOOL_PARAM_DESCRIPTION_MAX_CHARS,
  runTool,
  type ToolResponse,
  type ToolSpec,
} from '@plannotator/ui/webmcp';
import {
  buildDocumentHooks,
  buildDocumentTools,
  createDocumentToolState,
  type DocumentSessionView,
  type DocumentSnapshot,
  type DocumentToolAdapter,
  type SiblingDocument,
} from './documentTools';
import { buildOutline, resolveQuote, windowText } from './documentText';

const PLAN = `# Add rate limiting

## Goal

Protect the upload endpoint from abuse.

## Auth changes

We will rotate the signing key on every deploy so that stale tokens fail.

The rotation runs at boot.

## Rollout

Ship behind a flag. The rotation runs at boot.
`;

const toolName = (bare: string) => `plannotator.${bare}`;

interface Fake {
  adapter: DocumentToolAdapter;
  annotations: Annotation[];
  siblings: SiblingDocument[];
  banners: string[];
  revealed: string[];
  session: DocumentSessionView;
  text: string;
  blocks: Block[];
  call(name: string, input?: unknown): Promise<ToolResponse>;
  tools: ToolSpec<never, unknown>[];
  rebuild(options?: { writable?: boolean; folder?: boolean }): void;
}

function fake(overrides: Partial<DocumentSessionView> = {}, text = PLAN, options: { writable?: boolean; folder?: boolean } = {}): Fake {
  const annotations: Annotation[] = [];
  const siblings: SiblingDocument[] = [];
  const banners: string[] = [];
  const revealed: string[] = [];
  const session: DocumentSessionView = {
    mode: 'plan', surface: 'markdown', source: { title: 'Add rate limiting', path: '/plan.md', url: null },
    gate: false, readOnly: false, decision: 'pending', commentOnly: false, sourceStale: false, editing: false,
    versions: { current: 1, total: 1 }, pageUrl: null, ...overrides,
  };
  const blocks = parseMarkdownToBlocks(text);
  let clock = 1_700_000_000_000;
  const state = createDocumentToolState(() => clock++);
  const docs = new Map<string, DocumentSnapshot>();
  const adapter: DocumentToolAdapter = {
    getSession: () => session,
    getDocument: () => ({ path: '/plan.md', text: session.surface === 'live-app' ? null : text, blocks: session.surface === 'live-app' ? [] : blocks, annotations, html: session.surface === 'html' ? `<html><body><p>${text}</p></body></html>` : null }),
    readDocument: async (path) => docs.get(path) ?? null,
    getSiblingDocuments: () => siblings,
    listDocuments: () => [...docs.keys()].map((path) => ({ path })),
    getComposer: () => ({ open: false }),
    addAnnotation: (a, path) => { if (path !== null && path !== '/plan.md') return false; annotations.push(a); return true; },
    updateAnnotation: (id, patch, path) => { if (path !== null && path !== '/plan.md') return false; const i = annotations.findIndex((a) => a.id === id); if (i < 0) return false; annotations[i] = { ...annotations[i]!, ...patch }; return true; },
    removeAnnotation: (id, path) => { if (path !== null && path !== '/plan.md') return false; const i = annotations.findIndex((a) => a.id === id); if (i < 0) return false; annotations.splice(i, 1); return true; },
    revealAnnotation: (id) => { if (!annotations.some((a) => a.id === id)) return false; revealed.push(id); return true; },
    revealSection: (blockId) => { revealed.push(blockId); return true; },
    showBanner: (m) => { banners.push(m); },
  };
  const hooks = buildDocumentHooks(adapter, state, toolName);
  let tools = buildDocumentTools(adapter, state, { writable: options.writable ?? true, folder: options.folder ?? false, toolName });
  const self: Fake = {
    adapter, annotations, siblings, banners, revealed, session, text, blocks,
    get tools() { return tools; },
    rebuild(next = {}) { tools = buildDocumentTools(adapter, state, { writable: next.writable ?? true, folder: next.folder ?? false, toolName }); },
    async call(name, input = {}) {
      const spec = tools.find((t) => t.name === name);
      if (!spec) throw new Error(`tool ${name} not in the built set`);
      return runTool(spec as ToolSpec<unknown, unknown>, hooks, input, { signal: new AbortController().signal });
    },
  };
  (self as Fake & { docs: Map<string, DocumentSnapshot> }).docs = docs;
  return self;
}

function humanComment(fx: Fake, quote: string, text: string, extra: Partial<Annotation> = {}): Annotation {
  const res = resolveQuote(fx.blocks, quote);
  if (res.status !== 'found') throw new Error('fixture quote must resolve');
  const ann: Annotation = {
    id: `h-${fx.annotations.length + 1}`, blockId: res.match.blockId, startOffset: res.match.startOffset, endOffset: res.match.endOffset,
    type: AnnotationType.COMMENT, text, originalText: res.match.originalText, createdA: Date.now(), author: 'ramos', ...extra,
  };
  fx.annotations.push(ann);
  return ann;
}

const dataOf = (r: ToolResponse): any => (r.ok ? r.data : (() => { throw new Error(`expected ok, got ${JSON.stringify(r)}`); })());

describe('catalog shape', () => {
  test('no built set exposes a decision, submission, staging or viewed verb', () => {
    for (const set of [fake().tools, fake({}, PLAN, { folder: true }).tools, fake({}, PLAN, { writable: false }).tools]) {
      for (const tool of set) {
        expect(tool.name).not.toMatch(/approve|deny|submit|send|close|stage|viewed|feedback|lgtm/i);
        expect(tool.name).toMatch(TOOL_NAME_PATTERN);
        expect(`plannotator.${tool.name}`).toMatch(TOOL_NAME_PATTERN);
      }
    }
  });

  test('write tools are absent once the session is read-only or decided; list_documents only in folders', () => {
    const names = (set: ToolSpec<never, unknown>[]) => set.map((t) => t.name).sort();
    expect(names(fake().tools)).toEqual(['add_comments', 'nudge_user', 'read_document', 'remove_comments', 'reveal', 'update_comment']);
    expect(names(fake({}, PLAN, { writable: false }).tools)).toEqual(['nudge_user', 'read_document', 'reveal']);
    expect(names(fake({}, PLAN, { folder: true }).tools)).toContain('list_documents');
    expect(names(fake().tools)).not.toContain('list_documents');
  });

  test('hints: read tools are readOnly, read_document is untrusted content, remove_comments is destructive, mutations carry no readOnly', () => {
    const byName = new Map(fake({}, PLAN, { folder: true }).tools.map((t) => [t.name, t]));
    expect(byName.get('read_document')?.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    expect(byName.get('list_documents')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('remove_comments')?.annotations?.destructiveHint).toBe(true);
    for (const name of ['add_comments', 'update_comment', 'remove_comments', 'reveal', 'nudge_user']) {
      expect(byName.get(name)?.annotations?.readOnlyHint).toBeFalsy();
    }
  });

  test('descriptions fit the LLM-reader budgets and say when not to use the tool', () => {
    const walk = (schema: any, out: string[]) => {
      if (!schema || typeof schema !== 'object') return;
      if (typeof schema.description === 'string') out.push(schema.description);
      for (const child of Object.values(schema.properties ?? {})) walk(child, out);
      if (schema.items) walk(schema.items, out);
    };
    for (const tool of fake({}, PLAN, { folder: true }).tools) {
      expect(tool.description.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_MAX_CHARS);
      // Deliberate pin: the design requires every description to say when NOT
      // to use the tool (an LLM-reader rule, not incidental prose). The regex
      // accepts the phrasings in use; a description that drops the clause
      // entirely must fail here.
      expect(tool.description).toMatch(/Do not use|do not use|It refuses|It cannot|It returns no content/);
      const params: string[] = [];
      walk(tool.inputSchema, params);
      for (const p of params) expect(p.length).toBeLessThanOrEqual(TOOL_PARAM_DESCRIPTION_MAX_CHARS);
    }
  });
});

describe('read_document', () => {
  test('the zero-argument call returns session, text, outline, annotations, otherDocuments and a cursor', async () => {
    const fx = fake();
    humanComment(fx, 'rotate the signing key on every deploy', 'Needs a grace window.');
    const res = await fx.call('read_document');
    const data = dataOf(res);
    expect(data.session.mode).toBe('plan');
    expect(data.session.humanComments).toBe(1);
    expect(data.text).toBe(PLAN);
    expect(data.textRange.truncated).toBe(false);
    expect(data.outline.map((o: any) => o.id)).toEqual(['add-rate-limiting', 'goal', 'auth-changes', 'rollout']);
    expect(data.outline.find((o: any) => o.id === 'auth-changes').annotations).toBe(1);
    expect(data.annotations[0]).toMatchObject({
      id: 'h-1', kind: 'comment', author: 'ramos', source: 'human', isNew: true,
      section: { id: 'auth-changes', title: 'Auth changes' }, quote: 'rotate the signing key on every deploy', inReplyTo: null, replies: [],
    });
    expect(data.annotations[0].context).toContain('rotate the signing key');
    expect(data.otherDocuments).toEqual([]);
    expect(res.ok && res.cursor).toMatch(/^w:\d+$/);
    expect(res.nudges.map((n) => n.code)).toEqual(['annotations_new', 'pending_unsent']);
  });

  test('the watermark advances per response so the same comment is new exactly once; since re-opens the window', async () => {
    const fx = fake();
    humanComment(fx, 'Ship behind a flag', 'why?');
    const first = await fx.call('read_document');
    expect(dataOf(first).annotations[0].isNew).toBe(true);
    const second = await fx.call('read_document');
    expect(dataOf(second).annotations[0].isNew).toBe(false);
    expect(second.nudges.map((n) => n.code)).toEqual(['pending_unsent']);
    const replay = await fx.call('read_document', { since: 'w:0' });
    expect(dataOf(replay).annotations[0].isNew).toBe(true);
    expect(replay.nudges.map((n) => n.code)).toContain('annotations_new');
  });

  test('section narrows the text, include narrows the fields, unknown section is not_found', async () => {
    const fx = fake();
    const res = await fx.call('read_document', { section: 'auth-changes', include: ['text'] });
    const data = dataOf(res);
    expect(data.text.startsWith('## Auth changes')).toBe(true);
    expect(data.text).not.toContain('## Rollout');
    expect(data.outline).toBeUndefined();
    expect(data.annotations).toBeUndefined();
    const missing = await fx.call('read_document', { section: 'nope' });
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });

  test('a long document is windowed at a block boundary with a truncated nudge carrying the continuation', async () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'x'.repeat(400)}`).join('\n\n');
    const fx = fake({}, `# Long\n\n${paragraphs}\n`);
    const res = await fx.call('read_document');
    const data = dataOf(res);
    expect(data.textRange.truncated).toBe(true);
    expect(data.text.length).toBeLessThanOrEqual(16000);
    expect(data.text.endsWith('\n')).toBe(true);
    const nudge = res.nudges.find((n) => n.code === 'truncated');
    expect(nudge?.action).toEqual({ tool: 'plannotator.read_document', args: { offset: data.textRange.nextOffset } });
    const next = await fx.call('read_document', { offset: data.textRange.nextOffset });
    expect(dataOf(next).text.startsWith('Paragraph')).toBe(true);
    expect(data.text + dataOf(next).text).toBe(data.text + fx.text.slice(data.textRange.nextOffset, data.textRange.nextOffset + dataOf(next).textRange.length));
  });

  test('a live app reads no text and says so instead of pretending', async () => {
    const fx = fake({ surface: 'live-app', mode: 'annotate-app', commentOnly: true, pageUrl: '/admin' });
    const data = dataOf(await fx.call('read_document'));
    expect(data.text).toBeNull();
    expect(data.document.textAvailable).toBe(false);
    expect(data.outline).toEqual([]);
  });

  test('a sibling read never touches the open document and marks that path as read', async () => {
    const fx = fake({}, PLAN, { folder: true });
    (fx as any).docs.set('/notes/rollout.md', { path: '/notes/rollout.md', text: '# Rollout\n\nNotes.\n', blocks: parseMarkdownToBlocks('# Rollout\n\nNotes.\n'), annotations: [{ id: 's-1', blockId: '', startOffset: 0, endOffset: 0, type: AnnotationType.GLOBAL_COMMENT, text: 'sibling note', originalText: '', createdA: 1 }] });
    fx.siblings.push({ path: '/notes/rollout.md', open: false, annotations: (fx as any).docs.get('/notes/rollout.md').annotations, composerOpen: false });
    const first = await fx.call('read_document');
    expect(dataOf(first).otherDocuments[0]).toMatchObject({ path: '/notes/rollout.md', annotations: 1, newSinceLastRead: 1 });
    expect(first.nudges.find((n) => n.code === 'other_document_active')?.action).toEqual({ tool: 'plannotator.read_document', args: { path: '/notes/rollout.md' } });
    const sibling = await fx.call('read_document', { path: '/notes/rollout.md' });
    expect(dataOf(sibling).text).toBe('# Rollout\n\nNotes.\n');
    expect(dataOf(sibling).annotations[0].isNew).toBe(true);
    expect(fx.revealed).toEqual([]);
    const again = await fx.call('read_document');
    expect(dataOf(again).otherDocuments[0].newSinceLastRead).toBe(0);
    expect(again.nudges.some((n) => n.code === 'other_document_active')).toBe(false);
  });
});

describe('add_comments anchoring cascade', () => {
  test('a quote anchors on the block that contains it and returns context; a repeated requestId is deduplicated', async () => {
    const fx = fake();
    const input = { comments: [{ quote: 'rotate the signing key', text: 'Needs a grace window.', requestId: 'r1' }] };
    const first = dataOf(await fx.call('add_comments', input));
    expect(first.created).toBe(1);
    expect(first.results[0]).toMatchObject({ ok: true, index: 0, anchoredBy: 'quote' });
    expect(first.results[0].annotation.context).toContain('rotate the signing key');
    expect(fx.annotations.length).toBe(1);
    expect(fx.annotations[0]).toMatchObject({ type: AnnotationType.COMMENT, source: BROWSER_AGENT_SOURCE, author: BROWSER_AGENT_SOURCE, originalText: 'rotate the signing key' });
    const again = dataOf(await fx.call('add_comments', input));
    expect(again.created).toBe(0);
    expect(again.results[0]).toMatchObject({ ok: true, deduplicated: true, annotation: { id: fx.annotations[0]!.id } });
    expect(fx.annotations.length).toBe(1);
  });

  test('the agent\'s own comment is never new to it, and the response nudges reflect the mutation', async () => {
    const fx = fake();
    const res = await fx.call('add_comments', { comments: [{ text: 'Looks ready to me.' }] });
    expect(res.nudges.map((n) => n.code)).toEqual(['pending_unsent']);
    const read = dataOf(await fx.call('read_document'));
    expect(read.annotations[0].isNew).toBe(false);
    expect(read.session.agentComments).toBe(1);
  });

  test('an ambiguous quote fails with both contexts as candidates and section disambiguates', async () => {
    const fx = fake();
    const amb = dataOf(await fx.call('add_comments', { comments: [{ quote: 'The rotation runs at boot', text: 'x' }] }));
    expect(amb.results[0]).toMatchObject({ ok: false, error: { code: 'ambiguous' } });
    expect(amb.results[0].error.candidates.length).toBe(2);
    expect(fx.annotations.length).toBe(0);
    const good = dataOf(await fx.call('add_comments', { comments: [{ quote: 'The rotation runs at boot', section: 'rollout', text: 'x' }] }));
    expect(good.results[0].ok).toBe(true);
    expect(good.results[0].annotation.section.id).toBe('rollout');
  });

  test('section alone anchors on the heading; a missing quote is not_found; no anchor is a document-level note', async () => {
    const fx = fake();
    const data = dataOf(await fx.call('add_comments', { comments: [
      { section: 'goal', text: 'Scope is right.' },
      { quote: 'this text is nowhere', text: 'x' },
      { text: 'General note.' },
    ] }));
    expect(data.results.map((r: any) => r.ok)).toEqual([true, false, true]);
    expect(data.results[0].anchoredBy).toBe('section');
    expect(fx.annotations[0]!.originalText).toBe('Goal');
    expect(data.results[1].error.code).toBe('not_found');
    expect(data.results[2].anchoredBy).toBe('document');
    expect(data.results[2].annotation.kind).toBe('note');
    expect(fx.annotations[1]!.type).toBe(AnnotationType.GLOBAL_COMMENT);
  });

  test('inReplyTo inherits the parent anchor and threads under it', async () => {
    const fx = fake();
    const parent = humanComment(fx, 'Ship behind a flag', 'Which flag?', { startMeta: { parentTagName: 'P', parentIndex: 3, textOffset: 0 } });
    const data = dataOf(await fx.call('add_comments', { comments: [{ inReplyTo: parent.id, text: 'The upload_limits flag.' }] }));
    expect(data.results[0].anchoredBy).toBe('reply');
    const reply = fx.annotations[1]!;
    expect(reply).toMatchObject({ inReplyTo: parent.id, blockId: parent.blockId, startOffset: parent.startOffset, endOffset: parent.endOffset, originalText: parent.originalText, startMeta: parent.startMeta });
    const read = dataOf(await fx.call('read_document'));
    expect(read.annotations.find((a: any) => a.id === parent.id).replies).toEqual([reply.id]);
    const unknown = dataOf(await fx.call('add_comments', { comments: [{ inReplyTo: 'nope', text: 'x' }] }));
    expect(unknown.results[0].error.code).toBe('not_found');
  });

  test('a comment-only surface never yields a DELETION and verifies the quote against the page text', async () => {
    const fx = fake({ surface: 'html', commentOnly: true, mode: 'annotate' });
    const data = dataOf(await fx.call('add_comments', { comments: [
      { quote: 'Ship behind a flag', text: 'ok' },
      { quote: 'not on the page', text: 'x' },
      { text: 'note' },
    ] }));
    expect(data.results.map((r: any) => r.ok)).toEqual([true, false, true]);
    expect(fx.annotations.every((a) => a.type !== AnnotationType.DELETION)).toBe(true);
    expect(fx.annotations[0]!.originalText).toBe('Ship behind a flag');
  });

  test('a live app accepts an unverified quote anchor and says so', async () => {
    const fx = fake({ surface: 'live-app', mode: 'annotate-app', commentOnly: true, pageUrl: '/admin' });
    const data = dataOf(await fx.call('add_comments', { comments: [{ quote: 'Save changes', text: 'Label is vague.' }] }));
    expect(data.results[0]).toMatchObject({ ok: true, anchoredBy: 'quote', verified: false });
  });

  test('a sibling document that is not open answers not_available with the reveal hint', async () => {
    const fx = fake({}, PLAN, { folder: true });
    (fx as any).docs.set('/other.md', { path: '/other.md', text: '# Other\n\nBody.\n', blocks: parseMarkdownToBlocks('# Other\n\nBody.\n'), annotations: [] });
    const data = dataOf(await fx.call('add_comments', { comments: [{ path: '/other.md', quote: 'Body', text: 'x' }] }));
    expect(data.results[0]).toMatchObject({ ok: false, error: { code: 'not_available' } });
    expect(data.results[0].error.hint).toContain('reveal');
  });

  test('after the human decides, add_comments is refused even if still reachable', async () => {
    const fx = fake({ decision: 'approved' });
    const res = await fx.call('add_comments', { comments: [{ text: 'late' }] });
    expect(!res.ok && res.error.code).toBe('not_available');
    expect(res.nudges.map((n) => n.code)).toEqual(['session_decided']);
  });

  test('input limits are enforced by the schema before any write', async () => {
    const fx = fake();
    const tooMany = await fx.call('add_comments', { comments: Array.from({ length: 21 }, () => ({ text: 'x' })) });
    expect(!tooMany.ok && tooMany.error.code).toBe('invalid_input');
    const empty = await fx.call('add_comments', { comments: [] });
    expect(!empty.ok && empty.error.code).toBe('invalid_input');
    expect(fx.annotations.length).toBe(0);
  });
});

describe('ownership', () => {
  test('update_comment and remove_comments refuse human-authored comments and succeed on agent-authored ones', async () => {
    const fx = fake();
    const human = humanComment(fx, 'Ship behind a flag', 'human note');
    const mine = dataOf(await fx.call('add_comments', { comments: [{ text: 'agent note' }] })).results[0].annotation;

    const forbidden = await fx.call('update_comment', { id: human.id, text: 'rewritten' });
    expect(!forbidden.ok && forbidden.error.code).toBe('forbidden');
    expect(fx.annotations.find((a) => a.id === human.id)?.text).toBe('human note');

    const updated = dataOf(await fx.call('update_comment', { id: mine.id, text: 'agent note v2' }));
    expect(updated.annotation.text).toBe('agent note v2');
    expect(fx.annotations.find((a) => a.id === mine.id)?.text).toBe('agent note v2');
    expect(dataOf(await fx.call('read_document')).annotations.find((a: any) => a.id === mine.id).isNew).toBe(false);

    const removed = dataOf(await fx.call('remove_comments', { ids: [human.id, mine.id, 'ghost'] }));
    expect(removed.results).toEqual([
      { id: human.id, ok: false, error: { code: 'forbidden', message: expect.any(String), hint: expect.any(String) } },
      { id: mine.id, ok: true },
      { id: 'ghost', ok: false, error: { code: 'not_found', message: expect.any(String) } },
    ]);
    expect(removed.removed).toBe(1);
    expect(fx.annotations.map((a) => a.id)).toEqual([human.id]);
  });

  test('the agent removing its own comment is never reported back to it as a human removal', async () => {
    const fx = fake();
    const mine = dataOf(await fx.call('add_comments', { comments: [{ text: 'agent note' }] })).results[0].annotation;
    const removed = await fx.call('remove_comments', { ids: [mine.id] });
    expect(removed.ok && removed.data.removed).toBe(1);
    expect(removed.nudges.map((n) => n.code)).not.toContain('annotations_removed');
    const next = await fx.call('read_document');
    expect(next.nudges.map((n) => n.code)).not.toContain('annotations_removed');
  });

  test('the human removing an agent comment surfaces as annotations_removed on the next call', async () => {
    const fx = fake();
    const mine = dataOf(await fx.call('add_comments', { comments: [{ text: 'agent note' }] })).results[0].annotation;
    fx.annotations.splice(fx.annotations.findIndex((a) => a.id === mine.id), 1);
    const res = await fx.call('read_document');
    const nudge = res.nudges.find((n) => n.code === 'annotations_removed');
    expect(nudge?.ids).toEqual([mine.id]);
    // Deliberate pin: the "your comments" wording is the resolution signal
    // (see nudges.test.ts); the catalog must route an agent-owned removal to it.
    expect(nudge?.message).toContain('your comments');
  });

  test('ownership is the session claim, not the source stamp: a browser-agent comment the tools did not create is refused', async () => {
    const fx = fake();
    // Posted through the external-annotations API with a forged source.
    fx.annotations.push({
      id: 'ext-1', blockId: '', startOffset: 0, endOffset: 0, type: AnnotationType.GLOBAL_COMMENT,
      text: 'eslint finding wearing the agent stamp', originalText: '', createdA: 1, source: BROWSER_AGENT_SOURCE, author: BROWSER_AGENT_SOURCE,
    });
    const upd = await fx.call('update_comment', { id: 'ext-1', text: 'rewritten' });
    expect(upd.ok === false && upd.error.code).toBe('forbidden');
    const rm = dataOf(await fx.call('remove_comments', { ids: ['ext-1'] }));
    expect(rm.results[0]).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(fx.annotations.some((a) => a.id === 'ext-1')).toBe(true);
  });
});

describe('requestId replay after the human removed the comment', () => {
  test('answers conflict instead of re-creating the comment', async () => {
    const fx = fake();
    const first = dataOf(await fx.call('add_comments', { comments: [{ text: 'agent note', requestId: 'r-1' }] }));
    const id = first.results[0].annotation.id;
    fx.annotations.splice(fx.annotations.findIndex((a) => a.id === id), 1);
    const replay = dataOf(await fx.call('add_comments', { comments: [{ text: 'agent note', requestId: 'r-1' }] }));
    expect(replay.created).toBe(0);
    expect(replay.results[0]).toMatchObject({ ok: false, index: 0, error: { code: 'conflict' } });
    expect(fx.annotations.length).toBe(0);
  });
});

describe('reveal, nudge_user, list_documents', () => {
  test('reveal selects an annotation or scrolls to a section and never returns content', async () => {
    const fx = fake();
    const human = humanComment(fx, 'Ship behind a flag', 'x');
    expect(dataOf(await fx.call('reveal', { annotationId: human.id }))).toEqual({ revealed: 'annotation', navigated: false });
    expect(dataOf(await fx.call('reveal', { section: 'rollout' }))).toEqual({ revealed: 'section', navigated: false });
    expect(fx.revealed).toEqual([human.id, buildOutline(fx.blocks, []).find((o) => o.id === 'rollout')!.blockId]);
    const none = await fx.call('reveal', {});
    expect(!none.ok && none.error.code).toBe('invalid_input');
    const missing = await fx.call('reveal', { annotationId: 'ghost' });
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });

  test('nudge_user shows the message and is capped at 280 characters', async () => {
    const fx = fake();
    expect(dataOf(await fx.call('nudge_user', { message: '  Ready for your approval.  ' }))).toEqual({ shown: true });
    expect(fx.banners).toEqual(['Ready for your approval.']);
    const long = await fx.call('nudge_user', { message: 'x'.repeat(281) });
    expect(!long.ok && long.error.code).toBe('invalid_input');
    expect(fx.banners.length).toBe(1);
  });

  test('list_documents lists the tree with counts and filters by substring', async () => {
    const fx = fake({}, PLAN, { folder: true });
    (fx as any).docs.set('/notes/rollout.md', { path: '/notes/rollout.md', text: '# R\n', blocks: [], annotations: [] });
    (fx as any).docs.set('/notes/auth.md', { path: '/notes/auth.md', text: '# A\n', blocks: [], annotations: [] });
    humanComment(fx, 'Ship behind a flag', 'x');
    const all = dataOf(await fx.call('list_documents'));
    expect(all.documents.map((d: any) => d.path)).toEqual(['/notes/auth.md', '/notes/rollout.md', '/plan.md']);
    expect(all.documents.find((d: any) => d.path === '/plan.md')).toMatchObject({ open: true, annotations: 1 });
    const filtered = dataOf(await fx.call('list_documents', { filter: 'AUTH' }));
    expect(filtered.documents.map((d: any) => d.path)).toEqual(['/notes/auth.md']);
  });
});

describe('documentText helpers', () => {
  test('windowText cuts at the last block boundary inside the budget and continues exactly', () => {
    const text = 'aaaa\n\nbbbb\n\ncccc\n\ndddd\n';
    const blocks = parseMarkdownToBlocks(text);
    const w = windowText(text, blocks, 0, 13);
    expect(w.text).toBe('aaaa\n\nbbbb\n\n');
    expect(w.nextOffset).toBe(12);
    const rest = windowText(text, blocks, w.nextOffset!, 100);
    expect(w.text + rest.text).toBe(text);
    expect(rest.truncated).toBe(false);
  });

  test('windowText hard-cuts a single block larger than the budget rather than returning nothing', () => {
    const text = 'x'.repeat(50);
    const w = windowText(text, parseMarkdownToBlocks(text), 0, 10);
    expect(w.text.length).toBe(10);
    expect(w.nextOffset).toBe(10);
  });

  test('resolveQuote tolerates whitespace differences and returns the document\'s own text', () => {
    const blocks = parseMarkdownToBlocks('Para one has   two  spaces.\n');
    const res = resolveQuote(blocks, 'has two spaces');
    expect(res.status).toBe('found');
    if (res.status === 'found') expect(res.match.originalText).toBe('has   two  spaces');
  });

  test('duplicate heading titles get distinct outline ids', () => {
    const outline = buildOutline(parseMarkdownToBlocks('# A\n\n## Notes\n\n## Notes\n'), []);
    expect(outline.map((o) => o.id)).toEqual(['a', 'notes', 'notes-2']);
  });
});
