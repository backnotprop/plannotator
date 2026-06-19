/**
 * Annotation History Hook — bounded undo/redo for plan-review actions.
 *
 * Implements the command-pattern stack described in
 * `apps/pi-extension/UNDO_SPEC.md` §5. Each user-initiated annotation/comment
 * action is recorded as an {@link AnnotationAction} carrying enough data to
 * compute an inverse. `undo()` replays the inverse against the live React
 * setters and the imperative `ViewerHandle`; `redo()` replays the original.
 *
 * The stack reuses the existing DOM-highlight imperative API
 * (`removeHighlight` / `applySharedAnnotations`) — no new Viewer API is
 * introduced. Inverse mutations flow through the same `setAnnotations` /
 * `setCodeAnnotations` / `setGlobalAttachments` setters the app already uses,
 * so the debounced draft auto-save (`useAnnotationDraft`) picks up undo/redo
 * changes with no persistence-layer changes.
 *
 * Scope (v1): annotation add/edit/delete, code-annotation add/edit/delete,
 * global-attachment add/remove, checkbox toggle, identity change. External
 * (SSE) and VS Code editor annotations are non-undoable and never recorded.
 * Direct markdown edits are non-undoable (CM6 owns native undo); the app clears
 * this stack when committed markdown changes remap annotation anchors.
 */

import { useReducer, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Annotation, CodeAnnotation, ImageAttachment } from "../types";
import type { ViewerHandle } from "../components/Viewer";

/** A serializable snapshot of the override map. */
export type OverrideSnapshot = Array<[string, boolean]>;

/**
 * Discriminated union of every undoable v1 action. Each variant carries the
 * data needed to compute both the undo (inverse) and redo (forward) passes.
 *
 * `prevAnn`/`nextAnn` (full snapshots) are used for edits rather than partial
 * diffs so the inverse can re-apply DOM highlights when anchoring fields
 * (`originalText` / `startMeta` / `endMeta` / `blockId`) change — see
 * `anchorsEqual`.
 */
export type AnnotationAction =
  | {
      kind: "add-annotation";
      ann: Annotation;
      prevSelectedId: string | null;
      prevSelectedCodeId: string | null;
    }
  | {
      kind: "add-code-annotation";
      ann: CodeAnnotation;
      prevSelectedId: string | null;
      prevSelectedCodeId: string | null;
    }
  | { kind: "add-global-attachment"; img: ImageAttachment }
  | {
      kind: "update-annotation";
      prevAnn: Annotation;
      nextAnn: Annotation;
    }
  | {
      kind: "update-code-annotation";
      prevAnn: CodeAnnotation;
      nextAnn: CodeAnnotation;
    }
  | {
      kind: "delete-annotation";
      ann: Annotation;
      prevSelectedId: string | null;
    }
  | {
      kind: "delete-code-annotation";
      ann: CodeAnnotation;
      prevSelectedCodeId: string | null;
    }
  | { kind: "remove-global-attachment"; img: ImageAttachment }
  | {
      kind: "checkbox-toggle";
      blockId: string;
      prevOverrides: OverrideSnapshot;
      nextOverrides: OverrideSnapshot;
      prevCheckboxAnns: Annotation[];
      nextCheckboxAnns: Annotation[];
    }
  | {
      kind: "identity-change";
      oldIdentity: string;
      newIdentity: string;
      affectedAnnIds: string[];
      affectedCodeAnnIds: string[];
    };

/** JSON-serializable history snapshot for cross-surface stash/restore. */
export interface SerializedHistory {
  past: AnnotationAction[];
  future: AnnotationAction[];
}

/** Live setters + selection accessors the hook drives inverses through. */
export interface UseAnnotationHistoryOptions {
  setAnnotations: Dispatch<SetStateAction<Annotation[]>>;
  setCodeAnnotations: Dispatch<SetStateAction<CodeAnnotation[]>>;
  setGlobalAttachments: Dispatch<SetStateAction<ImageAttachment[]>>;
  viewerRef: RefObject<ViewerHandle | null>;
  /** Replace the checkbox-override map. Accepts a serializable snapshot. */
  applyOverrides: (next: OverrideSnapshot) => void;
  getSelectedAnnotationId: () => string | null;
  setSelectedAnnotationId: (id: string | null) => void;
  getSelectedCodeAnnotationId: () => string | null;
  setSelectedCodeAnnotationId: (id: string | null) => void;
}

