import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

export interface GetLastCodexMessageOptions {
  beforeActiveTurn?: boolean;
}

export interface GetLatestCodexPlanOptions {
  turnId?: string;
  stopHookActive?: boolean;
}

export type CodexStopSkipReason = "missing-turn-id" | "missing-turn-marker";

export interface CodexStopPlanLookup {
  plan: CodexPlanResult | null;
  skipReason: CodexStopSkipReason | null;
  fallbackTurnId?: string;
}

const TURN_START_TYPES = new Set(["task_started", "turn_started"]);
const TURN_COMPLETE_TYPES = new Set(["task_complete", "turn_completed"]);
const PROPOSED_PLAN_RE = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/gi;

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function findCodexRolloutsByThreadId(threadId: string): string[] {
  const sessionsDir = join(codexHome(), "sessions");

  try {
    const matches: string[] = [];

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

          for (const file of readdirSync(dayDir)) {
            if (file.endsWith(".jsonl") && file.includes(threadId)) {
              matches.push(join(dayDir, file));
            }
          }
        }
      }
    }

    return matches.sort((a, b) => {
      const byMtime = mtimeMs(b) - mtimeMs(a);
      return byMtime !== 0 ? byMtime : b.localeCompare(a);
    });
  } catch {
    return [];
  }
}

export function findCodexRolloutByThreadId(threadId: string): string | null {
  return findCodexRolloutsByThreadId(threadId)[0] ?? null;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

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

function findLastIndex(
  entries: RolloutEntry[],
  predicate: (entry: RolloutEntry) => boolean
): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (predicate(entries[i])) return i;
  }
  return -1;
}

function isTurnMarker(entry: RolloutEntry): boolean {
  return (
    (entry.type === "event_msg" &&
      TURN_START_TYPES.has(entry.payload?.type || "")) ||
    entry.type === "turn_context"
  );
}

function getTurnId(entry: RolloutEntry): string | null {
  const turnId = entry.payload?.turn_id;
  return typeof turnId === "string" && turnId ? turnId : null;
}

function findTurnStartIndex(entries: RolloutEntry[], turnId: string): number {
  return entries.findIndex(
    (entry) => isTurnMarker(entry) && getTurnId(entry) === turnId
  );
}

function findLatestRolloutTurnId(entries: RolloutEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isTurnMarker(entry)) continue;
    const turnId = getTurnId(entry);
    if (turnId) return turnId;
  }
  return null;
}

