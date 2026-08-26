/**
 * Phase-1 WebMCP catalog for plan review and every annotate surface:
 * `read_document`, `add_comments`, `update_comment`, `remove_comments`,
 * `reveal`, `nudge_user`, plus `list_documents` in folder sessions.
 *
 * The agent reads, comments and points; the human decides. No tool here
 * approves, denies, submits, closes, stages or marks anything, and the
 * catalog test pins that by name. The catalog takes an ADAPTER (getters and
 * actions over App state) and never imports from App.tsx, so it is
 * unit-testable with a fake adapter and no DOM, and a host can build the
 * same adapter over its own document state.
 */
import { AnnotationType, type Annotation, type Block } from '@plannotator/ui/types';
import { generateId } from '@plannotator/ui/utils/generateId';
import {
  AnnotationChangeTracker,
  BROWSER_AGENT_SOURCE,
  ChangeTrackerSet,
  buildNudges,
  defineTool,
  fail,
  isAgentAnnotation,
  ok,
  type DocumentSurface,
  type Nudge,
  type NudgeSnapshot,
  type OtherDocumentActivity,
  type ToolError,
  type ToolSpec,
  type ToolsetHooks,
} from '@plannotator/ui/webmcp';
import {
  ANNOTATION_TEXT_MAX,
  DEFAULT_MAX_CHARS,
  MAX_ANNOTATIONS_IN_RESPONSE,
  buildOutline,
  capText,
  contextForAnnotation,
  findSection,
  htmlToPlainText,
  resolveQuote,
  sectionForBlock,
  sectionSlice,
  windowText,
  type OutlineEntry,
} from './documentText';

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export type SessionMode = 'plan' | 'annotate' | 'annotate-last' | 'annotate-folder' | 'annotate-app' | 'archive' | 'shared';
export type SessionDecision = 'pending' | 'approved' | 'feedback-sent' | 'exited';

export interface DocumentSessionView {
  mode: SessionMode;
  surface: DocumentSurface;
  source: { title: string | null; path: string | null; url: string | null };
  gate: boolean;
  readOnly: boolean;
  decision: SessionDecision;
  commentOnly: boolean;
  sourceStale: boolean;
  editing: boolean;
  versions: { current: number; total: number } | null;
  /** Live app: the in-app page (pathname + search) the human is on. */
  pageUrl: string | null;
}

export interface DocumentSnapshot {
  /** Absolute path (folder / file sessions) or null. */
  path: string | null;
  /** Document text, or null when the parent cannot see it (live app). */
  text: string | null;
  blocks: Block[];
  annotations: Annotation[];
  /** Raw HTML of an html surface, for quote verification. */
  html?: string | null;
}

export interface SiblingDocument {
  path: string;
  title?: string;
  /** The human is looking at this document right now. */
  open: boolean;
  annotations: Annotation[];
  composerOpen: boolean;
}

