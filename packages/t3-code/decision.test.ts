import { describe, expect, test } from "bun:test";
// The Claude Code mod's own delivery rules: T3 words its decisions the same way.
// (Test-only import; product code never reaches into the mod.)
import { deliveryFor, type HostResultRecord } from "../../apps/hook/hooks/mod/delivery";
import { t3Decision, type T3HostResult } from "./decision";

const directory = "/data/t3-code/env/threads/thread/reviews/pn-abc123";
const overflowPath = `${directory}/feedback.md`;
const target = "/repo/notes.md";

function both(record: T3HostResult, kind: "annotate" | "review" | "last", options: { gate?: boolean } = {}) {
  const t3 = t3Decision(record, { kind, subject: "notes.md", sessionId: "pn-abc123", target, gate: options.gate, directory });
  const mod = deliveryFor(record as HostResultRecord, { subject: "notes.md", sessionId: "pn-abc123", overflowPath, target, deliverApproval: options.gate });
  return { t3, mod };
}

describe("T3 decision messages match the Claude Code mod's", () => {
  const cases: Array<[string, T3HostResult, "annotate" | "review" | "last", { gate?: boolean }?]> = [
    ["code review feedback", { v: 1, surface: "review", decision: "annotated", message: "Fix the loop.", noop: false, annotationCount: 3 }, "review"],
    ["one comment is singular", { v: 1, surface: "review", decision: "annotated", message: "Fix it.", noop: false, annotationCount: 1 }, "review"],
    ["description-only review feedback", { v: 1, surface: "review", decision: "annotated", message: "PR description note", noop: false, annotationCount: 0 }, "review"],
    ["review LGTM is only logged", { v: 1, surface: "review", decision: "approved", message: "", noop: true }, "review"],
    ["review approved with notes", { v: 1, surface: "review", decision: "approved", message: "Nit: rename.", noop: false, annotationCount: 2 }, "review"],
    ["annotate feedback", { v: 1, surface: "annotate", decision: "annotated", message: "Shorten.", noop: false, annotationCount: 2, target }, "annotate"],
    ["annotate Done with nothing to send", { v: 1, surface: "annotate", decision: "annotated", message: "", noop: true }, "annotate"],
    ["ungated bare approval is only logged", { v: 1, surface: "annotate", decision: "approved", message: "", noop: true }, "annotate"],
    ["gated bare approval is sent", { v: 1, surface: "annotate", decision: "approved", message: "", noop: true }, "annotate", { gate: true }],
    ["last-message feedback", { v: 1, surface: "annotate-last", decision: "annotated", message: "Too long.", noop: false, annotationCount: 1 }, "last"],
    ["oversized feedback goes to feedback.md", { v: 1, surface: "review", decision: "annotated", message: "x".repeat(130_000), noop: false, annotationCount: 4 }, "review"],
  ];
  for (const [name, record, kind, options] of cases) {
    test(name, () => {
      const { t3, mod } = both(record, kind, options);
      if (mod.action === "submit") {
        expect(t3).toEqual({ action: "send", text: mod.text, ...(mod.overflow ? { overflow: mod.overflow } : {}) });
      } else {
        expect(t3.action).toBe("log");
      }
    });
  }

  test("Close sends nothing, the agent's close included", () => {
    for (const closedBy of [undefined, "agent" as const]) {
      expect(t3Decision({ v: 1, surface: "review", decision: "dismissed", message: "", noop: true, ...(closedBy ? { closedBy } : {}) },
        { kind: "review", subject: "changes", sessionId: "pn-abc123", directory }).action).toBe("log");
    }
  });

  test("every sent message fits T3's 120,000-character cap", () => {
    // What regresses: feedback over the cap was retried forever.
    const { t3 } = both({ v: 1, surface: "annotate", decision: "annotated", message: "y".repeat(500_000), noop: false, annotationCount: 9 }, "annotate");
    expect(t3.action).toBe("send");
    if (t3.action !== "send") return;
    expect(t3.text.length).toBeLessThan(120_000);
    expect(t3.text).toContain(`Read all of it with the Read tool before you continue: ${overflowPath}`);
    expect(t3.overflow).toEqual({ path: overflowPath, text: `${"y".repeat(500_000)}\n` });
  });

  test("a review posted to the PR platform keeps its status line (the mod only logs it)", () => {
    const status = "Pull request reviewed on GitHub: 2 comments posted.";
    const { t3, mod } = both({ v: 1, surface: "review", decision: "annotated", message: status, noop: true, platform: true }, "review");
    expect(mod.action).toBe("log");
    expect(t3).toEqual({ action: "send", text: `Plannotator: notes.md (pn-abc123) — Review posted.\nTarget: ${target}\n\n${status}` });
  });
});
