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
import type { InboxAccountsRead, InboxMachineAccountsRead } from "@plannotator/core/inbox-types";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxAccounts, createInboxAccountsFor, INBOX_ACCOUNTS_TIMEOUT_MS, INBOX_MACHINE_ACCOUNTS_MAX_BYTES, INBOX_MACHINE_ACCOUNTS_WAIT_MS } from "./inbox-accounts";
import { createAgentEnvironmentFor, liveAgentRunCount } from "./inbox-agents";
import { PEER_LINK_TIMINGS } from "./inbox-peer-link";
import { fakeCswapCalls, fakeCswapFinished, fakeCswapTicks, writeFakeCswap, type FakeCswapAnswer } from "../../tests/helpers/fake-cswap";
import { waitFor } from "../../tests/helpers/inbox-world";

const FIXTURES = resolve(import.meta.dir, "../../tests/fixtures/cswap");
const LIST = readFileSync(join(FIXTURES, "list.json"), "utf8");
const STALE = readFileSync(join(FIXTURES, "stale.json"), "utf8");
const WINDOWS = JSON.parse(readFileSync(join(FIXTURES, "usage-windows.json"), "utf8")) as Record<string, unknown>;

const MAGIC = "macbook-pro.tail0000.ts.net";
const OWNER = "ramos@example.com";
const GUEST = "guest@example.com";
const FAR = "ibx_01K00000000000000000000002";

const roots: string[] = [];
const servers: InboxServer[] = [];
const doors: ReturnType<typeof Bun.serve>[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const door of doors.splice(0)) door.stop(true);
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
  phones?: boolean;
  /** How long the link waits for any answer. */
  requestMs?: number;
  /** How long a read of a linked machine waits. */
  accountsMs?: number;
  /** A stand-in for another Inbox's door, linked here. */
  linkedTo?: string;
}

async function world({ cswap = { stdout: LIST }, timeoutMs, hardLimitMs, cacheMs = 0, tailnet, phones = false, requestMs, accountsMs, linkedTo }: WorldOptions = {}) {
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
  if (linkedTo) {
    const link = { id: FAR, name: "Mini", token: "tok_x", transport: { kind: "tailnet", url: linkedTo }, device_id: null, linked_at: "2026-11-01T00:00:00Z" };
    mkdirSync(join(dataDir, "inbox"));
    writeFileSync(join(dataDir, "inbox", "machines.json"), JSON.stringify({ v: 1, self: { id: "ibx_01K00000000000000000000001" }, links: [link] }), { mode: 0o600 });
  }
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
    phones,
    version: "dev",
    // The fake's folder and nothing else.
    agentEnvironment: createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: bin } }),
    accounts: { timeoutMs, hardLimitMs, cacheMs },
    machineLinkTimings: { ...(requestMs ? { requestMs } : {}), ...(accountsMs ? { accountsMs } : {}) },
    // Linked or not, nothing here may run the real `tailscale`.
    tailscale: run,
    ...(tailnet ? { publishTailnet: true } : {}),
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
  /** A linked machine's read, as the window asks for it. */
  const readOf = async (machine: string, query = "") => {
    const answer = await fetch(`${base}/api/inbox/accounts/${machine}${query}`);
    expect(answer.status).toBe(200);
    return (await answer.json()) as InboxMachineAccountsRead;
  };
  return { root, bin, dataDir, base, read, readOf, accounts, through, settings };
}

/** `from` links one way to `to` over its door, as `plannotator inbox link --one-way` does. Answers `to`'s id. */
async function link(from: { base: string }, to: { base: string }): Promise<string> {
  const offered = (await (await fetch(`${to.base}/api/inbox/machines/offer`, { method: "POST", body: "{}" })).json()) as { link: string; machine: { id: string } };
  const linked = await fetch(`${from.base}/api/inbox/machines/link`, { method: "POST", body: JSON.stringify({ link: offered.link, address: to.base, one_way: true }) });
  expect(linked.status).toBe(201);
  return offered.machine.id;
}

/** The token `from` holds for the machine it linked to. */
const machineToken = (from: { dataDir: string }) => (JSON.parse(readFileSync(join(from.dataDir, "inbox", "machines.json"), "utf8")) as { links: { token: string }[] }).links[0]!.token;

