/**
 * Unit tests for useAnnotationHistory (apps/pi-extension/UNDO_SPEC.md §7.1).
 *
 * These drive the pure controller with fake setters and a fake ViewerHandle so we can
 * assert both state transitions and the imperative DOM-highlight calls the
 * inverses rely on. No DOM is required, so this runs under default `bun test`.
 */

import { describe, expect, test } from "bun:test";

import {
  createAnnotationHistoryController,
  type AnnotationAction,
  type AnnotationHistoryApi,
  type OverrideSnapshot,
  type UseAnnotationHistoryOptions,
} from "./useAnnotationHistory";
import { AnnotationType } from "../types";
import type { Annotation, CodeAnnotation, ImageAttachment } from "../types";
import type { ViewerHandle } from "../components/Viewer";

// ─── helpers ────────────────────────────────────────────────────────────────

function ann(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    blockId: "block-1",
    startOffset: 0,
    endOffset: 5,
    type: AnnotationType.COMMENT,
    originalText: "hello",
    createdA: 1,
    ...overrides,
  };
}

function codeAnn(id: string, overrides: Partial<CodeAnnotation> = {}): CodeAnnotation {
  return {
    id,
    type: "comment",
    scope: "line",
    filePath: "a.ts",
    lineStart: 1,
    lineEnd: 2,
    side: "new",
    createdAt: 1,
    ...overrides,
  };
}

function img(path: string): ImageAttachment {
  return { path, name: path };
}

interface FakeState {
  annotations: Annotation[];
  codeAnnotations: CodeAnnotation[];
  globalAttachments: ImageAttachment[];
  selectedAnnotationId: string | null;
  selectedCodeAnnotationId: string | null;
  overrides: OverrideSnapshot;
}

