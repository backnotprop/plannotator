/**
 * Bro mode (approval "bro-mode", 2026-11-05) on a real Inbox in a temp data dir: the switch, the line in the tool list,
 * and the one-time offer.
 *
 * What regresses: Bro mode off or undecided changing a byte of what an agent reads; on, the line reaching anything but
 * send_message's `body`; the switch needing a restart; the offer turning anything on, showing twice, or overriding a
 * person's own setting; a test run or dev build meeting the offer, which would put a dialog in front of every spec.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** An Inbox with Snooze and the rest of the queue behind the person, so only Bro mode can be next. */
async function world(options: { config?: Record<string, unknown>; version?: string; broOffer?: boolean; firstUseDays?: number } = {}) {
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
      inboxSnoozeIntro: { firstUseAt: new Date(Date.now() - (options.firstUseDays ?? 0) * DAY).toISOString(), snoozedAt: new Date(Date.now() - 3 * DAY).toISOString() },
      ...options.config,
    }),
  );
  const home = join(root, "home");
  mkdirSync(home);
  const server = await startInboxServer({
    dataDir,
    binaryPath: null,
    phones: false,
    version: options.version ?? "0.30.0",
    ...(options.broOffer === undefined ? {} : { broOffer: options.broOffer }),
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

describe("the offer", () => {
  test("a test run's build never meets it, and neither does a dev build", async () => {
    expect(await (await world()).next()).toBeNull();
    const dev = await world({ version: "0.0.0-dev", broOffer: true });
    expect(await dev.next()).toBeNull();
    expect((await dev.claim()).show).toBe(false);
  });

  test("everyone, from the first day: next, once; the claim turns nothing on and leaves agent text as off", async () => {
    const w = await world({ broOffer: true });
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

  test("goes ahead of Snooze, and the 48 h spacing still holds it back", async () => {
    const ahead = await world({ broOffer: true, firstUseDays: 3, config: { inboxSnoozeIntro: { firstUseAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString() } } });
    expect(await ahead.next()).toBe("bro");
    const spaced = await world({ broOffer: true, config: { inboxReveals: { lastShownAt: new Date(Date.now() - 3_600_000).toISOString() } } });
    expect(await spaced.next()).toBeNull();
    expect((await spaced.claim()).show).toBe(false);
  });

  for (const inboxBro of [true, false]) {
    test(`a person who set it ${inboxBro ? "on" : "off"} is never offered it, and their setting stays`, async () => {
      const w = await world({ broOffer: true, config: { inboxBro } });
      expect(await w.next()).toBeNull();
      expect((await w.claim()).show).toBe(false);
      expect(w.saved().inboxBro).toBe(inboxBro);
      expect(w.saved().inboxReveals?.bro).toBeUndefined();
    });
  }
});
