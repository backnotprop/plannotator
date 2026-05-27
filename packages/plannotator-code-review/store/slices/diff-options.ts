import type { StateCreator } from 'zustand';
import type { ReviewStore } from '../create-review-store';

export interface DiffOptionsSlice {
  diffStyle: 'split' | 'unified';
  diffOverflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  disableLineNumbers: boolean;
  disableBackground: boolean;
  fontFamily?: string;
  fontSize?: string;

  setDiffOptions(options: Partial<Omit<DiffOptionsSlice, 'setDiffOptions'>>): void;
}

export const createDiffOptionsSlice: StateCreator<
  ReviewStore,
  [['zustand/immer', never]],
  [],
  DiffOptionsSlice
> = (set) => ({
  diffStyle: 'split',
  diffOverflow: undefined,
  diffIndicators: undefined,
  lineDiffType: undefined,
  disableLineNumbers: false,
  disableBackground: false,
  fontFamily: undefined,
  fontSize: undefined,

  setDiffOptions(options) {
    set((state) => {
      Object.assign(state, options);
    });
  },
});
