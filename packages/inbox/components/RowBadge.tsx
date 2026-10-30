/**
 * The list row's Stopped and Holds up badges and their hover card (approval
 * "inbox-row-badges", 2026-10-25: "Both as icons", card A "Divided card").
 *
 *  - Stopped is a red triangle alone, Holds up an amber triangle and its count,
 *    in today's badge tints. The words stay as the badge's text for assistive
 *    technology ("Stopped", "Holds up 3"), visually hidden.
 *  - The card (Halftone's Card `divided` on a Popover surface, in the Inbox's
 *    tokens): a header (the triangle in the badge's tint, "Stopped" / "Holds up
 *    N", the thread's name), one row per stopped reason or held-up item with a
 *    hairline between them, a question label (Q1, A1) only when the items come
 *    from more than one question, and a quiet footer with the agent's mark, its
 *    name and the time. It opens on the badge after the tooltip delay (ui's
 *    Tooltip through `Tip`) and while the row has keyboard focus; the row
 *    names the card's words through `aria-describedby` (`badgeDescription`).
 *  - A phone draws the icons only, with no card: the thread shows the details.
 *
 * What the card lists comes from the row's `waits` (the server's, one entry
 * per open question that stops the agent or holds something up). An older
 * Inbox sends none: the card then lists the row's merged `holds_up`.
 */
import type { ReactNode } from 'react';
import type { InboxListRow, InboxRowWait } from '@plannotator/core/inbox-types';
import { formatCount } from '../format';
import { Icon } from '../icons';
import { Tip } from './Tip';

/** Heroicons' exclamation-triangle, outline (MIT), drawn in the badge's own colour. */
export function TriangleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg className="ib-tri" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
    </svg>
  );
}

/** The row carries a badge: Stopped on you or Holding up work. */
export function rowHasBadge(row: InboxListRow): boolean {
  return row.section === 'stopped' || row.section === 'holding';
}

/** The badge's words, as a screen reader reads them: "Stopped", "Holds up 3". */
export function badgeWords(row: InboxListRow): string | null {
  if (row.section === 'stopped') return 'Stopped';
  if (row.section === 'holding') return `Holds up ${row.questions.holds_up.length}`;
  return null;
}

