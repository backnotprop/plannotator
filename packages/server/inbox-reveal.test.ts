/**
 * The Board reveal for returning users and the reveals' queue (approval "inbox-feature-reveal", 2026-11-03) on a real
 * Inbox in a temp data dir.
 *
 * What regresses: the reveal turning on a Board the person set (on or off) or writing anything but unset -> true; two
 * tabs both showing it; a guest claiming it, or the owner's own pages (their phone, an allowed login on a tagged
 * machine) being held back; the claim not stamping the Board's first-visit dialog (it would show twice); `card` or any
 * other agent word arriving before the claim, or not after it; a dev build deciding it; the Snooze announcement losing
 * its 48 h spacing or its stamp of the spacing clock; a stuck Snooze holding the Board back. The Checklist reveal
 * (approval "inbox-checklist-reveal", 2026-11-04): its claim writing anything but `inboxSteps` unset -> true, or touching
 * a Checklist the person set; agent text changing before the claim, or not being the steps text after it; a guest
 * claiming it; its 5 days or 5 threads moving; it needing the Board on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxAgentTool, parseInboxToolList } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAGIC = "macbook-pro.tail0000.ts.net";
const OWNER = "owner@example.com";
const GUEST = "guest@example.com";
const RELEASE = "0.30.0";

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

/** A scripted `tailscale` (the real one never runs): the owner's machine, or a tagged one with no owner. */
function fakeTailscale(tagged: boolean): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") {
      return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42, ...(tagged ? { Tags: ["tag:server"] } : {}) }, User: { "42": { ID: 42, LoginName: tagged ? "tagged-devices" : OWNER } } }));
    }
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      return ok(
        JSON.stringify({
          TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
          Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
        }),
      );
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n`);
  };
}

interface Options {
  version?: string;
  /** Days since first use: the event log's first record is that old. */
  days?: number;
  /** Threads in the store. */
  threads?: number;
  /** More of config.json (the Board switch, the Snooze and reveal stamps). By default Snooze was shown 3 days ago. */
  config?: Record<string, unknown>;
  /** Published over the tailnet: the owner's phone and a guest can reach it; `tagged`: a machine with no owner. */
  tailnet?: "owner" | "tagged";
}

type Json = Record<string, any>;

async function world(options: Options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reveal-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  for (const name of ["PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_URL_HOST", "PLANNOTATOR_UPDATE_CHECK"]) setEnv(name, undefined);
  const days = options.days ?? 4;
  const config: Record<string, unknown> = {
    updateCheck: false,
    inboxSnoozeIntro: { firstUseAt: new Date(Date.now() - days * DAY).toISOString(), shownAt: new Date(Date.now() - 3 * DAY).toISOString() },
    ...options.config,
  };
  if (options.tailnet === "owner") Object.assign(config, { inboxTailscale: true, inboxTailscaleAllow: [GUEST] });
  // A tagged machine names no owner: the owner reaches it with a login they allowed.
  if (options.tailnet === "tagged") Object.assign(config, { inboxTailscale: true, inboxTailscaleAllow: [OWNER] });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  const then = new Date(Date.now() - days * DAY);
  const store = InboxStore.open(dataDir, { now: () => then });
  const project = store.ensureProject({ name: "docs", root: join(root, "docs") });
  // One session's messages make one thread: a session each.
  for (let i = 0; i < (options.threads ?? 6); i++) {
    store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: `ses_${i}`, name: "Claude Code" }, body: `Question ${i}?` });
  }
  const home = join(root, "home");
  mkdirSync(home);
  const server = await startInboxServer({
    dataDir,
    binaryPath: null,
    phones: false,
    version: options.version ?? RELEASE,
    ...(options.tailnet ? { tailscale: fakeTailscale(options.tailnet === "tagged") } : {}),
    agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: {} }),
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: Record<string, unknown> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
  const viaTailnet = (who: string, path: string, body?: Record<string, unknown>) => {
    const listener = server.tailscale.listenerPort();
    if (listener === null) throw new Error("not published");
    return fetch(`http://127.0.0.1:${listener}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Host: `${MAGIC}:${server.port}`,
        Origin: `https://${MAGIC}:${server.port}`,
        "Sec-Fetch-Site": "same-origin",
        "X-Forwarded-Proto": "https",
        "Tailscale-User-Login": who,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify({ serverSession: server.serverSession, ...body }) } : {}),
    });
  };
  const settings = async () => (await (await fetch(`${base}/api/inbox/settings?store=0`)).json()) as Json;
  const next = async () => (await settings()).reveal.next as string | null;
  const claim = async (id = "board") => (await (await post("/api/inbox/reveal", { id })).json()) as { show: boolean; reveal: { next: string | null }; board: { on: boolean }; steps: { on: boolean } };
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
    return (JSON.parse(data ? data.slice(5) : text) as { result: unknown }).result;
  };
  /** Every word an agent gets from this Inbox at session start: the server instructions, the tool list, and the agent tool built from it. */
  const agentText = async () => {
    const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })) as Json;
    const list = await rpc("tools/list", {});
    return JSON.stringify({ instructions: init.instructions, list, tool: inboxAgentTool(parseInboxToolList(list)) });
  };
  const toolNames = async () => parseInboxToolList(await rpc("tools/list", {})).map((tool) => tool.name);
  return { server, base, post, viaTailnet, settings, next, claim, saved, agentText, toolNames, dataDir };
}

