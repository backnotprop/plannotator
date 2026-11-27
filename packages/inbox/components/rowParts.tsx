/**
 * Parts every thread row draws the same in each shape of the list (InboxList.tsx): its title, its time, its counts and
 * marks, its hover action. Moved out of InboxList.tsx unchanged so the Agents view's one-line row (agentsView/) draws
 * them the same.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { HueDot, LetterMark, showsThreads, useRowMarks } from '../letterMarks';
import { withShortcut } from '../shortcuts/hint';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import type { InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';
import { inboxSnoozeWhen } from '@plannotator/core/inbox-snooze';
import { fullTime, shortTime, whenTime } from '../format';
import { rowRecipientName, rowWho } from '../scriptAuthor';
import { reaskRowLine, sentRowLine, undeliveredLabel } from '../deliveryLine';
import { sentRecipientsWords } from '../tags';
import { TagStack } from './TagPicker';
import { LazyRowTips, opensTips, RowTip } from './RowTip';
import { AuthorMark, Icon } from '../icons';
import { canMarkUnread, offersRowMarkRead } from '../markRead';
import { inboxHasUnsent, inboxRowArchived } from '@plannotator/core/inbox-types';
import { rowLabel, ScheduledBadge } from '../scheduled/rowLook';
import { DraftLabel, rowUnsent, unsentWords } from './DraftLabel';
import { rowTimeIso, rowWait } from '../rowDelivery';
import { UndeliveredBadge, useMinuteClock } from './Undelivered';
import { TimeWithTick } from './DeliveryTick';
import { ActionBadge, QuestionMark, WaitCard, badgeDescription, rowHasBadge, rowMarks, type RowMarks } from './RowBadge';
import { StatusMark, rowStatus } from './RowStatus';
import { relativeTime, relativeWords, useRelativeClock } from '../relativeTime';
import { InArchivedGroup, UnarchiveAction } from './ArchivedGroup';

/**
 * Whom a row is about: the agent that wrote the thread, or, for a thread the
 * person started (compose), the agent it is addressed to (`addressee`), so the
 * row draws that agent's mark and name, never the person's.
 */
export function rowAgent(row: InboxListRow): InboxListRow['author'] {
  return row.addressee ? { kind: 'agent', host: row.addressee.host, session: row.addressee.session, name: null } : row.author;
}

/**
 * The row's words for whom a reply goes to or who writes next (scriptAuthor.ts `rowRecipientName`): in a thread a
 * script started and a session took over, that session, never "Script" or the script's "An agent".
 */
export function rowRecipient(row: InboxListRow): string {
  return rowRecipientName(row, rowAgent(row));
}

export function slotSession(row: InboxListRow): string | null {
  const agent = rowAgent(row);
  return agent.kind === 'agent' ? (agent.session ?? null) : null;
}

/**
 * The badge card's footer mark: the agent's, or, when several agents are in the thread, their marks overlapping
 * (Lines). The row itself draws its agents before the project, on tiles: `RowAgents` on a wide row, `RowAgentTiles`
 * on a three-line or phone row.
 */
export function RowMark({ row }: { row: InboxListRow }) {
  // Agent icons off (Settings → Rows) takes the agent's mark off the card too; its name stays in words beside it.
  const { hideAgents } = useRowMarks();
  if (hideAgents) return null;
  if ((row.participants?.length ?? 0) > 1) return <TagStack participants={row.participants!} />;
  return <AuthorMark author={rowWho(row, rowAgent(row))} />;
}

/** A blocked row's hover card (wide and three-line rows), or undefined: its filled marks' tooltip. */
export function cardOf(row: InboxListRow): ReactNode | undefined {
  if (!rowHasBadge(row)) return undefined;
  return <WaitCard row={row} agent={rowRecipient(row)} mark={<RowMark row={row} />} time={shortTime(rowTimeIso(row))} />;
}

