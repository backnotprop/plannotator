/**
 * @plannotator/dsh's `plannotator` tool and `/plannotator-*` commands against
 * a fake DeepSeek Harness host and a fake `plannotator` CLI
 * (fixtures/fake-cli.ts, which opens no port and no browser). DSH is never
 * installed or run; each test has its own scratch data dir.
 *
 * Run: bun test apps/dsh-plugin/tool.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import type { PlannotatorConfig } from "../../packages/shared/config";
import type { DshInboxAgent, DshToolDefinition } from "./inbox";
import type { DshUserMessage } from "./plan-review";
import { applyPlannotator } from "./plugin";
import { dshDecision } from "./reviews";
import { DSH_COMMANDS, type DshCommandDefinition } from "./tool";

const FAKE_CLI = join(import.meta.dir, "fixtures", "fake-cli.ts");
const roots: string[] = [];
const unloads: (() => void)[] = [];

afterEach(() => {
  for (const unload of unloads.splice(0)) unload();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-dsh-tool-"));
  roots.push(dir);
  return dir;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

class FakeAgent implements DshInboxAgent {
  status = "idle";
  readonly followups: string[] = [];
  readonly session: { header: { id: string; cwd: string; parentSession?: string; origin?: string } };
  constructor(readonly id: string, cwd: string, header: { parentSession?: string; origin?: string } = {}) {
    this.session = { header: { id, cwd, ...header } };
  }
  followup(message: DshUserMessage): void {
    this.followups.push(message.content[0]!.text);
  }
}

interface FakeCall {
  subcommand: string;
  args: string[];
  pid: number;
  cwd: string;
  env: Record<string, string | undefined>;
}

function readCalls(logDir: string): FakeCall[] {
  const path = join(logDir, "calls.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as FakeCall) : [];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A fake DSH process with one project, the services the plugin uses, and the plugin loaded into it. */
function loadPlugin(options: {
  config?: PlannotatorConfig;
  env?: NodeJS.ProcessEnv;
  profile?: string;
  mode?: "fail" | "hang" | "late-fail" | "crash";
  /** The CLI ignores SIGTERM: only SIGKILL stops it. */
  ignoreTerm?: boolean;
  readyWaitMs?: { review: number; other: number };
} = {}) {
  const root = scratch();
  const dataDir = join(root, "data");
  const logDir = join(root, "log");
  const project = join(root, "project");
  for (const dir of [dataDir, logDir, project]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, "notes.md"), "# Notes\n");
  const agents = new Map<string, FakeAgent>();
  const tools: DshToolDefinition[] = [];
  const commands: DshCommandDefinition[] = [];
  const effects: (() => void)[] = [];
  const warnings: string[] = [];
  const services: Record<string, unknown> = {
    agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] },
    tools: { register: (definition: DshToolDefinition) => void tools.push(definition) },
    commands: { register: (definition: DshCommandDefinition) => void commands.push(definition) },
    profileContext: { name: options.profile ?? "web", home: join(root, "dsh-home") },
  };
  const ctx = {
    on: () => () => true,
    get: (name: string) => services[name],
    effect: (execute: () => () => void) => void effects.push(execute()),
    inject: (_deps: string[], callback: (child: unknown) => unknown) => void callback(ctx),
    logger: { warn: (...args: unknown[]) => void warnings.push(args.join(" ")), info: () => {} },
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_UPDATE_CHECK: "0",
    NO_ANON_PING: "1",
    FAKE_CLI_LOG_DIR: logDir,
    ...(options.mode && { FAKE_CLI_MODE: options.mode }),
    ...(options.ignoreTerm && { FAKE_CLI_IGNORE_TERM: "1" }),
    ...options.env,
  };
  void applyPlannotator(ctx as never, undefined, {
    env,
    dataDir,
    native: {
      config: options.config ?? {},
      command: [process.execPath, FAKE_CLI],
      pollMs: 20,
      ...(options.readyWaitMs && { readyWaitMs: options.readyWaitMs }),
    },
  });
  const unload = () => {
    for (const dispose of effects.splice(0)) dispose();
  };
  // Unloading stops every child the plugin still owns (SIGTERM, then SIGKILL).
  unloads.push(unload);
  if (options.ignoreTerm) {
    // A broken SIGKILL path must fail the test, not leave this test's own SIGTERM-proof children running.
    unloads.push(() => {
      for (const call of readCalls(logDir)) if (alive(call.pid)) process.kill(call.pid, "SIGKILL");
    });
  }
  const add = (agent: FakeAgent) => {
    agents.set(agent.id, agent);
    return agent;
  };
  return {
    project,
    dataDir,
    tools,
    commands,
    warnings,
    root,
    add,
    unload,
    calls: () => readCalls(logDir),
    decide: (id: string, record: Record<string, unknown>) => writeFileSync(join(logDir, `decide-${id}.json`), JSON.stringify({ v: 1, ...record })),
    /** Review folders still on disk. */
    folders: () => (existsSync(join(dataDir, "dsh")) ? readdirSync(join(dataDir, "dsh")) : []),
    tool: (name: string) => tools.find((tool) => tool.name === name),
    command: (name: string) => commands.find((command) => command.name === name),
  };
}

