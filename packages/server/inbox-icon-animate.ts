/**
 * Plannotator Inbox: "Animate it" (the agent icon dialog's "Your own…"). The person asks an agent, in a new thread, to
 * animate one of their pictures; the agent hands the result back with `plannotator inbox icon set <file> --request <id>`
 * (apps/hook/server/inbox-icon-command.ts), and that agent's icon becomes it in every window. Bun only: the Inbox runs
 * on the Bun server; the Pi server serves no Inbox route.
 *
 *   inbox/icon-animate.json   { v: 1, requests: [{ id, agent, sessions, icon, result, at }] }, newest last, 0600
 *
 * The one door agents have to an icon, and a narrow one: a request names one agent and the picture it showed, so a
 * hand-back can only replace that agent's icon, and only while it still shows that picture (or this request's own
 * earlier result: "make it slower" in the same thread works). A request asked about nothing else is refused. The
 * picture goes through the upload's own keeping (`AgentIcons.add`: sniffed, at most 512 KB, drawn only as an `<img>`),
 * never a second check.
 *
 *   POST /api/inbox/icon-animate  `{ animate: { icon, agent, sessions } }`  a request; `{ request: <id> }`
 *   POST /api/inbox/icon-animate  `{ request, picture: "data:…;base64,…" }` the hand-back; `{ applied, icon }`
 *   GET  /api/inbox/icon-animate                                            `{ results: [{ icon, result }] }` (no ids)
 *
 * This computer (an agent's command reaches the loopback listener) and the owner's windows over the tailnet.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanInboxFaceSessions, isInboxAgentFaceId } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import type { InboxAgentFacesFile } from "@plannotator/shared/inbox/agent-faces";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { AGENT_ICON_NOT_IMAGE, AGENT_ICON_TOO_BIG, type AgentIcons } from "./inbox-agent-icons";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";

export const INBOX_ICON_ANIMATE_PATH = "/api/inbox/icon-animate";
export const INBOX_ICON_ANIMATE_FILE = "icon-animate.json";
/** The requests kept: the oldest goes past this (its hand-back is then refused as unknown). */
export const ICON_ANIMATE_KEPT = 30;

const HASH = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^ia_[0-9a-f]{24}$/;

/** The words an agent's command prints for a refusal (the window never shows them). */
export const ICON_ANIMATE_WORDS = {
  unknown: "No such request. Use the request id from the Inbox message that asked you to animate the icon.",
  notApplied: "Kept with the person's pictures, but not shown: they changed this agent's icon since they asked.",
} as const;

export interface IconAnimateRequest {
  id: string;
  /** The agent whose icon it is (its faces key) and the sessions it is. */
  agent: string;
  sessions: string[];
  /** The picture it showed when asked (sha256). */
  icon: string;
  /** The last picture handed back for it, once one was. */
  result: string | null;
  at: number;
}

function readRequests(file: string): IconAnimateRequest[] {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; requests?: unknown };
    if (value?.v !== 1 || !Array.isArray(value.requests)) return [];
    return value.requests.filter(
      (r): r is IconAnimateRequest =>
        !!r && REQUEST_ID.test(r.id) && isInboxAgentFaceId(r.agent) && Array.isArray(r.sessions) && HASH.test(r.icon) && (r.result === null || HASH.test(r.result)) && typeof r.at === "number",
    );
  } catch {
    return [];
  }
}

