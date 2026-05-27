import { createStore } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import { createAnnotationsSlice, type AnnotationsSlice } from './slices/annotations';
import { createDiffOptionsSlice, type DiffOptionsSlice } from './slices/diff-options';
import { createFilesSlice, type FilesSlice } from './slices/files';

export type ReviewStore = AnnotationsSlice & DiffOptionsSlice & FilesSlice;

export interface ReviewStoreDeps {
  fetch: typeof globalThis.fetch;
}

export function createReviewStore(_deps: ReviewStoreDeps) {
  return createStore<ReviewStore>()(
    immer((...args) => ({
      ...createAnnotationsSlice(...args),
      ...createDiffOptionsSlice(...args),
      ...createFilesSlice(...args),
    })),
  );
}
