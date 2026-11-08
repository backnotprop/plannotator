/**
 * What waits on the person at a list row's end, and the hover card of a row
 * that is blocked (approvals "inbox-row-badges", 2026-10-25, card A "Divided
 * card"; "inbox-question-mark", 2026-11-08, Take 3 "Fill steps").
 *
 *  - One question mark, `?N`, N the open questions (action items left out),
 *    and the action box, N the open action items. Each takes one of three
 *    fill steps (`WaitStep`), in today's theme colours: open, quiet and
 *    unfilled (the question mark) or the neutral pill (the action box);
 *    holding up work, the amber tint pill (`.ib-b-hold`); stopped on you, the
 *    red tint pill (`.ib-b-stop`). There is no separate triangle badge.
 *  - A mark's words are its visually hidden text and tooltip: "3 questions",
 *    "Holding up work: 5 questions", "Stopped on you: 1 action item". The face
 *    draws "99+", the words keep the exact count.
 *  - A filled mark's tooltip is the card (Halftone's Card `divided` on a
 *    Popover surface, in the Inbox's tokens): a header (the mark's glyph in
 *    its tint, "Stopped" / "Holds up N", the thread's name), one row per
 *    stopped reason or held-up item with a hairline between them, a question
 *    label (Q1, A1) only when the items come from more than one question, and
 *    a quiet footer with the agent's mark, its name and the time. It opens on
 *    the mark after the tooltip delay (ui's Tooltip through `Tip`) and while
 *    the row has keyboard focus; the row names the card's words through
 *    `aria-describedby` (`badgeDescription`).
 *  - A phone draws the marks alone, with no tooltip or card: the thread shows
 *    the details.
 *
 * What the card lists comes from the row's `waits` (the server's, one entry
 * per open question that stops the agent or holds something up). An older
 * Inbox sends none: the card then lists the row's merged `holds_up`.
 */
import type { ReactElement, ReactNode } from 'react';
import type { InboxListRow, InboxRowWait } from '@plannotator/core/inbox-types';
import { INBOX_SECTIONS } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '../format';
import { Icon } from '../icons';
import { Tip } from './Tip';
import { RowTip } from './RowTip';

/** The row is blocked on the person: Stopped on you or Holding up work (its marks fill, its card opens). */
export function rowHasBadge(row: InboxListRow): boolean {
  return row.section === 'stopped' || row.section === 'holding';
}

/** The card's title, and a wide row's words beside its marks: "Stopped", "Holds up 3". */
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
  // The header's glyph is the mark that carries the row's state: the question mark, or the action box when only an
  // action item stops or holds the work.
  const marks = rowMarks(row);
  const glyph = marks.questions > 0 && marks.question !== 'open' ? 'question' : marks.action !== 'open' ? 'action' : 'question';
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
        <span className="ib-wc-tri" data-wait-card-glyph={glyph}>
          {glyph === 'action' ? <Icon name="todoOpen" size={14} /> : <Icon name="questionBubble" size={14} className="ib-qbub" />}
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

/** The row's open action items: never more than its open count. */
export function rowActionCount(row: InboxListRow): number {
  return Math.max(0, Math.min(row.questions.actions ?? 0, row.questions.open));
}

/** Past this, a row's open counts draw "99+": both at full length would run out of their column. */
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
 * A mark's fill step (approval "inbox-question-mark", Take 3): `open` waits on the person and holds nothing up;
 * `hold` holds up work (the amber tint pill); `stop` stops the agent (the red tint pill).
 */
export type WaitStep = 'open' | 'hold' | 'stop';

const STEP_RANK: Record<WaitStep, number> = { open: 0, hold: 1, stop: 2 };
const higher = (a: WaitStep, b: WaitStep): WaitStep => (STEP_RANK[b] > STEP_RANK[a] ? b : a);

/** What the row's two marks draw: each one's number and fill step. A number under one draws no mark. */
export interface RowMarks {
  /** Open questions, action items left out. */
  questions: number;
  question: WaitStep;
  /** Open action items; with none open, those done in the reply draft and not sent that still stop or hold work. */
  actions: number;
  action: WaitStep;
}

/**
 * Each mark's step, from the row's `waits` (a question's or an action item's own `Stopped:` and `Holds up:`), so an
 * action item that holds up work fills the action box even when no question does. The row's state always shows on a
 * mark: when its `waits` do not carry it (an older Inbox sends none; they are capped; a Done or Can't do it still in
 * the reply draft keeps the agent stopped), it goes on the question mark, else on the action box.
 */
export function rowMarks(row: InboxListRow): RowMarks {
  let actions = rowActionCount(row);
  const questions = row.questions.open - actions;
  let question: WaitStep = 'open';
  let action: WaitStep = 'open';
  if (!rowHasBadge(row)) return { questions, question, actions, action };
  for (const w of row.waits ?? []) {
    const step: WaitStep = w.stopped !== null ? 'stop' : w.holds_up.length > 0 ? 'hold' : 'open';
    if (w.key.startsWith('a-')) action = higher(action, step);
    else question = higher(question, step);
  }
  const level: WaitStep = row.section === 'stopped' ? 'stop' : 'hold';
  if (STEP_RANK[higher(question, action)] < STEP_RANK[level]) {
    if (questions > 0) question = level;
    else {
      // Nothing open carries it: a staged Done or Can't do it (the reply not sent yet) is what stops the agent.
      if (actions < 1) actions = Math.max(1, row.questions.staged ?? 0);
      action = level;
    }
  }
  return { questions, question: questions > 0 ? question : 'open', actions, action: actions > 0 ? action : 'open' };
}

