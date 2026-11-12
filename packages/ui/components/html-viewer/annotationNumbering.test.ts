import { describe, expect, test } from "bun:test";
import type { Annotation } from "../../types";
import { AnnotationType } from "../../types";
import { exportAnnotations } from "../../utils/parser";
import { MAX_SYNC_ANNOTATIONS, buildSyncNumbering } from "./annotationNumbering";

function htmlComment(id: string, createdA: number, originalText: string): Annotation {
  return {
    id,
    blockId: "",
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: `note about ${originalText}`,
    originalText,
    createdA,
  } as Annotation;
}

function globalComment(id: string, createdA: number, text: string): Annotation {
  return {
    id,
    blockId: "",
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.GLOBAL_COMMENT,
    text,
    originalText: "",
    createdA,
  } as Annotation;
}

function exportNumberOf(output: string, needle: string): number {
  const sections = output.split(/^## /m).slice(1);
  const section = sections.find((s) => s.includes(needle));
  if (!section) throw new Error(`no export section contains: ${needle}`);
  return Number.parseInt(section, 10);
}

describe("buildSyncNumbering", () => {
  test("a mixed list yields on-page numbers identical to exportAnnotations output", () => {
    const annotations = [
      htmlComment("ann-a", 100, "alpha passage"),
      globalComment("glob", 200, "overall global note"),
      htmlComment("ann-b", 300, "beta passage"),
    ];

    const payload = buildSyncNumbering(annotations);
    expect(payload).toEqual([
      { id: "ann-a", number: 1 },
      { id: "ann-b", number: 3 },
    ]);

    const output = exportAnnotations([], annotations, [], "Plan Feedback", "plan");
    expect(exportNumberOf(output, "alpha passage")).toBe(1);
    expect(exportNumberOf(output, "overall global note")).toBe(2);
    expect(exportNumberOf(output, "beta passage")).toBe(3);

    const needleById: Record<string, string> = {
      "ann-a": "alpha passage",
      "ann-b": "beta passage",
    };
    for (const entry of payload) {
      expect(exportNumberOf(output, needleById[entry.id]!)).toBe(entry.number);
    }
  });

  test("interleaved external annotations: numbers follow ARRAY order and agree with the export", () => {
    const external = {
      ...htmlComment("ext", 200, "external passage"),
      source: "eslint",
    } as Annotation;
    const annotations = [
      htmlComment("loc-a", 100, "alpha passage"),
      htmlComment("loc-b", 300, "beta passage"),
      external,
    ];

    const payload = buildSyncNumbering(annotations);
    expect(payload).toEqual([
      { id: "loc-a", number: 1 },
      { id: "loc-b", number: 2 },
      { id: "ext", number: 3 },
    ]);

    const output = exportAnnotations([], annotations, [], "Plan Feedback", "plan");
    expect(exportNumberOf(output, "alpha passage")).toBe(1);
    expect(exportNumberOf(output, "beta passage")).toBe(2);
    expect(exportNumberOf(output, "external passage")).toBe(3);
    const needleById: Record<string, string> = {
      "loc-a": "alpha passage",
      "loc-b": "beta passage",
      ext: "external passage",
    };
    for (const entry of payload) {
      expect(exportNumberOf(output, needleById[entry.id]!)).toBe(entry.number);
    }
  });

  test("the entry cap applies AFTER dropping globals, so globals never waste sync capacity", () => {
    const annotations: Annotation[] = [
      globalComment("glob", 0, "leading global"),
      ...Array.from({ length: MAX_SYNC_ANNOTATIONS + 1 }, (_, i) =>
        htmlComment(`bulk-${i}`, i + 1, `passage ${i}`),
      ),
    ];
    const payload = buildSyncNumbering(annotations);
    expect(payload.length).toBe(MAX_SYNC_ANNOTATIONS);
    expect(payload[0]).toEqual({ id: "bulk-0", number: 2 });
    expect(payload[MAX_SYNC_ANNOTATIONS - 1]).toEqual({
      id: `bulk-${MAX_SYNC_ANNOTATIONS - 1}`,
      number: MAX_SYNC_ANNOTATIONS + 1,
    });
  });
});
