/**
 * Plannotator Inbox, step 3: decisions. The rules over the store's decision
 * lines (packages/shared/inbox/store.ts keeps the records; the shapes are
 * `InboxDecision` in packages/core/inbox-types.ts) and the window's routes.
 *
 * Owner ruling Q5 (2026-10-06): decisions live in the Inbox's own store, one
 * `decisions.jsonl` per project under the data dir, with Workspaces' fields
 * (text, reason, source, state `current | replaced | retired`, version,
 * `decision_id` on the question), so a later sync is a mapping.
 *
 * A decision is written two ways: at Send, for every sent question whose
 * card switch is on (the approved `inbox-decision-toggle`: the tag is the
 * switch, the card keeps the words, the decision records at Send), and by an
 * agent's `record_decision`. The person retires or replaces one on the
 * Decisions page; nothing is ever deleted, so history stays.
 */

import {
  inboxAgentName,
  inboxId,
  isInboxId,
  type InboxDecision,
  type InboxDecisionAgent,
  type InboxDecisionDraft,
  type InboxQuestion,
  type InboxQuestionRecord,
} from "@plannotator/core/inbox-types";
import { inboxDecisionRecording, inboxDecisionWords, toInboxQuestion } from "@plannotator/core/inbox-questions";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** The decision rules' refusals and their HTTP status (merged into the server's table). */
export const INBOX_DECISION_ERROR_STATUS: Record<string, number> = {
  decision_not_found: 404,
  decision_version_conflict: 409,
  decision_not_current: 409,
};

/** A question that will record a decision once answered and sent: the Decisions page's Waiting group. */
export interface InboxWaitingDecision {
  question_id: string;
  message_id: string;
  thread_id: string;
  project_id: string;
  prompt: string;
  agent: InboxDecisionAgent | null;
  asked_at: string;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InboxError("validation_error", `${field}: write the decision first.`, { field });
  }
  return value.trim();
}

function optionalReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new InboxError("validation_error", "reason: must be a string.", { field: "reason" });
  return value.trim() || null;
}

function agentOf(author: { kind: string; host?: string | null; session?: string | null; name?: string | null }): InboxDecisionAgent | null {
  return author.kind === "agent" ? { host: author.host ?? null, session: author.session ?? null, name: author.name ?? null } : null;
}

function questionWire(store: InboxStore, record: InboxQuestionRecord): InboxQuestion {
  const message = store.message(record.message_id);
  const root = message ? store.message(message.thread_id) : null;
  return toInboxQuestion(record, root?.resolved_at != null);
}

function parseDraft(value: unknown): InboxDecisionDraft | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InboxError("validation_error", "draft: { text, reason } or null.", { field: "draft" });
  }
  const draft = value as Record<string, unknown>;
  for (const field of ["text", "reason"] as const) {
    if (draft[field] !== null && draft[field] !== undefined && typeof draft[field] !== "string") {
      throw new InboxError("validation_error", `draft.${field}: a string or null.`, { field: `draft.${field}` });
    }
  }
  const text = typeof draft.text === "string" ? draft.text.trim() || null : null;
  const reason = typeof draft.reason === "string" ? draft.reason.trim() : null;
  return text === null && reason === null ? null : { text, reason };
}

/**
 * The card's switch and its words on one question, saved at once (the
 * person's state, like a pick, but never touching the answer's revision).
 * `draft` is what Done keeps; Done also turns the switch on.
 */
export function setQuestionDecision(
  store: InboxStore,
  messageId: string,
  input: { key?: unknown; recording?: unknown; draft?: unknown },
): InboxQuestion {
  const message = store.message(messageId);
  if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
  if (store.message(message.thread_id)?.resolved_at != null) {
    throw new InboxError("thread_resolved", "This thread is resolved; reopen it to answer.");
  }
  if (typeof input.key !== "string") throw new InboxError("validation_error", "key: required.", { field: "key" });
  const record = store.questionRecord(`${messageId}/${input.key}`);
  if (!record) throw new InboxError("question_not_found", `No question ${input.key} on this message.`, { key: input.key });
  if (record.decision_id !== null || questionWire(store, record).state === "sent") {
    throw new InboxError("question_already_sent", `The answer to ${input.key} was already sent.`, { key: input.key });
  }
  const patch: Partial<Pick<InboxQuestionRecord, "decision_recording" | "decision_draft">> = {};
  if (input.recording !== undefined) {
    if (typeof input.recording !== "boolean") throw new InboxError("validation_error", "recording: must be a boolean.", { field: "recording" });
    patch.decision_recording = input.recording;
  }
  if (input.draft !== undefined) patch.decision_draft = parseDraft(input.draft);
  if (Object.keys(patch).length === 0) throw new InboxError("validation_error", "recording or draft: give one.", { field: "recording" });
  return questionWire(store, store.writeQuestionDecision(record.id, patch));
}

