import { storage } from '@plannotator/ui/utils/storage';

const STORAGE_KEY = 'plannotator-review-analysis-intro-seen';
// Bump after a meaningful change to the choices or explanation.
const CURRENT_VERSION = '2';

export function needsReviewAnalysisIntro(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markReviewAnalysisIntroSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

export interface ReviewAnalysisIntroGateState {
  readonly introPending: boolean;
  readonly isLoading: boolean;
  readonly guideIntroVisible: boolean;
  readonly lookAndFeelVisible: boolean;
  readonly reviewSetupVisible: boolean;
}

/** Fourth step in the no-stack code-review welcome chain. */
export function reviewAnalysisIntroCanShow(state: ReviewAnalysisIntroGateState): boolean {
  return (
    state.introPending
    && !state.isLoading
    && !state.guideIntroVisible
    && !state.lookAndFeelVisible
    && !state.reviewSetupVisible
  );
}
