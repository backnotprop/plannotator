/**
 * Shared types for AI ↔ Human clarification questions
 * and review session persistence across iterations.
 *
 * Inspired by Octto's branch-based Q&A model, adapted for Plannotator's
 * plan review workflow.
 */

// --- Clarification Question Types ---

export type QuestionType =
  | "pick_one"
  | "pick_many"
  | "confirm"
  | "ask_text"
  | "show_options";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ShowOption extends QuestionOption {
  pros?: string[];
  cons?: string[];
}

/**
 * A clarification question the AI pushes to the user during plan review.
 *
 * Questions can optionally be grouped by `branchId` (inspired by Octto's
 * branch-based exploration model) to organize related questions together.
 */
export interface ClarificationQuestion {
  id: string;
  type: QuestionType;
  question: string;
  /** Why the AI is asking this — shown as context in the UI */
  context?: string;
  /** For pick_one, pick_many */
  options?: QuestionOption[];
  /** For show_options — richer option cards with pros/cons */
  showOptions?: ShowOption[];
  /** For ask_text — input placeholder */
  placeholder?: string;
  /** Whether the user must answer before proceeding */
  required?: boolean;
  /** Optional grouping key (e.g., "cache-strategy", "auth-approach") */
  branchId?: string;
  /** Human-friendly branch label */
  branchLabel?: string;
}

export interface QuestionAnswer {
  questionId: string;
  type: QuestionType;
  /** string for text/pick_one/confirm, string[] for pick_many */
  answer: string | string[];
  answeredAt: string;
}

export interface ClarificationSession {
  questions: ClarificationQuestion[];
  answers: QuestionAnswer[];
  status: "active" | "complete";
}

// --- Review Session Persistence ---

/**
 * A single review iteration — one deny/revise cycle.
 * Captures everything that happened in that round.
 */
export interface ReviewIteration {
  iterationNumber: number;
  /** The plan text submitted in this iteration */
  plan: string;
  /** User annotations/feedback for this iteration */
  feedback: string;
  /** AI clarification questions asked in this iteration */
  questions: ClarificationQuestion[];
  /** User answers to clarification questions */
  answers: QuestionAnswer[];
  /** How the user decided */
  decision: "approved" | "denied";
  /** ISO timestamp */
  timestamp: string;
}

/**
 * A review session that persists across multiple deny/revise cycles.
 * This is the key data structure for solving context loss.
 */
export interface ReviewSession {
  sessionId: string;
  projectPath: string;
  planSlug: string;
  iterations: ReviewIteration[];
  createdAt: string;
  updatedAt: string;
}

// --- Plan Metadata Parsing ---

/**
 * Regex to extract session ID from plan metadata comment.
 * Format: <!-- plannotator:session SESSION_ID -->
 */
const SESSION_METADATA_RE =
  /<!--\s*plannotator:session\s+(\S+)\s*-->/;

/**
 * Regex to extract clarification questions from plan metadata comment.
 * Format: <!-- plannotator:questions [...JSON...] -->
 */
const QUESTIONS_METADATA_RE =
  /<!--\s*plannotator:questions\s+([\s\S]*?)\s*-->/;

/**
 * Extract the session ID embedded in a plan's metadata comment.
 * Returns null if no session metadata is found.
 */
export function extractSessionId(plan: string): string | null {
  const match = plan.match(SESSION_METADATA_RE);
  return match ? match[1] : null;
}

/**
 * Extract clarification questions embedded in a plan's metadata comment.
 * Returns an empty array if no questions metadata is found or parsing fails.
 */
export function extractQuestions(plan: string): ClarificationQuestion[] {
  const match = plan.match(QUESTIONS_METADATA_RE);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    // Basic validation: each item must have id, type, and question
    return parsed.filter(
      (q: unknown) =>
        typeof q === "object" &&
        q !== null &&
        "id" in q &&
        "type" in q &&
        "question" in q
    ) as ClarificationQuestion[];
  } catch {
    return [];
  }
}

/**
 * Strip all plannotator metadata comments from the plan markdown.
 * This returns the "clean" plan the user sees in the UI.
 */
export function stripPlanMetadata(plan: string): string {
  return plan
    .replace(SESSION_METADATA_RE, "")
    .replace(QUESTIONS_METADATA_RE, "")
    .replace(/^\s*\n/, ""); // Remove leading blank line if metadata was at top
}

/**
 * Embed a session ID into a plan as a metadata comment.
 * Prepends it as the first line (invisible in rendered markdown).
 */
export function embedSessionId(plan: string, sessionId: string): string {
  // Remove existing session metadata first
  const cleaned = plan.replace(SESSION_METADATA_RE, "").replace(/^\s*\n/, "");
  return `<!-- plannotator:session ${sessionId} -->\n${cleaned}`;
}

/**
 * Generate a unique session ID.
 * Format: ps_{timestamp}_{random} (ps = plannotator session)
 */
export function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `ps_${ts}_${rand}`;
}

/**
 * Format Q&A context for inclusion in feedback templates.
 * Produces a human-readable summary of questions asked and answers given.
 */
export function formatQAContext(
  questions: ClarificationQuestion[],
  answers: QuestionAnswer[]
): string {
  if (questions.length === 0) return "";

  const lines: string[] = ["## Clarification Q&A"];
  const answerMap = new Map(answers.map((a) => [a.questionId, a]));

  for (const q of questions) {
    const a = answerMap.get(q.id);
    lines.push("");
    lines.push(`**Q:** ${q.question}`);

    if (a) {
      const answerText = Array.isArray(a.answer)
        ? a.answer.join(", ")
        : a.answer;
      lines.push(`**A:** ${answerText}`);
    } else {
      lines.push(`**A:** _(not answered)_`);
    }
  }

  return lines.join("\n");
}

/**
 * Format a summary of previous review iterations for feedback context.
 * This is the key function that solves context loss across cycles.
 */
export function formatIterationContext(
  iterations: ReviewIteration[]
): string {
  if (iterations.length === 0) return "";

  const lines: string[] = ["## Previous Review Iterations"];

  for (const iter of iterations) {
    lines.push("");
    lines.push(
      `### Iteration ${iter.iterationNumber} (${iter.decision}, ${new Date(iter.timestamp).toLocaleString()})`
    );

    // Include feedback summary (truncated if very long)
    if (iter.feedback) {
      const feedbackPreview =
        iter.feedback.length > 500
          ? iter.feedback.slice(0, 500) + "..."
          : iter.feedback;
      lines.push("");
      lines.push("**User Feedback:**");
      lines.push(feedbackPreview);
    }

    // Include Q&A if any
    const qaContext = formatQAContext(iter.questions, iter.answers);
    if (qaContext) {
      lines.push("");
      lines.push(qaContext);
    }
  }

  return lines.join("\n");
}
