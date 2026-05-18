export type GoalSetupStage = "interview" | "facts";

export type GoalSetupAnswerMode =
  | "text"
  | "single"
  | "multi"
  | "single-custom"
  | "multi-custom"
  | "custom";

export interface GoalSetupQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface GoalSetupQuestion {
  id: string;
  prompt: string;
  description?: string;
  answerMode?: GoalSetupAnswerMode;
  recommendedAnswer?: string;
  recommendedOptionIds?: string[];
  options?: GoalSetupQuestionOption[];
  required?: boolean;
}

export interface GoalSetupQuestionAnswer {
  questionId: string;
  selectedOptionIds: string[];
  customAnswer: string;
  note?: string;
  answer: string;
  completed: boolean;
  skipped?: boolean;
}

export interface GoalSetupInterviewBundle {
  stage: "interview";
  title?: string;
  goalSlug?: string;
  questions: GoalSetupQuestion[];
}

export interface GoalSetupFact {
  id: string;
  text: string;
  accepted: boolean;
  removed: boolean;
  comment?: string;
  recommendedAutomatedVerification?: boolean;
  automatedVerification: boolean;
  previousText?: string;
}

export interface GoalSetupFactsBundle {
  stage: "facts";
  title?: string;
  goalSlug?: string;
  facts: GoalSetupFact[];
  showAccepted?: boolean;
}

export type GoalSetupBundle = GoalSetupInterviewBundle | GoalSetupFactsBundle;

export interface GoalSetupInterviewResult {
  stage: "interview";
  title?: string;
  goalSlug?: string;
  answers: GoalSetupQuestionAnswer[];
}

export interface GoalSetupFactResult {
  id: string;
  text: string;
  accepted: boolean;
  removed: boolean;
  comment?: string;
  automatedVerification: boolean;
  recommendedAutomatedVerification?: boolean;
}

export interface GoalSetupFactsResult {
  stage: "facts";
  title?: string;
  goalSlug?: string;
  facts: GoalSetupFactResult[];
  factsMarkdown: string;
}

export type GoalSetupResult = GoalSetupInterviewResult | GoalSetupFactsResult;

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeId(value: unknown, fallback: string): string {
  const raw = asString(value, fallback).trim();
  return raw || fallback;
}

function normalizeAnswerMode(value: unknown): GoalSetupAnswerMode {
  switch (value) {
    case "single":
    case "multi":
    case "single-custom":
    case "multi-custom":
    case "custom":
    case "text":
      return value;
    default:
      return "text";
  }
}

function normalizeOption(value: unknown, index: number): GoalSetupQuestionOption {
  const item = asRecord(value, `questions[].options[${index}]`);
  const label = asString(item.label).trim();
  if (!label) {
    throw new Error(`questions[].options[${index}].label is required`);
  }
  return {
    id: normalizeId(item.id, `option-${index + 1}`),
    label,
    ...(asString(item.description).trim()
      ? { description: asString(item.description).trim() }
      : {}),
  };
}

function normalizeQuestion(value: unknown, index: number): GoalSetupQuestion {
  const item = asRecord(value, `questions[${index}]`);
  const prompt = asString(item.prompt).trim();
  if (!prompt) {
    throw new Error(`questions[${index}].prompt is required`);
  }
  const options = Array.isArray(item.options)
    ? item.options.map(normalizeOption)
    : undefined;

  const recommendedOptionIds = Array.isArray(item.recommendedOptionIds)
    ? (item.recommendedOptionIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : undefined;

  return {
    id: normalizeId(item.id, `question-${index + 1}`),
    prompt,
    ...(asString(item.description).trim()
      ? { description: asString(item.description).trim() }
      : {}),
    answerMode: normalizeAnswerMode(item.answerMode),
    ...(asString(item.recommendedAnswer).trim()
      ? { recommendedAnswer: asString(item.recommendedAnswer).trim() }
      : {}),
    ...(recommendedOptionIds && recommendedOptionIds.length > 0
      ? { recommendedOptionIds }
      : {}),
    ...(options && options.length > 0 ? { options } : {}),
    required: asBoolean(item.required, true),
  };
}

function normalizeFact(value: unknown, index: number): GoalSetupFact {
  const item = asRecord(value, `facts[${index}]`);
  const text = asString(item.text).trim();
  if (!text) {
    throw new Error(`facts[${index}].text is required`);
  }
  const recommended = asBoolean(item.recommendedAutomatedVerification, false);
  return {
    id: normalizeId(item.id, `fact-${index + 1}`),
    text,
    accepted: asBoolean(item.accepted, false),
    removed: asBoolean(item.removed, false),
    ...(asString(item.comment).trim()
      ? { comment: asString(item.comment).trim() }
      : {}),
    recommendedAutomatedVerification: recommended,
    automatedVerification: asBoolean(item.automatedVerification, recommended),
    ...(asString(item.previousText).trim()
      ? { previousText: asString(item.previousText).trim() }
      : {}),
  };
}

export function normalizeInterviewBundle(value: unknown): GoalSetupInterviewBundle {
  const raw = asRecord(value, "goal setup interview bundle");
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    throw new Error("interview bundle requires at least one question");
  }
  return {
    stage: "interview",
    ...(asString(raw.title).trim() ? { title: asString(raw.title).trim() } : {}),
    ...(asString(raw.goalSlug).trim()
      ? { goalSlug: asString(raw.goalSlug).trim() }
      : {}),
    questions: raw.questions.map(normalizeQuestion),
  };
}

