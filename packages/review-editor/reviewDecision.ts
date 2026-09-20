import { generateId } from '@plannotator/ui/utils/generateId';
import type { DecisionActionId, DecisionMenuItem, DecisionPrimary } from '@plannotator/ui/utils/decisionSpec';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { CompactReviewAction } from './components/ReviewHeaderMenu';

/**
 * Pure transport routing for the review (agent-mode) decision control.
 *
 * `buildDecisionSpec` decides WHAT the header offers; this module decides
 * WHERE each choice goes. Review is single-transport (spec §3.2/§6.1): every
 * decision POSTs `/api/feedback`, with `approved` as the only fork —
 * change-request notes commit a `scope:'general'` CodeAnnotation and ride the
 * send, approvals post `buildReviewApprovalBody` (bare, with a note, or with
 * the live annotations — PR5 delivery), and the post-confirm discard is the
 * same bare approve the Approve primary posts. Kept pure (no React, no
 * App import) so the §8C handler-exhaustiveness test runs in the plain
 * `bun test` lane: every id the spec can emit must resolve here, and an id
 * added to `decisionSpec.ts` without a route fails the exhaustive switch.
 */
/**
 * Reads the `approvalNotesSupported` capability advert off a diff payload
 * (`/api/diff` and the switch/PR family — the server echoes it on all four).
 * Anything but a literal `true` reads as false: an OLD server that never
 * sends the field advertises "not capable" and the client renders no
 * approve-carrying items — exactly the PR3 behavior. A NEW server against an
 * old client changes nothing either (the field is simply ignored). Pinned by
 * `reviewDecision.test.ts`.
 */
export function readApprovalNotesAdvert(value: unknown): boolean {
  return value === true;
}

export type ReviewDecisionRoute =
  /** The adaptive primary: Approve at zero, Send Feedback otherwise. */
  | { kind: 'primary' }
  /** Commit the note as a scope:'general' CodeAnnotation, then submit on the
   *  next render (the payload builders close over `allAnnotations`). */
  | { kind: 'note' }
  /** Post-confirm discard: the bare approve (annotations dropped). */
  | { kind: 'discard' }
  /** Approve with content riding along (PR5 delivery, spec §6.4). The spec
   *  emits these ids only when the server advertises `approvalNotesSupported`
   *  — i.e. when this session's decision consumer prints/sends approve-time
   *  feedback instead of discarding it. `withAnnotations` distinguishes
   *  "Approve with notes" (the live annotations + their export ride the
   *  approval) from "Approve with a note…" (the composer note alone). */
  | { kind: 'approve-with-notes'; withAnnotations: boolean };

export function resolveReviewDecisionAction(id: DecisionActionId): ReviewDecisionRoute {
  switch (id) {
    case 'primary':
      return { kind: 'primary' };
    case 'request-changes':
    case 'note-with-feedback':
      // The two differ only by state (empty vs feedback), never by transport.
      return { kind: 'note' };
    case 'note-with-approval':
      return { kind: 'approve-with-notes', withAnnotations: false };
    case 'approve-with-notes':
      return { kind: 'approve-with-notes', withAnnotations: true };
    case 'discard-and-finish':
      return { kind: 'discard' };
  }
}

/**
 * PR6 (§3.4): platform-mode routing. Platform decisions never touch
 * `/api/feedback` — every id opens the EXISTING ReviewSubmissionDialog
 * (per-target state, retry, the "open PR" toggle, and the only
 * general-comment field on this side) in one of its two modes:
 *
 *   primary            → comment with annotations, approve when empty
 *   approve-with-notes → "Approve with comments…"  (approve mode)
 *   note-with-approval → "Approve with a comment…" (approve mode)
 *   note-with-feedback → "Post comments, then…"    (comment mode)
 *   request-changes    → "Request changes…"        (comment mode)
 *
 * Returns null for `discard-and-finish`, which the platform spec arm never
 * emits — the dialog owns what happens to unsent annotations.
 */
export function resolvePlatformDecisionAction(
  id: DecisionActionId,
  hasAnnotations: boolean,
): 'approve' | 'comment' | null {
  switch (id) {
    case 'primary':
      return hasAnnotations ? 'comment' : 'approve';
    case 'note-with-approval':
    case 'approve-with-notes':
      return 'approve';
    case 'request-changes':
    case 'note-with-feedback':
      return 'comment';
    case 'discard-and-finish':
      return null;
  }
}

