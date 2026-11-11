/** The Inbox's optional debug log against a real Inbox; the tailnet is a scripted `tailscale` CLI. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_DEBUG_BATCH_RECORDS, INBOX_DEBUG_BODY_BYTES, INBOX_DEBUG_ID_HEADER, INBOX_DEBUG_ON_HEADER, INBOX_DEBUG_PATH } from "@plannotator/shared/inbox/debug-log";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxDebugLog, flushInboxDebugLogs, INBOX_DEBUG_PENDING_MAX_BYTES } from "./inbox-debug-log";

type Line = Record<string, unknown>;

const WORDS = "the-owners-private-words";
const MSG = "msg_01J9Z3V5K8Q2W4E6R7T8Y9M0NP";
const PAGE = "p1793536686632-48213";
const REQUEST = `${PAGE}-1`;
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
    await flushInboxDebugLogs();
    expect(existsSync(logPath(dataDir))).toBe(false);
  });
});

describe("on", () => {
  test("PLANNOTATOR_INBOX_DEBUG=1 turns it on at start: a request's start and end, with the window's id", async () => {
    const dataDir = world();
    setEnv("PLANNOTATOR_INBOX_DEBUG", "1");
    const server = await start(dataDir);
    const read = await fetch(url(server, "/api/inbox/threads?archived=exclude"), { headers: { [INBOX_DEBUG_ID_HEADER]: REQUEST } });
    expect(read.status).toBe(200);
    expect(read.headers.get(INBOX_DEBUG_ON_HEADER)).toBe("1");
    await flushInboxDebugLogs();
    const mine = lines(logPath(dataDir)).filter((line) => line.id === REQUEST);
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
    await flushInboxDebugLogs();
    expect(existsSync(logPath(dataDir))).toBe(true);
  });

  test("the window's records go in, with only the fields the log allows, and its own sends are not logged", async () => {
    const dataDir = world();
    const server = await start(dataDir, { debug: true });
    const answer = await post(server, { records: [{ t: 5, ev: "req_start", page: PAGE, id: REQUEST, method: "POST", route: `/api/inbox/messages/${MSG}/reply`, words: WORDS }, { t: 6, ev: WORDS }] });
    expect(await answer.json()).toEqual({ ok: true, written: 1 });
    await flushInboxDebugLogs();
    const all = lines(logPath(dataDir));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ t: 5, side: "window", ev: "req_start", page: PAGE, id: REQUEST, route: `/api/inbox/messages/${MSG}/reply` });
    expect(typeof all[0]!.at).toBe("number");
  });

  test("a body may hold a full batch of records, and no more", async () => {
    const dataDir = world();
    const server = await start(dataDir, { debug: true });
    const batch = (size: number) => ({ records: Array.from({ length: size }, (_, i) => ({ t: i + 1, ev: "visibility" })) });
    const refused = await post(server, batch(INBOX_DEBUG_BATCH_RECORDS + 1));
    expect(refused.status).toBe(413);
    await flushInboxDebugLogs();
    expect(existsSync(logPath(dataDir))).toBe(false);
    expect(await (await post(server, batch(INBOX_DEBUG_BATCH_RECORDS))).json()).toEqual({ ok: true, written: INBOX_DEBUG_BATCH_RECORDS });
    await flushInboxDebugLogs();
    expect(lines(logPath(dataDir))).toHaveLength(INBOX_DEBUG_BATCH_RECORDS);
  });

  test("another site is refused, and so is a body past the cap", async () => {
    const dataDir = world();
    const server = await start(dataDir, { debug: true });
    const cross = await post(server, { records: [] }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
    expect(cross.status).toBe(403);
    const large = await post(server, { records: [], pad: "x".repeat(INBOX_DEBUG_BODY_BYTES) });
    expect(large.status).toBe(413);
    expect((await post(server, "not json")).status).toBe(400);
    await flushInboxDebugLogs();
    expect(existsSync(logPath(dataDir))).toBe(false);
  });

  test("no words in the log: a real reply, draft, search and message carry none into it", async () => {
    const dataDir = world();
    const server = await start(dataDir, { debug: true });
    const json = { "Content-Type": "application/json" };
    await fetch(url(server, `/api/inbox/search?q=${WORDS}`));
    await fetch(url(server, `/api/inbox/threads/${MSG}/draft`), { method: "POST", headers: json, body: JSON.stringify({ body: WORDS, base: null }) });
    await fetch(url(server, `/api/inbox/messages/${MSG}/reply`), { method: "POST", headers: json, body: JSON.stringify({ idempotency_key: "k", words: WORDS }) });
    await fetch(url(server, `/api/inbox/embeds/${WORDS}.png`));
    await post(server, { records: [{ t: 1, ev: "req_fail", error: WORDS, route: `/api/inbox/embeds/${WORDS}` }] });
    await flushInboxDebugLogs();
    const text = readFileSync(logPath(dataDir), "utf8");
    expect(text).not.toContain(WORDS);
    expect(text).toContain("/api/inbox/search");
    expect(text).toContain(`/api/inbox/messages/${MSG}/reply`);
  });

  test("no words in the log: words dressed as an id, on real requests and in every field a page fills", async () => {
    const dataDir = world();
    const server = await start(dataDir, { debug: true });
    const dressed = [`/api/inbox/outbox/msg_${WORDS}`, `/api/inbox/drafts/drf_${WORDS}`, `/api/inbox/attachments/att_${WORDS}/download`];
    for (const path of dressed) await fetch(url(server, path), { headers: { [INBOX_DEBUG_ID_HEADER]: WORDS } });
    await post(server, { records: [{ t: 1, ev: "req_fail", id: `p-${WORDS}`, page: `p-${WORDS}`, error: "Zebraquartz", protocol: "zebra/1", thread: `msg_${WORDS}`, route: dressed[0] }] });
    await flushInboxDebugLogs();
    const text = readFileSync(logPath(dataDir), "utf8");
    expect(text).not.toContain(WORDS);
    expect(text).not.toContain("ebraquartz");
    expect(text).not.toContain("zebra/1");
    await flushInboxDebugLogs();
    expect(lines(logPath(dataDir)).filter((line) => line.route === "/api/inbox/outbox/*").length).toBeGreaterThan(0);
  });
});

describe("the window's route on its own", () => {
  const log = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    return dir;
  };

  test("a chunked body has no Content-Length, and reading stops at the cap instead of taking it all in", async () => {
    let produced = 0;
    const chunk = new Uint8Array(64 * 1024);
    const large = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= 32 * 1024 * 1024) return controller.close();
        produced += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const req = new Request("http://127.0.0.1/api/inbox/debug/log", { method: "POST", body: large, duplex: "half" } as RequestInit);
    expect(req.headers.has("content-length")).toBe(false);
    const answer = await createInboxDebugLog(log()).accept(req);
    expect(answer.status).toBe(413);
    expect(produced).toBeLessThan(INBOX_DEBUG_BODY_BYTES * 2);
  });

  test("a batch is written whole: rotation never splits it across the two files", async () => {
    const debug = createInboxDebugLog(log(), 1_000);
    const batch = (from: number) => new Request("http://127.0.0.1/api/inbox/debug/log", { method: "POST", body: JSON.stringify({ records: Array.from({ length: 8 }, (_, i) => ({ t: from + i, ev: "visibility" })) }) });
    await debug.accept(batch(100));
    await debug.accept(batch(200));
    await flushInboxDebugLogs();
    expect(lines(`${debug.path}.1`).map((line) => line.t)).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
    await flushInboxDebugLogs();
    expect(lines(debug.path).map((line) => line.t)).toEqual([200, 201, 202, 203, 204, 205, 206, 207]);
  });
});

describe("the log itself", () => {
  test("a request that never finishes shows a start with no end", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    const log = createInboxDebugLog(dir);
    const served = log.wrap(() => new Promise<Response>(() => {}), () => true);
    void served(new Request(`http://127.0.0.1/api/inbox/messages/${MSG}/reply`, { method: "POST", headers: { [INBOX_DEBUG_ID_HEADER]: REQUEST } }), "local");
    await flushInboxDebugLogs();
    expect(lines(log.path).map((line) => [line.id, line.ev])).toEqual([[REQUEST, "req_start"]]);
  });

  test("a method off the list logs as a fixed word: what a raw client sends as a method stays out of the file", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    const log = createInboxDebugLog(dir);
    const served = log.wrap(async () => new Response("ok"), () => true);
    const threads = "http://127.0.0.1/api/inbox/threads";
    // `new Request` turns an unknown token into GET, and Bun's server drops one today, so this one is built by hand.
    const anyToken = { url: threads, method: "ZEBRAQUARTZ", headers: new Headers() } as unknown as Request;
    await served(new Request(threads, { method: "PROPFIND" }), "local");
    await served(anyToken, "local");
    await served(new Request(threads, { method: "POST" }), "local");
    await flushInboxDebugLogs();
    const text = readFileSync(log.path, "utf8");
    expect(text).not.toContain("PROPFIND");
    expect(text).not.toContain("ZEBRAQUARTZ");
    await flushInboxDebugLogs();
    expect(lines(log.path).map((line) => line.method)).toEqual(["other", "other", "other", "other", "POST", "POST"]);
  });

  test("a request that fails shows it failed, and the same failure reaches the caller", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    const log = createInboxDebugLog(dir);
    const failure = new Error(WORDS);
    const served = log.wrap(() => Promise.reject(failure), () => true);
    expect(await served(new Request("http://127.0.0.1/api/inbox/threads"), "local").catch((cause: unknown) => cause)).toBe(failure);
    await flushInboxDebugLogs();
    expect(lines(log.path).map((line) => line.ev)).toEqual(["req_start", "req_error"]);
    await flushInboxDebugLogs();
    expect(readFileSync(log.path, "utf8")).not.toContain(WORDS);
  });

  test("the handler's own response comes back, and only one call reaches it", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    const answer = new Response("ok", { status: 201 });
    const calls: Request[] = [];
    const served = createInboxDebugLog(dir).wrap(async (req) => {
      calls.push(req);
      return answer;
    }, () => true);
    const req = new Request("http://127.0.0.1/api/inbox/threads");
    expect(await served(req, "local")).toBe(answer);
    expect(calls).toEqual([req]);
  });

  test("logging cannot fail a request: headers that cannot change, or an owner check that throws, still answer", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    const log = createInboxDebugLog(dir);
    const frozen = new Response("ok");
    frozen.headers.set = () => {
      throw new TypeError("immutable");
    };
    expect(await log.wrap(async () => frozen, () => true)(new Request("http://127.0.0.1/api/inbox/threads"), "local")).toBe(frozen);

    const plain = new Response("ok");
    const refused = log.wrap(async () => plain, () => {
      throw new Error("no identity");
    });
    expect(await refused(new Request("http://127.0.0.1/api/inbox/threads", { headers: { [INBOX_DEBUG_ID_HEADER]: REQUEST } }), "local")).toBe(plain);
    expect(plain.headers.has(INBOX_DEBUG_ON_HEADER)).toBe(false);
    await flushInboxDebugLogs();
    expect(lines(log.path).at(-1)!.id).not.toBe(REQUEST);
  });

  test("the cap holds: it rotates once, so there are never more than two files, each under the cap", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    const cap = 2_000;
    const log = createInboxDebugLog(dir, cap);
    const served = log.wrap(async () => new Response("ok"), () => true);
    for (let i = 0; i < 200; i += 1) await served(new Request("http://127.0.0.1/api/inbox/threads"), "local");
    await flushInboxDebugLogs();
    expect(readFileSync(log.path).length).toBeLessThanOrEqual(cap);
    await flushInboxDebugLogs();
    expect(readFileSync(`${log.path}.1`).length).toBeLessThanOrEqual(cap);
    await flushInboxDebugLogs();
    expect(existsSync(`${log.path}.2`)).toBe(false);
  });
});

describe("written off the request path", () => {
  test("every line lands, in order, across writes in flight and a rotation; the stop writes what is kept at once", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    const log = createInboxDebugLog(dir, 40_000);
    const served = log.wrap(async () => new Response("ok"), () => true);
    for (let i = 0; i < 300; i += 1) {
      await served(new Request("http://127.0.0.1/api/inbox/threads"), "local");
      if (i % 50 === 0) void log.flush();
      if (i % 7 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await log.flush();
    const ids = [...lines(`${log.path}.1`), ...lines(log.path)].filter((line) => line.ev === "req_end").map((line) => Number(String(line.id).slice(1)));
    expect(ids.at(-1)).toBe(300);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => 301 - ids.length + i));
    expect(existsSync(`${log.path}.2`)).toBe(false);

    log.note("store_load", { ms: 1 });
    log.close();
    expect(lines(log.path).at(-1)).toMatchObject({ ev: "store_load" });
  });
});

describe("a stop or an exit while a write is in flight", () => {
  const seqs = (path: string) => (existsSync(path) ? lines(path).map((line) => line.n) : []);

  test("every line lands once, in order, whatever stage the write in flight is at", async () => {
    for (let turns = 0; turns < 12; turns += 1) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
      roots.push(dir);
      const log = createInboxDebugLog(dir);
      let n = 0;
      const some = (count: number) => {
        for (let i = 0; i < count; i += 1) log.note("loop_stall", { n: n++ });
      };
      some(3);
      await log.flush();
      some(40);
      const inFlight = log.flush();
      for (let i = 0; i < turns; i += 1) await new Promise((resolve) => (i % 2 ? setTimeout(resolve, 0) : setImmediate(resolve)));
      some(5);
      log.close();
      expect({ turns, seqs: seqs(log.path) }).toEqual({ turns, seqs: Array.from({ length: n }, (_, i) => i) });
      await inFlight;
      await flushInboxDebugLogs();
      expect({ turns, seqs: seqs(log.path) }).toEqual({ turns, seqs: Array.from({ length: n }, (_, i) => i) });
      some(1);
      await log.flush();
      expect(seqs(log.path).at(-1)).toBe(n - 1);
    }
  });

  test("a process that exits right after (Ctrl-C, a restart), with a write in flight, still has every line", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    const script = join(dir, "exit.ts");
    writeFileSync(
      script,
      `import { createInboxDebugLog } from ${JSON.stringify(join(import.meta.dir, "inbox-debug-log.ts"))};
const mode = process.argv[2];
const log = createInboxDebugLog(process.argv[3]);
let n = 0;
for (let i = 0; i < 3; i += 1) log.note("loop_stall", { n: n++ });
await log.flush();
for (let i = 0; i < 50; i += 1) log.note("loop_stall", { n: n++ });
void log.flush();
for (let i = 0; i < 5; i += 1) log.note("loop_stall", { n: n++ });
if (mode === "stop") log.close();
process.exit(143);
`,
    );
    for (const mode of ["stop", "exit"]) {
      const logDir = join(dir, mode);
      const run = Bun.spawnSync([process.execPath, script, mode, logDir], { env: { PATH: process.env.PATH ?? "", HOME: dir, PLANNOTATOR_DATA_DIR: join(dir, "data"), NO_BROWSER: "1", PLANNOTATOR_TEST_SANDBOX: "1" }, stdout: "pipe", stderr: "pipe" });
      expect({ mode, code: run.exitCode }).toEqual({ mode, code: 143 });
      expect({ mode, seqs: seqs(join(logDir, "debug.log")) }).toEqual({ mode, seqs: Array.from({ length: 58 }, (_, i) => i) });
    }
  });

  test("lines not yet on disk are capped: a writer that never gets a turn keeps the first 4 MB, in order, then drops", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-debug-")));
    roots.push(dir);
    const log = createInboxDebugLog(dir, 64 * 1024 * 1024);
    const pad = "x".repeat(1000);
    const total = Math.ceil((12 * 1024 * 1024) / 1050);
    for (let n = 0; n < total; n += 1) log.note("loop_stall", { n, pad });
    await log.flush();
    const kept = lines(log.path).map((line) => line.n as number);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(total);
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => i));
    expect(readFileSync(log.path).byteLength).toBeLessThanOrEqual(INBOX_DEBUG_PENDING_MAX_BYTES);
    log.note("store_load", { ms: 1 });
    await log.flush();
    expect(lines(log.path).at(-1)).toMatchObject({ ev: "store_load" });
  });
});

describe("over the tailnet", () => {
  const MAGIC = "macbook-pro.tail0000.ts.net";
  const OWNER = "ramos@example.com";
  const GUEST = "guest@example.com";
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

  test("the owner's window is told and may write; an allow-listed guest gets in, is not told, cannot write and cannot name an id", async () => {
    const dataDir = world({ inboxTailscale: true, inboxTailscaleAllow: [GUEST] });
    const run = fakeTailscale();
    const server = await start(dataDir, { debug: true, tailscale: run });
    const listener = server.tailscale.listenerPort();
    if (listener === null) throw new Error("not published");
    const through = (path: string, login: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${listener}${path}`, { ...init, headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": login, ...(init.headers ?? {}) } });
    const records = { method: "POST", body: JSON.stringify({ records: [{ t: 1, ev: "page_load" }] }), headers: { "Content-Type": "application/json" } };

    const owner = await through("/api/inbox/threads", OWNER, { headers: { [INBOX_DEBUG_ID_HEADER]: REQUEST } });
    expect(owner.headers.get(INBOX_DEBUG_ON_HEADER)).toBe("1");
    expect((await through(INBOX_DEBUG_PATH, OWNER, records)).status).toBe(200);

    const guestId = `${PAGE}-2`;
    const guest = await through("/api/inbox/threads", GUEST, { headers: { [INBOX_DEBUG_ID_HEADER]: guestId } });
    expect(guest.status).toBe(200);
    expect(guest.headers.has(INBOX_DEBUG_ON_HEADER)).toBe(false);
    const refused = await through(INBOX_DEBUG_PATH, GUEST, records);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("owner_only");

    const stranger = await through(INBOX_DEBUG_PATH, "someone@example.com", records);
    expect(stranger.status).toBe(403);

    await flushInboxDebugLogs();
    const all = lines(logPath(dataDir));
    expect(all.filter((line) => line.side === "window")).toHaveLength(1);
    expect(all.filter((line) => line.id === REQUEST).map((line) => line.via)).toEqual(["tailnet", "tailnet"]);
    expect(all.some((line) => line.id === guestId)).toBe(false);
    expect(all.filter((line) => /^s\d+$/.test(String(line.id)) && line.route === "/api/inbox/threads")).toHaveLength(2);
  });
});
