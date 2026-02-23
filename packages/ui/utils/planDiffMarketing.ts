import { storage } from './storage';

const STORAGE_KEY = 'plannotator-plan-diff-marketing-seen';

export function needsPlanDiffMarketingDialog(): boolean {
  return storage.getItem(STORAGE_KEY) !== 'true';
}

export function markPlanDiffMarketingSeen(): void {
  storage.setItem(STORAGE_KEY, 'true');
}
