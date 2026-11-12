export function typedCommentDraft(doc: Document = document): HTMLTextAreaElement | null {
  for (const area of doc.querySelectorAll<HTMLTextAreaElement>('[data-comment-popover] textarea')) {
    if (area.value.trim() !== '') return area;
  }
  return null;
}

export const LINK_WAITS_FOR_DRAFT_TITLE = 'Your comment is not saved yet';

export function linkWaitsForDraftDescription(target: string): string {
  return `Save or discard it, then follow the link to ${target}.`;
}