const sessionOf = (text: string) => /Session: (pn-[0-9a-f]{6})/.exec(text)?.[1] as string;

describe("the plannotator tool switch", () => {
  // The failure: DSH sends every tool's definition with each request, so a
  // tool that turns itself on costs every session tokens the owner did not agree to.
  // (plannotator_inbox's own default off is guarded in inbox.test.ts.)
  test("off by default: the plannotator tool is not registered; the commands are", () => {
    const dsh = loadPlugin();
    expect(dsh.tools.map((tool) => tool.name)).toEqual([]);
    expect(dsh.commands.map((command) => command.name).sort()).toEqual([DSH_COMMANDS.annotate, DSH_COMMANDS.last, DSH_COMMANDS.review]);
  });

  test("on with config agentTool or PLANNOTATOR_AGENT_TOOL=1; PLANNOTATOR_AGENT_TOOL=0 wins over the config", () => {
    expect(loadPlugin({ config: { agentTool: true } }).tool("plannotator")).toBeDefined();
    expect(loadPlugin({ env: { PLANNOTATOR_AGENT_TOOL: "1" } }).tool("plannotator")).toBeDefined();
    expect(loadPlugin({ config: { agentTool: true }, env: { PLANNOTATOR_AGENT_TOOL: "0" } }).tool("plannotator")).toBeUndefined();
  });

  test("an acp profile (a client that did not ask for turns of ours) gets neither the tool nor the commands", () => {
    const dsh = loadPlugin({ config: { agentTool: true }, profile: "acp" });
    expect(dsh.tools).toEqual([]);
    expect(dsh.commands).toEqual([]);
  });
});

