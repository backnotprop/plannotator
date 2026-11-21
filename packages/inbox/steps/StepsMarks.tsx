/**
 * The checklist's marks (approval "inbox-checklist-spinners-2026-11-07", mock 1): one 14 px box per
 * status, each its own shape, so no status rests on colour alone.
 *
 *  - todo: an empty ring (the quiet grey, 3:1 or better);
 *  - doing: the thin spinner: the todo ring's own circle as a faint track and a 28% arc in primary, the whole SVG
 *    turning in 0.9 s while the step is in progress, whether its session is busy or idle. Ended: still and grey.
 *    Reduced motion: the same arc, still (a partial ring, never the full todo ring);
 *  - done: a check, no disc;
 *  - waiting on the person: an amber ring with a pause;
 *  - dropped: a small ×.
 *
 * The inks and the turn are CSS (inbox.css, "Thread steps"), by the presence class (`ib-st-working`, `ib-st-idle`,
 * `ib-st-ended`) on the mark or a parent.
 */

import type { InboxStepStatus } from '@plannotator/core/inbox-types';
import { pieGeometry } from './model';

export function StepGlyph({ status, size = 14 }: { status: InboxStepStatus; size?: number }) {
  const box = { width: size, height: size, viewBox: '0 0 14 14', 'aria-hidden': true as const };
  switch (status) {
    case 'todo':
      return (
        <svg className="ib-stg ib-stg-todo" {...box} data-step-mark="todo">
          <circle cx="7" cy="7" r="6" />
        </svg>
      );
    case 'doing':
      return <StepSpinner size={size} />;
    case 'done':
      return (
        <svg className="ib-stg ib-stg-done" {...box} data-step-mark="done">
          <path d="M3.3 7.4 5.9 9.9 10.8 4.4" />
        </svg>
      );
    case 'waiting':
      return (
        <svg className="ib-stg ib-stg-wait" {...box} data-step-mark="waiting">
          <circle cx="7" cy="7" r="6" />
          <path d="M5.6 5v4M8.4 5v4" />
        </svg>
      );
    case 'dropped':
      return (
        <svg className="ib-stg ib-stg-drop" {...box} data-step-mark="dropped">
          <path d="M4.6 4.6l4.8 4.8M9.4 4.6 4.6 9.4" />
        </svg>
      );
  }
}

/** The spinner: a faint track on the todo ring's circle, one arc over 28% of it; the whole SVG turns, so the arc never changes length. */
export function StepSpinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="ib-stg ib-stg-spin" width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" data-step-mark="doing">
      <circle className="tr" cx="7" cy="7" r="6" />
      <circle className="arc" cx="7" cy="7" r="6" pathLength={100} strokeDasharray="28 72" transform="rotate(-90 7 7)" />
    </svg>
  );
}

/** The plan's mark: a ring with the done share as a wedge (the foot's button when no step is worked on or waits, and each list's head). */
export function StepsPie({ done, total, size = 13 }: { done: number; total: number; size?: number }) {
  const { c, r, ri, path, full } = pieGeometry(done, total, size);
  return (
    <svg className="ib-stpie" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" data-steps-pie={`${done}/${total}`}>
      <circle className="o" cx={c} cy={c} r={r} />
      {full ? <circle className="w" cx={c} cy={c} r={ri} /> : path ? <path className="w" d={path} /> : null}
    </svg>
  );
}
