/**
 * send_message's `branch` (Branch reviews), through the tool's own handler on a scratch repository (no server). What
 * regresses:
 *  - the field listed, or served, while Branch reviews is off;
 *  - a second report of the same commit sending a message or judging risk again;
 *  - a new commit starting a second thread instead of going into the branch's own;
 *  - risk judged for a head this computer can't read, or ever by the safety net, or steered by the agent's summary;
 *  - a cloud agent's pushed branch filed under its home folder instead of the project it pushed to;
 *  - a cloud agent probing this computer: a branch tip or a full commit id looked up for it, or its risk run on local
 *    work no remote-tracking ref of its remote holds;
 *  - a remote URL kept with a password, a query or a fragment in it;
 *  - a first report landing in another report's thread;
 *  - a report filed under the named project but read from a working folder in another repository;
 *  - a report of HEAD or of the default branch;
 *  - an archived report thread staying archived when a new head comes;
 *  - a failed judgment never tried again, or tried again and again; one lost or under old rules never offered to rank.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxBranchService } from "./inbox-branch-service";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import { INBOX_WORKING_FOLDER_META_KEY } from "@plannotator/shared/inbox/connection";
import { INBOX_BRANCH_NAME_NOT_BASE } from "@plannotator/core/inbox-branch-reports";
import { inboxRowArchived } from "@plannotator/core/inbox-types";
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

/** The service's background reads (a report's risk waits on git) are done. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 400));

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
  // A second repository with its own project: an agent may work in it while naming billing.
  const other = join(root, "other");
  mkdirSync(other);
  git(other, ["init", "--quiet", "-b", "main"]);
  commit(other, "o.txt");
  git(other, ["checkout", "--quiet", "-b", "other-work"]);
  commit(other, "work.txt");
  const otherProject = store.ensureProject({ name: "other", root: other });
  const gate = { on: options.on ?? true };
  const judged: RiskBranch[] = [];
  /** The risk store as the service sees it: what failed, and whether a branch may run now. */
  const risk = { failed: null as string | null, rankable: true };
  const service = createInboxBranchService({
    store,
    dataDir: join(root, "data"),
    runtime,
    on: () => gate.on,
    risk: {
      assessBranch: (branch) => void judged.push(branch),
      branchJudgment: () => ({ judgment: null, failed: risk.failed }),
      branchPending: () => false,
      branchRankable: () => risk.rankable,
    },
    originOf: (folder) => (folder === repo ? "github.com/northwind/billing-svc" : null),
  });
  const sender = options.cloud ? home : project;
  const projectOf = (path: string) => (path.startsWith(other) ? otherProject : path.startsWith(repo) ? project : sender);
  const context = {
    store,
    baseUrl: () => "http://localhost:1/",
    resolveProject: async (path: string) => projectOf(path),
    projectRootOf: async (path: string) => ({ root: projectOf(path).root }),
    branches: service.mcp,
    ...(options.cloud ? { cloudAgent: { homeRoot: home.root } } : {}),
  } as unknown as InboxMcpContext;
  const tools = () => (createInboxMcpServer(context) as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  const send = async (input: Record<string, unknown>, workingFolder?: string) => {
    const ctx = workingFolder ? { mcpReq: { _meta: { [INBOX_WORKING_FOLDER_META_KEY]: workingFolder } } } : {};
    const result = await tools().send_message!.handler({ project_path: sender.root, agent_session: "ses_1", agent_host: "claude-code", agent_name: "Claude Code", ...input }, ctx);
    return { error: result.isError === true, text: result.content.map((c) => c.text).join("\n"), structured: result.structuredContent ?? {} };
  };
  const messages = () => store.allProjects().flatMap((p) => store.threadsOf(p.id)).reduce((n, t) => n + store.threadMessageIds(t.thread_id).length, 0);
  return { store, repo, head, project, home, other, otherProject, gate, judged, risk, service, tools, send, messages };
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
    await quiet();
    expect(w.judged.map((b) => [b.key, b.head_sha])).toEqual([[`branch:${w.project.id}:retry-jitter`, w.head]]);
    // The agent's summary is its own words about its own work: never in the prompt.
    expect(w.judged[0]!.title).toBe("retry-jitter");
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
    await quiet();
    expect(w.judged.map((b) => b.head_sha)).toEqual([w.head, next]);
    // Its thread is a Reviews row from the first report.
    expect([...(await w.service.started()).keys()]).toEqual([thread]);
  });

  test("a head this computer can't read is kept and listed, never judged", async () => {
    const w = world();
    const sent = await w.send({ body: "Pushed.", subject: "elsewhere", branch: { name: "pushed-elsewhere", head: "c".repeat(40) } });
    expect(sent.error).toBe(false);
    await quiet();
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

  test("a cloud agent's report must name its head: never a branch's tip looked up here, even for a branch this computer has", async () => {
    const w = world({ cloud: true });
    for (const name of ["nowhere-here", "retry-jitter"]) {
      const sent = await w.send({ body: "Pushed.", subject: "x", branch: { name, remote_url: "https://github.com/northwind/billing-svc.git" } });
      expect(sent.error).toBe(true);
      expect(sent.text).toContain("branch.head: the commit you pushed (required for a cloud agent).");
    }
    expect(w.messages()).toBe(0);
  });

  test("a cloud agent learns nothing of local commits, and its risk runs only once its remote's tracking ref holds the commit", async () => {
    const w = world({ cloud: true });
    const short = w.head.slice(0, 7);
    const sent = await w.send({ body: "Pushed.", subject: "retry-jitter", branch: { name: "retry-jitter", head: short, remote_url: "https://github.com/northwind/billing-svc.git" } });
    expect(sent.error).toBe(false);
    // The short id stays short: never expanded from this computer's commits.
    expect(sent.text).toContain(`at ${short}`);
    expect(sent.text).not.toContain(w.head);
    expect(w.service.mcp.get(w.project.id, "retry-jitter")?.head).toBe(short);
    await quiet();
    // The commit is here, but only as local work: no remote-tracking ref of the remote it named holds it.
    expect(w.judged).toHaveLength(0);
    const thread = String(sent.structured.thread_id);
    expect(await w.service.rank(thread)).toBe(false);
    expect((await w.service.rows())[0]).not.toHaveProperty("rankable");
    // A remote of another repository holding it changes nothing.
    git(w.repo, ["remote", "add", "fork", "https://github.com/someone/billing-svc.git"]);
    git(w.repo, ["update-ref", "refs/remotes/fork/retry-jitter", w.head]);
    expect(await w.service.rank(thread)).toBe(false);
    expect(w.judged).toHaveLength(0);
  });

  test("a cloud agent's commit held by its remote's tracking ref is judged on its report", async () => {
    const w = world({ cloud: true });
    git(w.repo, ["remote", "add", "origin", "git@github.com:northwind/billing-svc.git"]);
    git(w.repo, ["update-ref", "refs/remotes/origin/retry-jitter", w.head]);
    const sent = await w.send({ body: "Pushed.", subject: "retry-jitter", branch: { name: "retry-jitter", head: w.head, remote_url: "https://github.com/northwind/billing-svc.git" } });
    expect(sent.error).toBe(false);
    await quiet();
    expect(w.judged.map((b) => b.head_sha)).toEqual([w.head]);
  });

  test("a remote URL is kept as rebuilt from its parts: no password, query or fragment; other schemes refused", async () => {
    const w = world({ cloud: true });
    const head = "d".repeat(40);
    const sent = await w.send({ body: "Pushed.", subject: "x", branch: { name: "pushed-one", head, remote_url: "https://bot:s3cret@github.com/northwind/billing-svc.git?token=abc#frag" } });
    expect(sent.error).toBe(false);
    expect(w.service.mcp.get(w.project.id, "pushed-one")?.remote_url).toBe("https://github.com/northwind/billing-svc.git");
    for (const remote_url of ["ext::sh -c touch% /tmp/x", "file:///etc/passwd", "http://github.com/a/b.git", "git://github.com/a/b.git", "--upload-pack=touch /tmp/x"]) {
      const refused = await w.send({ body: "Pushed.", subject: "y", branch: { name: "pushed-two", head, remote_url } });
      expect(refused.error).toBe(true);
      expect(refused.text).toContain("branch.remote_url");
    }
    expect(w.messages()).toBe(1);
  });

  test("a first report never lands in another report's thread: it starts its own", async () => {
    const w = world();
    git(w.repo, ["checkout", "--quiet", "-b", "second-branch"]);
    commit(w.repo, "second.txt");
    const first = await w.send({ body: "retry-jitter ready.", subject: "retry-jitter", thread: "my work", branch: { name: "retry-jitter", head: w.head } });
    const firstThread = String(first.structured.thread_id);
    const byReply = await w.send({ body: "second ready.", reply_to: String(first.structured.message_id), branch: { name: "second-branch" } });
    expect(byReply.error).toBe(false);
    expect(byReply.structured.thread_id).not.toBe(firstThread);
    expect(w.service.mcp.get(w.project.id, "second-branch")?.thread_id).toBe(String(byReply.structured.thread_id));
    git(w.repo, ["checkout", "--quiet", "-b", "third-branch"]);
    commit(w.repo, "third.txt");
    const byName = await w.send({ body: "third ready.", subject: "third", thread: "my work", branch: { name: "third-branch" } });
    expect([firstThread, byReply.structured.thread_id]).not.toContain(byName.structured.thread_id);
    // The first report's thread kept only its own message.
    expect(w.store.threadMessageIds(firstThread)).toHaveLength(1);
  });

  test("a working folder in another repository: the report files under the folder's project when the branch is there, else the named project is read", async () => {
    const w = world();
    const there = await w.send({ body: "other-work ready.", subject: "other-work", branch: { name: "other-work" } }, w.other);
    expect(there.error).toBe(false);
    expect(w.service.mcp.get(w.project.id, "other-work")).toBeNull();
    expect(w.service.mcp.get(w.otherProject.id, "other-work")).toMatchObject({ folder: w.other, base: "main" });
    expect(w.store.thread(String(there.structured.thread_id))?.project.id).toBe(w.otherProject.id);
    // The branch is billing's, not the working folder's: billing's checkout is read, never the other folder.
    const here = await w.send({ body: "retry-jitter ready.", subject: "retry-jitter", branch: { name: "retry-jitter" } }, w.other);
    expect(here.error).toBe(false);
    expect(w.service.mcp.get(w.project.id, "retry-jitter")).toMatchObject({ folder: w.repo, head: w.head });
  });

  test("HEAD and the default branch are no report's name", async () => {
    const w = world();
    for (const name of ["HEAD", "main"]) {
      const sent = await w.send({ body: "Ready.", subject: name, branch: { name } });
      expect(sent.error).toBe(true);
      expect(sent.text).toContain(INBOX_BRANCH_NAME_NOT_BASE);
    }
    expect(w.messages()).toBe(0);
  });

  test("a new head brings an archived report thread back", async () => {
    const w = world();
    const first = await w.send({ body: "Ready.", subject: "retry-jitter", branch: { name: "retry-jitter" } });
    const thread = String(first.structured.thread_id);
    w.store.resolveThread(thread, true, "person");
    expect(inboxRowArchived(w.store.listRow(thread)!)).toBe(true);
    expect(await w.service.rows()).toHaveLength(0);
    commit(w.repo, "after.txt");
    const update = await w.send({ body: "More.", subject: "retry-jitter", branch: { name: "retry-jitter" } });
    expect(update.structured.thread_id).toBe(thread);
    expect(inboxRowArchived(w.store.listRow(thread)!)).toBe(false);
    expect((await w.service.rows()).map((row) => row.thread_id)).toEqual([thread]);
  });

  test("a failed judgment is tried once more on the next read, then offered to rank by hand", async () => {
    const w = world();
    const sent = await w.send({ body: "Ready.", subject: "retry-jitter", branch: { name: "retry-jitter" } });
    await quiet();
    expect(w.judged).toHaveLength(1);
    w.risk.failed = "The agent did not answer.";
    const [once] = await w.service.rows();
    await quiet();
    expect(w.judged).toHaveLength(2);
    expect(once).not.toHaveProperty("rankable");
    const [after] = await w.service.rows();
    await quiet();
    expect(w.judged).toHaveLength(2);
    expect(after).toMatchObject({ rankable: true, risk_failed: "The agent did not answer." });
    expect(await w.service.rank(String(sent.structured.thread_id))).toBe(false);
    expect(w.judged).toHaveLength(3);
    // Nothing kept and nothing failed (lost to a restart, or the rules changed): not ranked, with Rank.
    w.risk.failed = null;
    expect((await w.service.rows())[0]).toMatchObject({ rankable: true, risk: null });
    w.risk.rankable = false;
    expect((await w.service.rows())[0]).not.toHaveProperty("rankable");
  });
});