describe("the Board reveal at day 4", () => {
  test("next is the Board; before the claim no card and agent text byte-equal to a Board switched off; the claim turns it on in one save", async () => {
    // Today's Board-off Inbox, the same day 4: what agents read.
    const off = await world({ config: { inboxBoard: false } });
    expect(await off.next()).toBeNull();
    const today = await off.agentText();

    const w = await world();
    expect(w.saved().inboxBoard).toBeUndefined();
    expect(await w.next()).toBe("board");
    expect((await w.settings()).board).toEqual({ on: false });
    // Armed, not claimed: the queue adds no word for agents.
    expect(await w.toolNames()).not.toContain("card");
    expect(await w.agentText()).toBe(today);

    const answer = await w.claim();
    expect(answer).toEqual({ show: true, reveal: { next: null }, board: { on: true }, steps: { on: false } });
    const config = w.saved();
    expect(config.inboxBoard).toBe(true);
    // One instant for the Board's own stamp, the reveal's and the spacing clock: the same save.
    const at = config.inboxReveals.board.shownAt;
    expect(config.inboxBoardIntro.shownAt).toBe(at);
    expect(config.inboxReveals.lastShownAt).toBe(at);
    // The first visit to #board never shows its dialog again; the switch stays the person's.
    expect(await (await w.post("/api/inbox/board/intro")).json()).toEqual({ show: false });
    expect(await w.toolNames()).toContain("card");
    // Never again: not next, and a second claim (a reload, another tab) shows nothing.
    expect(await w.next()).toBeNull();
    expect((await w.claim()).show).toBe(false);
  });

  test("never over a Board the person set: on stays on, off stays off, nothing is written", async () => {
    for (const set of [true, false]) {
      const w = await world({ config: { inboxBoard: set } });
      const before = readFileSync(join(w.dataDir, "config.json"), "utf8");
      expect(await w.next()).toBeNull();
      expect((await w.claim()).show).toBe(false);
      expect(readFileSync(join(w.dataDir, "config.json"), "utf8")).toBe(before);
    }
  });

  test("two tabs claim at once: exactly one shows it", async () => {
    const w = await world();
    const answers = await Promise.all([w.claim(), w.claim(), w.claim()]);
    expect(answers.filter((a) => a.show)).toHaveLength(1);
    expect(w.saved().inboxBoard).toBe(true);
  });

  test("405, 409, and an id that is not a reveal", async () => {
    const w = await world();
    expect((await fetch(`${w.base}/api/inbox/reveal`)).status).toBe(405);
    expect((await w.post("/api/inbox/reveal", { id: "board", serverSession: "another" })).status).toBe(409);
    const bad = await w.post("/api/inbox/reveal", { id: "dialog" });
    expect(bad.ok).toBe(false);
    expect(((await bad.json()) as Json).code).toBe("validation_error");
    // At day 4 the Checklist is not due (5 days): its claim shows nothing and writes nothing.
    expect((await w.claim("steps")).show).toBe(false);
    expect(w.saved().inboxBoard).toBeUndefined();
    expect(w.saved().inboxSteps).toBeUndefined();
  });

  test("a dev build decides nothing", async () => {
    const w = await world({ version: "0.0.0-dev" });
    expect(await w.next()).toBeNull();
    expect((await w.claim()).show).toBe(false);
    expect(w.saved().inboxBoard).toBeUndefined();
    expect(w.saved().inboxReveals).toBeUndefined();
  });

  test("tenure and threads: under 3 days or under 5 threads, it waits", async () => {
    expect(await (await world({ days: 2.9 })).next()).toBeNull();
    expect(await (await world({ threads: 4 })).next()).toBeNull();
    expect(await (await world({ threads: 5 })).next()).toBe("board");
  });

  test("an upgrade: Snooze and voice shown an hour ago by an Inbox before the reveals (no inboxReveals key): nothing is due", async () => {
    const hourAgo = new Date(Date.now() - HOUR).toISOString();
    const w = await world({
      config: {
        inboxSnoozeIntro: { firstUseAt: new Date(Date.now() - 4 * DAY).toISOString(), shownAt: hourAgo },
        inboxVoiceIntro: { dueAt: new Date(Date.now() - 2 * DAY).toISOString(), shownAt: hourAgo },
      },
    });
    expect(w.saved().inboxReveals).toBeUndefined();
    expect(await w.next()).toBeNull();
    expect((await w.claim()).show).toBe(false);
    expect(w.saved().inboxBoard).toBeUndefined();
  });

  test("a fresh install's list options and voice marks (shownAt with no dueAt: never shown) do not hold it back", async () => {
    const hourAgo = new Date(Date.now() - HOUR).toISOString();
    const w = await world({ config: { inboxListIntro: { shownAt: hourAgo }, inboxVoiceIntro: { shownAt: hourAgo } } });
    expect(await w.next()).toBe("board");
  });

  test("someone who already saw the Board's first-visit dialog (before the Board was a switch): the claim turns the Board on, no dialog", async () => {
    const seen = new Date(Date.now() - 20 * DAY).toISOString();
    const w = await world({ config: { inboxBoardIntro: { shownAt: seen } } });
    expect(await w.next()).toBe("board");
    const answer = await w.claim();
    expect(answer.show).toBe(false);
    expect(answer.board.on).toBe(true);
    const saved = w.saved();
    expect(saved.inboxBoard).toBe(true);
    expect(saved.inboxBoardIntro.shownAt).toBe(seen);
    expect(saved.inboxReveals.board.shownAt).toBe(saved.inboxReveals.lastShownAt);
    // Spent: never claimed again.
    expect(await w.next()).toBeNull();
    expect((await w.claim()).show).toBe(false);
  });

  test("the same person with the Board switched off: never claimed, false stays false", async () => {
    const w = await world({ config: { inboxBoard: false, inboxBoardIntro: { shownAt: new Date(Date.now() - 20 * DAY).toISOString() } } });
    expect(await w.next()).toBeNull();
    expect((await w.claim()).show).toBe(false);
    expect(w.saved().inboxBoard).toBe(false);
    expect(w.saved().inboxReveals?.board).toBeUndefined();
  });

  test("a dev build's list options claim does not stamp the spacing clock", async () => {
    const w = await world({ version: "0.0.0-dev", config: { inboxListIntro: { dueAt: new Date(Date.now() - DAY).toISOString() } } });
    expect(((await (await w.post("/api/inbox/list-intro")).json()) as Json).show).toBe(true);
    expect(w.saved().inboxListIntro.shownAt).toMatch(/^\d{4}-/);
    expect(w.saved().inboxReveals).toBeUndefined();
  });
});

