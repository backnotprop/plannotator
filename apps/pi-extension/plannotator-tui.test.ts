import { describe, expect, test } from "bun:test";
import { formatTuiFeedback } from "./plannotator-tui.ts";
import type { TuiAnnotation } from "./plannotator-tui.ts";

describe("TUI plan-review feedback", () => {
  test("formats a looks-good annotation with a line number derived from the prefix", () => {
    const annotations: TuiAnnotation[] = [
      {
        anchor: {
          originalText: "Do the t",
          plannotator_tui: {
            kind: "looks_good",
            prefix: "# Smoke Test Plan\n\n## Step 1\n",
          },
        },
        body: "",
      },
    ];
    expect(formatTuiFeedback("D:\\plan\\plan.md", annotations)).toBe(
      "# Annotations on plan.md\n\n## Annotation 1 (line 4)\nLooks good: \"Do the t\"\n\n",
    );
  });

  test("includes the comment body when present", () => {
    const annotations: TuiAnnotation[] = [
      {
        anchor: {
          originalText: "the thing",
          plannotator_tui: { kind: "comment", prefix: "# Title\n" },
        },
        body: "Too vague — which thing?",
      },
    ];
    const feedback = formatTuiFeedback("plan.md", annotations);
    expect(feedback).toContain("## Annotation 1 (line 2)");
    expect(feedback).toContain("Comment: \"the thing\"");
    expect(feedback).toContain("Too vague — which thing?");
  });

  test("falls back to Note for unknown kinds and handles a missing quote", () => {
    const annotations: TuiAnnotation[] = [{ anchor: { plannotator_tui: { kind: "mystery" } } }];
    expect(formatTuiFeedback("plan.md", annotations)).toBe(
      "# Annotations on plan.md\n\n## Annotation 1 (line 1)\nNote\n\n",
    );
  });
});
