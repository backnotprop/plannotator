import { inboxApi } from '../api';
import { REVEAL_TIMES, starRevealLeaveCounts, useLineReveal, type LineRevealInput } from '../reveal';
import type { RevealTurnOnDeps } from '../revealTurnOn';
import { routinesIntroHolds, turnOnRoutinesFromIntro } from '../routinesIntro';
import { RoutinesIntro } from './RoutinesIntro';

type RevealAt = Pick<LineRevealInput, 'blocked' | 'rows' | 'toast' | 'thread' | 'clear' | 'place' | 'heldBack'>;
type Settings = { scheduled_threads?: { on: boolean } };

export interface RoutinesRevealInput<S extends Settings> extends Omit<RevealTurnOnDeps<S>, 'save'> {
  /** The line names it (`reveal.next === 'routines'`). */
  due: boolean;
  revealAt: RevealAt;
  idle: boolean;
  listLoaded: boolean;
  firstRun: boolean;
  phone: boolean;
  /** The settings as they are now (the switch). */
  settings: () => S | null;
}

/**
 * The Routines intro on the page (shared/inbox/routines-intro.ts names who; reveals.ts `routines` its place, the
 * line's gap from any other dialog): the shared calm moment (a thread read 5 s and left, or the page idle, 60 s into the page), held
 * while Routines are on or not offered. "Turn on" turns them on as Settings does and opens `#routines`; "No thanks",
 * Escape and a click outside are the line's Not now and change nothing else.
 */
export function useRoutinesReveal<S extends Settings>(input: RoutinesRevealInput<S>) {
  const reveal = useLineReveal({
    id: 'routines',
    due: input.due,
    ...input.revealAt,
    leaveCounts: (visit, now) => starRevealLeaveCounts(visit, now),
    idle: input.idle,
    mayClaim: (pageAge) => input.listLoaded && !input.firstRun && pageAge >= REVEAL_TIMES.pageAgeMs,
    holds: () => routinesIntroHolds(input.settings()),
  });
  const dialog =
    reveal.stage === 'open' ? (
      <RoutinesIntro
        phone={input.phone}
        onClose={() => {
          void inboxApi.revealNotNow('routines');
          reveal.close();
        }}
        onTurnOn={() =>
          void turnOnRoutinesFromIntro<S>(reveal.close, {
            setSettings: input.setSettings,
            showToast: input.showToast,
            dismissToast: input.dismissToast,
            refreshSettings: input.refreshSettings,
            openSettings: input.openSettings,
            openRoutines: () => {
              window.location.hash = '#routines';
            },
          })
        }
      />
    ) : null;
  return { reveal, dialog };
}
