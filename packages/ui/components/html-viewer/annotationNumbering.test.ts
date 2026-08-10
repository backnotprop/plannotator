/**
 * On-page marker numbers must agree with the numbers the agent reads:
 * exportAnnotations (packages/ui/utils/parser.ts) numbers `## N.` sections
 * across the FULL annotation list including global comments, so the sync
 * payload must derive each marker's number from that same ordering. A sync
 * that excludes globals BEFORE numbering makes on-page "Comment 2" read
 * `## 3.` in the feedback — the exact confusion this suite guards against.
 */
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

/** The `## N.` number of the export section containing `needle`. */
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
    // Globals occupy a number but ship no entry (no page location): the
    // on-page markers show 1 and 3, leaving the gap where the global sits.
    expect(payload).toEqual([
      { id: "ann-a", number: 1 },
      { id: "ann-b", number: 3 },
    ]);

    const output = exportAnnotations([], annotations, [], "Plan Feedback", "plan");
    expect(exportNumberOf(output, "alpha passage")).toBe(1);
    expect(exportNumberOf(output, "overall global note")).toBe(2);
    expect(exportNumberOf(output, "beta passage")).toBe(3);

    // The payload numbers ARE the export numbers, entry by entry.
    const needleById: Record<string, string> = {
      "ann-a": "alpha passage",
      "ann-b": "beta passage",
    };
    for (const entry of payload) {
      expect(exportNumberOf(output, needleById[entry.id]!)).toBe(entry.number);
    }
  });

  test("numbers follow createdA order, not array order", () => {
    const annotations = [
      htmlComment("late", 300, "late passage"),
      globalComment("glob", 100, "first global"),
      htmlComment("early", 200, "early passage"),
    ];
    expect(buildSyncNumbering(annotations)).toEqual([
      { id: "early", number: 2 },
      { id: "late", number: 3 },
    ]);
  });

  test("truncates AFTER the stable sort at the bridge cap", () => {
    const annotations = Array.from({ length: MAX_SYNC_ANNOTATIONS + 8 }, (_, i) =>
      htmlComment(`bulk-${i}`, 1000 - i, `passage ${i}`),
    );
    const payload = buildSyncNumbering(annotations);
    expect(payload.length).toBe(MAX_SYNC_ANNOTATIONS);
    // Oldest annotation (highest index, lowest createdA) survives as number 1.
    expect(payload[0]).toEqual({ id: `bulk-${MAX_SYNC_ANNOTATIONS + 7}`, number: 1 });
    expect(payload[MAX_SYNC_ANNOTATIONS - 1]).toEqual({
      id: "bulk-8",
      number: MAX_SYNC_ANNOTATIONS,
    });
  });
});