/** A filled step's words before the count: the section's own label, so the band and the mark say the same thing. */
function stepHead(step: WaitStep): string | null {
  if (step === 'open') return null;
  return INBOX_SECTIONS.find((s) => s.id === (step === 'stop' ? 'stopped' : 'holding'))!.label;
}

/** The question mark's words, its accessible name and tooltip: "3 questions", "Holding up work: 5 questions". */
export function questionMarkWords(n: number, step: WaitStep): string {
  const all = plural(n, 'question');
  const head = stepHead(step);
  return head ? `${head}: ${all}` : all;
}

/** The action box's words: "2 actions to do" (open, as before), "Stopped on you: 1 action item". */
export function actionMarkWords(n: number, step: WaitStep): string {
  const head = stepHead(step);
  return head ? `${head}: ${plural(n, 'action item')}` : actionCountWords(n);
}

/** A mark's tooltip: the card on a filled mark (`card`; it opens with the row's keyboard focus through `open`), else its words. */
function markTip(mark: ReactElement, words: string, step: WaitStep, tip: boolean, card: ReactNode | undefined, open: boolean): ReactNode {
  if (!tip) return mark;
  if (step !== 'open' && card) {
    return (
      <Tip content={card} open={open}>
        {mark}
      </Tip>
    );
  }
  return <RowTip content={words}>{mark}</RowTip>;
}

/**
 * The open questions' mark, `?N` (approval "inbox-row-action-icon", Q3; "inbox-question-mark"): a speech bubble with
 * a "?" (Lucide's message-circle-question-mark) right next to its number. Open, it is quiet text with no pill, as
 * before; holding up work or stopped, the same face in today's amber or red tint pill. Its words for a screen reader
 * and in the tooltip; a filled mark's tooltip is the row's card. Nothing under one open question.
 */
export function QuestionMark({ row, marks = rowMarks(row), tip = false, card, open = false }: { row: InboxListRow; marks?: RowMarks; tip?: boolean; card?: ReactNode; open?: boolean }) {
  const n = marks.questions;
  if (n < 1) return null;
  const step = marks.question;
  const words = questionMarkWords(n, step);
  const mark = (
    <span className={step === 'open' ? 'ib-c ib-qn' : `ib-badge ib-bicon ib-qn ib-b-${step}`} data-open-count={n} data-wait-step={step}>
      <Icon name="questionBubble" size={14} className="ib-qbub" />
      <span className="ib-bn" aria-hidden="true">
        {shownCount(n)}
      </span>
      {/* Spaced, so the row's name never runs it into the words beside it. */}
      <span className="ib-sr">{` ${words} `}</span>
    </span>
  );
  return markTip(mark, words, step, tip, card, open);
}

/**
 * The open action items' box (approval "inbox-row-action-icon", A2 "Empty box", 2026-10-29; "inbox-question-mark"):
 * the action checklist card's box with its tick taken out ("still to do") and the number, in a pill of the badge's
 * shape. Open, a neutral fill and the text colour, as before; holding up work or stopped, today's amber or red tint
 * pill, so a thread stopped only by an action item says so here. Its words ("2 actions to do", "Stopped on you: 1
 * action item") are visually hidden text and, with `tip`, the tooltip (a filled box's is the row's card; a phone has
 * none). Nothing when no action item is open.
 */
export function ActionBadge({ row, marks = rowMarks(row), tip = false, card, open = false }: { row: InboxListRow; marks?: RowMarks; tip?: boolean; card?: ReactNode; open?: boolean }) {
  const n = marks.actions;
  if (n < 1) return null;
  const step = marks.action;
  const words = actionMarkWords(n, step);
  const badge = (
    <span className={`ib-badge ib-bicon ${step === 'open' ? 'ib-b-act' : `ib-b-actstep ib-b-${step}`}`} data-action-count={n} data-wait-step={step}>
      <Icon name="todoOpen" size={14} />
      <span className="ib-bn" aria-hidden="true">
        {shownCount(n)}
      </span>
      {/* Spaced, so the row's name never runs it into the badge's words or the question count's. */}
      <span className="ib-sr">{` ${words} `}</span>
    </span>
  );
  return markTip(badge, words, step, tip, card, open);
}

/**
 * A wide row's words for a blocked row (the owner's call of 2026-10-29: the full words in full-width mode, a list of
 * 1150 px or more), "Stopped" or "Holds up 3", in the badge's text colour, beside the marks. Whether they stay with
 * the question mark is still open with the owner (approval "inbox-question-mark", Q2): true keeps them; false leaves
 * them to the marks' tooltips, the card and the row's accessible name.
 */
export const WIDE_ROW_WAIT_WORDS = true;

/** The words (`WIDE_ROW_WAIT_WORDS`), or nothing. `card`: hovering them opens the row's card too, as the marks do. */
export function WaitWords({ row, card, open = false }: { row: InboxListRow; card?: ReactNode; open?: boolean }) {
  const words = WIDE_ROW_WAIT_WORDS ? badgeWords(row) : null;
  if (!words) return null;
  const stopped = row.section === 'stopped';
  // Visual only: the marks' words and the row's description already say it to a screen reader.
  const cell = (
    <span className={`ib-bwords ${stopped ? 'ib-bw-stop' : 'ib-bw-hold'}`} data-wait-words={stopped ? 'stopped' : 'holds'} aria-hidden="true">
      {words}
    </span>
  );
  if (!card) return cell;
  return (
    <Tip content={card} open={open}>
      {cell}
    </Tip>
  );
}
