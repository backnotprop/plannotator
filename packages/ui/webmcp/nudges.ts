/**
 * Nudge computation: every response carries `nudges` computed synchronously
 * from state the page already holds. No nudge needs a second call to
 * discover, and every nudge names the ids/paths needed to act on it.
 *
 * Messages are static strings we own. Document text, heading titles and
 * comment text are never concatenated into a message (prompt-injection
 * hygiene); they travel as data in `ids`, `path` and `section`.
 *
 * Pure, no DOM.
 */

import type { AnnotationChangeTracker } from './changes';
import type { Nudge } from './toolset';

export type DocumentSurface = 'markdown' | 'html' | 'live-app';

export interface OtherDocumentActivity {
  path: string;
  open: boolean;
  annotations: number;
  newSinceLastRead: number;
  composerOpen: boolean;
  /** The human opened this document since the last response. */
  openedSinceLastRead: boolean;
  /** Wall-clock ms of the last change, for ordering; null when never changed. */
  lastActivity?: number | null;
}

export interface NudgeSnapshot {
  surface: DocumentSurface;
  composer: { open: boolean; section?: string };
  sourceStale: boolean;
  documentEdited: boolean;
  /** Live app: the page the human is on now, and the one at the last response. */
  pageUrl: string | null;
  lastPageUrl: string | null;
  annotationCount: number;
  /** The human approved / sent feedback / closed. */
  decided: boolean;
  /** First response of the session (surface hints fire once). */
  firstResponse: boolean;
  /** Set by the response builder when text was windowed: the continuation call's arguments. */
  truncated?: { nextOffset: number; args: Record<string, unknown> };
  /** `inReplyTo` per live annotation id, for `replies_new`. */
  annotations: ReadonlyArray<{ id: string; inReplyTo?: string; source?: string }>;
  otherDocuments: OtherDocumentActivity[];
  /** Watermark the novelty checks run against. */
  since: number;
}

export const MAX_OTHER_DOCUMENT_NUDGES = 10;
/** Ids listed on one nudge; a burst past this names the first ones and says how many more. */
export const MAX_NUDGE_IDS = 100;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The first MAX_NUDGE_IDS ids plus a suffix for the message when some are left out. */
function capIds(ids: string[]): { ids: string[]; suffix: string } {
  if (ids.length <= MAX_NUDGE_IDS) return { ids, suffix: '' };
  const more = ids.length - MAX_NUDGE_IDS;
  return {
    ids: ids.slice(0, MAX_NUDGE_IDS),
    suffix: ` The first ${MAX_NUDGE_IDS} ids are listed; ${more} more ${more === 1 ? 'is' : 'are'} not (read the document for the rest).`,
  };
}

export function buildNudges(
  snapshot: NudgeSnapshot,
  tracker: AnnotationChangeTracker,
  toolName: (bare: string) => string,
): Nudge[] {
  const nudges: Nudge[] = [];
  const since = snapshot.since;
  const agentIds = new Set(snapshot.annotations.filter((a) => a.source === 'browser-agent').map((a) => a.id));

  const fresh = tracker.newSince(since);
  const replies = fresh.filter((id) => {
    const parent = snapshot.annotations.find((a) => a.id === id)?.inReplyTo;
    return parent !== undefined && agentIds.has(parent);
  });
  const plain = fresh.filter((id) => !replies.includes(id));
  if (plain.length > 0) {
    const capped = capIds(plain);
    nudges.push({
      code: 'annotations_new',
      message: `The human added or edited ${plural(plain.length, 'comment')} since your last read.${capped.suffix}`,
      ids: capped.ids,
    });
  }
  if (replies.length > 0) {
    const capped = capIds(replies);
    nudges.push({
      code: 'replies_new',
      message: `The human replied to your comments (${replies.length} new ${replies.length === 1 ? 'reply' : 'replies'}).${capped.suffix}`,
      ids: capped.ids,
    });
  }

  const removed = tracker.removedSince(since);
  if (removed.length > 0) {
    const own = removed.filter((t) => t.agent);
    const capped = capIds(removed.map((t) => t.id));
    nudges.push({
      code: 'annotations_removed',
      message: (own.length > 0
        ? `The human removed ${own.length} of your comments; treat that as resolved and do not re-add them.`
        : `${plural(removed.length, 'comment')} you had seen ${removed.length === 1 ? 'was' : 'were'} removed.`) + capped.suffix,
      ids: capped.ids,
    });
  }

  if (snapshot.composer.open) {
    nudges.push({
      code: 'composer_open',
      message: 'The human is typing a comment right now; wait before commenting on the same passage.',
      ...(snapshot.composer.section ? { section: snapshot.composer.section } : {}),
    });
  }

  if (snapshot.sourceStale) {
    nudges.push({
      code: 'source_stale',
      message: 'The annotated file changed on disk since it was loaded; the text you read may be behind the file.',
    });
  }

  if (snapshot.documentEdited) {
    nudges.push({
      code: 'document_edited',
      message: 'The human is editing the document text; the text reflects their buffer and quote anchors may drift.',
    });
  }

  if (snapshot.firstResponse && snapshot.surface !== 'markdown') {
    nudges.push({
      code: 'comment_only_surface',
      message: 'This surface is comment-only: comments anchor on an exact text quote or on the whole document, and nothing can be marked for deletion.',
    });
  }

  if (snapshot.surface === 'live-app' && snapshot.lastPageUrl !== null && snapshot.pageUrl !== null && snapshot.pageUrl !== snapshot.lastPageUrl) {
    nudges.push({
      code: 'page_changed',
      message: 'The human navigated to another page of the app since your last read; annotations are listed for the current page.',
      path: snapshot.pageUrl,
    });
  }

  const activeDocs = snapshot.otherDocuments
    .filter((doc) => doc.newSinceLastRead > 0 || doc.composerOpen || doc.openedSinceLastRead)
    .slice(0, MAX_OTHER_DOCUMENT_NUDGES);
  for (const doc of activeDocs) {
    nudges.push({
      code: 'other_document_active',
      message: doc.newSinceLastRead > 0
        ? `The human is also annotating another document (${plural(doc.newSinceLastRead, 'new comment')}); read it by path.`
        : doc.composerOpen
          ? 'The human is typing a comment in another document; read it by path.'
          : 'The human opened another document since your last read; read it by path.',
      path: doc.path,
      action: { tool: toolName('read_document'), args: { path: doc.path } },
    });
  }

  if (snapshot.truncated) {
    nudges.push({
      code: 'truncated',
      message: 'The text was windowed at a block boundary; continue from nextOffset to read the rest.',
      action: { tool: toolName('read_document'), args: { ...snapshot.truncated.args, offset: snapshot.truncated.nextOffset } },
    });
  }

  if (snapshot.decided) {
    nudges.push({
      code: 'session_decided',
      message: 'The human has already decided this session; comment tools are no longer registered and nothing more can be added.',
    });
  } else if (snapshot.annotationCount > 0) {
    nudges.push({
      code: 'pending_unsent',
      message: `${plural(snapshot.annotationCount, 'annotation')} ${snapshot.annotationCount === 1 ? 'is' : 'are'} pending; the human sends feedback and approves from the page, you do not.`,
    });
  }

  return nudges;
}
