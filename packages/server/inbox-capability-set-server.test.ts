/**
 * One set of Capabilities switches (inbox-capability-set.ts) on a real Inbox in a temp data dir: what the settings
 * route stamps and who is given the set. Starts an Inbox: CI runs it.
 *
 * What regresses: a Settings save that turns a switch without stamping its flip (so a linked computer's older flip
 * turns it back); a save that stamps a switch it does not name, or drops another switch's stamp; the set
 * (`capability_set`, every switch with its flip) given to anything but a linked computer's token: this computer's
 * window, a paired phone's list, or any window or phone stream.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { startInboxServer, type InboxServer } from "./inbox";
import { parseLinkOffer } from "./inbox-links";

const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_BROWSER", "HOME", "PLANNOTATOR_TEST_SANDBOX", "PLANNOTATOR_EXPERIMENTAL"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];
const servers: InboxServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const MAGIC = "inbox-host.tail0000.ts.net";

/** A scripted tailscale that publishes the Inbox (as inbox-rex-route.test.ts): no real tailscale runs. */
function scriptedTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42, TailscaleIPs: ["100.100.1.1"] }, User: { "42": { ID: 42, LoginName: "owner@example.com" } } }));
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      return ok(
        JSON.stringify({
          TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
          Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
        }),
      );
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok(`https://${MAGIC}:${httpsPort}/\n`);
  };
}

type Json = Record<string, any>;

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-capability-set-server-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const home = join(root, "home");
  for (const dir of [dataDir, home]) mkdirSync(dir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.HOME = home;
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  process.env.PLANNOTATOR_TEST_SANDBOX = dataDir;
  delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
  delete process.env.PLANNOTATOR_EXPERIMENTAL;
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ updateCheck: false, inboxTailscale: true, inboxSteps: false }));
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: true, tailscale: scriptedTailscale(), readProjectRepo: async () => null });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const windowHeaders = { "Sec-Fetch-Site": "same-origin", Origin: base };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const save = (body: Json) => post("/api/inbox/settings", { serverSession: server.serverSession, ...body }, windowHeaders);
  const flips = () => (JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Json).inboxCapabilityFlips as Json | undefined;
  const pair = async (platform: "ios" | "machine") => {
    if (platform === "ios") {
      const made = (await (await post("/api/inbox/pairing", {})).json()) as { offer: { code: string } };
      return ((await (await post("/api/inbox/device/pair", { code: made.offer.code, name: "iPhone", platform: "ios" })).json()) as { token: string }).token;
    }
    const offered = (await (await post("/api/inbox/machines/offer", {})).json()) as { link: string };
    return ((await (await post("/api/inbox/device/pair", { name: "MacBook", platform: "machine", secret: parseLinkOffer(offered.link)!.secret })).json()) as { token: string }).token;
  };
  /** Every byte a stream sends until `stop`. */
  const listen = async (path: string, headers: Record<string, string>) => {
    const response = await fetch(`${base}${path}`, { headers });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const done = (async () => {
      try {
        while (true) {
          const { value, done: ended } = await reader.read();
          if (ended) return;
          text += decoder.decode(value, { stream: true });
        }
      } catch {
        // Cancelled by the test.
      }
    })();
    return { text: () => text, stop: () => reader.cancel().then(() => done) };
  };
  return { base, server, windowHeaders, save, flips, pair, listen };
}

async function until(what: string, check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(20);
  if (!check()) throw new Error(`never: ${what}`);
}

test("a Settings save stamps a flip time for each switch it names, and keeps the others' stamps", async () => {
  const w = await world();
  expect(w.flips()).toBeUndefined();
  const before = Date.now();
  expect((await w.save({ bro: { on: true } })).status).toBe(200);
  const first = w.flips()!;
  expect(Object.keys(first)).toEqual(["bro"]);
  expect(first.bro.at).toBeGreaterThanOrEqual(before);
  expect(first.bro.at).toBeLessThanOrEqual(Date.now());
  expect(first.bro.by).toMatch(/^ibx_/);
  // Grid, inside `experimental`, and Checklist: stamped too, Bro mode's kept.
  expect((await w.save({ experimental: { grid: true }, steps: { on: true } })).status).toBe(200);
  const second = w.flips()!;
  expect(second.bro).toEqual(first.bro);
  expect([typeof second.grid?.at, typeof second.steps?.at]).toEqual(["number", "number"]);
  // A save that names no switch stamps nothing.
  expect((await w.save({ show_archived: { on: true } })).status).toBe(200);
  expect(w.flips()).toEqual(second);
  // A linked computer reads the flip with the switch.
  const machine = await w.pair("machine");
  const list = (await (await fetch(`${w.base}/api/inbox/device/threads`, { headers: { Authorization: `Bearer ${machine}` } })).json()) as Json;
  expect(list.capability_set.bro).toEqual({ on: true, at: first.bro.at, by: first.bro.by });
}, 60_000);

test("the set goes to a linked computer only: never in this computer's window, a phone's list, or a window's or a phone's stream", async () => {
  const w = await world();
  const phone = await w.pair("ios");
  const machine = await w.pair("machine");
  const windowStream = await w.listen("/api/inbox/events?window=window-one", { "Sec-Fetch-Site": "same-origin" });
  const phoneStream = await w.listen("/api/inbox/device/events", { Authorization: `Bearer ${phone}` });
  // A flip, so every stream that follows the switches has something to say.
  expect((await w.save({ bro: { on: true } })).status).toBe(200);
  await until("the window told of the switch", () => windowStream.text().includes("event: capabilities"));
  await Bun.sleep(200);
  await Promise.all([windowStream.stop(), phoneStream.stop()]);
  expect([windowStream.text().includes("capability_set"), phoneStream.text().includes("capability_set")]).toEqual([false, false]);
  const read = async (path: string, headers: Record<string, string>) => (await (await fetch(`${w.base}${path}`, { headers })).json()) as Json;
  expect("capability_set" in (await read("/api/inbox/threads", w.windowHeaders))).toBe(false);
  expect("capability_set" in (await read("/api/inbox/device/threads", { Authorization: `Bearer ${phone}` }))).toBe(false);
  // The linked computer's own read carries it.
  expect((await read("/api/inbox/device/threads", { Authorization: `Bearer ${machine}` })).capability_set?.bro?.on).toBe(true);
}, 60_000);