describe("the Checklist reveal at day 6", () => {
  /** Day 6, the Board already decided (on) and revealed 3 days ago, the Checklist never set. */
  const day6 = (config: Record<string, unknown> = {}, more: Options = {}) =>
    world({ days: 6, config: { inboxBoard: true, inboxReveals: { lastShownAt: new Date(Date.now() - 3 * DAY).toISOString() }, ...config }, ...more });

  test("next is the Checklist; agent text byte-equal to a Checklist off until the claim, the steps text after; the claim writes unset -> true in one save", async () => {
    const off = await day6({ inboxSteps: false });
    expect(await off.next()).toBeNull();
    const today = await off.agentText();
    const on = await day6({ inboxSteps: true });
    expect(await on.next()).toBeNull();
    const stepsText = await on.agentText();
    expect(stepsText).not.toBe(today);

    const w = await day6();
    expect(w.saved().inboxSteps).toBeUndefined();
    expect(await w.next()).toBe("steps");
    expect((await w.settings()).steps).toEqual({ on: false });
    // Armed, not claimed: no word of it reaches an agent.
    expect(await w.toolNames()).not.toContain("steps");
    expect(await w.agentText()).toBe(today);

    const answer = await w.claim("steps");
    expect(answer).toEqual({ show: true, reveal: { next: null }, board: { on: true }, steps: { on: true } });
    const config = w.saved();
    expect(config.inboxSteps).toBe(true);
    expect(config.inboxReveals.steps.shownAt).toBe(config.inboxReveals.lastShownAt);
    expect((await w.settings()).steps).toEqual({ on: true });
    // From the next session: the approved steps text, byte for byte.
    expect(await w.agentText()).toBe(stepsText);
    // Never again: not next, and a second claim (a reload, another tab) shows nothing and writes nothing.
    const after = readFileSync(join(w.dataDir, "config.json"), "utf8");
    expect(await w.next()).toBeNull();
    expect((await w.claim("steps")).show).toBe(false);
    expect(readFileSync(join(w.dataDir, "config.json"), "utf8")).toBe(after);
  });

  test("never over a Checklist the person set: on stays on, off stays off, nothing is written", async () => {
    for (const set of [true, false]) {
      const w = await day6({ inboxSteps: set });
      const before = readFileSync(join(w.dataDir, "config.json"), "utf8");
      expect(await w.next()).toBeNull();
      expect((await w.claim("steps")).show).toBe(false);
      expect(readFileSync(join(w.dataDir, "config.json"), "utf8")).toBe(before);
      expect(w.saved().inboxSteps).toBe(set);
    }
  });

  test("the Board need not be on: a Board switched off still gets the Checklist", async () => {
    const w = await day6({ inboxBoard: false });
    expect(await w.next()).toBe("steps");
    expect((await w.claim("steps")).show).toBe(true);
    expect(w.saved().inboxSteps).toBe(true);
    expect(w.saved().inboxBoard).toBe(false);
  });

  test("after the Board in the queue: an undecided Board goes first, and the Checklist waits out the 48 h after it", async () => {
    const w = await world({ days: 6 });
    expect(await w.next()).toBe("board");
    expect((await w.claim("steps")).show).toBe(false);
    expect((await w.claim("board")).show).toBe(true);
    expect(await w.next()).toBeNull();
    expect((await w.claim("steps")).show).toBe(false);
    expect(w.saved().inboxSteps).toBeUndefined();
  });

  test("two tabs claim at once: exactly one shows it", async () => {
    const w = await day6();
    const answers = await Promise.all([w.claim("steps"), w.claim("steps"), w.claim("steps")]);
    expect(answers.filter((a) => a.show)).toHaveLength(1);
    expect(w.saved().inboxSteps).toBe(true);
  });

  test("tenure and threads: under 5 days or under 5 threads, it waits", async () => {
    expect(await (await day6({}, { days: 4.9 })).next()).toBeNull();
    expect(await (await day6({}, { threads: 4 })).next()).toBeNull();
    expect(await (await day6({}, { days: 5, threads: 5 })).next()).toBe("steps");
  });

  test("a dev build decides nothing", async () => {
    const w = await day6({}, { version: "0.0.0-dev" });
    expect(await w.next()).toBeNull();
    expect((await w.claim("steps")).show).toBe(false);
    expect(w.saved().inboxSteps).toBeUndefined();
  });

  test("over the tailnet: a guest is never armed and never claims; the owner's phone claims", async () => {
    const w = await day6({}, { tailnet: "owner" });
    const guestSettings = (await (await w.viaTailnet(GUEST, "/api/inbox/settings?store=0")).json()) as Json;
    expect(guestSettings.reveal).toEqual({ next: null });
    expect(((await (await w.viaTailnet(GUEST, "/api/inbox/reveal", { id: "steps" })).json()) as Json).show).toBe(false);
    expect(w.saved().inboxSteps).toBeUndefined();
    const ownerSettings = (await (await w.viaTailnet(OWNER, "/api/inbox/settings?store=0")).json()) as Json;
    expect(ownerSettings.reveal).toEqual({ next: "steps" });
    expect(((await (await w.viaTailnet(OWNER, "/api/inbox/reveal", { id: "steps" })).json()) as Json).show).toBe(true);
    expect(w.saved().inboxSteps).toBe(true);
  });
});

