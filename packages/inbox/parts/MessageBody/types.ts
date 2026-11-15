/** What one message's body draws from: its message, its answers and cards, its comments, and the host's handlers. */
import type { Annotation } from '@plannotator/ui/types';
import type { InboxNoteBlock } from '@plannotator/core/inbox-context-notes';
import type { InboxMessageWire, InboxProjectRepo, InboxQuestion } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import type { InboxAttachment, InboxAttachmentState, InboxInlineImage } from '@plannotator/core/inbox-types';
import type { JumpTarget } from '../../components/ReplacedQuestion';
import type { ActionRow } from '../../components/ReplyAnswers';
import type { SentAnswerGroup } from '../../sentReply';

export interface MessageBodyProps {
  /** A question with a prototype (an option's, or one for all) was asked to open it (its key). Absent: no "Try prototype" tab. */
  onTryPrototype?: (key: string) => void;
  /**
   * Context notes (Code review on; approval "inbox-context-notes"): an agent's `:::note path#L…` block shows as a
   * chip naming its file and lines, with its words; `onOpen` opens the review at them. Absent: the text as it is.
   */
  contextNotes?: { onOpen?: (note: InboxNoteBlock) => void };
  /**
   * The action items this person's message carried (approval
   * "inbox-action-items-in-reply"): listed as "You did 1 action item", and the
   * agent-facing action sentence and "Action items you asked for" section are
   * left out of the text. Display only.
   */
  sentActions?: readonly ActionRow[];
  message: InboxMessageWire;
  /** The thread's project root: relative links start there or at the message's own folder. */
  projectRoot: string;
  /** Code review is on: a link to a file of the project that is not attached offers Open in. */
  openInFiles?: boolean;
  /** The project's git `origin` (the thread payload's `project.repo`): bare `#123` refs link into it. */
  repo?: InboxProjectRepo | null;
  /** A link in the body to one of this message's attachments was followed. */
  onOpenAttachment: (attachment: InboxAttachment) => void;
  /** An image the body shows was clicked (or pressed): its captured file (`inline_images`) opens in the viewer. */
  onOpenInlineImage?: (image: InboxInlineImage) => void;
  /**
   * A picture choice's zoom (approval "inbox-image-swipe", "Option sets"): its captured file opens in the
   * viewer over that question's picture choices only (the question's key), on the choice zoomed (`choice`, its
   * place among the question's choices: a picture two choices share opens as the one zoomed). Absent: it opens
   * like any image of the body.
   */
  onOpenOptionSet?: (key: string, image: InboxInlineImage, choice: number) => void;
  readOnly: boolean;
  answers: ReadonlyMap<string, QuestionAnswer>;
  onPick: (key: string, answer: QuestionAnswer | null) => void;
  footerFor: (key: string) => string | null;
  /** A superseded question's card in place of its answer card (the question's key and number), or undefined to keep it. */
  renderReplacedCard?: (key: string, number: number) => React.ReactNode | undefined;
  /** The "Replaces …" line under a question's prompt, or null. */
  renderReplacesLine?: (key: string) => React.ReactNode;
  /**
   * Action items (approval "action-items-checklist"): each run of adjacent
   * `:::action` blocks (blank lines between them only) is drawn as one card
   * in place of the run's first block; the run's other blocks draw nothing.
   * `recordFor` names the record a block draws (null: the block stays text
   * and ends the run); `render` draws a run's records, in body order.
   */
  renderActions?: {
    recordFor: (block: { startLine: number; content: string }) => InboxQuestion | null;
    render: (records: InboxQuestion[]) => React.ReactNode;
  };
  /**
   * Comments on the text (an agent's message that can still be answered;
   * approval "inbox-message-comments"): the person's comments on this message
   * waiting for a Send, drawn as highlights, and a selection opens the
   * toolbar (Delete, Comment, 👍; no label picker). `onSave` stores a new one (false: it was refused,
   * and its highlight goes). `onUnanchored` hears which could not be found by
   * their words; `onPainted` that highlights were drawn (the DOM changed).
   * Absent: the text takes no comments.
   */
  comments?: {
    annotations: readonly Annotation[];
    onSave: (annotation: Annotation) => Promise<boolean>;
    onUnanchored?: (report: { attempted: readonly string[]; unanchored: readonly string[] }) => void;
    onPainted?: () => void;
    /** A press on a comment's highlight: the list of comments, at this one. Null: the press made a selection, the list makes way. */
    onOpen?: (id: string | null) => void;
    /** The comment the list is open at: its highlight shows it. */
    openId?: string | null;
    /** Words the comment box opens with for this selection (the tour's suggested comment); absent: an empty box. */
    suggest?: (selectedText: string) => string | undefined;
    /** The comment on a diagram part the reply box's list just pointed at: the diagram shows it selected (its part panned into view, its ring pulsing). */
    revealed?: string | null;
    /** Ask AI's Side in the selection bar (ask/useInboxAsk.tsx `side`): the selected words go to the thread's chat, with where they came from (ask/sideSource.ts). Absent: no Side. */
    onSide?: (selected: string, source?: string) => void;
  };
  /**
   * The person's own sent reply (sentReply.ts): the answers it carried, read
   * from the thread's questions. The reply is then drawn in the person's
   * words, these answers as a short list, then its comments and files; the
   * agent-facing parts of the body ("Answered N questions.", the still-open
   * line, "## Answers to your questions") are left out. Display only: the
   * stored body and what agents get are unchanged.
   */
  sentAnswers?: readonly SentAnswerGroup[];
  /** A row of `sentAnswers` was pressed: show its question. */
  onJumpQuestion?: (target: JumpTarget) => void;
  /**
   * Where the body's images load from, in place of the message's own image
   * route (`inboxMessageImageBase`): the onboarding tour's assets
   * (`inbox-tour:`, images.ts). Absent: the message's route.
   */
  imageBase?: string;
  /** An image the body shows (a picture choice's zoom included) was opened: the host shows it. Absent: the thread's viewer. */
  onImage?: (src: string, alt: string) => void;
  /** A label over each picture choice's picture (ui QuestionBlock `pictureBadge`); absent: none. */
  pictureBadge?: (choice: { label: string; image: { alt: string; src: string } }) => string | null;
  /**
   * The src as the body wrote it, read back from an image URL the body drew: what finds the image's captured
   * file (`inline_images`, by `ref`). Absent: the message's own image route (inlineImageRefFromSrc). The
   * tour passes its own, for images drawn from its assets.
   */
  inlineRefOf?: (src: string) => string | null;
  /**
   * The person's own reply (replyFileLinks.ts): the files its feedback text
   * names (each "## <file>" heading of "Feedback on the attached files") are
   * drawn as links that open the file beside the thread, at the version the
   * comments were on, and a drawing's name shows the drawing. A heading that
   * names no file the thread still has stays text. Display only. Absent: the
   * text is drawn as written.
   */
  replyFiles?: {
    files: readonly InboxAttachmentState[];
    personMessageIds: ReadonlySet<string>;
    onOpen: (attachment: InboxAttachmentState, version: 'current' | 'sent') => void;
  };
}
