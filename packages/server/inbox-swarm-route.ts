/**
 * Plannotator Inbox: a thread's swarm switch (docs/agent-guides/inbox-compose.md, "Swarm"). The window's routes:
 *
 *   GET  /api/inbox/threads/:id/swarm   `{ swarm }`: the thread's swarm record (`InboxSwarm`), null for none
 *   POST /api/inbox/threads/:id/swarm   `{ on: boolean }`: the status view's Turn off, the quiet badge's turn on; `{ swarm }`
 *
 * The record lives on the computer that holds the thread (inbox/swarms.json): a linked computer's window and a phone
 * reach it through the door (inbox-devices.ts), and a held write waits in the outbox (`set`, inbox-outbox.ts). No
 * gate: any thread can be turned on, whoever's agents are in it.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxSwarms } from "@plannotator/shared/inbox/swarms";

export const INBOX_SWARM_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/swarm$/;

export function createInboxSwarmRoute(options: {
  store: Pick<InboxStore, "message">;
  swarms: InboxSwarms;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
}) {
  const { store, swarms, serverSession, json } = options;
  const route = async (req: Request, url: URL): Promise<Response | null> => {
    const match = INBOX_SWARM_PATH.exec(url.pathname);
    if (!match) return null;
    // A message id names its thread, as the window's other thread routes take either.
    const threadId = store.message(match[1]!)?.thread_id ?? null;
    if (!threadId) throw new InboxError("thread_not_found", `No thread ${match[1]}.`);
    if (req.method === "GET") return json({ thread_id: threadId, swarm: swarms.get(threadId) });
    if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (typeof body.on !== "boolean") throw new InboxError("validation_error", "on: a boolean.", { field: "on" });
    return json({ thread_id: threadId, swarm: swarms.setOn(threadId, body.on) });
  };
  return { route };
}