/** Another Inbox's door, played: `accounts` is the test's, and the line stays up. */
function standInDoor(accounts: (request: Request) => Response | Promise<Response>, machineLinks = 1, health: () => Response | null = () => null) {
  const door = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const route = new URL(req.url).pathname.replace("/api/inbox/device/", "");
      if (route === "health") return health() ?? Response.json({ ok: true, inbox_id: FAR, machine_links: machineLinks, version: "0.28.40" });
      if (route === "events") return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":0}\n\n`)) }), { headers: { "Content-Type": "text/event-stream" } });
      if (route === "threads") return Response.json({ cursor: 0, sections: [], projects: [] });
      if (route === "accounts") return accounts(req);
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  });
  doors.push(door);
  return `http://127.0.0.1:${door.port}`;
}

async function onlineMachine(w: { base: string }) {
  await waitFor("the line to the other machine", async () => {
    const { machines } = (await (await fetch(`${w.base}/api/inbox/machines`)).json()) as { machines: { self: boolean; state: string }[] };
    return machines.find((machine) => !machine.self)?.state === "online";
  });
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

  test("an answer serves every read inside its time, a Refresh's too, so cswap never starts twice in it", async () => {
    const w = await world({ cacheMs: 1_000 });
    const first = await w.read();
    writeFakeCswap(w.bin, { stdout: withUsage({ fiveHour: { pct: 12 } }) });
    for (const query of ["", "?fresh=1", "", "?fresh=1", "?fresh=1"]) expect(await w.read(query)).toEqual(first);
    expect(fakeCswapCalls(w.bin)).toHaveLength(1);
    await Bun.sleep(1_050);
    expect(await w.read("?fresh=1")).not.toEqual(first);
    expect(fakeCswapCalls(w.bin)).toHaveLength(2);
  });

  test("a good answer stops serving when its time is up", async () => {
    const w = await world({ cacheMs: 50 });
    await w.read();
    await Bun.sleep(80);
    await w.read();
    expect(fakeCswapCalls(w.bin)).toHaveLength(2);
  });

  test("a failure serves as long as an answer, so a broken cswap runs once however often a window opens; the next good run replaces it", async () => {
    const w = await world({ cacheMs: 1_000, cswap: { stdout: "Traceback" } });
    for (const query of ["", "", "?fresh=1", "", "?fresh=1"]) expect(await w.read(query)).toEqual({ state: "failed", reason: "bad_output" });
    expect(fakeCswapCalls(w.bin)).toHaveLength(1);
    writeFakeCswap(w.bin, { stdout: JSON.stringify({ schemaVersion: 1, error: { type: "CswapError", message: "no" } }), exit: 1 });
    await Bun.sleep(1_050);
    for (const query of ["", "?fresh=1", ""]) expect(await w.read(query)).toEqual({ state: "failed", reason: "run_failed" });
    expect(fakeCswapCalls(w.bin)).toHaveLength(2);
    writeFakeCswap(w.bin, { stdout: LIST });
    await Bun.sleep(1_050);
    expect(listed(await w.read())).toHaveLength(3);
  });

  test("Refresh counts from the last run's start: a slow run does not push the next one back by its length", async () => {
    const w = await world({ cacheMs: 600, cswap: { stdout: LIST, delay: 0.4 } });
    await w.read();
    await Bun.sleep(300);
    await w.read("?fresh=1");
    expect(fakeCswapCalls(w.bin)).toHaveLength(2);
  });

  test("cswap gone shows at once, over whatever is kept: finding that out runs nothing", async () => {
    const w = await world({ cacheMs: 60_000 });
    await w.read();
    rmSync(join(w.bin, "cswap"));
    expect(await w.read()).toEqual({ state: "not_installed" });
    expect(await w.read("?fresh=1")).toEqual({ state: "not_installed" });
    expect(fakeCswapCalls(w.bin)).toHaveLength(1);
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

  test("a phone's token doesn't reach it: on the door it is a machine's read alone (the relay's half: inbox-devices.test.ts)", async () => {
    const w = await world({ phones: true });
    const made = (await (await fetch(`${w.base}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as { offer: { code: string } };
    const paired = await fetch(`${w.base}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) });
    const { token } = (await paired.json()) as { token: string };
    const refused = await fetch(`${w.base}/api/inbox/device/accounts`, { headers: { Authorization: `Bearer ${token}` } });
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { code: string }).code).toBe("device_route_not_found");
    expect(fakeCswapCalls(w.bin)).toEqual([]);
  });

  test("the owner's phone browser reads what the desktop reads, this machine and a linked one", async () => {
    const far = await world();
    const near = await world({ tailnet: true });
    const machine = await link(near, far);
    await onlineMachine(near);
    for (const path of ["/api/inbox/accounts", `/api/inbox/accounts/${machine}`]) {
      const desktop = (await (await fetch(`${near.base}${path}`)).json()) as InboxAccountsRead;
      const phone = await near.through(OWNER, path);
      expect(phone.status).toBe(200);
      expect(listed(desktop)).toHaveLength(3);
      expect((await phone.json()) as InboxAccountsRead).toEqual(desktop);
    }
  });
});