describe("non-blocking reviews", () => {
  test("the tool returns while the CLI still waits for the person; the decision arrives as a followup to the session that owns it", async () => {
    const dsh = loadPlugin({ config: { agentTool: true } });
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    const other = dsh.add(new FakeAgent("session-other", dsh.project));
    const sub = dsh.add(new FakeAgent("session-sub", dsh.project, { parentSession: "session-main", origin: "subagent" }));

    // The fake CLI never exits until the test decides: a tool that waited for it would hang here.
    const result = (await dsh.tool("plannotator")!.execute({ action: "annotate", target: "notes.md" }, { agent: sub })) as { text: string };
    const id = sessionOf(result.text);
    expect(result.text).toContain("Opened notes.md in Plannotator: http://localhost:9/");
    expect(result.text).toContain("End your turn now");
    expect(main.followups).toEqual([]);
    expect(dsh.folders()).toEqual([id]);

    // The CLI ran as DSH, for the top-level session (a subagent's review belongs to the session it works for).
    const [call] = dsh.calls();
    expect(call!.subcommand).toBe("annotate");
    expect(call!.args).toEqual(["notes.md"]);
    expect(call!.env).toMatchObject({ PLANNOTATOR_ORIGIN: "dsh", DSH_SESSION_ID: "session-main", PLANNOTATOR_SESSION_TAG: "dsh:session-main", PLANNOTATOR_HOST_REVIEW_ID: id });

    dsh.decide(id, { surface: "annotate", decision: "annotated", message: "Fix the intro.", noop: false, annotationCount: 2 });
    await until(() => main.followups.length > 0);
    expect(main.followups).toHaveLength(1);
    expect(main.followups[0]).toStartWith(`Plannotator: notes.md (${id}) — Feedback · 2 comments.`);
    expect(main.followups[0]).toContain("Fix the intro.");
    expect(other.followups).toEqual([]);
    expect(sub.followups).toEqual([]);
    await until(() => dsh.folders().length === 0);
  }, 15_000);

  test("/plannotator-last runs annotate-last for the receiving session, with DSH's home, and returns before the decision", async () => {
    const dsh = loadPlugin();
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    const answer = await dsh.command(DSH_COMMANDS.last)!.handler({ agent: main, rawInput: "" });
    expect(answer.kind).toBe("success");
    const [call] = dsh.calls();
    expect(call!.subcommand).toBe("annotate-last");
    expect(call!.env.DSH_SESSION_ID).toBe("session-main");
    expect(call!.env.DSH_HOME).toEndWith("dsh-home");
    expect(main.followups).toEqual([]);
  }, 15_000);

  test("close stops the review and nothing is sent to the session afterwards", async () => {
    const dsh = loadPlugin({ config: { agentTool: true } });
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    const tool = dsh.tool("plannotator")!;
    const opened = (await tool.execute({ action: "review" }, { agent: main })) as { text: string };
    const id = sessionOf(opened.text);
    expect(((await tool.execute({ action: "list" }, { agent: main })) as { text: string }).text).toContain(`${id} · review · local changes`);
    const closed = (await tool.execute({ action: "close", session: id }, { agent: main })) as { text: string };
    expect(closed.text).toContain(`Closed local changes (${id})`);
    await until(() => dsh.folders().length === 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(main.followups).toEqual([]);
    expect(((await tool.execute({ action: "list" }, { agent: main })) as { text: string }).text).toBe("No open Plannotator reviews from this conversation.");
  }, 15_000);
});

describe("whose review it is", () => {
  // The failure: a subagent working in its own folder (a worktree) has the parent's folder reviewed instead.
  test("a subagent's review runs in the subagent's folder; its decision still goes to the top-level session", async () => {
    const dsh = loadPlugin({ config: { agentTool: true } });
    const worktree = join(dsh.root, "worktree");
    mkdirSync(worktree);
    writeFileSync(join(worktree, "notes.md"), "# Worktree notes\n");
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    const sub = dsh.add(new FakeAgent("session-sub", worktree, { parentSession: "session-main", origin: "subagent" }));
    const opened = (await dsh.tool("plannotator")!.execute({ action: "annotate", target: "notes.md" }, { agent: sub })) as { text: string };
    const [call] = dsh.calls();
    expect(realpathSync(call!.cwd)).toBe(realpathSync(worktree));
    expect(call!.env.DSH_SESSION_ID).toBe("session-main");
    dsh.decide(sessionOf(opened.text), { surface: "annotate", decision: "annotated", message: "Shorter.", noop: false, annotationCount: 1 });
    await until(() => main.followups.length > 0);
    expect(sub.followups).toEqual([]);
  }, 15_000);

  // The failure: one session lists, or closes, a review another session is waiting on.
  test("another session can neither list nor close a review", async () => {
    const dsh = loadPlugin({ config: { agentTool: true } });
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    const other = dsh.add(new FakeAgent("session-other", dsh.project));
    const tool = dsh.tool("plannotator")!;
    const text = async (agent: FakeAgent, args: Record<string, unknown>) => ((await tool.execute(args, { agent })) as { text: string }).text;
    const id = sessionOf(await text(main, { action: "annotate", target: "notes.md" }));
    expect(await text(other, { action: "list" })).toBe("No open Plannotator reviews from this conversation.");
    expect(await text(other, { action: "close", session: id })).toContain(`No open Plannotator review ${id} from this conversation.`);
    expect(await text(other, { action: "close", session: "all" })).toBe("No open Plannotator reviews from this conversation to close.");
    expect(alive(dsh.calls()[0]!.pid)).toBe(true);
    expect(await text(main, { action: "list" })).toContain(id);
  }, 15_000);
});

describe("stopping a review", () => {
  // The failure: a cancelled call leaves a CLI running that nobody owns (it ignored SIGTERM), or the call
  // settles while its child still runs.
  test("cancelling the call while the page is starting stops the child (SIGKILL when SIGTERM is ignored) before the call settles", async () => {
    const dsh = loadPlugin({ config: { agentTool: true }, mode: "hang", ignoreTerm: true });
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    const cancel = new AbortController();
    const call = dsh.tool("plannotator")!.execute({ action: "annotate", target: "notes.md" }, { agent: main, signal: cancel.signal });
    await until(() => dsh.calls().length === 1);
    cancel.abort(new Error("turn cancelled"));
    await expect(call).rejects.toThrow("turn cancelled");
    expect(alive(dsh.calls()[0]!.pid)).toBe(false);
    expect(main.followups).toEqual([]);
  }, 15_000);

  // The failure: a plugin reload or DSH quitting leaves review servers running with nothing to deliver to.
  test("unloading the plugin stops an open review (SIGKILL when SIGTERM is ignored) and sends nothing", async () => {
    const dsh = loadPlugin({ config: { agentTool: true }, ignoreTerm: true });
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    await dsh.tool("plannotator")!.execute({ action: "annotate", target: "notes.md" }, { agent: main });
    const { pid } = dsh.calls()[0]!;
    dsh.unload();
    await until(() => !alive(pid));
    await until(() => dsh.folders().length === 0);
    expect(main.followups).toEqual([]);
  }, 15_000);

  // The failure: a review whose page never comes up cannot be closed, and lists as "starting" forever.
  test("close stops a review still starting", async () => {
    const dsh = loadPlugin({ config: { agentTool: true }, mode: "hang", readyWaitMs: { review: 100, other: 100 } });
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    const tool = dsh.tool("plannotator")!;
    const opened = ((await tool.execute({ action: "annotate", target: "notes.md" }, { agent: main })) as { text: string }).text;
    expect(opened).toContain("Plannotator is starting for notes.md");
    const id = sessionOf(opened);
    expect(((await tool.execute({ action: "close", session: id }, { agent: main })) as { text: string }).text).toContain(`Closed notes.md (${id})`);
    await until(() => !alive(dsh.calls()[0]!.pid));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(main.followups).toEqual([]);
  }, 15_000);
});

describe("no decision coming", () => {
  // The failure: the agent was told to end its turn and wait, and the review died: it waits forever.
  test("a review that answered 'starting' and then fails sends a 'Did not open' turn", async () => {
    const dsh = loadPlugin({ config: { agentTool: true }, mode: "late-fail", readyWaitMs: { review: 100, other: 100 } });
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    const opened = ((await dsh.tool("plannotator")!.execute({ action: "annotate", target: "notes.md" }, { agent: main })) as { text: string }).text;
    expect(opened).toContain("Plannotator is starting for notes.md");
    await until(() => main.followups.length > 0);
    expect(main.followups[0]).toStartWith(`Plannotator: notes.md (${sessionOf(opened)}) — Did not open.`);
    expect(main.followups[0]).toContain("Port in use");
  }, 15_000);

  test("a CLI that exits after its page opened, with no decision, sends an 'Ended with no decision' turn", async () => {
    const dsh = loadPlugin({ config: { agentTool: true }, mode: "crash" });
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    const opened = ((await dsh.tool("plannotator")!.execute({ action: "annotate", target: "notes.md" }, { agent: main })) as { text: string }).text;
    expect(opened).toContain("Opened notes.md in Plannotator");
    await until(() => main.followups.length > 0);
    expect(main.followups[0]).toStartWith(`Plannotator: notes.md (${sessionOf(opened)}) — Ended with no decision.`);
    expect(main.followups[0]).toContain("do not wait for it");
  }, 15_000);
});

describe("a CLI gone right after its page came up", () => {
  // The failure: the call answers "ready" for a child that already exited, while the exit found no
  // answer yet and sent nothing, so the agent waits for a decision that never comes. The race is
  // timing-dependent, so it is opened ten times.
  test("every 'ready' answer is followed by a message; the rest answer a failure", async () => {
    const dsh = loadPlugin({ config: { agentTool: true }, mode: "crash", env: { FAKE_CLI_DELAY_MS: "0" } });
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    const tool = dsh.tool("plannotator")!;
    const ready: string[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const text = ((await tool.execute({ action: "annotate", target: "notes.md" }, { agent: main })) as { text: string }).text;
        ready.push(sessionOf(text));
      } catch (error) {
        expect(String(error)).toContain("Plannotator could not start");
      }
    }
    await until(() => dsh.folders().length === 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const id of ready) expect(main.followups.some((text) => text.startsWith(`Plannotator: notes.md (${id}) — Ended with no decision.`))).toBe(true);
    expect(main.followups).toHaveLength(ready.length);
  }, 30_000);
});

