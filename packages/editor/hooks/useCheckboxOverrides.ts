/**
 * Checkbox Overrides Hook
 *
 * Manages interactive checkbox toggling in the plan viewer. Each toggle creates
 * a COMMENT annotation capturing the action and section context; toggling back
 * to the original state removes the override and deletes the annotation.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Annotation, AnnotationType, Block } from '@plannotator/ui/types';

/** Serializable checkbox override entries used by history replay. */
export type CheckboxOverrideSnapshot = ReadonlyArray<readonly [string, boolean]>;

/** Checkbox annotation plus its exact position in the document collection. */
export interface IndexedCheckboxAnnotation {
  annotation: Annotation;
  index: number;
}

/** Reversible state captured for one human checkbox toggle. */
export interface CheckboxToggleMutation {
  blockId: string;
  beforeOverrides: CheckboxOverrideSnapshot;
  afterOverrides: CheckboxOverrideSnapshot;
  beforeAnnotations: IndexedCheckboxAnnotation[];
  afterAnnotations: IndexedCheckboxAnnotation[];
}

export interface UseCheckboxOverridesOptions {
  blocks: Block[];
  annotations: Annotation[];
  addAnnotation: (ann: Annotation) => number;
  removeAnnotation: (id: string) => void;
  onToggleMutation?: (mutation: CheckboxToggleMutation) => void;
}

export interface UseCheckboxOverridesReturn {
  /** Visual override state passed to the Viewer as `checkboxOverrides` */
  overrides: Map<string, boolean>;
  /** Toggle handler passed to the Viewer as `onToggleCheckbox` */
  toggle: (blockId: string, checked: boolean) => void;
  /** Revert an override when a checkbox annotation is deleted from the panel */
  revertOverride: (blockId: string) => void;
  /** Replace checkbox state while replaying undo/redo. */
  restoreOverrides: (snapshot: CheckboxOverrideSnapshot) => void;
}

export function useCheckboxOverrides({
  blocks,
  annotations,
  addAnnotation,
  removeAnnotation,
  onToggleMutation,
}: UseCheckboxOverridesOptions): UseCheckboxOverridesReturn {
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());

  // Refs so callbacks don't need annotations/blocks in their dep arrays
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const onToggleMutationRef = useRef(onToggleMutation);
  onToggleMutationRef.current = onToggleMutation;

  // Clean up stale overrides when blocks change (e.g. markdown reloaded)
  useEffect(() => {
    if (overrides.size === 0) return;
    const blockIds = new Set(blocks.map(b => b.id));
    const stale = [...overrides.keys()].filter(id => !blockIds.has(id));
    if (stale.length > 0) {
      setOverrides(prev => {
        const next = new Map(prev);
        stale.forEach(id => next.delete(id));
        return next;
      });
    }
  }, [blocks]);

  const toggle = useCallback((blockId: string, checked: boolean) => {
    const blocks = blocksRef.current;
    const annotations = annotationsRef.current;
    const block = blocks.find(b => b.id === blockId);
    const isRevertingToOriginal = block && checked === block.checked;
    const beforeOverrides = [...overridesRef.current.entries()] as CheckboxOverrideSnapshot;
    const beforeAnnotations = annotations.flatMap((annotation, index) =>
      annotation.blockId === blockId && annotation.id.startsWith('ann-checkbox-')
        ? [{ annotation, index }]
        : [],
    );

    if (isRevertingToOriginal) {
      // Undo: remove the override and delete ALL checkbox annotations for this block
      setOverrides(prev => {
        const next = new Map(prev);
        next.delete(blockId);
        return next;
      });
      const toDelete = annotations.filter(a => a.blockId === blockId && a.id.startsWith('ann-checkbox-'));
      toDelete.forEach(a => removeAnnotation(a.id));
      onToggleMutationRef.current?.({
        blockId,
        beforeOverrides,
        afterOverrides: beforeOverrides.filter(([id]) => id !== blockId),
        beforeAnnotations,
        afterAnnotations: [],
      });
    } else {
      // Toggle: remove any existing checkbox annotations for this block first (prevents duplicates from rapid clicks)
      const existing = annotations.filter(a => a.blockId === blockId && a.id.startsWith('ann-checkbox-'));
      existing.forEach(a => removeAnnotation(a.id));

      setOverrides(prev => {
        const next = new Map(prev);
        next.set(blockId, checked);
        return next;
      });
      let afterAnnotations: IndexedCheckboxAnnotation[] = [];
      if (block) {
        // Find the nearest heading above this block for section context
        const blockIdx = blocks.indexOf(block);
        let sectionHeading = '';
        for (let i = blockIdx - 1; i >= 0; i--) {
          if (blocks[i].type === 'heading') {
            sectionHeading = blocks[i].content;
            break;
          }
        }

        const action = checked ? 'Mark as completed' : 'Mark as not completed';
        const context = sectionHeading ? ` (under "${sectionHeading}")` : ` (line ${block.startLine})`;
        const ann: Annotation = {
          id: `ann-checkbox-${blockId}-${Date.now()}`,
          blockId,
          startOffset: 0,
          endOffset: block.content.length,
          type: AnnotationType.COMMENT,
          text: `${action}${context}: ${block.content}`,
          originalText: block.content,
          createdA: Date.now(),
        };
        const index = addAnnotation(ann);
        afterAnnotations = [{ annotation: ann, index }];
      }
      onToggleMutationRef.current?.({
        blockId,
        beforeOverrides,
        afterOverrides: [
          ...beforeOverrides.filter(([id]) => id !== blockId),
          [blockId, checked],
        ],
        beforeAnnotations,
        afterAnnotations,
      });
    }
  }, [addAnnotation, removeAnnotation]);

  const revertOverride = useCallback((blockId: string) => {
    setOverrides(prev => {
      const next = new Map(prev);
      next.delete(blockId);
      return next;
    });
  }, []);

  const restoreOverrides = useCallback((snapshot: CheckboxOverrideSnapshot) => {
    setOverrides(new Map(snapshot));
  }, []);

  return { overrides, toggle, revertOverride, restoreOverrides };
}