/** A snoozed row's return time, with the clock: where the row's words go (approval "inbox-snooze"). */
export function SnoozedUntil({ row }: { row: InboxListRow }) {
  if (!row.snoozed) return null;
  return (
    <span className="ib-zwhen" data-snoozed-until={row.snoozed.until} title={fullTime(row.snoozed.until)}>
      <Icon name="clock" size={13} />
      <span className="ib-sr">Snoozed until </span>
      {inboxSnoozeWhen(row.snoozed.until)}
    </span>
  );
}

/**
 * The time a list's rows show in place of their own (`rowTimeIso`), or null. Recent activity's (listFilterRecent.ts,
 * the list's `ListSort.by`): when the person last acted in the thread, the time the list is sorted by, so the times
 * read in order down the list. A row it gives no time keeps its own.
 */
export const RowTimeBy = createContext<((row: InboxListRow) => string) | null>(null);

/** Around a list's rows: their tooltips mounted on first use (`LazyRowTips`, RowTip.tsx), and the time they show (`RowTimeBy`). */
export function ListRows({ timeBy, children }: { timeBy?: ((row: InboxListRow) => string) | null; children: ReactNode }) {
  return (
    <LazyRowTips.Provider value={true}>
      <RowTimeBy.Provider value={timeBy ?? null}>{children}</RowTimeBy.Provider>
    </LazyRowTips.Provider>
  );
}

/** The row's time. A thread back from a snooze shows a small clock before it until the person reads it. */
export function RowTime({ row, relative = false }: { row: InboxListRow; relative?: boolean }) {
  // A relative time moves on by itself: the shared minute clock renders it again (only while it is on).
  const now = useRelativeClock(relative);
  const timeBy = useContext(RowTimeBy);
  const iso = timeBy?.(row) || rowTimeIso(row);
  // Relative: a screen reader hears "4 minutes ago" (never "4m"), and the pointer's tooltip gives the clock time.
  const time = relative ? (
    <span className="ib-trel" data-relative-time="" title={whenTime(iso)}>
      <span aria-hidden="true">{relativeTime(iso, now)}</span>
      <span className="ib-sr">{relativeWords(iso, now)}</span>
    </span>
  ) : (
    shortTime(iso)
  );
  return (
    <>
      {row.snooze_back && (
        <span className="ib-zback" data-snooze-back-mark="" role="img" aria-label="Back from snooze">
          <Icon name="clock" size={13} />
        </span>
      )}
      <TimeWithTick delivery={row.delivery} time={time} />
    </>
  );
}

/** The badge card's words for a screen reader, beside the row (the row names it in `aria-describedby`). */
export function BadgeWords({ row, id }: { row: InboxListRow; id: string }) {
  if (!rowHasBadge(row)) return null;
  return (
    <span hidden id={id}>
      {badgeDescription(row)}
    </span>
  );
}

/**
 * The subject cell's words. A row keeps its own subject: the delivery glyph
 * by its time says where the person's reply is (approval "inbox-row-delivery").
 * An older Inbox sends no `delivery`: its Sent row says it in words instead.
 */
export function subjectOf(row: InboxListRow): string {
  return sentWordsOf(row) ?? row.subject ?? '(no subject)';
}

/** A Sent row's own words in place of its subject, or null. */
export function sentWordsOf(row: InboxListRow): string | null {
  if (row.section !== 'sent') return null;
  // A thread the person started keeps its own subject in Sent; its count cell says whom it went to.
  // A reply that tags agents (approval "inbox-tag-agents", Lines): how many have it, and who waits.
  if (!row.addressee && row.sent?.recipients?.length) return sentRecipientsWords(row.sent.recipients);
  // A Re-ask note waits on the agent to ask again (approval "inbox-reask"): its own words, beside the delivery tick.
  if (row.reask_pending) return reaskRowLine(rowRecipient(row), row.sent?.checked_at ?? null, row.sent?.wakes);
  if (!row.addressee && !row.delivery) return sentRowLine(rowRecipient(row), row.sent?.wakes);
  return null;
}

/**
 * The row's title (approval "list-rows-mail-icons", 2026-10-30): the thread's name, or its subject when it has none.
 * A starred pill is labelled with it too (StarredPills.tsx), so a pill and its row never name a thread differently.
 */
