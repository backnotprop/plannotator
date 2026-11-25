/**
 * Plannotator Inbox: "Animate it" and "Ask an agent to draw it" (the icon dialog, for an agent or a project). The person
 * asks an agent, in a new thread, to animate an icon (their own picture, a set's icon, or one of our faces) or to draw
 * a new one; the agent hands the result back with `plannotator inbox icon set <file> --request <id>`
 * (apps/hook/server/inbox-icon-command.ts), and that agent's icon, or that project's picture, becomes it in every
 * window. Bun only: the Inbox runs on the Bun server; the Pi server serves no Inbox route.
 *
 *   inbox/icon-animate.json   { v: 1, requests: [{ id, kind?, agent | project, sessions, icon, shown?, result, result_at?, at }] }, newest last, 0600
 *
 * `kind` is absent for Animate it and "draw" for a drawing. `icon` is what was animated: an uploaded picture's hash
 * (`own:<hash>` in the faces), or the face itself for a set's icon (`set:<set>/<icon>`) or one of our faces; null for a
 * drawing. `shown` is what the target showed when asked, where `icon` does not say it: a drawn agent's face (null: none
 * picked), a project's picture time (null: none set). A result is always an uploaded picture's hash; `result_at` is the
 * project picture's time it set.
 *
 * The one door agents have to an icon, and a narrow one: a request names one agent or one project and what it showed,
 * so a hand-back can only replace that icon, and only while it still shows that (or this request's own earlier result:
 * "make it slower" in the same thread works). A request about an icon that cannot be shown here (no such picture or set
 * icon, the agent's own mark, Transparent) or a project this Inbox does not have is refused. The picture goes through
 * the upload's own keeping (`AgentIcons.add`: sniffed, at most 512 KB, drawn only as an `<img>`), and a project's
 * through Set picture's too (`ProjectPictures.setUpload`, the same sniffing and cap).
 *
 *   POST /api/inbox/icon-animate  `{ animate: { icon, agent, sessions } | { icon, project } }`  a request; `{ request: <id> }`
 *   POST /api/inbox/icon-animate  `{ draw: { agent, sessions } | { project } }`                 a request; `{ request: <id> }`
 *   POST /api/inbox/icon-animate  `{ request, picture: "data:…;base64,…" }` the hand-back; `{ applied, icon, target }`
 *   GET  /api/inbox/icon-animate                                            `{ results: [{ icon, result }] }` (no ids)
 *
 * This computer (an agent's command reaches the loopback listener), the owner's windows over the tailnet, and a linked
 * machine's Inbox through its door: a window there asks about this Inbox's project, and an agent there hands back a
 * request kept here (`far`, which this Inbox asks in turn for a request it does not keep).
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanInboxFaceSessions, INBOX_AGENT_FACES, inboxSetFaceParts, isInboxAgentFaceId, isInboxId, isInboxSetFace } from "@plannotator/core/inbox-types";
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
/**
 * Our faces an agent can be asked to animate: each is one picture. Not the agent's own mark (the brand's, already a
 * moving rig) nor Transparent (two pictures, one per theme).
 */
const ANIMATABLE_OURS: ReadonlySet<string> = new Set(INBOX_AGENT_FACES.filter((face) => face !== "agent" && face !== "transparent"));
const isAnimatable = (icon: unknown): icon is string => typeof icon === "string" && (HASH.test(icon) || isInboxSetFace(icon) || ANIMATABLE_OURS.has(icon));
const shownFace = (icon: string) => (HASH.test(icon) ? `own:${icon}` : icon);

/** The words an agent's command prints for a refusal (the window never shows them). */
export const ICON_ANIMATE_WORDS = {
  unknown: "No such request. Use the request id from the Inbox message that asked you for the icon.",
  notApplied: "Kept with the person's pictures, but not shown: they changed this agent's icon since they asked.",
  notAppliedProject: "Kept with the person's pictures, but not shown: they changed this project's picture since they asked.",
} as const;

export interface IconAnimateRequest {
  id: string;
  /** Absent: Animate it. "draw": Ask an agent to draw it. */
  kind?: "draw";
  /** The agent whose icon it is (its faces key) and the sessions it is; absent for a project's. */
  agent?: string;
  /** The project whose picture it is; absent for an agent's. */
  project?: string;
  sessions: string[];
  /** What was animated: an uploaded picture's sha256, or the set icon's or our face's id. Null for a drawing. */
  icon: string | null;
  /** What the target showed when asked, where `icon` does not say it: a drawn agent's face, a project's picture time. */
  shown?: string | number | null;
  /** The last picture handed back for it, once one was. */
  result: string | null;
  /** The project picture's time that result set. */
  result_at?: number;
  at: number;
}

