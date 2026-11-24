/**
 * The window's swarm route (inbox-swarm-route.ts), in process, no Inbox started. What can regress: a message id that
 * does not reach its thread's swarm, an `on` that is not a boolean taken as one, a stale page's write applied, and
 * the switch not kept.
 */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { InboxSwarms } from "@plannotator/shared/inbox/swarms";
import { createInboxSwarmRoute } from "./inbox-swarm-route";

const T = "msg_01M4H6G73M9H3Z32T859E72DPY";
const REPLY = "msg_01M4H7AAAAAAAAAAAAAAAAAAA1";

function setup() {
  const swarms = new InboxSwarms(mkdtempSync(join(tmpdir(), "plannotator-swarm-route-")));
  const messages: Record<string, { thread_id: string }> = { [T]: { thread_id: T }, [REPLY]: { thread_id: T } };
  const route = createInboxSwarmRoute({
    store: { message: (id: string) => (messages[id] ?? null) as never },
    swarms,
    serverSession: "page-1",
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
  });
  const call = (method: "GET" | "POST", id: string, body?: Record<string, unknown>) =>
    route.route(new Request(`http://127.0.0.1/api/inbox/threads/${id}/swarm`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), new URL(`http://127.0.0.1/api/inbox/threads/${id}/swarm`));
  return { swarms, call };
}

test("a message id reaches its thread; on and off are kept; GET reads them", async () => {
  const { swarms, call } = setup();
  expect(await (await call("GET", T))!.json()).toEqual({ thread_id: T, swarm: null });
  const on = (await (await call("POST", REPLY, { on: true, serverSession: "page-1" }))!.json()) as { thread_id: string; swarm: { on: boolean } };
  expect(on.thread_id).toBe(T);
  expect(on.swarm.on).toBe(true);
  await call("POST", T, { on: false, serverSession: "page-1" });
  expect(swarms.get(T)?.on).toBe(false);
});

test("refused: an unknown thread, an `on` that is not a boolean, a page from before a restart", async () => {
  const { swarms, call } = setup();
  await expect(call("GET", "msg_01M4H7BBBBBBBBBBBBBBBBBBB2")).rejects.toThrow(InboxError);
  await expect(call("POST", T, { on: "yes", serverSession: "page-1" })).rejects.toThrow(InboxError);
  expect((await call("POST", T, { on: true, serverSession: "page-0" }))!.status).toBe(409);
  expect(swarms.get(T)).toBeNull();
});
