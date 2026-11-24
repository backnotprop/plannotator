/**
 * Whether a text handed into a running Codex turn reached the model, from the thread's own rollout. Codex drops input
 * the model has not read yet when the person presses Esc (the turn ends `turn_aborted`), and drops a hook's
 * `additionalContext` when the tool call is cancelled, so a steer that Codex accepted (`turn/steer`, the hook's
 * claim) is not yet a delivery. The Codex wake (inbox-codex-wake.ts) says Delivered only once the rollout shows the
 * text as a message of the conversation, and sends it as the next turn when the turn ended without it. It never sends
 * it twice: the rollout shows the text, or the turn it was handed to ended and a later step went on without it.
 *
 * What the rollout says, line by line from where it was when the text was handed on (`CodexSightStart.offset`):
 *
 *  - the text, as a `response_item` message from the user or the developer (a steer, the hook's context) or a
 *    `user_message` event: seen. Into the running turn when no turn ended before it; otherwise Codex carried it into
 *    the turn after (it does that for input left when a turn completes).
 *  - the turn's end (`task_complete`, `turn_aborted`, …) or another turn's start (a Codex started again after a crash):
 *    the turn it was handed to is over. Then the model's next step (its reasoning, a tool call, a reply) with no text
 *    before it: dropped. Nothing after the end for SIGHT_QUIET_MS: dropped too (the thread went idle without it).
 *  - nothing written to the rollout for CODEX_SIGHT_GIVE_UP_MS (20 minutes, the hold's rule: a Codex that crashed
 *    mid-turn and was not resumed), counted from the hand-off too, and never while a launched thread's host says its
 *    turn still runs (a steer waits in Codex for the end of a tool call, which writes nothing however long it takes):
 *    dropped, so it goes once as the next turn.
 *  - anything else: still waiting (a long tool call, the model still answering).
 *
 * What Codex writes, from its source (openai/codex at baf9b39, 2026-11-24): a PostToolUse hook's `additionalContext`
 * is recorded by `record_additional_contexts` (core/src/tools/registry.rs, after `run_post_tool_use_hooks`, cancelled
 * with the tool call) as `HookAdditionalContext` (core/src/context/hook_additional_context.rs: role "developer", one
 * `input_text` with the text whole, no markers), through `record_conversation_items` → `record_prepared_items` →
 * `persist_rollout_items(RolloutItem::ResponseItem)` (core/src/session/mod.rs): a rollout line
 * `{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":…}]}}`.
 * A `turn/steer` input is recorded as the user's message (`record_user_prompt_and_emit_turn_item`, hook_runtime.rs
 * `record_pending_input`). `showsText` matches both.
 */

import { open, stat } from "node:fs/promises";
import type { CodexSight, CodexSightStart } from "@plannotator/shared/inbox/codex-hook-mailbox";

/** After the turn ended without the text, this long with nothing more in the rollout: it was dropped. */
export const CODEX_SIGHT_QUIET_MS = 10_000;
/** Nothing written to the rollout for this long while handed on: Codex is gone (the hold's ROLLOUT_STALE_MS). */
export const CODEX_SIGHT_GIVE_UP_MS = 20 * 60_000;
/** How much of the rollout before the hand-off is read for the running turn's id. */
const TURN_TAIL_BYTES = 512 * 1024;
/** The most read in one look (the rest on the next one). */
const READ_MAX_BYTES = 8 * 1024 * 1024;

const TURN_STARTS = new Set(["task_started", "turn_started"]);
const TURN_ENDS = new Set(["task_complete", "turn_complete", "turn_completed", "turn_aborted"]);
const OWN_ROLES = new Set(["user", "developer", "system"]);

/** What the text is looked for by: the wake text's first line (`Plannotator Inbox: <title> (<id>)`) and its id. */
type CodexSightMark = Pick<CodexSight, "line" | "id">;

/** What to look for, for a wake text with this id, handed on when the rollout stood at `start`. */
export function codexSightFor(start: CodexSightStart, text: string, id: string): CodexSight {
  return { ...start, line: text.split("\n", 1)[0]!, id };
}

/** How far a look got: the byte after the last whole line read, and whether the turn it was handed to is over. */
export interface CodexSightCursor {
  pos: number;
  ended: boolean;
}

export type CodexSightAnswer =
  /** The rollout shows it: `intoTurn` when it went into the turn it was handed to. */
  | { kind: "seen"; intoTurn: boolean }
  /** That turn ended and went on without it. */
  | { kind: "dropped" }
  | { kind: "waiting"; cursor: CodexSightCursor };

type Entry = { type?: unknown; payload?: { type?: unknown; role?: unknown; content?: unknown; message?: unknown; turn_id?: unknown } };

function parse(line: string): Entry | null {
  try {
    const entry = JSON.parse(line) as Entry;
    return entry && typeof entry === "object" ? entry : null;
  } catch {
    return null;
  }
}

function showsText(entry: Entry, mark: CodexSightMark): boolean {
  const payload = entry.payload;
  if (!payload) return false;
  if (entry.type === "event_msg") return payload.type === "user_message" && typeof payload.message === "string" && payload.message.includes(mark.line);
  if (entry.type !== "response_item" || payload.type !== "message" || !OWN_ROLES.has(String(payload.role))) return false;
  return Array.isArray(payload.content) && payload.content.some((part: { text?: unknown } | null) => typeof part?.text === "string" && part.text.includes(mark.line));
}

