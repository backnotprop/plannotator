/**
 * The plan page's bar (approval "inbox-plan-header-icons-a2-p2-g1", A2, on the pinned bar of
 * "inbox-plan-page-header-a3"): marks, not words, and no version text while the newest version is read.
 *
 * - The newest version: nothing on the left (the owner, 26 Nov: the approval "should just appear on the right as an
 *   icon"); at the end Approve while it is offered (or Done and Cancel while editing), the decision's mark
 *   (PlanDecision.tsx), a pencil (Edit), a history clock (Versions) and the page's menu. The clock's tooltip names the
 *   version ("Versions · v4, newest"); it reads expanded while Versions is open.
 * - An older version: one line, "v2 of 4, an older version", Back to version 4 and Restore v2; then the decision's
 *   mark and the clock; no pencil (an older version is never edited).
 *
 * The marks are the Inbox's own stand-ins (`PLAN_BAR_MARKS`, ui's inbox-thread icons): the approval asks for Pierre's
 * set (`@pierre/icons`: IconPencil, IconClockArrow, IconCheckCircle), which is not a dependency of this repository
 * yet. Swapping them is a change to this one map and PlanDecision's.
 */
import type { ReactElement, ReactNode } from 'react';
import { FrameButton } from '@plannotator/ui/components/frame';
import { Icon, type IconName } from '../icons';
import { Tip } from '../components/Tip';

export const PLAN_BAR_MARKS: { edit: IconName; versions: IconName } = { edit: 'pen', versions: 'clock' };

/** The clock's name and tooltip: "Versions · v4, newest" on the newest version, "Versions" on any other. */
export function versionsMarkName(shown: number, head: number): string {
  return shown === head ? `Versions · v${shown}, newest` : 'Versions';
}

/** The history clock: opens and closes Versions, expanded while they are open. */
export function PlanVersionsMark({ shown, head, open, onToggle, phone }: { shown: number; head: number; open: boolean; onToggle: (open: boolean) => void; phone?: boolean }) {
  const name = versionsMarkName(shown, head);
  return (
    <Tip content={name} side="bottom" align="end">
      <button type="button" className="ib-iconbtn ib-plan-mark" aria-label={name} aria-expanded={open} onClick={() => onToggle(!open)} data-reading-versions="" data-phone={phone ? '' : undefined}>
        <Icon name={PLAN_BAR_MARKS.versions} size={16} />
      </button>
    </Tip>
  );
}

/** The pencil: starts editing the newest version; it waits (disabled) while an edit, a Restore or an Approve is under way. */
export function PlanEditMark({ onEdit, busy }: { onEdit: () => void; busy?: boolean }) {
  return (
    <Tip content="Edit" side="bottom">
      <button type="button" className="ib-iconbtn ib-plan-mark" aria-label="Edit" onClick={onEdit} disabled={busy} data-plan-edit="">
        <Icon name={PLAN_BAR_MARKS.edit} size={16} />
      </button>
    </Tip>
  );
}

export interface PlanBarProps {
  shown: number;
  head: number;
  /** Approve, or Done and Cancel while editing (at the end, before the marks). */
  start: ReactNode;
  /** The decision's mark (PlanDecision.tsx). */
  decision: ReactNode;
  /** Starts editing; null when there is nothing to edit (an older version, a diagram, an edit open). */
  edit: (() => void) | null;
  /** An edit, a Restore or an Approve is under way. */
  busy?: boolean;
  /** An older version on screen: the way back to the newest, and its Restore. */
  older: { back: ReactElement; restore: ReactNode } | null;
  versionsOpen: boolean;
  onVersions: (open: boolean) => void;
  /** The page's menu (⋯), at the end. */
  menu: ReactNode;
  phone?: boolean;
}

/** The pinned bar at the page card's top (a computer; a phone off its main page's newest version). */
export function PlanBar({ shown, head, start, decision, edit, busy, older, versionsOpen, onVersions, menu, phone }: PlanBarProps) {
  return (
    <div className="ib-plan-bar" data-plan-bar={older ? 'older' : 'newest'} data-reading-line={older ? 'older' : 'newest'} data-older-version-bar={older ? '' : undefined}>
      <div className="ib-plan-bar-start">
        {older && (
          <>
            <span role="status" className="ib-plan-bar-older" data-plan-older-words="">
              <b>v{shown}</b> of {head}, an older version
            </span>
            <FrameButton variant="outline" size="xs" className="shrink-0" nativeButton={false} render={older.back}>
              Back to version {head}
            </FrameButton>
            {older.restore}
          </>
        )}
      </div>
      <div className="ib-plan-bar-end">
        {!older && start}
        {decision}
        {!older && edit && <PlanEditMark onEdit={edit} busy={busy} />}
        <PlanVersionsMark shown={shown} head={head} open={versionsOpen} onToggle={onVersions} phone={phone} />
        {menu}
      </div>
    </div>
  );
}
