/**
 * Integration tests for undo → feedback-export invariant
 * (apps/pi-extension/UNDO_SPEC.md §7.2).
 *
 * Combines the REAL annotation-history controller with the REAL
 * `exportAnnotations` / `parseMarkdownToBlocks` production code to prove the
 * v1 core promise: undoing an accidental deletion or misassigned comment
 * removes it from the feedback text delivered to the agent.
 */

import { describe, expect, test } from "bun:test";

import {
  createAnnotationHistoryController,
  type AnnotationHistoryApi,
  type UseAnnotationHistoryOptions,
} from "@plannotator/ui/hooks/useAnnotationHistory";
import { exportAnnotations, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import { AnnotationType } from "@plannotator/ui/types";
import type { Annotation, CodeAnnotation, ImageAttachment } from "@plannotator/ui/types";
import type { ViewerHandle } from "@plannotator/ui/components/Viewer";

const PLAN = `# Plan\n\nImplement the feature.\n\n- [ ] Step one\n- [ ] Step two\n\nSome risky section to delete.\n`;

interface FakeState {
  annotations: Annotation[];
  codeAnnotations: CodeAnnotation[];
  globalAttachments: ImageAttachment[];
  selectedAnnotationId: string | null;
  selectedCodeAnnotationId: string | null;
  overrides: Array<[string, boolean]>;
}

function makeViewer() {
  const calls: { fn: string; arg: unknown }[] = [];
  const viewer = {
    removeHighlight: (id: string) => calls.push({ fn: "removeHighlight", arg: id }),
    clearAllHighlights: () => calls.push({ fn: "clearAllHighlights", arg: null }),
    applySharedAnnotations: (a: Annotation[]) => calls.push({ fn: "applySharedAnnotations", arg: a }),
  } as unknown as ViewerHandle;
  return { viewer, calls };
}

function makeOptions(state: FakeState, viewer: ViewerHandle): UseAnnotationHistoryOptions {
  return {
    setAnnotations: (next) => {
      state.annotations = typeof next === "function" ? (next as (p: Annotation[]) => Annotation[])(state.annotations) : next;
    },
    setCodeAnnotations: (next) => {
      state.codeAnnotations = typeof next === "function" ? (next as (p: CodeAnnotation[]) => CodeAnnotation[])(state.codeAnnotations) : next;
    },
    setGlobalAttachments: (next) => {
      state.globalAttachments = typeof next === "function" ? (next as (p: ImageAttachment[]) => ImageAttachment[])(state.globalAttachments) : next;
    },
    viewerRef: { current: viewer },
    applyOverrides: (next) => {
      state.overrides = next;
    },
    getSelectedAnnotationId: () => state.selectedAnnotationId,
    setSelectedAnnotationId: (id) => {
      state.selectedAnnotationId = id;
    },
    getSelectedCodeAnnotationId: () => state.selectedCodeAnnotationId,
    setSelectedCodeAnnotationId: (id) => {
      state.selectedCodeAnnotationId = id;
    },
  };
}

function mount(options: UseAnnotationHistoryOptions): { api: AnnotationHistoryApi; unmount: () => void } {
  return {
    api: createAnnotationHistoryController(() => options),
    unmount: () => {},
  };
}

describe("undo → feedback export integration", () => {
  test("undoing an accidental DELETION removes it from exported feedback", () => {
    const blocks = parseMarkdownToBlocks(PLAN);
    const target = blocks.find((b) => b.content.includes("risky section"))!;
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeViewer();
    const { api, unmount } = mount(makeOptions(state, viewer));

    // User marks the section for deletion.
    const deletion: Annotation = {
      id: "del-1",
      blockId: target.id,
      startOffset: 0,
      endOffset: target.content.length,
      type: AnnotationType.DELETION,
      originalText: "Some risky section to delete.",
      createdA: 1,
    };
    state.annotations = [deletion];
    state.selectedAnnotationId = "del-1";
    api.push({ kind: "add-annotation", ann: deletion, prevSelectedId: null, prevSelectedCodeId: null });

    // Before undo: feedback contains "Remove this".
    expect(exportAnnotations(blocks, state.annotations)).toContain("Remove this");

    // Undo the accidental negative feedback.
    api.undo();
    expect(state.annotations).toEqual([]);

    // After undo: no deletion reaches the agent.
    const after = exportAnnotations(blocks, state.annotations);
    expect(after).not.toContain("Remove this");
    expect(after).toContain("No changes detected.");

    unmount();
  });

  test("undoing a misassigned COMMENT leaves no trace in exported feedback", () => {
    const blocks = parseMarkdownToBlocks(PLAN);
    const wrong = blocks.find((b) => b.content.includes("Implement the feature"))!;
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeViewer();
    const { api, unmount } = mount(makeOptions(state, viewer));

    // User comments on the WRONG text (misassigned).
    const misassigned: Annotation = {
      id: "c-1",
      blockId: wrong.id,
      startOffset: 0,
      endOffset: wrong.content.length,
      type: AnnotationType.COMMENT,
      text: "Out of scope",
      originalText: "Implement the feature.",
      isQuickLabel: true,
      createdA: 1,
    };
    state.annotations = [misassigned];
    api.push({ kind: "add-annotation", ann: misassigned, prevSelectedId: null, prevSelectedCodeId: null });

    expect(exportAnnotations(blocks, state.annotations)).toContain("Feedback on:");
    expect(exportAnnotations(blocks, state.annotations)).toContain("Implement the feature.");

    // Undo the misassigned comment.
    api.undo();
    expect(state.annotations).toEqual([]);

    const after = exportAnnotations(blocks, state.annotations);
    expect(after).not.toContain("Feedback on:");
    expect(after).not.toContain("Implement the feature.");
    expect(after).toContain("No changes detected.");

    // Redo re-applies it exactly.
    api.redo();
    expect(state.annotations).toEqual([misassigned]);
    expect(exportAnnotations(blocks, state.annotations)).toContain("Feedback on:");

    unmount();
  });

  test("delete-then-undo re-adds the annotation so it reappears in feedback", () => {
    const blocks = parseMarkdownToBlocks(PLAN);
    const target = blocks.find((b) => b.content.includes("Step one"))!;
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: "c-1",
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer, calls } = makeViewer();
    const { api, unmount } = mount(makeOptions(state, viewer));

    const comment: Annotation = {
      id: "c-1",
      blockId: target.id,
      startOffset: 0,
      endOffset: target.content.length,
      type: AnnotationType.COMMENT,
      text: "Clarify this",
      originalText: "Step one",
      createdA: 1,
    };
    // The annotation existed; user deletes it from the panel.
    state.annotations = [];
    state.selectedAnnotationId = null;
    api.push({ kind: "delete-annotation", ann: comment, prevSelectedId: "c-1" });

    expect(exportAnnotations(blocks, state.annotations)).toContain("No changes detected.");

    // Undo: annotation re-added and DOM highlight re-applied.
    api.undo();
    expect(state.annotations).toEqual([comment]);
    expect(calls.some((c) => c.fn === "applySharedAnnotations")).toBe(true);
    expect(exportAnnotations(blocks, state.annotations)).toContain("Feedback on:");
    expect(exportAnnotations(blocks, state.annotations)).toContain("Clarify this");

    unmount();
  });

  test("checkbox-toggle undo restores the override and the checkbox annotation", () => {
    const blocks = parseMarkdownToBlocks(PLAN);
    const checkboxBlock = blocks.find((b) => b.checked !== undefined)!;
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [["blk-x", true]],
    };
    const { viewer } = makeViewer();
    const { api, unmount } = mount(makeOptions(state, viewer));

    const prevCheckboxAnns: Annotation[] = [];
    const nextCheckboxAnns: Annotation[] = [
      {
        id: `ann-checkbox-${checkboxBlock.id}-${Date.now()}`,
        blockId: checkboxBlock.id,
        startOffset: 0,
        endOffset: checkboxBlock.content.length,
        type: AnnotationType.COMMENT,
        text: "Mark as completed: Step one",
        originalText: checkboxBlock.content,
        createdA: 1,
      },
    ];
    state.annotations = [...nextCheckboxAnns];
    api.push({
      kind: "checkbox-toggle",
      blockId: checkboxBlock.id,
      prevOverrides: [],
      nextOverrides: [["blk-x", true]],
      prevCheckboxAnns,
      nextCheckboxAnns,
    });

    expect(exportAnnotations(blocks, state.annotations)).toContain("Mark as completed");

    api.undo();
    expect(state.overrides).toEqual([]);
    expect(state.annotations).toEqual([]);
    expect(exportAnnotations(blocks, state.annotations)).toContain("No changes detected.");

    unmount();
  });

  test("multi-step: three annotations, undo all, redo all — feedback matches each step", () => {
    const blocks = parseMarkdownToBlocks(PLAN);
    const a = blocks.find((b) => b.content.includes("Implement"))!;
    const b = blocks.find((b) => b.content.includes("risky"))!;
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeViewer();
    const { api, unmount } = mount(makeOptions(state, viewer));

    const anns: Annotation[] = [
      { id: "1", blockId: a.id, startOffset: 0, endOffset: a.content.length, type: AnnotationType.COMMENT, text: "q1", originalText: a.content, createdA: 1 },
      { id: "2", blockId: b.id, startOffset: 0, endOffset: b.content.length, type: AnnotationType.DELETION, originalText: b.content, createdA: 2 },
      { id: "3", blockId: a.id, startOffset: 0, endOffset: a.content.length, type: AnnotationType.COMMENT, text: "q2", originalText: a.content, createdA: 3 },
    ];
    for (const x of anns) {
      state.annotations = [...state.annotations, x];
      api.push({ kind: "add-annotation", ann: x, prevSelectedId: null, prevSelectedCodeId: null });
    }
    expect(state.annotations).toHaveLength(3);

    api.undo();
    api.undo();
    api.undo();
    expect(state.annotations).toEqual([]);
    expect(exportAnnotations(blocks, state.annotations)).toContain("No changes detected.");

    api.redo();
    api.redo();
    api.redo();
    expect(state.annotations.map((x) => x.id)).toEqual(["1", "2", "3"]);
    const out = exportAnnotations(blocks, state.annotations);
    expect(out).toContain("Remove this");
    expect(out).toContain("q1");
    expect(out).toContain("q2");

    unmount();
  });
});
