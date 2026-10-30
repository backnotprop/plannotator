/**
 * Decision mode (experimental, approval "inbox-decision-mode") on a running
 * Inbox: the gate (config.json `experimental.decisionMode`, the
 * PLANNOTATOR_EXPERIMENTAL override, Settings' POST), `GET
 * /api/inbox/decisions` (its guards, its order, its liveness through the
 * existing picks and reply routes), and that the phone door leaves it out.
 * Every test runs under its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxDecisionsModel, InboxProjectRepo } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const envBefore = { data: process.env.PLANNOTATOR_DATA_DIR, experimental: process.env.PLANNOTATOR_EXPERIMENTAL };

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (envBefore.data === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = envBefore.data;
  if (envBefore.experimental === undefined) delete process.env.PLANNOTATOR_EXPERIMENTAL;
  else process.env.PLANNOTATOR_EXPERIMENTAL = envBefore.experimental;
});

/** A fresh Inbox whose config.json is its own (the Inbox reads config through PLANNOTATOR_DATA_DIR). */
async function setup(options: { on?: boolean; phones?: boolean; readProjectRepo?: (root: string) => Promise<InboxProjectRepo | null> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-decisions-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_EXPERIMENTAL;
  if (options.on) writeFileSync(join(dataDir, "config.json"), JSON.stringify({ experimental: { decisionMode: true } }));
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir, binaryPath: null, ...(options.phones ? { phones: true } : {}), ...(options.readProjectRepo ? { readProjectRepo: options.readProjectRepo } : {}) });
  servers.push(server);
  const client = new Client({ name: "inbox-decisions-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project, dataDir };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const block = (prompt: string, extra: string[] = []) => [":::question", prompt, "", ...extra, "- [ ] Yes", "- [ ] No", ":::"].join("\n");

async function send(client: Client, project: string, session: string, host: string, args: Record<string, unknown>) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { project_path: project, agent_session: session, agent_host: host, ...args },
  });
  expect(result.isError).toBeFalsy();
  return result.structuredContent as { message_id: string; thread_id: string };
}

const post = (server: InboxServer, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });

async function decisions(server: InboxServer, query = ""): Promise<InboxDecisionsModel> {
  const res = await fetch(`${base(server)}/api/inbox/decisions${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as InboxDecisionsModel;
}

describe("the gate", () => {
  test("off by default: the route does not exist and Settings says so", async () => {
    const { server } = await setup();
    const res = await fetch(`${base(server)}/api/inbox/decisions`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
    const settings = (await (await fetch(`${base(server)}/api/inbox/settings`)).json()) as { experimental: unknown };
    expect(settings.experimental).toEqual({ decision_mode: { on: false, env: null } });
  });

  test("Settings turns it on and off, applied at once, and refuses a bad body", async () => {
    const { server } = await setup();
    const on = await post(server, "/api/inbox/settings", { experimental: { decision_mode: true } });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { experimental: unknown }).experimental).toEqual({ decision_mode: { on: true, env: null } });
    expect((await fetch(`${base(server)}/api/inbox/decisions`)).status).toBe(200);
    for (const bad of [true, { decision_mode: "yes" }, { decision_mode: true, other: true }, []]) {
      const refused = await post(server, "/api/inbox/settings", { experimental: bad });
      expect(refused.status).toBe(422);
    }
    // Another site's page cannot switch it.
    const cross = await post(server, "/api/inbox/settings", { experimental: { decision_mode: false } }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
    expect(cross.status).toBe(403);
    const stale = await fetch(`${base(server)}/api/inbox/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: "not-this-one", experimental: { decision_mode: false } }),
    });
    expect(stale.status).toBe(409);
    await post(server, "/api/inbox/settings", { experimental: { decision_mode: false } });
    expect((await fetch(`${base(server)}/api/inbox/decisions`)).status).toBe(404);
  });

  test("switching decision mode keeps the other experimental flags in config.json", async () => {
    const { server, dataDir } = await setup();
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ experimental: { otherFlag: true }, inboxTextSize: 13 }));
    for (const on of [true, false]) {
      expect((await post(server, "/api/inbox/settings", { experimental: { decision_mode: on } })).status).toBe(200);
      const saved = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
      expect(saved.experimental).toEqual({ otherFlag: true, decisionMode: on });
      expect(saved.inboxTextSize).toBe(13);
    }
  });

  test("PLANNOTATOR_EXPERIMENTAL decides over config.json, both ways", async () => {
    const { server, dataDir } = await setup({ on: true });
    process.env.PLANNOTATOR_EXPERIMENTAL = "other-thing, -decision-mode";
    expect((await fetch(`${base(server)}/api/inbox/decisions`)).status).toBe(404);
    const settings = (await (await fetch(`${base(server)}/api/inbox/settings`)).json()) as { experimental: unknown };
    expect(settings.experimental).toEqual({ decision_mode: { on: false, env: false } });
    process.env.PLANNOTATOR_EXPERIMENTAL = " Decision-Mode ";
    // While the env var decides, the switch is locked: a save is refused (409, like Over your tailnet) and writes nothing.
    const before = readFileSync(join(dataDir, "config.json"), "utf8");
    const locked = await post(server, "/api/inbox/settings", { experimental: { decision_mode: false } });
    expect(locked.status).toBe(409);
    expect(((await locked.json()) as { code: string }).code).toBe("experimental_env_decides");
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(before);
    // Nothing else in the same request is saved either.
    expect((await post(server, "/api/inbox/settings", { experimental: { decision_mode: true }, text_size: 12 })).status).toBe(409);
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(before);
    expect((await fetch(`${base(server)}/api/inbox/decisions`)).status).toBe(200);
  });
});

