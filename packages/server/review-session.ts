/**
 * Review Session Store
 *
 * Persists review sessions across deny/revise cycles so context is not lost.
 * Sessions are stored in ~/.plannotator/sessions/{sessionId}.json.
 *
 * Each session tracks all iterations (plan text, annotations, Q&A, decisions)
 * so the AI receives accumulated context when the user denies and revises.
 */

import { homedir } from "os";
import { join } from "path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs";
import type {
  ReviewSession,
  ReviewIteration,
  ClarificationQuestion,
  QuestionAnswer,
} from "@plannotator/shared/questions";

// Re-export types for convenience
export type { ReviewSession, ReviewIteration };

const SESSIONS_DIR = join(homedir(), ".plannotator", "sessions");

/** Max age for session cleanup (7 days) */
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ensure the sessions directory exists.
 */
function ensureSessionsDir(): string {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  return SESSIONS_DIR;
}

/**
 * Get the file path for a session.
 */
function sessionPath(sessionId: string): string {
  return join(ensureSessionsDir(), `${sessionId}.json`);
}

/**
 * Load a review session from disk.
 * Returns null if the session doesn't exist or can't be read.
 */
export function loadSession(sessionId: string): ReviewSession | null {
  const filePath = sessionPath(sessionId);
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ReviewSession;
  } catch {
    return null;
  }
}

/**
 * Save a review session to disk.
 */
export function saveSession(session: ReviewSession): void {
  const filePath = sessionPath(session.sessionId);
  ensureSessionsDir();
  writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
}

/**
 * Create a new review session.
 */
export function createSession(
  sessionId: string,
  projectPath: string,
  planSlug: string
): ReviewSession {
  const now = new Date().toISOString();
  const session: ReviewSession = {
    sessionId,
    projectPath,
    planSlug,
    iterations: [],
    createdAt: now,
    updatedAt: now,
  };
  saveSession(session);
  return session;
}

/**
 * Record a completed review iteration in the session.
 *
 * This is called when the user approves or denies. It captures the full
 * state of this review round: the plan text, the user's annotations,
 * any Q&A that occurred, and the decision.
 */
export function recordIteration(
  sessionId: string,
  iteration: {
    plan: string;
    feedback: string;
    questions: ClarificationQuestion[];
    answers: QuestionAnswer[];
    decision: "approved" | "denied";
  }
): ReviewSession {
  let session = loadSession(sessionId);

  if (!session) {
    // Session was lost or never created — create it now
    session = createSession(sessionId, "_unknown", "_unknown");
  }

  const iterationRecord: ReviewIteration = {
    iterationNumber: session.iterations.length + 1,
    plan: iteration.plan,
    feedback: iteration.feedback,
    questions: iteration.questions,
    answers: iteration.answers,
    decision: iteration.decision,
    timestamp: new Date().toISOString(),
  };

  session.iterations.push(iterationRecord);
  session.updatedAt = new Date().toISOString();
  saveSession(session);

  return session;
}

/**
 * Get the previous iterations for a session (everything before the current round).
 * Returns an empty array if no session exists or it's the first iteration.
 */
export function getPreviousIterations(
  sessionId: string
): ReviewIteration[] {
  const session = loadSession(sessionId);
  if (!session) return [];
  return session.iterations;
}

/**
 * Clean up old session files.
 * Removes sessions older than MAX_SESSION_AGE_MS.
 * Returns the number of sessions removed.
 */
export function cleanupSessions(): number {
  const dir = ensureSessionsDir();
  const now = Date.now();
  let removed = 0;

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = join(dir, entry);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtime.getTime() > MAX_SESSION_AGE_MS) {
          unlinkSync(filePath);
          removed++;
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return removed;
}
