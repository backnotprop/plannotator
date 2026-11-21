/**
 * The switch's own code, without an Inbox: `parseCswapSwitch`, `switchTarget`
 * and `createInboxAccounts().switchTo` against a fake `cswap`
 * (tests/helpers/fake-cswap.ts) on a PATH of only its folder, with a temp
 * HOME. These run whether or not INBOX_ACCOUNT_SWITCHING is on, so the code it
 * gates stays proven while the route is off. The route itself, and every
 * guard in front of it, is packages/server/inbox-accounts.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInboxAccounts, parseCswapSwitch, switchTarget } from "./inbox-accounts";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { fakeCswapCalls, writeFakeCswap, type FakeCswapAnswer, type FakeCswapSwitch } from "../../tests/helpers/fake-cswap";

const FIXTURES = resolve(import.meta.dir, "../../tests/fixtures/cswap");
const LIST = readFileSync(join(FIXTURES, "list.json"), "utf8");
const SWITCH_OK = readFileSync(join(FIXTURES, "switch-ok.json"), "utf8");
const SWITCH_ERROR = readFileSync(join(FIXTURES, "switch-error.json"), "utf8");
/** Account 1 of the sample, as the window showed it. */
const PERSONAL = { number: 1, email: "a@fake.test", organizationName: "Fake a@fake.test", alias: "personal" };
/** The sample's API key: no address, no alias. */
const KEY = { number: 3, email: null, organizationName: null, alias: null };

const switchOut = (fields: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, switched: true, to: { number: 1, email: "a@fake.test" }, reason: "switched", ...fields });

describe("parseCswapSwitch", () => {
  test("the number asked for, under the address the list gave it: switched, and nothing else passes", () => {
    expect(parseCswapSwitch(SWITCH_OK, 1, "a@fake.test")).toEqual({ state: "switched", number: 1 });
    expect(parseCswapSwitch(switchOut({ switched: false, reason: "already-active" }), 1, "a@fake.test")).toEqual({ state: "switched", number: 1 });
  });

  test.each([
    ["not JSON", "Traceback (most recent call last):", "bad_output"],
    ["an error object", SWITCH_ERROR, "bad_output"],
    ["no `to`", JSON.stringify({ schemaVersion: 1, switched: true }), "bad_output"],
    ["a `to` with no whole number", switchOut({ to: { number: "1" } }), "bad_output"],
    ["no `switched`", JSON.stringify({ schemaVersion: 1, to: { number: 1 } }), "bad_output"],
    ["a schemaVersion this build doesn't know", switchOut({ schemaVersion: 2 }), "unknown_schema"],
    ["another account than the one asked for", switchOut({ to: { number: 3, email: "a@fake.test" } }), "run_failed"],
    ["no switch, for another reason", switchOut({ switched: false, reason: "no-valid-target" }), "run_failed"],
    ["the number asked for under another address", switchOut({ to: { number: 1, email: "api-key-3@token.local" } }), "renumbered"],
  ])("%s is a failure, never a switch", (_, stdout, reason) => {
    expect(parseCswapSwitch(stdout, 1, "a@fake.test")).toEqual({ state: "failed", reason } as never);
  });

  test("an API key matches on its placeholder, which never passes on", () => {
    const answer = parseCswapSwitch(switchOut({ to: { number: 3, email: "api-key-3@token.local" } }), 3, "api-key-3@token.local");
    expect(answer).toEqual({ state: "switched", number: 3 });
    expect(JSON.stringify(answer)).not.toContain("@");
  });
});

