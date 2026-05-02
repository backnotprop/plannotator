/**
 * Codex Session Parser
 *
 * Extracts the last rendered assistant message from a Codex rollout file.
 * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 *
 * Detection: Codex injects CODEX_THREAD_ID into every spawned process.
 * The thread ID is the UUID in the rollout filename.
 *
 * Rollout format (JSONL, one object per line):
 *   {"timestamp":"...","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}]}}
 *   {"timestamp":"...","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"...","call_id":"..."}}
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Types ---

type CodexPlanSource = "plan-item" | "assistant-message";

interface RolloutEntry {
  timestamp?: string;
  type: string;
  payload?: {
    type?: string;
    role?: string;
    content?: { type: string; text?: string }[];
    turn_id?: string;
    item?: {
      type?: string;
      text?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

interface CodexPlanCandidate {
  index: number;
  text: string;
  source: CodexPlanSource;
}

export interface CodexPlanResult {
  text: string;
  source: CodexPlanSource;
}

export interface GetLatestCodexPlanOptions {
  turnId?: string;
  stopHookActive?: boolean;
}

const TURN_START_TYPES = new Set(["task_started", "turn_started"]);
const PROPOSED_PLAN_RE = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/gi;

// --- Rollout File Discovery ---

/**
 * Find the Codex rollout file for a given thread ID.
 * The thread ID is the UUID portion of the filename:
 *   rollout-<timestamp>-<uuid>.jsonl
 *
 * Scans ~/.codex/sessions/ directory tree for a matching file.
 */
export function findCodexRolloutByThreadId(threadId: string): string | null {
  const sessionsDir = join(homedir(), ".codex", "sessions");

  try {
    // Walk YYYY/MM/DD directories in reverse order (most recent first)
    const years = readdirSync(sessionsDir).sort().reverse();
    for (const year of years) {
      const yearDir = join(sessionsDir, year);
      if (!isDir(yearDir)) continue;

      const months = readdirSync(yearDir).sort().reverse();
      for (const month of months) {
        const monthDir = join(yearDir, month);
        if (!isDir(monthDir)) continue;

        const days = readdirSync(monthDir).sort().reverse();
        for (const day of days) {
          const dayDir = join(monthDir, day);
          if (!isDir(dayDir)) continue;

          const files = readdirSync(dayDir);
          for (const file of files) {
            if (file.endsWith(".jsonl") && file.includes(threadId)) {
              return join(dayDir, file);
            }
          }
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// --- Message Extraction ---

function parseRolloutEntries(rolloutPath: string): RolloutEntry[] {
  const content = readFileSync(rolloutPath, "utf-8");
  if (!content.trim()) return [];

  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RolloutEntry];
      } catch {
        return [];
      }
    });
}

function getMessageText(
  entry: RolloutEntry,
  allowedContentTypes: readonly string[]
): string | null {
  if (entry.type !== "response_item") return null;
  if (entry.payload?.type !== "message") return null;

  const contentBlocks = entry.payload?.content;
  if (!Array.isArray(contentBlocks)) return null;

  const textParts = contentBlocks
    .filter((block) => allowedContentTypes.includes(block.type))
    .map((block) => (typeof block.text === "string" ? block.text.trim() : ""))
    .filter(Boolean);

  if (textParts.length === 0) return null;

  return textParts.join("\n");
}

function extractLastProposedPlan(text: string): string | null {
  const matches = Array.from(text.matchAll(PROPOSED_PLAN_RE));
  const latest = matches.at(-1)?.[1]?.trim();
  return latest || null;
}

function normalizePlan(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function findLastIndex(
  entries: RolloutEntry[],
  predicate: (entry: RolloutEntry) => boolean
): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (predicate(entries[i])) return i;
  }
  return -1;
}

function findTurnStartIndex(entries: RolloutEntry[], turnId?: string): number {
  const matchingTurnStart = findLastIndex(
    entries,
    (entry) =>
      entry.type === "event_msg" &&
      TURN_START_TYPES.has(entry.payload?.type || "") &&
      (!turnId || entry.payload?.turn_id === turnId)
  );
  if (matchingTurnStart !== -1) return matchingTurnStart;

  const matchingTurnContext = findLastIndex(
    entries,
    (entry) =>
      entry.type === "turn_context" &&
      (!turnId || entry.payload?.turn_id === turnId)
  );
  if (matchingTurnContext !== -1) return matchingTurnContext;

  const lastTurnStart = findLastIndex(
    entries,
    (entry) =>
      entry.type === "event_msg" &&
      TURN_START_TYPES.has(entry.payload?.type || "")
  );
  if (lastTurnStart !== -1) return lastTurnStart;

  const lastTurnContext = findLastIndex(
    entries,
    (entry) => entry.type === "turn_context"
  );
  return lastTurnContext === -1 ? 0 : lastTurnContext;
}

function isHookPromptMessage(entry: RolloutEntry): boolean {
  if (entry.type !== "response_item") return false;
  if (entry.payload?.type !== "message") return false;
  if (entry.payload?.role !== "user") return false;

  const messageText = getMessageText(entry, ["input_text"]);
  return !!messageText?.includes("<hook_prompt");
}

