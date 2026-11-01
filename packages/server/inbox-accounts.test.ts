/**
 * Settings → Accounts' read (inbox-accounts.ts) against a real Inbox with a
 * fake `cswap` (tests/helpers/fake-cswap.ts). The Inbox's whole PATH is the
 * fake's folder, so no test here can reach a real claude-swap: that one reads
 * and writes the Keychain. The fixtures are fake output of the real tool.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InboxAccountsRead } from "@plannotator/core/inbox-types";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { doorRouteNames } from "./inbox-devices";
import { createAgentEnvironmentFor, liveAgentRunCount } from "./inbox-agents";
import { fakeCswapCalls, fakeCswapTicks, writeFakeCswap, type FakeCswapAnswer } from "../../tests/helpers/fake-cswap";

const FIXTURES = resolve(import.meta.dir, "../../tests/fixtures/cswap");
const LIST = readFileSync(join(FIXTURES, "list.json"), "utf8");
const WINDOWS = JSON.parse(readFileSync(join(FIXTURES, "usage-windows.json"), "utf8")) as Record<string, unknown>;

const MAGIC = "macbook-pro.tail0000.ts.net";
const OWNER = "ramos@example.com";
const GUEST = "guest@example.com";

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

interface WorldOptions {
  /** Null: no `cswap` at all. */
  cswap?: FakeCswapAnswer | null;
  timeoutMs?: number;
  tailnet?: boolean;
}

async function world({ cswap = { stdout: LIST }, timeoutMs, tailnet }: WorldOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-accounts-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home);
  mkdirSync(bin);
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  if (tailnet) writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscaleAllow: [GUEST] }));
  if (cswap) writeFakeCswap(bin, cswap);
  const serve = new Map<number, string>();
  const run: TailscaleRunner = (args) => {
    const done = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return done(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
    if (args[1] === "status") {
      if (serve.size === 0) return done("{}");
      return done(JSON.stringify({ TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])), Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])) }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return done(`https://${MAGIC}:${httpsPort}/\n`);
  };
  const server = await startInboxServer({
    dataDir,
    binaryPath: null,
    phones: false,
    version: "dev",
    // The fake's folder and nothing else.
    agentEnvironment: createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: bin } }),
    accounts: { timeoutMs },
    ...(tailnet ? { tailscale: run, publishTailnet: true } : {}),
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const accounts = (init?: RequestInit) => fetch(`${base}/api/inbox/accounts`, init);
  const read = async () => {
    const answer = await accounts();
    expect(answer.status).toBe(200);
    return (await answer.json()) as InboxAccountsRead;
  };
  const through = (login: string) =>
    fetch(`http://127.0.0.1:${server.tailscale.listenerPort()!}/api/inbox/accounts`, {
      headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": login, Origin: `https://${MAGIC}:${server.port}` },
    });
  return { root, bin, dataDir, read, accounts, through };
}

function listed(read: InboxAccountsRead) {
  if (read.state !== "accounts") throw new Error(`expected accounts, got ${JSON.stringify(read)}`);
  return read.accounts;
}

/** `list --json` holding one account with this `usage`. */
const withUsage = (usage: unknown) => JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [{ number: 1, email: "a@fake.test", active: true, usageStatus: "ok", usage }] });

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test.skipIf(process.platform === "win32")("no cswap on PATH reads as not installed", async () => {
  const w = await world({ cswap: null });
  expect(readdirSync(w.bin)).toEqual([]);
  expect(await w.read()).toEqual({ state: "not_installed" });
});

