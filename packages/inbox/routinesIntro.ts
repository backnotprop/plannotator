/**
 * The Routines intro's page side (components/RoutinesIntro.tsx; the line's entry `routines` in
 * packages/shared/inbox/reveals.ts). "Turn on" is one press: Routines go on exactly as Settings → Capabilities'
 * switch turns them on (`scheduledApi.saveSwitch`, `POST /api/inbox/settings { scheduled_threads: { on: true } }`), the
 * "/" list is read again, and the Routines page opens. A save that fails puts the switch back and toasts "Routines
 * aren't on" with Open Settings (revealTurnOn.ts), so the page it opened says they are off.
 */
import { reloadSkillCatalog } from '@plannotator/ui/utils/skillCatalog';
import { scheduledApi } from './scheduled/client';
import { turnOnFromReveal, type RevealTurnOnDeps } from './revealTurnOn';

/** Settings' own save of the switch, answering it as saved. The "/" list follows (it names `/create-routine` while on). */
export function saveRoutinesOn(): Promise<{ on: boolean }> {
  return scheduledApi.saveSwitch(true).then((saved) => {
    reloadSkillCatalog();
    return saved.scheduled_threads ?? { on: true };
  });
}

/** "Turn on": the dialog closes, the switch goes on, and the Routines page opens (`#routines`), all in one press. */
export function turnOnRoutinesFromIntro<S extends { scheduled_threads?: { on: boolean } }>(
  close: () => void,
  deps: Omit<RevealTurnOnDeps<S>, 'save'> & { save?: () => Promise<{ on: boolean }>; openRoutines: () => void },
): Promise<void> {
  const done = turnOnFromReveal<S>('scheduled_threads', close, { ...deps, save: deps.save ?? saveRoutinesOn });
  deps.openRoutines();
  return done;
}

/** Still worth showing: Routines are offered here (the settings carry the switch) and not on. */
export function routinesIntroHolds(settings: { scheduled_threads?: { on: boolean } } | null | undefined): boolean {
  return settings?.scheduled_threads !== undefined && settings.scheduled_threads.on !== true;
}
