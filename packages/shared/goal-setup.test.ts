import { describe, expect, test } from "bun:test";
import {
  createFactsResult,
  createInterviewResult,
  factsResultToMarkdown,
  filterReviewableFacts,
  normalizeFactsBundle,
  normalizeGoalSetupBundle,
  normalizeInterviewBundle,
} from "./goal-setup";

describe("goal setup model", () => {
  test("normalizes bundled interview questions", () => {
    const bundle = normalizeInterviewBundle({
      title: "Goal setup",
      questions: [
        {
          id: "scope",
          prompt: "What is in scope?",
          answerMode: "multi-custom",
          options: [{ id: "ui", label: "UI" }],
          recommendedAnswer: "Ship the interactive flow.",
        },
      ],
    });

    expect(bundle.stage).toBe("interview");
    expect(bundle.questions[0]).toMatchObject({
      id: "scope",
      answerMode: "multi-custom",
      recommendedAnswer: "Ship the interactive flow.",
      required: true,
    });
    expect(bundle.questions[0].options?.[0].label).toBe("UI");
  });

  test("creates complete interview result from selected options and text", () => {
    const bundle = normalizeGoalSetupBundle(
      {
        stage: "interview",
        questions: [
          { id: "audience", prompt: "Who uses this?", answerMode: "single" },
          { id: "risk", prompt: "Main risk?" },
        ],
      },
      "interview"
    );

    if (bundle.stage !== "interview") throw new Error("expected interview");

    const result = createInterviewResult(bundle, [
      {
        questionId: "audience",
        selectedOptionIds: ["agents"],
        customAnswer: "",
        answer: "Agents",
        completed: false,
      },
      {
        questionId: "risk",
        selectedOptionIds: [],
        customAnswer: "",
        answer: "Slow one-at-a-time prompting",
        completed: false,
      },
    ]);

    expect(result.answers.map((answer) => answer.completed)).toEqual([
      true,
      true,
    ]);
  });

  test("preserves skipped interview answers with notes", () => {
    const bundle = normalizeGoalSetupBundle(
      {
        stage: "interview",
        questions: [
          { id: "scope", prompt: "What is out of scope?" },
        ],
      },
      "interview"
    );

    if (bundle.stage !== "interview") throw new Error("expected interview");

    const result = createInterviewResult(bundle, [
      {
        questionId: "scope",
        selectedOptionIds: [],
        customAnswer: "",
        answer: "",
        note: "I need more context before answering.",
        completed: false,
        skipped: true,
      },
    ]);

    expect(result.answers[0]).toMatchObject({
      questionId: "scope",
      completed: false,
      skipped: true,
      note: "I need more context before answering.",
    });
  });

  test("filters previously accepted facts unless the bundle opts in", () => {
    const bundle = normalizeFactsBundle({
      stage: "facts",
      facts: [
        { id: "old", text: "Already accepted.", accepted: true },
        { id: "new", text: "Needs review." },
      ],
    });

    expect(filterReviewableFacts(bundle).map((fact) => fact.id)).toEqual([
      "new",
    ]);
  });

  test("preserves recommended automated verification as preselected state", () => {
    const bundle = normalizeFactsBundle({
      stage: "facts",
      facts: [
        {
          id: "build",
          text: "The build must pass.",
          recommendedAutomatedVerification: true,
        },
      ],
    });

    expect(bundle.facts[0].automatedVerification).toBe(true);
    expect(bundle.facts[0].recommendedAutomatedVerification).toBe(true);
  });

  test("serializes accepted facts as flat markdown while metadata stays structured", () => {
    const markdown = factsResultToMarkdown([
      {
        id: "fact-1",
        text: "The skill batches all interview questions.",
        accepted: true,
        removed: false,
        comment: "Important for speed.",
        automatedVerification: true,
        recommendedAutomatedVerification: true,
      },
      {
        id: "fact-2",
        text: "A removed fact is omitted.",
        accepted: true,
        removed: true,
        automatedVerification: false,
      },
    ]);

    expect(markdown).toContain(
      "- The skill batches all interview questions."
    );
    expect(markdown).not.toContain("Automated verification");
    expect(markdown).not.toContain("Comment:");
    expect(markdown).not.toContain("A removed fact is omitted");
  });

  test("merges facts result against bundle order", () => {
    const bundle = normalizeFactsBundle({
      stage: "facts",
      facts: [
        { id: "a", text: "A" },
        { id: "b", text: "B", recommendedAutomatedVerification: true },
      ],
    });

    const result = createFactsResult(bundle, [
      {
        id: "b",
        text: "B edited",
        accepted: true,
        removed: false,
        automatedVerification: false,
      },
    ]);

    expect(result.facts.map((fact) => fact.id)).toEqual(["a", "b"]);
    expect(result.facts[1]).toMatchObject({
      text: "B edited",
      accepted: true,
      automatedVerification: false,
      recommendedAutomatedVerification: true,
    });
  });

  test("allows submitted facts to clear existing comments", () => {
    const bundle = normalizeFactsBundle({
      stage: "facts",
      facts: [{ id: "a", text: "A", comment: "Needs detail." }],
    });

    const result = createFactsResult(bundle, [
      {
        id: "a",
        text: "A",
        accepted: true,
        removed: false,
        comment: "",
        automatedVerification: false,
      },
    ]);

    expect(result.facts[0].comment).toBeUndefined();
  });

  test("rejects blank live fact text", () => {
    const bundle = normalizeFactsBundle({
      stage: "facts",
      facts: [{ id: "a", text: "A" }],
    });

    expect(() =>
      createFactsResult(bundle, [
        {
          id: "a",
          text: "   ",
          accepted: true,
          removed: false,
          automatedVerification: false,
        },
      ])
    ).toThrow('Fact "a" text cannot be empty');
  });
});
