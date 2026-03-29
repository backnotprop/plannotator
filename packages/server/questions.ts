import type {
  ClarificationQuestion,
  QuestionAnswer,
} from "@plannotator/shared/questions";

/**
 * Question session management for the Plannotator server.
 *
 * Manages in-memory state for clarification questions the AI has embedded
 * in the plan. The UI fetches questions, the user answers them via the
 * browser, and the hook/plugin collects the answers before making a decision.
 *
 * Inspired by Octto's waiter-based async answer collection pattern.
 */

export interface QuestionSession {
  questions: ClarificationQuestion[];
  answers: Map<string, QuestionAnswer>;
  waiters: Array<{
    questionId: string;
    resolve: (answer: QuestionAnswer) => void;
  }>;
  allAnsweredWaiters: Array<() => void>;
}

export function createQuestionSession(
  questions: ClarificationQuestion[]
): QuestionSession {
  return {
    questions,
    answers: new Map(),
    waiters: [],
    allAnsweredWaiters: [],
  };
}

/**
 * Submit an answer to a question. Resolves any waiters for that question
 * and checks if all questions are now answered.
 */
export function submitAnswer(
  session: QuestionSession,
  answer: QuestionAnswer
): void {
  session.answers.set(answer.questionId, answer);

  // Resolve any waiters for this specific question
  const pending = session.waiters.filter(
    (w) => w.questionId === answer.questionId
  );
  for (const waiter of pending) {
    waiter.resolve(answer);
  }
  session.waiters = session.waiters.filter(
    (w) => w.questionId !== answer.questionId
  );

  // Check if all questions are answered
  if (areAllAnswered(session)) {
    for (const resolve of session.allAnsweredWaiters) {
      resolve();
    }
    session.allAnsweredWaiters = [];
  }
}

/**
 * Wait for a specific question to be answered.
 */
export function waitForAnswer(
  session: QuestionSession,
  questionId: string,
  timeoutMs: number = 300_000 // 5 minutes
): Promise<QuestionAnswer> {
  // Already answered?
  const existing = session.answers.get(questionId);
  if (existing) return Promise.resolve(existing);

  return new Promise<QuestionAnswer>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.waiters = session.waiters.filter(
        (w) => w.questionId !== questionId
      );
      reject(new Error(`Timeout waiting for answer to question ${questionId}`));
    }, timeoutMs);

    session.waiters.push({
      questionId,
      resolve: (answer) => {
        clearTimeout(timer);
        resolve(answer);
      },
    });
  });
}

/**
 * Wait for all questions to be answered.
 */
export function waitForAllAnswers(
  session: QuestionSession,
  timeoutMs: number = 600_000 // 10 minutes
): Promise<QuestionAnswer[]> {
  if (areAllAnswered(session)) {
    return Promise.resolve(getAllAnswers(session));
  }

  return new Promise<QuestionAnswer[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.allAnsweredWaiters = [];
      reject(new Error("Timeout waiting for all answers"));
    }, timeoutMs);

    session.allAnsweredWaiters.push(() => {
      clearTimeout(timer);
      resolve(getAllAnswers(session));
    });
  });
}

/**
 * Check if all questions have been answered.
 */
export function areAllAnswered(session: QuestionSession): boolean {
  return session.questions.every((q) => session.answers.has(q.id));
}

/**
 * Get all collected answers as an array.
 */
export function getAllAnswers(session: QuestionSession): QuestionAnswer[] {
  return Array.from(session.answers.values());
}

/**
 * Get the current state of the question session for the UI.
 */
export function getSessionState(session: QuestionSession): {
  questions: ClarificationQuestion[];
  answers: QuestionAnswer[];
  allAnswered: boolean;
} {
  return {
    questions: session.questions,
    answers: getAllAnswers(session),
    allAnswered: areAllAnswered(session),
  };
}