function findLastHookPromptIndex(
  entries: RolloutEntry[],
  startIndex: number
): number {
  for (let i = entries.length - 1; i >= Math.max(startIndex, 0); i--) {
    if (isHookPromptMessage(entries[i])) return i;
  }
  return -1;
}

function getPlanItemText(
  entry: RolloutEntry,
  turnId?: string
): string | null {
  if (entry.type !== "event_msg") return null;
  if (entry.payload?.type !== "item_completed") return null;
  if (turnId && entry.payload?.turn_id !== turnId) return null;

  const itemType = entry.payload?.item?.type;
  if (itemType !== "Plan" && itemType !== "plan") return null;

  const text = entry.payload?.item?.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

function getAssistantProposedPlanText(entry: RolloutEntry): string | null {
  if (entry.type !== "response_item") return null;
  if (entry.payload?.type !== "message") return null;
  if (entry.payload?.role !== "assistant") return null;

  const messageText = getMessageText(entry, ["output_text"]);
  if (!messageText) return null;

  return extractLastProposedPlan(messageText);
}

function collectPlanCandidates(
  entries: RolloutEntry[],
  startIndex: number,
  turnId?: string
): CodexPlanCandidate[] {
  const candidates: CodexPlanCandidate[] = [];

  for (let i = Math.max(startIndex, 0); i < entries.length; i++) {
    const entry = entries[i];

    const planItemText = getPlanItemText(entry, turnId);
    if (planItemText) {
      candidates.push({ index: i, text: planItemText, source: "plan-item" });
    }

    const assistantPlanText = getAssistantProposedPlanText(entry);
    if (assistantPlanText) {
      candidates.push({
        index: i,
        text: assistantPlanText,
        source: "assistant-message",
      });
    }
  }

  return candidates;
}

function pickLatestPreferredPlan(
  candidates: CodexPlanCandidate[]
): CodexPlanCandidate | null {
  const latestPlanItem = [...candidates]
    .reverse()
    .find((candidate) => candidate.source === "plan-item");
  if (latestPlanItem) return latestPlanItem;

  return candidates.at(-1) || null;
}

/**
 * Extract the last assistant message from a Codex rollout file.
 *
 * Walks backward through the JSONL, finds the last entry where:
 *   type === "response_item"
 *   payload.type === "message"
 *   payload.role === "assistant"
 *
 * Extracts output_text blocks from payload.content.
 */
export function getLastCodexMessage(
  rolloutPath: string
): { text: string } | null {
  const entries = parseRolloutEntries(rolloutPath);

  // Walk backward
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "response_item") continue;
    if (entry.payload?.type !== "message") continue;
    if (entry.payload?.role !== "assistant") continue;

    const messageText = getMessageText(entry, ["output_text"]);
    if (messageText) return { text: messageText };
  }

  return null;
}

/**
 * Extract the latest Codex plan from a rollout file.
 *
 * Primary source: persisted completed TurnItem::Plan events.
 * Fallback source: raw assistant response_item messages that still contain a
 * <proposed_plan> block in the rollout transcript.
 *
 * When stopHookActive is true, this only returns a changed post-feedback plan:
 * - no plan after the last hook prompt => null
 * - identical plan after the last hook prompt => null
 */
export function getLatestCodexPlan(
  rolloutPath: string,
  options: GetLatestCodexPlanOptions = {}
): CodexPlanResult | null {
  const entries = parseRolloutEntries(rolloutPath);
  if (entries.length === 0) return null;

  const turnStartIndex = findTurnStartIndex(entries, options.turnId);
  const candidates = collectPlanCandidates(
    entries,
    turnStartIndex,
    options.turnId
  );
  if (candidates.length === 0) return null;

  if (!options.stopHookActive) {
    const latestPlan = pickLatestPreferredPlan(candidates);
    return latestPlan
      ? { text: latestPlan.text, source: latestPlan.source }
      : null;
  }

  const lastHookPromptIndex = findLastHookPromptIndex(entries, turnStartIndex);

  if (lastHookPromptIndex === -1) {
    const latestPlan = pickLatestPreferredPlan(candidates);
    return latestPlan
      ? { text: latestPlan.text, source: latestPlan.source }
      : null;
  }

  const plansAfterHookPrompt = candidates.filter(
    (candidate) => candidate.index > lastHookPromptIndex
  );
  if (plansAfterHookPrompt.length === 0) return null;

  const latestAfterHookPrompt = pickLatestPreferredPlan(plansAfterHookPrompt);
  if (!latestAfterHookPrompt) return null;

  const plansBeforeHookPrompt = candidates.filter(
    (candidate) => candidate.index < lastHookPromptIndex
  );
  const latestBeforeHookPrompt = pickLatestPreferredPlan(plansBeforeHookPrompt);

  if (
    latestBeforeHookPrompt &&
    normalizePlan(latestBeforeHookPrompt.text) ===
      normalizePlan(latestAfterHookPrompt.text)
  ) {
    return null;
  }

  return {
    text: latestAfterHookPrompt.text,
    source: latestAfterHookPrompt.source,
  };
}