describe("GET /api/inbox/decisions", () => {
  test("refuses another site and anything but GET", async () => {
    const { server } = await setup({ on: true });
    const cross = await fetch(`${base(server)}/api/inbox/decisions`, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(cross.status).toBe(403);
    const foreign = await fetch(`${base(server)}/api/inbox/decisions`, { headers: { Origin: "http://localhost:1" } });
    expect(foreign.status).toBe(403);
    const same = await fetch(`${base(server)}/api/inbox/decisions`, { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(same.status).toBe(200);
    expect((await post(server, "/api/inbox/decisions", {})).status).toBe(405);
    expect((await fetch(`${base(server)}/api/inbox/decisions?project=prj_nope`)).status).toBe(422);
  });

  test("lists across threads in queue order, with what a card needs", async () => {
    const { server, client, project } = await setup({ on: true });
    const plain = await send(client, project, "ses-a", "claude-code", { body: `Some context first.\n\n${block("Rename the flag?")}` });
    const blocked = await send(client, project, "ses-b", "codex", {
      body: `${block("Plain one?")}\n\n${block("Retry on 409?", ["Stopped: the worker cannot ship without this."])}`,
    });
    await send(client, project, "ses-c", "pi", { body: block("Merge now?", ["Holds up: the release; the docs"]) });
    const model = await decisions(server);
    expect(model.serverSession).toBe(server.serverSession);
    expect(model.decisions.map((d) => d.question.prompt)).toEqual(["Retry on 409?", "Plain one?", "Merge now?", "Rename the flag?"]);
    const stopped = model.decisions[0]!;
    expect(stopped.question.stopped).toBe("the worker cannot ship without this.");
    expect(stopped.thread).toMatchObject({ id: blocked.thread_id, section: "stopped", project: { name: "billing" } });
    expect(stopped.session).toMatchObject({ host: "codex", session: "ses-b" });
    const last = model.decisions.at(-1)!;
    expect(last.message).toMatchObject({ id: plain.message_id, excerpt: "Some context first." });
    expect(last.id).toBe(`${plain.message_id}/${last.question.key}`);
    // The project filter keeps the order.
    const filtered = await decisions(server, `?project=${stopped.thread.project.id}`);
    expect(filtered.decisions.map((d) => d.id)).toEqual(model.decisions.map((d) => d.id));
  });

  test("each decision carries its thread project's repo, so a card links refs on that forge", async () => {
    const seen: string[] = [];
    const { server, client, project } = await setup({
      on: true,
      readProjectRepo: async (root) => {
        seen.push(root);
        return { display: "acme/billing", host: "gitlab.example.com" };
      },
    });
    await send(client, project, "ses-a", "claude-code", { body: block("Ship it?") });
    let repo: InboxProjectRepo | null | undefined;
    for (let i = 0; i < 50 && !repo; i++) {
      repo = (await decisions(server)).decisions[0]?.thread.project.repo;
      if (!repo) await Bun.sleep(20);
    }
    expect(repo).toEqual({ display: "acme/billing", host: "gitlab.example.com" });
    expect(seen).toContain(project);
  });

  test("follows the existing picks and reply routes: a pick stays with its revision, a Send takes it out", async () => {
    const { server, client, project } = await setup({ on: true });
    const asked = await send(client, project, "ses-a", "claude-code", { body: `${block("First?")}\n\n${block("Second?")}` });
    const [first, second] = (await decisions(server)).decisions;
    const pick = await post(server, `/api/inbox/messages/${asked.message_id}/picks`, {
      questions: [{ key: first!.question.key, revision: first!.question.revision, answer: { v: 1, key: first!.question.key, kind: "single", prompt: "First?", selected: ["Yes"] } }],
    });
    expect(pick.status).toBe(200);
    const after = (await decisions(server)).decisions;
    expect(after.map((d) => [d.question.prompt, d.question.state, d.question.revision])).toEqual([
      ["First?", "picked", 1],
      ["Second?", "open", 0],
    ]);
    // A stale revision is refused by the picks route as always.
    const stale = await post(server, `/api/inbox/messages/${asked.message_id}/picks`, {
      questions: [{ key: first!.question.key, revision: 0, answer: null }],
    });
    expect(stale.status).toBe(409);
    const reply = await post(server, `/api/inbox/messages/${asked.message_id}/reply`, {
      idempotency_key: "decide-1",
      words: "",
      questions: [{ key: first!.question.key, revision: 1 }],
    });
    expect(reply.status).toBe(200);
    expect((await decisions(server)).decisions.map((d) => d.id)).toEqual([second!.id]);
  });

  test("a pick with unsent_only that raced the Send is refused (question_already_sent), and the answer stays sent", async () => {
    const { server, client, project } = await setup({ on: true });
    const asked = await send(client, project, "ses-a", "claude-code", { body: block("Ship it?") });
    const [d] = (await decisions(server)).decisions;
    const answer = (selected: string) => ({ v: 1, key: d!.question.key, kind: "single", prompt: "Ship it?", selected: [selected] });
    expect((await post(server, `/api/inbox/messages/${asked.message_id}/picks`, { questions: [{ key: d!.question.key, revision: 0, answer: answer("Yes") }] })).status).toBe(200);
    expect((await post(server, `/api/inbox/messages/${asked.message_id}/reply`, { idempotency_key: "k1", words: "", questions: [{ key: d!.question.key, revision: 1 }] })).status).toBe(200);
    // The window read revision 1 before the Send: its pick lands after it.
    const raced = await post(server, `/api/inbox/messages/${asked.message_id}/picks`, { unsent_only: true, questions: [{ key: d!.question.key, revision: 1, answer: answer("No") }] });
    expect(raced.status).toBe(409);
    expect(((await raced.json()) as { code: string }).code).toBe("question_already_sent");
    expect((await post(server, `/api/inbox/messages/${asked.message_id}/picks`, { unsent_only: "yes", questions: [{ key: d!.question.key, revision: 1, answer: answer("No") }] })).status).toBe(422);
    expect((await decisions(server)).decisions).toHaveLength(0);
  });

  test("the phone door does not carry it: `decisions` stays the removed Decisions route, refused", async () => {
    const { server } = await setup({ on: true, phones: true });
    const made = (await (await post(server, "/api/inbox/pairing", {})).json()) as { offer: { code: string } };
    const paired = await fetch(`${base(server)}/api/inbox/device/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }),
    });
    const { token } = (await paired.json()) as { token: string };
    const read = await fetch(`${base(server)}/api/inbox/device/decisions`, { headers: { Authorization: `Bearer ${token}` } });
    expect(read.status).toBe(404);
    expect(((await read.json()) as { code: string }).code).toBe("device_route_not_found");
  });
});
