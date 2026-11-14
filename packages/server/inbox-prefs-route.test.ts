/**
 * GET and POST /api/inbox/prefs on a real Inbox in a temp data dir.
 *
 * What regresses: the local command line (plain fetch to 127.0.0.1, no Origin, no serverSession, as `plannotator inbox
 * rows` reaches the settings) refused; another site, a stale page's serverSession or another Tailscale account
 * getting a write through, or any key of a call written when one of its values is refused; reset not putting the
 * default; the group filter; a key that no longer reads back what it wrote, or no longer saves to the config.json
 * field its `stored` names; `event: prefs` not reaching an open window, for a write here and for a save from Settings.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { inboxPref } from "@plannotator/core/inbox-prefs";
import type { InboxPrefEntry } from "./inbox-prefs";

const MAGIC = "macbook-pro.tail0000.ts.net";
const OWNER = "owner@example.com";
const OTHER = "other@example.com";

const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** A scripted `tailscale` (the real one never runs): the owner's machine. */
function fakeTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
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
    return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n`);
  };
}

type Json = Record<string, any>;

async function world(options: { tailnet?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-prefs-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  for (const name of ["PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_URL_HOST", "PLANNOTATOR_UPDATE_CHECK", "PLANNOTATOR_INBOX_PREVIEW"]) setEnv(name, undefined);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ updateCheck: false, ...(options.tailnet ? { inboxTailscale: true } : {}) }));
  const home = join(root, "home");
  mkdirSync(home);
  const server = await startInboxServer({
    dataDir,
    binaryPath: null,
    phones: false,
    ...(options.tailnet ? { tailscale: fakeTailscale() } : {}),
    agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: {} }),
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  /** The command line: no Origin, no serverSession. */
  const cli = (body?: Json, query = "") =>
    fetch(`${base}/api/inbox/prefs${query}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  /** A window of this Inbox: its own Origin and serverSession. */
  const page = (path: string, body: Json, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...headers }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
  const viaTailnet = (who: string, body?: Json) => {
    const listener = server.tailscale.listenerPort();
    if (listener === null) throw new Error("not published");
    return fetch(`http://127.0.0.1:${listener}/api/inbox/prefs`, {
      method: body ? "POST" : "GET",
      headers: {
        Host: `${MAGIC}:${server.port}`,
        Origin: `https://${MAGIC}:${server.port}`,
        "Sec-Fetch-Site": "same-origin",
        "X-Forwarded-Proto": "https",
        "Tailscale-User-Login": who,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify({ serverSession: server.serverSession, ...body }) } : {}),
    });
  };
  const prefs = async (query = "") => ((await (await cli(undefined, query)).json()) as { groups: string[]; prefs: InboxPrefEntry[] }).prefs;
  const value = async (key: string) => (await prefs()).find((p) => p.key === key)?.value;
  const saved = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Json;
  /** A window's event stream, open from the start: the text it has heard so far, waiting up to a moment for `until`. */
  const stream = async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/inbox/events?cursor=${server.store.cursor()}&window=window-prefs-1&permission=granted`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value);
    return {
      heard: async (until: string) => {
        const deadline = Date.now() + 1500;
        while (!text.includes(until) && Date.now() < deadline) {
          const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))]);
          if (chunk && chunk.value) text += decoder.decode(chunk.value);
        }
        return text;
      },
      close: () => controller.abort(),
    };
  };
  return { server, base, cli, page, viaTailnet, prefs, value, saved, savedText: () => readFileSync(join(dataDir, "config.json"), "utf8"), stream, dataDir };
}

describe("from the command line", () => {
  test("the list with values now; several keys set in one call, heard by an open window", async () => {
    const w = await world();
    const all = await w.prefs();
    expect(all.find((p) => p.key === "appearance.text_size")).toMatchObject({ value: 14, default: 14, type: "number" });
    const events = await w.stream();

    const response = await w.cli({ set: { "appearance.theme": "light", "appearance.text_size": 15, "sound.volume": 40 }, by: { host: "claude-code", session: "s1" } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Json).changes).toEqual([
      { key: "appearance.theme", from: "dark", to: "light" },
      { key: "appearance.text_size", from: 14, to: 15 },
      { key: "sound.volume", from: 60, to: 40 },
    ]);
    expect(w.saved()).toMatchObject({ theme: { mode: "light" }, inboxTextSize: 15, inboxSound: { volume: 40 } });
    const text = await events.heard("event: prefs");
    events.close();
    const frames = text.split("\n\n").filter((frame) => frame.startsWith("event: prefs"));
    expect(frames.length).toBe(1);
    expect(JSON.parse(frames[0]!.split("data: ")[1]!)).toEqual({ keys: ["appearance.theme", "appearance.text_size", "sound.volume"], by: { host: "claude-code", session: "s1" } });
  });

  test("one bad value or unknown key writes nothing; reset puts the default; the group filter", async () => {
    const w = await world();
    const before = w.savedText();
    const bad = await w.cli({ set: { "appearance.theme": "light", "appearance.text_size": 22 } });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: "validation_error", key: "appearance.text_size" });
    const unknown = await w.cli({ set: { "appearance.theme": "light", "appearance.font": "serif" } });
    expect(await unknown.json()).toMatchObject({ code: "unknown_pref", key: "appearance.font" });
    expect(w.savedText()).toBe(before);

    expect((await w.cli({ set: { "appearance.text_size": 12 } })).status).toBe(200);
    expect((await w.cli({ reset: ["appearance.text_size"] })).status).toBe(200);
    expect(await w.value("appearance.text_size")).toBe(14);

    expect((await w.prefs("?group=sound")).map((p) => p.key)).toEqual(["sound.on", "sound.volume"]);
    expect((await w.cli(undefined, "?group=fonts")).status).toBeGreaterThanOrEqual(400);
  });

  test("each key reads back what it wrote and saves to the config.json field it names", async () => {
    const w = await world();
    const skip = new Set(["capabilities.system", "capabilities.shape", "capabilities.code_review"]);
    const groups = new Set(["appearance", "sound", "notifications", "list", "diff", "experimental", "decisions", "capabilities", "prompts"]);
    const tried: string[] = [];
    for (const pref of await w.prefs()) {
      if (!groups.has(pref.group) || skip.has(pref.key)) continue;
      let next: unknown;
      if (pref.type === "boolean") next = !pref.value;
      else if (pref.type === "choice" || (pref.type === "number" && pref.values)) next = pref.values!.find((v) => v !== pref.value);
      else if (pref.type === "number") next = pref.value === pref.min ? pref.max : pref.min;
      else if (pref.type === "text" && pref.group === "prompts") next = `Kept short for ${pref.key}.`;
      else continue;
      const response = await w.cli({ set: { [pref.key]: next } });
      expect({ key: pref.key, status: response.status }).toEqual({ key: pref.key, status: 200 });
      expect({ key: pref.key, value: await w.value(pref.key) }).toEqual({ key: pref.key, value: next });
      const stored = inboxPref(pref.key)!.stored;
      const saved = stored.startsWith("file:") ? existsSync(join(w.dataDir, stored.slice(5))) : w.saved()[stored.split(".")[0]!] !== undefined;
      expect({ key: pref.key, saved }).toEqual({ key: pref.key, saved: true });
      tried.push(pref.key);
    }
    expect(tried.length).toBeGreaterThan(25);
  });
});

describe("the guards", () => {
  test("another site is refused, reads too; a stale page's serverSession is refused", async () => {
    const w = await world();
    const evil = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" };
    expect((await fetch(`${w.base}/api/inbox/prefs`, { headers: evil })).status).toBe(403);
    expect((await w.page("/api/inbox/prefs", { set: { "appearance.theme": "light" } }, evil)).status).toBe(403);
    const stale = await fetch(`${w.base}/api/inbox/prefs`, { method: "POST", headers: { "Content-Type": "application/json", Origin: w.base }, body: JSON.stringify({ serverSession: "an-earlier-run", set: { "appearance.theme": "light" } }) });
    expect(stale.status).toBe(409);
    expect(w.saved().theme).toBeUndefined();
    // This Inbox's own window goes through.
    expect((await w.page("/api/inbox/prefs", { set: { "appearance.theme": "light" } })).status).toBe(200);
  });

  test("another Tailscale account reads and writes nothing; the owner over the tailnet sets any key", async () => {
    const w = await world({ tailnet: true });
    const before = w.savedText();
    expect((await w.viaTailnet(OTHER)).status).toBe(403);
    expect((await w.viaTailnet(OTHER, { set: { "appearance.theme": "light" } })).status).toBe(403);
    expect(w.savedText()).toBe(before);
    expect((await w.viaTailnet(OWNER, { set: { "capabilities.board": true, "access.tailnet_allow": ["another@example.com"] } })).status).toBe(200);
    expect(w.saved()).toMatchObject({ inboxBoard: true, inboxTailscaleAllow: ["another@example.com"] });
  });
});

describe("event: prefs", () => {
  test("a save from Settings names its keys to every window", async () => {
    const w = await world();
    const events = await w.stream();
    expect((await w.page("/api/inbox/settings", { text_size: 13 })).status).toBe(200);
    const text = await events.heard("event: prefs");
    events.close();
    expect(text).toContain(`event: prefs\ndata: ${JSON.stringify({ keys: ["appearance.text_size"], by: null })}`);
  });
});
