/**
 * The one-time Snooze announcement's "who" and its claim (approval "inbox-snooze-announce") on a real Inbox in a temp
 * data dir. What regresses: a dev build deciding it; a new user (first use under two days) getting it; the backfill
 * not reading first use from the event log on upgrade, or missing a snooze running at upgrade; a snooze by some route
 * (the window, the owner's phone over the tailnet, a phone app through the door, a linked machine's forward) not
 * marking it, or a tailnet guest's marking it; the dialog showing twice (two tabs at once, or after the stamp); a
 * tailnet guest claiming it; a claim with another server session going through. And the pure rules (inbox-snooze-intro.ts):
 * the two-day line moving (the owner changed it from seven), an active-days rule coming back, a used or shown mark not
 * ending it, a dev build deciding it, first use read from the wrong end of the log.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { SNOOZE_INTRO_TENURE_MS, snoozeIntroDue, snoozeIntroFirstUse } from "./inbox-snooze-intro";

const DAY = 24 * 60 * 60 * 1000;
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

/** A scripted `tailscale`: this computer is the owner's, published at MAGIC. The real one never runs. */
function fakeTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
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
  /** config.json's `inboxSnoozeIntro` before the start (undefined: an upgrade that never had it). */
  saved?: Record<string, string>;
  /** Days ago the event log's first records were written (none: an empty log). */
  logDaysAgo?: number;
  /** A snooze running at the start (snoozes.json). */
  snoozeRunning?: boolean;
  /** Published over the tailnet (the owner's phone and a guest can reach it). */
  tailnet?: boolean;
  /** Phones on (the door a phone app pairs with). */
  phones?: boolean;
  /** A linked machine with this id, offline (a closed port). */
  linked?: string;
}

const LINKED = "ibx_01J00000000000000000000001";

async function world(options: Options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-zi-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  // The Inbox reads config.json through the env, even when handed dataDir.
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  for (const name of ["PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_URL_HOST", "PLANNOTATOR_UPDATE_CHECK"]) setEnv(name, undefined);
  // Phones on would make a mailbox at the real relay: a dead loopback port instead.
  setEnv("PLANNOTATOR_RELAY_URL", "http://127.0.0.1:9");
  // The update-day dialogs (sound, list options, voice) are first in the line (approval "inbox-one-time-dialogs"):
  // already settled here (a fresh install's marks), so Snooze is what these cases see.
  const settledAt = new Date(Date.now() - 30 * DAY).toISOString();
  const config: Record<string, unknown> = {
    updateCheck: false,
    inboxSound: { dialogShownFor: options.version ?? RELEASE },
    inboxListIntro: { shownAt: settledAt, version: 2 },
    inboxVoiceIntro: { shownAt: settledAt },
  };
  if (options.saved) config.inboxSnoozeIntro = options.saved;
  if (options.tailnet) Object.assign(config, { inboxTailscale: true, inboxTailscaleAllow: [GUEST] });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  let thread = "";
  if (options.logDaysAgo !== undefined) {
    // The log as an earlier Inbox wrote it, its clock that many days back.
    const then = new Date(Date.now() - options.logDaysAgo * DAY);
    const store = InboxStore.open(dataDir, { now: () => then });
    const project = store.ensureProject({ name: "docs", root: join(root, "docs") });
    thread = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" }, body: "Which index?" }).message.thread_id;
    if (options.snoozeRunning) store.setSnooze(thread, new Date(Date.now() + DAY).toISOString());
  }
  if (options.linked) {
    // Port 9 on loopback: nothing listens, so the machine is offline.
    const link = { id: options.linked, name: "Mini", token: "tok_x", transport: { kind: "tailnet", url: "http://127.0.0.1:9" }, device_id: null, linked_at: "2026-10-30T00:00:00Z" };
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "machines.json"), JSON.stringify({ v: 1, self: { id: "ibx_01J00000000000000000000000" }, links: [link] }), { mode: 0o600 });
  }
  const home = join(root, "home");
  mkdirSync(home);
  const server = await startInboxServer({
    dataDir,
    binaryPath: null,
    phones: options.phones ?? false,
    version: options.version ?? RELEASE,
    // A link publishes the door: the scripted tailscale, never the real one.
    ...(options.tailnet || options.linked ? { tailscale: fakeTailscale() } : {}),
    agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: {} }),
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: Record<string, unknown> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
  /** A page through the tailnet listener, as `tailscale serve` hands it over: the owner's phone, or a guest's. */
  const viaTailnet = (who: "owner" | "guest", path: string, body?: Record<string, unknown>) => {
    const listener = server.tailscale.listenerPort();
    if (listener === null) throw new Error("not published");
    return fetch(`http://127.0.0.1:${listener}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Host: `${MAGIC}:${server.port}`,
        Origin: `https://${MAGIC}:${server.port}`,
        "Sec-Fetch-Site": "same-origin",
        "X-Forwarded-Proto": "https",
        "Tailscale-User-Login": who === "owner" ? OWNER : GUEST,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify({ serverSession: server.serverSession, ...body }) } : {}),
    });
  };
  const due = async () => ((await (await fetch(`${base}/api/inbox/settings`)).json()) as { snooze_intro: { due: boolean } }).snooze_intro.due;
  const saved = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxSnoozeIntro as { firstUseAt?: string; snoozedAt?: string; shownAt?: string } | undefined;
  const claim = async () => ((await (await post("/api/inbox/snooze-intro")).json()) as { show: boolean }).show;
  return { server, base, post, viaTailnet, due, saved, claim, thread, dataDir };
}