export function normalizeFactsBundle(value: unknown): GoalSetupFactsBundle {
  const raw = asRecord(value, "goal setup facts bundle");
  if (!Array.isArray(raw.facts)) {
    throw new Error("facts bundle requires a facts array");
  }
  return {
    stage: "facts",
    ...(asString(raw.title).trim() ? { title: asString(raw.title).trim() } : {}),
    ...(asString(raw.goalSlug).trim()
      ? { goalSlug: asString(raw.goalSlug).trim() }
      : {}),
    facts: raw.facts.map(normalizeFact),
    showAccepted: asBoolean(raw.showAccepted, false),
  };
}

export function normalizeGoalSetupBundle(
  value: unknown,
  expectedStage?: GoalSetupStage
): GoalSetupBundle {
  const raw = asRecord(value, "goal setup bundle");
  const stage = expectedStage ?? raw.stage;
  if (stage === "interview") return normalizeInterviewBundle(raw);
  if (stage === "facts") return normalizeFactsBundle(raw);
  throw new Error("goal setup bundle stage must be interview or facts");
}

export function hasQuestionAnswer(answer: GoalSetupQuestionAnswer): boolean {
  return (
    answer.selectedOptionIds.length > 0 ||
    answer.customAnswer.trim().length > 0 ||
    answer.answer.trim().length > 0
  );
}

export function createInterviewResult(
  bundle: GoalSetupInterviewBundle,
  answers: GoalSetupQuestionAnswer[]
): GoalSetupInterviewResult {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
  return {
    stage: "interview",
    title: bundle.title,
    goalSlug: bundle.goalSlug,
    answers: bundle.questions.map((question) => {
      const answer = byId.get(question.id);
      const normalized: GoalSetupQuestionAnswer = {
        questionId: question.id,
        selectedOptionIds: Array.isArray(answer?.selectedOptionIds)
          ? answer!.selectedOptionIds
          : [],
        customAnswer: asString(answer?.customAnswer),
        ...(asString(answer?.note).trim()
          ? { note: asString(answer?.note).trim() }
          : {}),
        answer: asString(answer?.answer),
        completed: asBoolean(answer?.completed, false),
      };
      const completed = normalized.completed || hasQuestionAnswer(normalized);
      const skipped = asBoolean(answer?.skipped, false) && !completed;
      return {
        ...normalized,
        completed,
        ...(skipped ? { skipped: true } : {}),
      };
    }),
  };
}

export function filterReviewableFacts(bundle: GoalSetupFactsBundle): GoalSetupFact[] {
  if (bundle.showAccepted) return bundle.facts;
  return bundle.facts.filter((fact) => !fact.accepted);
}

export function createFactsResult(
  bundle: GoalSetupFactsBundle,
  facts: GoalSetupFactResult[]
): GoalSetupFactsResult {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const merged = bundle.facts.map((fact) => {
    const next = byId.get(fact.id);
    const removed = asBoolean(next?.removed, fact.removed);
    const text = asString(next?.text, fact.text).trim();
    if (!removed && !text) {
      throw new Error(`Fact "${fact.id}" text cannot be empty; edit it or remove the fact.`);
    }
    const comment = (next && Object.prototype.hasOwnProperty.call(next, "comment")
      ? asString(next.comment)
      : asString(fact.comment)
    ).trim();
    return {
      id: fact.id,
      text: text || fact.text,
      accepted: asBoolean(next?.accepted, fact.accepted),
      removed,
      ...(comment ? { comment } : {}),
      automatedVerification: asBoolean(
        next?.automatedVerification,
        fact.automatedVerification
      ),
      recommendedAutomatedVerification:
        next?.recommendedAutomatedVerification ??
        fact.recommendedAutomatedVerification,
    };
  });

  return {
    stage: "facts",
    title: bundle.title,
    goalSlug: bundle.goalSlug,
    facts: merged,
    factsMarkdown: factsResultToMarkdown(merged),
  };
}

export function factsResultToMarkdown(facts: GoalSetupFactResult[]): string {
  const accepted = facts.filter((fact) => fact.accepted && !fact.removed);
  if (accepted.length === 0) return "# Facts\n\nNo accepted facts.";

  const lines = ["# Facts", ""];
  for (const fact of accepted) {
    lines.push(`- ${fact.text}`);
  }
  return lines.join("\n");
}