export interface DocumentToolAdapter {
  getSession(): DocumentSessionView;
  /** The document the human has open (root plan, or the active linked doc). */
  getDocument(): DocumentSnapshot;
  /** Folder / linked-doc sessions: a sibling by path, fetching when not cached. Null when unknown or not a folder session. */
  readDocument(path: string): Promise<DocumentSnapshot | null>;
  /** Documents other than the open one that the session knows (cache, file browser). */
  getSiblingDocuments(): SiblingDocument[];
  /** Folder sessions: every document in the tree (paths the file browser shows). */
  listDocuments?(): Array<{ path: string; title?: string }>;
  getComposer(): { open: boolean; section?: string };
  /** Mutations resolve false when the document is not the open one and the host cannot write to it. */
  addAnnotation(annotation: Annotation, path: string | null): boolean;
  updateAnnotation(id: string, patch: Partial<Annotation>, path: string | null): boolean;
  removeAnnotation(id: string, path: string | null): boolean;
  /** Select + scroll to the annotation; navigates when `path` is another document. Resolves false when nothing could be revealed. */
  revealAnnotation(id: string, path: string | null): Promise<boolean> | boolean;
  revealSection(blockId: string, path: string | null): Promise<boolean> | boolean;
  /** One transient banner, replaced by the next call. */
  showBanner(message: string): void;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface AnnotationView {
  id: string;
  kind: 'comment' | 'deletion' | 'note';
  author: string | null;
  source: string;
  createdAt: string;
  seq: number | null;
  isNew: boolean;
  section: { id: string; title: string } | null;
  quote: string;
  context: string;
  text: string;
  truncated?: boolean;
  inReplyTo: string | null;
  replies: string[];
  pageUrl?: string;
}

export type AnchoredBy = 'quote' | 'section' | 'reply' | 'document';

export interface AddCommentItem {
  text: string;
  quote?: string;
  section?: string;
  inReplyTo?: string;
  path?: string;
  requestId?: string;
}

export type AddCommentResult =
  | { ok: true; index: number; annotation: AnnotationView; anchoredBy: AnchoredBy; deduplicated?: boolean; verified?: boolean }
  | { ok: false; index: number; error: { code: 'not_found' | 'ambiguous' | 'forbidden' | 'invalid_input' | 'not_available' | 'conflict'; message: string; hint?: string; candidates?: string[] } };

const NOT_OWNED_HINT = 'Only comments you created in this session can be changed; reply with add_comments { inReplyTo } instead.';

const OPEN_FIRST_HINT = 'Call reveal { path } to open that document, then comment on it.';

export const NUDGE_USER_MAX_CHARS = 280;
export const MAX_COMMENTS_PER_CALL = 20;
export const MAX_REMOVALS_PER_CALL = 50;
export const MAX_OTHER_DOCUMENTS = 10;

// ---------------------------------------------------------------------------
// Persistent per-session state (survives catalog rebuilds)
// ---------------------------------------------------------------------------

export class DocumentToolState {
  readonly main: AnnotationChangeTracker;
  readonly siblings: ChangeTrackerSet;
  /** Per-sibling read watermark. */
  readonly siblingRead = new Map<string, number>();
  /** requestId -> what it created (idempotency). */
  readonly requests = new Map<string, { id: string; path: string | null; anchoredBy: AnchoredBy }>();
  lastPageUrl: string | null = null;
  lastOpenPath: string | null = null;
  responses = 0;
  /** Per-call scratch consumed by buildNudges. */
  current: { since?: number; truncated?: { nextOffset: number; args: Record<string, unknown> } } = {};

