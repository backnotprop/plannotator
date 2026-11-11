import type { ReactElement, ReactNode } from 'react';
import type { InboxListRow, InboxRowWait } from '@plannotator/core/inbox-types';
import { INBOX_SECTIONS } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '../format';
import { Icon } from '../icons';
import { Tip } from './Tip';
import { RowTip } from './RowTip';

export function rowHasBadge(row: InboxListRow): boolean {
  return row.section === 'stopped' || row.section === 'holding';
}

export function badgeWords(row: InboxListRow): string | null {
  if (row.section === 'stopped') return 'Stopped';
  if (row.section === 'holding') return `Holds up ${row.questions.holds_up.length}`;
  return null;
}

export function tidyWaitText(text: string): string {
  const t = text.trim().replace(/[.;,]+$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export interface WaitItem {
  label: string | null;
  text: string;
}

export interface WaitCardModel {
  kind: 'stop' | 'hold';
  title: string;
  lead: WaitItem[];
  also: WaitItem[];
  alsoTotal: number;
  more: number;
}

export const WAIT_CARD_LINES = 5;

function labelsOf(waits: readonly InboxRowWait[]): string[] {
  const own = waits.map((w) => `${w.key.startsWith('a-') ? 'A' : 'Q'}${w.position + 1}`);
  if (new Set(own).size === own.length) return own;
  let q = 0;
  let a = 0;
  return waits.map((w) => (w.key.startsWith('a-') ? `A${++a}` : `Q${++q}`));
}

interface Gathered {
  raw: string;
  text: string;
  from: number[];
}

function gather(into: Gathered[], raw: string, from: number): void {
  const same = into.find((g) => g.raw === raw);
  if (same) {
    if (from >= 0 && !same.from.includes(from)) same.from.push(from);
    return;
  }
  into.push({ raw, text: tidyWaitText(raw), from: from >= 0 ? [from] : [] });
}

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
  if (waits.length === 0) for (const h of row.questions.holds_up) gather(holds, h, -1);
  const stopped = row.section === 'stopped';
  const lead = stopped ? stops : holds;
  const also = stopped ? holds : [];
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

export const STOPPED_FALLBACK = 'The agent cannot go on until you answer';

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

export function WaitCard({ row, agent, mark, time }: { row: InboxListRow; agent: string; mark: ReactNode; time: string }) {
  const model = waitCardModel(row);
  if (!model) return null;
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

export function rowActionCount(row: InboxListRow): number {
  return Math.max(0, Math.min(row.questions.actions ?? 0, row.questions.open));
}

export const SHOWN_COUNT_MAX = 99;

export function shownCount(n: number): string {
  return n > SHOWN_COUNT_MAX ? `${SHOWN_COUNT_MAX}+` : formatCount(n);
}

export function actionCountWords(n: number): string {
  return `${formatCount(n)} action${n === 1 ? '' : 's'} to do`;
}

export type WaitStep = 'open' | 'hold' | 'stop';

const STEP_RANK: Record<WaitStep, number> = { open: 0, hold: 1, stop: 2 };
const higher = (a: WaitStep, b: WaitStep): WaitStep => (STEP_RANK[b] > STEP_RANK[a] ? b : a);

export interface RowMarks {
  questions: number;
  question: WaitStep;
  actions: number;
  action: WaitStep;
}

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
      if (actions < 1) actions = Math.max(1, row.questions.staged ?? 0);
      action = level;
    }
  }
  return { questions, question: questions > 0 ? question : 'open', actions, action: actions > 0 ? action : 'open' };
}

function stepHead(step: WaitStep): string | null {
  if (step === 'open') return null;
  return INBOX_SECTIONS.find((s) => s.id === (step === 'stop' ? 'stopped' : 'holding'))!.label;
}

export function questionMarkWords(n: number, step: WaitStep): string {
  const all = plural(n, 'question');
  const head = stepHead(step);
  return head ? `${head}: ${all}` : all;
}

export function actionMarkWords(n: number, step: WaitStep): string {
  const head = stepHead(step);
  return head ? `${head}: ${plural(n, 'action item')}` : actionCountWords(n);
}

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

export const WIDE_ROW_WAIT_WORDS = true;

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