describe("over the tailnet", () => {
  test("a guest is never armed and never claims; the owner's phone claims", async () => {
    const w = await world({ tailnet: "owner" });
    const guestSettings = (await (await w.viaTailnet(GUEST, "/api/inbox/settings?store=0")).json()) as Json;
    expect(guestSettings.reveal).toEqual({ next: null });
    expect(((await (await w.viaTailnet(GUEST, "/api/inbox/reveal", { id: "board" })).json()) as Json).show).toBe(false);
    expect(w.saved().inboxBoard).toBeUndefined();
    const ownerSettings = (await (await w.viaTailnet(OWNER, "/api/inbox/settings?store=0")).json()) as Json;
    expect(ownerSettings.reveal).toEqual({ next: "board" });
    expect(((await (await w.viaTailnet(OWNER, "/api/inbox/reveal", { id: "board" })).json()) as Json).show).toBe(true);
    expect(w.saved().inboxBoard).toBe(true);
  });

  test("the Board's first-visit dialog: a guest never claims it, the owner's phone does, once", async () => {
    const w = await world({ tailnet: "owner", config: { inboxBoard: true } });
    const intro = async (who: string) => ((await (await w.viaTailnet(who, "/api/inbox/board/intro", {})).json()) as Json).show;
    expect(await intro(GUEST)).toBe(false);
    // The guest's ask spent nothing.
    expect(w.saved().inboxBoardIntro).toBeUndefined();
    expect(await intro(OWNER)).toBe(true);
    expect(w.saved().inboxBoardIntro.shownAt).toMatch(/^\d{4}-/);
    expect(await intro(OWNER)).toBe(false);
    expect(await (await w.post("/api/inbox/board/intro")).json()).toEqual({ show: false });
  });

  test("a tagged machine: an allowed login claims the Board's first-visit dialog", async () => {
    const tagged = await world({ tailnet: "tagged", config: { inboxBoard: true } });
    expect(((await (await tagged.viaTailnet(OWNER, "/api/inbox/board/intro", {})).json()) as Json).show).toBe(true);
  });

  test("a tagged machine: the login the owner allowed counts as the owner for the reveal", async () => {
    const w = await world({ tailnet: "tagged" });
    const settings = (await (await w.viaTailnet(OWNER, "/api/inbox/settings?store=0")).json()) as Json;
    expect(settings.reveal).toEqual({ next: "board" });
    expect(((await (await w.viaTailnet(OWNER, "/api/inbox/reveal", { id: "board" })).json()) as Json).show).toBe(true);
    expect(w.saved().inboxBoard).toBe(true);
  });
});

