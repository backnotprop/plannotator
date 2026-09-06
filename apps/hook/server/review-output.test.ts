import { describe, expect, test } from "bun:test";
import { buildReviewOutput } from "./review-output";

describe("direct review output", () => {
  test("approval notes remain approved and use the configured guidance framing", () => {
    const feedback = "Keep the diagnostic: Review session closed without feedback.";

    expect(
      buildReviewOutput(
        { approved: true, feedback, annotations: [{ text: feedback }] },
        "amp",
        {
          prompts: {
            review: {
              approved: "Bare approval.",
              approvedWithNotes: "Approved with non-blocking guidance:\n{{feedback}}\nContinue without reopening the review.",
              denied: "Request changes.",
            },
          },
        },
      ),
    ).toEqual({
      decision: "approved",
      message: `Approved with non-blocking guidance:\n${feedback}\nContinue without reopening the review.`,
    });
  });

  test("bare approval resolves the origin-specific prompt before the global prompt", () => {
    const result = { approved: true, feedback: "", annotations: [] };
    const config = {
      prompts: {
        review: {
          approved: "Global approval.",
          runtimes: { amp: { approved: "Amp approval.\n" } },
        },
      },
    };

    expect(buildReviewOutput(result, "amp", config)).toEqual({
      decision: "approved",
      message: "Amp approval.\n",
    });
    expect(buildReviewOutput(result, undefined, config)).toEqual({
      decision: "approved",
      message: "Global approval.",
    });
  });

  test("PR annotations get the configured suffix with the existing plaintext newline boundary", () => {
    const feedback = "# PR Review\n\nCheck the null boundary.\n";
    const suffix = "\n\nVerify the finding before changing code.";

    expect(
      buildReviewOutput(
        {
          approved: false,
          feedback,
          annotations: [{ filePath: "src/cache.ts", text: "Check the null boundary." }],
        },
        "amp",
        {
          prompts: {
            review: {
              denied: "Global suffix.",
              runtimes: { amp: { denied: suffix } },
            },
          },
        },
      ),
    ).toEqual({
      decision: "annotated",
      message: `${feedback}\n${suffix}`,
    });
  });

  test("platform status without annotations does not acquire the denial suffix", () => {
    expect(
      buildReviewOutput(
        { approved: false, feedback: "Review posted to GitHub.", annotations: [] },
        "amp",
        { prompts: { review: { denied: "Verify the findings." } } },
      ),
    ).toEqual({
      decision: "annotated",
      message: "Review posted to GitHub.",
    });
  });

  test("submitted text identical to the close message is still feedback", () => {
    const feedback = "Review session closed without feedback.";

    expect(
      buildReviewOutput({ approved: false, feedback, annotations: [] }, "amp", {}),
    ).toEqual({ decision: "annotated", message: feedback });
  });

  test("dismissal takes precedence over approval and unsent annotations", () => {
    const config = {
      prompts: { review: { approved: "Approved.", denied: "Verify the findings." } },
    };
    const dismissed = buildReviewOutput(
      {
        exit: true,
        approved: true,
        feedback: "Unsent reviewer note.",
        annotations: [{ text: "Unsent reviewer note." }],
      },
      "amp",
      config,
    );

    expect(dismissed.decision).toBe("dismissed");
    expect(dismissed).toEqual(
      buildReviewOutput(
        { exit: true, approved: false, feedback: "", annotations: [] },
        "amp",
        config,
      ),
    );
  });
});