function findActiveTurnStartIndex(entries: RolloutEntry[]): number {
  const latestTurnStart = findLastIndex(
    entries,
    (entry) =>
      entry.type === "event_msg" &&
      TURN_START_TYPES.has(entry.payload?.type || "")
  );
  if (latestTurnStart === -1) return -1;

  const latestTurnComplete = findLastIndex(
    entries,
    (entry) =>
      entry.type === "event_msg" &&
      TURN_COMPLETE_TYPES.has(entry.payload?.type || "")
  );
  return latestTurnStart > latestTurnComplete ? latestTurnStart : -1;
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

function isDeveloperMessage(entry: RolloutEntry): boolean {
  if (entry.type !== "response_item") return false;
  if (entry.payload?.type !== "message") return false;
  return entry.payload?.role === "developer";
}

function findLastDeveloperMessageIndex(
  entries: RolloutEntry[],
  startIndex: number
): number {
  for (let i = entries.length - 1; i >= Math.max(startIndex, 0); i--) {
    if (isDeveloperMessage(entries[i])) return i;
  }
  return -1;
}

function getPlanItemText(
  entry: RolloutEntry,
  turnId: string
): string | null {
  if (entry.type !== "event_msg") return null;
  if (entry.payload?.type !== "item_completed") return null;
  if (entry.payload?.turn_id !== turnId) return null;

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

export function logCodexStopSkip(
  reason: CodexStopSkipReason,
  opts: {
    debug?: string;
    write?: (message: string) => void;
  } = {},
): void {
  if (!opts.debug) return;
  const detail =
    reason === "missing-turn-id"
      ? "unusable Stop payload turn_id (present but blank or not a string)."
      : "missing id-carrying rollout turn marker.";
  (opts.write ?? console.error)(`[DEBUG] Codex Stop plan review skipped: ${detail}`);
}

export function logCodexStopTurnIdFallback(
  turnId: string,
  opts: { write?: (message: string) => void } = {},
): void {
  (opts.write ?? console.error)(
    `[plannotator] Codex Stop payload carried no turn_id (Codex < 0.117); resolved the current turn from the rollout instead (turn ${turnId}).`,
  );
}

function collectPlanCandidates(
  entries: RolloutEntry[],
  startIndex: number,
  turnId: string
): CodexPlanCandidate[] {
  const candidates: CodexPlanCandidate[] = [];
  let activeTurnId: string | null = null;

  for (let i = Math.max(startIndex, 0); i < entries.length; i++) {
    const entry = entries[i];
    if (isTurnMarker(entry)) {
      const boundaryTurnId = getTurnId(entry);
      if (boundaryTurnId) activeTurnId = boundaryTurnId;
    }

    const planItemText = getPlanItemText(entry, turnId);
    if (planItemText) {
      candidates.push({ index: i, text: planItemText, source: "plan-item" });
    }

    const assistantPlanText =
      activeTurnId === turnId ? getAssistantProposedPlanText(entry) : null;
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

export function getLastCodexMessage(
  rolloutPath: string,
  options: GetLastCodexMessageOptions = {}
): { text: string } | null {
  const entries = parseRolloutEntries(rolloutPath);
  const activeTurnStart = options.beforeActiveTurn
    ? findActiveTurnStartIndex(entries)
    : -1;
  const endIndex = activeTurnStart === -1 ? entries.length - 1 : activeTurnStart - 1;

  for (let i = endIndex; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "response_item") continue;
    if (entry.payload?.type !== "message") continue;
    if (entry.payload?.role !== "assistant") continue;

    const messageText = getMessageText(entry, ["output_text"]);
    if (messageText) return { text: messageText };
  }

  return null;
}

export interface CodexRecentMessage {
  messageId: string;
  text: string;
  timestamp?: string;
}

export function getRecentCodexMessages(
  rolloutPath: string,
  limit: number,
  options: GetLastCodexMessageOptions = {}
): CodexRecentMessage[] {
  if (limit <= 0) return [];
  const entries = parseRolloutEntries(rolloutPath);
  const activeTurnStart = options.beforeActiveTurn
    ? findActiveTurnStartIndex(entries)
    : -1;
  const endIndex = activeTurnStart === -1 ? entries.length - 1 : activeTurnStart - 1;

  const messages: CodexRecentMessage[] = [];
  for (let i = endIndex; i >= 0; i--) {
    if (messages.length >= limit) break;
    const entry = entries[i];
    if (entry.type !== "response_item") continue;
    if (entry.payload?.type !== "message") continue;
    if (entry.payload?.role !== "assistant") continue;

    const text = getMessageText(entry, ["output_text"]);
    if (!text) continue;
    messages.push({
      messageId: `codex-msg-${i}`,
      text,
      timestamp: entry.timestamp,
    });
  }
  return messages;
}

export function getLatestCodexPlan(
  rolloutPath: string,
  options: GetLatestCodexPlanOptions = {}
): CodexPlanResult | null {
  return resolveCodexStopPlan(rolloutPath, options).plan;
}

export function resolveCodexStopPlan(
  rolloutPath: string,
  options: GetLatestCodexPlanOptions = {}
): CodexStopPlanLookup {
  const rawTurnId: unknown = options.turnId;
  const payloadTurnId =
    rawTurnId === undefined
      ? undefined
      : typeof rawTurnId === "string"
        ? rawTurnId.trim()
        : "";
  if (rawTurnId !== undefined && !payloadTurnId) {
    return { plan: null, skipReason: "missing-turn-id" };
  }

  const entries = parseRolloutEntries(rolloutPath);

  const turnId = payloadTurnId ?? findLatestRolloutTurnId(entries);
  if (!turnId) return { plan: null, skipReason: "missing-turn-marker" };

  const turnStartIndex = findTurnStartIndex(entries, turnId);
  if (turnStartIndex === -1) {
    return { plan: null, skipReason: "missing-turn-marker" };
  }

  return {
    plan: findPlanInTurn(entries, turnStartIndex, turnId, {
      stopHookActive: !!options.stopHookActive,
      allowDeveloperBoundary: payloadTurnId === undefined,
    }),
    skipReason: null,
    ...(payloadTurnId ? {} : { fallbackTurnId: turnId }),
  };
}

function normalizePlan(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function toPlanResult(
  candidate: CodexPlanCandidate | null
): CodexPlanResult | null {
  return candidate ? { text: candidate.text, source: candidate.source } : null;
}

function planChangedAcrossBoundary(
  candidates: CodexPlanCandidate[],
  boundaryIndex: number
): CodexPlanResult | null {
  const plansAfter = candidates.filter(
    (candidate) => candidate.index > boundaryIndex
  );
  if (plansAfter.length === 0) return null;

  const latestAfter = pickLatestPreferredPlan(plansAfter);
  if (!latestAfter) return null;

  const latestBefore = pickLatestPreferredPlan(
    candidates.filter((candidate) => candidate.index < boundaryIndex)
  );

  if (
    latestBefore &&
    normalizePlan(latestBefore.text) === normalizePlan(latestAfter.text)
  ) {
    return null;
  }

  return toPlanResult(latestAfter);
}

function findPlanInTurn(
  entries: RolloutEntry[],
  turnStartIndex: number,
  turnId: string,
  options: { stopHookActive: boolean; allowDeveloperBoundary: boolean }
): CodexPlanResult | null {
  const candidates = collectPlanCandidates(entries, turnStartIndex, turnId);
  if (candidates.length === 0) return null;

  if (!options.stopHookActive) {
    return toPlanResult(pickLatestPreferredPlan(candidates));
  }

  const lastHookPromptIndex = findLastHookPromptIndex(entries, turnStartIndex);
  if (lastHookPromptIndex !== -1) {
    return planChangedAcrossBoundary(candidates, lastHookPromptIndex);
  }

  const lastDeveloperIndex = options.allowDeveloperBoundary
    ? findLastDeveloperMessageIndex(entries, turnStartIndex)
    : -1;
  if (lastDeveloperIndex !== -1) {
    return planChangedAcrossBoundary(candidates, lastDeveloperIndex);
  }

  return toPlanResult(pickLatestPreferredPlan(candidates));
}