describe.skipIf(process.platform === "win32")("the sample output", () => {
  test("runs `cswap list --json` and answers the named fields of each account", async () => {
    const w = await world();
    const read = await w.read();
    expect(fakeCswapCalls(w.bin)).toEqual(["list --json"]);
    expect(read).toEqual({
      state: "accounts",
      accounts: [
        {
          number: 1,
          alias: "personal",
          email: "a@fake.test",
          organizationName: "Fake a@fake.test",
          isOrganization: true,
          active: false,
          usageStatus: "unavailable",
          usageError: "network",
          usageRetryAt: "2026-11-01T12:48:33Z",
          usage: null,
        },
        {
          number: 2,
          alias: null,
          email: "b@fake.test",
          organizationName: "Fake b@fake.test",
          isOrganization: true,
          active: true,
          usageStatus: "unavailable",
          usageError: "network",
          usageRetryAt: "2026-11-01T12:48:33Z",
          usage: null,
        },
        // An API-key row never carries its placeholder address.
        { number: 3, alias: null, email: null, organizationName: null, isOrganization: false, active: false, usageStatus: "api_key", usageError: null, usageRetryAt: null, usage: null },
      ],
    });
  });

  test("a placeholder address is dropped whatever the row's status says", async () => {
    const stdout = JSON.stringify({ schemaVersion: 1, accounts: [{ number: 3, email: "api-key-3@token.local", usageStatus: "unavailable", usage: null }] });
    const w = await world({ cswap: { stdout } });
    expect(listed(await w.read())[0]!.email).toBeNull();
  });

  test("each usage shape keeps only the windows it reports; a missing one is null, never 0", async () => {
    const w = await world();
    const usageOf = async (shape: string) => {
      writeFakeCswap(w.bin, { stdout: withUsage(WINDOWS[shape]) });
      return listed(await w.read())[0]!.usage!;
    };
    const proMax = await usageOf("pro_max");
    expect(proMax.fiveHour).toEqual({ pct: 41, resetsAt: "2026-11-05T12:00:00+00:00", countdown: "3d 23h", clock: "Nov 5 12:00" });
    expect(proMax.sevenDay?.pct).toBe(58);
    expect(proMax.scoped).toEqual([]);

    const ultra = await usageOf("ultra_five_hour_null");
    expect(ultra.fiveHour).toBeNull();
    expect(ultra.scoped.map((window) => [window.name, window.pct])).toEqual([["Fable", 22]]);

    expect((await usageOf("ultra_five_hour_absent")).fiveHour).toBeNull();

    // The decided difference from the mock: 0% with no reset time is shown as reported.
    expect((await usageOf("hollow_five_hour")).fiveHour).toEqual({ pct: 0, resetsAt: null, countdown: null, clock: null });
  });

  test("a usage with no usable window is no reading", async () => {
    const w = await world({ cswap: { stdout: withUsage({ fiveHour: { pct: "41" }, sevenDay: {}, scoped: [{ pct: 12 }] }) } });
    expect(listed(await w.read())[0]!.usage).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("a failed read answers a fixed reason", () => {
  test("exit 1 with {error}: never its error text or stderr", async () => {
    const w = await world({
      cswap: { stdout: JSON.stringify({ schemaVersion: 1, error: { type: "CswapError", message: "stdout-words-of-cswap" } }), stderr: "stderr-words-of-cswap", exit: 1 },
    });
    const answer = await w.accounts();
    const text = await answer.text();
    expect(JSON.parse(text)).toEqual({ state: "failed", reason: "run_failed" });
    expect(text).not.toContain("words-of-cswap");
  });

  test.each([
    ["not JSON", "Traceback (most recent call last):"],
    ["cut off", LIST.slice(0, 80)],
    ["JSON that is not the list", '["a"]'],
    ["no schema version", JSON.stringify({ accounts: [] })],
    ["no accounts", JSON.stringify({ schemaVersion: 1 })],
    ["a row with no number", JSON.stringify({ schemaVersion: 1, accounts: [{ email: "a@fake.test" }] })],
  ])("garbage on stdout (%s)", async (_, stdout) => {
    const w = await world({ cswap: { stdout } });
    expect(await w.read()).toEqual({ state: "failed", reason: "bad_output" });
  });

  test("a schemaVersion this build doesn't know, however readable the rest", async () => {
    const stdout = JSON.stringify({ ...JSON.parse(LIST), schemaVersion: 2 });
    const w = await world({ cswap: { stdout } });
    expect(await w.read()).toEqual({ state: "failed", reason: "unknown_schema" });
  });

  test("a cswap that hangs is killed at the timeout, its children too, and the answer says so", async () => {
    const w = await world({ cswap: { hang: true }, timeoutMs: 300 });
    const started = Date.now();
    expect(await w.read()).toEqual({ state: "failed", reason: "timed_out" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(liveAgentRunCount()).toBe(0);
    // Killed: it stops ticking.
    await Bun.sleep(120);
    const ticks = fakeCswapTicks(w.bin);
    expect(ticks).toBeGreaterThan(0);
    await Bun.sleep(200);
    expect(fakeCswapTicks(w.bin)).toBe(ticks);
  });

  test("the Inbox stopping ends a read still going", async () => {
    const w = await world({ cswap: { hang: true } });
    const reading = w.read();
    for (let i = 0; i < 100 && fakeCswapCalls(w.bin).length === 0; i++) await Bun.sleep(20);
    servers.splice(0)[0]!.stop();
    await reading.catch(() => {});
    expect(liveAgentRunCount()).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("one read at a time", () => {
  test("two reads at once run cswap once and get the same answer; the next read runs it again", async () => {
    const w = await world({ cswap: { stdout: LIST, delay: 0.3 } });
    const [first, second] = await Promise.all([w.read(), w.read()]);
    expect(fakeCswapCalls(w.bin)).toHaveLength(1);
    expect(second).toEqual(first);
    expect(listed(first)).toHaveLength(3);
    await w.read();
    expect(fakeCswapCalls(w.bin)).toHaveLength(2);
  });

  test("opening an Inbox runs nothing: only a read does", async () => {
    const w = await world();
    await fetch(`http://127.0.0.1:${servers[0]!.port}/api/inbox/settings`);
    await Bun.sleep(100);
    expect(fakeCswapCalls(w.bin)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("who may read", () => {
  test("a tailnet guest gets 403 owner_only and starts nothing; the owner reads", async () => {
    const w = await world({ tailnet: true });
    const refused = await w.through(GUEST);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("owner_only");
    expect(fakeCswapCalls(w.bin)).toEqual([]);
    const owner = await w.through(OWNER);
    expect(owner.status).toBe(200);
    expect(listed((await owner.json()) as InboxAccountsRead)).toHaveLength(3);
  });

  test("another site gets nothing and starts nothing", async () => {
    const w = await world();
    for (const headers of [{ Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
      const refused = await w.accounts({ headers });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("cross_origin");
    }
    expect(fakeCswapCalls(w.bin)).toEqual([]);
  });

  test("only GET", async () => {
    const w = await world();
    expect((await w.accounts({ method: "POST", body: "{}" })).status).toBe(405);
    expect(fakeCswapCalls(w.bin)).toEqual([]);
  });

  test("it is not on the device door", () => {
    expect(doorRouteNames().filter((route) => /accounts/.test(route))).toEqual([]);
  });
});

test.skipIf(process.platform === "win32")("a field cswap adds never leaves it: not in the answer, the logs or the data dir", async () => {
  const TOKEN = "sk-ant-oat01-never-shown-4f2a";
  const list = JSON.parse(LIST) as { accounts: Record<string, unknown>[] };
  const row = list.accounts[0]!;
  row.accessToken = TOKEN;
  row.usage = { ...(WINDOWS.pro_max as object), accessToken: TOKEN, fiveHour: { pct: 41, accessToken: TOKEN }, scoped: [{ name: "Fable", pct: 22, accessToken: TOKEN }] };
  const stdout = JSON.stringify({ ...list, accessToken: TOKEN });

  const logged: string[] = [];
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug, out: process.stdout.write, err: process.stderr.write };
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  console.log = console.info = console.warn = console.error = console.debug = capture;
  const captureStream = (chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  };
  process.stdout.write = captureStream as typeof process.stdout.write;
  process.stderr.write = captureStream as typeof process.stderr.write;
  try {
    const w = await world({ cswap: { stdout, stderr: `token ${TOKEN}` } });
    const text = await (await w.accounts()).text();
    expect(listed(JSON.parse(text) as InboxAccountsRead)).toHaveLength(3);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("accessToken");
    expect(text).not.toContain("organizationUuid");
    const files = filesUnder(w.dataDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => readFileSync(file, "latin1").includes(TOKEN))).toEqual([]);
  } finally {
    Object.assign(console, { log: saved.log, info: saved.info, warn: saved.warn, error: saved.error, debug: saved.debug });
    process.stdout.write = saved.out;
    process.stderr.write = saved.err;
  }
  expect(logged.filter((line) => line.includes(TOKEN))).toEqual([]);
});