export function titleOf(row: InboxListRow): string {
  return row.thread_name?.trim() ? row.thread_name : subjectOf(row);
}

/**
 * A row's title (`titleOf`), plain, or with "Highlight thread subject" on (approval
 * "inbox-list-options") in the thread chip's pill (`.ib-key`, the open thread's pill), at the title's own size and
 * cut to one line. `className` is the shape's title class (`ib-title`, `ib-m2`). `tip`: a title that can be cut
 * (a wide row's, one in its pill, or one on a compact row's line 1) shows its whole text in a tooltip while it is
 * cut (`ClipText`).
 */
export function RowTitle({ row, className, pill, tip = false }: { row: InboxListRow; className: string; pill: boolean; tip?: boolean }) {
  const cls = pill ? `ib-keyt ${className}` : className;
  const title = tip ? (
    <ClipText className={cls} text={titleOf(row)} />
  ) : (
    <span className={cls} dir="auto">
      {titleOf(row)}
    </span>
  );
  const out = pill ? <span className="ib-key ib-rowkey">{title}</span> : title;
  return <TitleMark row={row}>{out}</TitleMark>;
}

/** Letter marks (letterMarks.tsx), style "Inline": a 20 px tile before the title; style "Dot": the thread's hue alone. */
export function TitleMark({ row, children }: { row: InboxListRow; children: ReactNode }) {
  const { marks } = useRowMarks();
  if (marks.style === 'avatar' || !showsThreads(marks.what)) return <>{children}</>;
  return (
    <span className="ib-lm-tt" data-take={marks.style}>
      {marks.style === 'inline' ? <LetterMark name={titleOf(row)} seed={row.thread_id} size={20} /> : <HueDot seed={row.thread_id} />}
      {children}
    </span>
  );
}

/**
 * What the count says in words (approval "inbox-row-byline"), or null: the open counts (`OpenCounts`) or nothing. A
 * three-line or phone row draws `short` in its 124 px slot (option A, 2026-10-29) and says `full` in the tooltip and its
 * name; a wide row draws `long`, the full words (the owner, 2026-10-29: full words in full-width mode). Open action
 * items are no longer words here (approval "inbox-row-action-icon", 2026-10-29): they are the action pill beside `?N`.
 */
export function countWords(row: InboxListRow, now: number, tickAlone = false): { short: ReactNode; long: ReactNode; full: string } | null {
  const same = (words: string) => ({ short: words, long: words, full: words });
  // A reply waiting on a busy agent (approval "inbox-busy-agent-reply"): how long, in place of the count.
  const wait = rowWait(row.delivery);
  if (wait) return { short: <UndeliveredBadge wait={wait} now={now} />, long: <UndeliveredBadge wait={wait} now={now} full />, full: undeliveredLabel(wait.since, now) };
  // Settings → Rows' Status mark on a done row (the owner, 2026-11-07, q-8e0e9490): the tick alone says it, so none of
  // the words saying why a row is Quiet (Archived, Read, 👍 Looks good). Any other words stay.
  const why = !(tickAlone && rowStatus(row) === 'done');
  // A Quiet row says why it is there: archived (resolved), or marked read.
  if (why && inboxRowArchived(row)) return same('Archived');
  // What the person has not sent (approval "inbox-reply-drafts"): "Draft", and "Draft · Your reply, 2 picks" in full.
  if (row.unsent && inboxHasUnsent(row.unsent)) return { short: <DraftLabel unsent={row.unsent} short />, long: <DraftLabel unsent={row.unsent} />, full: `Draft · ${unsentWords(rowUnsent(row.unsent))}` };
  // Marked read with 👍 Looks good: the row says so in place of "Read".
  if (why && row.section === 'quiet' && (row.read_at ?? null) !== null && row.ack) return same(`👍 ${row.ack.label}`);
  if (why && row.section === 'quiet' && (row.read_at ?? null) !== null) return same('Read');
  // An older Inbox (no `unsent`): its own words.
  if (row.answered_not_sent) return { short: 'Answered', long: 'Answered, not sent', full: 'Answered, not sent' };
  // An agent the person started from New message (launch): one muted word while it starts or works.
  if (row.run) return same(row.run === 'starting' ? 'Starting' : row.run === 'cloning' ? 'Cloning' : 'Working');
  if (row.combining) return { short: <span className="ib-combining">Combining…</span>, long: <span className="ib-combining">Combining…</span>, full: 'Combining…' };
  if (row.section === 'sent' && row.addressee) return same(`To ${rowRecipient(row)}`);
  return null;
}

