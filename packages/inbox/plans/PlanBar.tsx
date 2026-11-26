/**
 * The plan page's bar (approval "inbox-plan-header-icons-a2-p2-g1", A2, on the pinned bar of
 * "inbox-plan-page-header-a3"): marks, not words, and no version text while the newest version is read.
 *
 * - The newest version: Approve when it is offered (or Done and Cancel while editing) and the approval's words on the
 *   left; a pencil (Edit), a history clock (Versions) and the page's menu at the end. The clock's tooltip names the
 *   version ("Versions · v4, newest"); it reads pressed while Versions is open.
 * - An older version: one line, "v2 of 4, an older version", Back to version 4 and Restore v2; no pencil (an older
 *   version is never edited).
 *
 * The marks are the Inbox's own stand-ins (`PLAN_BAR_MARKS`): the approval asks for Pierre's set (`@pierre/icons`),
 * which is not a dependency of this repository yet. Swapping them is a change to this one map.
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

/** The history clock: opens and closes Versions, pressed while they are open. */
export function PlanVersionsMark({ shown, head, open, onToggle, phone }: { shown: number; head: number; open: boolean; onToggle: (open: boolean) => void; phone?: boolean }) {
  const name = versionsMarkName(shown, head);
  return (
    <Tip content={name} side="bottom" align="end">
      <button type="button" className="ib-iconbtn ib-plan-mark" aria-label={name} aria-expanded={open} aria-pressed={open} onClick={() => onToggle(!open)} data-reading-versions="" data-phone={phone ? '' : undefined}>
        <Icon name={PLAN_BAR_MARKS.versions} size={phone ? 18 : 16} />
      </button>
    </Tip>
  );
}

/** The pencil: starts editing the newest version. */
export function PlanEditMark({ onEdit }: { onEdit: () => void }) {
  return (
    <Tip content="Edit" side="bottom">
      <button type="button" className="ib-iconbtn ib-plan-mark" aria-label="Edit" onClick={onEdit} data-plan-edit="">
        <Icon name={PLAN_BAR_MARKS.edit} size={16} />
      </button>
    </Tip>
  );
}

export interface PlanBarProps {
  shown: number;
  head: number;
  /** The left of the line on the newest version: Approve, or Done and Cancel (the editing's start without Edit). */
  start: ReactNode;
  /** The approval's words (null: none on screen). */
  approved: ReactNode;
  /** Starts editing; null when there is nothing to edit (an older version, a diagram, an edit open). */
  edit: (() => void) | null;
  /** An older version on screen: the way back to the newest, and its Restore. */
  older: { back: ReactElement; restore: ReactNode } | null;
  versionsOpen: boolean;
  onVersions: (open: boolean) => void;
  /** The page's menu (⋯), at the end. */
  menu: ReactNode;
  phone?: boolean;
}

/** The pinned bar at the page card's top (a computer; a phone off its main page's newest version). */
export function PlanBar({ shown, head, start, approved, edit, older, versionsOpen, onVersions, menu, phone }: PlanBarProps) {
  return (
    <div className="ib-plan-bar" data-plan-bar={older ? 'older' : 'newest'} data-reading-line={older ? 'older' : 'newest'} data-older-version-bar={older ? '' : undefined}>
      <div className="ib-plan-bar-start">
        {older ? (
          <>
            <span role="status" className="ib-plan-bar-older" data-plan-older-words="">
              <b>v{shown}</b> of {head}, an older version
            </span>
            <FrameButton variant="outline" size="xs" className="shrink-0" nativeButton={false} render={older.back}>
              Back to version {head}
            </FrameButton>
            {older.restore}
          </>
        ) : (
          <>
            {start}
            {approved}
          </>
        )}
      </div>
      <div className="ib-plan-bar-end">
        {!older && edit && <PlanEditMark onEdit={edit} />}
        <PlanVersionsMark shown={shown} head={head} open={versionsOpen} onToggle={onVersions} phone={phone} />
        {menu}
      </div>
    </div>
  );
}
