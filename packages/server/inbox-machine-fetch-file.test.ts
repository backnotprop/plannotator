/**
 * `plannotator inbox call fetch_file` of a linked machine's file, through this Inbox's real control route
 * (`/api/inbox/control/machines/fetch-file`, inbox-machines.ts) and its real link to a stand-in far door on loopback
 * (PLANNOTATOR_TEST_SANDBOX lets the transport take it); the command's own code saves the file. No Inbox runs.
 * What regresses: the Inbox writing a file (in a folder a caller names, or anywhere), and a command that gave up
 * leaving the far fetch running.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchFarFile } from "../../apps/hook/server/inbox-call-far-fetch";
import { createInboxMachines } from "./inbox-machines";
import { InboxLinks } from "./inbox-links";

const FAR = "ibx_01K00000000000000000000000";
const TOKEN = "tok_test";
const MESSAGE = "msg_01K00000000000000000000000";
const BYTES = "# Plan\n100 a minute\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let root: string;
let savedSandbox: string | undefined;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-machine-fetch-")));
  savedSandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (savedSandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
  else process.env.PLANNOTATOR_TEST_SANDBOX = savedSandbox;
  rmSync(root, { recursive: true, force: true });
});

/** The far machine's door: health, its list (taking `agent-read`), its stream, and `agent-file`. */
function farDoor() {
  const seen = { fileAsks: 0, aborted: [] as number[] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      const route = url.pathname.replace("/api/inbox/device/", "");
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ code: "device_token_invalid" }, { status: 401 });
      if (route === "health") return Response.json({ ok: true, inbox_id: FAR, machine_links: 1, version: "0.28.70" });
      if (route === "threads") return Response.json({ cursor: 1, sections: [], projects: [], marks: ["agent-read"] });
      if (route === "events") {
        const body = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":1}\n\n`)) });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (route === "agent-file") {
        seen.fileAsks++;
        if (url.searchParams.get("file") === "hang") {
          const asked = Date.now();
          return new Promise<Response>((resolve) => req.signal.addEventListener("abort", () => (seen.aborted.push(Date.now() - asked), resolve(new Response(null, { status: 499 })))));
        }
        return new Response(BYTES, { headers: { "Content-Type": "text/markdown", "Content-Length": String(Buffer.byteLength(BYTES)), "X-Plannotator-File-Name": "plan.md", "X-Plannotator-File-Sha256": sha(BYTES) } });
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
    serverSession: "srv",
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
  // The control route over real HTTP, as the command reaches it (inbox.ts answers a thrown refusal in words).
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      try {
        return (await machines.control(req, new URL(req.url).pathname)) ?? Response.json({ code: "not_found" }, { status: 404 });
      } catch (error) {
        return Response.json({ code: (error as { code?: string }).code, error: (error as Error).message }, { status: 400 });
      }
    },
  });
  cleanups.push(() => control.stop(true));
  return { dataDir, door, entry: { port: control.port!, token: "registry-token" } };
}

/** Every file under a folder, relative. */
function filesUnder(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
}

test("the Inbox streams the file to the command and writes none: a folder in the ask is not the Inbox's to use", async () => {
  const { dataDir, entry } = await linkedInbox();
  const before = filesUnder(dataDir);
  // A caller that names a folder to the route itself (a hook folder, a LaunchAgents folder): nothing is made there.
  const target = join(root, "repo", ".git", "hooks");
  const answer = await fetch(`http://127.0.0.1:${entry.port}/api/inbox/control/machines/fetch-file`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message_id: MESSAGE, file: "plan.md", folder: target }) });
  expect(answer.status).toBe(200);
  expect(answer.headers.get("x-plannotator-file-name")).toBe("plan.md");
  expect(await answer.text()).toBe(BYTES);
  expect(existsSync(join(root, "repo"))).toBe(false);
  expect(filesUnder(dataDir)).toEqual(before);
  // The command saves it, in the folder it was given, in its own process.
  const cwd = join(root, "work");
  const saved = await fetchFarFile({ message_id: MESSAGE, file: "plan.md", folder: "fetched" }, cwd, entry);
  expect(saved).toMatchObject({ ok: true, saved: { path: join(cwd, "fetched", "plan.md"), size: Buffer.byteLength(BYTES), sha256: sha(BYTES), machine: FAR } });
  expect(readFileSync(join(cwd, "fetched", "plan.md"), "utf8")).toBe(BYTES);
  expect(filesUnder(dataDir)).toEqual(before);
});

test("a command that gave up stops the far fetch at once, not at the far wait's end", async () => {
  const { door, entry } = await linkedInbox();
  const started = Date.now();
  const gaveUp = await fetchFarFile({ message_id: MESSAGE, file: "hang" }, root, entry, fetch, { answerMs: 150 });
  expect(gaveUp).toMatchObject({ ok: false, code: "inbox_no_answer" });
  for (let i = 0; i < 100 && door.seen.aborted.length === 0; i++) await Bun.sleep(10);
  expect(door.seen.aborted.length).toBe(1);
  // The far wait is 5 s: the far request ended with the command's, well before.
  expect(Date.now() - started).toBeLessThan(2_000);
});
