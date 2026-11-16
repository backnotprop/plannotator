/**
 * `plannotator plans`, in process with its Inbox and browser faked, on a scratch data dir. What regresses if these
 * fail:
 * - `plans` does not turn Plans on and open the Inbox's Plans page, or refuses where no terminal is attached;
 * - `plans off` does not turn it off (or starts anything);
 * - while off, another `plans …` does more than print one line naming `plannotator plans` and exit 1;
 * - `plans list` writes anything, starts the Inbox, or prints other than the library holds.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlanStore } from "@plannotator/shared/plans/store";
import { PLANS_COMMAND_USAGE, PLANS_OFF_TEXT, runPlansCommand, type PlansCommandDeps } from "./plans-command";

let dataDir = "";
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "plans-command-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

const INBOX = { url: "http://localhost:4100/", port: 4100 };

function cli(overrides: Partial<PlansCommandDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls = { ensure: 0, opened: [] as string[], running: 0 };
  const deps: PlansCommandDeps = {
    dataDir,
    ensureInbox: async () => {
      calls.ensure++;
      return INBOX;
    },
    openUrl: async (url) => {
      calls.opened.push(url);
      return "opened";
    },
    runningInbox: async () => {
      calls.running++;
      return null;
    },
    fetch: (async () => {
      throw new Error("no fetch expected");
    }) as unknown as typeof fetch,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...overrides,
  };
  return { run: (...argv: string[]) => runPlansCommand(argv, deps), out, err, calls };
}

const inboxPlans = () => (existsSync(join(dataDir, "config.json")) ? JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxPlans : undefined);

describe("plannotator plans", () => {
  test("off: every other plans command prints one line naming `plannotator plans`, exits 1, starts nothing", async () => {
    for (const argv of [["list"], ["--help"], ["open"], ["off", "now"]]) {
      const { run, out, err, calls } = cli();
      expect(await run(...argv)).toBe(1);
      expect([out, err]).toEqual([[], [PLANS_OFF_TEXT]]);
      expect(calls).toEqual({ ensure: 0, opened: [], running: 0 });
    }
    expect(PLANS_OFF_TEXT).toContain("`plannotator plans`");
    expect(readdirSync(dataDir)).toEqual([]);
  });

  test("bare: on, the Inbox started or found, its Plans page opened and printed", async () => {
    const { run, out, err, calls } = cli();
    expect(await run()).toBe(0);
    expect(inboxPlans()).toBe(true);
    expect(calls.ensure).toBe(1);
    expect(calls.opened).toEqual(["http://localhost:4100/#plans"]);
    expect(out).toEqual(["http://localhost:4100/#plans"]);
    expect(err).toEqual(["Plans is on."]);
  });

  test("bare, with no terminal attached (an IDE's task runner, a wrapper): no gate, it turns on and opens the same", async () => {
    const saved = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    try {
      const { run, out, calls } = cli();
      expect(await run()).toBe(0);
      expect(inboxPlans()).toBe(true);
      expect(calls.opened).toEqual(["http://localhost:4100/#plans"]);
      expect(out).toEqual(["http://localhost:4100/#plans"]);
    } finally {
      if (saved) Object.defineProperty(process.stdin, "isTTY", saved);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  test("bare, remote: no browser, the Inbox's hint; an Inbox that cannot start says why", async () => {
    const remote = cli({ openUrl: async () => "remote", remoteHint: (port) => `forward ${port}` });
    expect(await remote.run()).toBe(0);
    expect(remote.err).toEqual(["Plans is on.", "forward 4100"]);
    const broken = cli({ ensureInbox: async () => Promise.reject(new Error("The Plannotator Inbox did not start.")) });
    expect(await broken.run()).toBe(1);
    expect(broken.err).toEqual(["Plans is on.", "The Plannotator Inbox did not start."]);
    expect(broken.out).toEqual([]);
  });

  test("off turns it off and starts nothing; the library stays", async () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxPlans: true }));
    createPlanStore({ dataDir }).createPlan({ name: "Kept", created_at: "2026-11-01T09:00:00.000Z", document: { title: "Kept" } });
    const { run, out, calls } = cli();
    expect(await run("off")).toBe(0);
    expect(out).toEqual(["Plans is off."]);
    expect(inboxPlans()).toBe(false);
    expect(calls).toEqual({ ensure: 0, opened: [], running: 0 });
    expect(existsSync(join(dataDir, "plan-library", "index.jsonl"))).toBe(true);
  });

  test("on: list reads the library on disk when no Inbox runs, writes nothing, and says when it is empty", async () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxPlans: true }));
    const empty = cli();
    expect(await empty.run("list")).toBe(0);
    expect(empty.out).toEqual(["No plans yet."]);
    expect(readdirSync(dataDir)).toEqual(["config.json"]);

    const store = createPlanStore({ dataDir });
    const { plan, document } = store.createPlan({ name: "Auth refactor", project_name: "api", created_at: "2026-11-01T09:00:00.000Z", document: { title: "Auth refactor" } });
    store.addVersion(plan.id, document.id, { bytes: new TextEncoder().encode("# Auth refactor"), committed_at: "2026-11-02T09:00:00.000Z", source: "plan-review" });
    const full = cli();
    expect(await full.run("list")).toBe(0);
    expect(full.out).toEqual([`${plan.id}  2026-11-02  api  v1  no decision  Auth refactor`]);
    expect(full.calls.ensure).toBe(0);
  });

  test("on: list asks the running Inbox, waiting out its import", async () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxPlans: true }));
    const asked: string[] = [];
    const plan = { id: "pln_01JCZZZZZZZZZZZZZZZZZZZZZZ", name: "From the Inbox", project_name: null, head_version_number: 2, updated_at: "2026-11-03T09:00:00.000Z", decision: { decision: "approved", version_number: 2, at: "x" }, changed: true, seen_version_number: 1 };
    const answers = [{ plans: [], importing: true }, { plans: [plan], importing: false }];
    const { run, out, calls } = cli({
      runningInbox: async () => INBOX,
      fetch: (async (url: string) => {
        asked.push(url);
        return Response.json(answers.shift());
      }) as unknown as typeof fetch,
    });
    expect(await run("list")).toBe(0);
    expect(asked).toEqual(["http://localhost:4100/api/plans", "http://localhost:4100/api/plans"]);
    expect(out).toEqual([`${plan.id}  2026-11-03  -  v2  approved v2 · changed, you saw v1  From the Inbox`]);
    expect(calls.ensure).toBe(0);
  });

  test("on: --help is the usage line; anything else is a usage error", async () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxPlans: true }));
    const help = cli();
    expect(await help.run("--help")).toBe(0);
    expect(help.out).toEqual([PLANS_COMMAND_USAGE]);
    const wrong = cli();
    expect(await wrong.run("publish")).toBe(2);
    expect(wrong.err).toEqual([PLANS_COMMAND_USAGE]);
  });
});
