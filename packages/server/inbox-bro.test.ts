/**
 * Bro mode (approval "bro-mode", 2026-11-05) on a real Inbox in a temp data dir: the switch, the line in the tool list,
 * and the one-time offer.
 *
 * What regresses: Bro mode off or undecided changing a byte of what an agent reads; on, the line reaching anything but
 * send_message's `body`; the switch needing a restart; the offer turning anything on, showing twice, or overriding a
 * person's own setting; the offer leaving the line of one-time dialogs (approval "inbox-one-time-dialogs": heavy use
 * only, never on day 0 or 1, the one-day spacing, Not now's gap); a dev build meeting the offer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxAgentTool, INBOX_BRO_LINE, parseInboxToolList } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { SEND_BODY_DESCRIPTION } from "./inbox-mcp";

const DAY = 24 * 3_600_000;

const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

type Json = Record<string, any>;

interface WorldOptions {
  config?: Record<string, unknown>;
  version?: string;
  /** Days since first use (default 3: past the offer's two days). */
  firstUseDays?: number;
  /** Threads the person read, each with an agent message on one of the last two days (default 0). */
  read?: number;
  /** The reads all on one day (heavy use needs two or more). */
  oneDay?: boolean;
}

/** An Inbox with Snooze and the rest of the line behind the person, so only Bro mode can be next. */
async function world(options: WorldOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-bro-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  for (const name of ["PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_URL_HOST", "PLANNOTATOR_UPDATE_CHECK"]) setEnv(name, undefined);
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({
      updateCheck: false,
      inboxBoard: false,
      inboxSteps: false,
      inboxCodeReview: false,
      inboxSnoozeIntro: { firstUseAt: new Date(Date.now() - (options.firstUseDays ?? 3) * DAY).toISOString(), snoozedAt: new Date(Date.now() - 3 * DAY).toISOString() },
      // The update-day dialogs (sound, list options, voice) come first in the line: settled here (a fresh install's marks).
      inboxSound: { dialogShownFor: options.version ?? "0.30.0" },
      inboxListIntro: { shownAt: new Date(Date.now() - 3 * DAY).toISOString(), version: 2 },
      inboxVoiceIntro: { shownAt: new Date(Date.now() - 3 * DAY).toISOString() },
      // The tab icon dialog (an update-day dialog): settled by a favicon already chosen.
      favicon: "glass",
      ...options.config,
    }),
  );
  // What the person read: heavy use counts the dates of the agent messages they looked at.
  let clock = new Date();
  const store = InboxStore.open(dataDir, { now: () => clock });
  const project = store.ensureProject({ name: "docs", root: join(root, "docs") });
  for (let i = 0; i < (options.read ?? 0); i++) {
    clock = new Date(Date.now() - (options.oneDay || i % 2 === 0 ? 1 : 2) * DAY);
    const thread = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: `ses_${i}`, name: "Claude Code" }, body: `Update ${i}.` }).message;
    store.markSeen(thread.id);
  }
  const home = join(root, "home");
  mkdirSync(home);
  const server = await startInboxServer({
    dataDir,
    binaryPath: null,
    phones: false,
    version: options.version ?? "0.30.0",
    agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: {} }),
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: Record<string, unknown> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
  const settings = async () => (await (await fetch(`${base}/api/inbox/settings?store=0`)).json()) as Json;
  const next = async () => (await settings()).reveal.next as string | null;
  const claim = async (key?: string) => (await (await post("/api/inbox/reveal", { id: "bro", ...(key ? { key } : {}) })).json()) as Json;
  const saved = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Json;
  let rpcId = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    return (JSON.parse(data ? data.slice(5) : text) as { result: Json }).result;
  };
  /** Every word an agent gets at session start, and the raw `body` fields of the Inbox's list and of the agent tool. */
  const agent = async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const list = await rpc("tools/list", {});
    const tool = inboxAgentTool(parseInboxToolList(list))!;
    return {
      text: JSON.stringify({ instructions: init.instructions, list, tool }),
      body: (list.tools as Json[]).find((entry) => entry.name === "send_message")!.inputSchema.properties.body.description as string,
      toolBody: (tool.inputSchema.properties as Json).body.description as string,
    };
  };
  return { post, settings, next, claim, saved, agent };
}