const tomorrow = () => new Date(Date.now() + DAY).toISOString();

describe("who gets the Snooze announcement", () => {
  test("an upgrade: first use is rebuilt from the event log, so someone three days in has it due at once", async () => {
    const w = await world({ logDaysAgo: 3 });
    const first = Date.parse(w.saved()!.firstUseAt!);
    expect(Math.abs(first - (Date.now() - 3 * DAY))).toBeLessThan(60_000);
    expect(w.saved()!.snoozedAt).toBeUndefined();
    expect(await w.due()).toBe(true);
  });

  test("first use under two days ago (a new user): not due", async () => {
    const w = await world({ logDaysAgo: 1.9 });
    expect(w.saved()!.firstUseAt).toBeDefined();
    expect(await w.due()).toBe(false);
    expect(await w.claim()).toBe(false);
  });

  test("the backfill runs once: a saved first use is kept, never rebuilt from the log", async () => {
    const w = await world({ logDaysAgo: 5, saved: { firstUseAt: new Date(Date.now() - DAY).toISOString() } });
    expect(Date.now() - Date.parse(w.saved()!.firstUseAt!)).toBeLessThan(DAY + 60_000);
    expect(await w.due()).toBe(false);
  });

  test("a fresh install (an empty log at start): first use comes from the first record, later", async () => {
    const w = await world();
    expect(w.saved()).toEqual({});
    expect(await w.due()).toBe(false);
    w.server.store.ensureProject({ name: "docs", root: join(w.dataDir, "docs") });
    expect(await w.due()).toBe(false);
    expect(Date.now() - Date.parse(w.saved()!.firstUseAt!)).toBeLessThan(60_000);
  });

  test("a snooze running at the upgrade is a snooze the person made: never due", async () => {
    const w = await world({ logDaysAgo: 3, snoozeRunning: true });
    expect(w.saved()!.snoozedAt).toBeDefined();
    expect(await w.due()).toBe(false);
  });

  test("already snoozed, or already shown: not due, and no claim shows it", async () => {
    const old = new Date(Date.now() - 10 * DAY).toISOString();
    for (const saved of [{ firstUseAt: old, snoozedAt: old }, { firstUseAt: old, shownAt: old }]) {
      const w = await world({ saved });
      expect(await w.due()).toBe(false);
      expect(await w.claim()).toBe(false);
    }
  });

  test("a dev build decides nothing: no backfill, never due; its snooze still marks it, for the release after", async () => {
    const w = await world({ version: "0.0.0-dev", logDaysAgo: 30 });
    expect(w.saved()).toBeUndefined();
    expect(await w.due()).toBe(false);
    expect(await w.claim()).toBe(false);
    expect((await w.post(`/api/inbox/threads/${w.thread}/snooze`, { until: tomorrow() })).status).toBe(200);
    expect(w.saved()!.snoozedAt).toMatch(/^\d{4}-/);
  });
});

