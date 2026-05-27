import type { StateCreator } from 'zustand';
import type { DiffFile } from '../../types';
import type { ReviewStore } from '../create-review-store';

export interface FilesSlice {
  files: DiffFile[];
  focusedFileIndex: number;
  focusedFilePath: string | null;
  isAllFilesActive: boolean;

  setFiles(files: DiffFile[]): void;
  setFocusedFile(index: number): void;
  setIsAllFilesActive(active: boolean): void;
}

export const createFilesSlice: StateCreator<
  ReviewStore,
  [['zustand/immer', never]],
  [],
  FilesSlice
> = (set) => ({
  files: [],
  focusedFileIndex: 0,
  focusedFilePath: null,
  isAllFilesActive: false,

  setFiles(files) {
    set((state) => {
      state.files = files;
      if (files.length > 0 && state.focusedFileIndex >= files.length) {
        state.focusedFileIndex = 0;
        state.focusedFilePath = files[0]?.path ?? null;
      } else if (files.length > 0) {
        state.focusedFilePath = files[state.focusedFileIndex]?.path ?? null;
      }
    });
  },

  setFocusedFile(index) {
    set((state) => {
      state.focusedFileIndex = index;
      state.focusedFilePath = state.files[index]?.path ?? null;
    });
  },

  setIsAllFilesActive(active) {
    set((state) => {
      state.isAllFilesActive = active;
    });
  },
});
