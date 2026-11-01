/**
 * The Inbox's optional debug log against a real Inbox server on loopback. Temp data dir only; the tailnet is a
 * scripted `tailscale` CLI through the runner seam, so the real one never runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_DEBUG_BODY_BYTES, INBOX_DEBUG_ID_HEADER, INBOX_DEBUG_ON_HEADER, INBOX_DEBUG_PATH } from "@plannotator/core/inbox-debug-log";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxDebugLog } from "./inbox-debug-log";

type Line = Record<string, unknown>;

const WORDS = "the-owners-private-words";
const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0)) restore();
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

function world(config: Record<string, unknown> = {}): string {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
  roots.push(dataDir);
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_INBOX_DEBUG", undefined);
  setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  return dataDir;
}

async function start(dataDir: string, extra: Parameters<typeof startInboxServer>[0] = {}): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, ...extra });
  servers.push(server);
  return server;
}

const logPath = (dataDir: string) => join(dataDir, "inbox", "debug.log");
const lines = (path: string): Line[] => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Line);
const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url(server, INBOX_DEBUG_PATH), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("off, the default", () => {
  test("nothing is written, no answer is marked, and the window's route refuses", async () => {
    const dataDir = world();
    const server = await start(dataDir);
    const read = await fetch(url(server, "/api/inbox/threads"));
    expect(read.status).toBe(200);
    expect(read.headers.has(INBOX_DEBUG_ON_HEADER)).toBe(false);
    expect((await post(server, { records: [{ t: 1, ev: "page_load" }] })).status).toBe(404);
    expect(existsSync(logPath(dataDir))).toBe(false);
  });
});

describe("on", () => {
  test("PLANNOTATOR_INBOX_DEBUG=1 turns it on at start: a request's start and end, with the window's id", async () => {
    const dataDir = world();
    setEnv("PLANNOTATOR_INBOX_DEBUG", "1");
    const server = await start(dataDir);
    const read = await fetch(url(server, "/api/inbox/threads?archived=exclude"), { headers: { [INBOX_DEBUG_ID_HEADER]: "p1-abc-1" } });
    expect(read.status).toBe(200);
    expect(read.headers.get(INBOX_DEBUG_ON_HEADER)).toBe("1");
    const mine = lines(logPath(dataDir)).filter((line) => line.id === "p1-abc-1");
    expect(mine.map((line) => line.ev)).toEqual(["req_start", "req_end"]);
    expect(mine[0]).toMatchObject({ side: "server", method: "GET", route: "/api/inbox/threads", via: "local" });
    expect(mine[1]).toMatchObject({ status: 200 });
    expect(typeof mine[1]!.ms).toBe("number");
    expect(typeof mine[0]!.t).toBe("number");
  });

  test("the config's inboxDebug turns it on too", async () => {
    const dataDir = world({ inboxDebug: true });
    const server = await start(dataDir);
    await fetch(url(server, "/api/inbox/threads"));
    expect(existsSync(logPath(dataDir))).toBe(true);
  });

  test("the window's records go in, with only the fields the log allows, and its own sends are not logged", async () => {
    const dataDir = world();
    const server = await start(dataDir, { debug: true });
    const answer = await post(server, { records: [{ t: 5, ev: "req_start", page: "p1", id: "p1-1", method: "POST", route: "/api/inbox/messages/msg_abc123XYZ/reply", words: WORDS }, { t: 6, ev: WORDS }] });
    expect(await answer.json()).toEqual({ ok: true, written: 1 });
    const all = lines(logPath(dataDir));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ t: 5, side: "window", ev: "req_start", id: "p1-1", route: "/api/inbox/messages/msg_abc123XYZ/reply" });
    expect(typeof all[0]!.at).toBe("number");
  });

  test("another site is refused, and so is a body past the cap", async () => {
    const dataDir = world();
    const server = await start(dataDir, { debug: true });
    const cross = await post(server, { records: [] }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
    expect(cross.status).toBe(403);
    const large = await post(server, { records: [], pad: "x".repeat(INBOX_DEBUG_BODY_BYTES) });
    expect(large.status).toBe(413);
    expect((await post(server, "not json")).status).toBe(400);
    expect(existsSync(logPath(dataDir))).toBe(false);
  });

  test("no words in the log: a real reply, draft, search and message carry none into it", async () => {
    const dataDir = world();
    const server = await start(dataDir, { debug: true });
    const json = { "Content-Type": "application/json" };
    await fetch(url(server, `/api/inbox/search?q=${WORDS}`));
    await fetch(url(server, `/api/inbox/threads/msg_doesnotexist/draft`), { method: "POST", headers: json, body: JSON.stringify({ body: WORDS, base: null }) });
    await fetch(url(server, `/api/inbox/messages/msg_doesnotexist/reply`), { method: "POST", headers: json, body: JSON.stringify({ idempotency_key: "k", words: WORDS }) });
    await fetch(url(server, `/api/inbox/embeds/${WORDS}.png`));
    await post(server, { records: [{ t: 1, ev: "req_fail", error: WORDS, route: `/api/inbox/embeds/${WORDS}` }] });
    const text = readFileSync(logPath(dataDir), "utf8");
    expect(text).not.toContain(WORDS);
    expect(text).toContain("/api/inbox/search");
    expect(text).toContain("/api/inbox/messages/msg_doesnotexist/reply");
  });
});

describe("the log itself", () => {
  test("a request that never finishes shows a start with no end", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    const log = createInboxDebugLog(dir);
    const served = log.wrap(() => new Promise<Response>(() => {}), () => true);
    void served(new Request("http://127.0.0.1/api/inbox/messages/msg_abc123XYZ/reply", { method: "POST", headers: { [INBOX_DEBUG_ID_HEADER]: "p1-9" } }), "local");
    expect(lines(log.path).map((line) => [line.id, line.ev])).toEqual([["p1-9", "req_start"]]);
  });

  test("a request that fails shows it failed, and the failure still reaches the caller", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    const log = createInboxDebugLog(dir);
    const served = log.wrap(() => Promise.reject(new Error(WORDS)), () => true);
    await expect(served(new Request("http://127.0.0.1/api/inbox/threads"), "local")).rejects.toThrow(WORDS);
    expect(lines(log.path).map((line) => line.ev)).toEqual(["req_start", "req_error"]);
    expect(readFileSync(log.path, "utf8")).not.toContain(WORDS);
  });

  test("the cap holds: it rotates once, so there are never more than two files, each under the cap", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    const cap = 2_000;
    const log = createInboxDebugLog(dir, cap);
    const served = log.wrap(async () => new Response("ok"), () => true);
    for (let i = 0; i < 200; i += 1) await served(new Request("http://127.0.0.1/api/inbox/threads"), "local");
    expect(readFileSync(log.path).length).toBeLessThanOrEqual(cap);
    expect(readFileSync(`${log.path}.1`).length).toBeLessThanOrEqual(cap);
    expect(existsSync(`${log.path}.2`)).toBe(false);
  });
});

describe("over the tailnet", () => {
  const MAGIC = "macbook-pro.tail0000.ts.net";
  const OWNER = "ramos@example.com";
  const fakeTailscale = () => {
    const serve = new Map<number, string>();
    const run: TailscaleRunner = (args) => {
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER, DisplayName: "Ramos" } } }));
      if (args[1] === "status") {
        if (serve.size === 0) return ok("{}");
        const TCP = Object.fromEntries([...serve.keys()].map((port) => [String(port), { HTTPS: true }]));
        const Web = Object.fromEntries([...serve].map(([port, proxy]) => [`${MAGIC}:${port}`, { Handlers: { "/": { Proxy: proxy } } }]));
        return ok(JSON.stringify({ TCP, Web }));
      }
      const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
      if (args.includes("off")) {
        serve.delete(httpsPort);
        return ok();
      }
      serve.set(httpsPort, args.at(-1)!);
      return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
    };
    return run;
  };

  test("the owner's window is told and may write; another tailnet person is not told and is refused", async () => {
    const dataDir = world({ inboxTailscale: true });
    const run = fakeTailscale();
    const server = await start(dataDir, { debug: true, tailscale: run });
    const listener = server.tailscale.listenerPort();
    if (listener === null) throw new Error("not published");
    const through = (path: string, login: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${listener}${path}`, { ...init, headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": login, ...(init.headers ?? {}) } });
    const records = { method: "POST", body: JSON.stringify({ records: [{ t: 1, ev: "page_load" }] }), headers: { "Content-Type": "application/json" } };

    const owner = await through("/api/inbox/threads", OWNER);
    expect(owner.headers.get(INBOX_DEBUG_ON_HEADER)).toBe("1");
    expect((await through(INBOX_DEBUG_PATH, OWNER, records)).status).toBe(200);

    const guest = await through("/api/inbox/threads", "someone@example.com");
    expect(guest.headers.has(INBOX_DEBUG_ON_HEADER)).toBe(false);
    expect((await through(INBOX_DEBUG_PATH, "someone@example.com", records)).status).toBe(403);
    expect(lines(logPath(dataDir)).filter((line) => line.side === "window")).toHaveLength(1);
    expect(lines(logPath(dataDir)).some((line) => line.via === "tailnet")).toBe(true);
  });
});
