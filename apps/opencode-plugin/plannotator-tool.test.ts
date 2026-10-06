import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PLANNOTATOR_OUTCOME_REVIEW_POSTED,
  PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT,
  PLANNOTATOR_TOOL_DESCRIPTION,
  PLANNOTATOR_TOOL_INPUT_SCHEMA,
  PLANNOTATOR_TOOL_NAME,
} from "@plannotator/shared/plannotator-tool";
import { classifyHostCloseAnswer } from "@plannotator/shared/host-control";
import serverPlugin, { registerPlannotatorTool, resolveRootSession } from "./server";
import { runNativeCommand, type NativeCommandDeps } from "./native-commands";
import {
  OpenCodeLaunchRegistry,
  PLANNOTATOR_TOOL_SUBAGENT_LAST_TEXT,
  commandSubject,
  quoteReviewWord,
  runPlannotatorTool,
  toolLaunchRequest,
  type PlannotatorToolDeps,
} from "./plannotator-tool";

const HOST_CONTROL = path.join(import.meta.dir, "..", "..", "packages", "shared", "host-control.ts");
const ANNOTATE_TARGET = path.join(import.meta.dir, "..", "..", "packages", "shared", "annotate-target.ts");
const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
// A stand-in `plannotator` CLI: a real loopback server with the REAL host
// control guards (bearer token, Host header), a ready file like the CLI's, and
// a test-only route that plays the reviewer's decision. `behavior` picks what
// the host-control paths answer: a current CLI, an older one without them, or
// a current one with host control turned off (remote mode).
// ---------------------------------------------------------------------------
type StubBehavior = "current" | "older" | "disabled" | "disabled-remote" | "fail" | "slowfail" | "slowready" | "nobundle" | "targets";

function writeStub(root: string, behavior: StubBehavior): string {
  const binary = path.join(root, `cli-${behavior}.ts`);
  const record = path.join(root, `argv-${behavior}.jsonl`);
  writeFileSync(binary, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { handleHostControlRequest } from ${JSON.stringify(HOST_CONTROL)};
const stdin = await Bun.stdin.text();
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin, token: process.env.PLANNOTATOR_SESSION_BRIDGE_TOKEN ?? null }) + "\\n");
if (${JSON.stringify(behavior)} === "nobundle") {
  // A CLI from before bundles: several paths are its ambiguity error.
  console.error("Ambiguous annotate arguments: several of these name something that exists.");
  process.exit(1);
}
if (${JSON.stringify(behavior)} === "fail" || ${JSON.stringify(behavior)} === "slowfail") {
  if (${JSON.stringify(behavior)} === "slowfail") await Bun.sleep(600);
  console.error("File not found: missing.md");
  process.exit(1);
}
// "slowready": a server that comes up after the tool already answered "starting".
if (${JSON.stringify(behavior)} === "slowready") await Bun.sleep(600);
const token = process.env.PLANNOTATOR_SESSION_BRIDGE_TOKEN;
let decide;
const decision = new Promise((resolve) => { decide = resolve; });
let decided = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/test/decide") {
      decided = true;
      decide(await req.json());
      return Response.json({ ok: true });
    }
    if (url.pathname.startsWith("/api/host/")) {
      if (${JSON.stringify(behavior)} === "older") return Response.json({ error: "Not found" }, { status: 404 });
      const answer = handleHostControlRequest(
        { method: req.method, pathname: url.pathname, host: req.headers.get("host"), origin: req.headers.get("origin"), authorization: req.headers.get("authorization") },
        {
          token: ${JSON.stringify(behavior)}.startsWith("disabled") ? undefined : token,
          getServerPort: () => server.port,
          control: {
            status: () => ({ kind: "annotate", documents: [], unsentAnnotations: 2, decided }),
            close: () => {
              if (decided) return { closed: false, reason: "decided" };
              decided = true;
              decide({ decision: "dismissed" });
              return { closed: true, unsentAnnotations: 2 };
            },
          },
        },
      );
      if (answer) return Response.json(answer.body, { status: answer.status });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});
// "targets": a CLI that names what it opened, in full, and reads its
// arguments as the real one does: ONE argument is one path, never split
// (\`annotate ". notes.md"\` is "File not found"), while several arguments go
// through the CLI's own shared selection (a stray "." beside a file is
// dropped, several file paths are a bundle).
const readyTarget = ${JSON.stringify(behavior)} === "targets" && process.argv[2] === "annotate"
  ? await (async () => {
      const { resolve } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const target = await import(${JSON.stringify(ANNOTATE_TARGET)});
      const base = process.env.PLANNOTATOR_CWD ?? process.cwd();
      const words = process.argv.slice(3).filter((word) => !word.startsWith("-"));
      if (words.length > 1) {
        const selection = target.selectAnnotateTokenTarget(
          words,
          (token) => target.probeAnnotateToken(token, base, { bareDirectories: false }),
          { bundlePath: (token) => target.probeAnnotateBundlePath(token, base), pathExists: (token) => target.annotatePathExists(token, base) },
        );
        if (selection.kind === "bundle") return selection.files.map((file) => file.value);
        if (selection.kind === "single") return selection.candidate.value;
        console.error("Ambiguous annotate arguments: " + words.join(" "));
        process.exit(1);
      }
      const only = words[0] ?? "";
      if (existsSync(resolve(base, only))) return resolve(base, only);
      console.error("File not found: " + only);
      process.exit(1);
    })()
  : undefined;