/** The model's own step: its reasoning, a tool call, its reply (not a tool's output, not a message to it). */
function modelStep(entry: Entry): boolean {
  const kind = entry.payload?.type;
  if (entry.type === "event_msg") return kind === "agent_message" || kind === "agent_reasoning";
  if (entry.type !== "response_item" || typeof kind !== "string") return false;
  if (kind === "message") return entry.payload?.role === "assistant";
  return !kind.endsWith("_output");
}

/**
 * One look over `text` (the rollout from `cursor.pos`, whole lines only): what it says of the text marked `mark`,
 * handed to the turn `turn` (null: any turn start after the hand-off is another turn).
 */
export function codexSightIn(text: string, mark: CodexSightMark, turn: string | null, cursor: CodexSightCursor): CodexSightAnswer {
  let ended = cursor.ended;
  let pos = cursor.pos;
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    if (end < 0) break;
    const line = text.slice(start, end);
    pos += Buffer.byteLength(line) + 1;
    start = end + 1;
    if (line.includes(`(${mark.id})`)) {
      const entry = parse(line);
      if (entry && showsText(entry, mark)) return { kind: "seen", intoTurn: !ended };
    }
    if (!line.includes('"event_msg"') && !line.includes('"turn_context"') && !(ended && line.includes('"response_item"'))) continue;
    const entry = parse(line);
    if (!entry) continue;
    const kind = entry.payload?.type;
    const turnId = typeof entry.payload?.turn_id === "string" ? entry.payload.turn_id : null;
    if (entry.type === "event_msg" && typeof kind === "string" && TURN_ENDS.has(kind)) ended = true;
    else if (entry.type === "event_msg" && typeof kind === "string" && TURN_STARTS.has(kind) && (turn === null || turnId !== turn)) ended = true;
    else if (entry.type === "turn_context" && turn !== null && turnId !== null && turnId !== turn) ended = true;
    else if (ended && modelStep(entry)) return { kind: "dropped" };
  }
  return { kind: "waiting", cursor: { pos, ended } };
}

/** The rollout's state at a hand-off: its size, and the turn the last turn marker names. Null when it cannot be read. */
export async function codexSightStartOf(rollout: string): Promise<CodexSightStart | null> {
  try {
    const info = await stat(rollout);
    if (!info.isFile()) return null;
    const file = await open(rollout, "r");
    try {
      const length = Math.min(info.size, TURN_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, info.size - length);
      const lines = buffer.toString("utf8").split("\n");
      let turn: string | null = null;
      for (let i = lines.length - 1; i >= 0 && turn === null; i--) {
        const line = lines[i]!;
        if (!line.includes('"turn_id"')) continue;
        const entry = parse(line);
        const isMarker = (entry?.type === "event_msg" && TURN_STARTS.has(String(entry.payload?.type))) || entry?.type === "turn_context";
        if (isMarker && typeof entry?.payload?.turn_id === "string") turn = entry.payload.turn_id;
      }
      return { rollout, offset: info.size, turn };
    } finally {
      await file.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

/**
 * When the text was handed on (ms), and, for a thread whose Codex the Inbox runs (a launched one), whether its host
 * says a turn runs now (true: the turn it was steered into has not ended, so it is never judged dropped by silence).
 */
export interface CodexSightHanded {
  at: number;
  running?: () => boolean | null;
}

/**
 * One look at the rollout for a handed-on text: `seen`, `dropped`, or `waiting` with how far it got. `now` and the
 * file's last write decide a turn that ended and then went quiet (CODEX_SIGHT_QUIET_MS). A rollout that cannot be read
 * is waiting: nothing is decided on a file that is not there.
 */
export async function lookForCodexSight(start: CodexSight, cursor: CodexSightCursor | null, now: number, handed: CodexSightHanded): Promise<CodexSightAnswer> {
  const mark: CodexSightMark = start;
  const from = cursor ?? { pos: start.offset, ended: false };
  try {
    const info = await stat(start.rollout);
    if (!info.isFile()) return { kind: "waiting", cursor: from };
    let answer: CodexSightAnswer = { kind: "waiting", cursor: from };
    if (info.size > from.pos) {
      const file = await open(start.rollout, "r");
      try {
        const length = Math.min(info.size - from.pos, READ_MAX_BYTES);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, from.pos);
        // Whole lines only: the cut is on a newline byte, never inside a character.
        const whole = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (whole >= 0) answer = codexSightIn(buffer.subarray(0, whole + 1).toString("utf8"), mark, start.turn, from);
      } finally {
        await file.close().catch(() => {});
      }
    }
    if (answer.kind === "waiting" && answer.cursor.ended && answer.cursor.pos >= info.size && now - info.mtimeMs >= CODEX_SIGHT_QUIET_MS) return { kind: "dropped" };
    // A Codex that crashed mid-turn: its rollout stopped; the give-up time after both the hand-off and its last
    // write, the next turn, once. Never while the host says the turn still runs (a long tool call writes nothing).
    const silent = now - info.mtimeMs >= CODEX_SIGHT_GIVE_UP_MS && now - handed.at >= CODEX_SIGHT_GIVE_UP_MS;
    if (answer.kind === "waiting" && answer.cursor.pos >= info.size && silent && handed.running?.() !== true) return { kind: "dropped" };
    return answer;
  } catch {
    return { kind: "waiting", cursor: from };
  }
}
