/**
 * Ship's routes (approval "inbox-ship-mode"), Bun only (the Inbox), behind Code review like every pull route:
 *
 * - `GET /api/inbox/ships`: this Inbox's ships, without their logs (`InboxShipView[]`), and `projects` (`host/repo` →
 *   this Inbox's projects on it), so a window on a linked machine lists this computer's agents for a PR's repository.
 * - `GET /api/inbox/ships/log?id=`: one ship and its log, newest first.
 * - `POST /api/inbox/ships` `{ key, thread_id, to?, started?, idempotency_key }`: ship a pull request. With `to` (a
 *   live session `{ host, session }`, or a new one `{ launch: { agent, project_id, model?, effort? } }`), the
 *   instruction (core `shipMessage`) goes into the thread as the person's reply to that agent, then the record is made.
 *   With `started: true` the window already started a new thread with the instruction (a pull request with no thread,
 *   or an agent on another computer than the review's thread): only the record; its `to`, when a live session, is
 *   who ships it until the thread says otherwise.
 * - `POST /api/inbox/ships/stop` `{ id }`: stop.
 * - `POST /api/inbox/ships/newer` `{ key, id, started_at, generation }`: a linked computer's Inbox (never a window) says
 *   it started shipping this pull request; a ship of it here that loses (`generation`, never the clocks) stops, one that
 *   wins answers with its own word (`watch.newer`). Sent through the outbox to every linked computer at each Ship, so
 *   an offline one hears it when it is back.
 *
 * A linked machine reaches them through the door (`machineOnly` rows in inbox-devices.ts), so a window on either
 * computer ships the other's; a phone token gets the door's 404 (the native app has no pull routes).
 */
import { shipForge, shipMessage, shipView, type InboxShip, type InboxShipAgent } from "@plannotator/core/inbox-pull-handoff";
import type { InboxPull } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxShipStore } from "./inbox-ship-store";
import type { InboxShipWatch } from "./inbox-ship-watch";

export const INBOX_SHIP_ROUTES = ["/api/inbox/ships", "/api/inbox/ships/log", "/api/inbox/ships/stop", "/api/inbox/ships/newer"] as const;

export type InboxShipTo = { host: string; session: string } | { launch: { agent: string; project_id: string; model?: string; effort?: string } };

export interface InboxShipRoutesOptions {
  ships: InboxShipStore;
  watch: InboxShipWatch;
  /** The pull request as the last list read it, else one read of it (a linked machine's window names one it listed). */
  findPull: (key: string) => Promise<InboxPull | null>;
  /** The thread's project, when it is a thread of this Inbox. */
  threadProject: (threadId: string) => string | null;
  /** Who works in the thread now (the window's `started` path): its last agent. */
  threadAgent: (threadId: string) => InboxShipAgent | null;
  /** `host/repo` (lowercased) → this Inbox's projects on it. */
  repoProjects: () => Promise<Record<string, string[]>>;
  /**
   * Send the instruction into the thread as the person's reply to `to`: the agent it went to (a new session's
   * placeholder until it starts) and the message that carried it.
   */
  sendInstruction: (input: { threadId: string; to: InboxShipTo; words: string; idempotencyKey: string; req: Request }) => Promise<{ agent: InboxShipAgent; message_id: string }>;
  /** The linked computer a request came from through its door (`ships/newer`); null for any other request. */
  fromMachine: (req: Request) => { id: string; name: string | null } | null;
  json: (body: unknown, status?: number) => Response;
  /** The pull routes' own guards (same origin, Code review, a window's press, the server session); a refusal, or null. */
  guard: (req: Request, write: boolean, body: Record<string, unknown> | null) => Response | null;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  serverSession: string;
}

const text = (value: unknown, max = 600) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);

function toOf(value: unknown): InboxShipTo | null {
  const to = value as Record<string, unknown> | null;
  if (!to || typeof to !== "object") return null;
  if (to.launch && typeof to.launch === "object") {
    const launch = to.launch as Record<string, unknown>;
    const agent = text(launch.agent, 64);
    const project = text(launch.project_id, 200);
    if (!agent || !project) return null;
    return { launch: { agent, project_id: project, ...(text(launch.model, 200) ? { model: launch.model as string } : {}), ...(text(launch.effort, 64) ? { effort: launch.effort as string } : {}) } };
  }
  const host = text(to.host, 64);
  const session = text(to.session, 300);
  return host && session ? { host, session } : null;
}

