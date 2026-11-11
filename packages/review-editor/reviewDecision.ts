import { generateId } from '@plannotator/ui/utils/generateId';
import type { DecisionActionId, DecisionMenuItem, DecisionPrimary } from '@plannotator/ui/utils/decisionSpec';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { PRReviewAction } from '@plannotator/shared/pr-types';
import type { CompactReviewAction } from './components/ReviewHeaderMenu';

export function readApprovalNotesAdvert(value: unknown): boolean {
  return value === true;
}

export type ReviewDecisionRoute =
  | { kind: 'primary' }
  | { kind: 'note' }
  | { kind: 'discard' }
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

export interface PlatformDialogMode {
  action: PRReviewAction;
  chooseEvent: boolean;
}

export function resolvePlatformDecisionAction(
  id: DecisionActionId,
  hasAnnotations: boolean,
  requestChangesSupported: boolean,
): PlatformDialogMode | null {
  switch (id) {
    case 'primary':
      return { action: hasAnnotations ? 'comment' : 'approve', chooseEvent: false };
    case 'note-with-approval':
    case 'approve-with-notes':
      return { action: 'approve', chooseEvent: false };
    case 'request-changes':
      return { action: requestChangesSupported ? 'request_changes' : 'comment', chooseEvent: true };
    case 'note-with-feedback':
      return { action: 'comment', chooseEvent: true };
    case 'discard-and-finish':
      return null;
  }
}

export interface ReviewApprovalBodyInput {
  draftGeneration: number;
  note?: string;
  withAnnotations: boolean;
  feedbackMarkdown: string;
  annotations: CodeAnnotation[];
}

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

export function compactRowIdForPlatformDecisionItem(
  id: DecisionMenuItem['id'],
): Extract<CompactReviewAction['id'], 'note' | 'comment' | 'feedback' | 'approve' | 'discard-finish'> {
  return id === 'note-with-feedback' ? 'comment' : compactRowIdForReviewDecisionItem(id);
}

export function compactPrimaryIdForReviewDecision(
  primary: Pick<DecisionPrimary, 'icon'>,
): Extract<CompactReviewAction['id'], 'feedback' | 'approve'> {
  return primary.icon === 'send' ? 'feedback' : 'approve';
}

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