export interface AnnotationHistoryApi {
  canUndo: boolean;
  canRedo: boolean;
  /** Record an action's inverse onto the past stack; clears redo. */
  push: (action: AnnotationAction) => void;
  /** Replay the most recent action's inverse; pushes it onto the redo stack. */
  undo: () => void;
  /** Replay a previously undone action; pushes it back onto the past stack. */
  redo: () => void;
  /** Empty both stacks (bulk baseline loads, terminal decision). */
  clear: () => void;
  /** Snapshot both stacks for stashing across surface switches. */
  serialize: () => SerializedHistory;
  /** Replace both stacks from a snapshot (undefined → cleared). */
  restore: (snapshot: SerializedHistory | undefined) => void;
}

/** Bounded past depth — oldest entries are dropped under pressure. */
const MAX_PAST = 50;

function anchorsEqual(a: Annotation, b: Annotation): boolean {
  return (
    a.originalText === b.originalText &&
    a.blockId === b.blockId &&
    a.startMeta?.parentTagName === b.startMeta?.parentTagName &&
    a.startMeta?.parentIndex === b.startMeta?.parentIndex &&
    a.startMeta?.textOffset === b.startMeta?.textOffset &&
    a.endMeta?.parentTagName === b.endMeta?.parentTagName &&
    a.endMeta?.parentIndex === b.endMeta?.parentIndex &&
    a.endMeta?.textOffset === b.endMeta?.textOffset
  );
}

/** True for annotations that own a DOM highlight (web-highlighter or code wrap). */
function hasHighlight(a: Annotation): boolean {
  return (
    !a.diffContext &&
    a.type !== ("GLOBAL_COMMENT" as Annotation["type"]) &&
    !a.id.startsWith("ann-checkbox-")
  );
}

export function useAnnotationHistory(
  options: UseAnnotationHistoryOptions,
): AnnotationHistoryApi {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  const controllerRef = useRef<AnnotationHistoryApi | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = createAnnotationHistoryController(
      () => optionsRef.current,
      forceUpdate,
    );
  }

  return controllerRef.current;
}

/**
 * Pure controller behind the React hook. Tests use this directly so undo/redo
 * semantics run in default `bun test` without requiring a DOM-backed renderer.
 */
