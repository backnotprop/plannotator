/** The shapes replyDraft.ts takes: a box's options (`useReplyDraft`), a page's (`createReplyDraftPage`), a save on its way. */
import type { InboxReplyDraft } from '@plannotator/core/inbox-types';
import type { ReplyDraftFileOps, ReplyDraftStore } from '@plannotator/core/inbox-reply-draft';
import type { ReplyDraftFiles } from './replyDraftKeys';
import type { ThreadMentions } from './threadMentions';

export interface ReplyDraftOptions {
  /** Where drafts are kept (default: this Inbox's, over HTTP). */
  store?: ReplyDraftStore;
  /**
   * A save of this window's landed: the box takes the draft's files (the thread whose draft it is, the draft as
   * saved, and `wanted`: the ids the box holds now, the draft's files with this window's changes still on their
   * way applied). The box then says what it holds (`boxTook`).
   */
  onFiles?: (threadId: string, draft: InboxReplyDraft, wanted: readonly string[]) => void;
  /**
   * Only another window changed the words (this box still holds the words this window last knew): no conflict. The
   * box takes the draft's words (`was`: the words it should hold now), and this window's file changes are saved with
   * them. Answers `took` (open on that thread, its live words still `was`: it took them), `hidden` (the box is
   * closed or shows another thread: no words of this window's to keep, so the change is saved with the newer words
   * all the same) or `differs` (its live words changed since: the conflict shows).
   */
  onWords?: (threadId: string, draft: InboxReplyDraft, was: string) => ReplyBoxTook;
  ownedBox?: (threadId: string) => { text: string; files: ReplyDraftFiles } | null;
  /**
   * A saved draft is offered (Restore draft) and the person edited the box (or had typed before the thread's first read
   * answered): the box takes the offered draft with its words after it (`restoreOffer`), which saves it. Typing is
   * always saved: an offer never holds typed words back.
   */
  onOffer?: (threadId: string) => void;
  /** Whether the host keeps this thread's draft (default: always). Not kept: nothing is sent, the words wait here, guarded. */
  canPersist?: (threadId: string) => boolean;
  /** Told when `canPersist` may answer otherwise (its answer stops it): the words that waited are saved once. */
  onPersistenceChange?: (listener: () => void) => () => void;
  /** Threads known to live elsewhere (default none): only theirs are words kept here while `canPersist` says no. */
  isRemote?: (threadId: string) => boolean;
}

/** What the box did with another window's newer words (`onWords`). */
export type ReplyBoxTook = 'took' | 'hidden' | 'differs';

/** One save on its way (queued or in flight): its words and file changes, which a refused or skipped save hands on. */
export interface QueuedSave {
  text: string;
  ops: ReplyDraftFileOps;
  /** Its words went into an offered draft taken since (`restoreOffer`): the newer save with both carries them. */
  taken?: boolean;
  /** Words that did not land, saved again (`retry`): sent on the draft they were typed over, never a newer one. */
  over?: { base: string | null; words?: string | null };
  /** The thread's generation as it was queued: a Send or Discard since makes it nothing to send. */
  generation: number;
}

/** How a page holds its drafts (`createReplyDraftPage`). */
export interface ReplyDraftPageOptions {
  /**
   * Words no draft holds (a save that did not land, a conflict's, a remote thread's) are also kept in this browser, so
   * a tab the browser ends loses none (replyWordsKept.ts). Default true (the Inbox). False: kept in the page only.
   */
  keepInBrowser?: boolean;
  /** Where the drafts' mentions are kept: the field's scope (threadMentions.ts). Default: the Inbox's own. */
  mentions?: ThreadMentions;
}
