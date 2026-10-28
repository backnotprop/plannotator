/**
 * A whole guide run against the FAKE ACP agent (tests/helpers/fake-acp-agent.ts):
 * the extension's ACP client starts it, it starts the builder relay script
 * from `session/new`, calls the guide_* tools through it, asks for a
 * permission, reports cost, and finishes. No real agent ever runs here.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuideGeneration, type GenerationDeps, type GenerationInput } from "./generation";
import { CLAUDE_CODE, CODEX, KNOWN_AGENTS, customAgent, type AgentDescriptor } from "@plannotator/acp-client/agents";
import { startRelayHost, type RelayHost } from "./mcp/relay-host";
import { changedFilesFromPatch } from "./sources/git";
import { listDraftRecords, loadDraftRecord, loadSavedGuide, listRecent } from "./store";

const FAKE_AGENT = join(import.meta.dir, "..", "..", "..", "..", "tests", "helpers", "fake-acp-agent.ts");
const RELAY_SCRIPT = join(import.meta.dir, "mcp", "relay-script.ts");

function addedFilePatch(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

let work: string;
let relay: RelayHost;
let repoN = 0;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "pn-guides-gen-"));
  relay = await startRelayHost({ serverVersion: "test" });
});

afterAll(async () => {
  await relay.close();
  rmSync(work, { recursive: true, force: true });
});

interface World {
  input: GenerationInput;
  deps: GenerationDeps;
  log: () => Array<Record<string, any>>;
  permissions: string[];
  /** The option ids each forwarded request offered. */
  offered: string[][];
}

function world(steps: unknown[], options: { pace?: number; resume?: GenerationInput["resume"]; choose?: string; script?: Record<string, unknown>; agent?: AgentDescriptor } = {}): World {
  const root = join(work, `repo-${++repoN}`);
  mkdirSync(join(root, "src"), { recursive: true });
  const files: Record<string, string[]> = {
    "src/retryPolicy.ts": ["export function computeBackoff(attempt: number) {", "  return 2 ** attempt;", "}"],
    "src/deliver.ts": ["import { computeBackoff } from './retryPolicy';", "export function deliver() {", "  return computeBackoff(1);", "}"],
    "src/deliver.test.ts": ["test('x', () => {});"],
  };
  for (const [p, lines] of Object.entries(files)) writeFileSync(join(root, p), `${lines.join("\n")}\n`);
  const rawPatch = Object.entries(files).map(([p, l]) => addedFilePatch(p, l)).join("");
  const scriptPath = join(root, "script.json");
  const logPath = join(root, "agent.log");
  writeFileSync(scriptPath, JSON.stringify({ steps, pace: options.pace ?? 0, ...options.script }));
  const permissions: string[] = [];
  const offered: string[][] = [];
  const input: GenerationInput = {
    repoKey: `test__repo-${repoN}`,
    source: {
      kind: "local",
      repoRoot: root,
      headRoot: root,
      repoName: "checkout-service",
      label: "Local changes",
      branch: "feat/retries",
      headSha: "9b07e4d0000000000000000000000000000000",
      baseSha: "3f2c1a9000000000000000000000000000000000",
      baseLabel: "main",
      workingTree: true,
    },
    rawPatch,
    files: changedFilesFromPatch(rawPatch),
    agent: { id: (options.agent ?? CLAUDE_CODE).id, label: (options.agent ?? CLAUDE_CODE).label, model: { id: "sonnet", label: "Sonnet" }, effort: { id: "low", label: "Low" } },
    instructions: "Keep chapters short.",
    ...(options.resume && { resume: options.resume }),
  };
  const deps: GenerationDeps = {
    relay,
    agent: options.agent ?? CLAUDE_CODE,
    agentLaunch: (cwd) => ({ command: process.execPath, args: [FAKE_AGENT], cwd, env: { FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath } }),
    mcpServer: { command: process.execPath, args: [RELAY_SCRIPT] },
    clientInfo: { name: "plannotator-vscode", title: "Plannotator", version: "test" },
    requestPermission: async (pending) => {
      permissions.push(pending.title);
      offered.push(pending.options.map((o) => o.optionId));
      if (options.choose === "never") return null;
      if (options.choose === "approve-run") return { approve: "run" };
      return { optionId: options.choose ?? "allow-once" };
    },
    resolveSymbol: async (name) => (name === "computeBackoff" ? { status: "found", path: "src/retryPolicy.ts", line: 1 } : { status: "missing" }),
    checkMermaid: async () => ({ ok: true, checked: true }),
  };
  const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { input, deps, log, permissions, offered };
}

