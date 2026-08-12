import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import {
  markReviewAnalysisIntroSeen,
  needsReviewAnalysisIntro,
  reviewAnalysisIntroCanShow,
  type ReviewAnalysisIntroGateState,
} from './reviewAnalysisIntro';

const SEEN_KEY = 'plannotator-review-analysis-intro-seen';
let stored: Map<string, string>;

describe('review analysis intro persistence', () => {
  beforeEach(() => {
    stored = new Map();
    setStorageBackend({
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => { stored.set(key, value); },
      removeItem: (key) => { stored.delete(key); },
    });
  });

  afterEach(() => resetStorageBackend());

  test('uses a versioned seen cookie', () => {
    expect(needsReviewAnalysisIntro()).toBe(true);
    markReviewAnalysisIntroSeen();
    expect(stored.get(SEEN_KEY)).toBe('2');
    expect(needsReviewAnalysisIntro()).toBe(false);
    stored.set(SEEN_KEY, '1');
    expect(needsReviewAnalysisIntro()).toBe(true);
  });
});

describe('reviewAnalysisIntroCanShow', () => {
  const openState: ReviewAnalysisIntroGateState = {
    introPending: true,
    isLoading: false,
    guideIntroVisible: false,
    lookAndFeelVisible: false,
    reviewSetupVisible: false,
  };

  test('shows only after the earlier welcome dialogs clear', () => {
    expect(reviewAnalysisIntroCanShow(openState)).toBe(true);
    expect(reviewAnalysisIntroCanShow({ ...openState, isLoading: true })).toBe(false);
    expect(reviewAnalysisIntroCanShow({ ...openState, guideIntroVisible: true })).toBe(false);
    expect(reviewAnalysisIntroCanShow({ ...openState, lookAndFeelVisible: true })).toBe(false);
    expect(reviewAnalysisIntroCanShow({ ...openState, reviewSetupVisible: true })).toBe(false);
    expect(reviewAnalysisIntroCanShow({ ...openState, introPending: false })).toBe(false);
  });
});