/** A group's count: its rows but those archived and waiting for the list to settle without them, as the sidebar counts. */
export function liveCount(rows: readonly InboxListRow[]): number {
  let n = 0;
  for (const row of rows) if (!inboxRowArchived(row)) n += 1;
  return n;
}

/**
 * The count in words (`countWords`), nothing when the count is `?N` or there is none. A three-line or phone row draws
 * the short form, its full words for a screen reader and, with `tip`, in the tooltip. A wide row (`wide`) draws the
 * full words in its words column; cut there, they are the tooltip too.
 */
export function CountWords({ row, tip = false, wide = false, status = false }: { row: InboxListRow; tip?: boolean; wide?: boolean; status?: boolean }) {
  const now = useMinuteClock(rowWait(row.delivery) !== null);
  const words = useContext(InArchivedGroup) && inboxRowArchived(row) ? null : countWords(row, now, status);
  if (!words) return null;
  const quiet = row.section === 'quiet' ? ' ib-qlabel' : '';
  if (wide) {
    return (
      <RowTip content={words.full} when={(cell) => cell.scrollWidth > cell.clientWidth + 0.5 || [...cell.querySelectorAll('.ib-cst, .ib-draft-l')].some((t) => t.scrollWidth > t.clientWidth + 0.5)}>
        <span className={`ib-c ib-cwords ib-cfull${quiet}`} data-count-words={words.full}>
          <span className="ib-cs">{typeof words.long === 'string' ? <span className="ib-cst">{words.long}</span> : words.long}</span>
        </span>
      </RowTip>
    );
  }
  const cell = (
    <span className={`ib-c ib-cwords${quiet}`} data-count-words={words.full}>
      <span className="ib-cs" aria-hidden="true">
        {typeof words.short === 'string' ? <span className="ib-cst">{words.short}</span> : words.short}
      </span>
      <span className="ib-sr">{words.full}</span>
    </span>
  );
  return tip ? <RowTip content={words.full}>{cell}</RowTip> : cell;
}

/** "Session ended": the session this row's thread would reach has ended (the server's `session_ended`; only a host that can tell). */
export function EndedMark({ row }: { row: InboxListRow }) {
  if (!row.session_ended) return <ScheduledBadge row={row} />;
  return (
    <span className="ib-gone ib-rended" data-row-ended="">
      Session ended
    </span>
  );
}

/**
 * The row's count (approval "inbox-row-byline", 2026-10-29): at the right end of a three-line or phone row's line 3.
 * What waits on the person is the action pill and `?N` (`OpenCounts`); anything else in words (`CountWords`).
 */
export function LineCount({ row, tip = false, status = false, card, open = false }: { row: InboxListRow; tip?: boolean; status?: boolean; card?: ReactNode; open?: boolean }) {
  return (
    <>
      <EndedMark row={row} />
      <CountWords row={row} tip={tip} status={status} />
      <OpenCounts row={row} tip={tip} status={status} card={card} open={open} />
    </>
  );
}

/**
 * What the row's marks draw (`OpenCounts`): both, from the row's open action items and questions, when the row has
 * no words (and Settings → Rows' Status mark is off); otherwise only the filled ones (a blocked row keeps its state).
 */