export function createInboxShipRoutes(options: InboxShipRoutesOptions) {
  const { json } = options;
  return async (req: Request, path: string, url: URL): Promise<Response | null> => {
    if (!(INBOX_SHIP_ROUTES as readonly string[]).includes(path)) return null;
    if (path === "/api/inbox/ships") {
      if (req.method === "GET") {
        const refused = options.guard(req, false, null);
        if (refused) return refused;
        return json({ serverSession: options.serverSession, ships: options.ships.all().map(shipView), projects: await options.repoProjects() });
      }
      if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const body = await options.readBody(req);
      const refused = options.guard(req, true, body);
      if (refused) return refused;
      const key = text(body.key);
      const threadId = text(body.thread_id, 200);
      if (!key) throw new InboxError("validation_error", "key: a pull request from the list.", { field: "key" });
      if (!threadId) throw new InboxError("validation_error", "thread_id: a thread in the Inbox.", { field: "thread_id" });
      const project = options.threadProject(threadId);
      if (!project) throw new InboxError("thread_not_found", "That thread isn't in this Inbox.", { field: "thread_id" });
      const pull = await options.findPull(key);
      if (!pull) throw new InboxError("pull_not_found", "That pull request isn't in the list any more.", { field: "key" });
      if (pull.state !== "open" && pull.state !== "draft") throw new InboxError("pull_not_open", `It is ${pull.state} already.`);
      // Only a forge whose pull request state the Inbox reads can ship (its watch would read nothing, for ever).
      if (!shipForge(pull.platform)) throw new InboxError("pull_not_shippable", "Ship reads GitHub and GitLab pull requests only.", { field: "key" });
      let agent: InboxShipAgent | null;
      let instruction: string | null;
      // A live session the person chose is settled; a new session (or none named) is bound by its first `ship` call.
      let bound = false;
      if (body.started === true) {
        // The window's new thread carried the instruction: its first message. The session the window started it with
        // ships it (a new session: the one its launch starts, read from that message), never whoever wrote last.
        const to = toOf(body.to);
        const now = options.threadAgent(threadId);
        bound = !!to && "session" in to;
        agent = to && "session" in to ? { host: to.host, session: to.session, name: now?.session === to.session ? now.name : null } : now;
        instruction = threadId;
      } else {
        const to = toOf(body.to);
        if (!to) throw new InboxError("validation_error", "to: a session, or a new session to start.", { field: "to" });
        const idempotencyKey = text(body.idempotency_key, 200);
        if (!idempotencyKey) throw new InboxError("validation_error", "idempotency_key: required.", { field: "idempotency_key" });
        const sent = await options.sendInstruction({ threadId, to, words: shipMessage(pull), idempotencyKey, req });
        bound = "session" in to;
        agent = sent.agent;
        instruction = sent.message_id;
      }
      const ship = options.watch.start({
        key: pull.key,
        platform: pull.platform,
        instruction_id: instruction,
        url: pull.url,
        title: pull.title,
        number: pull.number,
        repo: pull.repo,
        host: pull.host,
        thread_id: threadId,
        project_id: project,
        agent: agent ?? { host: null, session: null, name: null },
        ...(bound && agent?.session ? { bound: true } : {}),
      });
      return json({ serverSession: options.serverSession, ok: true, ship: shipView(ship) });
    }
    if (path === "/api/inbox/ships/log") {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      const refused = options.guard(req, false, null);
      if (refused) return refused;
      const ship: InboxShip | null = options.ships.byId(url.searchParams.get("id") ?? "");
      if (!ship) return json({ error: "No such ship.", code: "ship_not_found" }, 404);
      return json({ serverSession: options.serverSession, ship: shipView(ship), log: [...ship.log].reverse() });
    }
    if (path === "/api/inbox/ships/newer") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      // A linked computer's Inbox only; whatever this one's Code review setting, a stop is never refused (the outbox
      // would drop it, and two agents would ship one pull request).
      const machine = options.fromMachine(req);
      if (!machine) return json({ error: "Only a linked computer's Inbox sends this.", code: "machine_only" }, 403);
      const body = await options.readBody(req);
      const key = text(body.key);
      const id = text(body.id, 200);
      const startedAt = text(body.started_at, 64);
      const generation = body.generation;
      if (!key || !id) throw new InboxError("validation_error", "key and id: the ship started there.", { field: !key ? "key" : "id" });
      if (!startedAt || !Number.isFinite(Date.parse(startedAt))) throw new InboxError("validation_error", "started_at: when the ship started there, a date.", { field: "started_at" });
      if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) throw new InboxError("validation_error", "generation: the ship's place among this pull request's Ships, a whole number from 1.", { field: "generation" });
      const stopped = options.watch.newer({ key, id, started_at: startedAt, generation }, { id: machine.id, name: machine.name });
      return json({ serverSession: options.serverSession, ok: true, stopped: stopped ? stopped.id : null });
    }
    // /api/inbox/ships/stop
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await options.readBody(req);
    const refused = options.guard(req, true, body);
    if (refused) return refused;
    const ship = options.watch.stop(text(body.id, 200) ?? "");
    if (!ship) return json({ error: "No such ship.", code: "ship_not_found" }, 404);
    return json({ serverSession: options.serverSession, ok: true, ship: shipView(ship) });
  };
}