/** "the admin retry view." → "The admin retry view" */
export function tidyWaitText(text: string): string {
  const t = text.trim().replace(/[.;,]+$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export interface WaitItem {
  /** "Q1", "A2", "Q1, Q2" (a name two questions hold up): only when the card's items come from more than one question. */
  label: string | null;
  text: string;
}

export interface WaitCardModel {
  kind: 'stop' | 'hold';
  title: string;
  /** Stopped: the reasons; Holds up: the held-up items. */
  lead: WaitItem[];
  /** Stopped only: what it also holds up. */
  also: WaitItem[];
  /** How many items `also` holds before the card's cut. */
  alsoTotal: number;
  /** Items left out past the card's five lines. */
  more: number;
}

/** The card shows at most this many item lines; the rest are "+N more". */
export const WAIT_CARD_LINES = 5;

/** Each wait's label: Q (or A for an action item) and its place in its message, unless two would read alike. */
function labelsOf(waits: readonly InboxRowWait[]): string[] {
  const own = waits.map((w) => `${w.key.startsWith('a-') ? 'A' : 'Q'}${w.position + 1}`);
  // Two messages' first questions are both "Q1": number the card's questions in order instead.
  if (new Set(own).size === own.length) return own;
  let q = 0;
  let a = 0;
  return waits.map((w) => (w.key.startsWith('a-') ? `A${++a}` : `Q${++q}`));
}

/** One line of the card while it is being built: the questions it comes from (indexes into `waits`). */
interface Gathered {
  raw: string;
  text: string;
  from: number[];
}

/**
 * Adds an entry, or the question to an entry already there with the same
 * words: the badge counts names once across questions (`summarizeInboxQuestions`
 * de-duplicates `holds_up` by its exact text), so the card lists each name once
 * too, with every question it comes from ("Q1, Q2").
 */
function gather(into: Gathered[], raw: string, from: number): void {
  const same = into.find((g) => g.raw === raw);
  if (same) {
    if (from >= 0 && !same.from.includes(from)) same.from.push(from);
    return;
  }
  into.push({ raw, text: tidyWaitText(raw), from: from >= 0 ? [from] : [] });
}

/** What the card lists, decided once for the card and its words for a screen reader. */
export function waitCardModel(row: InboxListRow): WaitCardModel | null {
  if (!rowHasBadge(row)) return null;
  const waits = row.waits ?? [];
  const labels = labelsOf(waits);
  const stops: Gathered[] = [];
  const holds: Gathered[] = [];
  waits.forEach((w, i) => {
    if (w.stopped) gather(stops, w.stopped, i);
    for (const h of w.holds_up) gather(holds, h, i);
  });
  // An older Inbox (no `waits`): the row's merged hold-ups, from no question in particular.
  if (waits.length === 0) for (const h of row.questions.holds_up) gather(holds, h, -1);
  const stopped = row.section === 'stopped';
  const lead = stopped ? stops : holds;
  const also = stopped ? holds : [];
  // Name the questions only when the items come from more than one.
  const named = new Set([...lead, ...also].flatMap((i) => i.from)).size > 1;
  const strip = (items: Gathered[]): WaitItem[] =>
    items.map((i) => ({ label: named && i.from.length > 0 ? i.from.map((f) => labels[f]!).join(', ') : null, text: i.text }));
  const leadShown = strip(lead.slice(0, WAIT_CARD_LINES));
  const alsoShown = strip(also.slice(0, Math.max(0, WAIT_CARD_LINES - leadShown.length)));
  return {
    kind: stopped ? 'stop' : 'hold',
    title: badgeWords(row)!,
    lead: leadShown,
    also: alsoShown,
    alsoTotal: also.length,
    more: lead.length - leadShown.length + (also.length - alsoShown.length),
  };
}

/** The words for a stopped row that names no reason (an older Inbox, or a `Stopped:` the agent left empty). */
export const STOPPED_FALLBACK = 'The agent cannot go on until you answer';

/** The card's words as one sentence each, for the row's `aria-describedby`: the row's name stays short. */
export function badgeDescription(row: InboxListRow): string {
  const model = waitCardModel(row);
  if (!model) return '';
  const all = (items: WaitItem[]) => items.map((i) => i.text).join('; ');
  const more = model.more > 0 ? ` And ${model.more} more.` : '';
  if (model.kind === 'stop') {
    const why = model.lead.length > 0 ? all(model.lead) : STOPPED_FALLBACK;
    const also = model.also.length > 0 ? ` Also holds up: ${all(model.also)}.` : '';
    return `Stopped: ${why}.${also}${more}`;
  }
  return `Holds up: ${all(model.lead)}.${more}`;
}

/** Card A: the divided card. */
export function WaitCard({ row, agent, mark, time }: { row: InboxListRow; agent: string; mark: ReactNode; time: string }) {
  const model = waitCardModel(row);
  if (!model) return null;
  const line = (item: WaitItem, key: string) => (
    <div key={key} className="ib-wc-row">
      {item.label && <span className="ib-wc-q">{item.label}</span>}
      <span className="ib-wc-t" dir="auto">
        {item.text}
      </span>
    </div>
  );
  return (
    <div className={`ib-wcard ib-wc-${model.kind}`} data-wait-card={model.kind}>
      <div className="ib-wc-head">
        <span className="ib-wc-tri">
          <TriangleIcon />
        </span>
        <span className="ib-wc-h">{model.title}</span>
        {row.thread_name && (
          <span className="ib-wc-chip" dir="auto">
            {row.thread_name}
          </span>
        )}
      </div>
      {model.kind === 'stop' && model.lead.length === 0 && line({ label: null, text: STOPPED_FALLBACK }, 'fallback')}
      {model.lead.map((item, i) => line(item, `l${i}`))}
      {model.also.length > 0 && <div className="ib-wc-sub">Also holds up {model.alsoTotal}</div>}
      {model.also.map((item, i) => line(item, `a${i}`))}
      {model.more > 0 && <div className="ib-wc-row ib-wc-more">+{model.more} more</div>}
      <div className="ib-wc-foot">
        {mark}
        <span className="ib-wc-agent">{agent}</span>
        <span aria-hidden="true">·</span>
        <span>{time}</span>
      </div>
    </div>
  );
}

/**
 * The badge. `card` (the wide and three-line rows): the hover card, opened on
 * hover and, through `open`, while the row has keyboard focus. Without it (a
 * phone) the icons only. `words` (a wide row, the owner's call of 2026-10-29: the
 * full words in full-width mode): the triangle, then the badge's own words as
 * they read before approval "inbox-row-badges", "Stopped" and "Holds up 3".
 */
export function RowBadge({ row, card, open = false, words: shown = false }: { row: InboxListRow; card?: ReactNode; open?: boolean; words?: boolean }) {
  const words = badgeWords(row);
  if (!words) return null;
  const stopped = row.section === 'stopped';
  const label = shown ? 'ib-bw' : 'ib-sr';
  const badge = (
    <span className={`ib-badge ib-bicon${shown ? ' ib-bwords' : ''} ${stopped ? 'ib-b-stop' : 'ib-b-hold'}`} data-row-badge={stopped ? 'stopped' : 'holds'}>
      <TriangleIcon />
      {stopped ? (
        <span className={label}>Stopped</span>
      ) : shown ? (
        <span className="ib-bw">
          Holds up <span className="ib-bn">{row.questions.holds_up.length}</span>
        </span>
      ) : (
        <>
          <span className="ib-sr">Holds up </span>
          <span className="ib-bn">{row.questions.holds_up.length}</span>
        </>
      )}
    </span>
  );
  if (!card) return badge;
  return (
    <Tip content={card} open={open}>
      {badge}
    </Tip>
  );
}

/** The row's open action items: never more than its open count. */
export function rowActionCount(row: InboxListRow): number {
  return Math.max(0, Math.min(row.questions.actions ?? 0, row.questions.open));
}

/** Past this, a row's open counts draw "99+": both at full length would run out of their column over the badge. */
export const SHOWN_COUNT_MAX = 99;

/** The number a row's open count draws: "12", or "99+" past 99. The exact count stays in its words and tooltip. */
export function shownCount(n: number): string {
  return n > SHOWN_COUNT_MAX ? `${SHOWN_COUNT_MAX}+` : formatCount(n);
}

/** The action count's words, its accessible name and tooltip: "1 action to do", "2 actions to do". */
export function actionCountWords(n: number): string {
  return `${formatCount(n)} action${n === 1 ? '' : 's'} to do`;
}

/**
 * The open action items' count (approval "inbox-row-action-icon", A2 "Empty box", 2026-10-29): the action
 * checklist card's box with its tick taken out ("still to do") and the number, in a pill of the alert badge's
 * shape with a neutral fill and the text colour. One step under the red and amber badge, one over the quiet
 * question count beside it. Its words ("2 actions to do") are visually hidden text and, with `tip`, the
 * tooltip (a phone has none). Nothing when no action item is open.
 */
export function ActionBadge({ row, tip = false }: { row: InboxListRow; tip?: boolean }) {
  const n = rowActionCount(row);
  if (n < 1) return null;
  const words = actionCountWords(n);
  const badge = (
    <span className="ib-badge ib-bicon ib-b-act" data-action-count={n}>
      <Icon name="todoOpen" size={14} />
      <span className="ib-bn" aria-hidden="true">
        {shownCount(n)}
      </span>
      {/* Spaced, so the row's name never runs it into the badge's words or the question count's. */}
      <span className="ib-sr">{` ${words} `}</span>
    </span>
  );
  return tip ? <Tip content={words}>{badge}</Tip> : badge;
}
