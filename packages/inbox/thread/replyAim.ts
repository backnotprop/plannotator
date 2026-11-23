/**
 * Who gets the reply in a thread with more than one agent (approval "inbox-reply-recipient"), and when that choice
 * holds. The owner's decision of 2026-11-21, "Yes, follow until I type or pick": while the reply is empty and the
 * person has not picked, it goes to the agent that wrote last (`followedSession`), so an agent writing while the
 * thread is open moves it. The moment the reply holds anything (a character, a file, a comment, a quote, an answer
 * picked or still saving, dictation under way, a saved draft) or the person picks (the list, the Reply arrow), it
 * holds, whatever arrives after: it never changes under words being written. Emptied again without a pick or a
 * draft's choice (the words deleted, a Send), it follows again; a pick, and a choice a draft brought back, hold until
 * a Send, the box closed with no draft (a Discard), or another thread (as a pick always did).
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isInboxPermissionSession } from '@plannotator/core/inbox-permission';
import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import type { RecipientRow } from '../replyRecipients';
import type { ReplyText } from '../replyText';
import { sameSession, tookOverReply } from '../sendTargets';
import { activeHandoff } from '../tags';

/**
 * The session the reply follows while the box is empty: the newest agent message's (a permission prompt's and a
 * routine's change line passed over, as the words' default does), also when that session has ended: the chip then
 * says so, and Send stops once to show it (an ended agent's thread still takes a message that waits for it, and a
 * session the Inbox wakes itself drops off the live list while it can still take one). The person's own messages and
 * the Inbox's notes are not an agent's. A thread handed to another session, or taken over from one that ended, keeps
 * the words' own rule (`fallback`, from `wordsMessage`): the former owner writing again never takes the words back.
 * No agent message in the list: `fallback`.
 */
export function followedSession(thread: InboxThread, rows: readonly RecipientRow[], fallback: string | null): string | null {
  if (rows.length === 0 || activeHandoff(thread) !== null || tookOverReply(thread) !== null) return fallback;
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const m = thread.messages[index]!;
    const session = m.author.kind === 'agent' ? m.author.session : null;
    if (!session || isInboxPermissionSession(session) || m.scheduled_change) continue;
    const row = rows.find((r) => r.session === session);
    if (row && !row.start && row.alone !== false) return session;
  }
  return fallback;
}

/** The session a message's words reach: its agent's, or the one a person's reply was addressed to. */
export function wordsSession(message: InboxMessageWire): string | null {
  return message.author.kind === 'agent' ? (message.author.session ?? null) : (message.to?.session ?? null);
}

/**
 * The message a Send's unaimed words answer: the one they answered at the press (`pressed`, the chip's default then)
 * when a thread read during the Send moved the default to another session (an agent wrote meanwhile); else undefined,
 * the thread's own default now. The chip named `pressed`'s session, so the words never go elsewhere.
 */
export function wordsHeldAt(pressed: InboxMessageWire | undefined, now: InboxMessageWire): InboxMessageWire | undefined {
  if (!pressed || pressed.id === now.id || sameSession(pressed, now)) return undefined;
  return pressed;
}

/** What fixed the choice: the person's pick, the box's first content, or a draft that came back with one. */
export type AimBy = 'pick' | 'words' | 'draft';

export interface ReplyAim {
  /** The fixed choice, or null while it follows. */
  picked: readonly string[] | null;
  /** The fixed choice came back with a draft (not the person's own tap). */
  restored: boolean;
  /** Who gets the reply while nothing is fixed: the followed session (the one last shown once the box holds something). */
  lead: string | null;
  /** The person picked (the list, the Reply arrow): it holds until a Send, the box closed with no draft, or another thread. */
  pick: (ids: readonly string[]) => void;
  /** A Send went: the next reply follows again. */
  forget: () => void;
  /** The list is open. */
  listOpen: boolean;
  setListOpen: (open: boolean) => void;
}

