import type { Candidate } from "@plannotator/sem-jiff/candidate";
import { candidateState, type OpinionAnswer } from "@plannotator/sem-jiff/opinions";

const URL = "https://api.openai.com/v1/decisions";
const MODEL = "gpt-6-luna";
const ACCEPT_THRESHOLD = 0.95;
const VERY_LIKELY_THRESHOLD = 0.99;
const QUOTA_ERRORS = new Set([
  "insufficient_quota",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

export class OpenAIDecisionError extends Error {
  constructor(readonly failure: "refused" | "noCredit" | "noAnswer") {
    super(failure);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type DecisionQuestion =
  | { type: "predicate"; instructions: string }
  | { type: "choice"; instructions: string; choices: { value: string; description: string }[] };

async function decide(apiKey: string, fetchImpl: typeof fetch, signal: AbortSignal, input: string, question: DecisionQuestion) {
  const response = await fetchImpl(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input, questions: [{ ...question, name: "q" }] }),
    signal,
    redirect: "error",
  });
  if (response.status === 401 || response.status === 403) throw new OpenAIDecisionError("refused");
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
    throw new OpenAIDecisionError(
      response.status === 429 && typeof code === "string" && QUOTA_ERRORS.has(code) ? "noCredit" : "noAnswer",
    );
  }
  if (!isRecord(body) || !Array.isArray(body.answers) || body.answers.length !== 1) return undefined;
  const answer: unknown = body.answers[0];
  return isRecord(answer) && answer.name === "q" ? answer : undefined;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export async function checkOpenAIDecisions(apiKey: string, fetchImpl: typeof fetch): Promise<number> {
  const start = performance.now();
  const answer = await decide(apiKey, fetchImpl, AbortSignal.timeout(10_000), "A red apple.", { type: "predicate", instructions: "Is the apple red?" });
  if (answer?.type !== "predicate" || !isProbability(answer.probability)) throw new OpenAIDecisionError("noAnswer");
  return Math.round(performance.now() - start);
}

export function openaiAnswers(apiKey: string, fetchImpl: typeof fetch, timeoutMs = 20_000) {
  let queue = Promise.resolve();
  async function ask(candidate: Candidate, signal: AbortSignal): Promise<OpinionAnswer> {
    const extract = candidate.kind === "extract";
    const question = extract
      ? "Where did the added helper's statements come from?"
      : "Where did the removed helper's statements go?";
    const choices = [
      {
        value: "moved",
        description: extract
          ? "The statements moved from the old caller into the helper, and the new caller calls it. Small edits and renames are allowed."
          : "The helper's statements replaced the call in the new caller. Small edits and renames are allowed.",
      },
      extract
        ? { value: "new", description: "The helper adds statements that were absent in the old caller." }
        : { value: "deleted", description: "The helper's statements were dropped." },
      { value: "rewritten", description: "The code does similar work with a different implementation." },
      { value: "elsewhere", description: "The statements moved somewhere other than between this caller and helper." },
    ];
    const options = choices.map(({ value }) => value);
    const answer = await decide(apiKey, fetchImpl, signal, candidateState(candidate), { type: "choice", instructions: question, choices });
    const selected = answer?.choice;
    const probabilities = answer?.probabilities;
    const moves = Array.isArray(probabilities)
      ? probabilities.filter((entry) => isRecord(entry) && entry.value === "moved")
      : [];
    const probability: unknown = moves.length === 1 && isRecord(moves[0]) ? moves[0].probability : undefined;
    const scored = answer?.type === "choice" && typeof selected === "string" && options.includes(selected) && isProbability(probability);
    const score = scored ? probability : 0;
    const accept = scored && selected === "moved" && score >= ACCEPT_THRESHOLD;
    const band = accept ? (score >= VERY_LIKELY_THRESHOLD ? "very-likely" : "likely") : undefined;
    return { accept, score, band, model: MODEL, question, options, answer: scored ? selected : "unanswered" };
  }

  return (candidates: Candidate[]): Promise<OpinionAnswer[]> => {
    const run = queue.then(async () => {
      // The time limit starts when this batch's turn comes, not while it waits behind another.
      const signal = AbortSignal.timeout(timeoutMs);
      const answers: OpinionAnswer[] = [];
      for (let i = 0; i < candidates.length; i += 4) {
        signal.throwIfAborted();
        const batch = await Promise.allSettled(candidates.slice(i, i + 4).map((candidate) => ask(candidate, signal)));
        for (const result of batch) {
          if (result.status === "rejected") throw result.reason;
          answers.push(result.value);
        }
      }
      return answers;
    });
    queue = run.then(() => {}, () => {});
    return run;
  };
}