  constructor(readonly now: () => number = () => Date.now()) {
    this.main = new AnnotationChangeTracker(now);
    this.siblings = new ChangeTrackerSet(now);
  }
}

export function createDocumentToolState(now?: () => number): DocumentToolState {
  return new DocumentToolState(now);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoTime(ms: number | undefined, fallback: number): string {
  const value = typeof ms === 'number' && Number.isFinite(ms) ? ms : fallback;
  return new Date(value).toISOString();
}

function kindOf(annotation: Annotation): AnnotationView['kind'] {
  if (annotation.type === AnnotationType.DELETION) return 'deletion';
  if (annotation.type === AnnotationType.GLOBAL_COMMENT) return 'note';
  return 'comment';
}

function sortByDocumentOrder(blocks: readonly Block[], annotations: readonly Annotation[]): Annotation[] {
  const order = new Map(blocks.map((b, i) => [b.id, i] as const));
  return [...annotations].sort((a, b) => {
    const ia = a.blockId ? (order.get(a.blockId) ?? Number.MAX_SAFE_INTEGER) : -1;
    const ib = b.blockId ? (order.get(b.blockId) ?? Number.MAX_SAFE_INTEGER) : -1;
    if (ia !== ib) return ia - ib;
    if (a.startOffset !== b.startOffset) return a.startOffset - b.startOffset;
    return a.createdA - b.createdA;
  });
}

function viewOf(
  annotation: Annotation,
  all: readonly Annotation[],
  blocks: readonly Block[],
  outline: readonly OutlineEntry[],
  tracker: AnnotationChangeTracker,
  since: number,
  now: number,
): AnnotationView {
  const section = sectionForBlock(blocks, outline, annotation.blockId || undefined);
  const capped = capText(annotation.text, ANNOTATION_TEXT_MAX);
  const seq = tracker.seqOf(annotation.id);
  const view: AnnotationView = {
    id: annotation.id,
    kind: kindOf(annotation),
    author: annotation.author ?? null,
    source: annotation.source ?? 'human',
    createdAt: isoTime(annotation.createdA, now),
    seq: seq ?? null,
    isNew: tracker.isNew(annotation.id, since),
    section: section ? { id: section.id, title: section.title } : null,
    quote: annotation.type === AnnotationType.GLOBAL_COMMENT ? '' : (annotation.originalText ?? ''),
    context: annotation.type === AnnotationType.GLOBAL_COMMENT ? '' : contextForAnnotation(blocks, annotation),
    text: capped.text,
    inReplyTo: annotation.inReplyTo ?? null,
    replies: all.filter((a) => a.inReplyTo === annotation.id).map((a) => a.id),
  };
  if (capped.truncated) view.truncated = true;
  if (annotation.pageUrl) view.pageUrl = annotation.pageUrl;
  return view;
}

function surfaceOf(session: DocumentSessionView): DocumentSurface {
  return session.surface;
}

function trackerFor(state: DocumentToolState, path: string | null, openPath: string | null): AnnotationChangeTracker {
  if (path === null || path === openPath) return state.main;
  return state.siblings.forPath(path);
}

/** Observe every document the adapter can see (idempotent, O(n)). */
export function syncTrackers(adapter: DocumentToolAdapter, state: DocumentToolState): void {
  state.main.observe(adapter.getDocument().annotations);
  for (const sibling of adapter.getSiblingDocuments()) {
    state.siblings.forPath(sibling.path).observe(sibling.annotations);
  }
}

function otherDocumentActivity(adapter: DocumentToolAdapter, state: DocumentToolState): OtherDocumentActivity[] {
  const open = adapter.getDocument().path;
  return adapter
    .getSiblingDocuments()
    .filter((sibling) => sibling.path !== open)
    .map((sibling) => {
      const tracker = state.siblings.forPath(sibling.path);
      const since = state.siblingRead.get(sibling.path) ?? 0;
      return {
        path: sibling.path,
        open: sibling.open,
        annotations: sibling.annotations.length,
        newSinceLastRead: tracker.newSince(since).length,
        composerOpen: sibling.composerOpen,
        openedSinceLastRead: sibling.open && state.lastOpenPath !== sibling.path,
        lastActivity: tracker.lastActivity,
      };
    })
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
}

export interface DocumentToolsetOptions {
  /** Write tools are offered only while the human can still act (not read-only, not decided). */
  writable: boolean;
  /** `list_documents` exists only in folder sessions. */
  folder: boolean;
  /** Prefixed tool name for nudge actions (the registry prefixes at registration). */
  toolName: (bare: string) => string;
}

// ---------------------------------------------------------------------------
// Hooks (nudges + watermark) shared by every tool
// ---------------------------------------------------------------------------

export function buildDocumentHooks(adapter: DocumentToolAdapter, state: DocumentToolState, toolName: (bare: string) => string): ToolsetHooks {
  return {
    buildNudges: () => {
      syncTrackers(adapter, state);
      const session = adapter.getSession();
      const document = adapter.getDocument();
      const snapshot: NudgeSnapshot = {
        surface: surfaceOf(session),
        composer: adapter.getComposer(),
        sourceStale: session.sourceStale,
        documentEdited: session.editing,
        pageUrl: session.pageUrl,
        lastPageUrl: state.lastPageUrl,
        annotationCount: document.annotations.length,
        decided: session.decision !== 'pending',
        firstResponse: state.responses === 0,
        annotations: document.annotations,
        otherDocuments: otherDocumentActivity(adapter, state),
        since: state.current.since ?? state.main.watermark,
        ...(state.current.truncated ? { truncated: state.current.truncated } : {}),
      };
      return buildNudges(snapshot, state.main, toolName);
    },
    afterResponse: () => {
      state.main.advance();
      const session = adapter.getSession();
      state.lastPageUrl = session.pageUrl;
      const openSibling = adapter.getSiblingDocuments().find((s) => s.open);
      state.lastOpenPath = openSibling?.path ?? adapter.getDocument().path;
      state.responses += 1;
      state.current = {};
    },
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type ReadInput = {
  path?: string;
  section?: string;
  offset?: number;
  maxChars?: number;
  since?: string | number;
  include?: Array<'text' | 'annotations' | 'outline'>;
};

const PATH_PARAM = {
  type: 'string',
  maxLength: 4096,
  description: 'Folder or linked-doc sessions only: a sibling document path from otherDocuments or list_documents. Default: the open document.',
};

export function buildDocumentTools(adapter: DocumentToolAdapter, state: DocumentToolState, options: DocumentToolsetOptions): ToolSpec<never, unknown>[] {
  const { toolName } = options;
  const now = state.now;

  type Target = { snapshot: DocumentSnapshot; path: string | null; tracker: AnnotationChangeTracker; isOpen: boolean };
  type Missing = { ok: false; error: ToolError };
  const resolveTarget = async (path: string | undefined): Promise<Target | Missing> => {
    const open = adapter.getDocument();
    if (!path || path === open.path) {
      return { snapshot: open, path: open.path, tracker: state.main, isOpen: true };
    }
    const sibling = await adapter.readDocument(path);
    if (!sibling) {
      return { ok: false, error: { code: 'not_found', message: 'no document at that path in this session', hint: 'Use a path from otherDocuments or list_documents.' } };
    }
    const tracker = state.siblings.forPath(path);
    tracker.observe(sibling.annotations);
    return { snapshot: sibling, path, tracker, isOpen: false };
  };

  const readDocument = defineTool<ReadInput, unknown>({
    name: 'read_document',
    title: 'Read the document under review',
    description:
      'Everything about the page in one call: the session (mode, whether the human is editing, whether they already decided), the document text, its outline with per-section comment counts, every comment with its quoted text, surrounding context and whether it is new since your last read, the other documents the human is active on, and nudges. Use it to learn what is going on; call it with no arguments first. Do not use it just to look up a comment id that a previous response already gave you.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: PATH_PARAM,
        section: { type: 'string', maxLength: 512, description: 'Heading id from outline; returns only that section text (annotations stay complete).' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset into the (section) text for large documents. Default 0.' },
        maxChars: { type: 'integer', minimum: 200, maximum: 200000, description: 'Text budget; cut at a block boundary, nextOffset continues. Default 16000.' },
        since: { type: 'string', maxLength: 64, description: 'A cursor from an earlier response; marks comments newer than it as isNew instead of the per-tab watermark.' },
        include: { type: 'array', maxItems: 3, items: { type: 'string', enum: ['text', 'annotations', 'outline'] }, description: 'Subset to return. Default: all three.' },
      },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => {
      syncTrackers(adapter, state);
      const target = await resolveTarget(input.path);
      if ('ok' in target) return target;
      const { snapshot, tracker, isOpen } = target;
      const session = adapter.getSession();
      const include = new Set(input.include && input.include.length > 0 ? input.include : ['text', 'annotations', 'outline']);
      const explicitSince = AnnotationChangeTracker.parseSince(input.since);
      const since = explicitSince ?? (isOpen ? state.main.watermark : (state.siblingRead.get(target.path ?? '') ?? 0));
      if (isOpen && explicitSince !== null) state.current.since = explicitSince;

      const outline = buildOutline(snapshot.blocks, snapshot.annotations);
      let text: string | null = null;
      let textRange: { offset: number; length: number; total: number; truncated: boolean; nextOffset?: number } | null = null;
      if (include.has('text') && snapshot.text !== null) {
        let source = snapshot.text;
        const sectionArgs: Record<string, unknown> = {};
        if (input.section) {
          const section = findSection(outline, input.section);
          if (!section) return fail('not_found', 'no section with that id', { hint: 'Use an id from outline.' });
          source = sectionSlice(snapshot.text, snapshot.blocks, section).text;
          sectionArgs.section = section.id;
        }
        if (input.path && !isOpen) sectionArgs.path = input.path;
        const window = windowText(source, input.section ? [] : snapshot.blocks, input.offset ?? 0, input.maxChars ?? DEFAULT_MAX_CHARS);
        text = window.text;
        textRange = { offset: window.offset, length: window.length, total: window.total, truncated: window.truncated };
        if (window.truncated && window.nextOffset !== undefined) {
          textRange.nextOffset = window.nextOffset;
          state.current.truncated = { nextOffset: window.nextOffset, args: { ...sectionArgs, ...(input.maxChars ? { maxChars: input.maxChars } : {}) } };
        }
      }

      const pageFilter = session.surface === 'live-app' && session.pageUrl;
      const listed = sortByDocumentOrder(snapshot.blocks, snapshot.annotations)
        .filter((a) => !pageFilter || !a.pageUrl || a.pageUrl === session.pageUrl)
        .slice(0, MAX_ANNOTATIONS_IN_RESPONSE);
      const annotations = include.has('annotations')
        ? listed.map((a) => viewOf(a, snapshot.annotations, snapshot.blocks, outline, tracker, since, now()))
        : undefined;

      const agentComments = snapshot.annotations.filter(isAgentAnnotation).length;
      const others = otherDocumentActivity(adapter, state).slice(0, MAX_OTHER_DOCUMENTS).map((doc) => ({
        path: doc.path,
        open: doc.open,
        annotations: doc.annotations,
        newSinceLastRead: doc.newSinceLastRead,
        lastActivity: doc.lastActivity === null || doc.lastActivity === undefined ? null : new Date(doc.lastActivity).toISOString(),
        composerOpen: doc.composerOpen,
      }));

      if (!isOpen && target.path) state.siblingRead.set(target.path, tracker.seq);

      const data = {
        session: {
          mode: session.mode,
          surface: session.surface,
          source: session.source,
          gate: session.gate,
          readOnly: session.readOnly,
          decision: session.decision,
          commentOnly: session.commentOnly,
          sourceStale: session.sourceStale,
          editing: session.editing,
          versions: session.versions,
          ...(session.pageUrl ? { pageUrl: session.pageUrl } : {}),
          agentComments,
          humanComments: snapshot.annotations.length - agentComments,
          pendingUnsent: session.decision === 'pending' ? snapshot.annotations.length : 0,
        },
        document: { path: snapshot.path, textAvailable: snapshot.text !== null },
        ...(include.has('text') ? { text, textRange } : {}),
        ...(include.has('outline') ? { outline: outline.map(({ blockId: _blockId, ...entry }) => entry) } : {}),
        ...(annotations ? { annotations } : {}),
        otherDocuments: others,
      };
      return ok(data, state.main.cursor());
    },
  });

  const addComments = defineTool<{ comments: AddCommentItem[] }, unknown>({
    name: 'add_comments',
    title: 'Add comments',
    description:
      'Leave one or more comments in one call: on an exact quote from the text, on a section by its outline id, as a reply to an existing comment (inReplyTo inherits its anchor), or as a document-level note with no anchor (also how you say "looks ready to me"). Returns each created comment with its resolved anchor and context, so no read-back is needed. Do not use it to approve, request changes or submit: the human does that from the page. It cannot edit the human\'s comments.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['comments'],
      properties: {
        comments: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_COMMENTS_PER_CALL,
          description: 'Comments to create, in order. Each result carries the matching index.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: {
              text: { type: 'string', minLength: 1, maxLength: 20000, description: 'The comment. Markdown is rendered the same way as in the panel.' },
              quote: { type: 'string', minLength: 1, maxLength: 4000, description: 'Exact text to anchor on; resolved by text search, so copy it from the document verbatim.' },
              section: { type: 'string', maxLength: 512, description: 'Outline id. With quote: disambiguates. Alone: anchors on the heading.' },
              inReplyTo: { type: 'string', maxLength: 128, description: 'Comment id to reply to; the reply inherits that anchor and threads under it.' },
              path: PATH_PARAM,
              requestId: { type: 'string', maxLength: 128, description: 'Idempotency key: a repeat returns the existing comment with deduplicated: true.' },
            },
          },
        },
      },
    },
    execute: async (input) => {
      syncTrackers(adapter, state);
      const session = adapter.getSession();
      if (session.readOnly || session.decision !== 'pending') {
        return fail('not_available', 'this session no longer accepts comments');
      }
      const results: AddCommentResult[] = [];
      let created = 0;
      for (let index = 0; index < input.comments.length; index++) {
        const item = input.comments[index]!;
        const rid = item.requestId;
        if (rid && state.requests.has(rid)) {
          const seen = state.requests.get(rid)!;
          const targetForSeen = await resolveTarget(seen.path ?? undefined);
          if (!('ok' in targetForSeen)) {
            const existing = targetForSeen.snapshot.annotations.find((a) => a.id === seen.id);
            if (existing) {
              const outline = buildOutline(targetForSeen.snapshot.blocks, targetForSeen.snapshot.annotations);
              results.push({
                ok: true,
                index,
                annotation: viewOf(existing, targetForSeen.snapshot.annotations, targetForSeen.snapshot.blocks, outline, targetForSeen.tracker, Number.MAX_SAFE_INTEGER, now()),
                anchoredBy: seen.anchoredBy,
                deduplicated: true,
              });
              continue;
            }
          }
          // The comment this requestId created is gone: the human removed it
          // (the annotations_removed nudge already said so). Re-creating it
          // would undo the human, so a replay is a conflict, never a write.
          results.push({
            ok: false,
            index,
            error: { code: 'conflict', message: 'the comment this requestId created was removed since; not re-creating it', hint: 'Treat the removal as resolved, or add a new comment with a new requestId.' },
          });
          continue;
        }
        const target = await resolveTarget(item.path);
        if ('ok' in target) {
          results.push({ ok: false, index, error: { code: 'not_found', message: target.error.message } });
          continue;
        }
        const { snapshot, path, tracker } = target;
        const outline = buildOutline(snapshot.blocks, snapshot.annotations);
        const base: Annotation = {
          id: generateId('ann'),
          blockId: '',
          startOffset: 0,
          endOffset: 0,
          type: AnnotationType.GLOBAL_COMMENT,
          text: item.text,
          originalText: '',
          createdA: now(),
          // Author and source both name the agent, exactly like an
          // external-annotation comment names its tool: the panel then shows
          // "browser-agent" instead of the human's name with "(me)".
          author: BROWSER_AGENT_SOURCE,
          source: BROWSER_AGENT_SOURCE,
        };
        let annotation: Annotation;
        let anchoredBy: AnchoredBy;
        let verified = true;
        if (item.inReplyTo) {
          const parent = snapshot.annotations.find((a) => a.id === item.inReplyTo);
          if (!parent) {
            results.push({ ok: false, index, error: { code: 'not_found', message: 'inReplyTo does not name a comment in this document' } });
            continue;
          }
          annotation = {
            ...base,
            type: parent.type === AnnotationType.DELETION ? AnnotationType.COMMENT : parent.type,
            blockId: parent.blockId,
            startOffset: parent.startOffset,
            endOffset: parent.endOffset,
            originalText: parent.originalText,
            inReplyTo: parent.id,
            ...(parent.startMeta ? { startMeta: parent.startMeta } : {}),
            ...(parent.endMeta ? { endMeta: parent.endMeta } : {}),
            ...(parent.htmlAnchor ? { htmlAnchor: parent.htmlAnchor } : {}),
            ...(parent.pageUrl ? { pageUrl: parent.pageUrl } : {}),
            ...(parent.diffContext ? { diffContext: parent.diffContext } : {}),
          };
          anchoredBy = 'reply';
        } else if (item.quote) {
          const section = item.section ? findSection(outline, item.section) : null;
          if (item.section && !section) {
            results.push({ ok: false, index, error: { code: 'not_found', message: 'no section with that id' } });
            continue;
          }
          if (snapshot.blocks.length === 0 && snapshot.text === null) {
            // Live app: the parent cannot see the page text; the bridge
            // resolves the quote lazily and keeps the record until it does.
            annotation = { ...base, type: AnnotationType.COMMENT, originalText: item.quote.trim() };
            verified = false;
          } else if (session.surface === 'html' && snapshot.html) {
            const plain = htmlToPlainText(snapshot.html);
            const needle = item.quote.trim().replace(/\s+/g, ' ');
            if (!plain.includes(needle)) {
              results.push({ ok: false, index, error: { code: 'not_found', message: 'quote not found in the page text' } });
              continue;
            }
            annotation = { ...base, type: AnnotationType.COMMENT, originalText: item.quote.trim() };
          } else {
            const resolution = resolveQuote(snapshot.blocks, item.quote, section);
            if (resolution.status === 'not_found') {
              results.push({ ok: false, index, error: { code: 'not_found', message: 'quote not found in the document text' } });
              continue;
            }
            if (resolution.status === 'ambiguous') {
              results.push({
                ok: false,
                index,
                error: { code: 'ambiguous', message: 'quote matches more than one place; add section to disambiguate', candidates: resolution.candidates.map((c) => c.context) },
              });
              continue;
            }
            const match = resolution.match;
            annotation = { ...base, type: AnnotationType.COMMENT, blockId: match.blockId, startOffset: match.startOffset, endOffset: match.endOffset, originalText: match.originalText };
          }
          anchoredBy = 'quote';
        } else if (item.section) {
          const section = findSection(outline, item.section);
          if (!section) {
            results.push({ ok: false, index, error: { code: 'not_found', message: 'no section with that id' } });
            continue;
          }
          annotation = { ...base, type: AnnotationType.COMMENT, blockId: section.blockId, startOffset: 0, endOffset: section.title.length, originalText: section.title };
          anchoredBy = 'section';
        } else {
          annotation = base;
          anchoredBy = 'document';
        }
        if (!adapter.addAnnotation(annotation, path)) {
          results.push({ ok: false, index, error: { code: 'not_available', message: 'that document is not open, so it cannot be written to', hint: OPEN_FIRST_HINT } });
          continue;
        }
        tracker.claimOwn(annotation);
        // Observe the write now (the adapter overlays it on the committed
        // list) so the returned view carries the new seq and the response's
        // nudges reflect the mutation.
        syncTrackers(adapter, state);
        if (rid) state.requests.set(rid, { id: annotation.id, path, anchoredBy });
        created += 1;
        const all = [...snapshot.annotations, annotation];
        const result: AddCommentResult = {
          ok: true,
          index,
          annotation: viewOf(annotation, all, snapshot.blocks, outline, tracker, Number.MAX_SAFE_INTEGER, now()),
          anchoredBy,
        };
        if (!verified) result.verified = false;
        results.push(result);
      }
      return ok({ results, created });
    },
  });

