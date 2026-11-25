/**
 * `plannotator inbox canvas` (apps/hook/server/inbox-canvas-command.ts) on the Inbox's side: an agent reads a
 * thread's canvas as text, gets a picture of it, or changes it (inbox-canvas.ts `agent`). A command and not an action
 * of the agent tool (the owner, 2026-11-24: a feature some agents use adds no action or description to the tool; it
 * is taught where it starts and in the CLI's help): the route `/api/inbox/canvas/agent`, which the command calls on
 * this computer's listener, and a paired cloud agent's through the agent door's `route` (inbox-agent-routes.ts).
 *
 * Only while the canvas is on (Settings → Capabilities → Canvas): off, `409 canvas_off` and nothing is read or
 * written. This computer's agents' only: a request through a device door is not found here, and another site's
 * page is refused.
 */

import { INBOX_CANVAS_AGENT_ROUTE } from "@plannotator/shared/inbox/canvas/command";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import type { CanvasAgentAsk, InboxCanvas } from "./inbox-canvas";
import { INBOX_CANVAS_OFF_ANSWER } from "./inbox-canvas-switch";

export { INBOX_CANVAS_AGENT_ROUTE };

/** The fields an ask may carry besides `by` (who asks; the agent door sets it for a paired agent). */
export const CANVAS_AGENT_FIELDS = ["thread_id", "in", "things", "after_thing", "picture", "base", "do"] as const;

const refuse = (field: string, words: string) => new InboxError("validation_error", `${field}: ${words}`, { field });
const words = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw refuse(field, "a non-empty string.");
  return value;
};
const wordList = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((one) => typeof one !== "string" || !one.trim())) throw refuse(field, "a list of names or ids.");
  return value as string[];
};

/** The command's ask, checked: an unknown field or a field of the wrong kind is refused before anything is read. */
export function canvasAgentAskOf(body: Record<string, unknown>): CanvasAgentAsk {
  const extra = Object.keys(body).find((field) => field !== "by" && !(CANVAS_AGENT_FIELDS as readonly string[]).includes(field));
  if (extra) throw new InboxError("validation_error", `${extra}: not taken here.`, { field: extra });
  const threadId = words(body.thread_id, "thread_id");
  if (!threadId) throw refuse("thread_id", "the thread (or a message in it).");
  const picture = body.picture;
  if (picture !== undefined && picture !== true && typeof picture !== "string" && !Array.isArray(picture)) throw refuse("picture", "true, a thing, or a list of things.");
  if (body.base !== undefined && !Number.isInteger(body.base)) throw refuse("base", "a whole number, the rev of your last answer.");
  if (body.do !== undefined && !Array.isArray(body.do)) throw refuse("do", "a JSON list of changes.");
  const by = body.by && typeof body.by === "object" && !Array.isArray(body.by) ? (body.by as Record<string, unknown>) : null;
  const ask: CanvasAgentAsk = { thread_id: threadId };
  const frame = words(body.in, "in");
  if (frame) ask.in = frame;
  const things = wordList(body.things, "things");
  if (things) ask.things = things;
  const after = words(body.after_thing, "after_thing");
  if (after) ask.after_thing = after;
  if (picture !== undefined) ask.picture = typeof picture === "string" ? (words(picture, "picture") as string) : picture === true ? true : (wordList(picture, "picture") as string[]);
  if (body.base !== undefined) ask.base = body.base as number;
  if (body.do !== undefined) ask.do = body.do;
  if (by) ask.by = { host: typeof by.host === "string" ? by.host : undefined, session: typeof by.session === "string" ? by.session : undefined, name: typeof by.name === "string" ? by.name : undefined };
  return ask;
}

const STATUS: Record<string, number> = { validation_error: 422, thread_not_found: 404, canvas_unchanged: 409 };

/**
 * `/api/inbox/canvas/agent`: `POST` an ask; the answer is `{ text, thread_id, rev, … }`, a refusal `{ code, error }`
 * (a change that did not land: `409 canvas_unchanged`, its `error` the full answer). Null for any other path.
 */
export async function canvasAgentRoute(
  req: Request,
  url: URL,
  deps: { canvas: InboxCanvas; on: () => boolean; readBody: (req: Request) => Promise<Record<string, unknown>>; fromDeviceDoor: boolean },
): Promise<Response | null> {
  if (url.pathname !== INBOX_CANVAS_AGENT_ROUTE) return null;
  if (deps.fromDeviceDoor) return Response.json({ error: "Not found", code: "not_found" }, { status: 404 });
  if (!isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
    return Response.json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, { status: 403 });
  }
  if (req.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
  if (!deps.on()) return Response.json(INBOX_CANVAS_OFF_ANSWER, { status: 409 });
  try {
    const answer = await deps.canvas.agent(canvasAgentAskOf(await deps.readBody(req)));
    if (!answer.ok) return Response.json({ code: answer.code ?? "canvas_unchanged", error: answer.text, ...answer.structured }, { status: STATUS[answer.code ?? "canvas_unchanged"] ?? 409 });
    return Response.json({ text: answer.text, ...answer.structured });
  } catch (error) {
    if (error instanceof InboxError) return Response.json({ code: error.code, error: error.message }, { status: STATUS[error.code] ?? 422 });
    return Response.json({ code: "internal_error", error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
