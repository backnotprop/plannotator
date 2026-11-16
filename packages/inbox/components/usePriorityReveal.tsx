import { useMemo } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { starRevealLeaveCounts, useLineReveal, type LineRevealInput } from '../reveal';
import { openPriorityMenu, priorityIntroHolds, priorityIntroMayClaim, priorityIntroPicture, priorityIntroTarget } from '../priorityIntro';
import { PriorityIntro } from './PriorityIntro';

type RevealAt = Pick<LineRevealInput, 'blocked' | 'rows' | 'toast' | 'thread' | 'clear' | 'place' | 'heldBack'>;

export interface PriorityRevealInput {
  due: boolean;
  revealAt: RevealAt;
  idle: boolean;
  listLoaded: boolean;
  firstRun: boolean;
  grouped: boolean;
  oneTimeRows: () => readonly InboxListRow[];
  phone: boolean;
  projectNames: ReadonlyMap<string, string>;
  openThread: () => string | null;
  openTarget: (threadId: string) => void;
}

export function usePriorityReveal(input: PriorityRevealInput) {
  const { revealAt, grouped } = input;
  const reveal = useLineReveal({
    id: 'priority',
    due: input.due,
    ...revealAt,
    leaveCounts: (visit, now) => starRevealLeaveCounts(visit, now),
    idle: input.idle,
    mayClaim: (pageAge) => priorityIntroMayClaim({ listLoaded: input.listLoaded, firstRun: input.firstRun, grouped, rows: revealAt.rows }, pageAge),
    holds: () => grouped && priorityIntroHolds(input.oneTimeRows()),
  });
  const open = reveal.stage === 'open';
  const aim = open ? priorityIntroTarget(revealAt.rows, reveal.target) : null;
  const scene = useMemo(() => (open ? priorityIntroPicture(revealAt.rows, aim) : null), [open, aim, revealAt.rows]);
  const tryIt = () => {
    reveal.close();
    setTimeout(() => {
      void openPriorityMenu({
        root: document.querySelector('.pn-inbox') ?? document,
        phone: input.phone,
        openThread: input.openThread(),
        target: aim,
        openTarget: input.openTarget,
      });
    }, 0);
  };
  const dialog =
    open && scene ? (
      <PriorityIntro
        picture={scene}
        projectNames={input.projectNames}
        phone={input.phone}
        onGotIt={reveal.close}
        onTry={tryIt}
        onDismiss={() => {
          void inboxApi.revealNotNow('priority');
          reveal.close();
        }}
      />
    ) : null;
  return { reveal, dialog };
}
