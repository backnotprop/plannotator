import { useState, useEffect, useCallback, useRef } from 'react';
import { Annotation, AnnotationType, Block } from '@plannotator/ui/types';

export type CheckboxOverrideSnapshot = ReadonlyArray<readonly [string, boolean]>;

export interface IndexedCheckboxAnnotation {
  annotation: Annotation;
  index: number;
}

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
  overrides: Map<string, boolean>;
  toggle: (blockId: string, checked: boolean) => void;
  revertOverride: (blockId: string) => void;
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
      const existing = annotations.filter(a => a.blockId === blockId && a.id.startsWith('ann-checkbox-'));
      existing.forEach(a => removeAnnotation(a.id));

      setOverrides(prev => {
        const next = new Map(prev);
        next.set(blockId, checked);
        return next;
      });
      let afterAnnotations: IndexedCheckboxAnnotation[] = [];
      if (block) {
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
