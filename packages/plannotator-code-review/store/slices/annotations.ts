import type { StateCreator } from 'zustand';
import type {
  CodeAnnotation,
  SelectedLineRange,
} from '@plannotator/ui/types';
import type { ReviewStore } from '../create-review-store';

export interface AnnotationsSlice {
  localAnnotations: CodeAnnotation[];
  externalAnnotations: CodeAnnotation[];
  selectedAnnotationId: string | null;
  pendingSelection: SelectedLineRange | null;

  setPendingSelection(range: SelectedLineRange | null): void;
  selectAnnotation(id: string | null): void;
  addAnnotation(annotation: CodeAnnotation): void;
  editAnnotation(
    id: string,
    updates: Partial<Pick<CodeAnnotation, 'text' | 'suggestedCode' | 'originalCode' | 'conventionalLabel' | 'decorations'>>,
  ): void;
  deleteAnnotation(id: string): void;
  setExternalAnnotations(annotations: CodeAnnotation[]): void;
  setLocalAnnotations(annotations: CodeAnnotation[]): void;
}

export const createAnnotationsSlice: StateCreator<
  ReviewStore,
  [['zustand/immer', never]],
  [],
  AnnotationsSlice
> = (set) => ({
  localAnnotations: [],
  externalAnnotations: [],
  selectedAnnotationId: null,
  pendingSelection: null,

  setPendingSelection(range) {
    set((state) => {
      state.pendingSelection = range;
    });
  },

  selectAnnotation(id) {
    set((state) => {
      state.selectedAnnotationId = id;
    });
  },

  addAnnotation(annotation) {
    set((state) => {
      state.localAnnotations.push(annotation);
      state.pendingSelection = null;
    });
  },

  editAnnotation(id, updates) {
    set((state) => {
      const ann = state.localAnnotations.find((a) => a.id === id);
      if (ann) Object.assign(ann, updates);
    });
  },

  deleteAnnotation(id) {
    set((state) => {
      state.localAnnotations = state.localAnnotations.filter((a) => a.id !== id);
      if (state.selectedAnnotationId === id) {
        state.selectedAnnotationId = null;
      }
    });
  },

  setExternalAnnotations(annotations) {
    set((state) => {
      state.externalAnnotations = annotations;
    });
  },

  setLocalAnnotations(annotations) {
    set((state) => {
      state.localAnnotations = annotations;
    });
  },
});