export function createInboxIconAnimate(options: {
  inboxDir: string;
  icons: AgentIcons;
  faces: InboxAgentFacesFile;
  serverSession: string;
  localOnly: () => Response;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /** The pictures kept (or one added): every window hears it, as an upload does. */
  touch: () => void;
  now?: () => number;
}) {
  const { icons, faces, json } = options;
  const file = join(options.inboxDir, INBOX_ICON_ANIMATE_FILE);
  const now = options.now ?? Date.now;
  let cached: IconAnimateRequest[] | null = null;
  const list = () => (cached ??= readRequests(file));
  const save = (requests: IconAnimateRequest[]) => {
    const kept = requests.slice(-ICON_ANIMATE_KEPT);
    mkdirSync(options.inboxDir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, requests: kept })}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    cached = kept;
  };

  const ask = (body: Record<string, unknown>): Response => {
    const animate = body.animate as Record<string, unknown> | null;
    if (!animate || typeof animate !== "object") throw new InboxError("validation_error", "animate: { icon, agent }.", { field: "animate" });
    if (typeof animate.icon !== "string" || !HASH.test(animate.icon)) throw new InboxError("validation_error", "icon: a picture's id.", { field: "icon" });
    if (!isInboxAgentFaceId(animate.agent)) throw new InboxError("validation_error", "agent: the agent's id.", { field: "agent" });
    if (!icons.read(animate.icon, true)) throw new InboxError("validation_error", "No such picture.", { field: "icon" });
    const request: IconAnimateRequest = {
      id: `ia_${randomBytes(12).toString("hex")}`,
      agent: animate.agent,
      sessions: cleanInboxFaceSessions(animate.sessions, animate.agent),
      icon: animate.icon,
      result: null,
      at: now(),
    };
    save([...list(), request]);
    return json({ request: request.id });
  };

  const handBack = (body: Record<string, unknown>): Response => {
    const id = typeof body.request === "string" ? body.request.trim() : "";
    const index = list().findIndex((r) => r.id === id);
    if (!REQUEST_ID.test(id) || index < 0) return json({ error: ICON_ANIMATE_WORDS.unknown, code: "no_request" }, 404);
    const request = list()[index]!;
    // The upload's own keeping: the same sniffing, cap and words.
    const given = typeof body.picture === "string" ? body.picture : "";
    if (given.length > 800_000) throw new InboxError("validation_error", AGENT_ICON_TOO_BIG, { field: "picture" });
    const dataUrl = /^data:[a-z0-9.+/-]*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(given);
    const saved = dataUrl ? icons.add(new Uint8Array(Buffer.from(dataUrl[1]!, "base64"))) : ({ ok: false, reason: "not_image" } as const);
    if (!saved.ok) {
      if (saved.reason === "not_saved") throw new InboxError("config_not_saved", "The picture did not change.");
      throw new InboxError("validation_error", saved.reason === "too_big" ? AGENT_ICON_TOO_BIG : AGENT_ICON_NOT_IMAGE, { field: "picture" });
    }
    const result = saved.icon.id;
    // Only the agent asked about, and only while it shows what it showed then (or this request's last result).
    const showing = faces.wire().faces[request.agent]?.face;
    const applied = showing === `own:${request.icon}` || (request.result !== null && showing === `own:${request.result}`) || showing === `own:${result}`;
    const requests = list().slice();
    requests[index] = { ...request, result };
    save(requests);
    if (applied && showing !== `own:${result}`) faces.change({ agent: request.agent, sessions: request.sessions, face: `own:${result}` });
    else options.touch();
    return json({ applied, icon: result, ...(applied ? {} : { note: ICON_ANIMATE_WORDS.notApplied }) });
  };

  const route = async (req: Request, url: URL, owner: boolean): Promise<Response | null> => {
    if (url.pathname !== INBOX_ICON_ANIMATE_PATH) return null;
    if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
    if (!owner) return options.localOnly();
    if (req.method === "GET") return json({ results: list().flatMap((r) => (r.result ? [{ icon: r.icon, result: r.result }] : [])) });
    if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    return body.animate !== undefined ? ask(body) : handBack(body);
  };

  /** The pictures a request still points at: never the ones the cap removes (the original stays one click away). */
  const kept = (): Set<string> => new Set(list().flatMap((r) => [`own:${r.icon}`, ...(r.result ? [`own:${r.result}`] : [])]));

  return { route, kept };
}
