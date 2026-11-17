import { useEffect, useRef } from 'react';
import { Icon } from '../icons';
import { builtinSkillContent } from '../skills';
import { playRoutinesLoop } from '../routinesIntroArt';
import { useReducedMotion } from '../tour/Tour';
import { Modal } from './Updates';

/**
 * The Routines intro (the owner, 2026-11-17; round 2's variant F, "The loop", with the owner's changes: "it should be
 * two equal actions, like no thanks or turn on, etcetera, and let people know that they can turn it on at any point in
 * time in the settings"). A one-time offer of the line (shared/inbox/reveals.ts `routines`), in the Board's frame
 * (`.ib-bi`): the loop, the title, one sentence, the `/create-routine` line once that built-in exists, where Settings
 * turns it on, and two equal buttons.
 *
 * "No thanks" and "Turn on" are the same button (`.ib-btn`, neither the primary nor a ghost), the same size, side by
 * side (stacked at 44 px on a phone). First focus is the dialog itself, so Enter picks nothing and no ring shows until
 * the keyboard moves; Tab goes to "No thanks", then "Turn on", and wraps. "Turn on" turns Routines on as Settings
 * does and opens the Routines page; "No thanks", Escape and a click outside close it and change nothing. Every way out
 * is final (the claim spent it). No keyboard shortcut.
 */
export function RoutinesIntro({ phone, onClose, onTurnOn }: { phone: boolean; onClose: () => void; onTurnOn: () => void }) {
  useFirstFocusOnDialog();
  return (
    <Modal labelledBy="ib-rti-title" describedBy="ib-rti-desc" testId="routines-intro" onClose={onClose} ownKeys fallbackFocus={pageHeading} className={`ib-bi ib-rti${phone ? ' ib-bi-phone' : ''}`}>
      <RoutinesLoopArt phone={phone} />
      <p className="ib-sr" data-routines-intro-picture="">
        Picture: every weekday at 9:00 AM an agent runs and its reply lands in a thread, again and again.
      </p>
      <div className="ib-bi-text">
        <h2 id="ib-rti-title" className="ib-rti-h">
          Routines
          <Icon name="scheduled" className="ib-rti-h-ic" />
        </h2>
        <p id="ib-rti-desc">Save a prompt and pick when it runs. An agent runs it on this computer each time, and each run replies in the routine’s own thread.</p>
        {createRoutineBuiltIn() && (
          <p className="ib-bi-q" data-routines-intro-skill="">
            Once they’re on, you can also type <code>/create-routine</code> in any message and describe what you want.
          </p>
        )}
        <p className="ib-bi-q" data-routines-intro-settings="">
          You can turn Routines on at any time in Settings → Capabilities.
        </p>
      </div>
      <div className="ib-bi-acts ib-rti-acts">
        <button type="button" className="ib-btn" onClick={onClose} data-routines-intro-close="">
          No thanks
        </button>
        <button type="button" className="ib-btn" onClick={onTurnOn} data-routines-intro-on="">
          Turn on
        </button>
      </div>
    </Modal>
  );
}

/**
 * The `/create-routine` built-in exists in this build (PR #3601): the window carries its text, as it does `/shape` and
 * the review skills. Asked of the window's own built-ins, not the "/" list, which names it only while Routines are on.
 * Until it exists the line is left out, so the dialog never names a command the build does not have.
 */
export function createRoutineBuiltIn(): boolean {
  return builtinSkillContent({ name: 'create-routine', root: 'plannotator', humanOnly: true }) !== undefined;
}

/** Focus after the dialog when nothing focusable opened it: the page's heading. */
function pageHeading(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>('.ib-main h1');
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  return heading;
}

/**
 * First focus on the dialog itself (Code review's offer does the same): its name is read, and Enter turns nothing on.
 * Tab from the dialog goes to its first button, Shift+Tab to its last, so focus never leaves it.
 */
function useFirstFocusOnDialog() {
  useEffect(() => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[data-dialog="routines-intro"]');
    if (!dialog) return;
    dialog.tabIndex = -1;
    dialog.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || document.activeElement !== dialog) return;
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
      const to = event.shiftKey ? buttons[buttons.length - 1] : buttons[0];
      if (!to) return;
      event.preventDefault();
      to.focus();
    };
    dialog.addEventListener('keydown', onKey);
    return () => dialog.removeEventListener('keydown', onKey);
  }, []);
}

/** The loop. Decoration only: the paragraph beside it says it in words. */
function RoutinesLoopArt({ phone }: { phone: boolean }) {
  const svg = useRef<SVGSVGElement>(null);
  const still = useReducedMotion();
  useEffect(() => {
    if (!svg.current) return;
    return playRoutinesLoop(svg.current, { phone }, still);
  }, [phone, still]);
  return (
    <div className="ib-rti-art" aria-hidden="true" data-still={still ? '' : undefined}>
      <svg ref={svg} xmlns="http://www.w3.org/2000/svg" focusable="false" />
    </div>
  );
}
