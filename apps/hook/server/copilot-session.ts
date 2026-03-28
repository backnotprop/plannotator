/**
 * Copilot CLI Session Parser
 *
 * Extracts the last rendered assistant message from a Copilot CLI session.
 * Copilot CLI stores sessions at ~/.copilot/session-state/<uuid>/
 *
 * Detection: The COPILOT_CLI=1 environment variable is set in Copilot CLI sessions.
 *
 * Session directory contents:
 *   events.jsonl    — All session events (JSONL format)
 *   workspace.yaml  — Session metadata (id, cwd, summary, timestamps)
 *   session.db      — SQLite database with turns, checkpoints, etc.
 *   plan.md         — Plan content (if plan mode was used)
 *
 * Event types in events.jsonl:
 *   assistant.message — { messageId, content, toolRequests, interactionId }
 *   user.message      — { content, transformedContent, source }
 *   tool.*            — Tool execution events
 *   hook.*            — Hook invocation events
 *   session.*         — Session lifecycle events
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Types ---

interface CopilotEvent {
  type: string;
  data: {
    messageId?: string;
    content?: string;
    toolRequests?: unknown[];
    interactionId?: string;
    [key: string]: unknown;
  };
  id: string;
  timestamp: string;
}

// --- Session Directory Discovery ---

/**
 * Find the Copilot CLI session directory for a given CWD.
 *
 * Strategy (in priority order):
 * 1. Active session (has inuse.*.lock file) matching CWD
 * 2. Any active session
 * 3. Most recently modified session matching CWD
 * 4. Most recently modified session overall
 */
export function findCopilotSessionForCwd(cwd: string): string | null {
  const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
  const sessionsDir = join(copilotHome, "session-state");
  if (!existsSync(sessionsDir)) return null;

  const entries = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dirPath = join(sessionsDir, e.name);
      try {
        const wsPath = join(dirPath, "workspace.yaml");
        let sessionCwd: string | undefined;
        if (existsSync(wsPath)) {
          const ws = readFileSync(wsPath, "utf-8");
          const cwdMatch = ws.match(/^cwd:\s*(.+)$/m);
          sessionCwd = cwdMatch?.[1]?.trim();
        }

        const dirFiles = readdirSync(dirPath);
        const hasLock = dirFiles.some(
          (f) => f.startsWith("inuse.") && f.endsWith(".lock"),
        );

        return {
          name: e.name,
          path: dirPath,
          cwd: sessionCwd,
          hasLock,
          mtime: statSync(dirPath).mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{
    name: string;
    path: string;
    cwd?: string;
    hasLock: boolean;
    mtime: number;
  }>;

  // Sort by modification time (newest first)
  entries.sort((a, b) => b.mtime - a.mtime);

  // Normalize paths for comparison
  const normCwd = cwd.replace(/\\/g, "/").toLowerCase();
  const matchesCwd = (entry: (typeof entries)[0]) =>
    entry.cwd?.replace(/\\/g, "/").toLowerCase() === normCwd;

  return (
    entries.find((e) => e.hasLock && matchesCwd(e))?.path ??
    entries.find((e) => e.hasLock)?.path ??
    entries.find((e) => matchesCwd(e))?.path ??
    entries[0]?.path ??
    null
  );
}

// --- Plan Content Discovery ---

/**
 * Find the plan.md content for a Copilot CLI session.
 *
 * Uses sessionId (from hook input) if available, otherwise falls back
 * to finding the most recently modified plan.md across all sessions.
 */
export function findCopilotPlanContent(sessionId?: string): string | null {
  const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
  const sessionsDir = join(copilotHome, "session-state");

  // Primary: use sessionId directly (validate UUID to prevent path traversal)
  if (sessionId && /^[a-f0-9-]{36}$/i.test(sessionId)) {
    const planPath = join(sessionsDir, sessionId, "plan.md");
    if (existsSync(planPath)) {
      return readFileSync(planPath, "utf-8");
    }
  }

  // Fallback: find most recently modified plan.md
  if (!existsSync(sessionsDir)) return null;

  const candidates = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const p = join(sessionsDir, e.name, "plan.md");
      try {
        return { path: p, mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ path: string; mtime: number }>;

  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) return null;

  return readFileSync(candidates[0].path, "utf-8");
}

// --- Message Extraction ---

/**
 * Extract the last assistant message from a Copilot CLI session.
 *
 * Walks backward through events.jsonl, finds the last `assistant.message`
 * event with non-empty content. Accumulates content from multiple events
 * in the same turn (identified by interactionId) if needed.
 */
export function getLastCopilotMessage(
  sessionDir: string,
): { text: string } | null {
  const eventsPath = join(sessionDir, "events.jsonl");
  if (!existsSync(eventsPath)) return null;

  const content = readFileSync(eventsPath, "utf-8");
  const lines = content.trim().split("\n");

  // Walk backward to find the last assistant message with content
  for (let i = lines.length - 1; i >= 0; i--) {
    let event: CopilotEvent;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (event.type !== "assistant.message") continue;
    if (!event.data.content?.trim()) continue;

    return { text: event.data.content };
  }

  return null;
}