test.skipIf(process.platform === "win32")("the test folder for cswap and the test cache are heard only in a sandbox, so no release can be pointed at another cswap", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-accounts-")));
  roots.push(root);
  const onPath = join(root, "path");
  const named = join(root, "named");
  mkdirSync(onPath);
  mkdirSync(named);
  writeFakeCswap(onPath, { stdout: LIST });
  writeFakeCswap(named, { stdout: LIST });
  const environment = createAgentEnvironmentFor({ platform: process.platform, homeDir: root, env: { HOME: root, PATH: onPath } });
  const knobs = { PLANNOTATOR_TEST_CSWAP_DIR: named, PLANNOTATOR_TEST_ACCOUNTS_CACHE_MS: "0" };
  const threeReads = async (env: Record<string, string | undefined>) => {
    const accounts = createInboxAccountsFor(environment, {}, env);
    for (let i = 0; i < 3; i++) await accounts.read();
  };

  await threeReads(knobs);
  await threeReads({ ...knobs, PLANNOTATOR_TEST_SANDBOX: "" });
  expect(fakeCswapCalls(onPath)).toHaveLength(2);
  expect(fakeCswapCalls(named)).toEqual([]);

  await threeReads({ ...knobs, PLANNOTATOR_TEST_SANDBOX: root });
  expect(fakeCswapCalls(named)).toHaveLength(3);
  expect(fakeCswapCalls(onPath)).toHaveLength(2);
});

test.skipIf(process.platform === "win32")("a clock set back does not hold up a read: a kept answer from the future is no answer", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-accounts-")));
  roots.push(root);
  writeFakeCswap(root, { stdout: LIST });
  const accounts = createInboxAccounts({ environment: createAgentEnvironmentFor({ platform: process.platform, homeDir: root, env: { HOME: root, PATH: root } }) });
  const realNow = Date.now;
  let hoursBack = 0;
  Date.now = () => realNow() - hoursBack * 3_600_000;
  try {
    await accounts.read();
    expect(fakeCswapCalls(root)).toHaveLength(1);
    hoursBack = 1;
    await accounts.read({ fresh: true });
    expect(fakeCswapCalls(root)).toHaveLength(2);
    hoursBack = 2;
    await accounts.read();
    expect(fakeCswapCalls(root)).toHaveLength(3);
    // The floor holds on the new time.
    await accounts.read({ fresh: true });
    expect(fakeCswapCalls(root)).toHaveLength(3);
  } finally {
    Date.now = realNow;
  }
});