export function createAnnotationHistoryController(
  getOptions: () => UseAnnotationHistoryOptions,
  onChange: () => void = () => {},
): AnnotationHistoryApi {
  let past: AnnotationAction[] = [];
  let future: AnnotationAction[] = [];

  const applyUndo = (action: AnnotationAction) => {
    const o = getOptions();
    switch (action.kind) {
      case "add-annotation": {
        o.viewerRef.current?.removeHighlight(action.ann.id);
        o.setAnnotations((prev) => prev.filter((a) => a.id !== action.ann.id));
        o.setSelectedAnnotationId(action.prevSelectedId);
        o.setSelectedCodeAnnotationId(action.prevSelectedCodeId);
        break;
      }
      case "add-code-annotation": {
        o.setCodeAnnotations((prev) => prev.filter((a) => a.id !== action.ann.id));
        o.setSelectedAnnotationId(action.prevSelectedId);
        o.setSelectedCodeAnnotationId(action.prevSelectedCodeId);
        break;
      }
      case "add-global-attachment": {
        o.setGlobalAttachments((prev) => prev.filter((p) => p.path !== action.img.path));
        break;
      }
      case "update-annotation": {
        o.setAnnotations((prev) => prev.map((a) => (a.id === action.prevAnn.id ? action.prevAnn : a)));
        if (hasHighlight(action.prevAnn) && !anchorsEqual(action.prevAnn, action.nextAnn)) {
          o.viewerRef.current?.removeHighlight(action.prevAnn.id);
          o.viewerRef.current?.applySharedAnnotations([action.prevAnn]);
        }
        break;
      }
      case "update-code-annotation": {
        o.setCodeAnnotations((prev) => prev.map((a) => (a.id === action.prevAnn.id ? action.prevAnn : a)));
        break;
      }
      case "delete-annotation": {
        o.setAnnotations((prev) => [...prev, action.ann]);
        if (hasHighlight(action.ann)) {
          o.viewerRef.current?.applySharedAnnotations([action.ann]);
        }
        o.setSelectedAnnotationId(action.prevSelectedId);
        break;
      }
      case "delete-code-annotation": {
        o.setCodeAnnotations((prev) => [...prev, action.ann]);
        o.setSelectedCodeAnnotationId(action.prevSelectedCodeId);
        break;
      }
      case "remove-global-attachment": {
        o.setGlobalAttachments((prev) => [...prev, action.img]);
        break;
      }
      case "checkbox-toggle": {
        o.applyOverrides(action.prevOverrides);
        o.setAnnotations((prev) => [
          ...prev.filter(
            (a) => !(a.blockId === action.blockId && a.id.startsWith("ann-checkbox-")),
          ),
          ...action.prevCheckboxAnns,
        ]);
        break;
      }
      case "identity-change": {
        o.setAnnotations((prev) =>
          prev.map((a) =>
            action.affectedAnnIds.includes(a.id) ? { ...a, author: action.oldIdentity } : a,
          ),
        );
        o.setCodeAnnotations((prev) =>
          prev.map((a) =>
            action.affectedCodeAnnIds.includes(a.id) ? { ...a, author: action.oldIdentity } : a,
          ),
        );
        break;
      }
    }
  };

  const applyRedo = (action: AnnotationAction) => {
    const o = getOptions();
    switch (action.kind) {
      case "add-annotation": {
        o.setAnnotations((prev) => [...prev, action.ann]);
        if (hasHighlight(action.ann)) {
          o.viewerRef.current?.applySharedAnnotations([action.ann]);
        }
        o.setSelectedAnnotationId(action.ann.id);
        o.setSelectedCodeAnnotationId(null);
        break;
      }
      case "add-code-annotation": {
        o.setCodeAnnotations((prev) => [...prev, action.ann]);
        o.setSelectedAnnotationId(null);
        o.setSelectedCodeAnnotationId(action.ann.id);
        break;
      }
      case "add-global-attachment": {
        o.setGlobalAttachments((prev) => [...prev, action.img]);
        break;
      }
      case "update-annotation": {
        o.setAnnotations((prev) => prev.map((a) => (a.id === action.nextAnn.id ? action.nextAnn : a)));
        if (hasHighlight(action.nextAnn) && !anchorsEqual(action.prevAnn, action.nextAnn)) {
          o.viewerRef.current?.removeHighlight(action.nextAnn.id);
          o.viewerRef.current?.applySharedAnnotations([action.nextAnn]);
        }
        break;
      }
      case "update-code-annotation": {
        o.setCodeAnnotations((prev) => prev.map((a) => (a.id === action.nextAnn.id ? action.nextAnn : a)));
        break;
      }
      case "delete-annotation": {
        o.viewerRef.current?.removeHighlight(action.ann.id);
        o.setAnnotations((prev) => prev.filter((a) => a.id !== action.ann.id));
        // removeAnnotation cleared selection only when the deleted ann was selected.
        o.setSelectedAnnotationId(action.prevSelectedId === action.ann.id ? null : action.prevSelectedId);
        break;
      }
      case "delete-code-annotation": {
        o.setCodeAnnotations((prev) => prev.filter((a) => a.id !== action.ann.id));
        o.setSelectedCodeAnnotationId(
          action.prevSelectedCodeId === action.ann.id ? null : action.prevSelectedCodeId,
        );
        break;
      }
      case "remove-global-attachment": {
        o.setGlobalAttachments((prev) => prev.filter((p) => p.path !== action.img.path));
        break;
      }
      case "checkbox-toggle": {
        o.applyOverrides(action.nextOverrides);
        o.setAnnotations((prev) => [
          ...prev.filter(
            (a) => !(a.blockId === action.blockId && a.id.startsWith("ann-checkbox-")),
          ),
          ...action.nextCheckboxAnns,
        ]);
        break;
      }
      case "identity-change": {
        o.setAnnotations((prev) =>
          prev.map((a) =>
            action.affectedAnnIds.includes(a.id) ? { ...a, author: action.newIdentity } : a,
          ),
        );
        o.setCodeAnnotations((prev) =>
          prev.map((a) =>
            action.affectedCodeAnnIds.includes(a.id) ? { ...a, author: action.newIdentity } : a,
          ),
        );
        break;
      }
    }
  };

  return {
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    push(action: AnnotationAction) {
      past = [...past, action].slice(-MAX_PAST);
      future = [];
      onChange();
    },
    undo() {
      const action = past.pop();
      if (!action) return;
      applyUndo(action);
      future = [...future, action];
      onChange();
    },
    redo() {
      const action = future.pop();
      if (!action) return;
      applyRedo(action);
      past = [...past, action].slice(-MAX_PAST);
      onChange();
    },
    clear() {
      past = [];
      future = [];
      onChange();
    },
    serialize(): SerializedHistory {
      return { past: [...past], future: [...future] };
    },
    restore(snapshot: SerializedHistory | undefined) {
      past = snapshot ? [...snapshot.past] : [];
      future = snapshot ? [...snapshot.future] : [];
      onChange();
    },
  };
}
