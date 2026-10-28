/**
 * GuideAsks on the vscode mock with the FAKE ACP agent (never a real one):
 * a second question while the first is getting ready is refused cleanly, and
 * a guide or answer deleted while it is being answered is not written back;
 * the question box under the lines (a comment thread) asks, shows the work,
 * opens the answer beside the diff and takes follow-ups.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as vscode from "vscode";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE } from "@plannotator/acp-client/agents";
import { answersPath, listAnswers } from "../ask/answers";
import { startRelayHost, type RelayHost } from "../mcp/relay-host";
import { ReaderModel } from "../reader-model";
import type { LoadedGuide } from "../store";
import { approveAlwaysTarget } from "../trust";
import { GuideAsks, type AsksHost } from "./asks";

const FAKE_AGENT = join(import.meta.dir, "..", "..", "..", "..", "..", "tests", "helpers", "fake-acp-agent.ts");
const RELAY_SCRIPT = join(import.meta.dir, "..", "mcp", "relay-script.ts");
const GUIDE_ID = "1761200000000-retry-failed-webhook-deliveries";
const REPO_KEY = "github.com__northwind__checkout-service";

let work: string;
let relay: RelayHost;
let dataBefore: string | undefined;
const warnings: string[] = [];
const original = { warn: vscode.window.showWarningMessage, info: vscode.window.showInformationMessage };
let confirmDelete: string | undefined = "Delete";

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "pn-guides-asks-"));
  relay = await startRelayHost({ serverVersion: "test" });
  // The extension's `dist/guide-mcp.cjs`, here the relay script run by bun.
  mkdirSync(join(work, "ext", "dist"), { recursive: true });
  writeFileSync(join(work, "ext", "dist", "guide-mcp.cjs"), `require(${JSON.stringify(RELAY_SCRIPT)});\n`);
});

afterAll(async () => {
  await relay.close();
  rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  dataBefore = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = mkdtempSync(join(work, "data-"));
  warnings.length = 0;
  confirmDelete = "Delete";
  (vscode.window as unknown as Record<string, unknown>).showWarningMessage = async (message: string, ...items: unknown[]) => {
    warnings.push(message);
    // The Delete confirm (modal): answered by the test.
    if (items.includes("Delete")) return confirmDelete;
    return undefined;
  };
  (vscode.window as unknown as Record<string, unknown>).showQuickPick = async (items: Array<{ value: string }>) => items.find((i) => i.value === "delete");
  (vscode.window as unknown as Record<string, unknown>).showInformationMessage = async () => undefined;
});

afterEach(() => {
  if (dataBefore === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = dataBefore;
  (vscode.window as unknown as Record<string, unknown>).showWarningMessage = original.warn;
  (vscode.window as unknown as Record<string, unknown>).showInformationMessage = original.info;
});

function world(askTurns: unknown[][], options: { gate?: Promise<void> } = {}) {
  const root = mkdtempSync(join(work, "repo-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "deliver.ts"), "export function deliver() {\n  return 1;\n}\n");
  const scriptPath = join(root, "script.json");
  const logPath = join(root, "agent.log");
  writeFileSync(scriptPath, JSON.stringify({ steps: [], askTurns }));
  const rawPatch = "diff --git a/src/deliver.ts b/src/deliver.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/deliver.ts\n@@ -0,0 +1,3 @@\n+export function deliver() {\n+  return 1;\n+}\n";
  const guide: LoadedGuide = {
    repoKey: REPO_KEY,
    id: GUIDE_ID,
    rawPatch,
    envelope: {
      version: 1, savedAt: 1, label: "local", title: "Retry failed webhook deliveries", engine: "claude",
      guide: { title: "Retry failed webhook deliveries", intent: "Deliveries retry.", sections: [{ title: "The loop", overview: "It backs off.", diffs: [{ file: "src/deliver.ts", summary: "x" }] }] },
      reviewed: [false],
    } as unknown as LoadedGuide["envelope"],
    sidecar: { v: 1, fileTicks: [], focus: {}, agent: { id: CLAUDE_CODE.id, label: CLAUDE_CODE.label } },
  };
  const model = new ReaderModel(guide);
  const reader = { model, sides: { gitRoot: root, baseRev: "HEAD", head: { kind: "fs" as const, root }, moved: false } };
  const shown: unknown[] = [];
  const panels: Array<{ title: string; preserveFocus?: boolean }> = [];
  const host: AsksHost = {
    context: { globalState: { get: () => undefined, update: async () => {} }, extensionUri: vscode.Uri.file(join(work, "ext")) } as unknown as vscode.ExtensionContext,
    version: "test",
    runner: async () => ({ code: 0, stdout: "9b07e4d\n", stderr: "" }),
    log: () => {},
    reader: () => reader,
    openGuide: async () => {},
    openLink: async () => {},
    relayHost: async () => relay,
    agentById: (id) => (id === CLAUDE_CODE.id ? CLAUDE_CODE : null),
    defaultChoice: () => ({ id: CLAUDE_CODE.id, label: CLAUDE_CODE.label }),
    ensureLaunch: async () => {
      await options.gate;
      return { ok: true as const, source: "path" as const, command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath } };
    },
    pickModel: async () => null,
    notifyPermission: async () => null,
    autoApprove: () => false,
    approveAlways: () => {},
    signIn: async () => {},
    createPanel: (title, _column, _onLink, preserveFocus) => (panels.push({ title, preserveFocus }), {
      panel: { title: "", viewColumn: 2, visible: true, reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }) } as unknown as vscode.WebviewPanel,
      host: { show: (s: unknown) => shown.push(s) } as unknown as import("./webview-host").WebviewHost,
    }),
    persists: () => true,
    updateChapterView: () => {},
    setAnswering: () => {},
  };
  const asks = new GuideAsks(host);
  const sidecarPath = join(process.env.PLANNOTATOR_DATA_DIR!, "guides", REPO_KEY, "vscode", `${GUIDE_ID}.json`);
  const about = { kind: "file" as const, chapter: 0, chapterTitle: "The loop", path: "src/deliver.ts", side: "head" as const };
  const ask = (q: string) => (asks as unknown as { ask(g: LoadedGuide, a: typeof about, q: string, o: object): Promise<void> }).ask(guide, about, q, {});
  return { asks, guide, ask, shown, panels, root, sidecarPath, log: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

const answer = (title: string) => ({ mcp: { name: "show_answer", args: { title, html: "<p>ok</p>" } } });
const waitFor = async (check: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("asking from VS Code", () => {
  it("refuses a second question while the first is still getting ready, and leaves no stale record", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w = world([[answer("One")]], { gate });
    const first = w.ask("Why did this change?");
    // The first is waiting on its launch (nothing saved yet); the second comes in now.
    await w.ask("What could break?");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("getting ready to answer another question");
    open();
    await first;
    await waitFor(() => listAnswers(REPO_KEY, GUIDE_ID).some((r) => r.status === "answered"));
    const all = listAnswers(REPO_KEY, GUIDE_ID);
    expect(all.map((r) => r.question)).toEqual(["Why did this change?"]);
    // The slot is free again: the next question goes through.
    await w.ask("And then?");
    expect(warnings).toHaveLength(1);
    await waitFor(() => listAnswers(REPO_KEY, GUIDE_ID).filter((r) => r.status === "answered").length === 2);
    w.asks.dispose();
  });

  it("does not write back an answer, or the sidecar, when the guide is deleted while it is being answered", async () => {
    const w = world([[{ say: "Thinking…" }, { sleep: 800 }, answer("Too late")]]);
    await w.ask("Why did this change?");
    await waitFor(() => w.log().some((e) => e.event === "prompt"));
    w.asks.onGuideDeleted(REPO_KEY, GUIDE_ID);
    expect(existsSync(answersPath(REPO_KEY, GUIDE_ID))).toBe(false);
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(answersPath(REPO_KEY, GUIDE_ID))).toBe(false);
    expect(existsSync(w.sidecarPath)).toBe(false);
    w.asks.dispose();
  });

  it("asks before deleting an answer; a cancelled confirm keeps it", async () => {
    const w = world([[answer("Kept")]]);
    await w.ask("Why did this change?");
    await waitFor(() => listAnswers(REPO_KEY, GUIDE_ID).some((r) => r.status === "answered"));
    const [record] = listAnswers(REPO_KEY, GUIDE_ID);
    confirmDelete = undefined;
    await w.asks.menu(record.id);
    expect(warnings.some((m) => m.startsWith("Delete the answer to “Why did this change?”"))).toBe(true);
    expect(listAnswers(REPO_KEY, GUIDE_ID).map((r) => r.id)).toEqual([record.id]);
    // "delete" is not an action a message can ask for directly: it still asks.
    warnings.length = 0;
    await w.asks.menu(record.id, "delete");
    expect(warnings).toHaveLength(1);
    expect(listAnswers(REPO_KEY, GUIDE_ID)).toHaveLength(1);
    w.asks.dispose();
  });

  it("does not write back an answer deleted while it is being answered", async () => {
    const w = world([[{ say: "Thinking…" }, { sleep: 800 }, answer("Too late")]]);
    await w.ask("Why did this change?");
    await waitFor(() => w.log().some((e) => e.event === "prompt"));
    const [record] = listAnswers(REPO_KEY, GUIDE_ID);
    expect(record.status).toBe("stopped"); // an "answering" file reads as stopped
    await w.asks.menu(record.id);
    await new Promise((r) => setTimeout(r, 1500));
    expect(listAnswers(REPO_KEY, GUIDE_ID)).toEqual([]);
    expect(existsSync(join(answersPath(REPO_KEY, GUIDE_ID), `${record.id}.json`))).toBe(false);
    w.asks.dispose();
  });

  it("Always approve acts only on the answer and the request really waiting: a mismatched id changes nothing", async () => {
    const w = world([[{ permission: { title: "Run git log -p", kind: "execute" } }, answer("After the approval")]]);
    await w.ask("Why did this change?");
    await waitFor(() => w.log().some((e) => e.event === "prompt"));
    const [record] = listAnswers(REPO_KEY, GUIDE_ID);
    await waitFor(() => w.asks.hasPendingPermission(record.id, 1));
    const askPending = (run: string | undefined, id: number | undefined) => w.asks.hasPendingPermission(run, id);
    // What the controller checks before it writes plannotator.guides.autoApprove.
    expect(approveAlwaysTarget(record.id, 1, { generation: null, askPending })).toBe("ask");
    expect(approveAlwaysTarget(record.id, 2, { generation: null, askPending })).toBeNull();
    expect(approveAlwaysTarget("ans-1-zzzz", 1, { generation: null, askPending })).toBeNull();
    expect(approveAlwaysTarget(record.id, undefined, { generation: null, askPending })).toBeNull();
    expect(w.asks.answerPermission(record.id, 1, "allow-once")).toBe(true);
    await waitFor(() => listAnswers(REPO_KEY, GUIDE_ID).some((r) => r.status === "answered"));
    // Answered: nothing waits any more, so the same ids no longer count.
    expect(approveAlwaysTarget(record.id, 1, { generation: null, askPending })).toBeNull();
    w.asks.dispose();
  });
});

type MockThread = { uri: vscode.Uri; comments: Array<{ body: { value: string }; author: { name: string; iconPath?: vscode.Uri }; label?: string }>; label?: string; state?: number; contextValue: string; canReply: boolean; disposed: boolean; controller: string };
const threads = () => (vscode as unknown as { createdCommentThreads: MockThread[] }).createdCommentThreads.filter((t) => t.controller.startsWith("plannotator-guides-ask"));
/** The box now: the newest thread still shown (a box moves to the conversation controller when its first question runs). */
const current = () => threads().filter((t) => !t.disposed).at(-1)!;
const bodies = (t: MockThread) => t.comments.map((c) => c.body.value);
const selection = { kind: "selection" as const, chapter: 0, chapterTitle: "The loop", path: "src/deliver.ts", side: "head" as const, lines: { start: 1, end: 2 }, code: "export function deliver() {\n  return 1;" };

