/**
 * Asking the agent about a guide, against the FAKE ACP agent
 * (tests/helpers/fake-acp-agent.ts): the extension's ACP client starts it, it starts
 * the relay from `session/new` or `session/load`, and calls `show_answer`.
 * No real agent ever runs here.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE } from "@plannotator/acp-client/agents";
import { startRelayHost, type RelayHost } from "../mcp/relay-host";
import { GuideAskSession, sessionsToLoad, type AskQuestion, type AskSessionDeps, type SavedSession } from "./session";
import { buildAskPrompt, type AskGuideContext } from "./prompt";
import type { AskAbout } from "./answers";

const FAKE_AGENT = join(import.meta.dir, "..", "..", "..", "..", "..", "tests", "helpers", "fake-acp-agent.ts");
const RELAY_SCRIPT = join(import.meta.dir, "..", "mcp", "relay-script.ts");

let work: string;
let relay: RelayHost;
let n = 0;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "pn-guides-ask-"));
  relay = await startRelayHost({ serverVersion: "test" });
});

afterAll(async () => {
  await relay.close();
  rmSync(work, { recursive: true, force: true });
});

const PAGE = `<p>Before, <a href="symbol:deliver">deliver</a> retried at once. Lines <a href="code:src/deliver.ts#L2-L3">2–3</a> now back off.</p><svg><rect data-link="chapter:1"/></svg><script>document.body.dataset.ran='1'</script>`;
const about: AskAbout = { kind: "selection", chapter: 0, chapterTitle: "The retry budget", path: "src/deliver.ts", side: "head", lines: { start: 2, end: 3 }, code: "export function deliver() {\n  return computeBackoff(1);" };

function guideContext(root: string): AskGuideContext {
  return {
    title: "Retry failed webhook deliveries",
    intent: "Deliveries retry with backoff.",
    chapters: [{ title: "The retry budget", overview: "A policy decides how often to retry.", files: ["src/deliver.ts"] }],
    changeLabel: "the local changes on feat/retries",
    cwd: root,
    baseRev: "3f2c1a9000000000000000000000000000000000",
    rawPatch: "diff --git a/src/deliver.ts b/src/deliver.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/deliver.ts\n@@ -0,0 +1,3 @@\n+import x;\n+export function deliver() {\n+  return computeBackoff(1);\n",
  };
}

function world(script: Record<string, unknown>, options: { saved?: SavedSession[]; idleMs?: number; choose?: string } = {}) {
  const root = join(work, `repo-${++n}`);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "deliver.ts"), "import x;\nexport function deliver() {\n  return computeBackoff(1);\n}\n");
  const scriptPath = join(root, "script.json");
  const logPath = join(root, "agent.log");
  writeFileSync(scriptPath, JSON.stringify({ steps: [], ...script }));
  const permissions: string[] = [];
  const deps: AskSessionDeps = {
    relay,
    agent: CLAUDE_CODE,
    agentLaunch: (cwd) => ({ command: process.execPath, args: [FAKE_AGENT], cwd, env: { FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath } }),
    mcpServer: { command: process.execPath, args: [RELAY_SCRIPT] },
    clientInfo: { name: "plannotator-vscode", title: "Plannotator", version: "test" },
    linkHooks: {
      chapterCount: 1,
      fileExists: async (p) => existsSync(join(root, p)),
      resolveSymbol: async (name) => (name === "deliver" ? { status: "found" } : { status: "missing" }),
    },
    requestPermission: async (pending) => {
      permissions.push(pending.title);
      return { optionId: options.choose ?? "allow-once" };
    },
    ...(options.idleMs && { idleMs: options.idleMs }),
  };
  const session = new GuideAskSession({ guideId: "g1", cwd: root, saved: options.saved ?? [] }, deps);
  const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const ctx = guideContext(root);
  const question = (answerId: string, text: string, kind: "new" | "followUp" = "new"): AskQuestion => ({
    answerId,
    agent: { id: "claude-code", label: "Claude Code", model: { id: "sonnet", label: "Sonnet" }, effort: { id: "low", label: "Low" } },
    autoApprove: false,
    prompt: (m) => buildAskPrompt({
      mode: kind === "followUp" ? "followUp" : !m.firstInSession ? "next" : m.session,
      ...(m.loadedFrom && { loadedFrom: m.loadedFrom }),
      question: text,
      about,
      guide: ctx,
    }),
  });
  return { root, session, log, permissions, question };
}

const showAnswer = (title: string, html = PAGE) => ({ mcp: { name: "show_answer", args: { title, html } } });

describe("which session answers", () => {
  it("loads nothing when the agent cannot load sessions, and the ask session before the guide's when it can", () => {
    const saved: SavedSession[] = [{ id: "g", from: "guide" }, { id: "a", from: "asks" }, { id: "a", from: "asks" }];
    expect(sessionsToLoad({ loadSession: false }, saved)).toEqual([]);
    expect(sessionsToLoad({}, saved)).toEqual([]);
    expect(sessionsToLoad(null, saved)).toEqual([]);
    expect(sessionsToLoad({ loadSession: true }, saved).map((s) => s.id)).toEqual(["a", "g"]);
    expect(sessionsToLoad({ loadSession: true }, [])).toEqual([]);
  });
});

describe("asking the agent over ACP", () => {
  it("fresh session: the guide goes in the prompt, a refused page is fixed, the answer page arrives with its scripts", async () => {
    const w = world({
      askTurns: [[
        { say: "Looking at the delivery loop." },
        { tool: { title: "Read src/deliver.ts", locations: [{ path: "src/deliver.ts", line: 2 }] } },
        showAnswer("Retries back off now", `${PAGE}<a href="chapter:7">x</a>`),
        { usage: { cost: 0.03 } },
        showAnswer("Retries back off now"),
      ]],
    }, { saved: [{ id: "guide-session", from: "guide" }] });
    const run = w.session.ask(w.question("ans-1-aaaa", "Why did this change?"));
    const state = await run.done;
    expect(state.status).toBe("answered");
    expect(state.session).toBe("fresh");
    expect(state.answer?.title).toBe("Retries back off now");
    expect(state.answer?.html).toContain("<script>");
    expect(state.cost?.amount).toBeCloseTo(0.03);
    const log = w.log();
    expect(log.some((e) => e.event === "loadSession")).toBe(false);
    expect(log.find((e) => e.event === "mcpReady")?.tools).toEqual(["show_answer"]);
    expect(log.find((e) => e.event === "mcpReady")?.instructions).toContain("show_answer");
    const prompt = log.find((e) => e.event === "prompt")?.text as string;
    expect(prompt).toContain("A reviewer is reading a guided review");
    expect(prompt).toContain("Title: Retry failed webhook deliveries");
    expect(prompt).toContain("lines 2–3 of src/deliver.ts (the new version)");
    expect(prompt).toContain("2 | export function deliver() {");
    expect(prompt).toContain("+export function deliver() {");
    expect(prompt).toContain("The question: Why did this change?");
    const calls = log.filter((e) => e.event === "mcpCall");
    expect(calls[0].isError).toBe(true);
    expect(calls[0].text).toContain("chapter:7: the guide has 1 chapter");
    expect(calls[1].isError).toBe(false);
    expect(state.activity.some((a) => a.title === "Drawing the answer")).toBe(true);
    expect(state.activity.some((a) => a.title === "Started a new session with the guide and the code")).toBe(true);
    w.session.dispose();
  });

  it("loads the guide's own session when the agent can, ignores the replay, and counts only this question's cost", async () => {
    const w = world({
      loadSession: true,
      askTurns: [[{ say: "I remember the guide." }, { usage: { cost: 0.53 } }, showAnswer("From memory")]],
    }, { saved: [{ id: "guide-session-42", from: "guide" }] });
    const state = await w.session.ask(w.question("ans-2-aaaa", "What could break?")).done;
    expect(state.status).toBe("answered");
    expect(state.session).toBe("loaded");
    const log = w.log();
    expect(log.find((e) => e.event === "loadSession")?.sessionId).toBe("guide-session-42");
    expect(log.some((e) => e.event === "newSession")).toBe(false);
    expect((log.find((e) => e.event === "prompt")?.text as string)).toContain("Earlier in this session you wrote a guided review of this change");
    expect(JSON.stringify(state.activity)).not.toContain("REPLAYED");
    expect(JSON.stringify(state.activity)).not.toContain("src/replayed.ts");
    expect(state.cost?.amount).toBeCloseTo(0.03);
    expect(w.session.askSessionId).toBe("guide-session-42");
    w.session.dispose();
  });

  it("starts a new session with the guide when the load fails", async () => {
    const w = world({ loadSession: true, loadSessionError: "No conversation found", askTurns: [[showAnswer("Fresh after all")]] }, { saved: [{ id: "gone", from: "guide" }] });
    const state = await w.session.ask(w.question("ans-3-aaaa", "Why?")).done;
    expect(state.status).toBe("answered");
    expect(state.session).toBe("fresh");
    const log = w.log();
    expect(log.some((e) => e.event === "loadSession")).toBe(true);
    expect(log.some((e) => e.event === "newSession")).toBe(true);
    w.session.dispose();
  });

  it("shows the agent's last message as the answer when it never calls show_answer", async () => {
    const w = world({ ignoreMcp: true, steps: [{ say: "Let me look." }, { tool: { title: "Read src/deliver.ts" } }, { say: "It backs off **exponentially** now." }] });
    const state = await w.session.ask(w.question("ans-4-aaaa", "Why?")).done;
    expect(state.status).toBe("text");
    expect(state.text).toBe("It backs off **exponentially** now.");
    expect(state.statusMessage).toContain("answered in text");
    w.session.dispose();
  });

  it("answers a follow-up in the same conversation without starting the agent again", async () => {
    const w = world({ askTurns: [[{ usage: { cost: 0.04 } }, showAnswer("First")], [{ usage: { cost: 0.01 } }, { usage: { cost: 0.02 } }, showAnswer("Second")]] });
    const first = await w.session.ask(w.question("ans-5-aaaa", "Why?")).done;
    expect(first.answer?.title).toBe("First");
    const second = await w.session.ask(w.question("ans-6-aaaa", "And the worker?", "followUp")).done;
    expect(second.answer?.title).toBe("Second");
    // The fake reports each turn's own cost (less than the running total so far): counted per turn.
    expect(second.cost?.amount).toBeCloseTo(0.02);
    const log = w.log();
    expect(log.filter((e) => e.event === "initialize")).toHaveLength(1);
    expect(log.filter((e) => e.event === "newSession")).toHaveLength(1);
    expect((log.filter((e) => e.event === "prompt")[1].text as string)).toContain("follow-up question");
    expect(second.activity.some((a) => a.title === "Same conversation as the last question")).toBe(true);
    w.session.dispose();
  });

  it("forwards permission requests with all options, and allows show_answer's own request without asking", async () => {
    const w = world({
      askTurns: [[
        { permission: { title: "Run git log -p src/deliver.ts", kind: "execute" } },
        { permission: { title: "mcp__plannotator-guide__show_answer", kind: "other", name: "show_answer" } },
        showAnswer("Done"),
      ]],
    });
    const state = await w.session.ask(w.question("ans-7-aaaa", "Why?")).done;
    expect(state.status).toBe("answered");
    expect(w.permissions).toEqual(["Run git log -p src/deliver.ts"]);
    const outcomes = w.log().filter((e) => e.event === "permission").map((e) => e.outcome.optionId);
    expect(outcomes).toEqual(["allow-once", "allow-once"]);
    w.session.dispose();
  });

  it("stops on request and keeps what streamed; one question at a time", async () => {
    const w = world({ pace: 120, askTurns: [[{ say: "Thinking about the backoff " }, { sleep: 1500 }, showAnswer("Too late")]] });
    const run = w.session.ask(w.question("ans-8-aaaa", "Why?"));
    expect(() => w.session.ask(w.question("ans-9-aaaa", "Again?"))).toThrow("Another question");
    while (!run.state.stream) await new Promise((r) => setTimeout(r, 50));
    await run.cancel();
    const state = await run.done;
    expect(state.status).toBe("stopped");
    expect(state.text).toContain("Thinking about the backoff");
    w.session.dispose();
  });

  it("stops the agent when idle, then loads the conversation again for the next question", async () => {
    const w = world({ loadSession: true, askTurns: [[showAnswer("One")], [showAnswer("Two")]] }, { idleMs: 300 });
    await w.session.ask(w.question("ans-10-aaaa", "Why?")).done;
    const firstId = w.session.askSessionId;
    expect(w.session.sessionMode).toBe("fresh");
    await new Promise((r) => setTimeout(r, 800));
    expect(w.session.isAlive).toBe(false);
    const second = await w.session.ask(w.question("ans-11-aaaa", "And then?")).done;
    expect(second.status).toBe("answered");
    expect(second.session).toBe("loaded");
    const log = w.log();
    expect(log.filter((e) => e.event === "initialize")).toHaveLength(2);
    expect(log.find((e) => e.event === "loadSession")?.sessionId).toBe(firstId);
    expect((log.filter((e) => e.event === "prompt")[1].text as string)).toContain("Earlier in this session you answered the reviewer's questions");
    w.session.dispose();
  });
});