describe("switchTarget", () => {
  test("picks the four fields by name; an empty text is null; an alias may be left out", () => {
    expect(switchTarget({ ...PERSONAL, extra: "dropped" })).toEqual(PERSONAL);
    expect(switchTarget({ number: 3, email: "", organizationName: "", alias: "" })).toEqual(KEY);
    expect(switchTarget({ number: 0, email: null, organizationName: null })).toEqual({ number: 0, email: null, organizationName: null, alias: null });
  });

  test.each([
    ["no number", {}],
    ["a number as text", { number: "1", email: null, organizationName: null }],
    ["a fraction", { number: 1.5, email: null, organizationName: null }],
    ["a negative number", { number: -1, email: null, organizationName: null }],
    ["an unsafe integer", { number: 2 ** 60, email: null, organizationName: null }],
    ["an address that is no text", { number: 1, email: 7, organizationName: null }],
    ["an address left out", { number: 1, organizationName: null }],
    ["an overlong address", { number: 1, email: "x".repeat(2_000), organizationName: null }],
    ["an alias that is no text", { number: 1, email: null, organizationName: null, alias: 5 }],
  ])("%s is no target", (_, body) => {
    expect(switchTarget(body as Record<string, unknown>)).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("createInboxAccounts().switchTo, with a fake cswap", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A fake `cswap` alone on PATH, a temp HOME, and nothing kept between reads. */
  function accountsWith(list: FakeCswapAnswer | null, change?: FakeCswapSwitch, timeoutMs?: number) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-accounts-switch-")));
    roots.push(root);
    const bin = join(root, "bin");
    if (list) writeFakeCswap(bin, list, change);
    const environment = createAgentEnvironmentFor({ platform: process.platform, homeDir: root, env: { HOME: root, PATH: bin } });
    return { bin, accounts: createInboxAccounts({ environment, cacheMs: 0, ...(timeoutMs ? { timeoutMs } : {}) }) };
  }
  const inUse = async (accounts: ReturnType<typeof createInboxAccounts>) => {
    const read = await accounts.read();
    return read.state === "accounts" ? read.accounts.find((account) => account.active)?.number : read.state;
  };

  test("matches a new list, runs `cswap switch <n> --json`, answers the number, and the next read shows it in use", async () => {
    const after = JSON.stringify({ ...JSON.parse(LIST), accounts: (JSON.parse(LIST) as { accounts: { number: number }[] }).accounts.map((row) => ({ ...row, active: row.number === 1 })) });
    const { bin, accounts } = accountsWith({ stdout: LIST }, { stdout: SWITCH_OK, listAfter: after });
    expect(await accounts.switchTo(PERSONAL)).toEqual({ state: "switched", number: 1 });
    expect(fakeCswapCalls(bin)).toEqual(["list --json", "switch 1 --json"]);
    expect(await inUse(accounts)).toBe(1);
  });

  test("the login in use switches nothing; a login no longer under that number switches nothing", async () => {
    const { bin, accounts } = accountsWith({ stdout: LIST }, { stdout: SWITCH_OK });
    expect(await accounts.switchTo({ number: 2, email: "b@fake.test", organizationName: "Fake b@fake.test", alias: null })).toEqual({ state: "switched", number: 2 });
    for (const target of [{ ...PERSONAL, email: "b@fake.test" }, { ...PERSONAL, alias: null }, { ...PERSONAL, number: 9 }, { ...KEY, alias: "build" }]) {
      expect(await accounts.switchTo(target)).toEqual({ state: "failed", reason: "changed" });
    }
    expect(fakeCswapCalls(bin).filter((call) => call.startsWith("switch"))).toEqual([]);
  });

  test("a failed switch is a fixed code, never cswap's words", async () => {
    const { accounts } = accountsWith({ stdout: LIST }, { stdout: SWITCH_ERROR, stderr: "words-of-cswap", exit: 1 });
    const answer = await accounts.switchTo(PERSONAL);
    expect(answer).toEqual({ state: "failed", reason: "run_failed" });
    expect(JSON.stringify(answer)).not.toContain("words-of-cswap");
    expect(await inUse(accounts)).toBe(2);
  });

  test("a list that fails before the switch is the answer, and nothing switches; no cswap is not installed", async () => {
    const broken = accountsWith({ stdout: "garbage" }, { stdout: SWITCH_OK });
    expect(await broken.accounts.switchTo(PERSONAL)).toEqual({ state: "failed", reason: "bad_output" });
    expect(fakeCswapCalls(broken.bin)).toEqual(["list --json"]);
    expect(await accountsWith(null).accounts.switchTo(PERSONAL)).toEqual({ state: "not_installed" });
  });

  test("one switch at a time: a second while one runs is busy and runs nothing", async () => {
    const { bin, accounts } = accountsWith({ stdout: LIST }, { stdout: SWITCH_OK, delay: 0.4 });
    const first = accounts.switchTo(PERSONAL);
    expect(await accounts.switchTo(KEY)).toEqual({ state: "failed", reason: "busy" });
    expect(await first).toEqual({ state: "switched", number: 1 });
    expect(fakeCswapCalls(bin).filter((call) => call.startsWith("switch"))).toEqual(["switch 1 --json"]);
  });

  test("a slow switch answers timed_out at the wait, and is not killed: it finishes", async () => {
    const { bin, accounts } = accountsWith({ stdout: LIST }, { stdout: SWITCH_OK, delay: 0.8 }, 300);
    expect(await accounts.switchTo(PERSONAL)).toEqual({ state: "failed", reason: "timed_out" });
    // Past the wait it goes on, and ends by itself.
    const ended = () => readFileSync(join(bin, "events.log"), "utf8").includes("end switch 1 --json");
    for (let i = 0; i < 60 && !ended(); i++) await Bun.sleep(50);
    expect(ended()).toBe(true);
    expect(await inUse(accounts)).toBe(2);
  });
});
