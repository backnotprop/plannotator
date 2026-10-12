/**
 * Plannotator Inbox decisions (step 3), proved through the server's real
 * doors: a running server on loopback, real `fetch`, the MCP SDK client over
 * streamable HTTP, and the files on disk. What the browser proof
 * (tests/e2e/inbox-decisions.spec.ts) cannot reach lives here: a decision
 * that cannot be written never undoes the sent answer, the records come back
 * after a restart, and the refusals. Every test uses its own temp data dir.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxQuestion } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import { decisionProjectCounts, recordAgentDecision, replaceDecision, retireDecision, setQuestionDecision, waitingDecisionCount, waitingDecisions } from "./inbox-decisions";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(): { dataDir: string; project: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-decisions-")));
  roots.push(root);
  const project = join(root, "billing-svc");
  mkdirSync(project);
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return { dataDir: join(root, "data"), project };
}

async function start(dataDir: string): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer) {
  const client = new Client({ name: "inbox-decisions-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent?: any };
    return result.isError ? { error: result.content[0]!.text } : result.structuredContent;
  };
}

async function post(server: InboxServer, path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, serverSession: server.serverSession }),
  });
  return { status: response.status, body: await response.json() };
}

async function thread(server: InboxServer, threadId: string): Promise<any> {
  return (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}`)).json();
}

const ASK = [
  ":::question",
  "Which way should the worker go on a Stripe 409?",
  "Decision: when answered",
  "",
  "- [ ] Retry with the same idempotency key",
  "- [ ] Fail the job",
  ":::",
].join("\n");

/** An agent asks; the person picks the first choice. Returns the ids and the picked question. */
async function askAndPick(server: InboxServer, project: string) {
  const call = await agent(server);
  const sent = await call("send_message", { project_path: project, body: ASK, agent_name: "Claude Code", agent_host: "claude-code" });
  const key = sent.questions[0].key as string;
  const before = (await thread(server, sent.thread_id)).thread.messages[0].questions[0] as InboxQuestion;
  const answer = { v: 1, key, kind: before.kind, prompt: before.prompt, selected: ["Retry with the same idempotency key"] };
  const picked = await post(server, `/api/inbox/messages/${sent.message_id}/picks`, { questions: [{ key, revision: 0, answer }] });
  expect(picked.status).toBe(200);
  return { call, sent, key };
}

function decisionsFile(dataDir: string): string {
  const projects = join(dataDir, "inbox", "projects");
  return join(projects, readdirSync(projects)[0]!, "decisions.jsonl");
}

test("a decision that cannot be written never undoes the sent answer, and the Send's retry records it", async () => {
  const { dataDir, project } = world();
  const server = await start(dataDir);
  const { sent, key } = await askAndPick(server, project);
  // A folder where the decisions file goes: the append fails, as a full or read-only disk would.
  mkdirSync(decisionsFile(dataDir));

  const send = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "send-1", questions: [{ key, revision: 1 }] });
  expect(send.status).toBe(200);
  expect(send.body.decisions).toEqual([]);
  expect(send.body.decisions_refused).toHaveLength(1);
  expect(send.body.decisions_refused[0].key).toBe(key);
  const question = send.body.questions[0] as InboxQuestion;
  expect(question.state).toBe("sent");
  expect(question.decision_id).toBeNull();
  expect((await thread(server, sent.thread_id)).thread.messages.at(-1).author.kind).toBe("person");

  // The window keeps its idempotency key for a retry: the reply is not sent twice, the decision is filled in.
  rmSync(decisionsFile(dataDir), { recursive: true });
  const retry = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "send-1", questions: [{ key, revision: 1 }] });
  expect(retry.body.replayed).toBe(true);
  expect(retry.body.decisions).toHaveLength(1);
  expect(retry.body.decisions[0].text).toBe("Retry with the same idempotency key.");
  expect(retry.body.questions[0].decision_id).toBe(retry.body.decisions[0].id);
  expect((await thread(server, sent.thread_id)).thread.messages.filter((m: any) => m.author.kind === "person")).toHaveLength(1);
  // A third replay records nothing more.
  const again = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "send-1", questions: [{ key, revision: 1 }] });
  expect(again.body.decisions).toEqual([]);
  expect(readFileSync(decisionsFile(dataDir), "utf8").trim().split("\n")).toHaveLength(1);
});

