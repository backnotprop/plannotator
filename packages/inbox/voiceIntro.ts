/**
 * When the one-time voice announcement may show (DESIGN-NOTES section 1). The Inbox decides who, and spends the claim
 * (POST /api/inbox/voice/intro: once per machine, only where Codex has a ChatGPT login), and its line says when it is
 * next (packages/shared/inbox/reveals.ts). The page decides when: it goes last, so it never shares a load with the
 * sound dialog, the agent note, the list options dialog or the tour; its moment is a long reply just sent (approval
 * "inbox-one-time-dialogs"), and it waits as the list options dialog does (listIntro.ts) for a settled Inbox page with
 * nothing over it.
 */
import { useEffect, useRef, useState } from 'react';
import { inboxApi } from './api';
import { LIST_INTRO_SETTLED_MS } from './listIntro';

/** Voice's moment (approval "inbox-one-time-dialogs": "just sent a reply of 40+ words"): a reply this long or longer. */
export const VOICE_INTRO_MIN_WORDS = 40;
/** How long after such a reply the moment lasts, ms. */
export const VOICE_INTRO_MOMENT_MS = 60_000;

export interface VoiceIntroLoad {
  /** The Inbox has it due (settings `voice.intro_due`), as the load's latch holds it (reveal.ts `useLineLatch`). */
  due: boolean;
  /** The page is this computer's or its owner's over the tailnet (not a tailnet guest's). */
  owner: boolean;
  listLoaded: boolean;
  firstRun: boolean;
  /** The list options dialog was due when this load began: it goes first, and voice waits a load. */
  listIntroDue: boolean;
  tourThisLoad: boolean;
  /** The sound or the agent-note dialog showed in this load. */
  otherDialogThisLoad: boolean;
  /** The sound claim and the agent-note decision of this load are both settled. */
  othersSettled: boolean;
  /** An update dialog or a restart is on screen. */
  updating: boolean;
  /** Its moment: this page sent a reply of `VOICE_INTRO_MIN_WORDS` or more a moment ago. Absent: no moment needed. */
  moment?: boolean;
}

export function voiceIntroWanted(load: VoiceIntroLoad): boolean {
  return load.due && load.owner && load.listLoaded && !load.firstRun && !load.listIntroDue && !load.tourThisLoad && !load.otherDialogThisLoad;
}

export function voiceIntroMayAsk(load: VoiceIntroLoad, settled: boolean): boolean {
  return voiceIntroWanted(load) && settled && load.othersSettled && !load.updating && load.moment !== false;
}

const RECHECK_MS = 700;

/** Run `step` now and then until it says it is done. */
function untilDone(step: () => boolean): (() => void) | undefined {
  if (step()) return undefined;
  const timer = setInterval(() => {
    if (step()) clearInterval(timer);
  }, RECHECK_MS);
  return () => clearInterval(timer);
}

export type VoiceIntroStage = 'none' | 'claimed' | 'open' | 'shown';

/**
 * The claim and the opening. `clear`: the Inbox page with nothing over it (`listIntroPageClear`). `place`: what restarts
 * the settling wait. `heldBack`: a dialog, a panel, or a reply being written.
 */
export function useVoiceIntro(load: VoiceIntroLoad, clear: boolean, place: string, heldBack: () => boolean) {
  const [stage, setStage] = useState<VoiceIntroStage>('none');
  const [decided, setDecided] = useState(false);
  const [settledFlag, setSettled] = useState(false);
  const asked = useRef(false);
  const held = useRef(heldBack);
  held.current = heldBack;
  const settled = settledFlag && clear;
  const wanted = voiceIntroWanted(load);
  const watch = wanted && (!decided || stage === 'claimed');
  useEffect(() => {
    setSettled(false);
    if (!watch || !clear) return;
    const timer = setTimeout(() => setSettled(true), LIST_INTRO_SETTLED_MS);
    return () => clearTimeout(timer);
  }, [watch, clear, place]);
  const ready = voiceIntroMayAsk(load, settled);
  useEffect(() => {
    if (!ready || asked.current) return;
    return untilDone(() => {
      if (asked.current || held.current()) return false;
      asked.current = true;
      inboxApi
        .claimVoiceIntro()
        .then((answer) => answer.show && setStage('claimed'))
        .catch(() => {})
        .finally(() => setDecided(true));
      return true;
    });
  }, [ready]);
  // A claim is spent: never dropped, it opens when the page is free again.
  const claimed = stage === 'claimed';
  const free = settled && !load.updating;
  useEffect(() => {
    if (!claimed || !free) return;
    return untilDone(() => {
      if (held.current()) return false;
      setStage('open');
      return true;
    });
  }, [claimed, free]);
  return { stage, wanted, decided, close: () => setStage('shown') };
}
