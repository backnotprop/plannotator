/**
 * "Ask an agent on <machine> to update it" (the owner's call, 2026-11-08): an older machine's door takes no `update`,
 * so the window sends an agent there a New message through the forward, then tells this Inbox with
 * `POST /api/inbox/machines/:id/update/asked`. Guarded here: who may say it, what of it is kept, and that the row says
 * it. A loopback door stands in for the older machine (PLANNOTATOR_TEST_SANDBOX lets the transport take it); nothing
 * else runs.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxMachines } from "./inbox-machines";
import { InboxLinks } from "./inbox-links";

const OLD = "ibx_01K00000000000000000000000";
const UNLINKED = "ibx_01K00000000000000000000001";
const TOKEN = "tok_test";
const SESSION = "srv_session";

let root: string;
let savedSandbox: string | undefined;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-machine-asked-"));
  savedSandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (savedSandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
  else process.env.PLANNOTATOR_TEST_SANDBOX = savedSandbox;
  rmSync(root, { recursive: true, force: true });
});

/** An Inbox from before machines could update each other: its health names no `machine_update`. */
function olderDoor() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const route = new URL(req.url).pathname.replace("/api/inbox/device/", "");
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ code: "device_token_invalid" }, { status: 401 });
      if (route === "health") return Response.json({ ok: true, inbox_id: OLD, machine_links: 1, version: "0.28.50" });
      if (route === "threads") return Response.json({ cursor: 0, sections: [], projects: [] });
      if (route === "events") {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":0}\n\n`));
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

async function inboxLinkedToOlder() {
  const dataDir = join(root, "data");
  InboxLinks.open(dataDir).put({ id: OLD, name: "Mini", token: TOKEN, transport: { kind: "tailnet", url: olderDoor() }, device_id: null, linked_at: "2026-11-01T00:00:00Z" });
  const noop = () => {};
  const machines = createInboxMachines({
    dataDir,
    serverSession: SESSION,
    computerName: () => "Studio",
    door: {
      openMachineOffer: () => ({ secret: "s", code: "000000", expires_at: "" }),
      offerDevice: () => null,
      closeMachineOffer: () => null,
      revokeDevice: noop,
      tailnetAddress: () => null,
      tailnetError: () => null,
      publishTailnet: () => ({ ok: false, message: "no" }),
      closeTailnetIfUnused: noop,
    },
    readBody: async (req) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    holds: () => false,
    isGuest: (req) => req.headers.get("x-test-guest") === "1",
    ownVersions: () => ({ current: "0.28.55", latest: null }),
    timings: { silenceMs: 60_000, backoffMinMs: 50, backoffMaxMs: 200, requestMs: 2000, sendMs: 2000 },
  });
  cleanups.push(() => machines.stop());
  machines.start();
  const mini = () => machines.machinesView().find((m) => m.id === OLD)!;
  for (let i = 0; i < 100 && mini().state !== "online"; i++) await Bun.sleep(20);
  expect(mini().state).toBe("online");
  const ask = (id: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const url = new URL(`http://localhost/api/inbox/machines/${id}/update/asked`);
    return machines.route(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), url, "local");
  };
  return { machines, mini, ask };
}

test("an older machine's row says an agent there was asked, with the thread it went to", async () => {
  const { mini, ask } = await inboxLinkedToOlder();
  expect(mini().update).toMatchObject({ phase: "behind", can_update: false, from: "0.28.50" });
  expect(mini().update?.asked).toBeUndefined();
  const answer = (await ask(OLD, { serverSession: SESSION, thread_id: "thr_01Kabc", agent: "Claude Code" }))!;
  expect(answer.status).toBe(200);
  expect(mini().update?.asked).toMatchObject({ thread: "thr_01Kabc", agent: "Claude Code" });
});

test("a held ask names no thread, and only an id that reads as one and a short plain name are kept", async () => {
  const { mini, ask } = await inboxLinkedToOlder();
  await ask(OLD, { serverSession: SESSION, thread_id: "../../etc", agent: `  Claude\nCode ${"x".repeat(200)}` });
  const asked = mini().update?.asked;
  expect(asked?.thread).toBeNull();
  expect(asked?.agent.startsWith("Claude Code x")).toBe(true);
  expect(asked!.agent.length).toBeLessThanOrEqual(60);
  await ask(OLD, { serverSession: SESSION, thread_id: null, agent: "" });
  expect(mini().update?.asked).toMatchObject({ thread: null, agent: "An agent" });
});

test("a tailnet guest, a stale tab and a machine that is not linked change nothing", async () => {
  const { mini, ask } = await inboxLinkedToOlder();
  expect((await ask(OLD, { serverSession: SESSION, agent: "Claude Code" }, { "x-test-guest": "1" }))!.status).toBe(403);
  expect((await ask(OLD, { serverSession: "an_older_tab", agent: "Claude Code" }))!.status).toBe(409);
  expect((await ask(UNLINKED, { serverSession: SESSION, agent: "Claude Code" }))!.status).toBe(404);
  expect(mini().update?.asked).toBeUndefined();
});