appendFileSync(process.env.PLANNOTATOR_READY_FILE, JSON.stringify({ url: "http://localhost:" + server.port, port: server.port, isRemote: ${JSON.stringify(behavior)} === "disabled-remote", ...(readyTarget ? { target: readyTarget } : {}) }) + "\\n");
const outcome = await decision;
// Let the answer to the request that decided reach its caller first.
await Bun.sleep(100);
server.stop(true);
console.log(JSON.stringify(outcome));
process.exit(0);
`, { mode: 0o755 });
  return binary;
}

function readArgv(root: string, behavior: StubBehavior): Array<{ argv: string[]; stdin: string; token: string | null }> {
  const file = path.join(root, `argv-${behavior}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor<T>(read: () => T | undefined | null | false, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
}

/** The fake OpenCode 2 context the real launch path runs against. */
function makeHost(root: string, options: { parents?: Record<string, string> } = {}) {
  const prompts: Array<{ sessionID: string; text: string; delivery?: unknown }> = [];
  const prompt = mock(async (input: { sessionID: string; text: string; delivery?: unknown }) => {
    prompts.push({ sessionID: input.sessionID, text: input.text, delivery: input.delivery });
    return {};
  });
  // Session-URL notices (`session.synthetic`), as an OpenCode 2 host takes them.
  const notices: Array<{ sessionID: string; text: string }> = [];
  const synthetic = mock(async (input: { sessionID: string; text: string }) => {
    notices.push({ sessionID: input.sessionID, text: input.text });
    return {};
  });
  const ctx: any = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        location: { directory: root },
        ...(options.parents?.[sessionID] ? { parentID: options.parents[sessionID] } : {}),
      }),
      prompt,
      synthetic,
      context: async () => [],
    },
    location: { directory: root },
  };
  const registry = new OpenCodeLaunchRegistry();
  const nativeDeps: NativeCommandDeps = {
    ctx,
    getAgents: async () => [],
    getBridgeContext: async () => ({ sharingEnabled: false }),
    launches: registry,
  };
  const toolDeps: PlannotatorToolDeps = {
    registry,
    launch: (request) => runNativeCommand(
      request.command,
      { sessionID: request.sessionID, prompt: { text: request.rawArgs } },
      nativeDeps,
      { launch: request.launch, annotateArgs: request.annotateArgs, annotateBundle: request.annotateBundle, notice: request.notice },
    ),
    resolveOwner: (sessionID) => resolveRootSession(ctx, sessionID),
    reportLateFailure: async ({ sessionID, text }) => {
      await ctx.session.prompt({ sessionID, text, delivery: "queue" });
    },
    readyWaitMs: { review: 8_000, other: 8_000 },
  };
  return { ctx, prompts, prompt, notices, registry, nativeDeps, toolDeps };
}

const SESSION_ID_LINE = /^Session: (pn-[0-9a-f]{6})$/m;

function sessionIdOf(text: string): string {
  const match = SESSION_ID_LINE.exec(text);
  if (!match) throw new Error(`no session id in: ${text}`);
  return match[1] as string;
}

function portOf(text: string): number {
  const match = /http:\/\/localhost:(\d+)/.exec(text);
  if (!match) throw new Error(`no url in: ${text}`);
  return Number(match[1]);
}