test("the switch, the card's words and the decisions come back after a restart", async () => {
  const { dataDir, project } = world();
  const server = await start(dataDir);
  const { call, sent, key } = await askAndPick(server, project);
  const kept = await post(server, `/api/inbox/messages/${sent.message_id}/decision`, {
    key,
    recording: true,
    draft: { text: "Retry a 409 with the same key.", reason: null },
  });
  expect(kept.body.question.decision_draft).toEqual({ text: "Retry a 409 with the same key.", reason: null });
  await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "s", questions: [{ key, revision: 1 }] });
  await call("record_decision", { project_path: project, text: "Webhooks are verified first.", agent_name: "Codex" });
  server.stop();
  servers.splice(servers.indexOf(server), 1);

  const again = await start(dataDir);
  const q = (await thread(again, sent.thread_id)).thread.messages[0].questions[0] as InboxQuestion;
  expect(q.decision_draft).toEqual({ text: "Retry a 409 with the same key.", reason: null });
  expect(q.decision_recording).toBe(true);
  const listed = await (await agent(again))("list_decisions", { project_path: project });
  expect(listed.decisions.map((d: any) => [d.text, d.source.kind])).toEqual([
    ["Retry a 409 with the same key.", "answer"],
    ["Webhooks are verified first.", "agent"],
  ]);
  expect(listed.decisions[0].id).toBe(q.decision_id);
});

test("refusals: a stale version, an ended decision, a reused key with other words, a switch on a sent answer, a stale tab", async () => {
  const { dataDir, project } = world();
  const server = await start(dataDir);
  const { call, sent, key } = await askAndPick(server, project);
  const recorded = await call("record_decision", { project_path: project, text: "Refunds stay a person's call.", idempotency_key: "k1" });
  const id = recorded.decision.id as string;

  expect((await post(server, `/api/inbox/decisions/${id}/retire`, { version: 0 })).body.code).toBe("decision_version_conflict");
  expect((await post(server, `/api/inbox/decisions/${id}/replace`, { version: 1, text: "Refunds stay a person's call." })).body.code).toBe("validation_error");
  expect((await post(server, `/api/inbox/decisions/${id}/retire`, { version: 1 })).status).toBe(200);
  const ended = await post(server, `/api/inbox/decisions/${id}/replace`, { version: 2, text: "Something else." });
  expect([ended.status, ended.body.code]).toEqual([409, "decision_not_current"]);

  expect((await call("record_decision", { project_path: project, text: "Other words.", idempotency_key: "k1" })).error).toStartWith("idempotency_key_reused:");
  expect((await call("record_decision", { project_path: project, text: "  " })).error).toStartWith("validation_error:");

  await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "s", questions: [{ key, revision: 1 }] });
  const late = await post(server, `/api/inbox/messages/${sent.message_id}/decision`, { key, recording: false });
  expect([late.status, late.body.code]).toEqual([409, "question_already_sent"]);

  const stale = await fetch(`http://127.0.0.1:${server.port}/api/inbox/decisions/${id}/retire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 2, serverSession: "an-older-inbox" }),
  });
  expect(stale.status).toBe(409);
  const crossSite = await fetch(`http://127.0.0.1:${server.port}/api/inbox/messages/${sent.message_id}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.com" },
    body: JSON.stringify({ key, recording: true }),
  });
  expect(crossSite.status).toBe(403);
});

