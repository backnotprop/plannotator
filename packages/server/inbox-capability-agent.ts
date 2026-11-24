/**
 * `plannotator inbox capability` (apps/hook/server/inbox-capability-command.ts) on the Inbox's side: an agent turns
 * one of Settings → Capabilities' switches on or off when the person asks it to (the owner, 2026-11-24: "Yes, an
 * agent I ask can turn any capability on or off"). A command and not an action of the agent tool (the owner,
 * 2026-11-24: "don't bloat or change the tool as it was for this customer configuration stuff ... Just add it to the
 * cli help"): the route `/api/inbox/capability`, which the command calls on this computer's listener, and a paired
 * cloud agent's through the agent door's `route` (inbox-agent-routes.ts).
 *
 * A turn here is a flip like the person's own, so every linked computer takes it (inbox-capability-set.ts): there is
 * no computer to name.
 *
 * Only the switches a person sees there (core `INBOX_CAPABILITY_AGENT_SWITCHES`: a hidden one, as System is, is not
 * offered). A turn posts one line for the person, as the agent, on this computer only: in the thread it names, else in
 * a new thread in its project, with no sound.
 */

import { INBOX_CAPABILITY_AGENT_IDS, INBOX_CAPABILITY_AGENT_SWITCHES, INBOX_CAPABILITY_SWITCHES, type InboxCapabilitySwitches, type InboxCapabilitySwitchKey } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { NO_CHANGE_LINE } from "./inbox-mcp-scheduled";

/** The route the command calls: `GET` lists, `POST` turns one. */
export const INBOX_CAPABILITY_ROUTE = "/api/inbox/capability";

export interface InboxCapabilityTurnBy {
  host: string;
  session: string;
  name: string;
}

export interface InboxCapabilityContext {
  /** The project an agent's path names. */
  resolveProject?: (path: string) => Promise<{ id: string }>;
  /** This computer's switches, each one it offers now. */
  here: () => InboxCapabilitySwitches;
  /** Turns one here, as Settings does (so every linked computer takes it); answers the switches after. */
  set: (key: InboxCapabilitySwitchKey, on: boolean) => Promise<InboxCapabilitySwitches>;
  /**
   * The one line for the person: in that thread, else a new thread in the agent's project (`project`, asked only
   * then: a lookup may make it). The thread id, or null when it had nowhere to go.
   */
  tell: (by: InboxCapabilityTurnBy, threadId: string | null, project: () => Promise<string | null>, body: string) => Promise<string | null>;
}

/** What the command sends: a list without `on`, a turn with `capability` and `on`. `by`: the agent, as its shell names it. */
export interface InboxCapabilityAsk {
  capability?: string;
  on?: boolean;
  thread_id?: string;
  project_path?: string;
  /** The agent's project by id (a paired cloud agent's own, as the agent door names it), in place of `project_path`. */
  project_id?: string;
  by?: { host?: string; session?: string; name?: string };
}

/** The answer: `text` for the agent, and the switches. */
export interface InboxCapabilityAnswer {
  text: string;
  structured: Record<string, unknown>;
}

const switchOf = (id: string) => INBOX_CAPABILITY_SWITCHES.find((s) => s.agent === id)!;

/**
 * Only the switches an agent may see, by the names the command takes (`routines`, not the settings key): a hidden one
 * never shows in a list or a structured answer.
 */
const shown = (switches: InboxCapabilitySwitches): Record<string, { on: boolean }> =>
  Object.fromEntries(INBOX_CAPABILITY_AGENT_SWITCHES.flatMap((s) => (switches[s.key] ? [[s.agent, switches[s.key]!]] : [])));

const listLine = (where: string, switches: InboxCapabilitySwitches) => {
  const parts = INBOX_CAPABILITY_AGENT_SWITCHES.flatMap((s) => (switches[s.key] ? [`${s.agent} ${switches[s.key]!.on ? "on" : "off"}`] : []));
  return parts.length === 0 ? `${where}: none offered.` : `${where}: ${parts.join(", ")}.`;
};

/** The action a switch serves in this Inbox's own tools, and its shell form, which works as soon as the switch is on. */
const SERVES: Partial<Record<InboxCapabilitySwitchKey, { action: string; shell: string }>> = {
  board: { action: "card", shell: "plannotator card --help" },
  steps: { action: "steps", shell: "plannotator inbox steps <thread> --json '<list>'" },
  scheduled_threads: { action: "routine", shell: "plannotator routine --help" },
};

/** A switch on here that serves an action: a session listed before has no such action yet (tool lists are made at start). */
function servesLine(key: InboxCapabilitySwitchKey): string {
  const serves = SERVES[key];
  return serves ? ` Agents get the ${serves.action} action in their next session (a session's tools are listed once, at its start); from a shell it works now: \`${serves.shell}\`.` : "";
}

/** The line the person sees, as the agent: "Turned on Routines." */
export function capabilityLineText(name: string, on: boolean): string {
  return `Turned ${on ? "on" : "off"} ${name}.`;
}

const ASK_FIELDS = ["capability", "on", "thread_id", "project_path", "project_id", "by"];
const text = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new InboxError("validation_error", `${field}: a string.`, { field });
  return value;
};

