/**
 * "Sent with: this PR's details" (mock "V1"), under the person's first message in a thread started from a PR's page:
 * the PR's details that went to the agent after the person's words (`threadDetails.ts`), folded. A press shows the
 * exact text the agent got, as plain text; another folds it. A disclosure button, reachable with Tab.
 */
import { useId, useState } from 'react';
import { Icon } from '../icons';

export const PULL_DETAILS_SENT_WITH = 'Sent with: this PR’s details';

export function PullDetailsLine({ details }: { details: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="ib-pdet" data-pull-details="">
      <button type="button" className="ib-pdet-b" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} data-pull-details-toggle="">
        <Icon name={open ? 'chevD' : 'chevR'} size={12} />
        {PULL_DETAILS_SENT_WITH}
      </button>
      {open && (
        <pre id={id} className="ib-pdet-t" dir="auto" data-pull-details-text="">
          {details}
        </pre>
      )}
    </div>
  );
}