/**
 * At Send: a decision for every question this reply sent whose switch is
 * on, in the card's words (or the drafted ones), and `decision_id` on the
 * question. Runs after the reply landed and never undoes it: a decision
 * that cannot be written is reported in `refused` and the answer stays sent.
 * A question already linked to a decision is skipped, so a replayed Send
 * records nothing twice and a retried one fills in what a crash missed.
 */
export function recordDecisionsForReply(
  store: InboxStore,
  replyId: string,
): { recorded: InboxDecision[]; refused: { key: string; code: string; message: string }[] } {
  const recorded: InboxDecision[] = [];
  const refused: { key: string; code: string; message: string }[] = [];
  const reply = store.message(replyId);
  const asked = reply?.reply_to ? store.message(reply.reply_to) : null;
  if (!reply || !asked) return { recorded, refused };
  for (const question of store.questionsOf(asked.id)) {
    const record = store.questionRecord(`${asked.id}/${question.key}`)!;
    if (record.sent_reply_id !== replyId || record.decision_id !== null || !inboxDecisionRecording(record)) continue;
    const words = inboxDecisionWords({
      answer: question.answer,
      prompt: record.prompt,
      askerName: inboxAgentName(asked.author),
      draft: record.decision_draft,
    });
    if (words.text === null) continue;
    const decision: InboxDecision = {
      id: inboxId("dec"),
      project_id: asked.project_id,
      text: words.text,
      reason: words.reason.trim() || null,
      source: { kind: "answer", question_id: record.id, message_id: asked.id, thread_id: asked.thread_id, agent: agentOf(asked.author) },
      state: "current",
      version: 1,
      replaces_id: null,
      replacement_id: null,
      created_at: reply.created_at,
      changed_at: null,
      idempotency_key: null,
    };
    try {
      store.writeDecision(decision);
      store.writeQuestionDecision(record.id, { decision_id: decision.id });
      recorded.push(decision);
    } catch (error) {
      refused.push({
        key: record.key,
        code: error instanceof InboxError ? error.code : "decision_not_saved",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { recorded, refused };
}

function currentDecision(store: InboxStore, id: string, version: unknown): InboxDecision {
  const decision = isInboxId("dec", id) ? store.decision(id) : null;
  if (!decision) throw new InboxError("decision_not_found", `No decision ${id}.`);
  if (decision.state !== "current") {
    throw new InboxError("decision_not_current", `This decision is already ${decision.state}.`, { state: decision.state });
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new InboxError("validation_error", "version: the decision's version as you read it.", { field: "version" });
  }
  if (decision.version !== version) {
    throw new InboxError("decision_version_conflict", `The decision changed since you read it (version ${decision.version}).`, {
      version: decision.version,
    });
  }
  return decision;
}

/** Retire: the decision no longer holds. It stays, folded under "Replaced or retired". */
export function retireDecision(store: InboxStore, id: string, version: unknown): InboxDecision {
  const old = currentDecision(store, id, version);
  const at = new Date().toISOString();
  const retired: InboxDecision = { ...old, state: "retired", version: old.version + 1, changed_at: at };
  store.writeDecision(retired);
  return retired;
}

/**
 * Replace: a new decision (version 1, `replaces_id`) in the person's words,
 * and the old one marked `replaced` with `replacement_id`, so both stay.
 */
export function replaceDecision(
  store: InboxStore,
  id: string,
  input: { version?: unknown; text?: unknown; reason?: unknown },
): { decision: InboxDecision; replaced: InboxDecision } {
  const old = currentDecision(store, id, input.version);
  const text = nonEmpty(input.text, "text");
  if (text === old.text) throw new InboxError("validation_error", "text: write a different decision to replace this one.", { field: "text" });
  const at = new Date().toISOString();
  const next: InboxDecision = {
    id: inboxId("dec"),
    project_id: old.project_id,
    text,
    reason: optionalReason(input.reason),
    source: { kind: "person", question_id: null, message_id: null, thread_id: null, agent: null },
    state: "current",
    version: 1,
    replaces_id: old.id,
    replacement_id: null,
    created_at: at,
    changed_at: null,
    idempotency_key: null,
  };
  store.writeDecision(next);
  const replaced: InboxDecision = { ...old, state: "replaced", replacement_id: next.id, version: old.version + 1, changed_at: at };
  store.writeDecision(replaced);
  return { decision: next, replaced };
}

/**
 * record_decision: an agent records a decision in a project. Idempotent on
 * the key: the same key with the same words answers the first decision.
 */
export function recordAgentDecision(
  store: InboxStore,
  input: { project_id: string; text: string; reason?: string | null; agent: InboxDecisionAgent; idempotency_key?: string | null },
): { decision: InboxDecision; replayed: boolean } {
  const text = nonEmpty(input.text, "text");
  const reason = optionalReason(input.reason);
  const key = input.idempotency_key?.trim() || null;
  if (key) {
    const first = store.decisionsOf(input.project_id).find((d) => d.idempotency_key === key && d.source.kind === "agent");
    if (first) {
      // The first decision's own words, as recorded (a later replace or retire does not change them).
      const original = first.text === text && first.reason === reason;
      if (!original) throw new InboxError("idempotency_key_reused", "This idempotency_key was already used for a different decision.", { decision_id: first.id });
      return { decision: first, replayed: true };
    }
  }
  const decision: InboxDecision = {
    id: inboxId("dec"),
    project_id: input.project_id,
    text,
    reason,
    source: { kind: "agent", question_id: null, message_id: null, thread_id: null, agent: input.agent },
    state: "current",
    version: 1,
    replaces_id: null,
    replacement_id: null,
    created_at: new Date().toISOString(),
    changed_at: null,
    idempotency_key: key,
  };
  store.writeDecision(decision);
  return { decision, replayed: false };
}

/** Questions that record a decision once answered and sent, in an open thread; one project's, or every project's. */
export function waitingDecisions(store: InboxStore, projectId?: string | null): InboxWaitingDecision[] {
  const projects = projectId ? [projectId] : store.listProjects().map((p) => p.id);
  const out: InboxWaitingDecision[] = [];
  for (const id of projects) {
    for (const record of store.questionRecordsOf(id)) {
      if (record.decision_id !== null || !inboxDecisionRecording(record)) continue;
      const state = questionWire(store, record).state;
      if (state !== "open" && state !== "picked") continue;
      const message = store.message(record.message_id)!;
      out.push({
        question_id: record.id,
        message_id: record.message_id,
        thread_id: message.thread_id,
        project_id: record.project_id,
        prompt: record.prompt,
        agent: agentOf(message.author),
        asked_at: message.created_at,
      });
    }
  }
  return out;
}

/** The Decisions page for one project: what waits on a call, then every decision. */
export function decisionsModel(store: InboxStore, projectId: string) {
  return { project_id: projectId, waiting: waitingDecisions(store, projectId), decisions: store.decisionsOf(projectId) };
}

/** The decisions a thread's questions link to, for its "Settled: ..." lines. */
export function threadDecisions(store: InboxStore, questionDecisionIds: readonly (string | null)[]): InboxDecision[] {
  const out: InboxDecision[] = [];
  for (const id of questionDecisionIds) {
    const decision = id ? store.decision(id) : null;
    if (decision) out.push(decision);
  }
  return out;
}

export interface InboxDecisionRouteContext {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /** The `serverSession` guard: a Response for a stale tab, else null. */
  staleTab: (body: Record<string, unknown>) => Response | null;
}

/**
 * The window's decision routes, or null when the path is not one of them:
 *   GET  /api/inbox/decisions?project=prj_...     the Decisions page
 *   POST /api/inbox/messages/:id/decision         { key, recording?, draft? }
 *   POST /api/inbox/decisions/:id/retire          { version }
 *   POST /api/inbox/decisions/:id/replace         { version, text, reason? }
 * Origin and Host are checked by the server before this runs.
 */
export async function handleInboxDecisionRoute(req: Request, url: URL, context: InboxDecisionRouteContext): Promise<Response | null> {
  const { store, json } = context;
  const path = url.pathname;
  if (path === "/api/inbox/decisions") {
    if (req.method !== "GET") return json({ error: "Use GET." }, 405);
    const projectId = url.searchParams.get("project") ?? "";
    if (!isInboxId("prj", projectId)) throw new InboxError("validation_error", "project: a prj_ id.", { field: "project" });
    if (!store.project(projectId)) throw new InboxError("project_not_found", `No project ${projectId}.`);
    return json({ serverSession: context.serverSession, cursor: store.cursor(), ...decisionsModel(store, projectId) });
  }
  const switchMatch = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/decision$/.exec(path);
  const lifeMatch = /^\/api\/inbox\/decisions\/([A-Za-z0-9_]+)\/(retire|replace)$/.exec(path);
  if (!switchMatch && !lifeMatch) return null;
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  const body = await context.readBody(req);
  const stale = context.staleTab(body);
  if (stale) return stale;
  if (switchMatch) return json({ question: setQuestionDecision(store, switchMatch[1]!, body) });
  const [, id, action] = lifeMatch!;
  if (action === "retire") return json({ decision: retireDecision(store, id!, body.version) });
  return json(replaceDecision(store, id!, body));
}