test("the one-pass counts equal each project's Waiting group and current decisions, on a mixed multi-project seed", async () => {
  const { dataDir, project } = world();
  const server = await start(dataDir);
  const store = server.store;
  const author = { kind: "agent" as const, host: "claude-code", session: "ses_seed", name: "Claude Code" };
  const agentOf = { host: "claude-code", session: "ses_seed", name: "Claude Code" };
  const ids: string[] = [];
  for (let p = 0; p < 4; p++) {
    const root = join(project, `p${p}`);
    mkdirSync(root);
    const prj = store.ensureProject({ name: `p${p}`, root });
    ids.push(prj.id);
    for (let q = 0; q < p + 1; q++) {
      const sent = store.sendMessage({ project_id: prj.id, author: { ...author, session: `ses_${p}_${q}` }, body: ASK.replace("409?", `409 (${q})?`) }).message;
      // Some questions turn their switch off, some threads are resolved: neither waits.
      if (q === 1) setQuestionDecision(store, sent.id, { key: store.questionsOf(sent.id)[0]!.key, recording: false });
      if (q === 2) store.resolveThread(sent.thread_id, true);
    }
    // A question without the decision line never waits.
    store.sendMessage({ project_id: prj.id, author, body: [":::question", "Plain question?", "", "- [ ] A", "- [ ] B", ":::"].join("\n") });
    for (let d = 0; d < p; d++) {
      const { decision } = recordAgentDecision(store, { project_id: prj.id, text: `p${p} decision ${d}`, agent: agentOf });
      if (d === 1) retireDecision(store, decision.id, 1);
      if (d === 2) replaceDecision(store, decision.id, { version: 1, text: `p${p} decision ${d}, revised` });
    }
  }
  const counts = decisionProjectCounts(store);
  expect(counts.map((c) => c.project_id)).toEqual(store.listProjects().map((p) => p.id));
  for (const id of ids) {
    const one = counts.find((c) => c.project_id === id)!;
    expect(one.waiting).toBe(waitingDecisions(store, id).length);
    expect(one.settled).toBe(store.decisionsOf(id).filter((d) => d.state === "current").length);
  }
  // Not vacuous: the seed has waiting questions and settled decisions to count, and some to leave out.
  expect(counts.map((c) => [c.waiting, c.settled])).toEqual([
    [1, 0],
    [1, 1],
    [1, 1],
    [2, 2],
  ]);
  // The sidebar's Decisions count is the same rule, in the same pass.
  expect(waitingDecisionCount(store)).toBe(waitingDecisions(store).length);
  const list = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads`)).json();
  expect(list.decisions_waiting).toBe(5);
});

test("the Decisions route carries every project's waiting and settled counts, for the project switch", async () => {
  const { dataDir, project } = world();
  const server = await start(dataDir);
  const call = await agent(server);
  // billing-svc: one question waiting on a decision, two decisions recorded, one of them then retired.
  const asked = await call("send_message", { project_path: project, body: ASK, agent_name: "Claude Code", agent_host: "claude-code" });
  await call("record_decision", { project_path: project, text: "Webhooks are verified first.", idempotency_key: "a" });
  const retired = await call("record_decision", { project_path: project, text: "Refunds stay a person's call.", idempotency_key: "b" });
  expect((await post(server, `/api/inbox/decisions/${retired.decision.id}/retire`, { version: 1 })).status).toBe(200);
  // docs: a project with nothing to decide.
  const docs = join(dataDir, "..", "docs");
  mkdirSync(docs);
  await call("send_message", { project_path: docs, body: "The docs build is green." });

  const projects = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/projects`)).json()).projects as { id: string; name: string }[];
  const billing = projects.find((p) => p.name === "billing-svc")!;
  const quiet = projects.find((p) => p.name === "docs")!;
  const model = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/decisions?project=${quiet.id}`)).json();
  // Asked from one project, every project's counts come back, in the sidebar's order.
  expect(model.project_counts).toEqual([
    { project_id: billing.id, waiting: 1, settled: 1 },
    { project_id: quiet.id, waiting: 0, settled: 0 },
  ]);
  expect(model.project_counts.map((c: { project_id: string }) => c.project_id)).toEqual(projects.map((p) => p.id));

  // The answer sent with its switch on: no longer waiting, one more settled.
  const key = asked.questions[0].key as string;
  const before = (await thread(server, asked.thread_id)).thread.messages[0].questions[0] as InboxQuestion;
  const answer = { v: 1, key, kind: before.kind, prompt: before.prompt, selected: ["Fail the job"] };
  await post(server, `/api/inbox/messages/${asked.message_id}/picks`, { questions: [{ key, revision: 0, answer }] });
  await post(server, `/api/inbox/messages/${asked.message_id}/reply`, { idempotency_key: "send", questions: [{ key, revision: 1 }] });
  const after = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/decisions?project=${billing.id}`)).json();
  expect(after.project_counts[0]).toEqual({ project_id: billing.id, waiting: 0, settled: 2 });
});