const header = { mcp: { name: "guide_set_header", args: { title: "Retry failed webhook deliveries", intent: "Deliveries retry with backoff." } } };
const ch1 = { mcp: { name: "guide_add_chapter", args: { title: "The retry budget", overview: "A policy decides how often to retry." } } };
const ch2 = { mcp: { name: "guide_add_chapter", args: { title: "Delivery loop learns to back off", overview: "The loop backs off." } } };
const place = (file: string, chapter: string, extra: Record<string, unknown> = {}) => ({ mcp: { name: "guide_place_file", args: { file, chapter, summary: `What ${file} does.`, ...extra } } });

/** The fake agent's stubborn grandchildren (they ignore SIGTERM): killed after each test whatever it asserted, so a failing test never leaves one running. */
const stubborn = new Set<number>();

describe("guide generation over ACP", () => {
  afterEach(() => {
    for (const pid of stubborn) {
      try {
        process.kill(pid, "SIGKILL"); // own grandchild (the fake agent's), never anything else
      } catch {
        // Already gone.
      }
    }
    stubborn.clear();
  });

  it("runs a whole guide: messages, tool calls, a permission, builder calls with a refused one, cost, finish", async () => {
    const w = world([
      { say: "Reading the change first." },
      { tool: { title: "Read src/deliver.ts", locations: [{ path: "src/deliver.ts", line: 2 }] } },
      { permission: { title: "Read ~/notes/design.md", kind: "read" } },
      header,
      ch1,
      ch2,
      place("src/retryPolicy.ts", "c1", { focus: [{ start: 1, end: 3 }] }),
      place("src/deliver.test.ts", "c2"),
      place("src/deliver.test.ts", "c1"),
      { mcp: { name: "guide_set_overview", args: { text: "Start at [computeBackoff](symbol:computeBackoff), then [chapter 2](chapter:2).", diagram: { kind: "mermaid", source: 'flowchart LR\n d-->b\n click b "symbol:computeBackoff"' } } } },
      { mcp: { name: "guide_finish" } },
      place("src/deliver.ts", "c2"),
      { usage: { cost: 0.17 } },
      { mcp: { name: "guide_read" } },
      { mcp: { name: "guide_finish" } },
    ]);
    const gen = new GuideGeneration(w.input, w.deps);
    const statuses: string[] = [];
    gen.onChange((s) => {
      if (statuses[statuses.length - 1] !== s.status) statuses.push(s.status);
    });
    await gen.run();

    expect(gen.state.status).toBe("finished");
    expect(statuses).toContain("running");
    expect(gen.state.cost).toEqual({ amount: 0.17, currency: "USD" });
    expect(gen.state.appliedModel).toBe("Sonnet");
    expect(gen.state.appliedEffort).toBe("Low");

    const log = w.log();
    expect(log.find((e) => e.event === "initialize")?.clientCapabilities).toMatchObject({ fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true } });
    // Local changes are the user's own checkout: their project settings apply; only Claude Code's write tools are disallowed.
    // The agent runs with the user's own config: no _meta of Guides', nothing narrowed.
    expect(log.find((e) => e.event === "newSession")?.meta).toBeNull();
    expect(log.find((e) => e.event === "mcpReady")?.tools).toContain("guide_place_file");
    expect(log.filter((e) => e.event === "setConfig").map((e) => `${e.configId}=${e.value}`)).toEqual(["model=sonnet", "effort=low"]);
    const prompt = log.find((e) => e.event === "prompt")!;
    expect(prompt.text).toContain("- src/deliver.ts (+4/-0)");
    expect(prompt.text).toContain("guide_finish");
    expect(prompt.text).toContain("Keep chapters short.");
    expect(prompt.text).not.toContain("## Speed");
    expect(log.find((e) => e.event === "permission")?.outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(w.permissions).toEqual(["Read ~/notes/design.md"]);
    const calls = log.filter((e) => e.event === "mcpCall");
    expect(calls.find((c) => c.name === "guide_place_file" && c.isError)?.text).toContain("already in chapter 2 (c2). Use guide_move_file");
    expect(calls.filter((c) => c.name === "guide_finish")[0].text).toContain("neither placed nor marked not in a chapter: `src/deliver.ts`");
    expect(calls.filter((c) => c.name === "guide_finish")[1].text).toContain("Saved \"Retry failed webhook deliveries\": 2 chapters and an overview.");

    // The activity stream: the agent's message, its own tool call with a link, the builder lines (no duplicates from the ACP side).
    const kinds = gen.state.activity.map((a) => `${a.kind}:${a.kind === "builder" ? a.title : ""}`);
    expect(kinds.filter((k) => k.startsWith("tool:"))).toHaveLength(2);
    expect(gen.state.activity.find((a) => a.kind === "message")?.title).toBe("Reading the change first.");
    expect(gen.state.activity.find((a) => a.kind === "tool")?.locations).toEqual([{ path: "src/deliver.ts", line: 2 }]);
    expect(gen.state.activity.find((a) => a.kind === "permission")?.detail).toBe("Allow once");
    const refused = gen.state.activity.find((a) => a.kind === "builder" && a.isError);
    expect(refused?.detail).toBe("src/deliver.test.ts → 1: `src/deliver.test.ts` is already in chapter 2 (c2). Use guide_move_file to move it.");

    // Saved where the web app finds it, with the VS Code sidecar beside it; the draft is gone.
    const saved = loadSavedGuide(w.input.repoKey, gen.state.savedGuideId!);
    expect(saved?.envelope.guide.sections.map((s) => s.diffs.map((d) => d.file))).toEqual([["src/retryPolicy.ts"], ["src/deliver.test.ts", "src/deliver.ts"]]);
    expect((saved?.envelope.guide as { overview?: { text: string } }).overview?.text).toContain("symbol:computeBackoff");
    expect(saved?.envelope.review?.source).toEqual({ kind: "local", repo: "checkout-service", branch: "feat/retries", headSha: w.input.source.headSha });
    expect(saved?.envelope.customInstructions).toBe("Keep chapters short.");
    expect(saved?.envelope.model).toBe("sonnet");
    expect(saved?.rawPatch).toBe(w.input.rawPatch);
    expect(saved?.sidecar.focus).toEqual({ "src/retryPolicy.ts": [{ start: 1, end: 3 }] });
    expect(saved?.sidecar.cost).toEqual({ amount: 0.17, currency: "USD" });
    expect(listDraftRecords(w.input.repoKey)).toEqual([]);
    expect(listRecent(w.input.repoKey).map((r) => r.kind)).toEqual(["guide"]);
  });

  it("keeps the draft when the agent crashes, and Resume finishes it under the same id", async () => {
    const w = world([header, ch1, place("src/retryPolicy.ts", "c1"), { exit: 3 }]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("failed");
    expect(gen.state.statusMessage).toStartWith("The agent exited with code 3.");
    const record = loadDraftRecord(w.input.repoKey, gen.state.id);
    expect(record?.status).toBe("failed");
    expect(record?.draft.chapters[0].files.map((f) => f.file)).toEqual(["src/retryPolicy.ts"]);
    const recent = listRecent(w.input.repoKey);
    expect(recent[0]).toMatchObject({ kind: "draft", draftInfo: { chapters: 1, filesLeft: 2, status: "failed" } });

    const w2 = world([{ mcp: { name: "guide_read" } }, ch2, place("src/deliver.ts", "c2"), place("src/deliver.test.ts", "c2"), { mcp: { name: "guide_finish" } }], { resume: record! });
    w2.input.repoKey = w.input.repoKey;
    w2.input.source = w.input.source;
    w2.input.rawPatch = w.input.rawPatch;
    w2.input.files = w.input.files;
    const resumed = new GuideGeneration(w2.input, w2.deps);
    expect(resumed.state.id).toBe(gen.state.id);
    await resumed.run();
    expect(resumed.state.status).toBe("finished");
    const prompt = w2.log().find((e) => e.event === "prompt")!;
    expect(prompt.text).toContain("A draft of this guide already exists.");
    expect(w2.log().find((e) => e.event === "mcpCall")?.text).toContain("1. c1 · The retry budget");
    expect(loadDraftRecord(w.input.repoKey, gen.state.id)).toBeNull();
  });

  it("cancels: session/cancel reaches the agent and the draft is kept as stopped", async () => {
    const w = world([header, ch1, { sleep: 3000 }, ch2], { pace: 10 });
    const gen = new GuideGeneration(w.input, w.deps);
    const running = gen.run();
    await new Promise<void>((resolve) => {
      const off = gen.onChange((s) => {
        if (s.draft.chapters.length === 1) {
          off();
          resolve();
        }
      });
    });
    await gen.cancel();
    await running;
    expect(gen.state.status).toBe("stopped");
    expect(gen.state.statusMessage).toBe("Cancelled.");
    expect(w.log().some((e) => e.event === "cancel")).toBe(true);
    expect(loadDraftRecord(w.input.repoKey, gen.state.id)?.status).toBe("stopped");

    // Save as is: the leftovers go to "Not in a chapter", the empty chapter is dropped.
    const placed = world([]);
    void placed;
    const result = await gen.saveAsIs();
    expect(result.ok).toBe(false); // the only chapter has no files
  });

  it("passes a rejected permission back to the agent, and names the bottleneck with a way through", async () => {
    const w = world([{ permission: { title: "Search the web", kind: "fetch" } }, header], { choose: "reject-once" });
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(w.log().find((e) => e.event === "permission")?.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
    expect(gen.state.activity.find((a) => a.kind === "permission")?.status).toBe("failed");
    expect(gen.state.bottlenecks.find((b) => b.key === "turned-down")).toEqual({
      key: "turned-down",
      title: "You turned down Search the web",
      detail: "Claude Code will try another way. Approve automatically to let its requests through for the rest of this run.",
      action: "approveRun",
    });
    // The run ended without the guide after a request was turned down: resume with approval.
    expect(gen.state.bottlenecks.find((b) => b.key === "ended-blocked")?.action).toBe("resumeWithApproval");
    expect(gen.state.status).toBe("stopped");
    expect(gen.state.statusMessage).toContain("without calling guide_finish");
  });

  it("saves a stopped draft as is", async () => {
    const w = world([header, ch1, ch2, place("src/retryPolicy.ts", "c1")]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("stopped");
    const result = await gen.saveAsIs();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const saved = loadSavedGuide(w.input.repoKey, result.guideId)!;
    expect(saved.envelope.guide.sections.map((s) => s.title)).toEqual(["The retry budget"]);
    expect(saved.envelope.guide.unplacedFiles?.sort()).toEqual(["src/deliver.test.ts", "src/deliver.ts"]);
    expect(gen.state.status).toBe("finished");
  });

  it("fails a signed-out run with the agent's own sign-in commands", async () => {
    const w = world([header, { authRequired: true }]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("failed");
    expect(gen.state.statusMessage).toStartWith("Claude Code is not signed in.");
    expect(gen.state.signIn?.logins).toEqual([{ label: "Claude Subscription", args: ["--cli", "auth", "login", "--claudeai"] }]);
    expect(loadDraftRecord(w.input.repoKey, gen.state.id)?.status).toBe("failed");
  });

  it("refuses an agent that speaks another ACP protocol version", async () => {
    const w = world([header], { script: { protocolVersion: 2 } });
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("failed");
    expect(gen.state.statusMessage).toContain("ACP protocol version 2");
    expect(w.log().some((e) => e.event === "newSession")).toBe(false);
  });

  it("kills what the agent started when the run ends, even after the agent itself exited", async () => {
    const w = world([{ spawnStubborn: true }, header]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    const pid = w.log().find((e) => e.event === "stubborn")?.pid as number;
    expect(typeof pid).toBe("number");
    stubborn.add(pid);
    expect(await gone(pid, 6000)).toBe(true);
  });

  it("kill() stops the agent and everything it started at once (VS Code closing)", async () => {
    const w = world([{ spawnStubborn: true }, header, { sleep: 20000 }]);
    const gen = new GuideGeneration(w.input, w.deps);
    const running = gen.run();
    let pid: number | undefined;
    for (let i = 0; i < 100 && !pid; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pid = w.log().find((e) => e.event === "stubborn")?.pid;
    }
    expect(pid).toBeDefined();
    stubborn.add(pid!);
    gen.kill();
    expect(await gone(pid!, 1500)).toBe(true);
    await running;
  });

  it("with guide history off, writes no draft and no guide: the guide is kept in memory", async () => {
    const w = world([header, ch1, ch2, place("src/retryPolicy.ts", "c1"), place("src/deliver.ts", "c2"), place("src/deliver.test.ts", "c2"), { mcp: { name: "guide_finish" } }]);
    w.deps.history = false;
    const seenDrafts: number[] = [];
    const gen = new GuideGeneration(w.input, w.deps);
    gen.onChange(() => seenDrafts.push(listDraftRecords(w.input.repoKey).length));
    await gen.run();
    expect(gen.state.status).toBe("finished");
    expect(gen.state.memoryOnly).toBe(true);
    expect(gen.state.statusMessage).toContain("Not saved: guide history is off");
    expect(seenDrafts.every((n) => n === 0)).toBe(true);
    expect(listRecent(w.input.repoKey)).toEqual([]);
    expect(loadSavedGuide(w.input.repoKey, gen.state.savedGuideId!)).toBeNull();
    expect(gen.memoryGuide?.id).toBe(gen.state.savedGuideId);
    expect(gen.memoryGuide?.envelope.title).toBe("Retry failed webhook deliveries");
    expect(gen.memoryGuide?.rawPatch).toBe(w.input.rawPatch);
    expect(gen.toDraftRecord().draft.chapters).toHaveLength(2);
  });

  it("says so when the overview diagram could not be render-checked, and records it for the reader", async () => {
    const w = world([
      header,
      ch1,
      place("src/retryPolicy.ts", "c1"),
      place("src/deliver.ts", "c1"),
      place("src/deliver.test.ts", "c1"),
      { mcp: { name: "guide_set_overview", args: { text: "Start here.", diagram: { kind: "mermaid", source: "flowchart LR\n a-->b" } } } },
      { mcp: { name: "guide_finish" } },
    ]);
    w.deps.checkMermaid = async () => ({ ok: true, checked: false });
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("finished");
    expect(gen.state.diagramUnchecked).toBe(true);
    expect(gen.state.statusMessage).toContain("not render-checked");
    expect(w.log().filter((e) => e.event === "mcpCall" && e.name === "guide_finish")[0].text).toContain("could not be render-checked");
    expect(loadSavedGuide(w.input.repoKey, gen.state.savedGuideId!)?.sidecar.diagramCheck).toBe("unchecked");
  });

  it("records a checked diagram as ok", async () => {
    const w = world([
      header,
      ch1,
      place("src/retryPolicy.ts", "c1"),
      place("src/deliver.ts", "c1"),
      place("src/deliver.test.ts", "c1"),
      { mcp: { name: "guide_set_overview", args: { text: "Start here.", diagram: { kind: "mermaid", source: "flowchart LR\n a-->b" } } } },
      { mcp: { name: "guide_finish" } },
    ]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.diagramUnchecked).toBeUndefined();
    expect(loadSavedGuide(w.input.repoKey, gen.state.savedGuideId!)?.sidecar.diagramCheck).toBe("ok");
  });
});

describe("your agent, your config: Guides never blocks it", () => {
  const asPullRequest = (w: World) => {
    w.input.source = { ...w.input.source, kind: "pr", label: "PR #482", pr: { number: 482, url: "https://github.com/northwind/checkout-service/pull/482", title: "Retry" }, worktreePath: w.input.source.headRoot };
  };
  const modeChanges = (log: Array<Record<string, any>>) => log.filter((e) => e.event === "setMode" || (e.event === "setConfig" && e.configId === "mode"));
  const fullGuide = [header, ch1, ch2, place("src/retryPolicy.ts", "c1"), place("src/deliver.ts", "c2"), place("src/deliver.test.ts", "c2"), { mcp: { name: "guide_finish" } }];

  for (const agent of [...KNOWN_AGENTS, customAgent({ command: "/opt/any-acp" })!]) {
    for (const kind of ["local", "pr"] as const) {
      it(`${agent.label} writes a guide for ${kind === "pr" ? "a pull request" : "local changes"}`, async () => {
        const w = world(fullGuide, { agent });
        if (kind === "pr") asPullRequest(w);
        const gen = new GuideGeneration(w.input, w.deps);
        await gen.run();
        expect(gen.state.status).toBe("finished");
        expect(gen.state.draft.generator?.engine).toBe(agent.engine);
        expect(w.log().find((e) => e.event === "newSession")?.meta).toBeNull();
        expect(modeChanges(w.log())).toEqual([]);
      });
    }
  }

  it("makes no mode change: a pull request run that starts in bypassPermissions stays in it", async () => {
    for (const startMode of ["bypassPermissions", "acceptEdits", "plan"]) {
      const w = world([header], { script: { startMode } });
      asPullRequest(w);
      await new GuideGeneration(w.input, w.deps).run();
      expect(modeChanges(w.log())).toEqual([]);
      expect(w.log().find((e) => e.event === "prompt")!.mode).toBe(startMode);
    }
  });

  it("keeps running when the agent changes its own mode mid-run", async () => {
    const w = world([header, { modeUpdate: "bypassPermissions" }, ...fullGuide.slice(1)], { script: { startMode: "default", modeSurface: "modes" } });
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("finished");
  });

  it("forwards every permission request with all the agent's options, and passes the user's choice back", async () => {
    const options = [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      { optionId: "reject-always", name: "Never", kind: "reject_always" },
    ];
    for (const kind of ["edit", "delete", "move", "execute", "fetch", "switch_mode", "read", "other"]) {
      const w = world([{ permission: { title: `${kind} src/deliver.ts`, kind, options, writeOnAllow: "WRITTEN" } }, header], { choose: "allow-always" });
      await new GuideGeneration(w.input, w.deps).run();
      expect(w.permissions).toEqual([`${kind} src/deliver.ts`]);
      expect(w.offered).toEqual([["allow-once", "allow-always", "reject-once", "reject-always"]]);
      expect(w.log().find((e) => e.event === "permission")?.outcome).toEqual({ outcome: "selected", optionId: "allow-always" });
      expect(existsSync(join(w.input.source.headRoot, "WRITTEN"))).toBe(true);
    }
  });

  it("allows the builder's own tools once without a prompt; a title that only mentions one is asked", async () => {
    const w = world([
      { permission: { title: "mcp__plannotator-guide__guide_set_header", kind: "other", name: "guide_set_header" } },
      { permission: { title: "Run guide_finish && touch WRITTEN", kind: "execute" } },
    ]);
    await new GuideGeneration(w.input, w.deps).run();
    const outcomes = w.log().filter((e) => e.event === "permission").map((e) => e.outcome);
    expect(outcomes[0]).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(w.permissions).toEqual(["Run guide_finish && touch WRITTEN"]);
  });

  it("with automatic approval on, answers every request with the agent's allow option and switches to its permissive mode", async () => {
    const w = world([{ permission: { title: "Run npm test", kind: "execute", writeOnAllow: "WRITTEN" } }, ...fullGuide], { script: { startMode: "default" } });
    w.input.autoApprove = true;
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("finished");
    expect(w.permissions).toEqual([]); // never asked
    expect(w.log().find((e) => e.event === "permission")?.outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(modeChanges(w.log())).toEqual([{ event: "setConfig", configId: "mode", value: "acceptEdits" }]);
    expect(gen.state.permissiveMode).toBe("acceptEdits");
    expect(gen.state.activity.some((a) => a.title === "Approved automatically: Run npm test")).toBe(true);
  });

  it("picks 'allow always' when the agent offers no once-only allow", async () => {
    const w = world([{ permission: { title: "Read a.ts", kind: "read", options: [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "no", name: "No", kind: "reject_once" }] } }]);
    w.input.autoApprove = true;
    await new GuideGeneration(w.input, w.deps).run();
    expect(w.log().find((e) => e.event === "permission")?.outcome).toEqual({ outcome: "selected", optionId: "always" });
  });

  it("shows a pending request in the run state until it is answered, offers automatic approval inline, and 'Approve all' answers it and the rest", async () => {
    const w = world([
      { permission: { title: "Run git log", kind: "execute" } },
      { permission: { title: "Run npm test", kind: "execute" } },
      header,
    ], { choose: "never", agent: CODEX, script: { startMode: "read-only", modes: [{ id: "read-only", name: "Read Only" }, { id: "agent", name: "Auto" }] } });
    const gen = new GuideGeneration(w.input, w.deps);
    const running = gen.run();
    await new Promise<void>((resolve) => {
      const off = gen.onChange((s) => {
        if (s.pendingPermissions.length) {
          off();
          resolve();
        }
      });
    });
    expect(gen.state.pendingPermissions).toEqual([
      { id: 1, title: "Run git log", kind: "execute", options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ] },
    ]);
    expect(gen.state.offerAutoApprove).toBe(true);
    expect(gen.state.activity.some((a) => a.title === "Waiting for your approval: Run git log" && a.status === "pending")).toBe(true);
    gen.approveAutomatically();
    await running;
    const outcomes = w.log().filter((e) => e.event === "permission").map((e) => e.outcome);
    expect(outcomes).toEqual([{ outcome: "selected", optionId: "allow-once" }, { outcome: "selected", optionId: "allow-once" }]);
    expect(w.permissions).toEqual(["Run git log"]); // the second was approved without asking
    expect(gen.state.pendingPermissions).toEqual([]);
    expect(gen.state.autoApprove).toBe(true);
    expect(gen.state.offerAutoApprove).toBe(false);
    expect(gen.state.permissiveMode).toBe("agent");
  });

  it("answers a pending request from the run view with the option picked there", async () => {
    const w = world([{ permission: { title: "Read ~/notes.md", kind: "read" } }, header], { choose: "never" });
    const gen = new GuideGeneration(w.input, w.deps);
    const running = gen.run();
    await new Promise<void>((resolve) => {
      const off = gen.onChange((s) => {
        if (s.pendingPermissions.length) {
          off();
          resolve();
        }
      });
    });
    gen.answerPermission(1, { optionId: "not-an-option" }); // ignored
    expect(gen.state.pendingPermissions).toHaveLength(1);
    gen.answerPermission(1, { optionId: "reject-once" });
    await running;
    expect(w.log().find((e) => e.event === "permission")?.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("names tools the agent's settings denied (its own wording only), in one notice, and goes on", async () => {
    const w = world([
      { tool: { title: "Bash", kind: "execute", fail: true, output: "Permission to use Bash has been denied." } },
      { tool: { title: "WebFetch", kind: "fetch", fail: true, output: "Permission to use WebFetch with url https://x.dev has been denied." } },
      { tool: { title: "Read missing.ts", kind: "read", fail: true, output: "ENOENT: no such file" } },
      ...fullGuide,
    ]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("finished");
    expect(gen.state.bottlenecks).toHaveLength(1);
    expect(gen.state.bottlenecks[0].key).toBe("blocked:settings");
    expect(gen.state.bottlenecks[0].title).toBe("Claude Code's settings denied Bash, WebFetch");
    expect(gen.state.bottlenecks[0].detail).toContain("does not lift a deny rule");
    expect(gen.state.bottlenecks[0].action).toBeUndefined();
  });

  it("does not advise resuming with automatic approval when only a deny rule blocked the agent", async () => {
    // The run ends without the guide; the only blocks came from the agent's own settings.
    const w = world([{ tool: { title: "Bash", kind: "execute", fail: true, output: "Permission to use Bash has been denied." } }, header]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).not.toBe("finished");
    expect(gen.state.bottlenecks.map((b) => b.key)).toEqual(["blocked:settings"]);
    expect(gen.state.bottlenecks.some((b) => b.action === "resumeWithApproval")).toBe(false);
  });

  it("never reads a tool's own failure as the agent's config", async () => {
    const outputs = [
      "cat: secrets.txt: Permission denied",
      "fatal: Unable to create '/repo/.git/index.lock': Permission denied",
      "npm ERR! code EACCES",
      "HTTP 405 Method Not Allowed",
      "fatal: 'my branch' is not a valid branch name: Spaces are not allowed in branch names",
      "FAIL src/sandbox.test.ts",
      "rm: build: Operation not permitted",
      "error: cannot open .git/FETCH_HEAD: Read-only file system",
    ];
    const w = world([...outputs.map((output, i) => ({ tool: { title: `Run ${i}`, kind: "execute", fail: true, output } })), header]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.bottlenecks.filter((b) => b.key.startsWith("blocked"))).toEqual([]);
    // Nothing was blocked, so the end of the run does not blame the user's setup.
    expect(gen.state.bottlenecks.some((b) => b.key === "ended-blocked")).toBe(false);
  });

  it("never downgrades a session already in a mode as permissive as the target", async () => {
    for (const startMode of ["auto", "bypassPermissions", "acceptEdits"]) {
      const w = world([header], { script: { startMode, modes: [{ id: "default", name: "Default" }, { id: "acceptEdits", name: "Accept" }, { id: "auto", name: "Auto" }, { id: "bypassPermissions", name: "Bypass" }] } });
      w.input.autoApprove = true;
      const gen = new GuideGeneration(w.input, w.deps);
      await gen.run();
      expect(modeChanges(w.log())).toEqual([]);
      expect(gen.state.permissiveMode).toBe(startMode);
    }
    const codex = world([header], { agent: CODEX, script: { startMode: "agent-full-access", modes: [{ id: "read-only", name: "RO" }, { id: "agent", name: "Auto" }, { id: "agent-full-access", name: "Full" }] } });
    codex.input.autoApprove = true;
    await new GuideGeneration(codex.input, codex.deps).run();
    expect(modeChanges(codex.log())).toEqual([]);
  });

  it("'Approve all' from a notification whose request was already answered still turns automatic approval on", async () => {
    const w = world([{ sleep: 400 }, { permission: { title: "Run npm test", kind: "execute" } }, header], { choose: "never" });
    const gen = new GuideGeneration(w.input, w.deps);
    const running = gen.run();
    await new Promise<void>((resolve) => {
      const off = gen.onChange((s) => {
        if (s.status === "running") {
          off();
          resolve();
        }
      });
    });
    gen.answerPermission(999, { approve: "run" }); // no such pending request any more
    await running;
    expect(gen.state.autoApprove).toBe(true);
    expect(w.permissions).toEqual([]); // the later request was approved without asking
    expect(w.log().find((e) => e.event === "permission")?.outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    // Once a run ended, a late "Approve all" changes nothing.
    const ended = world([header]);
    const after = new GuideGeneration(ended.input, ended.deps);
    await after.run();
    after.answerPermission(1, { approve: "run" });
    expect(after.state.autoApprove).toBe(false);
  });

  it("leaves a request with no allow option with the user when 'Approve all' is pressed", async () => {
    const w = world([{ permission: { title: "Pick one", kind: "other", options: [{ optionId: "no", name: "No", kind: "reject_once" }] } }, header], { choose: "never" });
    const gen = new GuideGeneration(w.input, w.deps);
    const running = gen.run();
    await new Promise<void>((resolve) => {
      const off = gen.onChange((s) => {
        if (s.pendingPermissions.length) {
          off();
          resolve();
        }
      });
    });
    gen.approveAutomatically();
    expect(gen.state.pendingPermissions).toHaveLength(1); // still waiting for the user
    gen.answerPermission(gen.state.pendingPermissions[0].id, { optionId: "no" });
    await running;
    expect(w.log().find((e) => e.event === "permission")?.outcome).toEqual({ outcome: "selected", optionId: "no" });
  });

  it("says so when the agent never reaches the guide's tools", async () => {
    // An agent that accepts the client's MCP servers but never starts them (pi-acp today).
    const w = world([{ say: "I looked around." }], { script: { ignoreMcp: true } });
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("stopped");
    expect(gen.state.statusMessage).toStartWith("Claude Code never reached the guide's tools");
    expect(gen.state.bottlenecks.map((b) => b.key)).toContain("no-builder");
  });

  it("serves fs/read_text_file when an agent calls it; write and terminal were not offered", async () => {
    const w = world([{ clientRead: { path: "src/deliver.ts", line: 2, limit: 1 } }, { clientWrite: { path: "WRITTEN", content: "x" } }, { clientTerminal: { command: "true" } }, header]);
    await new GuideGeneration(w.input, w.deps).run();
    const log = w.log();
    expect(log.find((e) => e.event === "clientRead")).toEqual({ event: "clientRead", ok: true, content: "export function deliver() {" });
    expect(log.find((e) => e.event === "clientWrite")?.code).toBe(-32601);
    expect(log.find((e) => e.event === "clientTerminal")?.code).toBe(-32601);
  });
});

/** Wait until a process no longer exists. */
async function gone(pid: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
    return false;
  } catch {
    return true;
  }
}
