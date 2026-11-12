import { readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';

export type FileView = 'full' | 'side';

export const FILE_VIEW_COOKIE = 'plannotator-inbox-file-view';

export function parseFileView(value: string | null | undefined): FileView | null {
  return value === 'full' || value === 'side' ? value : null;
}

export function readFileViewChoice(): FileView | null {
  return parseFileView(storage.getItem(FILE_VIEW_COOKIE));
}

export function writeFileViewChoice(view: FileView | null): void {
  if (view === null) storage.removeItem(FILE_VIEW_COOKIE);
  else storage.setItem(FILE_VIEW_COOKIE, view);
}

export function kindDefaultView(attachment: Pick<InboxAttachmentState, 'kind' | 'ref'>): FileView {
  return readInboxAttachmentKind(attachment.kind) === 'html' || attachment.ref !== undefined ? 'full' : 'side';
}

export interface FileViewInputs {
  address: FileView | null;
  choice: FileView | null;
  narrow: boolean;
}

export function fileViewFor(attachment: Pick<InboxAttachmentState, 'kind' | 'ref'>, inputs: FileViewInputs): FileView {
  if (inputs.narrow) return 'full';
  return inputs.address ?? inputs.choice ?? kindDefaultView(attachment);
}

export function openingView(attachment: Pick<InboxAttachmentState, 'kind' | 'ref'>): FileView {
  return readFileViewChoice() ?? kindDefaultView(attachment);
}

export function hashWithoutView(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  params.delete('view');
  const rest = params.toString();
  return rest ? `#${rest}` : '';
}

export function sameScreenAnyView(a: string, b: string): boolean {
  return hashWithoutView(a) === hashWithoutView(b);
}
