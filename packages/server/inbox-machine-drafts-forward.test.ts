/**
 * A linked machine's reply draft through this Inbox's real forward (inbox-machines.ts, `/api/inbox/m/<machine>/…`) and
 * its real link to a stand-in far door on loopback (PLANNOTATOR_TEST_SANDBOX lets the transport take it). No Inbox runs.
 * What regresses:
 *  - a page an earlier run of this same Inbox served (a restart, an update) keeps saving the far draft, as it keeps
 *    saving this Inbox's own (inbox-reply-drafts.ts `follows`); a page of another Inbox, or its Discard, is refused;
 *  - Unlink with a draft held for that machine: the machine says it is held (so Unlink says it would be lost), and
 *    its words join the "Not sent" list, never gone silently.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { createInboxMachines } from "./inbox-machines";
import { InboxLinks } from "./inbox-links";
import { INBOX_MACHINE_DRAFTS_DIR } from "./inbox-machine-drafts-held";

const FAR = "ibx_01K00000000000000000000000";
const TOKEN = "tok_test";
const THREAD = "msg_01K00000000000000000000001";
const SESSION = "srv";
const EARLIER = "srv-earlier-run";

let root: string;
let savedSandbox: string | undefined;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-machine-drafts-forward-")));
  savedSandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (savedSandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
  else process.env.PLANNOTATOR_TEST_SANDBOX = savedSandbox;
  rmSync(root, { recursive: true, force: true });
});

/** The far machine's door: health, its list (taking `reply-drafts`), its stream, and the draft's save there. */
function farDoor() {
  const seen = { saves: [] as Record<string, unknown>[], deletes: 0, busy: false };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const route = new URL(req.url).pathname.replace("/api/inbox/device/", "");
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ code: "device_token_invalid" }, { status: 401 });
      if (route === "health") return Response.json({ ok: true, inbox_id: FAR, machine_links: 1, version: "0.28.70" });
      if (route === "threads") return Response.json({ cursor: 1, sections: [], projects: [], marks: ["reply-drafts"] });
      if (route === "events") {
        const body = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":1}\n\n`)) });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (route === `threads/${THREAD}/draft` && req.method === "POST") {
        // Busy: it cannot take a save now, so this Inbox holds it.
        if (seen.busy) return Response.json({ error: "Busy." }, { status: 503 });
        const body = (await req.json()) as Record<string, unknown>;
        seen.saves.push(body);
        return Response.json({ draft: { v: 1, thread_id: THREAD, body: body.body, created_at: "2026-11-25T00:00:00.000Z", updated_at: "2026-11-25T00:00:00.000Z" } });
      }
      if (route === `threads/${THREAD}/draft/delete`) {
        seen.deletes++;
        return Response.json({ ok: true, deleted: true });
      }
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

async function linkedInbox() {
  const dataDir = join(root, "data");
  const door = farDoor();
  InboxLinks.open(dataDir).put({ id: FAR, name: "Mini", token: TOKEN, transport: { kind: "tailnet", url: door.url }, device_id: null, linked_at: "2026-11-01T00:00:00Z" });
  const noop = () => {};
  const machines = createInboxMachines({
    dataDir,
    serverSession: SESSION,
    follows: [EARLIER],
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
    ownVersions: () => ({ current: "0.28.70", latest: null }),
    timings: { silenceMs: 60_000, backoffMinMs: 50, backoffMaxMs: 200, requestMs: 2000, sendMs: 2000 },
  });
  cleanups.push(() => machines.stop());
  machines.start();
  const mini = () => machines.machinesView().find((m) => m.id === FAR);
  for (let i = 0; i < 100 && !(mini()?.state === "online" && mini()?.list_cursor === 1); i++) await Bun.sleep(20);
  expect(mini()).toMatchObject({ state: "online", list_cursor: 1 });
  /** The window's request: its own origin, the thread it is about. */
  const call = async (path: string, body?: Record<string, unknown>) => {
    const url = new URL(`http://127.0.0.1:4100${path}`);
    const req = new Request(url, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Origin: url.origin, Host: url.host, "Sec-Fetch-Site": "same-origin", "X-Plannotator-Thread": THREAD },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const answer = (await machines.route(req, url, "local"))!;
    return { status: answer.status, body: (await answer.json()) as Record<string, any> };
  };
  const save = (serverSession: string, words: string) => call(`/api/inbox/m/${FAR}/threads/${THREAD}/draft`, { serverSession, body: words, base: null, files_add: [], files_remove: [], files_place: [], idempotency_key: crypto.randomUUID() });
  return { dataDir, door, machines, mini, call, save };
}

test("a far draft save from a page an earlier run of this Inbox served is taken; another Inbox's page, or its Discard, is refused", async () => {
  const { door, call, save } = await linkedInbox();
  const taken = await save(EARLIER, "Typed before the restart");
  expect(taken.status).toBe(200);
  expect(door.seen.saves.map((s) => s.body)).toEqual(["Typed before the restart"]);
  // The session never goes on to that machine.
  expect(door.seen.saves[0]!.serverSession).toBeUndefined();
  expect((await save("srv-another-inbox", "Typed in another Inbox's page")).status).toBe(409);
  expect((await call(`/api/inbox/m/${FAR}/threads/${THREAD}/draft/delete`, { serverSession: EARLIER, idempotency_key: crypto.randomUUID() })).status).toBe(409);
  expect(door.seen.saves).toHaveLength(1);
  expect(door.seen.deletes).toBe(0);
});

test("Unlink with a draft held for that machine: it is counted for Unlink, and its words join the Not sent list", async () => {
  const { dataDir, door, mini, call, save } = await linkedInbox();
  door.seen.busy = true;
  const held = await save(SESSION, "Typed for the Mini while it was busy");
  expect(held.status).toBe(200);
  expect(held.body.draft).toMatchObject({ body: "Typed for the Mini while it was busy" });
  expect(mini()).toMatchObject({ waiting: 0, drafts_held: 1 });
  const heldDir = join(inboxDir(dataDir), INBOX_MACHINE_DRAFTS_DIR, FAR);
  expect(readdirSync(heldDir)).toEqual([`${THREAD}.json`]);
  expect((await call("/api/inbox/outbox")).body.notices).toEqual([]);
  const unlinked = await call(`/api/inbox/machines/${FAR}/unlink`, { serverSession: SESSION });
  expect(unlinked.status).toBe(200);
  const notices = (await call("/api/inbox/outbox")).body.notices as Record<string, unknown>[];
  expect(notices).toEqual([expect.objectContaining({ machine: FAR, machine_name: "Mini", thread: THREAD, state: "dropped", words: "Typed for the Mini while it was busy", notice: expect.objectContaining({ kind: "not_delivered" }) })]);
  // Never queued and never sent: no draft write reached that machine after it was held.
  expect(door.seen.saves).toEqual([]);
  expect(existsSync(heldDir) ? readdirSync(heldDir) : []).toEqual([]);
});
