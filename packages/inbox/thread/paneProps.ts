/** What the thread pane (components/Thread.tsx `ThreadPane`) takes from App. */
import type { InboxListGroupId, InboxListRow, InboxQuestion, InboxReaction, InboxRun, InboxSentRecipient, InboxThread } from '@plannotator/core/inbox-types';
import type { MachineView, OutboxView, ThreadModel } from '../api';
import type { FrameMove } from '../fullScreenOrigin';
import type { InboxToastModel } from '../components/Toast';
import type { ReviewView } from '../pulls/reviewsModel';
import type { ReuseSource } from '../reuse';
import type { ActionMark } from '../components/ActionChecklist';
import type { OpenQuestionsDecide } from '../components/OpenQuestions';
import type { StepsSubscribe } from '../steps/useThreadSteps';
import type { Signal } from '../signal';
import type { ShapeReplyPart } from '../shape/addToReply';

export interface ThreadPaneProps {
  /** The thread is open in Reviews (the address), whatever its row says from one read to the next. */
  inReviews?: boolean;
  /** Its row in Reviews: the line and title over the messages, and what came before the review folded. */
  reviewView?: ReviewView | null;
  /** The review card's quiet link to this thread in Reviews; absent where there is no such page, or already on it. */
  onInReviews?: () => void;
  /**
   * The thread in full screen: the sidebar and the list hidden, the thread at a reading measure. The header leads with
   * "‹ Inbox" (back to them) in place of the button that hid them, and has no ×.
   */
  threadAlone?: boolean;
  /** The sidebar is open beside the list (the person's choice, not held closed): full screen hides it and brings it back. */
  fullSidebar?: boolean;
  /** Enter or leave the thread's full screen; absent where it has none (a thread opened from a Board card). */
  onFull?: (on: boolean) => void;
  /** A line under the subject, from the window (the tour's notifications ask, once more, in the first real thread). */
  notice?: React.ReactNode;
  thread: InboxThread;
  /**
   * Linked machines: the machine whose thread this is, when it is another machine (null: this machine's own).
   * The meta line under the subject names it, or says it is away since when.
   */
  machine?: MachineView | null;
  /**
   * Update a linked machine (by id): the error line's "Update" when a Delete there was refused because its Inbox is
   * too old. Absent: the line says so without it.
   */
  onMachineUpdate?: (machineId: string) => void;
  /** An archived thread's reuse button: New message with this file. Absent: an archived thread offers no button. */
  onNewMessageWith?: (source: ReuseSource) => void;
  /**
   * Writes held for that machine about this thread (machines.ts `threadOutbox`): the person's words still on their
   * way ("Sending to MacBook…", "Will send when MacBook is back"), or a write that did not land, with Dismiss.
   */
  outbox?: readonly OutboxView[];
  onDismissOutbox?: (key: string) => void;
  /**
   * The thread's list row's `sent`: the person's reply is the last message
   * (the Inbox's own notes read past), and when the agent read it (by the
   * store's seq, so a reply the agent was not given still reads as unread),
   * or null.
   */
  sent: { at: string; checked_at: string | null; read_by?: string; recipients?: InboxSentRecipient[] } | null;
  /** The thread's questions changed through a pick (the response's questions for that message). */
  /** `stateKept`: every question kept its state (only words typed in an answer changed): nothing outside the pane moved. */
  onQuestions: (messageId: string, questions: InboxQuestion[], stateKept?: boolean) => void;
  /**
   * A Send's answer carried the thread as a read of it answers now (`thread_read`): the window draws the sent reply
   * from it and reads only the list after. False: not drawn (the person moved on, or no such read), so `onChanged` reads.
   */
  onSentRead?: (model: ThreadModel) => Promise<boolean>;
  /**
   * Mark read is drawn (the header's Read pressed) but its write and the reads after it have not landed: the line
   * under the header ("Read … N questions were closed …") waits for them, so it never shows half of what it says.
   */
  readPending?: boolean;
  /** The questions (`<message id>/<key>`) with an answer saving, each time they change; none: the last one landed, or the pane closed. */
  onPickSaves?: (ids: ReadonlySet<string>, paneClosed?: boolean) => void;
  /** Something was written (a Send, resolve): read the thread and the list again. */
  onChanged: () => Promise<void>;
  /** Raised each time the Inbox says this thread's reply draft changed (`event: drafts`): the draft is read again. */
  draftChanged?: number;
  /** Raised each time records needed only this thread's files read again, not the thread (openThreadReads.ts). */
  filesChanged?: number;
  /**
   * The same two as signals (signal.ts), which draw nothing themselves: the window tells the pane to read its
   * reply draft, or its files, again. A read that brings nothing new then draws nothing at all.
   */
  draftSignal?: Signal | null;
  filesSignal?: Signal | null;
  onClose: () => void;
  /** The attachment open beside the thread (`#…&file=att_…`), its version, and an annotation to show. */
  file: { id: string; version: 'current' | 'sent'; focus: string | null; linked?: string | null; view?: 'full' | 'side' | null; set?: string | null } | null;
  /** `replace`: swap the history entry (stepping between files), so Back returns to the thread in one press. */
  /** `back`: the browser's Back when the entry on screen was opened from `file` (a linked page's Back), else a new entry. */
  /** `move`: into full screen from beside the thread, or back out to it (fullScreenOrigin.ts): the window keeps the history a stack of frames. */
  onOpenFile: (file: { id: string; version: 'current' | 'sent'; focus: string | null; linked?: string | null; view?: 'full' | 'side' | null; set?: string | null } | null, options?: { replace?: boolean; back?: boolean; move?: FrameMove }) => void;
  /**
   * The full screen on screen was entered from the file beside the thread (the history entry's mark,
   * fullScreenOrigin.ts): × and Escape go back beside the thread. Else they close the file, back to the thread.
   */
  fullFromSide?: boolean;
  /** The file × and Escape go back to when it is not the one on screen (fullScreenOrigin.ts `fullExitFile`), or null. */
  fullExitFile?: string | null;
  /** Open the guided review a message carries (the record's 4.2; `at`: a place in it, a context note's "Open in the review"; `side: 'old'` for removed lines). */
  onOpenGuide: (messageId: string, at?: { path: string; line: number; side?: 'old' }) => void;
  /**
   * Where "new since you looked" starts (folding.ts `lookBoundary`), read
   * from the thread BEFORE the window recorded this look and kept until the
   * person leaves the thread. The window takes it from its own first read,
   * which lands before it records the look. Absent: the pane takes it from
   * the first thread it is given.
   */
  lookSeq?: number | null;
  /** When this thread came back from its snooze, while the person stays in it (snoozeBack.ts); else null. */
  snoozeBack?: string | null;
  /**
   * Seen on sight (design record "inbox-new-in-open-thread", approved
   * 2026-10-12): the seq the window's looks this visit covered (the look
   * recorded when the thread opened, raised as arrivals are seen). An agent
   * message after it arrived while the thread was open; once its first lines
   * have been on screen for a second (window in front, nothing over the
   * thread) the pane calls `onSeen` with the seq the look may now cover.
   * Null: the thread carries no seqs (an older Inbox). Absent `onSeen`: off.
   */
  seenThrough?: number | null;
  onSeen?: (throughSeq: number) => void;
  /** Something over the thread from outside the pane (a guided review, a dialog): nothing counts as seen. */
  covered?: boolean;
  /**
   * Whether this thread is visible: called with its id and whether anything
   * covers it (from outside, or a file over it), and with null when the pane
   * goes. Notifications skip a question in the thread on screen (notify.ts).
   */
  onScreenChange?: (state: { threadId: string; covered: boolean } | null) => void;
  /** The thread's list row as it is now: Mark read's state and whether it is offered. Null until the list has it. */
  row?: InboxListRow | null;
  /** The group the thread's row sits in on the list on screen (markRead.ts `seenHeldInNew`). */
  drawn?: InboxListGroupId | null;
  /** Mark read, or move it back (the pressed button). Absent: no Mark read button. */
  onMarkRead?: (read: boolean) => void;
  /**
   * Mark unread (markRead.ts `canMarkUnread`): on a thread read by opening it
   * (not marked read) the header's Mark read becomes Mark unread, the moment
   * `row` reads it as looked at (its look on its way included) and while the
   * list still holds its row in New (the owner, 2026-11-02). It closes the
   * thread, which stays unread. Absent: the button stays Mark read.
   */
  onMarkUnread?: () => void;
  /**
   * 👍 Looks good on the agent's latest message (`on`), or take it back:
   * silent, nothing is sent; the thread is marked read. `agent` names the
   * agent for the toast. Absent: no Looks good button. `reaction`: the emoji
   * picked in the 👍's tray (null: 👍 Looks good; taking back, the one taken
   * back), approval "inbox-reaction-tray". `was`: set only when the message
   * already had the mark (the reaction it had; null: 👍), so only the emoji changes.
   */
  onAck?: (messageId: string, on: boolean, agent: string, reaction?: InboxReaction | null, was?: InboxReaction | null) => void;
  /**
   * An action item's Done or Can't do it (`mark`) into the reply draft, or
   * taking it back (`null`), approval "inbox-action-items-in-reply": the window
   * writes it and reads the thread again. Resolves the message's action items
   * as saved, or null when it was refused. Absent: the pane writes it itself
   * and reads the thread again.
   */
  onAction?: (messageId: string, key: string, mark: ActionMark | null) => Promise<InboxQuestion[] | null>;
  /** Archive (`true`) or Unarchive. Absent: the pane calls the resolve route itself. */
  onArchive?: (archived: boolean) => void;
  /**
   * The thread is pinned to the sidebar (approval "inbox-pinned-threads"), and
   * the header's pin toggle. Absent (an older Inbox keeps no pins): no toggle.
   */
  pinned?: boolean;
  /** Resolves once the pin is written and the list read again (the header waits on it before the next click's request). */
  onPin?: (pinned: boolean) => void | Promise<unknown>;
  /** Snooze the thread until a moment (the ⋯ menu, approval "inbox-snooze"). Absent (an older Inbox keeps no snoozes): no item. */
  onSnooze?: (until: string) => void;
  /** This thread's machine must update before Snooze works: Snooze stays and opens the update dialog. */
  snoozeBlocked?: { name: string; onPress: () => void };
  /** End its snooze: the line under the subject, and the ⋯ menu. */
  onUnsnooze?: () => void;
  /** The thread whose reply box should open (the warning toast's Reply); the pane calls `onReplyOpened` once it has. */
  replyRequest?: string | null;
  onReplyOpened?: () => void;
  /** Shape's Pebble (approval "shape-inbox-placement"): the thread's board, at the header's right beside ⋮. Null: none. */
  shapeButton?: React.ReactNode;
  /**
   * Ask AI's Side for the selection bars of the agents' messages and of the open file (ask/useInboxAsk.tsx `side`).
   * Absent while this thread cannot ask: no Side. The top bar has no Ask icon (the owner, 2026-11-09): Side starts a chat.
   */
  onSide?: (selected: string, source?: string) => void;
  /**
   * The reply box's `/side` (ask/useInboxAsk.tsx `sideWords`): the reply's words go to the thread's side chat, and
   * `taken` is called once its box has them. Absent while this thread cannot ask: `/side` is not listed.
   */
  onSideWords?: (words: string, taken?: () => void) => void;
  /** Words from Ask AI's Reply in the thread: they join the reply draft, and the pane calls `onReplyWordsTaken` once. */
  replyWords?: string | null;
  onReplyWordsTaken?: () => void;
  /**
   * A board's Add to reply (packages/inbox/shape/addToReply.ts): its words join the reply after any it holds, its
   * picture joins the reply's files, with the window's "Added to your reply · Undo". The pane calls `onReplyPartTaken` once.
   */
  replyPart?: ShapeReplyPart | null;
  onReplyPartTaken?: () => void;
  /** On a phone the header leads with a Back button named for the screen under the thread ("Inbox", a project). */
  backLabel?: string;
  /** A thread opened from a Board card: the chip naming the card, under the subject (board/CardChip.tsx). */
  cardChip?: React.ReactNode;
  /**
   * Thread steps (approval "inbox-thread-steps"): the switch, and the window's steps changes (a steps line naming
   * this thread, presence moved, a catch-up). Null or off: no steps button. `boardCard`: the Board card that links
   * the thread (the Board on), opened by the panel head's Board icon.
   */
  threadSteps?: { on: boolean; subscribe: StepsSubscribe; boardCard?: { title: string; onOpen: () => void } | null } | null;
  /**
   * Code review is on (Settings → Capabilities, approval "inbox-code-review-direction"): a review an agent sent
   * shows as a review card with Start review. Off or absent: today's guided-review tile, nothing new.
   */
  codeReview?: boolean;
  /** A phone: one screen at a time, so an open file takes the whole window (phone.ts). */
  phone?: boolean;
  /**
   * A window too narrow for the list beside the thread (stack.ts): the thread
   * covers the list, and its header leads with the way back to it.
   */
  stacked?: boolean;
  /** A window too narrow for a file beside the thread (stack.ts): an open file takes the whole window. */
  fileStacked?: boolean;
  /**
   * This page came through the tailnet ("Over your tailnet"): "Open in" is a
   * new tab only, never an app on the computer. Null until the settings say
   * where the page is: no "Open in" yet, so a tailnet page never asks for the
   * local app list.
   */
  remote?: boolean | null;
  /**
   * A tailnet guest's page (`tailnetGuest(settings)`): a launched agent's ⋯ has
   * no Stop or Delete, as the server answers both `owner_only`.
   */
  guest?: boolean;
  /**
   * A file open beside the thread on a desktop hides the list and the
   * sidebar: the header then leads with `‹ Inbox` (`backLabel`), which closes
   * the file (through the pane's leave, as the file's × does: a typed
   * comment waits as the file's draft) and calls this with the file's name, so the window can bring the
   * list back and put focus on this thread's row. Absent: no such button.
   */
  onBackToList?: (fileName: string | null) => void;
  /** The window's one toast: "Files open side by side now" with Undo, when a picked view becomes the remembered one. */
  onToast?: (toast: Omit<InboxToastModel, 'id'>) => void;
  /** Take down the toast this pane put up, named by its Undo, when it is still the one showing (another replaced it: no change). */
  onToastGone?: (onUndo: () => void) => void;
  /**
   * The thread's address, or one message's (`&msg=<id>`), for the copy menus' Copy link (CopyMenus.tsx). Absent:
   * the window's own origin (rowMenu.ts `threadLink` before the settings load).
   */
  linkOf?: (messageId?: string) => string;
  /** A link in an attached page to this Inbox (AttachmentPane's `onInboxLink`). */
  onInboxLink?: (href: string) => (() => void) | null;
  /**
   * A search result to land on (`#thread=…&msg=…`): the message is unfolded
   * if folded or hidden in the middle fold, scrolled to the centre, focused
   * and ringed (a question's card when the match was in a question), and the
   * query's words are highlighted in it until the first click or key in the
   * thread. `onLanded` then drops `msg=` from the hash. `focus: 'prompt'`
   * (decision mode's "Open the thread", approval "inbox-decide-thread-only"):
   * focus goes to the question's prompt, not the card.
   */
  landing?: { messageId: string; terms: readonly string[]; questionKey: string | null; focus?: 'prompt' } | null;
  onLanded?: () => void;
  /**
   * The Artifacts view is on (approval "inbox-thread-artifacts", `#thread=…&artifacts`):
   * the thread's body is swapped for a grid of every artifact across its messages.
   */
  artifacts?: boolean;
  /** Turn the Artifacts view on or off (the header's button, "Back to the thread"). Absent: no Artifacts button. */
  onArtifacts?: (open: boolean) => void;
  /** The Artifacts view shows the thread's links (`#thread=…&artifacts&links`): its other side, never a second view. */
  links?: boolean;
  /** Move between the view's two sides. */
  onLinks?: (on: boolean) => void;
  /**
   * Decision mode (experimental, thread only): "Decide these N" at the top of
   * the open-questions list, which opens the dialog scoped to this thread.
   * The window passes it only while two or more of the thread's decisions wait.
   */
  decide?: OpenQuestionsDecide | null;
  /**
   * A launched thread's run line (the thread route's `run`, launch only): null while the agent rests.
   * Absent: not a launched thread, or launch is off (the delivery line as always).
   */
  run?: InboxRun | null;
  /** The host's attach command for a launched thread (the thread route's `attach_command`), also while the agent rests. */
  attachCommand?: string | null;
  /** Stop, Try again or Delete changed the launch: read the thread again. */
  onRunChanged?: () => void;
  /**
   * The ids of the messages in the first read of this thread that landed after it was opened (App's `openedWith`).
   * A permission card among them never takes focus. Null (or absent) while that read has not landed, when `thread`
   * may be a stale copy from an earlier visit: then no card takes focus.
   */
  openedWith?: ReadonlySet<string> | null;
}
