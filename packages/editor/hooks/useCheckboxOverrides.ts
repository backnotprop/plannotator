/**
 * Checkbox Overrides Hook
 *
 * Manages interactive checkbox toggling in the plan viewer. Each toggle creates
 * a COMMENT annotation capturing the action and section context; toggling back
 * to the original state removes the override and deletes the annotation.
 *
 * Undo integration: the hook records each toggle as a single composite action
 * via `onRecordToggle` (capturing before/after override maps and checkbox
 * annotations) so the history stack can reverse it as one step. `applyOverrides`
 * restores a prior override map during undo/redo. The `addAnnotation` /
 * `removeAnnotation` callbacks passed in are expected to be the *raw*
 * (non-history-recording) variants so the toggle's internal add/remove do not
 * each push their own history entry.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Annotation, AnnotationType, Block } from '@plannotator/ui/types';
import type { OverrideSnapshot } from '@plannotator/ui/hooks/useAnnotationHistory';

/** Payload recorded for the history stack on each interactive toggle. */
export interface CheckboxToggleRecord {
  blockId: string;
  prevOverrides: OverrideSnapshot;
  nextOverrides: OverrideSnapshot;
  prevCheckboxAnns: Annotation[];
  nextCheckboxAnns: Annotation[];
}

export interface UseCheckboxOverridesOptions {
  blocks: Block[];
  annotations: Annotation[];
  addAnnotation: (ann: Annotation) => void;
  removeAnnotation: (id: string) => void;
  /** Record a composite toggle action for undo/redo. */
  onRecordToggle?: (record: CheckboxToggleRecord) => void;
}

export interface UseCheckboxOverridesReturn {
  /** Visual override state passed to the Viewer as `checkboxOverrides` */
  overrides: Map<string, boolean>;
  /** Toggle handler passed to the Viewer as `onToggleCheckbox` */
  toggle: (blockId: string, checked: boolean) => void;
  /** Revert an override when a checkbox annotation is deleted from the panel */
  revertOverride: (blockId: string) => void;
  /** Replace the entire override map (undo/redo). Accepts a serializable snapshot. */
  applyOverrides: (next: OverrideSnapshot) => void;
}

export function useCheckboxOverrides({
  blocks,
  annotations,
  addAnnotation,
  removeAnnotation,
  onRecordToggle,
}: UseCheckboxOverridesOptions): UseCheckboxOverridesReturn {
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());

  // Refs so callbacks don't need annotations/blocks/overrides in their dep arrays
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const onRecordToggleRef = useRef(onRecordToggle);
  onRecordToggleRef.current = onRecordToggle;

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

    // Snapshot before-state for the composite undo record.
    const prevOverrides: OverrideSnapshot = [...overridesRef.current.entries()];
    const prevCheckboxAnns = annotations.filter(
      a => a.blockId === blockId && a.id.startsWith('ann-checkbox-'),
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

      const nextOverrides = prevOverrides.filter(([id]) => id !== blockId);
      onRecordToggleRef.current?.({
        blockId,
        prevOverrides,
        nextOverrides,
        prevCheckboxAnns,
        nextCheckboxAnns: [],
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

      let nextCheckboxAnns: Annotation[] = [];
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
        nextCheckboxAnns = [ann];
      }

      const nextOverrides: OverrideSnapshot = [...prevOverrides.filter(([id]) => id !== blockId), [blockId, checked]];
      onRecordToggleRef.current?.({
        blockId,
        prevOverrides,
        nextOverrides,
        prevCheckboxAnns,
        nextCheckboxAnns,
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

  const applyOverrides = useCallback((next: OverrideSnapshot) => {
    setOverrides(new Map(next));
  }, []);

  return { overrides, toggle, revertOverride, applyOverrides };
}
