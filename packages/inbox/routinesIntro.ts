/**
 * The Routines intro's page side (components/RoutinesIntro.tsx; the line's entry `routines` in
 * packages/shared/inbox/reveals.ts). "Turn on" is one press: Routines go on exactly as Settings → Capabilities'
 * switch turns them on (`scheduledApi.saveSwitch`, `POST /api/inbox/settings { scheduled_threads: { on: true } }`), the
 * "/" list is read again, and the Routines page opens once the switch is saved. A save that fails puts the switch back
 * and toasts "Routines aren't on" with Open Settings (revealTurnOn.ts), and opens no page.
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

/**
 * "Turn on": the dialog closes and the switch shows on at once; the Routines page (`#routines`) opens once the Inbox
 * has saved the switch. Opened sooner, the page's first read could reach the Inbox before the save and say Routines
 * are off, with nothing to read it again. A save that fails leaves the person where they were, with the toast.
 */
export function turnOnRoutinesFromIntro<S extends { scheduled_threads?: { on: boolean } }>(
  close: () => void,
  deps: Omit<RevealTurnOnDeps<S>, 'save'> & { save?: () => Promise<{ on: boolean }>; openRoutines: () => void },
): Promise<void> {
  const save = deps.save ?? saveRoutinesOn;
  let savedOn = false;
  const saveAndNote = () =>
    save().then((saved) => {
      savedOn = saved.on;
      return saved;
    });
  return turnOnFromReveal<S>('scheduled_threads', close, { ...deps, save: saveAndNote }).then(() => {
    if (savedOn) deps.openRoutines();
  });
}

/** Still worth showing: Routines are offered here (the settings carry the switch) and not on. */
export function routinesIntroHolds(settings: { scheduled_threads?: { on: boolean } } | null | undefined): boolean {
  return settings?.scheduled_threads !== undefined && settings.scheduled_threads.on !== true;
}
