/**
 * Checkbox Overrides Hook
 *
 * Manages interactive checkbox toggling in the plan viewer. Each toggle creates
 * a COMMENT annotation capturing the action and section context; toggling back
 * to the original state removes the override and deletes the annotation.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Annotation, AnnotationType, Block } from '@plannotator/ui/types';

export interface UseCheckboxOverridesOptions {
  blocks: Block[];
  annotations: Annotation[];
  addAnnotation: (ann: Annotation) => void;
  removeAnnotation: (id: string) => void;
}

export interface UseCheckboxOverridesReturn {
  /** Visual override state passed to the Viewer as `checkboxOverrides` */
  overrides: Map<string, boolean>;
  /** Toggle handler passed to the Viewer as `onToggleCheckbox` */
  toggle: (blockId: string, checked: boolean) => void;
  /** Revert an override when a checkbox annotation is deleted from the panel */
  revertOverride: (blockId: string) => void;
}

export function useCheckboxOverrides({
  blocks,
  annotations,
  addAnnotation,
  removeAnnotation,
}: UseCheckboxOverridesOptions): UseCheckboxOverridesReturn {
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());

  // Refs so callbacks don't need annotations/blocks in their dep arrays
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;

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

    if (isRevertingToOriginal) {
      // Undo: remove the override and delete ALL checkbox annotations for this block
      setOverrides(prev => {
        const next = new Map(prev);
        next.delete(blockId);
        return next;
      });
      const toDelete = annotations.filter(a => a.blockId === blockId && a.id.startsWith('ann-checkbox-'));
      toDelete.forEach(a => removeAnnotation(a.id));
    } else {
      // Toggle: remove any existing checkbox annotations for this block first (prevents duplicates from rapid clicks)
      const existing = annotations.filter(a => a.blockId === blockId && a.id.startsWith('ann-checkbox-'));
      existing.forEach(a => removeAnnotation(a.id));

      setOverrides(prev => {
        const next = new Map(prev);
        next.set(blockId, checked);
        return next;
      });
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
        addAnnotation(ann);
      }
    }
  }, [addAnnotation, removeAnnotation]);

  const revertOverride = useCallback((blockId: string) => {
    setOverrides(prev => {
      const next = new Map(prev);
      next.delete(blockId);
      return next;
    });
  }, []);

  return { overrides, toggle, revertOverride };
}