async function decide(port: number, outcome: unknown): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/test/decide`, { method: "POST", body: JSON.stringify(outcome) });
}

// Sandbox every run: the launch path reads config and may resolve the data
// dir; nothing here may touch the real ~/.plannotator or ~/.config/opencode.
const SANDBOX_KEYS = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_BIN"] as const;
let saved: Record<string, string | undefined> = {};
let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "plannotator-oc2-tool-"));
  saved = Object.fromEntries(SANDBOX_KEYS.map((key) => [key, process.env[key]]));
  for (const dir of ["home", "config", "cache", "data", "pn"]) mkdirSync(path.join(root, dir));
  process.env.HOME = path.join(root, "home");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  process.env.XDG_DATA_HOME = path.join(root, "data");
  process.env.PLANNOTATOR_DATA_DIR = path.join(root, "pn");
  writeFileSync(path.join(root, "notes.md"), "# Notes\n");
  writeFileSync(path.join(root, "my notes.md"), "# Notes\n");
});

afterEach(() => {
  for (const key of SANDBOX_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("registration", () => {
  function toolDomain() {
    const added: Array<Record<string, any>> = [];
    return {
      added,
      domain: {
        transform: async (apply: (tools: { add?: (tool: Record<string, unknown>) => void }) => void) => {
          apply({ add: (tool) => added.push(tool) });
        },
      },
    };
  }
  const deps = (): PlannotatorToolDeps => ({ registry: new OpenCodeLaunchRegistry(), launch: async () => {} });

  // Failure caught: a forked or drifted contract (another name, a stale
  // schema without list/close, a hand-written description).
  test("registers the shared contract itself, not a copy", async () => {
    const { added, domain } = toolDomain();
    expect(await registerPlannotatorTool(domain, { session: { prompt: async () => ({}) } }, deps())).toBe(true);
    expect(added).toHaveLength(1);
    expect(added[0]!.name).toBe(PLANNOTATOR_TOOL_NAME);
    expect(added[0]!.description).toBe(PLANNOTATOR_TOOL_DESCRIPTION);
    expect(added[0]!.input).toBe(PLANNOTATOR_TOOL_INPUT_SCHEMA);
  });

  // Failure caught: a tool whose decisions could never come back (no
  // session.prompt), or a throw inside an older host's draft without `add`.
  test("registers nothing where the decision cannot be delivered or the draft has no add", async () => {
    const noPrompt = toolDomain();
    expect(await registerPlannotatorTool(noPrompt.domain, { session: {} }, deps())).toBe(false);
    expect(noPrompt.added).toHaveLength(0);

    let applied = false;
    const legacy = {
      transform: async (apply: (tools: any) => void) => {
        applied = true;
        apply({ list: () => [], get: () => undefined, update: () => {}, remove: () => {} });
      },
    };
    expect(await registerPlannotatorTool(legacy, { session: { prompt: async () => ({}) } }, deps())).toBe(false);
    expect(applied).toBe(true);
    expect(await registerPlannotatorTool(undefined, { session: { prompt: async () => ({}) } }, deps())).toBe(false);
  });

  async function setupAddedTools(workflow: "plan-agent" | "manual"): Promise<string[]> {
    const added: string[] = [];
    await serverPlugin.setup({
      options: { workflow },
      agent: { list: async () => ({ data: [] }) },
      session: {
        get: async () => ({ location: { directory: root } }),
        prompt: async () => ({}),
        hook: async () => ({ dispose: async () => {} }),
      },
      tool: {
        transform: async (apply: (tools: any) => void) => {
          apply({ add: (tool: { name: string }) => added.push(tool.name) });
          return { dispose: async () => {} };
        },
      },
    } as never);
    return added;
  }

  /** Run `fn` with PLANNOTATOR_AGENT_TOOL set (or unset), restoring it after. */
  async function withAgentToolEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const saved = process.env.PLANNOTATOR_AGENT_TOOL;
    if (value === undefined) delete process.env.PLANNOTATOR_AGENT_TOOL;
    else process.env.PLANNOTATOR_AGENT_TOOL = value;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.PLANNOTATOR_AGENT_TOOL;
      else process.env.PLANNOTATOR_AGENT_TOOL = saved;
    }
  }

  // Failure caught: the tool registered only for some workflows, or setup
  // wiring that never reaches it, once the user turned it on.
  for (const workflow of ["plan-agent", "manual"] as const) {
    test(`${workflow}: plugin setup registers the plannotator tool when it is turned on`, async () => {
      expect(await withAgentToolEnv("1", () => setupAddedTools(workflow))).toContain(PLANNOTATOR_TOOL_NAME);
    });
  }

  // Failure caught: the owner's default (off on OpenCode 2) regresses, or the
  // config key / env var stops deciding it. PLANNOTATOR_DATA_DIR is the
  // sandbox beforeEach set up, so config.json here is a temp file.
  test("off by default; agentTool in config.json turns it on; the env var wins over the file", async () => {
    await withAgentToolEnv(undefined, async () => {
      expect(await setupAddedTools("plan-agent")).not.toContain(PLANNOTATOR_TOOL_NAME);
      writeFileSync(path.join(process.env.PLANNOTATOR_DATA_DIR!, "config.json"), JSON.stringify({ agentTool: true }));
      expect(await setupAddedTools("manual")).toContain(PLANNOTATOR_TOOL_NAME);
    });
    expect(await withAgentToolEnv("0", () => setupAddedTools("manual"))).not.toContain(PLANNOTATOR_TOOL_NAME);
  });
});

describe("calls answered without opening anything", () => {
  test("invalid input, reply, and a subagent's last are refused and launch nothing", async () => {
    const host = makeHost(root, { parents: { ses_child: "ses_a" } });
    const launch = mock(host.toolDeps.launch);
    const deps = { ...host.toolDeps, launch };

    expect(await runPlannotatorTool({ action: "annotate" }, { sessionID: "ses_a" }, deps)).toContain("Invalid plannotator call");
    expect(await runPlannotatorTool({ action: "reply", session: "pn-abcdef", comment: "c1", text: "done" }, { sessionID: "ses_a" }, deps))
      .toContain("Invalid plannotator call");
    // `last` reads the main session's messages, which a subagent did not write.
    expect(await runPlannotatorTool({ action: "last" }, { sessionID: "ses_child" }, deps)).toBe(PLANNOTATOR_TOOL_SUBAGENT_LAST_TEXT);
    expect(launch).not.toHaveBeenCalled();
  });

  test("list with nothing open, and close of an id this session never opened", async () => {
    const host = makeHost(root);
    expect(await runPlannotatorTool({ action: "list" }, { sessionID: "ses_a" }, host.toolDeps))
      .toBe("No open Plannotator reviews from this conversation.");
    expect(await runPlannotatorTool({ action: "close", session: "pn-abcdef" }, { sessionID: "ses_a" }, host.toolDeps))
      .toContain("No open Plannotator review pn-abcdef from this conversation");
  });

  // Failure caught: `close all` reporting a plan review it can never close
  // (noise the agent may act on); an explicit plan id still explains why.
  test("close all skips plan reviews silently; an explicit plan id says why", async () => {
    const host = makeHost(root);
    const plan = host.registry.begin("ses_a", "plan", "Plan");
    expect(await runPlannotatorTool({ action: "close", session: "all" }, { sessionID: "ses_a" }, host.toolDeps))
      .toBe("No open Plannotator reviews from this conversation to close.");
    expect(await runPlannotatorTool({ action: "close", session: plan.launch.id }, { sessionID: "ses_a" }, host.toolDeps))
      .toContain(`Not closed: Plan (${plan.launch.id}) is a plan review`);
    plan.end();
  });

  // Failure caught: a nested subagent's reviews owned by its own session
  // (decision delivered where nobody reads it, invisible to the main agent).
  test("a subagent's session resolves to its root session", async () => {
    const host = makeHost(root, { parents: { ses_grandchild: "ses_child", ses_child: "ses_a" } });
    expect(await resolveRootSession(host.ctx, "ses_grandchild")).toEqual({ root: "ses_a", subagent: true });
    expect(await resolveRootSession(host.ctx, "ses_a")).toEqual({ root: "ses_a", subagent: false });
  });
});

describe("tool arguments", () => {
  // Failure caught: a target with spaces split into prose words, or a review
  // base/directory that parseReviewArgs would split.
  test("an annotate target stays one argument; review words are quoted for the string parser", () => {
    const annotate = toolLaunchRequest({ action: "annotate", target: "my notes.md", gate: true, options: { markdown: true } });
    expect(annotate).toMatchObject({ ok: true, command: "plannotator-annotate" });
    if (!annotate.ok) throw new Error("unreachable");
    expect(annotate.annotateArgs).toMatchObject({ filePath: "my notes.md", rawFilePath: "my notes.md", gate: true, renderMarkdown: true });

    const review = toolLaunchRequest({ action: "review", target: "/tmp/my repo", options: { base: "main" } });
    expect(review).toEqual({ ok: true, command: "plannotator-review", rawArgs: '--base main "/tmp/my repo"' });
    expect(quoteReviewWord(`it's "x" y`)).toBeNull();
  });

  test("slash-command subjects skip flag values", () => {
    expect(commandSubject("plannotator-review", "--base main")).toEqual({ kind: "review", subject: "local changes" });
    expect(commandSubject("plannotator-review", "https://github.com/o/r/pull/12")).toEqual({ kind: "review", subject: "PR #12" });
    expect(commandSubject("plannotator-annotate", "docs/spec.md --gate")).toEqual({ kind: "annotate", subject: "spec.md" });
  });
});