describe("the queue with Snooze", () => {
  test("Snooze first at day 4 when it was never shown; its claim stamps the spacing clock, and the Board waits 48 h", async () => {
    const w = await world({ config: { inboxSnoozeIntro: { firstUseAt: new Date(Date.now() - 4 * DAY).toISOString() } } });
    expect(await w.next()).toBe("snooze");
    // A tab that armed the Board (loaded earlier) is refused while Snooze is next.
    expect((await w.claim("board")).show).toBe(false);
    expect((await (await w.post("/api/inbox/snooze-intro")).json()) as Json).toMatchObject({ show: true });
    const config = w.saved();
    expect(config.inboxReveals.lastShownAt).toBe(config.inboxSnoozeIntro.shownAt);
    expect(await w.next()).toBeNull();
    expect((await w.claim("board")).show).toBe(false);
  });

  test("Snooze gains the spacing: another announcement under 48 h ago holds it back", async () => {
    const w = await world({ config: { inboxSnoozeIntro: { firstUseAt: new Date(Date.now() - 4 * DAY).toISOString() }, inboxReveals: { lastShownAt: new Date(Date.now() - 47 * HOUR).toISOString() } } });
    expect((await w.settings()).snooze_intro).toEqual({ due: false });
    expect(((await (await w.post("/api/inbox/snooze-intro")).json()) as Json).show).toBe(false);
    expect(w.saved().inboxSnoozeIntro.shownAt).toBeUndefined();
  });

  test("a Snooze next for 3 days without its moment lets the Board go first; the first time it was next is kept", async () => {
    const snoozeOnly = { inboxSnoozeIntro: { firstUseAt: new Date(Date.now() - 10 * DAY).toISOString() } };
    const fresh = await world({ config: snoozeOnly });
    expect(await fresh.next()).toBe("snooze");
    const since = fresh.saved().inboxReveals.waitingSince.snooze;
    expect(Date.now() - Date.parse(since)).toBeLessThan(60_000);
    // Asked again later: the first time stands.
    await fresh.next();
    expect(fresh.saved().inboxReveals.waitingSince.snooze).toBe(since);

    const stuck = await world({ config: { ...snoozeOnly, inboxReveals: { waitingSince: { snooze: new Date(Date.now() - 3 * DAY).toISOString() } } } });
    expect(await stuck.next()).toBe("board");
    expect((await stuck.settings()).snooze_intro).toEqual({ due: false });
    expect((await stuck.claim()).show).toBe(true);
  });

  test("the list options dialog's claim counts toward the spacing", async () => {
    const w = await world({ config: { inboxListIntro: { dueAt: new Date(Date.now() - DAY).toISOString() } } });
    expect(await w.next()).toBe("board");
    expect(((await (await w.post("/api/inbox/list-intro")).json()) as Json).show).toBe(true);
    expect(w.saved().inboxReveals.lastShownAt).toBe(w.saved().inboxListIntro.shownAt);
    expect(await w.next()).toBeNull();
  });
});
