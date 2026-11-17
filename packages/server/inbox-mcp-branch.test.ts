/**
 * send_message's `branch` (Branch reviews), through the tool's own handler on a scratch repository (no server). What
 * regresses:
 *  - the field listed, or served, while Branch reviews is off;
 *  - a second report of the same commit sending a message or judging risk again;
 *  - a new commit starting a second thread instead of going into the branch's own;
 *  - risk judged for a head this computer can't read, or ever by the safety net;
 *  - a cloud agent's pushed branch filed under its home folder instead of the project it pushed to.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxBranchService } from "./inbox-branch-service";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import type { RiskBranch } from "./inbox-pull-risk";
import { runtime } from "./git";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
type Tool = { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Result>; inputSchema?: { shape?: Record<string, unknown> } };

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function commit(repo: string, file: string): string {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, ["add", file]);
  git(repo, ["commit", "--quiet", "-m", file]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function world(options: { on?: boolean; cloud?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-branch-mcp-")));
  roots.push(root);
  const repo = join(root, "billing");
  mkdirSync(repo);
  git(repo, ["init", "--quiet", "-b", "main"]);
  commit(repo, "base.txt");
  git(repo, ["checkout", "--quiet", "-b", "retry-jitter"]);
  const head = commit(repo, "jitter.txt");
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "billing", root: repo });
  const home = store.ensureProject({ name: "cloud home", root: join(root, "home") });
  const gate = { on: options.on ?? true };
  const judged: RiskBranch[] = [];
  const service = createInboxBranchService({
    store,
    dataDir: join(root, "data"),
    runtime,
    on: () => gate.on,
    risk: { assessBranch: (branch) => void judged.push(branch), branchJudgment: () => ({ judgment: null, failed: null }) },
    originOf: (folder) => (folder === repo ? "github.com/northwind/billing-svc" : null),
  });
  const sender = options.cloud ? home : project;
  const context = { store, baseUrl: () => "http://localhost:1/", resolveProject: async () => sender, branches: service.mcp, ...(options.cloud ? { cloudAgent: { homeRoot: home.root } } : {}) } as unknown as InboxMcpContext;
  const tools = () => (createInboxMcpServer(context) as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  const send = async (input: Record<string, unknown>) => {
    const result = await tools().send_message!.handler({ project_path: sender.root, agent_session: "ses_1", agent_host: "claude-code", agent_name: "Claude Code", ...input }, {});
    return { error: result.isError === true, text: result.content.map((c) => c.text).join("\n"), structured: result.structuredContent ?? {} };
  };
  const messages = () => store.allProjects().flatMap((p) => store.threadsOf(p.id)).reduce((n, t) => n + store.threadMessageIds(t.thread_id).length, 0);
  return { store, repo, head, project, home, gate, judged, service, tools, send, messages };
}

describe("send_message's branch", () => {
  test("off: not in the tool's fields, and a call with it is refused with nothing sent", async () => {
    const w = world({ on: false });
    expect(Object.keys(w.tools().send_message!.inputSchema?.shape ?? {})).not.toContain("branch");
    const sent = await w.send({ body: "Done.", subject: "retry-jitter", branch: { name: "retry-jitter" } });
    expect(sent.error).toBe(true);
    expect(sent.text).toContain("branch_reviews_off");
    expect(w.messages()).toBe(0);
    expect(w.judged).toHaveLength(0);
  });

  test("on: one thread per branch; the same head again sends nothing; a new head goes into the same thread", async () => {
    const w = world();
    expect(Object.keys(w.tools().send_message!.inputSchema?.shape ?? {})).toContain("branch");
    const first = await w.send({ body: "retry-jitter is ready for review.", subject: "retry-jitter", branch: { name: "retry-jitter", summary: "Jitter on retries" } });
    expect(first.error).toBe(false);
    const thread = String(first.structured.thread_id);
    expect(w.service.mcp.get(w.project.id, "retry-jitter")).toMatchObject({ thread_id: thread, head: w.head, base: "main", place: "here", reports: 1 });
    expect(w.judged.map((b) => [b.key, b.head_sha])).toEqual([[`branch:${w.project.id}:retry-jitter`, w.head]]);
    expect(w.messages()).toBe(1);

    const again = await w.send({ body: "retry-jitter is ready for review.", subject: "retry-jitter", branch: { name: "retry-jitter" } });
    expect(again.error).toBe(false);
    expect(again.structured).toMatchObject({ thread_id: thread, reported: false });
    expect(w.messages()).toBe(1);
    expect(w.judged).toHaveLength(1);

    const next = commit(w.repo, "more.txt");
    const update = await w.send({ body: "Fixed the review's points.", subject: "something else", branch: { name: "retry-jitter" } });
    expect(update.structured.thread_id).toBe(thread);
    expect(w.store.threadMessageIds(thread)).toHaveLength(2);
    expect(w.service.mcp.get(w.project.id, "retry-jitter")).toMatchObject({ head: next, reports: 2 });
    expect(w.judged.map((b) => b.head_sha)).toEqual([w.head, next]);
    // Its thread is a Reviews row from the first report.
    expect([...(await w.service.started()).keys()]).toEqual([thread]);
  });

  test("a head this computer can't read is kept and listed, never judged", async () => {
    const w = world();
    const sent = await w.send({ body: "Pushed.", subject: "elsewhere", branch: { name: "pushed-elsewhere", head: "c".repeat(40) } });
    expect(sent.error).toBe(false);
    expect(w.judged).toHaveLength(0);
    const [row] = await w.service.rows();
    expect(row).toMatchObject({ branch: "pushed-elsewhere", reachable: false });
  });

  test("the safety net reads git only: no report, no risk", async () => {
    const w = world();
    const answer = await w.service.unreported(w.project, new Set());
    expect(answer.branches.map((b) => b.branch)).toEqual(["retry-jitter"]);
    expect(w.judged).toHaveLength(0);
    expect(w.messages()).toBe(0);
    expect(w.service.mcp.get(w.project.id, "retry-jitter")).toBeNull();
  });

  test("a cloud agent's pushed branch files under the project whose origin it pushed to", async () => {
    const w = world({ cloud: true });
    const sent = await w.send({ body: "Pushed retry-jitter.", subject: "retry-jitter", branch: { name: "retry-jitter", head: w.head, remote_url: "https://github.com/northwind/billing-svc.git" } });
    expect(sent.error).toBe(false);
    const report = w.service.mcp.get(w.project.id, "retry-jitter");
    expect(report).toMatchObject({ place: "cloud", project_id: w.project.id, remote_url: "https://github.com/northwind/billing-svc.git" });
    expect(w.store.message(String(sent.structured.thread_id))?.project_id ?? w.store.thread(String(sent.structured.thread_id))?.project.id).toBe(w.project.id);
    expect(w.service.mcp.get(w.home.id, "retry-jitter")).toBeNull();
  });

  test("a cloud agent's report with no head it can name is refused before anything is sent", async () => {
    const w = world({ cloud: true });
    const sent = await w.send({ body: "Pushed.", subject: "x", branch: { name: "nowhere-here", remote_url: "https://github.com/someone/else.git" } });
    expect(sent.error).toBe(true);
    expect(sent.text).toContain("branch.head");
    expect(w.messages()).toBe(0);
  });
});
