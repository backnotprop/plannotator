/**
 * Decision mode's switch (approval "inbox-decision-mode-one-send") on a running Inbox: on unless the person turned
 * it off (config.json `inboxDecisionMode`, read with the old `experimental.decisionMode` as its fallback), saved by
 * Settings → Capabilities (`POST /api/inbox/settings` `{ decision_mode: { on } }`), and every window hears each
 * change through `event: capabilities`. Also the picks route's `unsent_only`, which decision mode's picks use.
 * Every test runs under its own temp data dir.
 *
 * What regresses: decision mode off for someone who never turned it off; an old experimental "off" lost; a switch
 * another window does not hear; the old experimental place still taking saves; a pick that raced a Send reopening
 * what went.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
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

type Settings = { decision_mode?: { on: boolean }; experimental?: Record<string, unknown>; board?: { on: boolean } };
type Frame = { board?: { on: boolean }; steps?: { on: boolean }; decision_mode?: { on: boolean } };

/** A fresh Inbox whose config.json is its own (the Inbox reads config through PLANNOTATOR_DATA_DIR). */
async function setup(config: Record<string, unknown> | null = null) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-decisions-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_EXPERIMENTAL;
  if (config) writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false });
  servers.push(server);
  const client = new Client({ name: "inbox-decisions-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const saved = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Record<string, unknown>;
  return { server, client, project, dataDir, saved };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const block = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
const read = async (server: InboxServer) => (await (await fetch(`${base(server)}/api/inbox/settings`)).json()) as Settings;

const post = (server: InboxServer, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });

/** A window's event stream: the `event: capabilities` frames, as they arrive. */
async function windowCapabilities(server: InboxServer) {
  const controller = new AbortController();
  const response = await fetch(`${base(server)}/api/inbox/events?window=decision-mode-test`, { signal: controller.signal, headers: { "Sec-Fetch-Site": "same-origin" } });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let hello = false;
  let buffer = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        if (event === "hello") hello = true;
        if (event === "capabilities") frames.push(JSON.parse(/^data: (.*)$/m.exec(chunk)![1]!) as Frame);
      }
    }
  })();
  const until = async (ready: () => boolean) => {
    const end = Date.now() + 5_000;
    while (!ready()) {
      if (Date.now() > end) throw new Error("timed out waiting for the event stream");
      await Bun.sleep(5);
    }
  };
  await until(() => hello);
  return { frames, next: (count: number) => until(() => frames.length >= count), stop: async () => (controller.abort(), await pump) };
}

