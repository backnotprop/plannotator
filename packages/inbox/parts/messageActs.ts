import type { KeyboardEvent } from 'react';
import type { Annotation } from '@plannotator/ui/types';
import type { InboxNoteBlock } from '@plannotator/core/inbox-context-notes';
import type { InboxAttachmentState, InboxInlineImage, InboxMessageWire } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import type { JumpTarget } from '../components/ReplacedQuestion';
import type { ActionMark } from '../components/ActionChecklist';
import type { PageStart } from '../components/htmlPageFrame';
import type { FileRef } from '../fileRefs';

export interface MessageActs {
  openFromReply: (attachment: InboxAttachmentState, version: 'current' | 'sent') => void;
  jumpTo: (target: JumpTarget) => void;
  noteChips: (messageId: string) => { onOpen?: (note: InboxNoteBlock) => void };
  /** `opening`: called as the file opens. */
  openFromMessage: (attachment: Pick<InboxAttachmentState, 'id' | 'kind' | 'ref'> & { name?: string }, view?: null, opening?: () => void) => void;
  /** The HTML page about to open starts at this query and fragment (a message's link to `mock.html?variant=2`). */
  setPageStart: (start: PageStart) => void;
  openOptionSet: (messageId: string, key: string, image: InboxInlineImage, choice: number) => void;
  pick: (messageId: string, key: string, answer: QuestionAnswer | null) => void;
  markAction: (messageId: string, key: string, mark: ActionMark | null) => Promise<boolean>;
  saveMessageComment: (messageId: string, annotation: Annotation) => Promise<boolean>;
  noteUnanchored: (report: { attempted: readonly string[]; unanchored: readonly string[] }) => void;
  repaintHits: (messageId: string) => void;
  openListAt: (id: string | null) => void;
  onSide?: (selected: string, source?: string) => void;
  toggleMessage: (id: string) => void;
  replyToMessage: (message: InboxMessageWire) => void;
  quoteAtPress: (messageId: string) => void;
  setHeaderOpen: (id: string, open: boolean) => void;
  closeHeaderOnEscape: (id: string) => (event: KeyboardEvent) => void;
  tryPrototype: (messageId: string, key: string) => void;
  takeBackOf: (message: InboxMessageWire) => (() => void) | null;
  /** A file an agent's message names opens beside the thread, read only (approval "inbox-file-refs-open-viewer"). */
  openFileRef: (messageId: string, ref: FileRef) => void;
}

export type MessageActsRef = { readonly current: MessageActs };
