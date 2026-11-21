import { storage } from '@plannotator/ui/utils/storage';

export const LAYOUT_ENGINE_KEY = 'plannotator-review-layout-engine';

export function usesPaneLayout(): boolean {
  return storage.getItem(LAYOUT_ENGINE_KEY) !== 'dock';
}