describe("the switch", () => {
  test("on by default: the read says on, it is not an experimental feature, and another switch's event leaves it out", async () => {
    const { server } = await setup();
    const settings = await read(server);
    expect(settings.decision_mode).toEqual({ on: true });
    expect(settings.experimental).toEqual({ grid: { on: false, env: null } });
    const stream = await windowCapabilities(server);
    expect((await post(server, "/api/inbox/settings", { steps: { on: true } })).status).toBe(200);
    await stream.next(1);
    expect("decision_mode" in stream.frames[0]!).toBe(false);
    await stream.stop();
  });

  test("turned off, then back on: config.json, the answer, the read and every window follow", async () => {
    const { server, saved } = await setup();
    const stream = await windowCapabilities(server);
    const off = await post(server, "/api/inbox/settings", { decision_mode: { on: false } });
    expect(off.status).toBe(200);
    expect(((await off.json()) as Settings).decision_mode).toEqual({ on: false });
    expect(saved().inboxDecisionMode).toBe(false);
    expect((await read(server)).decision_mode).toEqual({ on: false });
    await stream.next(1);
    expect(stream.frames[0]!.decision_mode).toEqual({ on: false });
    // While it is off, another switch's frame still carries it, so no window turns it back on by itself.
    expect((await post(server, "/api/inbox/settings", { steps: { on: true } })).status).toBe(200);
    await stream.next(2);
    expect(stream.frames[1]!.decision_mode).toEqual({ on: false });

    const on = await post(server, "/api/inbox/settings", { decision_mode: { on: true } });
    expect(((await on.json()) as Settings).decision_mode).toEqual({ on: true });
    expect(saved().inboxDecisionMode).toBe(true);
    expect((await read(server)).decision_mode).toEqual({ on: true });
    await stream.next(3);
    expect(stream.frames[2]!.decision_mode).toEqual({ on: true });
    // Saving the same state again tells nobody.
    expect((await post(server, "/api/inbox/settings", { decision_mode: { on: true } })).status).toBe(200);
    await Bun.sleep(50);
    expect(stream.frames).toHaveLength(3);
    await stream.stop();
  });

  test("an old experimental choice is kept: off stays off until the switch is used, and the other experimental keys stay", async () => {
    const { server, saved } = await setup({ experimental: { decisionMode: false, otherFlag: true }, inboxTextSize: 13 });
    expect((await read(server)).decision_mode).toEqual({ on: false });
    expect((await post(server, "/api/inbox/settings", { decision_mode: { on: true } })).status).toBe(200);
    expect((await read(server)).decision_mode).toEqual({ on: true });
    expect(saved()).toMatchObject({ inboxDecisionMode: true, experimental: { decisionMode: false, otherFlag: true }, inboxTextSize: 13 });
  });

  test("refuses a bad body, the old experimental place, another site and a stale session, and writes nothing", async () => {
    const { server, dataDir } = await setup({ inboxDecisionMode: false });
    const before = readFileSync(join(dataDir, "config.json"), "utf8");
    for (const bad of [true, { on: "yes" }, { on: true, other: 1 }, {}, []]) {
      expect((await post(server, "/api/inbox/settings", { decision_mode: bad })).status).toBe(422);
    }
    // Decision mode left Experimental: the old body is refused like any unknown key.
    const old = await post(server, "/api/inbox/settings", { experimental: { decision_mode: true } });
    expect(old.status).toBe(422);
    expect(((await old.json()) as { code: string }).code).toBe("validation_error");
    // Nothing else in a refused request is saved either.
    expect((await post(server, "/api/inbox/settings", { decision_mode: { on: "yes" }, text_size: 12 })).status).toBe(422);
    const cross = await post(server, "/api/inbox/settings", { decision_mode: { on: true } }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
    expect(cross.status).toBe(403);
    const stale = await fetch(`${base(server)}/api/inbox/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: "not-this-one", decision_mode: { on: true } }),
    });
    expect(stale.status).toBe(409);
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(before);
    expect((await read(server)).decision_mode).toEqual({ on: false });
  });

  test("PLANNOTATOR_EXPERIMENTAL no longer names it", async () => {
    const { server } = await setup();
    process.env.PLANNOTATOR_EXPERIMENTAL = "-decision-mode";
    expect((await read(server)).decision_mode).toEqual({ on: true });
    // So it never locks the switch.
    expect((await post(server, "/api/inbox/settings", { decision_mode: { on: false } })).status).toBe(200);
    expect((await read(server)).decision_mode).toEqual({ on: false });
  });

  test("Grid's switch (approval \"inbox-agent-grid\") saves on its own, off by default, and leaves decision mode", async () => {
    const { server, saved } = await setup({ inboxDecisionMode: false });
    const on = await post(server, "/api/inbox/settings", { experimental: { grid: true } });
    expect(on.status).toBe(200);
    expect(((await on.json()) as Settings).experimental).toEqual({ grid: { on: true, env: null } });
    expect(saved()).toMatchObject({ inboxDecisionMode: false, experimental: { grid: true } });
    process.env.PLANNOTATOR_EXPERIMENTAL = "-grid";
    expect((await post(server, "/api/inbox/settings", { experimental: { grid: true } })).status).toBe(409);
    delete process.env.PLANNOTATOR_EXPERIMENTAL;
  });
});

describe("the picks route's unsent_only", () => {
  test("a pick that raced the Send is refused (question_already_sent), and the answer stays sent", async () => {
    const { server, client, project } = await setup();
    const result = await client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: "ses-a", agent_host: "claude-code", body: block("Ship it?") } });
    expect(result.isError).toBeFalsy();
    const asked = result.structuredContent as { message_id: string };
    const [q] = server.store.questionsOf(asked.message_id);
    const answer = (selected: string) => ({ v: 1, key: q!.key, kind: "single", prompt: "Ship it?", selected: [selected] });
    expect((await post(server, `/api/inbox/messages/${asked.message_id}/picks`, { questions: [{ key: q!.key, revision: 0, answer: answer("Yes") }] })).status).toBe(200);
    expect((await post(server, `/api/inbox/messages/${asked.message_id}/reply`, { idempotency_key: "k1", words: "", questions: [{ key: q!.key, revision: 1 }] })).status).toBe(200);
    // The window read revision 1 before the Send: its pick lands after it.
    const raced = await post(server, `/api/inbox/messages/${asked.message_id}/picks`, { unsent_only: true, questions: [{ key: q!.key, revision: 1, answer: answer("No") }] });
    expect(raced.status).toBe(409);
    expect(((await raced.json()) as { code: string }).code).toBe("question_already_sent");
    expect((await post(server, `/api/inbox/messages/${asked.message_id}/picks`, { unsent_only: "yes", questions: [{ key: q!.key, revision: 1, answer: answer("No") }] })).status).toBe(422);
    const after = server.store.questionsOf(asked.message_id)[0]!;
    expect(after.state).toBe("sent");
    expect(after.answer?.selected).toEqual(["Yes"]);
  });
});
