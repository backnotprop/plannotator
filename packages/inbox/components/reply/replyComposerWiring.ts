/**
 * A host that keeps its own draft page, mentions, the draft and files hooks' options and its whole Send flow: the
 * Inbox's thread pane (Thread.tsx). It hands them to the controller (useReplyComposer.tsx) instead of a store and an
 * uploader, so the box runs on the controller's words store, draft hook, files hook, key handler and guards while what
 * the Inbox does around them stays its own, unchanged:
 *
 * - The draft hook takes `draft` (another window's changes: `onWords`, `onFiles`, `ownedBox`, `onOffer`, and which
 *   threads keep drafts) on the host's `page`; the files hook takes `files` (its announcements, its uploader, what an
 *   unmount does with uploads). The host reads both back on the handle (`handle.wired`).
 * - `host.send` is the host's own Send, called once per press, synchronously inside the press: it claims the draft,
 *   clears it (`clear_draft`), empties the box and says what happened itself. The controller keeps a second press
 *   out while it runs, and keeps the box read-only (no typing, Discard, attach, paste, drop, a tile's remove or Put
 *   back) while the host says its Send is out (`view().sending`, from the moment the Send holds the words).
 * - The controller's own draft restore, file save, thread change and error line do not run: the host's do.
 *
 * `view()` is read as the box is drawn (and when a key or a press needs it): what the box shows and the host's
 * handlers, as they are in that render.
 */
import type { ReactNode } from 'react';
import type { useComposeFiles } from '../../compose/ComposeFiles';
import type { ReplyDraftOptions, ReplyDraftPage } from '../../replyDraft';
import type { ThreadMentions } from '../../threadMentions';
import type { ReplyBoxRecipients, ReplyBoxSkills, ReplyBoxVoice } from './replyBoxSeams';
import type { ReplyComposerHost, ReplyComposerSlots } from './replyComposerHost';

/** The files hook's options, as `useComposeFiles` takes them. */
export type ReplyComposerFilesOptions = NonNullable<Parameters<typeof useComposeFiles>[1]>;

/** What the box shows and does in this render, for a wired host. */
export interface ReplyComposerWiringView {
  /** The box is open (closed: the host draws its own foot). */
  open: boolean;
  /** A Send of the shown thread is out, started by the host (the box shows it sending). */
  sending: boolean;
  /** The words are drawn in the thread as a sending bubble: the field shows none. */
  sendingWords: boolean;
  slots: ReplyComposerSlots;
  recipients?: ReplyBoxRecipients;
  voice?: ReplyBoxVoice;
  skills?: ReplyBoxSkills;
  errorLine: ReactNode;
  draftNotSaved: boolean;
  /** The words changed (never called while a Send is out). */
  change: (text: string) => void;
  /** ⌘/Ctrl+Enter in the field: true when the host took it (the chord goes elsewhere); false sends. */
  chord: () => boolean;
  /** Escape in the field (an input method's own Escape never reaches it). */
  escape: () => void;
  /** The box's ×. */
  close: () => void;
  /** Discard (the bin): never called while a Send is out. */
  discard: () => void;
  /** The paperclip's files (never while a Send is out). */
  attach: (list: FileList) => void;
  /** Files went into the box (a drop, a paste): the host's line under the box clears. */
  added: () => void;
}

export interface ReplyComposerWiring {
  /** The draft page the host's other parts read (the Inbox's floaters and row menus). */
  page: ReplyDraftPage;
  /** The mentions scope the host's other parts read. */
  mentions: ThreadMentions;
  /** The draft hook's options, as the host builds them each render (its store, if not the page's default). */
  draft: ReplyDraftOptions;
  /**
   * The files hook's options, as the host builds them each render (no `uploader`: the hook's own). The words a long
   * paste is placed in are the controller's; `setText` is how the hook changes them (Put back, a paste's tile).
   */
  files: Omit<ReplyComposerFilesOptions, 'text'> & { setText: (text: string) => void };
  view: () => ReplyComposerWiringView;
}

/** A wired host: the plain host's contract without the store and uploader (the wiring's hooks carry their own). */
export interface ReplyComposerWiredHost extends Omit<ReplyComposerHost, 'uploader' | 'draftStore' | 'slots' | 'voice' | 'skills' | 'recipients'> {
  wiring: ReplyComposerWiring;
}