describe("the claim", () => {
  test("two tabs claim at once: exactly one shows it; after the stamp, never again; 405 and 409", async () => {
    const w = await world({ logDaysAgo: 3 });
    expect(await w.due()).toBe(true);
    expect((await fetch(`${w.base}/api/inbox/snooze-intro`)).status).toBe(405);
    expect((await w.post("/api/inbox/snooze-intro", { serverSession: "another" })).status).toBe(409);
    expect(w.saved()!.shownAt).toBeUndefined();
    const answers = await Promise.all([w.post("/api/inbox/snooze-intro"), w.post("/api/inbox/snooze-intro")]);
    const shows = await Promise.all(answers.map(async (answer) => ((await answer.json()) as { show: boolean }).show));
    expect(shows.filter(Boolean)).toHaveLength(1);
    expect(w.saved()!.shownAt).toMatch(/^\d{4}-/);
    expect(await w.due()).toBe(false);
    expect(await w.claim()).toBe(false);
    // A restart (or a reload, another tab) reads the same stamp.
    expect(await (await w.post("/api/inbox/snooze-intro")).json()).toEqual({ show: false, snooze_intro: { due: false } });
  });

  test("over the tailnet: a guest never sees it due nor claims it; the owner's phone does", async () => {
    const w = await world({ logDaysAgo: 3, tailnet: true });
    const due = async (who: "owner" | "guest") => ((await (await w.viaTailnet(who, "/api/inbox/settings")).json()) as { snooze_intro: { due: boolean } }).snooze_intro.due;
    const claim = async (who: "owner" | "guest") => ((await (await w.viaTailnet(who, "/api/inbox/snooze-intro", {})).json()) as { show: boolean }).show;
    expect(await due("guest")).toBe(false);
    expect(await claim("guest")).toBe(false);
    // The guest's ask spent nothing.
    expect(w.saved()!.shownAt).toBeUndefined();
    expect(await due("owner")).toBe(true);
    expect(await claim("owner")).toBe(true);
    expect(w.saved()!.shownAt).toMatch(/^\d{4}-/);
  });
});