describe("the line", () => {
  test("unset and off are byte-equal to today's field; on, the line is in that one field and nowhere else", async () => {
    const unset = await (await world()).agent();
    expect(unset.body).toBe(SEND_BODY_DESCRIPTION);
    expect(unset.text).not.toContain(INBOX_BRO_LINE);
    const off = await (await world({ config: { inboxBro: false } })).agent();
    expect(off.text).toBe(unset.text);

    const on = await (await world({ config: { inboxBro: true } })).agent();
    expect(on.body.split(INBOX_BRO_LINE).length - 1).toBe(1);
    expect(on.toolBody.split(INBOX_BRO_LINE).length - 1).toBe(1);
    // Once in the list's `body` and once in the agent tool's, and with those two taken out the text is off's.
    expect(on.text.split(INBOX_BRO_LINE).length - 1).toBe(2);
    expect(on.text.replaceAll(`${INBOX_BRO_LINE} `, "")).toBe(off.text);
  });

  test("the switch takes effect at the next tool list, with no restart, and saves config.json", async () => {
    const w = await world();
    expect((await w.settings()).bro).toEqual({ on: false });
    expect(await (await w.post("/api/inbox/settings", { bro: { on: true } })).json()).toMatchObject({ bro: { on: true } });
    expect(w.saved().inboxBro).toBe(true);
    expect((await w.settings()).bro).toEqual({ on: true });
    expect((await w.agent()).body).toContain(INBOX_BRO_LINE);
    await w.post("/api/inbox/settings", { bro: { on: false } });
    expect(w.saved().inboxBro).toBe(false);
    expect((await w.agent()).body).toBe(SEND_BODY_DESCRIPTION);
    expect((await w.post("/api/inbox/settings", { bro: { on: "yes" } })).status).toBe(422);
  });
});

/** Heavy use (approval "inbox-one-time-dialogs"): 10 threads read in the last 7 days, on 2 days. */
const HEAVY = { read: 10 } as const;

describe("the offer", () => {
  test("a dev build never meets it", async () => {
    const dev = await world({ ...HEAVY, version: "0.0.0-dev" });
    expect(await dev.next()).toBeNull();
    expect((await dev.claim()).show).toBe(false);
  });

  test("heavy use: next, once; the claim turns nothing on and leaves agent text as off", async () => {
    const w = await world(HEAVY);
    const before = await w.agent();
    expect(await w.next()).toBe("bro");
    expect((await w.claim("key-one-1")).show).toBe(true);
    expect(w.saved().inboxBro).toBeUndefined();
    expect(w.saved().inboxReveals.bro.shownAt).toBe(w.saved().inboxReveals.lastShownAt);
    expect((await w.agent()).text).toBe(before.text);
    expect(await w.next()).toBeNull();
    // A second tab never shows it; the same page's retry after a lost answer does.
    expect((await w.claim("key-two-2")).show).toBe(false);
    expect((await w.claim("key-one-1")).show).toBe(true);
    // Turn it on, as Settings saves it.
    await w.post("/api/inbox/settings", { bro: { on: true } });
    expect((await w.agent()).body).toContain(INBOX_BRO_LINE);
    expect((await w.claim("key-one-1")).show).toBe(false);
  });

  for (const [name, options] of [
    ["nine threads read", { read: 9 }],
    ["ten threads read, all on one day", { read: 10, oneDay: true }],
    ["day 1 of use", { ...HEAVY, firstUseDays: 1 }],
    ["a dialog of the line less than a day ago", { ...HEAVY, config: { inboxReveals: { lastShownAt: new Date(Date.now() - 3_600_000).toISOString() } } }],
  ] as const) {
    test(`never for ${name}`, async () => {
      const w = await world(options);
      expect(await w.next()).toBeNull();
      expect((await w.claim()).show).toBe(false);
      expect(w.saved().inboxReveals?.bro).toBeUndefined();
    });
  }

  test("Not now writes no switch and holds the next dialog back (the line's gap)", async () => {
    const w = await world(HEAVY);
    expect((await w.claim()).show).toBe(true);
    expect((await w.post("/api/inbox/reveal", { id: "bro", answer: "not_now" })).status).toBe(200);
    expect(w.saved().inboxReveals.notNowAt).toMatch(/^\d{4}-/);
    expect(w.saved().inboxBro).toBeUndefined();
  });

  for (const inboxBro of [true, false]) {
    test(`a person who set it ${inboxBro ? "on" : "off"} is never offered it, and their setting stays`, async () => {
      const w = await world({ ...HEAVY, config: { inboxBro } });
      expect(await w.next()).toBeNull();
      expect((await w.claim()).show).toBe(false);
      expect(w.saved().inboxBro).toBe(inboxBro);
      expect(w.saved().inboxReveals?.bro).toBeUndefined();
    });
  }
});