  const updateComment = defineTool<{ id: string; text: string; path?: string }, unknown>({
    name: 'update_comment',
    title: 'Reword one of your comments',
    description:
      'Replace the text of a comment you created earlier (source browser-agent). Use it to correct or refine your own note after new information. It refuses the human\'s comments and comments from other tools with forbidden; to respond to a human comment, add a reply with add_comments instead.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'text'],
      properties: {
        id: { type: 'string', maxLength: 128, description: 'The comment id.' },
        text: { type: 'string', minLength: 1, maxLength: 20000, description: 'The new comment text.' },
        path: PATH_PARAM,
      },
    },
    execute: async (input) => {
      syncTrackers(adapter, state);
      const target = await resolveTarget(input.path);
      if ('ok' in target) return target;
      const { snapshot, path, tracker } = target;
      const existing = snapshot.annotations.find((a) => a.id === input.id);
      if (!existing) return fail('not_found', 'no comment with that id');
      // Ownership is the tracker's claim from this session, not the `source`
      // stamp: the external-annotations API accepts any source, so a stamp
      // alone would let another tool's findings become agent-editable.
      if (!tracker.isOwn(existing.id)) return fail('forbidden', 'only comments you created can be changed', { hint: NOT_OWNED_HINT });
      if (!adapter.updateAnnotation(input.id, { text: input.text }, path)) {
        return fail('not_available', 'that document is not open, so it cannot be written to', { hint: OPEN_FIRST_HINT });
      }
      const updated = { ...existing, text: input.text };
      tracker.claimOwn(updated);
      syncTrackers(adapter, state);
      const outline = buildOutline(snapshot.blocks, snapshot.annotations);
      return ok({ annotation: viewOf(updated, snapshot.annotations, snapshot.blocks, outline, tracker, Number.MAX_SAFE_INTEGER, now()) });
    },
  });

  const removeComments = defineTool<{ ids: string[]; path?: string }, unknown>({
    name: 'remove_comments',
    title: 'Withdraw your comments',
    description:
      'Remove comments you created earlier (source browser-agent), in batch, when they no longer apply. Each id resolves independently and the response says which succeeded. It refuses the human\'s comments with forbidden. Do not remove a comment just because the human disagreed: that conversation belongs in a reply.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ids'],
      properties: {
        ids: { type: 'array', minItems: 1, maxItems: MAX_REMOVALS_PER_CALL, items: { type: 'string', maxLength: 128 }, description: 'Comment ids to remove.' },
        path: PATH_PARAM,
      },
    },
    // destructiveHint is not in today's WebMCP ToolAnnotations dictionary
    // (issue #176); unknown members are ignored, so it costs nothing and is
    // honest the day the hint lands. Do not "fix" it away.
    annotations: { destructiveHint: true },
    execute: async (input) => {
      syncTrackers(adapter, state);
      const target = await resolveTarget(input.path);
      if ('ok' in target) return target;
      const { snapshot, path, tracker } = target;
      const results = input.ids.map((id) => {
        const existing = snapshot.annotations.find((a) => a.id === id);
        if (!existing) return { id, ok: false as const, error: { code: 'not_found' as const, message: 'no comment with that id' } };
        if (!tracker.isOwn(existing.id)) return { id, ok: false as const, error: { code: 'forbidden' as const, message: 'only comments you created can be removed', hint: NOT_OWNED_HINT } };
        if (!adapter.removeAnnotation(id, path)) {
          return { id, ok: false as const, error: { code: 'not_available' as const, message: 'that document is not open, so it cannot be written to', hint: OPEN_FIRST_HINT } };
        }
        // The agent's own removal must not come back to it as "the human
        // removed your comment" (the resolution signal).
        tracker.claimRemoved(id);
        return { id, ok: true as const };
      });
      syncTrackers(adapter, state);
      return ok({ results, removed: results.filter((r) => r.ok).length });
    },
  });

  const reveal = defineTool<{ annotationId?: string; section?: string; path?: string }, unknown>({
    name: 'reveal',
    title: 'Bring the human to a comment or section',
    description:
      'Scroll the human\'s view to a comment (selecting it) or to a section heading. Use it right after leaving a comment you want them to see, or when answering "where is that". A path other than the open document navigates the human there and the response says so. It returns no content; use read_document to read.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        annotationId: { type: 'string', maxLength: 128, description: 'Comment id to select and scroll to.' },
        section: { type: 'string', maxLength: 512, description: 'Outline id to scroll to (used when annotationId is absent).' },
        path: PATH_PARAM,
      },
    },
    execute: async (input) => {
      if (!input.annotationId && !input.section) return fail('invalid_input', 'pass annotationId or section');
      syncTrackers(adapter, state);
      const open = adapter.getDocument();
      const navigated = !!input.path && input.path !== open.path;
      if (input.annotationId) {
        const revealed = await adapter.revealAnnotation(input.annotationId, navigated ? input.path! : null);
        if (!revealed) return fail('not_found', 'no comment with that id');
        return ok({ revealed: 'annotation', navigated, ...(navigated ? { path: input.path } : {}) });
      }
      const target = await resolveTarget(input.path);
      if ('ok' in target) return target;
      const outline = buildOutline(target.snapshot.blocks, target.snapshot.annotations);
      const section = findSection(outline, input.section!);
      if (!section) return fail('not_found', 'no section with that id');
      const revealed = await adapter.revealSection(section.blockId, navigated ? input.path! : null);
      if (!revealed) return fail('not_found', 'the section is not on screen');
      return ok({ revealed: 'section', navigated, ...(navigated ? { path: input.path } : {}) });
    },
  });

  const nudgeUser = defineTool<{ message: string }, unknown>({
    name: 'nudge_user',
    title: 'Show the human a short message',
    description:
      'Show one short, transient message in the page ("Finished: two comments, nothing blocking, ready for your approval"). One banner at a time; a new call replaces it, and the human can dismiss it. It is not saved and not part of the feedback. Do not use it for anything that should survive the session or reach the coding agent: leave a document-level note with add_comments for that.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: {
        message: { type: 'string', minLength: 1, maxLength: NUDGE_USER_MAX_CHARS, description: 'Plain text, at most 280 characters.' },
      },
    },
    execute: (input) => {
      adapter.showBanner(input.message.trim());
      return ok({ shown: true });
    },
  });

  const listDocuments = defineTool<{ filter?: string }, unknown>({
    name: 'list_documents',
    title: 'List the documents in this folder session',
    description:
      'Browse the folder session\'s document tree when the nudges and otherDocuments in a previous response do not already name the document you need: every path with its comment count and what changed since you last read it. Use the returned path with read_document. Do not use it to read contents.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filter: { type: 'string', maxLength: 256, description: 'Case-insensitive substring of the path or title.' },
      },
    },
    annotations: { readOnlyHint: true },
    execute: (input) => {
      syncTrackers(adapter, state);
      const open = adapter.getDocument();
      const siblings = new Map(adapter.getSiblingDocuments().map((s) => [s.path, s] as const));
      const known = new Map<string, { path: string; title?: string }>();
      for (const entry of adapter.listDocuments?.() ?? []) known.set(entry.path, entry);
      for (const [path, sibling] of siblings) if (!known.has(path)) known.set(path, { path, title: sibling.title });
      if (open.path && !known.has(open.path)) known.set(open.path, { path: open.path });
      const filter = input.filter?.trim().toLowerCase();
      const documents = [...known.values()]
        .filter((doc) => !filter || doc.path.toLowerCase().includes(filter) || (doc.title ?? '').toLowerCase().includes(filter))
        .map((doc) => {
          const isOpen = doc.path === open.path;
          const sibling = siblings.get(doc.path);
          const tracker = isOpen ? state.main : state.siblings.forPath(doc.path);
          const since = isOpen ? state.main.watermark : (state.siblingRead.get(doc.path) ?? 0);
          const count = isOpen ? open.annotations.length : (sibling?.annotations.length ?? 0);
          return {
            path: doc.path,
            ...(doc.title ? { title: doc.title } : {}),
            open: isOpen || !!sibling?.open,
            annotations: count,
            newSinceLastRead: tracker.newSince(since).length,
            lastActivity: tracker.lastActivity === null ? null : new Date(tracker.lastActivity).toISOString(),
          };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
      return ok({ documents });
    },
  });

  const tools: ToolSpec<never, unknown>[] = [readDocument as ToolSpec<never, unknown>];
  if (options.writable) {
    tools.push(
      addComments as ToolSpec<never, unknown>,
      updateComment as ToolSpec<never, unknown>,
      removeComments as ToolSpec<never, unknown>,
    );
  }
  tools.push(reveal as ToolSpec<never, unknown>, nudgeUser as ToolSpec<never, unknown>);
  if (options.folder) tools.push(listDocuments as ToolSpec<never, unknown>);
  return tools;
}

export type { Nudge };
