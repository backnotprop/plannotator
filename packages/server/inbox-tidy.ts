/**
 * Tidy's routes (owner-approved design, 2026-10-28; packages/core/inbox-tidy.ts):
 *
 * - `GET /api/inbox/tidy?project=&surface=list|board`: who Tidy would ask in
 *   the list's (or the Board's) scope, and the last run's progress.
 * - `POST /api/inbox/tidy { sessions, idempotency_key, project?, surface? }`:
 *   asks the named sessions (each must still be in the plan), writing each
 *   one's Tidy notes. A replay of the key answers the run it wrote.
 *
 * Bun only, like the rest of the Inbox. The window's guards are the server's
 * own (a write from another site is refused before routing; the read is
 * refused here, as the other read routes do).
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { inboxId, isInboxId, type InboxTidyPlan, type InboxTidyReach, type InboxTidyRun } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxTidyBody, inboxTidyPlan, inboxTidyRun, inboxTidyWakeThread, type InboxTidySurface } from "@plannotator/shared/inbox/tidy";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { INBOX_WAKE_ONLY_LIVE_MS } from "./inbox-sessions";

export interface InboxTidyDeps {
  store: InboxStore;
  serverSession: string;
  /** A session whose connection (or Codex's queue) delivers to it now; null when none does. */
  deliveryConnectionOf: (session: string) => { busy: boolean | null } | null;
  /** Since when a live session is idle (epoch ms), or null while busy or when it does not say. */
  idleSince: (session: string) => number | null;
  /** The agents that read the Inbox over MCP only, and when they were last seen. */
  mcpAgents: () => { session: string; last_at: string }[];
  boardOn: () => boolean;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  now?: () => number;
}

export function createInboxTidy(deps: InboxTidyDeps) {
  const { store } = deps;
  const now = () => deps.now?.() ?? Date.now();

  /** How each session is reached now: woken by its connection, at its next Inbox call (MCP only, seen within the hour), or not (ended). */
  const reachFor = (): ((session: string) => InboxTidyReach | null) => {
    // Presence is the live sessions' clock (the wall clock), as for every other liveness check.
    const t = Date.now();
    const mcp = new Map(deps.mcpAgents().map((agent) => [agent.session, Date.parse(agent.last_at)]));
    return (session) => {
      if (deps.deliveryConnectionOf(session)) return "wakes";
      const seen = mcp.get(session);
      return seen !== undefined && t - seen <= INBOX_WAKE_ONLY_LIVE_MS ? "next_call" : null;
    };
  };

  const scopeOf = (value: unknown): string | null => {
    if (value === null || value === undefined || value === "") return null;
    if (!isInboxId("prj", value)) throw new InboxError("validation_error", "project: a prj_ id.", { field: "project" });
    if (!store.project(value)) throw new InboxError("project_not_found", `No project ${value}.`);
    return value;
  };
  const surfaceOf = (value: unknown): InboxTidySurface => (value === "board" ? "board" : "list");

  const runNow = (reachOf: (session: string) => InboxTidyReach | null): InboxTidyRun | null =>
    inboxTidyRun(store, { now: now(), idleSince: deps.idleSince, reachOf });

  const planFor = (projectId: string | null, surface: InboxTidySurface, reachOf: (session: string) => InboxTidyReach | null) =>
    inboxTidyPlan(store, { projectId, surface, now: now(), reachOf, boardOn: deps.boardOn() });

  const plan = (projectId: string | null, surface: InboxTidySurface): InboxTidyPlan => {
    const reachOf = reachFor();
    const found = planFor(projectId, surface, reachOf);
    // A session that never wrote anywhere has no thread to carry its wake: not offered.
    const agents = found.agents.filter((agent) => inboxTidyWakeThread(store, agent) !== null);
    return {
      serverSession: deps.serverSession,
      count: agents.reduce((n, a) => n + a.items.length, 0),
      agents: agents.map((agent) => ({
        session: agent.session,
        host: agent.host,
        name: agent.name,
        reach: agent.reach,
        items: agent.items.map((item) => ({ thread_id: item.thread_id, subject: item.subject, project: item.project, reasons: item.reasons })),
      })),
      run: runNow(reachOf),
    };
  };

  /** Asks the named sessions; each still in the plan gets its notes. */
  const start = (body: Record<string, unknown>): { run: InboxTidyRun | null; asked: string[] } => {
    const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
    if (!key || key.length > 128) throw new InboxError("validation_error", "idempotency_key: required, at most 128 characters.", { field: "idempotency_key" });
    if (!Array.isArray(body.sessions) || body.sessions.length === 0 || body.sessions.some((s) => typeof s !== "string" || !s)) {
      throw new InboxError("validation_error", "sessions: the sessions to ask, by id.", { field: "sessions" });
    }
    const reachOf = reachFor();
    // A replay: the run this key wrote.
    const replayed = store.tidyNotes().filter((m) => m.idempotency_key === key);
    if (replayed.length > 0) {
      return { run: runNow(reachOf), asked: [...new Set(replayed.map((m) => m.to!.session))] };
    }
    const wanted = new Set(body.sessions as string[]);
    const found = planFor(scopeOf(body.project), surfaceOf(body.surface), reachOf);
    const run = inboxId("tdy");
    const asked: string[] = [];
    for (const agent of found.agents) {
      if (!wanted.has(agent.session)) continue;
      const wake = inboxTidyWakeThread(store, agent);
      if (!wake) continue;
      const threads = [wake, ...agent.items.flatMap((item) => (item.thread_id ? [item.thread_id] : []))];
      store.sendTidy({ run, to: { host: agent.host ?? "agent", session: agent.session }, threadIds: threads, body: inboxTidyBody(agent), idempotency_key: key });
      asked.push(agent.session);
    }
    if (asked.length === 0) throw new InboxError("nothing_to_tidy", "None of those sessions has anything to tidy now.");
    return { run: runNow(reachOf), asked };
  };

  /** The routes; null when the path is not one of them. */
  const route = async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname !== "/api/inbox/tidy") return null;
    if (req.method === "GET") {
      // Another site's page must not read who owes the person what.
      if (!isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
        return deps.json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
      }
      return deps.json(plan(scopeOf(url.searchParams.get("project")), surfaceOf(url.searchParams.get("surface"))));
    }
    if (req.method !== "POST") return deps.json({ error: "Use GET or POST." }, 405);
    const body = await deps.readBody(req);
    if (checkServerSession(body, deps.serverSession) === "mismatch") return deps.json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    return deps.json({ serverSession: deps.serverSession, ...start(body) });
  };

  return { route, plan, reachFor };
}