describe("failures", () => {
  // The failure: a command whose CLI fails is reported as opened, so the person
  // and the agent wait for a decision that never comes, or a dead review lingers.
  test("a command with a bad path answers the CLI's error; nothing is left open and nothing is sent later", async () => {
    const dsh = loadPlugin({ mode: "fail" });
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    const answer = await dsh.command(DSH_COMMANDS.annotate)!.handler({ agent: main, rawInput: "missing.md" });
    expect(answer).toEqual({ kind: "error", text: "Plannotator could not start: File not found: missing.md" });
    await until(() => dsh.folders().length === 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(main.followups).toEqual([]);
  }, 15_000);

  test("a script-only annotate flag is refused before anything runs", async () => {
    const dsh = loadPlugin();
    const main = dsh.add(new FakeAgent("session-main", dsh.project));
    const answer = await dsh.command(DSH_COMMANDS.annotate)!.handler({ agent: main, rawInput: "notes.md --require-approval" });
    expect(answer.kind).toBe("error");
    expect(answer.text).toContain("--require-approval is for scripts");
    expect(dsh.calls()).toEqual([]);
  });

  test("the tool rejects an invalid call and a subagent's last without starting the CLI", async () => {
    const dsh = loadPlugin({ config: { agentTool: true } });
    dsh.add(new FakeAgent("session-main", dsh.project));
    const sub = dsh.add(new FakeAgent("session-sub", dsh.project, { parentSession: "session-main", origin: "subagent" }));
    const tool = dsh.tool("plannotator")!;
    await expect(tool.execute({ action: "annotate" }, { agent: sub })).rejects.toThrow('action "annotate" needs a target');
    await expect(tool.execute({ action: "last" }, { agent: sub })).rejects.toThrow("not available to a subagent");
    expect(dsh.calls()).toEqual([]);
  });
});

describe("dshDecision", () => {
  const review = { kind: "review" as const, subject: "local changes", id: "pn-abc123", gate: false };
  // The failure: an LGTM interrupts the agent with a turn it has nothing to do for,
  // or a gated review's approval, which the agent was told to wait for, never arrives.
  test("a bare approval is sent only for a gated review; a close never is", () => {
    const approved = { surface: "review", decision: "approved", message: "LGTM", noop: true };
    expect(dshDecision(approved, review).send).toBe(false);
    expect(dshDecision(approved, { ...review, gate: true })).toEqual({ send: true, text: "Plannotator: local changes (pn-abc123) — Approved.\n\nLGTM" });
    expect(dshDecision({ decision: "dismissed", message: "", noop: true }, { ...review, gate: true }).send).toBe(false);
  });
});
