import { describe, expect, test } from "bun:test";
import { findLastUndoRemovableAnnotation, isUndoRemovableAnnotation } from "./annotationUndo";
import { AnnotationType, type Annotation } from "../types";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann-1",
    blockId: "block-1",
    startOffset: 0,
    endOffset: 5,
    type: AnnotationType.DELETION,
    originalText: "hello",
    createdA: 1,
    ...overrides,
  };
}

describe("annotationUndo", () => {
  test("treats empty local deletion annotations as undo-removable", () => {
    expect(
      isUndoRemovableAnnotation(
        makeAnnotation({ type: AnnotationType.DELETION }),
      ),
    ).toBe(true);
  });

  test("does not treat annotations with user-written content as undo-removable", () => {
    expect(
      isUndoRemovableAnnotation(
        makeAnnotation({
          id: "ann-2",
          type: AnnotationType.COMMENT,
          text: "needs work",
        }),
      ),
    ).toBe(false);

    expect(
      isUndoRemovableAnnotation(
        makeAnnotation({
          id: "ann-3",
          type: AnnotationType.COMMENT,
          text: "👍 Looks good",
          isQuickLabel: true,
        }),
      ),
    ).toBe(false);

    expect(
      isUndoRemovableAnnotation(
        makeAnnotation({
          id: "ann-4",
          type: AnnotationType.GLOBAL_COMMENT,
          text: "general feedback",
        }),
      ),
    ).toBe(false);

    expect(
      isUndoRemovableAnnotation(
        makeAnnotation({
          id: "ann-5",
          type: AnnotationType.DELETION,
          images: [{ path: "/tmp/mock.png", name: "mock" }],
        }),
      ),
    ).toBe(false);
  });

  test("finds the newest undo-removable local annotation", () => {
    const annotations: Annotation[] = [
      makeAnnotation({
        id: "ann-1",
        type: AnnotationType.COMMENT,
        text: "keep this comment",
        createdA: 1,
      }),
      makeAnnotation({
        id: "ann-2",
        type: AnnotationType.DELETION,
        source: "eslint",
        createdA: 2,
      }),
      makeAnnotation({
        id: "ann-3",
        type: AnnotationType.DELETION,
        createdA: 3,
      }),
    ];

    expect(findLastUndoRemovableAnnotation(annotations)?.id).toBe("ann-3");
  });

  test("returns null when every annotation has user content or is external", () => {
    const annotations: Annotation[] = [
      makeAnnotation({
        id: "ann-1",
        type: AnnotationType.COMMENT,
        text: "keep this",
      }),
      makeAnnotation({
        id: "ann-2",
        type: AnnotationType.GLOBAL_COMMENT,
        text: "keep this too",
      }),
      makeAnnotation({
        id: "ann-3",
        type: AnnotationType.DELETION,
        source: "eslint",
      }),
    ];

    expect(findLastUndoRemovableAnnotation(annotations)).toBeNull();
  });
});
