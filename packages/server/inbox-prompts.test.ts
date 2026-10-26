/**
 * Settings → Prompts on a running Inbox (#2194): `GET /api/inbox/settings`
 * carries `prompts`, and `POST { prompts: { inbox } }` writes only
 * config.json `prompts.inbox` (a string sets a key, null deletes it, every
 * other key kept), refuses text over the cap with 422, and answers to the
 * window's usual guards.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxPromptsSettings } from "@plannotator/core/inbox-types";
import { INBOX_REMINDER_MAX_CHARS, INBOX_REMINDER_TEXT, INBOX_REMINDER_TEXT_NO_WAKE } from "@plannotator/shared/inbox/connection";
import { DEFAULT_PLAN_APPROVED_PROMPT, DEFAULT_REVIEW_DENIED_SUFFIX } from "@plannotator/shared/prompts";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";

const roots: string[] = [];
const servers: InboxServer[] = [];
let previousDataDir: string | undefined;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
});

/** A scratch data dir with this config.json (none for undefined); loadConfig reads it through the env. */
async function world(config?: unknown): Promise<{ server: InboxServer; dataDir: string; onDisk: () => any }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-prompts-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  if (config !== undefined) writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  return { server, dataDir, onDisk: () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) };
}

async function read(server: InboxServer): Promise<InboxPromptsSettings> {
  return ((await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`)).json()) as { prompts: InboxPromptsSettings }).prompts;
}

function post(server: InboxServer, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("Settings → Prompts", () => {
  test("with no prompts in config.json: the defaults, nothing custom, and twelve read-only prompts", async () => {
    const { server } = await world();
    const prompts = await read(server);
    expect(prompts.reminder).toEqual({
      shared: null,
      runtimes: { "claude-code": null, pi: null, opencode: null },
      defaults: { wake: INBOX_REMINDER_TEXT, no_wake: INBOX_REMINDER_TEXT_NO_WAKE },
      max: INBOX_REMINDER_MAX_CHARS,
      on: prompts.reminder.on,
      editable: true,
      wakes: { "claude-code": true, pi: true, opencode: true },
      over: { shared: null, runtimes: { "claude-code": null, pi: null, opencode: null } },
    });
    expect(prompts.others.map((item) => item.key)).toEqual([
      "prompts.plan.approved",
      "prompts.plan.approvedWithNotes",
      "prompts.plan.autoApproved",
      "prompts.plan.denied",
      "prompts.plan.answered",
      "prompts.review.approved",
      "prompts.review.approvedWithNotes",
      "prompts.review.denied",
      "prompts.annotate.fileFeedback",
      "prompts.annotate.messageFeedback",
      "prompts.annotate.approved",
      "prompts.annotate.approvedWithNotes",
    ]);
    expect(prompts.others.every((item) => !item.custom && item.text === item.default && item.runtimes.length === 0)).toBe(true);
    const approved = prompts.others[0]!;
    expect([approved.text, approved.note, approved.group_label]).toEqual([DEFAULT_PLAN_APPROVED_PROMPT, "OpenCode has a shorter default.", "Plan"]);
    expect(prompts.others[7]!.default).toBe(DEFAULT_REVIEW_DENIED_SUFFIX.replace(/^\n+/, ""));
  });

  test("the other prompts read config.json: shared text, and the agents with their own", async () => {
    const { server } = await world({ prompts: { review: { denied: "Check each finding.", runtimes: { pi: { approved: "Pi ok." } } } } });
    const others = (await read(server)).others;
    const denied = others.find((item) => item.key === "prompts.review.denied")!;
    expect([denied.text, denied.custom]).toEqual(["Check each finding.", true]);
    const approved = others.find((item) => item.key === "prompts.review.approved")!;
    expect([approved.custom, approved.runtimes]).toEqual([true, ["pi"]]);
  });

  test("a save writes only prompts.inbox, one key at a time; null and blank delete; every other key is kept", async () => {
    const { server, onDisk } = await world({
      displayName: "Ann",
      inboxReminder: { opencode: false },
      prompts: { review: { denied: "Keep me.", runtimes: { pi: { approved: "Pi ok." } } } },
    });
    const ok = (response: Response) => {
      expect(response.status).toBe(200);
      return response.json() as Promise<{ prompts: InboxPromptsSettings }>;
    };
    let answer = await ok(await post(server, { serverSession: server.serverSession, prompts: { inbox: { reminder: "Shared line." } } }));
    expect(answer.prompts.reminder.shared).toBe("Shared line.");
    expect(answer.prompts.reminder.on.opencode).toBe(false);
    answer = await ok(await post(server, { serverSession: server.serverSession, prompts: { inbox: { runtimes: { pi: { reminder: "Pi line." } } } } }));
    expect(answer.prompts.reminder.runtimes).toEqual({ "claude-code": null, pi: "Pi line.", opencode: null });
    expect(answer.prompts.reminder.shared).toBe("Shared line.");
    expect(onDisk()).toEqual({
      displayName: "Ann",
      inboxReminder: { opencode: false },
      prompts: {
        review: { denied: "Keep me.", runtimes: { pi: { approved: "Pi ok." } } },
        inbox: { reminder: "Shared line.", runtimes: { pi: { reminder: "Pi line." } } },
      },
    });
    // Reset to default (null) and Use shared (a blank string reads as null) delete their keys, and the emptied entries go.
    await ok(await post(server, { serverSession: server.serverSession, prompts: { inbox: { reminder: null } } }));
    expect(onDisk().prompts.inbox).toEqual({ runtimes: { pi: { reminder: "Pi line." } } });
    await ok(await post(server, { serverSession: server.serverSession, prompts: { inbox: { runtimes: { pi: { reminder: "   " } } } } }));
    expect(onDisk()).toEqual({ displayName: "Ann", inboxReminder: { opencode: false }, prompts: { review: { denied: "Keep me.", runtimes: { pi: { approved: "Pi ok." } } } } });
    expect((await read(server)).reminder.runtimes.pi).toBeNull();
  });

  test("text at the cap saves; one character over is refused with 422 and nothing is written", async () => {
    const { server, onDisk, dataDir } = await world({ theme: { mode: "dark" } });
    const atCap = "x".repeat(INBOX_REMINDER_MAX_CHARS);
    const over = await post(server, { serverSession: server.serverSession, prompts: { inbox: { reminder: `${atCap}y` } } });
    expect(over.status).toBe(422);
    expect(((await over.json()) as { field: string }).field).toBe("prompts.inbox.reminder");
    // A refused part saves nothing, the valid parts beside it included.
    const mixed = await post(server, { serverSession: server.serverSession, text_size: 13, prompts: { inbox: { runtimes: { pi: { reminder: `${atCap}y` } } } } });
    expect(mixed.status).toBe(422);
    expect(onDisk()).toEqual({ theme: { mode: "dark" } });
    const saved = await post(server, { serverSession: server.serverSession, prompts: { inbox: { reminder: atCap } } });
    expect(saved.status).toBe(200);
    expect(onDisk().prompts.inbox.reminder).toBe(atCap);
    // Text over the cap put in config.json by hand is ignored on read: the page shows the default.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ prompts: { inbox: { reminder: `${atCap}y` } } }));
    expect((await read(server)).reminder.shared).toBeNull();
  });

  test("text over the cap written into config.json by hand: reported as `over` (its length), so the page can say it is ignored", async () => {
    const long = "y".repeat(INBOX_REMINDER_MAX_CHARS + 72);
    const { server } = await world({ prompts: { inbox: { reminder: long, runtimes: { pi: { reminder: long }, opencode: { reminder: "OC." } } } } });
    const reminder = (await read(server)).reminder;
    expect([reminder.shared, reminder.runtimes.pi, reminder.runtimes.opencode]).toEqual([null, null, "OC."]);
    expect(reminder.over).toEqual({ shared: INBOX_REMINDER_MAX_CHARS + 72, runtimes: { "claude-code": null, pi: INBOX_REMINDER_MAX_CHARS + 72, opencode: null } });
    // Reset to default deletes it like any other text.
    const reset = await post(server, { serverSession: server.serverSession, prompts: { inbox: { reminder: null, runtimes: { pi: { reminder: null } } } } });
    expect(((await reset.json()) as { prompts: InboxPromptsSettings }).prompts.reminder.over).toEqual({ shared: null, runtimes: { "claude-code": null, pi: null, opencode: null } });
  });

  test("OpenCode 1 (its config's `plugin` list): `wakes.opencode` is false, so the page shows it the no-wake default", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-prompts-oc1-")));
    roots.push(root);
    const home = join(root, "home");
    const opencodeDir = join(root, "opencode");
    mkdirSync(home, { recursive: true });
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(join(opencodeDir, "opencode.json"), JSON.stringify({ plugin: [] }));
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    const server = await startInboxServer({
      dataDir,
      agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: { HOME: home, PATH: "", OPENCODE_CONFIG_DIR: opencodeDir } }),
    });
    servers.push(server);
    expect((await read(server)).reminder.wakes).toEqual({ "claude-code": true, pi: true, opencode: false });
    writeFileSync(join(opencodeDir, "opencode.json"), JSON.stringify({ plugins: [] }));
    expect((await read(server)).reminder.wakes).toEqual({ "claude-code": true, pi: true, opencode: true });
  });

  test("a malformed change is refused before anything is written", async () => {
    const { server, onDisk } = await world({ displayName: "Ann" });
    const bodies: unknown[] = [
      null,
      "text",
      { review: { denied: "no" } },
      { inbox: {} },
      { inbox: { reminder: 5 } },
      { inbox: { other: "x" } },
      { inbox: { runtimes: { codex: { reminder: "x" } } } },
      { inbox: { runtimes: { pi: "x" } } },
      { inbox: { runtimes: { pi: { reminder: "x", extra: 1 } } } },
      { inbox: { runtimes: {} } },
    ];
    for (const prompts of bodies) {
      const response = await post(server, { serverSession: server.serverSession, prompts });
      expect([JSON.stringify(prompts), response.status]).toEqual([JSON.stringify(prompts), 422]);
    }
    expect(onDisk()).toEqual({ displayName: "Ann" });
  });

  test("another site's page and a stale tab write nothing", async () => {
    const { server, onDisk } = await world({ displayName: "Ann" });
    const change = { prompts: { inbox: { reminder: "Mine." } } };
    const cross = await post(server, change, { Origin: "https://evil.example" });
    expect([cross.status, ((await cross.json()) as { code: string }).code]).toEqual([403, "cross_origin"]);
    const crossSite = await post(server, change, { "Sec-Fetch-Site": "same-site" });
    expect(crossSite.status).toBe(403);
    const stale = await post(server, { ...change, serverSession: "not-this-one" });
    expect(stale.status).toBe(409);
    expect(onDisk()).toEqual({ displayName: "Ann" });
  });
});