function makeFakeViewer() {
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
      state.codeAnnotations =
        typeof next === "function" ? (next as (p: CodeAnnotation[]) => CodeAnnotation[])(state.codeAnnotations) : next;
    },
    setGlobalAttachments: (next) => {
      state.globalAttachments =
        typeof next === "function"
          ? (next as (p: ImageAttachment[]) => ImageAttachment[])(state.globalAttachments)
          : next;
    },
    viewerRef: { current: viewer },
    applyOverrides: (next: OverrideSnapshot) => {
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

function mountHistory(options: UseAnnotationHistoryOptions): {
  api: AnnotationHistoryApi;
  unmount: () => void;
} {
  return {
    api: createAnnotationHistoryController(() => options),
    unmount: () => {},
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("useAnnotationHistory", () => {
  test("add-annotation: undo removes it and restores selection; redo re-adds + re-highlights", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer, calls } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    const a = ann("a1", { type: AnnotationType.DELETION });
    state.annotations = [...state.annotations, a];
    state.selectedAnnotationId = "a1";
    state.selectedCodeAnnotationId = null;
    api.push({ kind: "add-annotation", ann: a, prevSelectedId: null, prevSelectedCodeId: null });
    expect(api.canUndo).toBe(true);
    expect(api.canRedo).toBe(false);

    api.undo();
    expect(state.annotations).toEqual([]);
    expect(state.selectedAnnotationId).toBe(null);
    expect(calls.some((c) => c.fn === "removeHighlight" && c.arg === "a1")).toBe(true);
    expect(api.canUndo).toBe(false);
    expect(api.canRedo).toBe(true);

    calls.length = 0;
    api.redo();
    expect(state.annotations).toEqual([a]);
    expect(state.selectedAnnotationId).toBe("a1");
    expect(calls.some((c) => c.fn === "applySharedAnnotations")).toBe(true);

    unmount();
  });

  test("add-code-annotation: undo removes + restores selection; redo re-adds", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    const ca = codeAnn("c1");
    state.codeAnnotations = [ca];
    state.selectedCodeAnnotationId = "c1";
    api.push({ kind: "add-code-annotation", ann: ca, prevSelectedId: null, prevSelectedCodeId: null });

    api.undo();
    expect(state.codeAnnotations).toEqual([]);
    expect(state.selectedCodeAnnotationId).toBe(null);

    api.redo();
    expect(state.codeAnnotations).toEqual([ca]);
    expect(state.selectedCodeAnnotationId).toBe("c1");
    unmount();
  });

  test("delete-annotation: undo re-adds and re-applies highlight; redo removes", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: "a1",
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer, calls } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    const a = ann("a1", { originalText: "marked text" });
    state.annotations = [];
    state.selectedAnnotationId = null;
    api.push({ kind: "delete-annotation", ann: a, prevSelectedId: "a1" });

    api.undo();
    expect(state.annotations).toEqual([a]);
    expect(state.selectedAnnotationId).toBe("a1");
    expect(calls.some((c) => c.fn === "applySharedAnnotations")).toBe(true);

    calls.length = 0;
    api.redo();
    expect(state.annotations).toEqual([]);
    expect(calls.some((c) => c.fn === "removeHighlight" && c.arg === "a1")).toBe(true);
    unmount();
  });

  test("delete-code-annotation: undo re-adds; redo removes", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: "c1",
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    const ca = codeAnn("c1");
    state.codeAnnotations = [];
    state.selectedCodeAnnotationId = null;
    api.push({ kind: "delete-code-annotation", ann: ca, prevSelectedCodeId: "c1" });

    api.undo();
    expect(state.codeAnnotations).toEqual([ca]);
    expect(state.selectedCodeAnnotationId).toBe("c1");

    api.redo();
    expect(state.codeAnnotations).toEqual([]);
    expect(state.selectedCodeAnnotationId).toBe(null);
    unmount();
  });

  test("update-annotation: undo reverts fields; redo re-applies", () => {
    const state: FakeState = {
      annotations: [ann("a1", { text: "old" })],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: "a1",
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    const prevAnn = ann("a1", { text: "old" });
    const nextAnn = ann("a1", { text: "new" });
    state.annotations = [nextAnn];
    api.push({ kind: "update-annotation", prevAnn, nextAnn });

    api.undo();
    expect(state.annotations[0].text).toBe("old");

    api.redo();
    expect(state.annotations[0].text).toBe("new");
    unmount();
  });

  test("update-code-annotation: undo reverts; redo re-applies", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [codeAnn("c1", { text: "old" })],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: "c1",
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    const prevAnn = codeAnn("c1", { text: "old" });
    const nextAnn = codeAnn("c1", { text: "new" });
    state.codeAnnotations = [nextAnn];
    api.push({ kind: "update-code-annotation", prevAnn, nextAnn });

    api.undo();
    expect(state.codeAnnotations[0].text).toBe("old");
    api.redo();
    expect(state.codeAnnotations[0].text).toBe("new");
    unmount();
  });

  test("add/remove-global-attachment round-trip", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    const i = img("x.png");
    state.globalAttachments = [i];
    api.push({ kind: "add-global-attachment", img: i });
    api.undo();
    expect(state.globalAttachments).toEqual([]);
    api.redo();
    expect(state.globalAttachments).toEqual([i]);

    state.globalAttachments = [];
    api.push({ kind: "remove-global-attachment", img: i });
    api.undo();
    expect(state.globalAttachments).toEqual([i]);
    api.redo();
    expect(state.globalAttachments).toEqual([]);
    unmount();
  });

  test("checkbox-toggle: undo restores overrides + checkbox annotations", () => {
    const prevCheckboxAnns = [ann("ann-checkbox-b1-1", { blockId: "b1" })];
    const nextCheckboxAnns = [ann("ann-checkbox-b1-2", { blockId: "b1" })];
    const prevOverrides: OverrideSnapshot = [];
    const nextOverrides: OverrideSnapshot = [["b1", true]];
    const state: FakeState = {
      annotations: [...nextCheckboxAnns],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: nextOverrides,
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    api.push({
      kind: "checkbox-toggle",
      blockId: "b1",
      prevOverrides,
      nextOverrides,
      prevCheckboxAnns,
      nextCheckboxAnns,
    });

    api.undo();
    expect(state.overrides).toEqual(prevOverrides);
    expect(state.annotations).toEqual(prevCheckboxAnns);

    api.redo();
    expect(state.overrides).toEqual(nextOverrides);
    expect(state.annotations).toEqual(nextCheckboxAnns);
    unmount();
  });

  test("identity-change: undo restores old author; redo re-applies new", () => {
    const state: FakeState = {
      annotations: [ann("a1", { author: "new" }), ann("a2", { author: "other" })],
      codeAnnotations: [codeAnn("c1", { author: "new" })],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    api.push({
      kind: "identity-change",
      oldIdentity: "old",
      newIdentity: "new",
      affectedAnnIds: ["a1"],
      affectedCodeAnnIds: ["c1"],
    });

    api.undo();
    expect(state.annotations[0].author).toBe("old");
    expect(state.annotations[1].author).toBe("other");
    expect(state.codeAnnotations[0].author).toBe("old");

    api.redo();
    expect(state.annotations[0].author).toBe("new");
    expect(state.codeAnnotations[0].author).toBe("new");
    unmount();
  });

  test("push clears the redo stack", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    const a = ann("a1");
    state.annotations = [a];
    api.push({ kind: "add-annotation", ann: a, prevSelectedId: null, prevSelectedCodeId: null });
    api.undo();
    expect(api.canRedo).toBe(true);

    const b = ann("a2");
    state.annotations = [b];
    api.push({ kind: "add-annotation", ann: b, prevSelectedId: null, prevSelectedCodeId: null });
    expect(api.canRedo).toBe(false);
    expect(api.canUndo).toBe(true);
    unmount();
  });

  test("bounded past cap drops oldest entries", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    for (let i = 0; i < 60; i++) {
      const a = ann(`a${i}`);
      api.push({ kind: "add-annotation", ann: a, prevSelectedId: null, prevSelectedCodeId: null });
    }
    // cap is 50; undo should be possible 50 times, not 60.
    let undos = 0;
    while (api.canUndo) {
      api.undo();
      undos++;
    }
    expect(undos).toBe(50);
    unmount();
  });

  test("clear empties both stacks", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    const a = ann("a1");
    api.push({ kind: "add-annotation", ann: a, prevSelectedId: null, prevSelectedCodeId: null });
    api.undo();
    expect(api.canUndo).toBe(false);
    expect(api.canRedo).toBe(true);

    api.clear();
    expect(api.canUndo).toBe(false);
    expect(api.canRedo).toBe(false);
    unmount();
  });

  test("serialize/restore round-trip preserves past and future", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    const a = ann("a1");
    const b = ann("a2");
    api.push({ kind: "add-annotation", ann: a, prevSelectedId: null, prevSelectedCodeId: null });
    api.push({ kind: "add-annotation", ann: b, prevSelectedId: null, prevSelectedCodeId: null });
    api.undo(); // past=[a], future=[b]
    const snapshot = api.serialize();
    expect(snapshot.past).toHaveLength(1);
    expect(snapshot.future).toHaveLength(1);

    api.clear();
    expect(api.canUndo).toBe(false);

    api.restore(snapshot);
    expect(api.canUndo).toBe(true);
    expect(api.canRedo).toBe(true);
    // undo the remaining past entry -> back to empty
    api.undo();
    expect(api.canUndo).toBe(false);
    unmount();
  });

  test("restore(undefined) clears", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    api.push({ kind: "add-annotation", ann: ann("a1"), prevSelectedId: null, prevSelectedCodeId: null });
    api.restore(undefined);
    expect(api.canUndo).toBe(false);
    expect(api.canRedo).toBe(false);
    unmount();
  });

  test("undo/redo with empty stacks is a no-op", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    expect(() => {
      api.undo();
      api.redo();
    }).not.toThrow();
    expect(api.canUndo).toBe(false);
    expect(api.canRedo).toBe(false);
    unmount();
  });

  test("multi-step: add three, undo all, redo all", () => {
    const state: FakeState = {
      annotations: [],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: null,
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    const ids = ["a1", "a2", "a3"];
    for (const id of ids) {
      const a = ann(id);
      state.annotations = [...state.annotations, a];
      api.push({ kind: "add-annotation", ann: a, prevSelectedId: null, prevSelectedCodeId: null });
    }
    expect(state.annotations.map((a) => a.id)).toEqual(ids);

    api.undo();
    api.undo();
    api.undo();
    expect(state.annotations).toEqual([]);

    api.redo();
    api.redo();
    api.redo();
    expect(state.annotations.map((a) => a.id)).toEqual(ids);
    unmount();
  });

  test("update-annotation anchor change re-applies highlight on undo and redo", () => {
    const state: FakeState = {
      annotations: [ann("a1", { originalText: "old", blockId: "b1" })],
      codeAnnotations: [],
      globalAttachments: [],
      selectedAnnotationId: "a1",
      selectedCodeAnnotationId: null,
      overrides: [],
    };
    const { viewer, calls } = makeFakeViewer();
    const { api, unmount } = mountHistory(makeOptions(state, viewer));

    const prevAnn = ann("a1", { originalText: "old", blockId: "b1" });
    const nextAnn = ann("a1", { originalText: "new", blockId: "b2" });
    state.annotations = [nextAnn];
    api.push({ kind: "update-annotation", prevAnn, nextAnn });

    calls.length = 0;
    api.undo();
    expect(calls.some((c) => c.fn === "applySharedAnnotations")).toBe(true);

    calls.length = 0;
    api.redo();
    expect(calls.some((c) => c.fn === "applySharedAnnotations")).toBe(true);
    unmount();
  });
});