describe.skipIf(isWindows)("the tool through the real launch path (stub CLI)", () => {
  // Failure caught: the tool waiting on the whole review (it must return once
  // the page is up), a target re-split, a decision that never names the
  // session id, or one delivered to another session.
  test("annotate opens, returns at once with the session id and url, and the decision arrives later", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "current");
    const host = makeHost(root);

    const text = await runPlannotatorTool({ action: "annotate", target: "my notes.md", gate: true }, { sessionID: "ses_a" }, host.toolDeps);
    const id = sessionIdOf(text);
    expect(text).toContain("Opened my notes.md in Plannotator: http://localhost:");
    expect(host.prompts).toHaveLength(0);

    const [run] = readArgv(root, "current");
    expect(run!.argv).toEqual(["annotate", "my notes.md", "--json", "--gate"]);
    expect(run!.token?.length).toBeGreaterThanOrEqual(32);

    // list sees it (with the server's unsent count); another session does not.
    const list = await runPlannotatorTool({ action: "list" }, { sessionID: "ses_a" }, host.toolDeps);
    expect(list).toContain(`${id} · annotate · my notes.md · http://localhost:`);
    expect(list).toContain("open · unsent: 2");
    expect(await runPlannotatorTool({ action: "list" }, { sessionID: "ses_b" }, host.toolDeps))
      .toBe("No open Plannotator reviews from this conversation.");
    expect(await runPlannotatorTool({ action: "close", session: id }, { sessionID: "ses_b" }, host.toolDeps))
      .toContain(`No open Plannotator review ${id}`);

    await decide(portOf(text), { decision: "annotated", feedback: "Tighten the intro.", annotationCount: 2 });
    const delivered = await waitFor(() => host.prompts[0]);
    expect(delivered.sessionID).toBe("ses_a");
    expect(delivered.text.split("\n")[0]).toBe(`Plannotator: my notes.md (${id}) — Feedback · 2 comments.`);
    expect(delivered.text).toContain("Tighten the intro.");
    await waitFor(() => host.registry.openFor("ses_a").length === 0);
  }, 30_000);

  // Failure caught: a gate the agent opened that is approved with nothing
  // attached sends no message, leaving the agent waiting forever.
  test("a bare approval of a gate the tool opened is delivered", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "current");
    const host = makeHost(root);
    const text = await runPlannotatorTool({ action: "annotate", target: "notes.md", gate: true }, { sessionID: "ses_a" }, host.toolDeps);
    await decide(portOf(text), { decision: "approved" });
    const delivered = await waitFor(() => host.prompts[0]);
    expect(delivered.text).toBe(`Plannotator: notes.md (${sessionIdOf(text)}) — Approved.`);
  }, 30_000);

  // Failure caught (a real report): two open reviews of a QUESTIONS.md in
  // different folders, and a bare approval headed only "QUESTIONS.md", so the
  // agent acted on the other file. Each decision must name its own full path.
  test("two same-named files: subjects are told apart and each decision names its own path", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "targets");
    for (const folder of ["releases-2026-09-20", "releases-2026-10-04"]) {
      mkdirSync(path.join(root, folder));
      writeFileSync(path.join(root, folder, "QUESTIONS.md"), "# Q\n");
    }
    const host = makeHost(root);
    const oldText = await runPlannotatorTool({ action: "annotate", target: "releases-2026-09-20/QUESTIONS.md", gate: true }, { sessionID: "ses_a" }, host.toolDeps);
    const newText = await runPlannotatorTool({ action: "annotate", target: "releases-2026-10-04/QUESTIONS.md", gate: true }, { sessionID: "ses_a" }, host.toolDeps);
    const oldPath = path.join(root, "releases-2026-09-20", "QUESTIONS.md");
    const newPath = path.join(root, "releases-2026-10-04", "QUESTIONS.md");
    expect(oldText).toContain(`Target: ${oldPath}`);
    expect(newText).toContain(`Target: ${newPath}`);
    expect(newText).toContain("Opened releases-2026-10-04/QUESTIONS.md in Plannotator");

    // The record's target (the CLI's) is named; without one, the ready line's.
    await decide(portOf(oldText), { decision: "annotated", feedback: "Fix Q1.", annotationCount: 1, target: oldPath });
    await waitFor(() => host.prompts[0]);
    await decide(portOf(newText), { decision: "approved" });
    const approval = await waitFor(() => host.prompts[1]);
    expect(host.prompts[0]!.text).toContain(`Target: ${oldPath}`);
    expect(approval.text).toBe(`Plannotator: releases-2026-10-04/QUESTIONS.md (${sessionIdOf(newText)}) — Approved.\nTarget: ${newPath}`);
  }, 30_000);

  // Failure caught: a list of files opened as one file, split again, reordered,
  // unnamed in the result/list/heading, or an older CLI's ambiguity error
  // shown raw instead of the update text.
  test("a list target opens one bundle review, named, listed, and headed", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "current");
    const host = makeHost(root);
    const text = await runPlannotatorTool({ action: "annotate", target: ["notes.md", "my notes.md"] }, { sessionID: "ses_a" }, host.toolDeps);
    const id = sessionIdOf(text);
    expect(text).toContain("Opened 2 files: notes.md, my notes.md in Plannotator: http://localhost:");
    expect(readArgv(root, "current")[0]!.argv).toEqual(["annotate", "notes.md", "my notes.md", "--json"]);
    expect(await runPlannotatorTool({ action: "list" }, { sessionID: "ses_a" }, host.toolDeps))
      .toContain(`${id} · annotate · 2 files: notes.md, my notes.md · http://localhost:`);

    await decide(portOf(text), { decision: "annotated", feedback: "Both need work.", annotationCount: 3 });
    const delivered = await waitFor(() => host.prompts[0]);
    expect(delivered.text.split("\n")[0]).toBe(`Plannotator: 2 files: notes.md, my notes.md (${id}) — Feedback · 3 comments.`);
    expect(delivered.text).toContain("notes.md, my notes.md");
    expect(delivered.text).toContain("Both need work.");

    process.env.PLANNOTATOR_BIN = writeStub(root, "nobundle");
    expect(await runPlannotatorTool({ action: "annotate", target: ["notes.md", "my notes.md"] }, { sessionID: "ses_a" }, host.toolDeps))
      .toBe(PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT);
  }, 30_000);

  // Failure caught (#1719): feedback on a PR that is not a platform post (only
  // description notes, so zero line annotations) headed or framed as a posted
  // review; or a real platform post framed as a change request.
  test("review headings follow the platform flag, never the annotation count", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "current");
    const host = makeHost(root);
    const pr = "https://github.com/o/r/pull/12";
    const text = await runPlannotatorTool({ action: "review", target: pr }, { sessionID: "ses_a" }, host.toolDeps);
    const id = sessionIdOf(text);
    await decide(portOf(text), { decision: "annotated", approved: false, isPRMode: true, platform: false, feedback: "Clarify the description.", annotationCount: 0 });
    const delivered = await waitFor(() => host.prompts[0]);
    expect(delivered.text.split("\n")[0]).toBe(`Plannotator: PR #12 (${id}) — Changes requested.`);
    expect(delivered.text).toContain("Clarify the description.");
    expect(delivered.text.trim().endsWith("Clarify the description.")).toBe(false); // the change-request suffix follows

    const posted = await runPlannotatorTool({ action: "review", target: pr }, { sessionID: "ses_a" }, host.toolDeps);
    await decide(portOf(posted), { decision: "annotated", approved: false, isPRMode: true, platform: true, feedback: "Review posted to GitHub.", annotationCount: 2 });
    const second = await waitFor(() => host.prompts[1]);
    // The shared outcome, so Pi and OpenCode name the platform post the same way.
    expect(second.text).toBe(`Plannotator: PR #12 (${sessionIdOf(posted)}) — ${PLANNOTATOR_OUTCOME_REVIEW_POSTED}.\n\nReview posted to GitHub.`);
  }, 30_000);

  // Failure caught: a subagent's review owned by (and delivered to) the
  // subagent's own session, where nobody reads it after it finished.
  test("a subagent's review belongs to the root session: decision there, listed there", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "current");
    const host = makeHost(root, { parents: { ses_child: "ses_a" } });
    const text = await runPlannotatorTool({ action: "review" }, { sessionID: "ses_child" }, host.toolDeps);
    const id = sessionIdOf(text);
    expect(await runPlannotatorTool({ action: "list" }, { sessionID: "ses_a" }, host.toolDeps)).toContain(`${id} · review · local changes`);
    await decide(portOf(text), { decision: "annotated", approved: false, feedback: "Rename x.", annotationCount: 1 });
    const delivered = await waitFor(() => host.prompts[0]);
    expect(delivered.sessionID).toBe("ses_a");
    expect(delivered.text.split("\n")[0]).toBe(`Plannotator: local changes (${id}) — Changes requested · 1 comment.`);
  }, 30_000);

  // Failure caught (0.28.5 smoke, live on OpenCode 2.0.22): a BACKGROUND
  // subagent's review posted its session-URL notice into the root session,
  // which was idle. The pending row was then promoted ALONE as a model turn
  // when the root next woke, and the model answered "Plannotator session
  // ready: <url>". The notice belongs to the calling session, mid-turn in its
  // own tool call; the root receives only the decision.
  test("a subagent's notice goes to its own session, never the root that gets the decision", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "current");
    const host = makeHost(root, { parents: { ses_child: "ses_a" } });
    const text = await runPlannotatorTool({ action: "annotate", target: "notes.md" }, { sessionID: "ses_child" }, host.toolDeps);
    const url = `http://localhost:${portOf(text)}`;
    expect(host.notices).toEqual([{ sessionID: "ses_child", text: `Plannotator session ready: ${url}` }]);

    await decide(portOf(text), { decision: "annotated", feedback: "Tighten the intro.", annotationCount: 1 });
    const delivered = await waitFor(() => host.prompts[0]);
    expect(delivered.sessionID).toBe("ses_a");
    expect(delivered.delivery).toBe("queue");
    expect(host.notices.some((notice) => notice.sessionID === "ses_a")).toBe(false);
  }, 30_000);

  // Unchanged for the main session: its own tool call is the open turn the
  // notice is promoted in.
  test("a main-session tool call posts its notice into that session", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "current");
    const host = makeHost(root);
    const text = await runPlannotatorTool({ action: "annotate", target: "notes.md" }, { sessionID: "ses_a" }, host.toolDeps);
    expect(host.notices).toEqual([{ sessionID: "ses_a", text: `Plannotator session ready: http://localhost:${portOf(text)}` }]);
    await decide(portOf(text), { decision: "dismissed" });
  }, 30_000);

  // Failure caught: a URL that arrives after the tool answered "starting"
  // lands in a session whose turn may be over: the same idle-session leak.
  test("a server that comes up after the starting answer posts no notice", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "slowready");
    const host = makeHost(root);
    const text = await runPlannotatorTool(
      { action: "annotate", target: "notes.md" },
      { sessionID: "ses_a" },
      { ...host.toolDeps, readyWaitMs: { review: 100, other: 100 } },
    );
    expect(text).toContain("Plannotator is starting for notes.md");
    const id = sessionIdOf(text);
    const launch = await waitFor(() => host.registry.openFor("ses_a").find((open) => open.id === id && open.port));
    // The URL is known (the tool's list shows it), but nothing was posted.
    await Bun.sleep(100);
    expect(host.notices).toEqual([]);
    await decide(launch.port!, { decision: "dismissed" });
  }, 30_000);

  // Failure caught: the agent told "starting, wait" and then never told the
  // review did not open, so it waits forever.
  test("a failure after the starting answer is sent to the session", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "slowfail");
    const host = makeHost(root);
    const text = await runPlannotatorTool(
      { action: "annotate", target: "missing.md" },
      { sessionID: "ses_a" },
      { ...host.toolDeps, readyWaitMs: { review: 100, other: 100 } },
    );
    expect(text).toContain("Plannotator is starting for missing.md");
    const id = sessionIdOf(text);
    const delivered = await waitFor(() => host.prompts[0]);
    expect(delivered.sessionID).toBe("ses_a");
    expect(delivered.text.split("\n")[0]).toBe(`Plannotator: missing.md (${id}) — Did not open.`);
    expect(delivered.text).toContain("File not found: missing.md");
  }, 30_000);

  // Failure caught: close that deletes nothing but leaves the review open, a
  // closed review that still sends a decision, or one that keeps listing.
  test("close goes through /api/host/close with the launch token; nothing is delivered", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "current");
    const host = makeHost(root);
    const text = await runPlannotatorTool({ action: "review" }, { sessionID: "ses_a" }, host.toolDeps);
    const id = sessionIdOf(text);
    expect(text).toContain("Opened local changes in Plannotator");

    const closed = await runPlannotatorTool({ action: "close", session: id }, { sessionID: "ses_a" }, host.toolDeps);
    expect(closed).toContain(`Closed local changes (${id}): 2 unsent comments saved as a draft.`);
    expect(await runPlannotatorTool({ action: "list" }, { sessionID: "ses_a" }, host.toolDeps))
      .toBe("No open Plannotator reviews from this conversation.");
    await waitFor(() => host.registry.openFor("ses_a").length === 0 && readArgv(root, "current").length === 1);
    await Bun.sleep(200);
    expect(host.prompts).toHaveLength(0);
  }, 30_000);

  // Failure caught: TERM sent to a server that is not proven an older
  // Plannotator (remote mode turns host close off: the review must survive).
  test("host close turned off leaves the review running; an older CLI is stopped", async () => {
    const errors = spyOn(console, "error");
    try {
    process.env.PLANNOTATOR_BIN = writeStub(root, "disabled");
    const host = makeHost(root);
    const text = await runPlannotatorTool({ action: "annotate", target: "notes.md" }, { sessionID: "ses_a" }, host.toolDeps);
    const id = sessionIdOf(text);
    const refused = await runPlannotatorTool({ action: "close", session: id }, { sessionID: "ses_a" }, host.toolDeps);
    // Not remote mode: say what is true (a server started without a host token).
    expect(refused).toContain(`Could not close notes.md (${id}): its server has host close turned off`);
    const port = portOf(text);
    expect((await fetch(`http://127.0.0.1:${port}/nothing`)).status).toBe(404);
    await decide(port, { decision: "dismissed" });

    process.env.PLANNOTATOR_BIN = writeStub(root, "disabled-remote");
    const remote = await runPlannotatorTool({ action: "annotate", target: "notes.md" }, { sessionID: "ses_a" }, host.toolDeps);
    const remoteId = sessionIdOf(remote);
    expect(await runPlannotatorTool({ action: "close", session: remoteId }, { sessionID: "ses_a" }, host.toolDeps))
      .toContain(`Could not close notes.md (${remoteId}): it runs in remote mode`);
    await decide(portOf(remote), { decision: "dismissed" });

    process.env.PLANNOTATOR_BIN = writeStub(root, "older");
    const older = await runPlannotatorTool({ action: "annotate", target: "notes.md" }, { sessionID: "ses_a" }, host.toolDeps);
    const olderId = sessionIdOf(older);
    const stopped = await runPlannotatorTool({ action: "close", session: olderId }, { sessionID: "ses_a" }, host.toolDeps);
    expect(stopped).toContain(`Closed notes.md (${olderId}): any unsent comments stay saved as a draft.`);
    // The close hides it from the list at once; the stopped child exits a
    // moment later, and only then is its exit logged. Wait for that line.
    expect(host.registry.openFor("ses_a")).toHaveLength(0);
    const closedLine = `The agent closed notes.md (${olderId})`;
    await waitFor(() => errors.mock.calls.some((call) => String(call[0]).includes(closedLine)));
    const olderPort = portOf(older);
    await expect(fetch(`http://127.0.0.1:${olderPort}/nothing`)).rejects.toThrow();
    expect(host.prompts).toHaveLength(0);
    // The agent's own close is not logged as a CLI failure.
    const logged = errors.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => /exited with code/.test(line))).toBe(false);
    expect(logged.some((line) => line.includes(`The agent closed notes.md (${olderId})`))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  }, 30_000);

  // Failure caught: a startup error reported as "opened", or swallowed.
  test("the CLI's startup error is the tool result", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "fail");
    const host = makeHost(root);
    const text = await runPlannotatorTool({ action: "annotate", target: "missing.md" }, { sessionID: "ses_a" }, host.toolDeps);
    expect(text).toBe("Plannotator could not start: File not found: missing.md");
    await waitFor(() => host.registry.openFor("ses_a").length === 0);
    // The tool result reports it; no slash-command failure notice as well.
    expect(host.notices).toHaveLength(0);
  }, 30_000);

  // Failure caught: slash-command reviews missing from list ("opened in this
  // conversation" covers them) or their decisions not naming the id.
  test("a slash command's review is listed and its decision names its id", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "current");
    const host = makeHost(root);
    const running = runNativeCommand("plannotator-annotate", { sessionID: "ses_a", prompt: { text: "notes.md" } }, host.nativeDeps);
    const launch = await waitFor(() => host.registry.openFor("ses_a").find((entry) => entry.port));
    const list = await runPlannotatorTool({ action: "list" }, { sessionID: "ses_a" }, host.toolDeps);
    expect(list).toContain(`${launch.id} · annotate · notes.md`);
    await decide(launch.port!, { decision: "annotated", feedback: "One note." });
    await running;
    expect(host.prompts[0]!.text.split("\n")[0]).toBe(`Plannotator: notes.md (${launch.id}) — Feedback.`);
    expect(host.registry.openFor("ses_a")).toHaveLength(0);
  }, 30_000);

  // Failure caught: `. notes.md` opens notes.md alone (the CLI drops the
  // stray "."), but the subject came from the typed words: "2 files: ., notes.md".
  test("a slash command is named by what the CLI opened, not the typed words", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "targets");
    const host = makeHost(root);
    const running = runNativeCommand("plannotator-annotate", { sessionID: "ses_a", prompt: { text: ". notes.md" } }, host.nativeDeps);
    const launch = await waitFor(() => host.registry.openFor("ses_a").find((entry) => entry.port));
    expect(launch.subject).toBe("notes.md");
    expect(await runPlannotatorTool({ action: "list" }, { sessionID: "ses_a" }, host.toolDeps)).toContain(`${launch.id} · annotate · notes.md`);
    await decide(launch.port!, { decision: "annotated", feedback: "One note." });
    await running;
    expect(host.prompts[0]!.text.split("\n").slice(0, 2)).toEqual([
      `Plannotator: notes.md (${launch.id}) — Feedback.`,
      `Target: ${path.join(root, "notes.md")}`,
    ]);
  }, 30_000);

  // Failure caught: the tool's bundle `Files:` line naming the words it was
  // given (bare names) while the slash command's names absolute paths.
  test("a tool bundle names files in its subject and full paths in its Files and Target lines", async () => {
    process.env.PLANNOTATOR_BIN = writeStub(root, "targets");
    const host = makeHost(root);
    const text = await runPlannotatorTool({ action: "annotate", target: ["notes.md", "my notes.md"] }, { sessionID: "ses_a" }, host.toolDeps);
    const id = sessionIdOf(text);
    const files = [path.join(root, "notes.md"), path.join(root, "my notes.md")];
    expect(text).toContain("Opened 2 files: notes.md, my notes.md in Plannotator: http://localhost:");
    expect(text).toContain(`Targets:\n- ${files[0]}\n- ${files[1]}`);

    await decide(portOf(text), { decision: "annotated", feedback: "Both need work.", annotationCount: 3, target: files });
    const delivered = await waitFor(() => host.prompts[0]);
    expect(delivered.text.split("\n")[0]).toBe(`Plannotator: 2 files: notes.md, my notes.md (${id}) — Feedback · 3 comments.`);
    expect(delivered.text).toContain(`Files: ${files.join(", ")}`);
  }, 30_000);
});

describe("host close answers", () => {
  // Failure caught: an older CLI's app page or an uncoded 404 read as closed,
  // or a coded "turned off" 404 read as older (which would TERM it).
  test("only a JSON count is a close; only an uncoded 404 or the app page is older", () => {
    expect(classifyHostCloseAnswer({ status: 200, text: '{"unsentAnnotations":3}' })).toEqual({ kind: "closed", unsent: 3 });
    expect(classifyHostCloseAnswer({ status: 200, text: "<!doctype html><html>" })).toEqual({ kind: "older" });
    expect(classifyHostCloseAnswer({ status: 404, text: '{"error":"Not found"}' })).toEqual({ kind: "older" });
    expect(classifyHostCloseAnswer({ status: 404, text: '{"error":"Not found","code":"host_control_disabled"}' })).toEqual({ kind: "disabled" });
    expect(classifyHostCloseAnswer({ status: 409, text: '{"code":"already_decided"}' })).toEqual({ kind: "decided" });
    expect(classifyHostCloseAnswer({ status: 401, text: '{"error":"x"}' })).toEqual({ kind: "refused", status: 401 });
    expect(classifyHostCloseAnswer(null)).toEqual({ kind: "unreachable" });
  });
});