export function shownMarks(row: InboxListRow, status = false): RowMarks | null {
  const marks = rowMarks(row);
  if (!status && row.questions.open > 0 && countWords(row, 0) === null) return marks;
  const filled: RowMarks = {
    questions: marks.question === 'open' ? 0 : marks.questions,
    question: marks.question,
    actions: marks.action === 'open' ? 0 : marks.actions,
    action: marks.action,
  };
  return filled.questions > 0 || filled.actions > 0 ? filled : null;
}

/**
 * What a row's open counts (`OpenCounts`, Status mark off) draw, as a key: each mark's fill step and number, or ''
 * when it draws none. Two rows with the same key draw the same counts.
 */
export function openCountsKey(row: InboxListRow): string {
  const marks = shownMarks(row);
  if (!marks) return '';
  return `${marks.action}${marks.actions}/${marks.question}${marks.questions}`;
}

/**
 * What waits on the person (approvals "inbox-row-action-icon", 2026-10-29, and "inbox-question-mark", 2026-11-08):
 * the open action items' box (`ActionBadge`, A2), then the open questions' `?N` (`QuestionMark`), each in its fill
 * step. A row with words (a draft, Undelivered …) or Settings → Rows' Status mark draws its words or the status mark
 * instead, and keeps only a filled mark, before the status mark, so a blocked row always says so. The first filled
 * mark opens the row's card on keyboard focus (`open`), unless the wide row's words do (`open` false then).
 */
export function OpenCounts({ row, tip = false, status = false, card, open = false }: { row: InboxListRow; tip?: boolean; status?: boolean; card?: ReactNode; open?: boolean }) {
  const marks = shownMarks(row, status);
  const statusMark = status ? <StatusMark row={row} tip={tip} /> : null;
  if (!marks) return statusMark;
  // The card opens on the strongest filled mark, the question mark when both are as strong.
  const onQuestion = marks.questions > 0 && marks.question !== 'open' && (marks.actions < 1 || marks.action === 'open' || STEP_ORDER.indexOf(marks.question) >= STEP_ORDER.indexOf(marks.action));
  return (
    <>
      <ActionBadge row={row} marks={marks} tip={tip} card={card} open={open && !onQuestion} />
      <QuestionMark row={row} marks={marks} tip={tip} card={card} open={open && onQuestion} />
      {/* Settings → Rows' Status mark: one mark in place of the open counts, their words its name and tooltip. */}
      {statusMark}
    </>
  );
}

export const STEP_ORDER = ['open', 'hold', 'stop'] as const;

/**
 * One line of text the row may cut with "…": ui's tooltip shows it whole on
 * hover (`Tip`; the window's provider sets the delays), only while it is cut. Never a
 * focus stop, and nothing for a screen reader to add: the row's name already
 * holds the whole text.
 */
export function ClipText({ className, text }: { className: string; text: string }) {
  return (
    <RowTip content={text} cut>
      <span className={className} dir="auto">
        {text}
      </span>
    </RowTip>
  );
}

/**
 * A row and its quiet hover action: Mark read on a bold row that waits on the
 * person, Mark unread on a read row (markRead.ts `canMarkUnread`), shown on
 * hover or keyboard focus where the count and time are. It
 * never opens the thread. The action is the row's sibling (a button cannot
 * hold a button).
 */