/** The command's ask, checked: an unknown field, a capability not an agent's, or a state not true or false is refused. */
export function capabilityAskOf(body: Record<string, unknown>): InboxCapabilityAsk {
  const extra = Object.keys(body).find((field) => !ASK_FIELDS.includes(field));
  if (extra) throw new InboxError("validation_error", `${extra}: not taken here.`, { field: extra });
  const capability = text(body.capability, "capability");
  if (capability !== undefined && !(INBOX_CAPABILITY_AGENT_IDS as readonly string[]).includes(capability)) {
    throw new InboxError("validation_error", `capability: one of ${INBOX_CAPABILITY_AGENT_IDS.join(", ")}.`, { field: "capability" });
  }
  if (body.on !== undefined && typeof body.on !== "boolean") throw new InboxError("validation_error", "on: true or false.", { field: "on" });
  const by = body.by && typeof body.by === "object" && !Array.isArray(body.by) ? (body.by as Record<string, unknown>) : null;
  return {
    ...(capability !== undefined ? { capability } : {}),
    ...(typeof body.on === "boolean" ? { on: body.on } : {}),
    ...(text(body.thread_id, "thread_id") !== undefined ? { thread_id: body.thread_id as string } : {}),
    ...(text(body.project_path, "project_path") !== undefined ? { project_path: body.project_path as string } : {}),
    ...(text(body.project_id, "project_id") !== undefined ? { project_id: body.project_id as string } : {}),
    ...(by ? { by: { host: typeof by.host === "string" ? by.host : undefined, session: typeof by.session === "string" ? by.session : undefined, name: typeof by.name === "string" ? by.name : undefined } } : {}),
  };
}

/** List the switches, or turn one: the answer, or an InboxError with the refusal. */
export async function capabilityAnswer(caps: InboxCapabilityContext, input: InboxCapabilityAsk): Promise<InboxCapabilityAnswer> {
  const done = (words: string, structured: Record<string, unknown>): InboxCapabilityAnswer => ({ text: words, structured });
  if (input.on === undefined) {
    if (input.capability) throw new InboxError("validation_error", "on: true or false, to turn it; leave capability out to list them.", { field: "on" });
    return done(listLine("On this computer", caps.here()), { capabilities: shown(caps.here()) });
  }
  if (!input.capability) throw new InboxError("validation_error", `capability: one of ${INBOX_CAPABILITY_AGENT_IDS.join(", ")}.`, { field: "capability" });
  const { key, name } = switchOf(input.capability);
  const on = input.on;
  const host = input.by?.host?.trim() || "";
  const by: InboxCapabilityTurnBy = { host: host || "agent", session: input.by?.session?.trim() || "", name: input.by?.name?.trim() || host || "Agent" };
  // The agent's own project, by the lookup of the way it came, so the line lands where it works.
  const projectPath = input.project_path?.trim() || null;
  const resolve = caps.resolveProject;
  const projectId = input.project_id?.trim() || null;
  const project = async () => projectId ?? (projectPath && resolve ? ((await resolve(projectPath).catch(() => null))?.id ?? null) : null);
  const threadId = input.thread_id?.trim() || null;
  const state = on ? "on" : "off";
  const before = caps.here()[key];
  if (!before) throw new InboxError("not_offered", `${name} is not offered on this computer.`);
  if (before.on === on) return done(`${name} was already ${state} (this computer). Nothing changed.${on ? servesLine(key) : ""}`, { capabilities: shown(caps.here()) });
  const after = await caps.set(key, on);
  // One line, here: a linked computer that takes the flip posts none.
  const told = await caps.tell(by, threadId, project, capabilityLineText(name, on));
  return done(`Turned ${state} ${name}.${told ? ` The person sees it in thread ${told}.` : NO_CHANGE_LINE}${on ? servesLine(key) : ""}`, { capabilities: shown(after) });
}

const STATUS: Record<string, number> = { validation_error: 422, not_offered: 409 };

/**
 * `/api/inbox/capability`: `GET` lists, `POST` (an ask) lists or turns. The answer is `{ text, ...structured }`; a
 * refusal `{ code, error }`. Null for any other path. This computer's agents' only: a request through a device door
 * (a phone, a linked computer; `fromDeviceDoor`) is not found here, as on an Inbox without the route, and another
 * site's page is refused, read or write.
 */
export async function capabilityRoute(req: Request, url: URL, caps: InboxCapabilityContext, readBody: (req: Request) => Promise<Record<string, unknown>>, fromDeviceDoor = false): Promise<Response | null> {
  if (url.pathname !== INBOX_CAPABILITY_ROUTE) return null;
  if (fromDeviceDoor) return Response.json({ error: "Not found", code: "not_found" }, { status: 404 });
  if (!isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
    return Response.json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, { status: 403 });
  }
  if (req.method !== "GET" && req.method !== "POST") return Response.json({ error: "Use GET or POST." }, { status: 405 });
  try {
    const ask = req.method === "GET" ? {} : capabilityAskOf(await readBody(req));
    const answer = await capabilityAnswer(caps, ask);
    return Response.json({ text: answer.text, ...answer.structured });
  } catch (error) {
    if (error instanceof InboxError) return Response.json({ code: error.code, error: error.message }, { status: STATUS[error.code] ?? 422 });
    return Response.json({ code: "internal_error", error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
