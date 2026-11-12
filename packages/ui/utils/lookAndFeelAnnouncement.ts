import { storage } from './storage';

const CHOICE_RESOLVED_KEY = 'plannotator-plan-look-choice-resolved';
const LEGACY_ANNOUNCEMENT_KEY = 'plannotator-look-feel-announcement-seen';
const V2_KEY = 'plannotator-plan-look-v2';
const GRID_KEY = 'plannotator-grid-enabled';

export type PlanLookPrompt = 'first-run' | 'moved' | null;

function hasV1Marker(): boolean {
  return storage.getItem(CHOICE_RESOLVED_KEY) === 'true'
    || storage.getItem(LEGACY_ANNOUNCEMENT_KEY) === '2';
}

export function migratePlanLookChoice(): void {
  if (storage.getItem(V2_KEY) !== null) return;
  if (!hasV1Marker()) return;
  if (storage.getItem(GRID_KEY) === 'true') {
    storage.setItem(GRID_KEY, 'false');
    storage.setItem(V2_KEY, 'notice');
  } else {
    storage.setItem(V2_KEY, 'resolved');
  }
}

function readV2(): string | null {
  migratePlanLookChoice();
  const v2 = storage.getItem(V2_KEY);
  if (v2 === 'resolved') storage.setItem(V2_KEY, 'resolved');
  return v2;
}

export function isLookChoiceResolved(): boolean {
  return readV2() === 'resolved';
}

export function planLookPrompt(): PlanLookPrompt {
  const v2 = readV2();
  if (v2 === 'resolved') return null;
  return v2 === 'notice' ? 'moved' : 'first-run';
}

export function planLookAnsweredElsewhere(): boolean | null {
  if (storage.getItem(V2_KEY) !== 'resolved') return null;
  return storage.getItem(GRID_KEY) === 'true';
}

export function needsLookAndFeelAnnouncement(): boolean {
  return planLookPrompt() !== null;
}

export function markLookAndFeelChoiceResolved(): void {
  storage.setItem(V2_KEY, 'resolved');
  storage.setItem(CHOICE_RESOLVED_KEY, 'true');
}