export function RowWithAction({
  row,
  drawn,
  menu,
  onMarkRead,
  onMarkUnread,
  onSendNow,
  onUnarchive,
  children,
}: {
  row: InboxListRow;
  /** The group the row sits in on screen (markRead.ts `seenHeldInNew`). */
  drawn: InboxListGroupId;
  menu: boolean;
  onMarkRead?: (row: InboxListRow) => void;
  onMarkUnread?: (row: InboxListRow) => void;
  onSendNow?: (row: InboxListRow) => void;
  onUnarchive?: (row: InboxListRow) => void;
  children: ReactNode;
}) {
  // The action toggles (owner, 2026-10-31): on a read row (the row menu's rule, `canMarkUnread`) it is Mark unread.
  // That includes a row the person read that the list still holds in New (the thread open, or the one just left;
  // markRead.ts `seenHeldInNew`): the owner, 2026-11-02, "I opened it. I still want the ability to mark it unread."
  // And an opened row whose questions still wait (the owner, 2026-11-25). Mark read stays in the row menu and the header.
  const unread = !onUnarchive && onMarkUnread && canMarkUnread(row);
  const offer = !onUnarchive && !unread && onMarkRead && offersRowMarkRead(row, drawn);
  // A reply waiting on a busy agent that can take it now: Send now, on hover and keyboard focus as Mark read.
  const sendNow = onSendNow && !offer && !unread && row.delivery?.send_now === true && rowWait(row.delivery) !== null;
  // The action's tooltip mounts when the pointer or focus first comes into the row (RowTip.tsx), before the action
  // shows: a Tab moves focus onto it, and focus must never land on a trigger that is about to be drawn again.
  const [actionTip, setActionTip] = useState(false);
  return (
    <div
      className="ib-rw"
      data-row={row.thread_id}
      // Archived, waiting for the list to settle without it (approval "inbox-list-view", R7): faded in place.
      data-archived={inboxRowArchived(row) && drawn !== 'archived' ? '' : undefined}
      data-menu={menu ? '' : undefined}
      onPointerEnter={(event) => {
        if (!actionTip && opensTips(event)) setActionTip(true);
      }}
      onFocus={() => {
        if (!actionTip) setActionTip(true);
      }}
      onKeyDown={(event) => {
        // Tab from the row onto its action (focus fix 1): the action shows only while the row has keyboard focus,
        // and focus leaves the row before it reaches the action, so the browser's own Tab finds it gone and drops
        // focus on the page. The wrapper holds it shown (`data-action-focus`) while focus moves; Shift+Tab back is
        // the browser's.
        if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
        if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-thread-id]')) return;
        const wrapper = event.currentTarget;
        const action = wrapper.querySelector<HTMLElement>(':scope > .ib-ract');
        if (!action) return;
        event.preventDefault();
        wrapper.setAttribute('data-action-focus', '');
        action.addEventListener('blur', () => wrapper.removeAttribute('data-action-focus'), { once: true });
        action.focus();
        if (document.activeElement !== action) wrapper.removeAttribute('data-action-focus');
      }}
    >
      {children}
      {onUnarchive && <UnarchiveAction row={row} label={`Unarchive: ${rowLabel(row, titleOf(row))}`} onUnarchive={onUnarchive} />}
      {sendNow && (
        <RowTip armed={actionTip} content={`Send now: put your reply into ${rowRecipient(row)}'s running turn without waiting for it to end`}>
          <button
            type="button"
            className="ib-ract"
            data-row-send-now=""
            aria-label={`Send now: ${rowLabel(row, titleOf(row))}`}
            onClick={(event) => {
              event.stopPropagation();
              onSendNow(row);
            }}
          >
            <Icon name="send" size={15} />
            Send now
          </button>
        </RowTip>
      )}
      {offer && (
        <RowTip armed={actionTip} content={withShortcut(`Mark read / quiet: out of the top until ${rowRecipient(row)} writes again`, { scope: inboxThreadShortcuts, action: 'markRead' })}>
          <button
            type="button"
            className="ib-ract"
            data-row-mark-read=""
            aria-label={`Mark read: ${rowLabel(row, titleOf(row))}`}
            onClick={(event) => {
              event.stopPropagation();
              onMarkRead(row);
            }}
          >
            <Icon name="checkCircle" size={15} />
            Mark read
          </button>
        </RowTip>
      )}
      {unread && (
        <RowTip armed={actionTip} content="Mark unread: back to New, bold. Nothing is sent.">
          <button
            type="button"
            className="ib-ract"
            data-row-mark-unread=""
            aria-label={`Mark unread: ${rowLabel(row, titleOf(row))}`}
            onClick={(event) => {
              event.stopPropagation();
              onMarkUnread(row);
            }}
          >
            <Icon name="envelope" size={15} />
            Mark unread
          </button>
        </RowTip>
      )}
    </div>
  );
}
