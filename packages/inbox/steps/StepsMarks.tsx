/**
 * Thread steps' marks (approval "inbox-thread-steps", A1): Linear's status
 * shapes at 14 px, and the plan's pie. Colour is only on the step in progress
 * (primary) and the step that waits on the person (amber); the CSS
 * (inbox.css, "Thread steps") does the rest, by the panel's presence class.
 */

import type { InboxStepStatus } from '@plannotator/core/inbox-types';
import { pieGeometry } from './model';

export function StepGlyph({ status }: { status: InboxStepStatus }) {
  switch (status) {
    case 'todo':
      return (
        <svg className="ib-stg ib-stg-todo" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6" />
        </svg>
      );
    case 'doing':
      return (
        <svg className="ib-stg ib-stg-doing" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle className="o" cx="7" cy="7" r="6" />
          <path className="p" d="M7 3.2a3.8 3.8 0 0 1 0 7.6z" />
        </svg>
      );
    case 'done':
      return (
        <svg className="ib-stg ib-stg-done" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle className="f" cx="7" cy="7" r="6.6" />
          <path className="k" d="M4.4 7.2 6.2 9 9.7 5.3" />
        </svg>
      );
    case 'waiting':
      return (
        <svg className="ib-stg ib-stg-wait" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6" />
          <rect x="5.1" y="4.6" width="1.3" height="4.8" rx=".5" />
          <rect x="7.6" y="4.6" width="1.3" height="4.8" rx=".5" />
        </svg>
      );
    case 'dropped':
      return (
        <svg className="ib-stg ib-stg-drop" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6.6" />
          <path d="M5 5l4 4M9 5 5 9" />
        </svg>
      );
  }
}

/** The plan's mark: a ring with the done share as a wedge. */
export function StepsPie({ done, total, size = 13 }: { done: number; total: number; size?: number }) {
  const { c, r, ri, path, full } = pieGeometry(done, total, size);
  return (
    <svg className="ib-stpie" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" data-steps-pie={`${done}/${total}`}>
      <circle className="o" cx={c} cy={c} r={r} />
      {full ? <circle className="w" cx={c} cy={c} r={ri} /> : path ? <path className="w" d={path} /> : null}
    </svg>
  );
}
