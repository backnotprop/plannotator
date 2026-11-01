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
import { fakeCswapCalls, fakeCswapFinished, fakeCswapTicks, writeFakeCswap, type FakeCswapAnswer } from "../../tests/helpers/fake-cswap";

const FIXTURES = resolve(import.meta.dir, "../../tests/fixtures/cswap");
const LIST = readFileSync(join(FIXTURES, "list.json"), "utf8");
const STALE = readFileSync(join(FIXTURES, "stale.json"), "utf8");
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
  hardLimitMs?: number;
  /** 0 unless a test is about the kept answer: the others change the fake between reads. */
  cacheMs?: number;
  tailnet?: boolean;
}

async function world({ cswap = { stdout: LIST }, timeoutMs, hardLimitMs, cacheMs = 0, tailnet }: WorldOptions = {}) {
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
    accounts: { timeoutMs, hardLimitMs, cacheMs },
    ...(tailnet ? { tailscale: run, publishTailnet: true } : {}),
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const accounts = (init?: RequestInit) => fetch(`${base}/api/inbox/accounts`, init);
  const read = async (query = "") => {
    const answer = await fetch(`${base}/api/inbox/accounts${query}`);
    expect(answer.status).toBe(200);
    return (await answer.json()) as InboxAccountsRead;
  };
  const through = (login: string, path = "/api/inbox/accounts") =>
    fetch(`http://127.0.0.1:${server.tailscale.listenerPort()!}${path}`, {
      headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": login, Origin: `https://${MAGIC}:${server.port}` },
    });
  const settings = async () => (await (await fetch(`${base}/api/inbox/settings`)).json()) as { cswap: boolean };
  return { root, bin, dataDir, read, accounts, through, settings };
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
          usageAgeSeconds: null,
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
          usageAgeSeconds: null,
        },
        // An API-key row never carries its placeholder address.
        { number: 3, alias: null, email: null, organizationName: null, isOrganization: false, active: false, usageStatus: "api_key", usageError: null, usageRetryAt: null, usage: null, usageAgeSeconds: null },
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
    expect(proMax.fiveHour).toEqual({ pct: 41, resetsAt: "2099-11-05T12:00:00+00:00", countdown: "3d 23h", clock: "Nov 5 12:00" });
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

  test("an old reading: its age passes by name, and a window past its reset reads as not reported", async () => {
    const w = await world({ cswap: { stdout: STALE } });
    const [old, fresh] = listed(await w.read());
    expect(old!.usageAgeSeconds).toBe(7320);
    expect(old!.usage!.fiveHour).toBeNull();
    expect(old!.usage!.sevenDay?.pct).toBe(92);
    expect(fresh!.usageAgeSeconds).toBe(120);
    expect(fresh!.usage!.fiveHour?.pct).toBe(94);
    expect(JSON.stringify(old)).not.toContain("usageFetchedAt");
  });

  test("every window past its reset is no reading; a reset time that isn't one keeps its window", async () => {
    const gone = { pct: 80, resetsAt: "2020-01-01T00:00:00Z" };
    const w = await world({ cswap: { stdout: withUsage({ fiveHour: gone, sevenDay: gone, scoped: [{ ...gone, name: "Fable" }] }) } });
    expect(listed(await w.read())[0]!.usage).toBeNull();
    writeFakeCswap(w.bin, { stdout: withUsage({ fiveHour: { pct: 80, resetsAt: "soon" } }) });
    expect(listed(await w.read())[0]!.usage!.fiveHour?.pct).toBe(80);
  });

  test.each([["a word", "old"], ["below zero", -1]])("an age that is not one is no age (%s)", async (_, usageAgeSeconds) => {
    const stdout = JSON.stringify({ schemaVersion: 1, accounts: [{ number: 1, usageStatus: "ok", usage: null, usageAgeSeconds }] });
    const w = await world({ cswap: { stdout } });
    expect(listed(await w.read())[0]!.usageAgeSeconds).toBeNull();
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

  test("exit 127 is the shell's command not found: a shim whose tool is gone reads as not installed", async () => {
    const w = await world({ cswap: { stderr: "bad interpreter", exit: 127 } });
    expect(await w.read()).toEqual({ state: "not_installed" });
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

  test("output over the 64 KiB cap is cut, and cut JSON reads as bad output", async () => {
    const stdout = JSON.stringify({ schemaVersion: 1, accounts: [{ number: 1, usageStatus: "ok", usage: null, extra: "x".repeat(70 * 1024) }] });
    const w = await world({ cswap: { stdout } });
    expect(await w.read()).toEqual({ state: "failed", reason: "bad_output" });
  });
});

/**
 * `cswap list --json` can spend a one-time refresh token and write the new one
 * back, so a run killed partway can lose a login. The limits here are short;
 * the shipped ones are 20 s to answer and 2 minutes to kill.
 */
describe.skipIf(process.platform === "win32")("a cswap run is never stopped for being slow", () => {
  const untilFinished = async (bin: string, runs: number) => {
    for (let i = 0; i < 200 && fakeCswapFinished(bin) < runs; i++) await Bun.sleep(20);
    return fakeCswapFinished(bin);
  };

  test("a slow run answers timed_out at the limit, goes on to finish, and a Refresh joins it instead of starting another", async () => {
    const w = await world({ cswap: { stdout: LIST, delay: 1.4 }, timeoutMs: 1_000 });
    expect(await w.read()).toEqual({ state: "failed", reason: "timed_out" });
    // Still running: not finished, and only the one run.
    expect(fakeCswapFinished(w.bin)).toBe(0);
    expect(fakeCswapCalls(w.bin)).toHaveLength(1);
    // The Refresh gets the answer of the run already going.
    expect(listed(await w.read())).toHaveLength(3);
    expect(fakeCswapFinished(w.bin)).toBe(1);
    expect(fakeCswapCalls(w.bin)).toHaveLength(1);
    // Only once it has really ended does a read run it again.
    writeFakeCswap(w.bin, { stdout: LIST });
    await w.read();
    expect(fakeCswapCalls(w.bin)).toHaveLength(2);
  });

  test("a run truly stuck is killed only at the hard limit, its children too, and until then nothing starts", async () => {
    const started = Date.now();
    const w = await world({ cswap: { hang: true }, timeoutMs: 100, hardLimitMs: 1_500 });
    expect(await w.read()).toEqual({ state: "failed", reason: "timed_out" });
    // Answered, and still alive: it keeps ticking.
    for (let i = 0; i < 100 && fakeCswapTicks(w.bin) === 0; i++) await Bun.sleep(20);
    const ticking = fakeCswapTicks(w.bin);
    expect(ticking).toBeGreaterThan(0);
    await Bun.sleep(150);
    expect(fakeCswapTicks(w.bin)).toBeGreaterThan(ticking);
    expect(await w.read()).toEqual({ state: "failed", reason: "timed_out" });
    expect(fakeCswapCalls(w.bin)).toHaveLength(1);
    // Past the hard limit: killed, so it stops ticking, and a read may run again.
    await Bun.sleep(Math.max(0, 2_000 - (Date.now() - started)));
    const last = fakeCswapTicks(w.bin);
    await Bun.sleep(200);
    expect(fakeCswapTicks(w.bin)).toBe(last);
    writeFakeCswap(w.bin, { stdout: LIST });
    await w.read();
    expect(await untilFinished(w.bin, 1)).toBe(1);
    expect(fakeCswapCalls(w.bin)).toHaveLength(2);
  });

  test("the Inbox stopping leaves a run to finish", async () => {
    const w = await world({ cswap: { stdout: LIST, delay: 0.5 } });
    const reading = w.read();
    for (let i = 0; i < 100 && fakeCswapCalls(w.bin).length === 0; i++) await Bun.sleep(20);
    expect(liveAgentRunCount()).toBe(0);
    servers.splice(0)[0]!.stop();
    await reading.catch(() => {});
    expect(await untilFinished(w.bin, 1)).toBe(1);
  });

  test("a process with a run going ends by itself, and the run still finishes", async () => {
    const w = await world({ cswap: { stdout: LIST, delay: 1 } });
    const agents = resolve(import.meta.dir, "inbox-agents.ts");
    // Nothing here calls exit: this process ends once the run has started, or the check below that the run is unfinished fails.
    const script = `import { existsSync } from "node:fs";
import { runUntilExit } from ${JSON.stringify(agents)};
void runUntilExit([${JSON.stringify(join(w.bin, "cswap"))}, "list", "--json"], {}, 60000);
const started = setInterval(() => { if (existsSync(${JSON.stringify(join(w.bin, "calls.log"))})) clearInterval(started); }, 10);`;
    const exited = await Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore", env: { ...process.env, PATH: w.bin } }).exited;
    expect(exited).toBe(0);
    expect(fakeCswapCalls(w.bin)).toHaveLength(1);
    expect(fakeCswapFinished(w.bin)).toBe(0);
    expect(await untilFinished(w.bin, 1)).toBe(1);
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

  test("a good answer serves the reads after it, and fresh=1 runs again", async () => {
    const w = await world({ cacheMs: 60_000 });
    const first = await w.read();
    writeFakeCswap(w.bin, { stdout: withUsage({ fiveHour: { pct: 12 } }) });
    expect(await w.read()).toEqual(first);
    expect(fakeCswapCalls(w.bin)).toHaveLength(1);
    expect(await w.read("?fresh=1")).not.toEqual(first);
    expect(fakeCswapCalls(w.bin)).toHaveLength(2);
    expect(listed(await w.read())).toHaveLength(1);
    expect(fakeCswapCalls(w.bin)).toHaveLength(2);
  });

  test("a good answer stops serving when its time is up", async () => {
    const w = await world({ cacheMs: 50 });
    await w.read();
    await Bun.sleep(80);
    await w.read();
    expect(fakeCswapCalls(w.bin)).toHaveLength(2);
  });

  test("a failure and not installed are never kept, and drop the good answer, so a change shows at once", async () => {
    const w = await world({ cacheMs: 60_000, cswap: { stdout: "Traceback" } });
    await w.read();
    await w.read();
    expect(fakeCswapCalls(w.bin)).toHaveLength(2);

    writeFakeCswap(w.bin, { stdout: LIST });
    expect(listed(await w.read())).toHaveLength(3);
    rmSync(join(w.bin, "cswap"));
    expect(await w.read("?fresh=1")).toEqual({ state: "not_installed" });
    expect(await w.read()).toEqual({ state: "not_installed" });
  });

  test("settings say whether cswap is on PATH and run nothing, so opening an Inbox does not", async () => {
    const w = await world();
    expect((await w.settings()).cswap).toBe(true);
    await Bun.sleep(100);
    expect(fakeCswapCalls(w.bin)).toEqual([]);
    rmSync(join(w.bin, "cswap"));
    expect((await w.settings()).cswap).toBe(false);
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

  test("settings tell a tailnet guest cswap is not here; the owner is told it is", async () => {
    const w = await world({ tailnet: true });
    const asked = async (login: string) => ((await (await w.through(login, "/api/inbox/settings")).json()) as { cswap: boolean }).cswap;
    expect(await asked(GUEST)).toBe(false);
    expect(await asked(OWNER)).toBe(true);
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
