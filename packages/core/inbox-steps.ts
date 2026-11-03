/**
 * Thread steps (approval "inbox-thread-steps", 2026-11-03): the agent's plan
 * for the work in one thread, as the person should see it. One list per
 * (thread, agent session), sent whole each time (it replaces the last one).
 *
 * Steps are their own records (store.ts, `steps.jsonl`): nothing that routes,
 * lists, counts unread or notifies reads them. The window shows them behind
 * the foot's steps button and in the thread's Board card; agents send them
 * only while the person has the switch on (Settings → Capabilities,
 * config.json `inboxSteps`, off by default).
 *
 * Pure: no runtime APIs, so the window, the server and the tools share it.
 */

import type { InboxAuthor } from "./inbox-types";
import { normalizeInboxCardText } from "./inbox-cards";

/** A step's state: Linear's status shapes in the window. `waiting` is on the person; `dropped` says why in its note. */
export const INBOX_STEP_STATUSES = ["todo", "doing", "done", "waiting", "dropped"] as const;
export type InboxStepStatus = (typeof INBOX_STEP_STATUSES)[number];

/** The most steps one list holds. */
export const INBOX_STEPS_MAX = 12;
/** The most characters a step's text, or its note, holds. */
export const INBOX_STEP_TEXT_MAX = 80;

/** One step as stored and served. `at`: when it took its status (the done time the window shows). */
export interface InboxStep {
  step: string;
  status: InboxStepStatus;
  note: string | null;
  at: string;
}

/** One agent session's steps in one thread. Its own record: a full snapshot per line, the last one current. */
export interface InboxSteps {
  /** `stp_…`, made on the session's first list in the thread and kept for its later ones. */
  id: string;
  project_id: string;
  thread_id: string;
  /** The session that keeps the list (an agent, with its session id). */
  agent: Extract<InboxAuthor, { kind: "agent" }>;
  /** Empty once the agent cleared it. */
  steps: InboxStep[];
  updated_at: string;
}

/**
 * How fresh a list is, from the session's presence (never from the list's
 * age): `working` while a turn runs, `idle` while the session is there but
 * waits, `ended` once it is gone. The window turns the in-progress mark only
 * while working, and adds "as of <time>" once ended.
 */
export type InboxStepsPresence = "working" | "idle" | "ended";

/** A list as the window reads it: the record, with its session's presence now. */
export interface InboxStepsWire extends InboxSteps {
  presence: InboxStepsPresence;
}

/** Done of counted, where a dropped step does not count; the step in progress, if any. */
export interface InboxStepsProgress {
  done: number;
  total: number;
  doing: string | null;
  waiting: boolean;
}

export function inboxStepsProgress(steps: readonly Pick<InboxStep, "step" | "status">[]): InboxStepsProgress {
  const counted = steps.filter((step) => step.status !== "dropped");
  return {
    done: counted.filter((step) => step.status === "done").length,
    total: counted.length,
    doing: counted.find((step) => step.status === "doing")?.step ?? null,
    waiting: counted.some((step) => step.status === "waiting"),
  };
}

/** A status as an agent may send it: trimmed, any case. Anything else is refused by the caller. */
export function inboxStepStatusOf(value: unknown): InboxStepStatus | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return (INBOX_STEP_STATUSES as readonly string[]).includes(key) ? (key as InboxStepStatus) : null;
}

/**
 * An agent's list made the stored one, or a refusal naming the field. Each
 * item `{ step, status, note? }`; at most INBOX_STEPS_MAX of them, each text
 * and note one line of at most INBOX_STEP_TEXT_MAX characters. A step that
 * keeps its text and status keeps its `at` from `previous`; any other takes
 * `at`. An empty list clears the session's steps.
 */
export function normalizeInboxSteps(value: unknown, previous: readonly InboxStep[], at: string): { steps: InboxStep[] } | { error: string; field: string } {
  if (!Array.isArray(value)) return { error: "steps: the whole list, an array of { step, status, note? }.", field: "steps" };
  if (value.length > INBOX_STEPS_MAX) return { error: `steps: at most ${INBOX_STEPS_MAX} steps (this list has ${value.length}).`, field: "steps" };
  const steps: InboxStep[] = [];
  for (const [index, raw] of value.entries()) {
    const where = `steps[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${where}: an object { step, status, note? }.`, field: where };
    const item = raw as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (key !== "step" && key !== "status" && key !== "note") return { error: `${where}.${key}: a step takes step, status and note only.`, field: `${where}.${key}` };
    }
    const text = normalizeInboxCardText(item.step, `${where}.step`, INBOX_STEP_TEXT_MAX);
    if ("error" in text) return { error: text.error, field: `${where}.step` };
    const status = inboxStepStatusOf(item.status);
    if (!status) return { error: `${where}.status: one of ${INBOX_STEP_STATUSES.join(", ")}.`, field: `${where}.status` };
    let note: string | null = null;
    if (item.note !== undefined && item.note !== null && !(typeof item.note === "string" && item.note.trim() === "")) {
      const checked = normalizeInboxCardText(item.note, `${where}.note`, INBOX_STEP_TEXT_MAX);
      if ("error" in checked) return { error: checked.error, field: `${where}.note` };
      note = checked.text;
    }
    const before = previous.find((step) => step.step === text.text);
    steps.push({ step: text.text, status, note, at: before && before.status === status ? before.at : at });
  }
  return { steps };
}

/** Whether two lists read the same (their times aside): a call that changes nothing writes nothing. */
export function sameInboxSteps(a: readonly InboxStep[], b: readonly InboxStep[]): boolean {
  return a.length === b.length && a.every((step, i) => step.step === b[i]!.step && step.status === b[i]!.status && step.note === b[i]!.note);
}

/** Whether a stored record reads as one (a line an older or broken writer left is skipped). */
export function isInboxStepsRecord(value: unknown): value is InboxSteps {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<InboxSteps>;
  return (
    typeof record.id === "string" &&
    typeof record.project_id === "string" &&
    typeof record.thread_id === "string" &&
    record.agent?.kind === "agent" &&
    typeof record.agent.session === "string" &&
    Array.isArray(record.steps) &&
    typeof record.updated_at === "string"
  );
}