export interface ReviewApprovalBodyInput {
  draftGeneration: number;
  /** Composer note ("Approve with a note…"); whitespace-only means none. */
  note?: string;
  /** "Approve with notes": the live annotations ride the approval. */
  withAnnotations: boolean;
  /** The same export Send Feedback posts — what the agent reads as guidance. */
  feedbackMarkdown: string;
  annotations: CodeAnnotation[];
}

/**
 * The `/api/feedback` body for every approval (PR5 delivery, spec §6.4).
 *
 * The pre-PR5 client sent the placeholder `'LGTM - no changes requested.'` on
 * every approval; with consumers now printing approve-time feedback, that
 * placeholder would be appended to every bare approval, so it is gone:
 * a bare approval sends `feedback: ''`, which is also what finally makes the
 * archive's `lgtm` decision reachable and stops bare approvals writing a
 * sidecar (spec §6.2 fact 1). "Approve with a note…" sends the note as the
 * feedback; "Approve with notes" sends the live annotation export as the
 * feedback with the annotations riding for archive provenance.
 */
export function buildReviewApprovalBody(input: ReviewApprovalBodyInput): {
  draftGeneration: number;
  approved: true;
  feedback: string;
  annotations: unknown[];
} {
  const note = input.note?.trim() ?? '';
  if (input.withAnnotations) {
    return {
      draftGeneration: input.draftGeneration,
      approved: true,
      // A note must never be silently discarded because annotations also
      // ride: a future combined item (note + annotations) folds the note in
      // ahead of the export. Today's "Approve with notes" item has no
      // composer, so note is normally empty here.
      feedback: note ? `${note}\n\n${input.feedbackMarkdown}` : input.feedbackMarkdown,
      annotations: input.annotations,
    };
  }
  return {
    draftGeneration: input.draftGeneration,
    approved: true,
    feedback: note,
    annotations: [],
  };
}

/**
 * Compact/touch row ids for the spec-driven decision rows. Ids double as
 * React keys, so they must be unique within any one spec: the composers are
 * `note`, the change-request composer is `feedback` (it IS the change-request
 * send), approve-with-notes is `approve`, the confirm item `discard-finish`.
 */
export function compactRowIdForReviewDecisionItem(
  id: DecisionMenuItem['id'],
): Extract<CompactReviewAction['id'], 'note' | 'feedback' | 'approve' | 'discard-finish'> {
  switch (id) {
    case 'note-with-approval':
    case 'note-with-feedback':
      return 'note';
    case 'request-changes':
      return 'feedback';
    case 'approve-with-notes':
      return 'approve';
    case 'discard-and-finish':
      return 'discard-finish';
  }
}

/** The compact primary row id for the spec's primary (data, not copy: the
 *  send icon marks the Send Feedback state; check marks Approve). */
export function compactPrimaryIdForReviewDecision(
  primary: Pick<DecisionPrimary, 'icon'>,
): Extract<CompactReviewAction['id'], 'feedback' | 'approve'> {
  return primary.icon === 'send' ? 'feedback' : 'approve';
}

/**
 * The one shape for a human review-level comment: `scope: 'general'` with the
 * ''/0/0 sentinels that keep it out of every file group. Shared by BOTH human
 * producers — the header composer's submit note (`commitReviewNote`) and the
 * sidebar's durable "+ General comment" — so the transport shape the
 * review-note payload tests pin cannot fork between them.
 *
 * Deliberately carries no PR context (`prUrl`/`diffScope`): an unstamped
 * annotation passes every PR scope (`utils/annotationScope.ts`), which is
 * what lets a review-level comment survive an in-place PR switch (spec §3.3).
 * `generateId()` (crypto.randomUUID with an insecure-context fallback; remote-mode
 * http sessions have no crypto.randomUUID) rather than `Date.now()` because two commits in the
 * same millisecond would collide and the deferred-submit effect keys on the
 * id (spec §9).
 *
 * Returns null for a whitespace-only note: the composers never commit an
 * empty comment.
 */
export function createGeneralReviewComment(text: string, author?: string): CodeAnnotation | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return {
    id: generateId('review-note'),
    type: 'comment',
    scope: 'general',
    filePath: '',
    lineStart: 0,
    lineEnd: 0,
    side: 'new',
    text: trimmed,
    createdAt: Date.now(),
    ...(author ? { author } : {}),
  };
}