const anyText = (text: ReplyText) => () => text.get() !== '';

export function useReplyAim(input: {
  threadId: string;
  /** The recipient control shows (several agents, or an ended one's reply another can take). */
  active: boolean;
  boxOpen: boolean;
  boxOpenNow: () => boolean;
  /** `followedSession` now (with no control: the words' default). */
  follow: string | null;
  text: ReplyText;
  /**
   * Anything else the reply holds: files, comments, a quote, answers picked (a pick still saving too), dictation under way,
   * a draft's words or files with the box closed.
   */
  carries: boolean;
  /** The saved draft's choice, and whether there is a draft. */
  saved: readonly string[] | undefined;
  hasDraft: boolean;
}): ReplyAim {
  const { threadId, active, boxOpen, follow } = input;
  const [kept, setKept] = useState<{ thread: string; ids: readonly string[]; by: AimBy } | null>(null);
  /** The choice, this thread's only (a render before the reset below never shows another thread's). */
  const aim = kept?.thread === threadId ? kept : null;
  const setAim = (next: { ids: readonly string[]; by: AimBy } | null) => setKept(next && { thread: threadId, ...next });
  const [listOpen, setListOpen] = useState(false);
  // Any character counts, a space too: the person started writing.
  const read = anyText(input.text);
  const typed = useSyncExternalStore(input.text.subscribe, read, read);
  const holds = active && (typed || input.carries);
  /** The followed session the control showed at the last commit, in this thread: what a first character fixes. */
  const shown = useRef<{ thread: string; session: string | null }>({ thread: threadId, session: null });
  const shownHere = shown.current.thread === threadId ? shown.current.session : null;
  // The render where the box first holds something shows what was shown before it, never a newer writer's name.
  const lead = holds && shownHere ? shownHere : follow;
  // The choice a draft was saved with comes back (a reload, another window, back to the thread). While the box is
  // open the person's own choice stands: a save's answer never takes it back.
  const savedKey = input.saved?.join('\u0000') ?? '';
  useEffect(() => {
    if (!active || !savedKey) return;
    if (aim === null || (!input.boxOpenNow() && aim.ids.join('\u0000') !== savedKey)) setAim({ ids: savedKey.split('\u0000'), by: 'draft' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey, active]);
  // A box that opens on a draft takes its choice; an empty one follows. A box closed with no draft forgets it.
  useEffect(() => {
    if (!active) return;
    if (boxOpen) {
      if (aim === null && input.saved && input.saved.length > 0) setAim({ ids: input.saved, by: 'draft' });
      return;
    }
    setListOpen(false);
    if (!input.hasDraft) setAim(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxOpen, active]);
  useEffect(() => {
    setAim(null);
    setListOpen(false);
  }, [threadId]);
  // Fixed before the paint (and before any Send can read it) the moment the box holds something; following again
  // once it is empty again, only when what fixed it was the box's content: a pick holds, and so does a draft's
  // choice (a pick, or words, that came back after a reload or another thread), until a Send or a Discard.
  const held = useRef(holds);
  useLayoutEffect(() => {
    const was = held.current;
    held.current = holds;
    if (holds && aim === null && lead) setAim({ ids: [lead], by: 'words' });
    else if (!holds && was && aim?.by === 'words') setAim(null);
    // Without the control it is whom the words go to (`follow` is the words' default then), so a second agent
    // writing into a one-agent thread mid-reply shows the chip on that one. What stands in for a fixed choice this
    // window cannot use (a restored draft's unknown lead) stays put too.
    if (!active || aim === null || shownHere === null) shown.current = { thread: threadId, session: lead };
  });
  return {
    picked: aim?.ids ?? null,
    restored: aim?.by === 'draft',
    lead,
    pick: (ids) => setAim({ ids, by: 'pick' }),
    forget: () => {
      setAim(null);
      setListOpen(false);
    },
    listOpen,
    setListOpen,
  };
}