describe("the question box under the lines", () => {
  async function openBox(w: ReturnType<typeof world>, line = 0) {
    const before = threads().length;
    w.asks.threads.open(w.guide, selection, vscode.Uri.file(join(w.root, "src", "deliver.ts")), new vscode.Range(line, 0, line + 1, 0));
    expect(threads()).toHaveLength(before + 1);
    return threads().at(-1)!;
  }

  it("asks the typed question, shows the work in the box, then opens the answer beside the diff", async () => {
    const w = world([[{ say: "Looking." }, { sleep: 400 }, answer("It returns one")]]);
    const t = await openBox(w);
    expect(t.label).toBe("Ask Claude Code · deliver.ts 1–2");
    expect(t.contextValue).toBe("plannotator-ask-compose");
    expect(t.canReply).toBe(true);
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0].author.name).toBe("Plannotator");
    // Resolved: nothing waits on it (comments.openView "firstFileUnresolved" leaves the panel closed).
    expect(t.state).toBe(vscode.CommentThreadState.Resolved);
    expect(bodies(t)[0]).toContain("Ask about **lines 1–2**");
    expect(bodies(t)[0]).toContain("command:plannotator.guides.askThreadPick");

    await w.asks.threads.submit({ thread: t, text: "  Why return a value?  " });
    // The box moved to the conversation controller (its field asks a follow-up), on the same lines.
    expect(t.disposed).toBe(true);
    const c = current();
    expect(c.controller).toBe("plannotator-guides-ask-conversation");
    expect(c.uri).toBe(t.uri);
    expect(c.label).toBe("Claude Code · deliver.ts 1–2");
    expect(c.contextValue).toBe("plannotator-ask-asking");
    expect(c.canReply).toBe(false);
    expect(bodies(c)[0]).toBe("Why return a value?");
    expect(bodies(c)[1]).toContain("command:plannotator.guides.askThreadStop");
    // No tab yet: the box shows the work.
    expect(w.panels).toHaveLength(0);

    await waitFor(() => c.contextValue === "plannotator-ask-done");
    expect(c.canReply).toBe(true);
    expect(c.state).toBe(vscode.CommentThreadState.Resolved);
    expect(bodies(c)[1]).toContain("Answer opened beside the diff");
    // Avatars for the person and the agent; the agent's label adds the time and the cost.
    // The person: initials; the agent: its own mark from images/agents/.
    expect(c.comments[0].author.iconPath?.scheme).toBe("data");
    expect(c.comments[0].author.iconPath?.path).toStartWith("image/svg+xml;base64,");
    expect(c.comments[1].author.iconPath?.path).toEndWith("/ext/images/agents/claude-code.svg");
    expect(c.comments[1].label).toMatch(/ · \d+s$/);
    expect(w.panels).toEqual([{ title: "Answer: Why return a value?", preserveFocus: true }]);
    const [record] = listAnswers(REPO_KEY, GUIDE_ID);
    expect(record.about).toMatchObject({ kind: "selection", lines: { start: 1, end: 2 } });
    expect(record.question).toBe("Why return a value?");
    w.asks.dispose();
  });

  it("asks a follow-up in the same box, in the same conversation", async () => {
    const w = world([[answer("First")], [answer("Second")]]);
    const t = await openBox(w);
    await w.asks.threads.submit({ thread: t, text: "Why?" });
    const c = current();
    await waitFor(() => c.contextValue === "plannotator-ask-done");
    await w.asks.threads.submit({ thread: c, text: "And then?" });
    // A follow-up stays in the same box.
    expect(current()).toBe(c);
    await waitFor(() => c.contextValue === "plannotator-ask-done" && c.comments.length === 4);
    expect(bodies(c)[2]).toBe("And then?");
    expect(bodies(c)[3]).toContain("Answer opened beside the diff");
    const all = listAnswers(REPO_KEY, GUIDE_ID);
    const [second, first] = all;
    expect(second.followUpOf).toBe(first.id);
    // One session answered both.
    expect(w.log().filter((e) => e.event === "prompt")).toHaveLength(2);
    expect(w.log().filter((e) => e.event === "newSession" || e.event === "loadSession")).toHaveLength(1);
    w.asks.dispose();
  });

  it("asks a suggestion when its link is picked, and lists earlier questions about the file", async () => {
    const w = world([[answer("Why")], [answer("Break")]]);
    const t = await openBox(w);
    const id = /askThreadPick\?([^\s)]+)/.exec(bodies(t)[0])![1];
    const [threadId] = JSON.parse(decodeURIComponent(id));
    await w.asks.threads.pick(threadId, 1);
    await waitFor(() => current().contextValue === "plannotator-ask-done");
    expect(listAnswers(REPO_KEY, GUIDE_ID)[0].question).toBe("What could break?");
    const next = await openBox(w, 5);
    expect(bodies(next)[0]).toContain("Asked before:  \n[What could break?](command:plannotator.guides.openAnswer");
    w.asks.dispose();
  });

  it("says in the box when another question is being answered, and keeps the question to ask later", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w = world([[answer("Chapter")], [answer("Box")]], { gate });
    const chapter = w.ask("What does this chapter do?");
    const t = await openBox(w);
    await w.asks.threads.submit({ thread: t, text: "Why?" });
    expect(t.contextValue).toBe("plannotator-ask-compose");
    expect(bodies(t).at(-1)).toContain("Not asked: “Why?”");
    expect(bodies(t).at(-1)).toContain("command:plannotator.guides.askThreadAgain");
    expect(warnings).toEqual([]);
    open();
    await chapter;
    await waitFor(() => listAnswers(REPO_KEY, GUIDE_ID).some((r) => r.status === "answered"));
    const threadId = JSON.parse(decodeURIComponent(/askThreadAgain\?([^\s)]+)/.exec(bodies(t).at(-1)!)![1]))[0];
    await w.asks.threads.again(threadId);
    await waitFor(() => current().contextValue === "plannotator-ask-done");
    expect(listAnswers(REPO_KEY, GUIDE_ID).map((r) => r.question)).toEqual(["Why?", "What does this chapter do?"]);
    w.asks.dispose();
  });

  it("Cancel removes the box; a second unasked box replaces the first; closing the guide removes the rest", async () => {
    const w = world([]);
    const a = await openBox(w);
    w.asks.threads.close({ thread: a, text: "" });
    expect(a.disposed).toBe(true);
    const b = await openBox(w);
    const c = await openBox(w, 1);
    expect(b.disposed).toBe(true);
    expect(c.disposed).toBe(false);
    // The same lines again: the open box is reused.
    w.asks.threads.open(w.guide, selection, c.uri, new vscode.Range(1, 0, 2, 0));
    expect(threads().at(-1)).toBe(c);
    w.asks.onReaderChanged(null);
    expect(c.disposed).toBe(true);
    expect(w.asks.threads.size).toBe(0);
    w.asks.dispose();
  });

  it("closing the guide while a box's question runs stops it, and no answer tab opens", async () => {
    const w = world([[{ say: "Thinking…" }, { sleep: 1500 }, answer("Too late")]]);
    const t = await openBox(w);
    await w.asks.threads.submit({ thread: t, text: "Why?" });
    const c = current();
    await waitFor(() => w.log().some((e) => e.event === "prompt"));
    w.asks.onReaderChanged(null);
    expect(c.disposed).toBe(true);
    await waitFor(() => listAnswers(REPO_KEY, GUIDE_ID).some((r) => r.status === "stopped" && !!r.answeredAt));
    await new Promise((r) => setTimeout(r, 300));
    expect(w.panels).toEqual([]);
    expect(w.log().some((e) => e.event === "cancel")).toBe(true);
    w.asks.dispose();
  });

  it("asking again on lines that have a box gets that box back; a new box keeps a question that was not asked", async () => {
    const w = world([[answer("One")]]);
    const t = await openBox(w);
    await w.asks.threads.submit({ thread: t, text: "Why?" });
    const c = current();
    await waitFor(() => c.contextValue === "plannotator-ask-done");
    const before = threads().length;
    w.asks.threads.open(w.guide, selection, c.uri, new vscode.Range(0, 0, 1, 0));
    expect(threads()).toHaveLength(before);
    expect(current()).toBe(c);
    expect(c.disposed).toBe(false);

    // A box whose question was not asked (another one was running) stays when a box opens elsewhere.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w2 = world([[answer("Chapter")]], { gate });
    const chapter = w2.ask("What does this chapter do?");
    const kept = await openBox(w2, 5);
    await w2.asks.threads.submit({ thread: kept, text: "Why?" });
    expect(bodies(kept).at(-1)).toContain("Not asked");
    const other = await openBox(w2, 9);
    expect(kept.disposed).toBe(false);
    expect(other.disposed).toBe(false);
    open();
    await chapter;
    w.asks.dispose();
    w2.asks.dispose();
  });

  it("an empty Ask asks nothing", async () => {
    const w = world([]);
    const t = await openBox(w);
    await w.asks.threads.submit({ thread: t, text: "   " });
    expect(t.contextValue).toBe("plannotator-ask-compose");
    expect(listAnswers(REPO_KEY, GUIDE_ID)).toEqual([]);
    w.asks.dispose();
  });
});
