/**
 * Routines and capability switches across linked computers, on two real Inboxes linked both ways (the owner: "If I'm
 * connected somehow to all my machines, I need to see routines from each... I need to be able to run routines from each
 * if I'm connected."). A routine lives and runs on the computer that made it; A's window lists B's beside its own and
 * changes B's through the forward, B's door and B's own routes. Starts two Inboxes: CI runs it.
 *
 * What this catches: A unable to turn on B's Routines (or turning on its own); a create from A landing on A, or not at
 * all; A's merged list without B's routine or its computer; an on, a run or an edit from A not taking effect on B; a bare
 * call through the forward changing a routine (only a window's press does, as here); B asleep: its routine dropped from
 * A's list instead of kept as last known, or a turn off lost instead of held and applied when B is back; a linked
 * computer's switch read (an older computer's group) exposing other settings; an agent's `computer`, gone with the one
 * set, still taken.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { waitFor } from "../../tests/helpers/inbox-world";
import { startInboxServer } from "./inbox";

type Json = Record<string, any>;

/** A `tailscale` stand-in that keeps a serve config (as inbox-archived-machines.test.ts does). */
function scriptedTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`laptop.tail0000.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) {
      serve.delete(httpsPort);
      return ok();
    }
    serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://laptop.tail0000.ts.net:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
  };
}

describe("routines and capability switches across linked computers", () => {
  const dirs: string[] = [];
  const envWas = { sandbox: process.env.PLANNOTATOR_TEST_SANDBOX, home: process.env.HOME };
  let root = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-routines-linked-")));
    dirs.push(root);
    process.env.PLANNOTATOR_TEST_SANDBOX = root;
    // The sandboxed Inboxes' launchers read this as home.
    process.env.HOME = join(root, "home");
    mkdirSync(process.env.HOME, { recursive: true });
  });
  afterAll(() => {
    for (const [name, was] of [["PLANNOTATOR_TEST_SANDBOX", envWas.sandbox], ["HOME", envWas.home]] as const) {
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const fake = fakeLaunchHost();
  const login = { calls: [] as string[], path: null, add: async () => (login.calls.push("add"), "added" as const), remove: async () => void login.calls.push("remove") };
  const dataDir = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
    return dir;
  };
  /**
   * `scheduled`: the Inbox's own Routines switch held (`options.scheduled`). Both Inboxes run in this one process and so
   * read one config.json (each is its own process on a real computer): A's is held off, so B's turned on stays B's.
   */
  const start = (dir: string, scheduled?: boolean) => startInboxServer({ dataDir: dir, binaryPath: null, phones: false, tailscale: scriptedTailscale(), launchHosts: () => [fake.host], scheduledLogin: login, ...(scheduled === undefined ? {} : { scheduled }) });
  const at = (port: number) => `http://127.0.0.1:${port}`;
  const get = async (port: number, path: string) => (await (await fetch(`${at(port)}${path}`)).json()) as Json;
  let keys = 0;
  /** A press in A's window: its Origin and page session, and the window's key for a write to another machine. */
  const press = async (port: number, path: string, body: Json = {}) => {
    const health = await get(port, "/api/inbox/health");
    return fetch(`${at(port)}${path}`, { method: "POST", headers: { Origin: at(port), "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: `window-routine-${++keys}`, ...body }) });
  };
  /** The same call with no Origin: an agent's or a script's, not a press. */
  const bare = (port: number, path: string, body: Json = {}) => fetch(`${at(port)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: `bare-${++keys}`, ...body }) });
  const merged = async (port: number) => get(port, "/api/inbox/scheduled?machines=1");

  test("A turns on B's Routines, makes, turns on, runs and edits B's routine; a bare call cannot; B asleep, it stays listed and a turn off waits", async () => {
    const dataA = dataDir("a");
    const dataB = dataDir("b");
    const a = await start(dataA, false);
    let b = await start(dataB);
    try {
      const offered = (await (await fetch(`${at(b.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(a.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(b.port), back: at(a.port) }) });
      expect(linked.status).toBe(201);
      const bId = (JSON.parse(readFileSync(join(dataA, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      const far = `/api/inbox/m/${bId}`;
      await waitFor("B's list on A", async () => ((await get(a.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)?.marks?.includes("routines") === true, 15_000);

      // B's switches, read from A as an older computer's group of B still reads them: the capability switches alone, no
      // other setting (this Inbox's own window no longer reads them: the switches are one set).
      const switches = await get(a.port, `${far}/capabilities`);
      expect(switches.capabilities.scheduled_threads).toEqual({ on: false });
      expect(Object.keys(switches)).toEqual(["capabilities"]);
      // Routines on B, turned from A as that older group turns them; A's stay off (held off here). The answer carries the switches only.
      const turned = await press(a.port, `${far}/capabilities`, { scheduled_threads: { on: true } });
      expect(turned.status).toBe(200);
      expect(Object.keys((await turned.json()) as Json).every((key) => ["board", "steps", "decision_mode", "scheduled_threads", "code_review", "chapter_diagrams", "system", "bro", "float_drafts"].includes(key))).toBe(true);
      expect((await get(b.port, "/api/inbox/settings")).scheduled_threads.on).toBe(true);
      // The turn went through B's door (its command log), not to A's own settings.
      const doorLines = readFileSync(join(dataB, "inbox", "device-commands.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Json);
      expect(doorLines.map((line) => [line.method, line.path, line.status])).toContainEqual(["POST", "/api/inbox/device/capabilities", 200]);
      expect((await get(a.port, "/api/inbox/settings")).scheduled_threads.on).toBe(false);
      // Any other setting through that route is refused there.
      expect((await press(a.port, `${far}/capabilities`, { theme: "dark" })).status).toBe(422);

      // A routine made on B from A's window.
      const fields = { name: "Nightly build", prompt: "Build and report.", schedule: null, if_missed: "run_once", folder: { scratch: true }, agent: FAKE, attachments: [] };
      const made = await press(a.port, `${far}/scheduled`, fields);
      expect(made.status).toBe(201);
      const id = ((await made.json()) as Json).scheduled.id as string;
      expect(((await get(b.port, "/api/inbox/scheduled")).scheduled as Json[]).map((r) => r.id)).toEqual([id]);

      // A's merged list: B's routine with its computer; A's Routines are off, so only B's.
      const list = await merged(a.port);
      expect((list.scheduled as Json[]).map((r) => [r.id, r.machine])).toEqual([[id, bId]]);
      expect(list.computers).toEqual([{ id: bId, on: true, launch_on: true, away: false, read_at: expect.any(String) }]);

      // A bare call through the forward changes nothing: only a press in a window does.
      expect((await bare(a.port, `${far}/scheduled/${id}/on`)).status).toBe(403);
      expect(((await get(b.port, `/api/inbox/scheduled/${id}`)).scheduled as Json).state).toBe("off");

      // On, an edit and Run now, each from A, each on B.
      expect((await press(a.port, `${far}/scheduled/${id}/on`)).status).toBe(200);
      expect((await press(a.port, `${far}/scheduled/${id}`, { prompt: "Build, test and report." })).status).toBe(200);
      const run = await press(a.port, `${far}/scheduled/${id}/run`);
      expect(run.status).toBe(202);
      expect(typeof ((await run.json()) as Json).message_id).toBe("string");
      const onB = (await get(b.port, `/api/inbox/scheduled/${id}`)).scheduled as Json;
      expect([onB.prompt, onB.state === "off"]).toEqual(["Build, test and report.", false]);

      // B asleep: A still lists B's routine, as last known; a turn off waits (202) and lands when B is back.
      b.stop();
      await waitFor("B offline on A", async () => ((await get(a.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)?.state === "offline", 30_000);
      const asleep = await merged(a.port);
      expect((asleep.scheduled as Json[]).map((r) => [r.id, r.machine])).toEqual([[id, bId]]);
      expect((asleep.computers as Json[])[0]!.away).toBe(true);
      expect((await press(a.port, `${far}/scheduled/${id}/off`)).status).toBe(202);
      b = await start(dataB);
      // Off is the routine's switch: the run Run now started is still going there (the fake agent never ends), so its
      // row says "running" until that run ends, turned off or not.
      await waitFor("the held turn off on B", async () => ((await get(b.port, `/api/inbox/scheduled/${id}`)).scheduled as Json).enabled === false, 45_000);

      // An agent on A, asked by the person (`plannotator inbox capability checklist on`): the switch turns on A, which
      // every linked computer then takes (both Inboxes read one config.json here, so the e2e proves that part); one
      // line for the person, on A. A `computer` (gone with the one set) is refused.
      await waitFor("B back on A", async () => ((await get(a.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)?.state === "online", 30_000);
      const bName = ((await get(a.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)!.name as string;
      const folder = join(root, "work");
      mkdirSync(folder, { recursive: true });
      const agentAsk = (extra: Json) =>
        fetch(`${at(a.port)}/api/inbox/capability`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ by: { session: "ses_ada", host: "claude-code", name: "Claude Code" }, project_path: folder, capability: "checklist", on: true, ...extra }),
        });
      expect((await agentAsk({ computer: bName })).status).toBe(422);
      expect((await get(a.port, "/api/inbox/settings")).steps.on).toBe(false);
      const agentTurn = await agentAsk({});
      expect(agentTurn.status).toBe(200);
      const text = ((await agentTurn.json()) as { text: string }).text;
      expect(text).toStartWith("Turned on Checklist. The person sees it in thread ");
      expect((await get(a.port, "/api/inbox/settings")).steps.on).toBe(true);
      const lineId = /thread (msg_[^\s.]+)\./.exec(text)![1]!;
      expect((a.store.message(lineId)?.body ?? "")).toBe("Turned on Checklist.");
      expect(a.store.threadMessageIds(a.store.message(lineId)!.thread_id)).toHaveLength(1);
    } finally {
      a.stop();
      b.stop();
    }
  }, 150_000);
});