describe.skipIf(process.platform === "win32")("a linked machine's accounts, through its door", () => {
  test("its read, its one run and its kept answer, whatever a far caller sends; what `cswap` adds never crosses", async () => {
    const list = JSON.parse(LIST) as { accounts: Record<string, unknown>[] };
    list.accounts[0]!.accessToken = "sk-ant-oat01-never-shown-4f2a";
    const far = await world({ cswap: { stdout: JSON.stringify(list) }, cacheMs: 60_000 });
    const near = await world({ cswap: null });
    const machine = await link(near, far);
    const read = await near.readOf(machine);
    expect(listed(read as InboxAccountsRead).map((account) => account.email)).toEqual(["a@fake.test", "b@fake.test", null]);
    expect(JSON.stringify(read)).not.toContain("sk-ant");
    expect(fakeCswapCalls(far.bin)).toEqual(["list --json"]);
    for (const query of ["", "?fresh=1", "?fresh=1", "?fresh=1&fresh=1"]) await near.readOf(machine, query);
    const headers = { Authorization: `Bearer ${machineToken(near)}` };
    expect((await fetch(`${far.base}/api/inbox/device/accounts?fresh=1`, { headers })).status).toBe(200);
    expect(fakeCswapCalls(far.bin)).toHaveLength(1);
  });

  test("a far run slower than the far limit comes back as its own timed_out, past the link's usual limit; the next read gets its answer", async () => {
    // The limits below are this test's: these are the ones that ship.
    expect(INBOX_MACHINE_ACCOUNTS_WAIT_MS).toBeGreaterThan(INBOX_ACCOUNTS_TIMEOUT_MS);
    const far = await world({ cswap: { stdout: LIST, delay: 1.2 }, timeoutMs: 600, cacheMs: 60_000 });
    const near = await world({ cswap: null, requestMs: 300, accountsMs: 1_500 });
    const machine = await link(near, far);
    await onlineMachine(near);
    expect(await near.readOf(machine)).toEqual({ state: "failed", reason: "timed_out" });
    await waitFor("the far run to end", () => fakeCswapFinished(far.bin) === 1);
    expect(listed((await near.readOf(machine)) as InboxAccountsRead)).toHaveLength(3);
    expect(fakeCswapCalls(far.bin)).toHaveLength(1);
  });

  test("no address reaches either machine's disk, and nothing is polled", async () => {
    const far = await world();
    const near = await world({ cswap: null });
    const machine = await link(near, far);
    await onlineMachine(near);
    expect(fakeCswapCalls(far.bin)).toEqual([]);
    expect(JSON.stringify(await near.readOf(machine))).toContain("a@fake.test");
    for (const file of [...filesUnder(near.dataDir), ...filesUnder(far.dataDir)]) expect(readFileSync(file, "utf8")).not.toContain("@fake.test");
    await Bun.sleep(300);
    expect(fakeCswapCalls(far.bin)).toHaveLength(1);
  });

  test("a machine without cswap says so, as this one would", async () => {
    const far = await world({ cswap: null });
    const near = await world();
    expect(await near.readOf(await link(near, far))).toEqual({ state: "not_installed" });
  });

  test("a machine that is gone is offline, at once, and this machine's read goes on", async () => {
    const far = await world();
    const near = await world();
    const machine = await link(near, far);
    await onlineMachine(near);
    servers.find((server) => server.port === Number(new URL(far.base).port))!.stop();
    await waitFor("the line to drop", async () => {
      const { machines } = (await (await fetch(`${near.base}/api/inbox/machines`)).json()) as { machines: { self: boolean; state: string }[] };
      return machines.find((m) => !m.self)?.state === "offline";
    });
    const started = Date.now();
    expect(await near.readOf(machine)).toEqual({ state: "offline" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(listed(await near.read())).toHaveLength(3);
  });

  test("a hung door holds up only itself, whether it stalls before its answer or inside it, and is not asleep while its line stays up", async () => {
    // Past the line's own silence limit, so a machine truly asleep has lost its line by the end of the wait.
    expect(INBOX_MACHINE_ACCOUNTS_WAIT_MS).toBeGreaterThan(PEER_LINK_TIMINGS.silenceMs);
    const stalled = [
      () => new Promise<Response>(() => {}),
      () => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"state":')) }), { headers: { "Content-Type": "application/json" } }),
    ];
    for (const answer of stalled) {
      const near = await world({ linkedTo: standInDoor(answer), accountsMs: 300 });
      await onlineMachine(near);
      const reading = near.readOf(FAR);
      expect(listed(await near.read())).toHaveLength(3);
      expect(await reading).toEqual({ state: "unreachable" });
    }
  });

  // A flood that outlived the cap would run to the wait, so the wait is short: this fails on a figure, not on the machine's memory.
  for (const status of [200, 401]) {
    test(`a far answer past the cap is a failed read, a ${status} too: its door's stream stops there, and nothing past the cap is read`, async () => {
      let sent = 0;
      let stopped = false;
      const chunk = new Uint8Array(64 * 1024).fill(32);
      const flood = () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              sent += chunk.length;
              controller.enqueue(chunk);
            },
            cancel() {
              stopped = true;
            },
          }),
          { status },
        );
      const near = await world({ linkedTo: standInDoor(flood), accountsMs: 1_000 });
      await onlineMachine(near);
      expect(await near.readOf(FAR)).toEqual({ state: "failed", reason: "bad_output" });
      await waitFor("the door's stream to stop", () => stopped);
      expect(sent).toBeLessThan(INBOX_MACHINE_ACCOUNTS_MAX_BYTES * 4);
    });
  }

  test("a far side that revokes this link is never asleep: it says so once, and then it is not linked", async () => {
    let revoked = false;
    const refused = () => Response.json({ code: "device_revoked" }, { status: 401 });
    const near = await world({ linkedTo: standInDoor(() => (revoked ? refused() : Response.json({ state: "not_installed" })), 1, () => (revoked ? refused() : null)) });
    await onlineMachine(near);
    revoked = true;
    expect(await near.readOf(FAR)).toEqual({ state: "unreachable" });
    await waitFor("the link to go", async () => (await fetch(`${near.base}/api/inbox/accounts/${FAR}`)).status === 404);
  });

  test("a real answer's size is well inside the cap, and a field no real answer has is dropped by name", async () => {
    expect(LIST.length * 50).toBeLessThan(INBOX_MACHINE_ACCOUNTS_MAX_BYTES);
    const near = await world({ linkedTo: standInDoor(() => Response.json({ state: "accounts", accounts: [{ number: 1, alias: "x".repeat(5_000), email: "a@fake.test", usageStatus: "ok", active: true }] })) });
    await onlineMachine(near);
    const [row] = listed((await near.readOf(FAR)) as InboxAccountsRead);
    expect(row!.alias).toBeNull();
    expect(row!.email).toBe("a@fake.test");
  });

  test("a far answer's rows stop at 200, far past any real list, so a hostile one can't slow this window", async () => {
    const accounts = Array.from({ length: 5_000 }, (_, i) => ({ number: i + 1, email: `a${i}@fake.test`, usageStatus: "ok" }));
    const near = await world({ linkedTo: standInDoor(() => Response.json({ state: "accounts", accounts })) });
    await onlineMachine(near);
    const rows = listed((await near.readOf(FAR)) as InboxAccountsRead);
    expect(rows).toHaveLength(200);
    expect(rows[0]!.email).toBe("a0@fake.test");
  });

  test("a far side that does not know the route, an older Plannotator, reads as needing an update, with its link still up; so does one too old to link", async () => {
    const older = await world({ linkedTo: standInDoor(() => Response.json({ error: "Not a phone route.", code: "device_route_not_found" }, { status: 404 })) });
    await onlineMachine(older);
    expect(await older.readOf(FAR)).toEqual({ state: "needs_update" });
    const { machines } = (await (await fetch(`${older.base}/api/inbox/machines`)).json()) as { machines: { self: boolean; state: string }[] };
    expect(machines.find((m) => !m.self)?.state).toBe("online");

    const tooOld = await world({ linkedTo: standInDoor(() => Response.json({ state: "not_installed" }), 0) });
    await waitFor("the line to read its version", async () => {
      const { machines } = (await (await fetch(`${tooOld.base}/api/inbox/machines`)).json()) as { machines: { self: boolean; state: string }[] };
      return machines.find((m) => !m.self)?.state === "needs_update";
    });
    expect(await tooOld.readOf(FAR)).toEqual({ state: "needs_update" });
  });

  test("whatever a far door sends: named fields only, a fixed failure; only silence is offline", async () => {
    let sends: () => Response = () => new Response();
    const near = await world({ linkedTo: standInDoor(() => sends()) });
    await onlineMachine(near);

    sends = () =>
      Response.json({
        state: "accounts",
        raw: "kept out",
        accounts: [{ number: 1, email: "a@fake.test", active: true, usageStatus: "ok", accessToken: "sk-ant-x", usage: { accessToken: "sk-ant-x", fiveHour: { pct: 92, accessToken: "sk-ant-x" } } }],
      });
    const read = await near.readOf(FAR);
    expect(listed(read as InboxAccountsRead)[0]!.usage!.fiveHour!.pct).toBe(92);
    expect(JSON.stringify(read)).not.toMatch(/sk-ant|kept out/);

    sends = () => Response.json({ state: "failed", reason: "a sentence from the other side" });
    expect(await near.readOf(FAR)).toEqual({ state: "failed", reason: "run_failed" });

    // A machine that answers is awake. A shape this build can't read is a version apart, however the rows came.
    for (const answer of [() => Response.json({ state: "accounts", accounts: [{ number: 1 }, { number: "one" }] }), () => Response.json({ state: "a newer state" })]) {
      sends = answer;
      expect(await near.readOf(FAR)).toEqual({ state: "needs_update" });
    }
    // Anything else it says is no answer to this read.
    for (const status of [401, 403, 404, 500, 502]) {
      sends = () => Response.json({ error: "no" }, { status });
      expect(await near.readOf(FAR)).toEqual({ state: "unreachable" });
    }
    sends = () => new Response("<html>");
    expect(await near.readOf(FAR)).toEqual({ state: "unreachable" });
  });

  test("a machine that is not linked is 404", async () => {
    const w = await world();
    expect((await fetch(`${w.base}/api/inbox/accounts/${FAR}`)).status).toBe(404);
  });

  test("a tailnet guest gets nothing on any path, and starts nothing on the far machine; the owner reads it from a phone's browser", async () => {
    const far = await world();
    const near = await world({ tailnet: true, cswap: null });
    const machine = await link(near, far);
    await onlineMachine(near);
    const direct = await near.through(GUEST, `/api/inbox/accounts/${machine}`);
    expect(direct.status).toBe(403);
    expect(((await direct.json()) as { code: string }).code).toBe("owner_only");
    expect((await near.through(GUEST, `/api/inbox/accounts/${machine}?fresh=1`)).status).toBe(403);
    // The forward passes whatever the far door allows: that way there is no route at all, for anyone.
    for (const route of ["accounts", "accounts?fresh=1", "acc%6Funts", "%61ccounts"]) {
      for (const login of [GUEST, OWNER]) {
        const forwarded = await near.through(login, `/api/inbox/m/${machine}/${route}`);
        expect(forwarded.status).toBe(404);
        expect(await forwarded.text()).not.toContain("@fake.test");
      }
    }
    expect(fakeCswapCalls(far.bin)).toEqual([]);

    const owner = await near.through(OWNER, `/api/inbox/accounts/${machine}`);
    expect(owner.status).toBe(200);
    expect(listed((await owner.json()) as InboxAccountsRead)).toHaveLength(3);
  });

  test("another site gets nothing of a linked machine, and only GET", async () => {
    const far = await world();
    const near = await world({ cswap: null });
    const machine = await link(near, far);
    await onlineMachine(near);
    const refused = await fetch(`${near.base}/api/inbox/accounts/${machine}`, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(refused.status).toBe(403);
    expect((await fetch(`${near.base}/api/inbox/accounts/${machine}`, { method: "POST", body: "{}" })).status).toBe(405);
    expect(fakeCswapCalls(far.bin)).toEqual([]);
  });

  test("a machine's token reads that machine's own accounts only, never a third's", async () => {
    const third = await world();
    const middle = await world();
    const near = await world({ cswap: null });
    const thirdId = await link(middle, third);
    await link(near, middle);
    const headers = { Authorization: `Bearer ${machineToken(near)}` };
    const own = await fetch(`${middle.base}/api/inbox/device/accounts?machine=${thirdId}`, { headers });
    expect(own.status).toBe(200);
    expect(fakeCswapCalls(middle.bin)).toHaveLength(1);
    expect((await fetch(`${middle.base}/api/inbox/device/accounts/${thirdId}`, { headers })).status).toBe(404);
    expect((await fetch(`${middle.base}/api/inbox/device/m/${thirdId}/accounts`, { headers })).status).toBe(404);
    expect(fakeCswapCalls(third.bin)).toEqual([]);
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