const isRequest = (r: IconAnimateRequest): boolean => {
  if (!r || !REQUEST_ID.test(r.id) || !Array.isArray(r.sessions) || typeof r.at !== "number" || !(r.result === null || HASH.test(r.result))) return false;
  if (r.project === undefined ? !isInboxAgentFaceId(r.agent) : !isInboxId("prj", r.project) || r.agent !== undefined) return false;
  return r.kind === "draw" ? r.icon === null : r.kind === undefined && isAnimatable(r.icon);
};

function readRequests(file: string): IconAnimateRequest[] {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; requests?: unknown };
    if (value?.v !== 1 || !Array.isArray(value.requests)) return [];
    return value.requests.filter(isRequest);
  } catch {
    return [];
  }
}

/** The projects a request may name: this Inbox's own, and their pictures (inbox-project-pictures.ts). */
export interface IconAnimateProjects {
  has: (projectId: string) => boolean;
  uploadedAt: (projectId: string) => number | undefined;
  setUpload: (projectId: string, bytes: Uint8Array) => { ok: true; at: number } | { ok: false; reason: "not_image" | "too_big" | "not_saved" };
  /** A project's picture changed: every window, and every linked machine, reads the projects again. */
  changed: () => void;
}

export function createInboxIconAnimate(options: {
  inboxDir: string;
  icons: AgentIcons;
  faces: InboxAgentFacesFile;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /** The pictures kept (or one added): every window hears it, as an upload does. */
  touch: () => void;
  /** Whether a set's icon can be served here (a built-in set's, or a fetched set's that is kept). */
  setIconKept: (set: string, icon: string) => boolean | Promise<boolean>;
  /** The projects a request may name. Absent: requests name agents only. */
  projects?: IconAnimateProjects;
  /**
   * A hand-back for a request this Inbox does not keep: asks each linked machine (a request about its project, or one a
   * window there made). Null: none keeps it.
   */
  far?: (handBack: { request: string; picture: string }) => Promise<Response | null>;
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

  /** The target a request names: one agent (its id and sessions), or one of this Inbox's projects. */
  const targetOf = (given: Record<string, unknown>): { agent: string; sessions: string[] } | { project: string } => {
    if (given.project !== undefined) {
      if (!options.projects || !isInboxId("prj", given.project) || !options.projects.has(given.project)) throw new InboxError("project_not_found", "No such project.", { field: "project" });
      return { project: given.project };
    }
    if (!isInboxAgentFaceId(given.agent)) throw new InboxError("validation_error", "agent: the agent's id.", { field: "agent" });
    return { agent: given.agent, sessions: cleanInboxFaceSessions(given.sessions, given.agent) };
  };
  /** What a project showed when asked: its picture's time, or null with none set. */
  const projectShown = (project: string) => options.projects?.uploadedAt(project) ?? null;

  const keep = (request: Omit<IconAnimateRequest, "id" | "result" | "at">): Response => {
    const kept: IconAnimateRequest = { id: `ia_${randomBytes(12).toString("hex")}`, ...request, result: null, at: now() };
    save([...list(), kept]);
    return json({ request: kept.id });
  };

  const ask = async (body: Record<string, unknown>): Promise<Response> => {
    const animate = body.animate as Record<string, unknown> | null;
    if (!animate || typeof animate !== "object") throw new InboxError("validation_error", "animate: { icon, agent } or { icon, project }.", { field: "animate" });
    if (!isAnimatable(animate.icon)) throw new InboxError("validation_error", "icon: a picture's id, a set icon or one of our faces.", { field: "icon" });
    const target = targetOf(animate);
    const kept = HASH.test(animate.icon)
      ? !!icons.read(animate.icon, true)
      : isInboxSetFace(animate.icon)
        ? await options.setIconKept(inboxSetFaceParts(animate.icon).set, inboxSetFaceParts(animate.icon).icon)
        : true;
    if (!kept) throw new InboxError("validation_error", "No such picture.", { field: "icon" });
    return "project" in target ? keep({ project: target.project, sessions: [], icon: animate.icon, shown: projectShown(target.project) }) : keep({ ...target, icon: animate.icon });
  };

  const askDraw = (body: Record<string, unknown>): Response => {
    const draw = body.draw as Record<string, unknown> | null;
    if (!draw || typeof draw !== "object") throw new InboxError("validation_error", "draw: { agent } or { project }.", { field: "draw" });
    const target = targetOf(draw);
    if ("project" in target) return keep({ kind: "draw", project: target.project, sessions: [], icon: null, shown: projectShown(target.project) });
    return keep({ kind: "draw", ...target, icon: null, shown: faces.wire().faces[target.agent]?.face ?? null });
  };

  const handBack = async (body: Record<string, unknown>): Promise<Response> => {
    const id = typeof body.request === "string" ? body.request.trim() : "";
    const index = list().findIndex((r) => r.id === id);
    const given = typeof body.picture === "string" ? body.picture : "";
    if (!REQUEST_ID.test(id) || index < 0) {
      // Kept on a linked machine, perhaps: asked there, unless that machine handed it here itself.
      const there = REQUEST_ID.test(id) && options.far && body.relayed !== true ? await options.far({ request: id, picture: given }) : null;
      return there ?? json({ error: ICON_ANIMATE_WORDS.unknown, code: "no_request" }, 404);
    }
    const request = list()[index]!;
    // The upload's own keeping: the same sniffing, cap and words.
    if (given.length > 800_000) throw new InboxError("validation_error", AGENT_ICON_TOO_BIG, { field: "picture" });
    const dataUrl = /^data:[a-z0-9.+/-]*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(given);
    const bytes = dataUrl ? new Uint8Array(Buffer.from(dataUrl[1]!, "base64")) : null;
    const saved = bytes ? icons.add(bytes) : ({ ok: false, reason: "not_image" } as const);
    if (!saved.ok) {
      if (saved.reason === "not_saved") throw new InboxError("config_not_saved", "The picture did not change.");
      throw new InboxError("validation_error", saved.reason === "too_big" ? AGENT_ICON_TOO_BIG : AGENT_ICON_NOT_IMAGE, { field: "picture" });
    }
    const result = saved.icon.id;
    const requests = list().slice();

    if (request.project !== undefined) {
      const projects = options.projects;
      const showing = projects?.uploadedAt(request.project) ?? null;
      const applied = !!projects && projects.has(request.project) && (showing === request.shown || (request.result_at !== undefined && showing === request.result_at));
      const set = applied ? projects.setUpload(request.project, bytes!) : null;
      if (set && !set.ok) throw new InboxError(set.reason === "not_saved" ? "config_not_saved" : "validation_error", set.reason === "not_saved" ? "The picture did not change." : set.reason === "too_big" ? AGENT_ICON_TOO_BIG : AGENT_ICON_NOT_IMAGE, { field: "picture" });
      requests[index] = { ...request, result, ...(set?.ok ? { result_at: set.at } : {}) };
      save(requests);
      // The picture joins "Your own…" either way.
      options.touch();
      if (set?.ok) projects!.changed();
      return json({ applied: !!set?.ok, icon: result, target: "project", ...(set?.ok ? {} : { note: ICON_ANIMATE_WORDS.notAppliedProject }) });
    }

    // Only the agent asked about, and only while it shows what it showed then (or this request's last result).
    const agent = request.agent!;
    const showing = faces.wire().faces[agent]?.face;
    const before = request.kind === "draw" ? (request.shown ?? null) : shownFace(request.icon!);
    const applied = (showing ?? null) === before || (request.result !== null && showing === `own:${request.result}`) || showing === `own:${result}`;
    requests[index] = { ...request, result };
    save(requests);
    if (applied && showing !== `own:${result}`) faces.change({ agent, sessions: request.sessions, face: `own:${result}` });
    else options.touch();
    return json({ applied, icon: result, target: "agent", ...(applied ? {} : { note: ICON_ANIMATE_WORDS.notApplied }) });
  };

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname !== INBOX_ICON_ANIMATE_PATH) return null;
    if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
    if (req.method === "GET") return json({ results: list().flatMap((r) => (r.result && r.icon !== null ? [{ icon: r.icon, result: r.result }] : [])) });
    if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (body.animate !== undefined) return await ask(body);
    if (body.draw !== undefined) return askDraw(body);
    return await handBack(body);
  };

  /** The pictures a request still points at: never the ones the cap removes (the original stays one click away). */
  const kept = (): Set<string> => new Set(list().flatMap((r) => [...(r.icon !== null && HASH.test(r.icon) ? [`own:${r.icon}`] : []), ...(r.result ? [`own:${r.result}`] : [])]));

  return { route, kept };
}
