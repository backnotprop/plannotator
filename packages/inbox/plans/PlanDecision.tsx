/**
 * The plan's decision as one mark at the right of the page's bar (the owner, 26 Nov: "It could probably just be an
 * icon over to the right or something. With a hover card or click card"). The mark is the decision's own glyph, the
 * one the page's other decision marks use: a check in a circle in the success colour (approved), the reply arrow in
 * the warning colour (changes asked), a quiet circle with a dash (no decision yet, or an approval that did not carry
 * over; the other marks' clock would sit beside the Versions clock).
 *
 * Resting the pointer or keyboard focus on it shows a small card; a press pins the card (ui's Popover, as the review's
 * semantic badge: Base UI opens it on hover and keeps it on a press), and Escape, a press outside or a second press
 * closes it. The card says what the bar's sentence said, in the page's own words: the decision's line, the version it
 * is on and when (as the Versions rows write them), and "Your approval moved to v4." with its Dismiss while that
 * notice stands. The mark's name is the decision's line, so a screen reader hears the state on the button.
 */
import { useEffect, useRef, useState } from 'react';
import { planDecisionVersion, type PlanApprovalState, type PlanDecision } from '@plannotator/core/plans';
import { Popover, PopoverContent, PopoverTrigger } from '@plannotator/ui/components/Popover';
import { REF_CARD_CLOSE_MS, REF_CARD_DELAY_MS } from '@plannotator/ui/components/RefHoverCard';
import { whenWords } from '@plannotator/ui/components/frame';
import { Icon, type IconName } from '../icons';
import { approvalTone, approvalWords, type PlanDecisionTone } from './words';
import { DecisionMark } from './parts';

/** What the mark and its card say. */
export interface PlanDecisionInfo {
  tone: PlanDecisionTone;
  /** The decision's line ("Approved by you, with notes", "Changes asked", "No decision on v4"); the mark's name. */
  words: string;
  /** The version the decision is on, and when it was given (null: none was given on it). */
  version: number;
  at: string | null;
  /** "Your approval moved to v4." while it stands, and its Dismiss. */
  moved: { words: string; dismiss: () => void } | null;
}

/** The mark's glyph per tone (see the file's head). */
export const PLAN_DECISION_GLYPH: Record<PlanDecisionTone, IconName> = { approved: 'checkCircle', changes: 'reply', none: 'minus' };

/**
 * The decision on the newest version of `docId`, in the page's words: `approvedBy` is the approval's own line (PlanEditing's
 * `approvedByLine`), the cleared approval's line is `cleared`'s, the rest are the plan's few words (`approvalWords`).
 */
export function planDecisionInfo(o: { state: PlanApprovalState; head: number; decisions: readonly PlanDecision[]; docId: string; approvedBy: string | null; cleared: string | null; moved: PlanDecisionInfo['moved'] }): PlanDecisionInfo {
  const { state } = o;
  const words = state.kind === 'approved' && o.approvedBy ? o.approvedBy : state.kind === 'cleared' && o.cleared ? o.cleared : approvalWords(state);
  const given = state.kind === 'approved' || state.kind === 'changes';
  const on = given ? o.decisions.filter((d) => d.document_id === o.docId && planDecisionVersion(d) === o.head).sort((a, b) => a.at.localeCompare(b.at)) : [];
  return { tone: approvalTone(state), words, version: o.head, at: on[on.length - 1]?.at ?? null, moved: state.kind === 'approved' ? o.moved : null };
}

/** How long after a card closes focus landing on the mark is the card handing it back (Base UI's return focus). */
const PLAN_DECISION_RETURN_MS = 500;

const fullDate = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export function PlanDecisionMark({ info, phone }: { info: PlanDecisionInfo; phone?: boolean }) {
  const [open, setOpen] = useState(false);
  /** How it opened: keyboard focus (closes when focus leaves), else the trigger's own hover or press. */
  const via = useRef<'focus' | 'other' | null>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const card = useRef<HTMLDivElement | null>(null);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  /** When a card closed with focus in it or on the mark: focus coming back to the mark then is not a new arrival. */
  const closedAt = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => () => clearTimeout(focusTimer.current), []);
  const change = (next: boolean, details: { reason?: string }) => {
    clearTimeout(focusTimer.current);
    // A press on a card that keyboard focus opened pins it, as a press on a hovered one does.
    if (!next && via.current === 'focus' && details.reason === 'trigger-press') {
      via.current = 'other';
      return;
    }
    const active = document.activeElement;
    if (!next && active && (active === button || card.current?.contains(active))) closedAt.current = performance.now();
    via.current = next ? 'other' : null;
    setOpen(next);
  };
  // The notice goes, and its Dismiss with it: focus goes to the mark first, and the card stays with what is left.
  const dismiss = () => {
    button?.focus({ preventScroll: true });
    info.moved?.dismiss();
  };
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger
        openOnHover
        delay={REF_CARD_DELAY_MS}
        closeDelay={REF_CARD_CLOSE_MS}
        render={
          <button
            ref={setButton}
            type="button"
            className="ib-iconbtn ib-plan-mark ib-plan-decision"
            aria-label={info.words}
            data-tone={info.tone}
            data-plan-decision-mark={info.tone}
            data-phone={phone ? '' : undefined}
            onFocus={(event) => {
              // Escape or a press outside closed it: focus handed back to the mark does not open it again.
              const back = performance.now() - closedAt.current < PLAN_DECISION_RETURN_MS;
              closedAt.current = Number.NEGATIVE_INFINITY;
              if (back || open || !event.currentTarget.matches(':focus-visible')) return;
              clearTimeout(focusTimer.current);
              focusTimer.current = setTimeout(() => {
                via.current = 'focus';
                setOpen(true);
              }, REF_CARD_DELAY_MS);
            }}
            onBlur={(event) => {
              clearTimeout(focusTimer.current);
              // Tab from the mark passes Base UI's focus guard on its way into the card; Shift+Tab, and Tab out of the
              // card's far end, pass a guard too, and Base UI closes the card and moves focus on itself.
              const to = event.relatedTarget;
              if (via.current !== 'focus' || (to instanceof Element && (card.current?.contains(to) || to.hasAttribute('data-base-ui-focus-guard')))) return;
              via.current = null;
              setOpen(false);
            }}
          />
        }
      >
        <Icon name={PLAN_DECISION_GLYPH[info.tone]} size={16} />
      </PopoverTrigger>
      <PopoverContent ref={card} side="bottom" align="end" sideOffset={6} collisionPadding={8} container={button?.closest<HTMLElement>('.pn-inbox') ?? undefined} initialFocus={(type) => type === 'keyboard'} aria-label={info.words} className="ib-plan-dcard" data-plan-decision-card="" data-phone={phone ? '' : undefined}>
        <p className="ib-plan-dcard-line">
          <DecisionMark tone={info.tone} />
          <span>{info.words}</span>
        </p>
        {info.at && (
          <p className="ib-plan-dcard-when" data-plan-decision-when="">
            <b>v{info.version}</b>
            <time dateTime={info.at} title={fullDate(info.at)}>
              {whenWords(info.at)}
            </time>
          </p>
        )}
        {info.moved && (
          <p className="ib-plan-dcard-moved" data-plan-approval="moved">
            <span>{info.moved.words}</span>
            <button type="button" className="ib-plans-quiet ib-plan-approval-x" aria-label="Dismiss" onClick={dismiss} data-plan-approval-dismiss="">
              <Icon name="x" />
            </button>
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
