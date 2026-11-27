/**
 * An agent's answer held for a thread on another computer (`notify`, inbox-mcp-far-reply.ts) in this Inbox's outbox
 * frames (inbox-machines.ts). What regresses: the window drawing this Inbox's own write while it is only on its way;
 * its notice coming without the thread it was for; something of it other than the write itself reaching the linked
 * computer; and a drop by Unlink whose words Settings → Machines cannot show (the toast says it keeps them). A loopback
 * door stands in for the other computer (PLANNOTATOR_TEST_SANDBOX lets the transport take it); nothing else runs.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxMachines, type MachineFrame } from "./inbox-machines";
import { InboxLinks } from "./inbox-links";
import { FAR_AGENT_REPLY_ROUTE } from "./inbox-far-tags";

const LAPTOP = "ibx_01K00000000000000000000002";
const TOKEN = "tok_test";
const SESSION = "srv_session";
const THREAD = "msg_01K0000000000000000000000T";

let root: string;
let savedSandbox: string | undefined;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-machine-far-notice-"));
  savedSandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (savedSandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
  else process.env.PLANNOTATOR_TEST_SANDBOX = savedSandbox;
});

/** The other computer's door: every request it is sent is kept; `agent-reply` waits for `answer`. */
function laptopDoor(opts: { away?: boolean } = {}) {
  const seen: { method: string; route: string; body: string }[] = [];
  let release: (response: Response) => void = () => {};
  const answer = new Promise<Response>((resolve) => (release = resolve));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const route = new URL(req.url).pathname.replace("/api/inbox/device/", "");
      seen.push({ method: req.method, route, body: req.method === "POST" ? await req.text() : "" });
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ code: "device_token_invalid" }, { status: 401 });
      if (route === "unlink") return Response.json({ ok: true });
      if (opts.away) return Response.json({ code: "unavailable" }, { status: 503 });
      if (route === "health") return Response.json({ ok: true, inbox_id: LAPTOP, machine_links: 1, version: "0.28.55" });
      if (route === "threads") return Response.json({ cursor: 0, sections: [], projects: [] });
      if (route === "events") {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":0}\n\n`));
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (route === FAR_AGENT_REPLY_ROUTE) return answer;
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen, release };
}

function inboxLinkedTo(url: string) {
  const dataDir = join(root, "data");
  InboxLinks.open(dataDir).put({ id: LAPTOP, name: "Laptop", token: TOKEN, transport: { kind: "tailnet", url }, device_id: null, linked_at: "2026-11-01T00:00:00Z" });
  const noop = () => {};
  const machines = createInboxMachines({
    dataDir,
    serverSession: SESSION,
    computerName: () => "Studio",
    door: {
      openMachineOffer: () => ({ secret: "s", code: "000000", expires_at: "" }),
      offerDevice: () => null,
      closeMachineOffer: () => null,
      openIntroductionOffer: () => ({ secret: "s", expires_at: "" }),
      introduction: () => null,
      settleIntroduction: noop,
      dropIntroductions: noop,
      revokeDevice: noop,
      tailnetAddress: () => null,
      tailnetError: () => null,
      publishTailnet: () => ({ ok: false, message: "no" }),
      closeTailnetIfUnused: noop,
    },
    readBody: async (req) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    holds: () => false,
    ownVersions: () => ({ current: "0.28.55", latest: null }),
    timings: { silenceMs: 60_000, backoffMinMs: 50, backoffMaxMs: 200, requestMs: 2000, sendMs: 2000 },
  });
  cleanups.push(() => machines.stop());
  const frames: MachineFrame[] = [];
  cleanups.push(machines.subscribe((frame) => frames.push(frame)));
  machines.start();
  const outboxFrames = () => frames.flatMap((frame) => (frame.event === "outbox" ? [frame.data] : []));
  return { machines, outboxFrames };
}

/** An agent's answer as inbox-mcp-far-reply.ts holds it. */
const farAnswer = (key: string) => ({ idempotency_key: key, session: "ses_one", args: { body: "The order holds.", reply_to: THREAD, idempotency_key: "far:k" } });

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 150 && !ok(); i++) await Bun.sleep(20);
  expect(ok()).toBe(true);
};

test("a held far answer reaches the window only once it has a notice, with its thread, and nothing of it but the write reaches the linked computer", async () => {
  const door = laptopDoor();
  const { machines, outboxFrames } = inboxLinkedTo(door.url);
  await until(() => machines.machinesView().find((m) => m.id === LAPTOP)?.state === "online");
  const held = machines.holdWrite(LAPTOP, FAR_AGENT_REPLY_ROUTE, farAnswer("far-reply:one"), THREAD, 0, { notify: true });
  expect(held).not.toBeNull();
  // On its way (sent, no answer yet): this Inbox's own, never drawn.
  await until(() => door.seen.some((r) => r.route === FAR_AGENT_REPLY_ROUTE));
  await Bun.sleep(50);
  expect(outboxFrames()).toEqual([]);
  door.release(Response.json({ code: "message_not_found", error: "No message." }, { status: 404 }));
  await until(() => outboxFrames().length > 0);
  expect(outboxFrames()).toEqual([expect.objectContaining({ key: "far-reply:one", state: "refused", thread: THREAD, words: "The order holds.", notice: expect.objectContaining({ kind: "refused" }) })]);
  // The linked computer was sent the write, once, and nothing else of it (no notice, no frame).
  const posts = door.seen.filter((r) => r.method === "POST");
  expect(posts.map((r) => r.route)).toEqual([FAR_AGENT_REPLY_ROUTE]);
  expect(JSON.parse(posts[0]!.body)).toEqual(farAnswer("far-reply:one"));
});

test("a far answer dropped by Unlink: its words are what Settings → Machines keeps", async () => {
  const door = laptopDoor({ away: true });
  const { machines, outboxFrames } = inboxLinkedTo(door.url);
  expect(machines.holdWrite(LAPTOP, FAR_AGENT_REPLY_ROUTE, farAnswer("far-reply:two"), THREAD, 0, { notify: true })).not.toBeNull();
  // Waiting for the computer: not drawn.
  expect(outboxFrames()).toEqual([]);
  const url = new URL(`http://localhost/api/inbox/machines/${LAPTOP}/unlink`);
  const unlinked = await machines.route(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: SESSION }) }), url, "local");
  expect(unlinked!.status).toBe(200);
  expect(outboxFrames()).toEqual([expect.objectContaining({ key: "far-reply:two", state: "dropped", machine_name: "Laptop", thread: THREAD, words: "The order holds." })]);
  const listUrl = new URL("http://localhost/api/inbox/outbox");
  const listed = (await (await machines.route(new Request(listUrl), listUrl, "local"))!.json()) as { notices: { key: string; words: string | null }[] };
  expect(listed.notices).toEqual([expect.objectContaining({ key: "far-reply:two", words: "The order holds." })]);
  expect(door.seen.filter((r) => r.method === "POST").map((r) => r.route)).toEqual(["unlink"]);
});
