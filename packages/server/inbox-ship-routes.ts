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
 *
 * A linked machine reaches them through the door (`machineOnly` rows in inbox-devices.ts), so a window on either
 * computer ships the other's; a phone token gets the door's 404 (the native app has no pull routes).
 */
import { shipMessage, shipView, type InboxShip, type InboxShipAgent } from "@plannotator/core/inbox-ship";
import type { InboxPull } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxShipStore } from "./inbox-ship-store";
import type { InboxShipWatch } from "./inbox-ship-watch";

export const INBOX_SHIP_ROUTES = ["/api/inbox/ships", "/api/inbox/ships/log", "/api/inbox/ships/stop"] as const;

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
  /** Send the instruction into the thread as the person's reply to `to`; the agent it went to. */
  sendInstruction: (input: { threadId: string; to: InboxShipTo; words: string; idempotencyKey: string; req: Request }) => Promise<InboxShipAgent>;
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
      let agent: InboxShipAgent | null;
      if (body.started === true) {
        // The thread's agent once it answered; before that, the live session the window started it with.
        const to = toOf(body.to);
        agent = options.threadAgent(threadId) ?? (to && "session" in to ? { host: to.host, session: to.session, name: null } : null);
      } else {
        const to = toOf(body.to);
        if (!to) throw new InboxError("validation_error", "to: a session, or a new session to start.", { field: "to" });
        const idempotencyKey = text(body.idempotency_key, 200);
        if (!idempotencyKey) throw new InboxError("validation_error", "idempotency_key: required.", { field: "idempotency_key" });
        agent = await options.sendInstruction({ threadId, to, words: shipMessage(pull), idempotencyKey, req });
      }
      const ship = options.watch.start({
        key: pull.key,
        url: pull.url,
        title: pull.title,
        number: pull.number,
        repo: pull.repo,
        host: pull.host,
        thread_id: threadId,
        project_id: project,
        agent: agent ?? { host: null, session: null, name: null },
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