describe("every snooze route marks it used", () => {
  test("the window's snooze", async () => {
    const w = await world({ logDaysAgo: 3 });
    expect(await w.due()).toBe(true);
    // Unsnooze is no snooze, and a snooze refused (a time that is no time) is none either.
    await w.post(`/api/inbox/threads/${w.thread}/snooze`, { until: null });
    expect((await w.post(`/api/inbox/threads/${w.thread}/snooze`, { until: "not a time" })).ok).toBe(false);
    expect(w.saved()!.snoozedAt).toBeUndefined();
    expect((await w.post(`/api/inbox/threads/${w.thread}/snooze`, { until: tomorrow() })).status).toBe(200);
    expect(w.saved()!.snoozedAt).toMatch(/^\d{4}-/);
    // The snooze ends, snoozes.json goes with it: the mark stays.
    await w.post(`/api/inbox/threads/${w.thread}/snooze`, { until: null });
    expect(w.server.store.snoozes()).toEqual([]);
    expect(await w.due()).toBe(false);
    expect(await w.claim()).toBe(false);
  });

  test("the owner's phone over the tailnet marks it; a tailnet guest's snooze does not", async () => {
    const w = await world({ logDaysAgo: 3, tailnet: true });
    await w.viaTailnet("guest", `/api/inbox/threads/${w.thread}/snooze`, { until: tomorrow() });
    expect(w.saved()!.snoozedAt).toBeUndefined();
    expect((await w.viaTailnet("owner", `/api/inbox/threads/${w.thread}/snooze`, { until: tomorrow() })).status).toBe(200);
    expect(w.saved()!.snoozedAt).toMatch(/^\d{4}-/);
    expect(await w.due()).toBe(false);
  });

  test("a phone app through the door marks it", async () => {
    const w = await world({ logDaysAgo: 3, phones: true });
    const made = (await (await w.post("/api/inbox/pairing")).json()) as { offer: { code: string } };
    const paired = (await (
      await fetch(`${w.base}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) })
    ).json()) as { token: string };
    const snoozed = await fetch(`${w.base}/api/inbox/device/threads/${w.thread}/snooze`, {
      method: "POST",
      headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: crypto.randomUUID(), until: tomorrow() }),
    });
    expect(snoozed.status).toBe(200);
    expect(w.saved()!.snoozedAt).toMatch(/^\d{4}-/);
    expect(await w.due()).toBe(false);
  });

  test("a linked machine's thread, snoozed through the forward, marks it here; a forward refused does not", async () => {
    const w = await world({ logDaysAgo: 3, linked: LINKED });
    const snooze = (machine: string) => w.post(`/api/inbox/m/${machine}/threads/msg_01J00000000000000000000000/snooze`, { until: tomorrow(), idempotency_key: crypto.randomUUID() });
    // A machine that is not linked: 404, no snooze made.
    expect((await snooze("ibx_01J00000000000000000000009")).status).toBe(404);
    expect(w.saved()!.snoozedAt).toBeUndefined();
    // The linked machine is offline: the snooze is held for it (202), as made.
    expect((await snooze(LINKED)).status).toBe(202);
    expect(w.saved()!.snoozedAt).toMatch(/^\d{4}-/);
    expect(await w.due()).toBe(false);
  });
});

// The pure rules (inbox-snooze-intro.ts), by a clock the test moves.
const NOW = new Date("2026-11-02T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;

describe("snoozeIntroDue", () => {
  test("the two-day boundary: due at exactly 48 h of tenure, not a millisecond before", () => {
    expect(SNOOZE_INTRO_TENURE_MS).toBe(2 * DAY);
    expect(snoozeIntroDue({ firstUseAt: ago(2 * DAY) }, NOW, true)).toBe(true);
    expect(snoozeIntroDue({ firstUseAt: ago(2 * DAY - 1) }, NOW, true)).toBe(false);
    // No active-days rule: one use two days ago is enough.
    expect(snoozeIntroDue({ firstUseAt: ago(90 * DAY) }, NOW, true)).toBe(true);
  });

  test("each condition alone stops it", () => {
    const first = ago(3 * DAY);
    expect(snoozeIntroDue({ firstUseAt: first }, NOW, false)).toBe(false);
    expect(snoozeIntroDue({ firstUseAt: first, snoozedAt: ago(DAY) }, NOW, true)).toBe(false);
    expect(snoozeIntroDue({ firstUseAt: first, shownAt: ago(DAY) }, NOW, true)).toBe(false);
    expect(snoozeIntroDue({}, NOW, true)).toBe(false);
    expect(snoozeIntroDue(undefined, NOW, true)).toBe(false);
  });
});

describe("snoozeIntroFirstUse", () => {
  test("the oldest time of any line or record, wherever it is in the log", () => {
    const lines = [
      { at: ago(DAY), record: { created_at: ago(DAY) } },
      // A record rewritten later keeps when it was made.
      { at: ago(HOUR), record: { created_at: ago(5 * DAY) } },
      { at: ago(3 * DAY), record: {} },
    ];
    expect(snoozeIntroFirstUse(lines)).toBe(ago(5 * DAY));
    expect(snoozeIntroFirstUse([])).toBeNull();
  });
});
