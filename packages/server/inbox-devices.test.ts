/**
 * The phone door (mobile plan step P1; adr/implementation/inbox-mobile.md
 * sections 1, 2 and 6), proved against a real Inbox. Nothing is mocked:
 *
 *  - "On the binary": `plannotator inbox --background` as a process (the
 *    compiled binary when PLANNOTATOR_INBOX_TEST_BINARY names one, as the
 *    inbox-e2e job runs it; the CLI from source otherwise) under a temp HOME
 *    and data dir. Every contract exchange of sections 1 and 2 (7.1 to 7.25,
 *    7.36, 7.37) is replayed with real fetch and the answers compared to the
 *    contract's shapes. A "phone" (this script) pairs, reads threads, picks
 *    and sends, and the agent's wait_for_reply, through `plannotator inbox
 *    mcp` and the MCP SDK's stdio client, gets the answer.
 *  - "In process": what a process cannot show without waiting ten minutes
 *    or a real tailnet: the offer's expiry (the server's clock option), and
 *    the tailnet path through a scripted `tailscale` CLI (the runner seam):
 *    serve points at a door-only listener, a spoofed Host reaches no window
 *    route there, and the mapping goes with the switch and a clean stop.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimAgent } from "../../scripts/inbox-sim";
import {
  createInboxWorld,
  destroyInboxWorld,
  inboxBinary,
  registry,
  startInbox,
  stopInbox,
  removeStubbedHtml, stubBuiltHtml,
  worldEnv,
  type InboxWorld,
} from "../../tests/helpers/inbox-world";
import { resetServedHostnamesForTests } from "./request-host-guard";
import { startInboxServer } from "./inbox";
import { createInboxDevices, takeDownInboxTailnet } from "./inbox-devices";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { GUIDE_BRIEF_EXAMPLE } from "./inbox-guides";

const DEVICE_KEYS = ["carriage", "created_at", "id", "last_seen_at", "name", "platform", "revoked_at"];
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const QUESTIONS = [
  "The retry worker is ready.",
  "",
  ":::question",
  "Run the retry tests against the Stripe test clock?",
  "They take about four minutes against the test key.",
  "- Yes",
  "- No",
  "Recommended: Yes",
  ":::",
  "",
  ":::question",
  "Ship it behind a flag?",
  "- Yes",
  "- No",
  ":::",
].join("\n");

type Json = Record<string, any>;

describe("the device door, on the binary", () => {
  let w: InboxWorld;
  let stubs: string[] = [];
  let agent: SimAgent;
  let base = "";
  let serverSession = "";
  let token = "";
  let deviceId = "";
  let threadId = "";
  let guideMessage = "";
  const keys = (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })();

  /** The window, as the page calls it (same origin). */
  const win = (path: string, body?: unknown, origin = true) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: base } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** The phone: `/api/inbox/device/<path>` with its bearer token and no Origin. */
  const door = (path: string, init: { token?: string | null; body?: unknown; headers?: Record<string, string>; method?: string } = {}) =>
    fetch(`${base}/api/inbox/device/${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.token === null ? {} : { Authorization: `Bearer ${init.token ?? token}` }),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  const offer = async (): Promise<Json> => {
    const response = await win("/api/inbox/pairing", { serverSession });
    expect(response.status).toBe(201);
    return response.json();
  };

  beforeAll(async () => {
    stubs = stubBuiltHtml();
    w = createInboxWorld("plannotator-inbox-devices-", "device-door", "device-door", { phones: true });
    const entry = startInbox(w);
    base = `http://127.0.0.1:${entry.port}`;
    serverSession = ((await (await fetch(`${base}/api/inbox/health`)).json()) as Json).serverSession;
    agent = await SimAgent.connect({ binary: join(w.bin, "plannotator"), env: worldEnv(w), name: "Claude Code", host: "claude-code", cwd: w.project });
    writeFileSync(join(w.project, "retry-plan.md"), "# Retry plan\n\nRetry at most three times, 2, 4 and 8 seconds apart.\n");
    writeFileSync(join(w.project, "ticket.html"), '<!doctype html><html><head><title>Ticket</title></head><body><h1>Low Tide</h1><img src="sun.png"></body></html>');
    writeFileSync(join(w.project, "sun.png"), ONE_PIXEL_PNG);
    const sent = await agent.send({ project_path: w.project, body: QUESTIONS, attachments: ["retry-plan.md", "ticket.html"] });
    threadId = sent.thread_id;
    const guided = await agent.submitGuide({ ...GUIDE_BRIEF_EXAMPLE, project_path: w.project, thread: "token-refresh", idempotency_key: "guide-1" });
    guideMessage = guided.message_id ?? guided.thread_id;
  }, 60_000);

  afterAll(async () => {
    await agent?.close().catch(() => {});
    if (w) await destroyInboxWorld(w);
    removeStubbedHtml(stubs);
  });

  test("7.1: the window makes an offer, with the QR link, the six digits, the computer and its addresses", async () => {
    const before = Date.now();
    const made = await offer();
    expect(Object.keys(made).sort()).toEqual(["addresses", "computer", "link", "offer", "reachable"]);
    // No way switched on: the window shows no code for it (Pair a phone's step 1 is the gate).
    expect(made.reachable).toBe(false);
    expect(made.offer.code).toMatch(/^\d{6}$/);
    const ttl = Date.parse(made.offer.expires_at) - before;
    expect(ttl).toBeGreaterThan(9.9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 2_000);
    expect(typeof made.computer.name).toBe("string");
    expect(made.computer.name.length).toBeGreaterThan(0);
    expect(made.addresses).toEqual({ tailnet: null, lan: null, fingerprint: null });
    const link = new URL(made.link.replace("plannotator://", "https://pair.invalid/"));
    expect(made.link.startsWith("plannotator://pair?v=1&name=")).toBe(true);
    expect([...link.searchParams.keys()]).toEqual(["v", "name", "secret", "code"]);
    expect(link.searchParams.get("name")).toBe(made.computer.name);
    expect(link.searchParams.get("secret")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.searchParams.get("code")).toBe(made.offer.code);
  });

  test("7.1: the offer route keeps the window's guards: a foreign page and a stale tab are refused", async () => {
    const foreign = await fetch(`${base}/api/inbox/pairing`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).code).toBe("cross_origin");
    const stale = await win("/api/inbox/pairing", { serverSession: "0".repeat(32) });
    expect(stale.status).toBe(409);
    // Never on the door, whatever the token.
    expect((await door("pairing", { token: null, body: {} })).status).toBe(401);
  });

  test("7.3 then 7.2: a wrong code says how many tries are left; the right one pairs once and returns the token; the same redemption again is 410", async () => {
    const made = await offer();
    const wrongCode = made.offer.code === "000000" ? "000001" : "000000";
    const wrong = await door("pair", { token: null, body: { code: wrongCode, name: "iPhone", platform: "ios" } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "That code is not the one on your computer.", code: "pairing_code_wrong", tries_left: 4 });

    const paired = await door("pair", { token: null, body: { code: made.offer.code, name: "iPhone", platform: "ios" } });
    expect(paired.status).toBe(201);
    const body = (await paired.json()) as Json;
    expect(Object.keys(body).sort()).toEqual(["addresses", "computer", "device", "relay", "secret", "token"]);
    expect(Object.keys(body.device).sort()).toEqual(DEVICE_KEYS);
    expect(body.device).toMatchObject({ name: "iPhone", platform: "ios", revoked_at: null, carriage: true });
    expect(body.device.id).toMatch(/^dev_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.token).toMatch(/^tok_[A-Za-z0-9_-]{43}$/);
    expect(body.secret).toBe(new URL(made.link.replace("plannotator://", "https://pair.invalid/")).searchParams.get("secret"));
    expect(body.computer).toEqual(made.computer);
    expect(body.addresses).toEqual({ tailnet: null, lan: null, fingerprint: null });
    expect(body.relay).toBeNull();
    token = body.token;
    deviceId = body.device.id;

    const again = await door("pair", { token: null, body: { code: made.offer.code, name: "iPhone", platform: "ios" } });
    expect(again.status).toBe(410);
    expect(await again.json()).toEqual({ error: "This pairing code is no longer open. Make a new one on your computer.", code: "offer_expired" });
  });

  test("on disk: devices.jsonl keeps the token's SHA-256, never the token; the secret sits 0600 in a 0700 folder", () => {
    const dir = join(w.dataDir, "inbox");
    const lines = readFileSync(join(dir, "devices.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const last = lines.filter((l) => l.id === deviceId).at(-1);
    expect(Object.keys(last).sort()).toEqual(["at", "id", "record", "v"]);
    expect(last.v).toBe(1);
    expect(last.record.token_sha256).toBe(createHash("sha256").update(token).digest("hex"));
    expect(readFileSync(join(dir, "devices.jsonl"), "utf8")).not.toContain(token);
    const secretFile = join(dir, "device-secrets", deviceId);
    expect(readFileSync(secretFile, "utf8")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") {
      expect(statSync(secretFile).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "device-secrets")).mode & 0o777).toBe(0o700);
    }
  });

  test("7.2: the QR secret redeems once; a new offer closes the old one; the sixth wrong code finds the offer closed", async () => {
    const first = await offer();
    const secret = new URL(first.link.replace("plannotator://", "https://pair.invalid/")).searchParams.get("secret");
    const replaced = await offer();
    // The first offer was replaced: its secret no longer opens anything.
    expect((await door("pair", { token: null, body: { secret, name: "Old", platform: "ios" } })).status).toBe(410);

    const bySecret = new URL(replaced.link.replace("plannotator://", "https://pair.invalid/")).searchParams.get("secret");
    const qr = await door("pair", { token: null, body: { secret: bySecret, name: "iPad", platform: "ios" } });
    expect(qr.status).toBe(201);
    const qrDevice = ((await qr.json()) as Json).device.id;
    expect((await door("pair", { token: null, body: { secret: bySecret, name: "iPad", platform: "ios" } })).status).toBe(410);

    const tries = await offer();
    const wrongCode = tries.offer.code === "000000" ? "000001" : "000000";
    const left: number[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await door("pair", { token: null, body: { code: wrongCode, name: "x", platform: "ios" } });
      expect(response.status).toBe(401);
      left.push(((await response.json()) as Json).tries_left);
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    const sixth = await door("pair", { token: null, body: { code: tries.offer.code, name: "x", platform: "ios" } });
    expect(sixth.status).toBe(410);

    // Validation: one of secret or code, a name, a platform.
    const open = await offer();
    expect((await door("pair", { token: null, body: { name: "x", platform: "ios" } })).status).toBe(422);
    expect((await door("pair", { token: null, body: { code: open.offer.code, name: "", platform: "ios" } })).status).toBe(422);
    expect((await door("pair", { token: null, body: { code: open.offer.code, name: "line\nbreak", platform: "ios" } })).status).toBe(422);
    expect((await win(`/api/inbox/devices/${qrDevice}/revoke`, { serverSession })).status).toBe(200);
  });

  test("7.4 and every door route: no token, a wrong token, an Origin are refused before anything runs", async () => {
    const routes: [string, string][] = [
      ["GET", "health"],
      ["GET", "threads"],
      ["GET", "projects"],
      ["GET", `threads/${threadId}`],
      ["POST", `threads/${threadId}/seen`],
      ["POST", `threads/${threadId}/read`],
      ["POST", `threads/${threadId}/unread`],
      ["GET", "events"],
      ["POST", `messages/${threadId}/picks`],
      ["POST", `messages/${threadId}/reply`],
      ["POST", `messages/${threadId}/resolve`],
      ["POST", `threads/${threadId}/delete`],
      ["GET", `threads/${threadId}/attachments`],
      ["GET", "attachments/att_x/view"],
      ["GET", "html-assets/0000000000000001/sun.png"],
      ["GET", `messages/${threadId}/image?path=sun.png`],
      ["POST", "annotations"],
      ["POST", "annotations/ann-1/remove"],
      ["GET", `messages/${threadId}/guide`],
      ["POST", `messages/${threadId}/guide/reviewed`],
      ["GET", `threads/${threadId}/sessions`],
      ["POST", `threads/${threadId}/message`],
      ["GET", "sessions"],
      ["POST", "messages"],
      ["POST", `messages/${threadId}/to`],
      ["POST", `messages/${threadId}/ack`],
      ["GET", "search?q=retry"],
      ["POST", "projects/prj_x/read"],
      ["POST", "projects/prj_x/unread"],
      ["POST", "projects/prj_x/resolve"],
      ["GET", "skills"],
      ["GET", "skills/content?name=readback"],
      ["POST", "uploads?name=a.txt"],
      ["POST", "markups"],
      ["POST", `messages/${guideMessage}/guide/annotations`],
      ["POST", `messages/${threadId}/annotations`],
      ["POST", "revoke"],
    ];
    for (const [method, path] of routes) {
      const body = method === "POST" ? { idempotency_key: keys() } : undefined;
      const none = await door(path, { method, token: null, body });
      expect([path, none.status, ((await none.json()) as Json).code]).toEqual([path, 401, "device_token_missing"]);
      const wrong = await door(path, { method, token: "tok_exampleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", body });
      expect([path, wrong.status, ((await wrong.json()) as Json).code]).toEqual([path, 401, "device_token_invalid"]);
      const browser = await door(path, { method, body, headers: { Origin: base } });
      expect([path, browser.status, ((await browser.json()) as Json).code]).toEqual([path, 403, "origin_not_allowed"]);
    }
    const pairFromPage = await door("pair", { token: null, body: { code: "000000", name: "x", platform: "ios" }, headers: { Origin: base } });
    expect(pairFromPage.status).toBe(403);

    const health = await door("health");
    expect(health.status).toBe(200);
    const h = (await health.json()) as Json;
    expect(Object.keys(h).sort()).toEqual(["app", "event_streams", "notify_reach", "ok", "peek", "pid", "serverSession", "update", "version"]);
    expect(h).toMatchObject({ ok: true, app: "plannotator-inbox", serverSession });
    expect(await (await door("health", { token: null })).json()).toEqual({ error: "This request needs the phone's token.", code: "device_token_missing" });
  });

  test("what the door never answers: settings, restart, /mcp, the bridge, control, raw bytes, project delete, drafts, recent searches, decisions (removed), pairing, the device list, Open in", async () => {
    for (const [method, path] of [
      ["GET", "settings"],
      // Recent searches stay the window's: the phone keeps its own.
      ["POST", "search/recent"],
      // "Open in" launches an app on the computer: never from a phone (and no new-tab page there either).
      ["POST", "open-in"],
      ["GET", "open-in/apps"],
      ["GET", "attachments/att_x/page"],
      ["POST", "restart"],
      ["POST", "mcp"],
      ["POST", "bridge/poll"],
      ["POST", "control/stop"],
      ["GET", "attachments/att_x"],
      ["POST", "projects/prj_x/delete"],
      // A reply draft is read only on the door (7.62): the phone writes none.
      ["POST", "threads/msg_x/draft"],
      ["POST", "threads/msg_x/draft/delete"],
      // Shared drafts stay the window's (never seen by phones) until that is ruled otherwise.
      ["GET", "drafts"],
      ["POST", "drafts/drf_x"],
      ["POST", "drafts/drf_x/delete"],
      // Uploads and drawings are POSTs only (a markup is read by GET markups/<name>).
      ["GET", "uploads"],
      // Decisions were removed (2026-10): every route that drew, set or changed one is gone.
      ["POST", "decisions/dec_x/retire"],
      ["POST", "decisions/dec_x/replace"],
      ["GET", "decisions"],
      ["POST", "messages/msg_x/decision"],
      ["POST", "pairing"],
      ["GET", "devices"],
      ["GET", "messages/x/picks"],
      ["GET", ""],
    ] as const) {
      const response = await door(path, { method, body: method === "POST" ? { idempotency_key: keys() } : undefined });
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.json()).toEqual({ error: "Not a phone route.", code: "device_route_not_found" });
    }
    // The bridge and control keep their own guard: a device token is just a wrong token there.
    for (const path of ["/api/inbox/bridge/poll", "/api/inbox/bridge/event", "/api/inbox/control/stop"]) {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
      expect([path, response.status, ((await response.json()) as Json).code]).toEqual([path, 401, "unauthorized"]);
    }
  });

  test("7.5 to 7.9: the list, projects, a thread, seen (key required), the event stream", async () => {
    const list = (await (await door("threads")).json()) as Json;
    expect(Object.keys(list).sort()).toEqual(["cursor", "notice", "pins", "project", "projects", "restart_agents", "restart_claude_code", "sections", "serverSession", "update", "update_check_failing", "updated", "version"]);
    expect(list.sections.map((s: Json) => s.id)).toEqual(["stopped", "holding", "waiting", "new", "sent", "quiet"]);
    const row = list.sections.flatMap((s: Json) => s.threads).find((t: Json) => t.thread_id === threadId);
    expect(row).toMatchObject({ section: "waiting", unread: true, questions: { open: 2 } });
    const filtered = (await (await door(`threads?project=${row.project_id}`)).json()) as Json;
    expect(filtered.project).toBe(row.project_id);

    const projects = (await (await door("projects")).json()) as Json;
    expect(Object.keys(projects).sort()).toEqual(["cursor", "projects", "serverSession"]);
    expect(Object.keys(projects.projects[0]).sort()).toEqual(["archived", "created_at", "id", "key", "listed", "name", "root", "threads", "unread"]);

    const thread = (await (await door(`threads/${threadId}`)).json()) as Json;
    expect(Object.keys(thread).sort()).toEqual(["cursor", "row", "serverSession", "thread"]);
    expect(thread.thread.messages[0].questions).toHaveLength(2);
    expect(thread.thread.messages[0].questions[0]).toMatchObject({ kind: "single", state: "open", revision: 0, recommendation: "Yes" });

    const noKey = await door(`threads/${threadId}/seen`, { body: {} });
    expect(noKey.status).toBe(422);
    expect(await noKey.json()).toEqual({ error: "idempotency_key: required on a phone's command.", code: "validation_error", field: "idempotency_key" });
    // through_seq (seen on sight) passes the door unchanged: a cap below every message covers nothing; a bad one is refused.
    expect(row.unseen).toBeGreaterThan(0);
    const capped = await door(`threads/${threadId}/seen`, { body: { idempotency_key: keys(), through_seq: 0 } });
    expect(capped.status).toBe(200);
    expect(((await capped.json()) as Json).thread).toMatchObject({ thread_id: threadId, unseen: row.unseen });
    const badCap = await door(`threads/${threadId}/seen`, { body: { idempotency_key: keys(), through_seq: "all" } });
    expect(badCap.status).toBe(422);
    expect(((await badCap.json()) as Json)).toMatchObject({ code: "validation_error", field: "through_seq" });
    const seen = await door(`threads/${threadId}/seen`, { body: { idempotency_key: keys() } });
    expect(seen.status).toBe(200);
    expect(((await seen.json()) as Json).thread).toMatchObject({ thread_id: threadId, unseen: 0 });

    // The stream from a cursor: hello, then the store lines after it.
    const abort = new AbortController();
    const stream = await door(`events?cursor=${thread.cursor - 1}`, { headers: {} });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    let text = "";
    const deadline = Date.now() + 10_000;
    while (!/event: record/.test(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    abort.abort();
    await reader.cancel();
    expect(text).toContain("retry: 2000\nevent: hello\n");
    expect(text).toMatch(new RegExp(`id: ${thread.cursor}\\nevent: record\\ndata: \\{"seq":${thread.cursor},`));
  });

  test("7.10 and 7.11: a pick (replayed by its key, a stale revision refused), then Send, and the agent's wait_for_reply gets the answer", async () => {
    const thread = (await (await door(`threads/${threadId}`)).json()) as Json;
    const q = thread.thread.messages[0].questions[0];
    const pickKey = keys();
    const pickBody = {
      idempotency_key: pickKey,
      questions: [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: "single", prompt: q.prompt, selected: ["Yes"] } }],
    };
    const pick = await door(`messages/${threadId}/picks`, { body: pickBody });
    expect(pick.status).toBe(200);
    expect(pick.headers.get("idempotent-replayed")).toBeNull();
    const picked = (await pick.json()) as Json;
    expect(Object.keys(picked).sort()).toEqual(["message_id", "questions", "reply"]);
    expect(picked.questions[0]).toMatchObject({ key: q.key, state: "picked", revision: 1 });

    const replay = await door(`messages/${threadId}/picks`, { body: pickBody });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(picked);
    const stale = await door(`messages/${threadId}/picks`, { body: { ...pickBody, idempotency_key: keys() } });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as Json).code).toBe("question_revision_conflict");
    const reused = await door(`threads/${threadId}/seen`, { body: { idempotency_key: pickKey } });
    expect(reused.status).toBe(409);
    expect(((await reused.json()) as Json).code).toBe("idempotency_key_reused");

    const waiting = agent.waitForReply(threadId, 50);
    const sendKey = keys();
    const send = await door(`messages/${threadId}/reply`, { body: { idempotency_key: sendKey, words: "Go ahead.", questions: [{ key: q.key, revision: 1 }] } });
    expect(send.status).toBe(200);
    const sent = (await send.json()) as Json;
    expect(Object.keys(sent).sort()).toEqual(["message_id", "questions", "replayed", "reply"]);
    expect(sent).toMatchObject({ message_id: threadId, replayed: false, reply: { author: { kind: "person" }, idempotency_key: sendKey } });
    expect(sent.questions[0]).toMatchObject({ key: q.key, state: "sent", sent_revision: 1 });
    const reply = await waiting;
    expect(JSON.stringify(reply)).toContain("Go ahead.");
    expect(JSON.stringify(reply)).toContain("Yes");
    // A retry of the same Send over another path writes nothing.
    const again = await door(`messages/${threadId}/reply`, { body: { idempotency_key: sendKey, words: "Go ahead.", questions: [{ key: q.key, revision: 1 }] } });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(((await again.json()) as Json).reply.id).toBe(sent.reply.id);
  }, 60_000);

  test("7.14 to 7.18: attachments, a view, an HTML asset, an annotation saved and removed", async () => {
    const listed = (await (await door(`threads/${threadId}/attachments`)).json()) as Json;
    expect(Object.keys(listed).sort()).toEqual(["annotations", "attachments", "inline_images", "serverSession"]);
    expect(listed.attachments.map((a: Json) => a.name).sort()).toEqual(["retry-plan.md", "ticket.html"]);
    const md = listed.attachments.find((a: Json) => a.name === "retry-plan.md");
    const html = listed.attachments.find((a: Json) => a.name === "ticket.html");
    expect(Object.keys(md).sort()).toEqual(
      ["changed_since_sent", "current", "id", "kind", "message_id", "name", "named_path", "path", "sent_at", "sent_mtime", "sent_sha256", "size", "unavailable"].sort(),
    );

    const view = (await (await door(`attachments/${html.id}/view`)).json()) as Json;
    expect(Object.keys(view).sort()).toEqual(["attachment", "html", "serverSession", "text", "version"]);
    const assetBase = /<base href="(\/api\/html-assets\/[^"]+\/)">/.exec(view.html)?.[1];
    expect(assetBase).toBeTruthy();
    const asset = await door(`html-assets/${assetBase!.slice("/api/html-assets/".length)}sun.png`);
    expect(asset.status).toBe(200);
    expect(Buffer.from(await asset.arrayBuffer()).equals(ONE_PIXEL_PNG)).toBe(true);

    const annotation = { id: "ann-1", blockId: "block-1", startOffset: 0, endOffset: 5, type: "COMMENT", text: "Why three?", originalText: "Retry", createdA: 1791460320000 };
    const saved = await door("annotations", { body: { idempotency_key: keys(), attachment_id: md.id, version: "current", annotation } });
    expect(saved.status).toBe(200);
    const record = ((await saved.json()) as Json).annotation;
    expect(record).toMatchObject({ id: "ann-1", attachment_id: md.id, version: "current", removed_at: null, sent_reply_id: null, annotation });
    const removed = await door("annotations/ann-1/remove", { body: { idempotency_key: keys() } });
    expect(((await removed.json()) as Json).annotation.removed_at).toBeTruthy();
  });

  test("7.38: a message's images, one in a question's context too, through the window's own route: same bytes, same headers, the same refusals, ETag and 304", async () => {
    mkdirSync(join(w.project, "shots"), { recursive: true });
    writeFileSync(join(w.project, "shots", "after.png"), ONE_PIXEL_PNG);
    writeFileSync(join(w.project, "shots", "mock.png"), ONE_PIXEL_PNG);
    writeFileSync(join(w.project, "shots", "not-shown.png"), ONE_PIXEL_PNG);
    // Outside the project, in a hidden folder, referenced by `../`.
    mkdirSync(join(w.project, "..", ".private"), { recursive: true });
    writeFileSync(join(w.project, "..", ".private", "outside.png"), ONE_PIXEL_PNG);
    const body = [
      "The page after the fix:",
      "",
      "![after](shots/after.png)",
      "",
      "![up](../.private/outside.png)",
      "",
      ":::question",
      "Keep the new header?",
      "It moves the search into the header:",
      "![mock](shots/mock.png)",
      "- Keep it",
      "- Go back",
      ":::",
    ].join("\n");
    const sent = await agent.send({ project_path: w.project, body, thread: "images" });
    const id = sent.message_id as string;
    // The question's context holds the image: it is the same body the route checks.
    const thread = (await (await door(`threads/${sent.thread_id}`)).json()) as Json;
    const question = thread.thread.messages.find((m: Json) => m.id === id).questions[0];
    expect(question.context).toContain("![mock](shots/mock.png)");

    const img = (path: string, init: Parameters<typeof door>[1] = {}) => door(`messages/${id}/image?path=${encodeURIComponent(path)}`, init);
    const windowImg = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/inbox/messages/${id}/image?path=${encodeURIComponent(path)}`, { headers });
    const SAME = ["content-type", "content-length", "content-security-policy", "x-content-type-options", "cross-origin-resource-policy", "cache-control", "etag", "x-image-width", "x-image-height"];
    const picked = (r: Response) => SAME.map((h) => [h, r.headers.get(h)]);

    for (const path of ["shots/after.png", "shots/mock.png"]) {
      const phone = await img(path);
      const page = await windowImg(path);
      expect([path, phone.status]).toEqual([path, 200]);
      expect(picked(phone)).toEqual(picked(page));
      expect(phone.headers.get("content-type")).toBe("image/png");
      expect(phone.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
      expect(phone.headers.get("x-content-type-options")).toBe("nosniff");
      expect(phone.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(phone.headers.get("cache-control")).toBe("private, no-cache");
      expect(phone.headers.get("etag")).toBe(`"${createHash("sha256").update(ONE_PIXEL_PNG).digest("hex")}"`);
      expect(Buffer.from(await phone.arrayBuffer()).equals(ONE_PIXEL_PNG)).toBe(true);
      // The phone's If-None-Match reaches the window: a cached copy revalidates to 304.
      const cached = await img(path, { headers: { "If-None-Match": phone.headers.get("etag")! } });
      expect(cached.status).toBe(304);
      expect(picked(cached).filter(([h]) => h !== "content-length")).toEqual(picked(phone).filter(([h]) => h !== "content-length"));
      expect((await cached.arrayBuffer()).byteLength).toBe(0);
    }

    // Not referenced by that message's body: 403, the window's own answer.
    const unshown = await img("shots/not-shown.png");
    expect(unshown.status).toBe(403);
    expect(((await unshown.json()) as Json).code).toBe("image_not_referenced");
    expect(unshown.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
    // Referenced, but in a hidden folder outside the project: the window's refusal.
    const hidden = await img("../.private/outside.png");
    expect(hidden.status).toBe(403);
    expect(((await hidden.json()) as Json).code).toBe("image_hidden");
    // A person's reply posted from the phone keeps the project boundary: an image of the
    // project shows, one elsewhere on the machine (a photo library, say) is refused, by the door and the window alike.
    mkdirSync(join(w.project, "..", "Photos"), { recursive: true });
    const photo = join(realpathSync(join(w.project, "..")), "Photos", "IMG_0001.png");
    writeFileSync(photo, ONE_PIXEL_PNG);
    const replied = await door(`messages/${id}/reply`, { body: { idempotency_key: keys(), words: `Like this: ![p](${photo}) ![a](shots/after.png)` } });
    expect(replied.status).toBe(200);
    const replyId = ((await replied.json()) as Json).reply.id as string;
    const personImg = (path: string) => door(`messages/${replyId}/image?path=${encodeURIComponent(path)}`);
    expect((await personImg("shots/after.png")).status).toBe(200);
    const outsidePhone = await personImg(photo);
    expect([outsidePhone.status, ((await outsidePhone.json()) as Json).code]).toEqual([403, "outside_project"]);
    const outsideWindow = await fetch(`${base}/api/inbox/messages/${replyId}/image?path=${encodeURIComponent(photo)}`);
    expect([outsideWindow.status, ((await outsideWindow.json()) as Json).code]).toEqual([403, "outside_project"]);
    // Another message's id does not lend its body.
    const other = await door(`messages/${threadId}/image?path=${encodeURIComponent("shots/after.png")}`);
    expect(other.status).toBe(403);

    // No token, a wrong token, a browser: refused before the window is asked.
    expect((await img("shots/after.png", { token: null })).status).toBe(401);
    expect((await img("shots/after.png", { token: "tok_exampleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).status).toBe(401);
    expect((await img("shots/after.png", { headers: { Origin: base } })).status).toBe(403);

    // A removed phone is refused.
    const made = await offer();
    const spare = (await (await door("pair", { token: null, body: { code: made.offer.code, name: "Spare iPhone", platform: "ios" } })).json()) as Json;
    expect((await img("shots/after.png", { token: spare.token })).status).toBe(200);
    expect((await win(`/api/inbox/devices/${spare.device.id}/revoke`, { serverSession })).status).toBe(200);
    const gone = await img("shots/after.png", { token: spare.token });
    expect(gone.status).toBe(401);
    expect(((await gone.json()) as Json).code).toBe("device_revoked");
  });

  test("a message's images captured as files: the thread and its listing carry the additive inline_images, and the door serves them by id as the window does", async () => {
    mkdirSync(join(w.project, "shots"), { recursive: true });
    writeFileSync(join(w.project, "shots", "inline.png"), ONE_PIXEL_PNG);
    const sent = await agent.send({ project_path: w.project, body: "The drawer:\n\n![drawer](shots/inline.png)", thread: "inline images" });
    const thread = (await (await door(`threads/${sent.thread_id}`)).json()) as Json;
    const record = thread.thread.messages[0].inline_images[0];
    expect(record).toMatchObject({ ref: "shots/inline.png", kind: "image", media_type: "image/png" });
    const listing = (await (await door(`threads/${sent.thread_id}/attachments`)).json()) as Json;
    // An older app reads `attachments` only: the image is not one of them.
    expect(listing.attachments).toEqual([]);
    expect(listing.inline_images.map((i: Json) => i.id)).toEqual([record.id]);
    const phone = await door(`attachments/${record.id}/image`);
    const page = await fetch(`${base}/api/inbox/attachments/${record.id}/image`);
    expect(phone.status).toBe(200);
    expect(phone.headers.get("etag")).toBe(page.headers.get("etag"));
    expect(phone.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await phone.arrayBuffer()).equals(ONE_PIXEL_PNG)).toBe(true);
  });

  test("7.19, 7.20, 7.23, 7.24: the guide and a tick, live sessions, New message", async () => {
    const guide = await door(`messages/${guideMessage}/guide`);
    expect(guide.status).toBe(200);
    const g = (await guide.json()) as Json;
    expect(Object.keys(g).sort()).toEqual(["guide", "message_id", "snapshot"]);
    expect(g.guide.title).toBe("Token refresh");
    const tick = await door(`messages/${guideMessage}/guide/reviewed`, { body: { idempotency_key: keys(), reviewed: [true] } });
    expect(await tick.json()).toEqual({ message_id: guideMessage, reviewed: [true] });
    expect((await door(`messages/${threadId}/guide`)).status).toBe(404);

    const thread = (await (await door(`threads/${threadId}`)).json()) as Json;

    // No live session yet: New message writes nothing.
    const writer = thread.thread.messages[0].author.session as string;
    const none = await door(`threads/${threadId}/message`, { body: { idempotency_key: keys(), session: writer, body: "Also the EU account." } });
    expect(none.status).toBe(409);
    expect(((await none.json()) as Json).code).toBe("session_not_live");
    // The agent's connection polls once, saying where it works: now it is live.
    const poll = await fetch(`${base}/api/inbox/bridge/poll`, {
      method: "POST",
      headers: { Authorization: `Bearer ${registry(w).token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session: writer, host: "claude-code", waitMs: 0, project_path: w.project }),
    });
    expect(poll.status).toBe(200);
    const sessions = (await (await door(`threads/${threadId}/sessions`)).json()) as Json;
    expect(Object.keys(sessions).sort()).toEqual(["home", "project", "serverSession", "sessions"]);
    expect(sessions.sessions.map((s: Json) => s.session)).toContain(writer);
    const key = keys();
    const message = await door(`threads/${threadId}/message`, { body: { idempotency_key: key, session: writer, body: "Also the EU account." } });
    expect(message.status).toBe(200);
    expect((await message.json()) as Json).toMatchObject({ replayed: false, message: { author: { kind: "person" }, to: { host: "claude-code", session: writer }, idempotency_key: key } });
  });

  test("7.53: a comment on a guided review's diff, replayed by its key; the window's refusals pass through; removed through 7.18's route", async () => {
    const comment = (overrides: Json = {}) => ({
      id: "ann-guide-phone",
      type: "comment",
      scope: "line",
      filePath: "src/auth.ts",
      lineStart: 1,
      lineEnd: 1,
      side: "new",
      text: "Refresh before it expires.",
      createdAt: 1,
      ...overrides,
    });
    const route = `messages/${guideMessage}/guide/annotations`;
    const key = keys();
    const saved = await door(route, { body: { idempotency_key: key, annotation: comment() } });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Json).annotation).toMatchObject({
      message_id: guideMessage,
      attachment_id: "",
      path: "src/auth.ts",
      guide: { file: "src/auth.ts", side: "new", line_start: 1, line_end: 1 },
      sent_reply_id: null,
    });
    // The same key again: the recorded answer; the changed text is not written.
    const again = await door(route, { body: { idempotency_key: key, annotation: comment({ text: "changed" }) } });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(((await again.json()) as Json).annotation.annotation.text).toBe("Refresh before it expires.");
    // An edit is the same annotation id under a new key.
    const edited = await door(route, { body: { idempotency_key: keys(), annotation: comment({ text: "A minute early." }) } });
    expect(((await edited.json()) as Json).annotation.annotation.text).toBe("A minute early.");
    // The window's refusals, unchanged.
    const outside = await door(route, { body: { idempotency_key: keys(), annotation: comment({ id: "ann-guide-x", filePath: "nope.ts" }) } });
    expect([outside.status, ((await outside.json()) as Json).field]).toEqual([422, "annotation.filePath"]);
    const noGuide = await door(`messages/${threadId}/guide/annotations`, { body: { idempotency_key: keys(), annotation: comment({ id: "ann-guide-y" }) } });
    expect([noGuide.status, ((await noGuide.json()) as Json).code]).toEqual([404, "guide_not_found"]);
    // Removed through the attachments' remove route (7.18), already on the door; then closed to edits.
    expect((await door("annotations/ann-guide-phone/remove", { body: { idempotency_key: keys() } })).status).toBe(200);
    const closed = await door(route, { body: { idempotency_key: keys(), annotation: comment() } });
    expect([closed.status, ((await closed.json()) as Json).code]).toEqual([409, "annotation_closed"]);
  });

  test("7.59: a comment on the text of an agent's message, replayed by its key; the window's refusals pass through; removed through 7.18's route", async () => {
    const comment = (overrides: Json = {}) => ({
      id: "ann-message-phone",
      blockId: "block-0",
      startOffset: 0,
      endOffset: 5,
      type: "COMMENT",
      text: "Say which retries.",
      originalText: "Retry",
      createdA: 1,
      ...overrides,
    });
    const route = `messages/${threadId}/annotations`;
    const key = keys();
    const saved = await door(route, { body: { idempotency_key: key, annotation: comment() } });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Json).annotation).toMatchObject({
      message_id: threadId,
      attachment_id: "",
      path: threadId,
      version: "current",
      message: { at: expect.any(String) },
      sent_reply_id: null,
    });
    // The same key again: the recorded answer; the changed text is not written.
    const again = await door(route, { body: { idempotency_key: key, annotation: comment({ text: "changed" }) } });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(((await again.json()) as Json).annotation.annotation.text).toBe("Say which retries.");
    // The window's refusals, unchanged: a deletion is not a comment.
    const deletion = await door(route, { body: { idempotency_key: keys(), annotation: comment({ id: "ann-message-x", type: "DELETION" }) } });
    expect([deletion.status, ((await deletion.json()) as Json).field]).toEqual([422, "annotation.type"]);
    // Removed through the attachments' remove route (7.18); then closed to edits.
    expect((await door("annotations/ann-message-phone/remove", { body: { idempotency_key: keys() } })).status).toBe(200);
    const closed = await door(route, { body: { idempotency_key: keys(), annotation: comment() } });
    expect([closed.status, ((await closed.json()) as Json).code]).toEqual([409, "annotation_closed"]);
  });

  test("7.60: who can be tagged, and a reply that tags a live session, forwarded unchanged; the tagged session is handed it with the tagged wake", async () => {
    const { token: bridgeToken } = JSON.parse(readFileSync(join(w.dataDir, "inbox", "inbox.json"), "utf8")) as { token: string };
    const poll = async () =>
      (await (
        await fetch(`${base}/api/inbox/bridge/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridgeToken}` },
          body: JSON.stringify({ session: "pi-door", host: "pi", project_path: w.project, waitMs: 0, tags: true }),
        })
      ).json()) as { commands: Json[] };
    await poll();
    const taggable = (await (await door(`threads/${threadId}/taggable`)).json()) as Json;
    expect(taggable.sessions.find((s: Json) => s.session === "pi-door")).toMatchObject({ kind: "live", host: "pi", taggable: true, owner: false });
    const key = keys();
    const sent = await door(`messages/${threadId}/reply`, { body: { idempotency_key: key, words: "@Pi take the retries.", tags: [{ host: "pi", session: "pi-door", label: "Pi" }] } });
    expect(sent.status).toBe(200);
    const reply = ((await sent.json()) as Json).reply;
    expect(reply.tags).toEqual([{ host: "pi", session: "pi-door", label: "Pi", wakes: true }]);
    const handed = (await poll()).commands.find((c) => c.id === reply.id);
    expect(handed).toMatchObject({ tagged: { owner: "Claude Code" } });
    // The same key again: the recorded answer, nothing new written.
    const again = await door(`messages/${threadId}/reply`, { body: { idempotency_key: key, words: "@Pi take the retries.", tags: [{ session: "gone" }] } });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    // A session that is not live: refused, nothing written.
    const gone = await door(`messages/${threadId}/reply`, { body: { idempotency_key: keys(), words: "x", tags: [{ session: "nobody" }] } });
    expect([gone.status, ((await gone.json()) as Json).code]).toEqual([409, "session_not_live"]);
  });

  test("7.63: an action item's Done and its Undo, forwarded unchanged and replayed by key; a question's key is not a door route", async () => {
    const sent = await agent.send({ project_path: w.project, thread: "door-todo", body: ":::action\nApprove the deploy on Vercel\nWhere: https://vercel.com/acme\n:::" });
    const listed = (await (await door(`threads/${sent.thread_id}`)).json()) as Json;
    const todo = listed.thread.messages[0].questions.find((q: Json) => q.kind === "action");
    expect(todo).toMatchObject({ state: "open", action: { where_url: "https://vercel.com/acme" } });
    const route = `messages/${sent.message_id}/actions/${todo.key}`;
    const key = keys();
    const done = await door(route, { body: { idempotency_key: key, outcome: "done", note: "Approved." } });
    expect(done.status).toBe(200);
    expect(((await done.json()) as Json).questions.find((q: Json) => q.key === todo.key)).toMatchObject({ state: "picked", action_result: { outcome: "done", note: "Approved.", by: "person" } });
    const again = await door(route, { body: { idempotency_key: key, outcome: "cant", note: "changed" } });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    const undone = await door(route, { body: { idempotency_key: keys(), outcome: null } });
    expect(((await undone.json()) as Json).questions.find((q: Json) => q.key === todo.key)).toMatchObject({ state: "open", action_result: null });
    expect((await door(`messages/${sent.message_id}/actions/q-00000000`, { body: { idempotency_key: keys(), outcome: "done" } })).status).toBe(404);
  });

  test("7.12 and 7.13: resolve, then delete the thread", async () => {
    const resolved = await door(`messages/${threadId}/resolve`, { body: { idempotency_key: keys(), resolved: true } });
    expect(((await resolved.json()) as Json).thread.resolved_at).toBeTruthy();
    // The window moved archived threads out of its list (Settings lists them);
    // the phone's list is unchanged unless it asks: the thread stays in Quiet.
    const list = (await (await door("threads")).json()) as Json;
    const quiet = list.sections.find((s: Json) => s.id === "quiet").threads.map((t: Json) => t.thread_id);
    expect(quiet).toContain(threadId);
    const apart = (await (await door("threads?archived=exclude")).json()) as Json;
    expect(apart.sections.flatMap((s: Json) => s.threads).map((t: Json) => t.thread_id)).not.toContain(threadId);
    const archived = (await (await door("threads/archived")).json()) as Json;
    expect(archived.threads.map((t: Json) => t.thread_id)).toContain(threadId);
    const deleted = await door(`threads/${threadId}/delete`, { body: { idempotency_key: keys() } });
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as Json;
    expect(body.ok).toBe(true);
    expect(Object.keys(body.store).sort()).toEqual(["bytes", "dir", "projects"]);
    expect((await door(`threads/${threadId}`)).status).toBe(404);
  });

  test("the answers survive a restart: a key sent before it replays after it", async () => {
    const key = keys();
    const first = await door(`messages/${guideMessage}/guide/reviewed`, { body: { idempotency_key: key, reviewed: [false] } });
    expect(first.status).toBe(200);
    await stopInbox(w);
    const entry = startInbox(w);
    base = `http://127.0.0.1:${entry.port}`;
    serverSession = ((await (await fetch(`${base}/api/inbox/health`)).json()) as Json).serverSession;
    const again = await door(`messages/${guideMessage}/guide/reviewed`, { body: { idempotency_key: key, reviewed: [false] } });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.json()).toEqual({ message_id: guideMessage, reviewed: [false] });
  }, 30_000);

  test("7.36 and 7.37: the window lists phones newest first with last seen; Remove revokes, closes the phone's stream, and its next call is 401", async () => {
    const made = await offer();
    const second = (await (await door("pair", { token: null, body: { code: made.offer.code, name: "Work iPhone", platform: "ios" } })).json()) as Json;
    const listed = (await (await win("/api/inbox/devices")).json()) as Json;
    expect(Object.keys(listed)).toEqual(["devices"]);
    expect(listed.devices.map((d: Json) => d.name)).toEqual(["Work iPhone", "iPhone"]);
    for (const device of listed.devices) expect(Object.keys(device).sort()).toEqual(DEVICE_KEYS);
    const mine = listed.devices.find((d: Json) => d.id === deviceId);
    expect(Date.parse(mine.last_seen_at)).toBeGreaterThan(Date.parse(mine.created_at));

    const stream = await door("events", { token: second.token });
    const reader = stream.body!.getReader();
    await reader.read();
    const removed = await win(`/api/inbox/devices/${second.device.id}/revoke`, { serverSession });
    expect(removed.status).toBe(200);
    const r = ((await removed.json()) as Json).device;
    expect(Object.keys(r).sort()).toEqual(DEVICE_KEYS);
    expect(r.revoked_at).toBeTruthy();
    // The open stream ends.
    let ended = false;
    const deadline = Date.now() + 5_000;
    while (!ended && Date.now() < deadline) ended = (await reader.read()).done;
    expect(ended).toBe(true);
    expect(existsSync(join(w.dataDir, "inbox", "device-secrets", second.device.id))).toBe(false);
    const after = await door("threads", { token: second.token });
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "This phone was removed from the Inbox. Pair it again.", code: "device_revoked" });
    expect(((await (await win("/api/inbox/devices")).json()) as Json).devices.map((d: Json) => d.id)).toEqual([deviceId]);
    expect((await win("/api/inbox/devices/dev_nope/revoke", { serverSession })).status).toBe(404);
  });

  test("7.25: the phone removes itself; twice changes nothing; every later request is device_revoked", async () => {
    const first = await door("revoke", { body: {} });
    expect(first.status).toBe(200);
    const device = ((await first.json()) as Json).device;
    expect(device).toMatchObject({ id: deviceId, name: "iPhone" });
    expect(device.revoked_at).toBeTruthy();
    for (const path of ["health", "threads", "revoke"]) {
      const response = await door(path, { method: path === "revoke" ? "POST" : "GET", body: path === "revoke" ? {} : undefined });
      expect([path, response.status, ((await response.json()) as Json).code]).toEqual([path, 401, "device_revoked"]);
    }
    expect(((await (await win("/api/inbox/devices")).json()) as Json).devices).toEqual([]);
    if (inboxBinary()) w.proof("door proof ran against the compiled binary");
  });
});

describe("the device door, in process", () => {
  const roots: string[] = [];
  afterAll(() => {
    resetServedHostnamesForTests();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test("an offer expires with its window: 10 minutes after it was made, its code is 410", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-inbox-devices-clock-"));
    roots.push(dataDir);
    let clock = Date.parse("2026-10-08T10:00:00.000Z");
    const inbox = await startInboxServer({ dataDir, binaryPath: null, phones: true, now: () => new Date(clock) });
    try {
      const base = `http://127.0.0.1:${inbox.port}`;
      const made = (await (await fetch(`${base}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as Json;
      expect(made.offer.expires_at).toBe("2026-10-08T10:10:00.000Z");
      clock += 10 * 60_000;
      const late = await fetch(`${base}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) });
      expect(late.status).toBe(410);
      expect(((await late.json()) as Json).code).toBe("offer_expired");
    } finally {
      inbox.stop();
    }
  });

  test("the tailnet reaches only the door: tailscale serve points at a door-only listener, so a spoofed Host reaches no window route; the mapping and the listener go when the switch goes off and at a clean stop or restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-inbox-devices-tailnet-"));
    roots.push(dataDir);
    // Tailscale's serve config, kept by a scripted CLI through the seam the Inbox runs the real one with.
    const serve = new Map<number, string>();
    // Tailscale failing to answer status, or to publish (stopped, signed out).
    const down = { status: false, serve: false };
    const calls: string[][] = [];
    const tailscale: TailscaleRunner = (args) => {
      calls.push(args);
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      const fail = { status: 1, stdout: "", stderr: "Tailscale is stopped." };
      if (args[1] === "status" && down.status) return fail;
      if (args[1] !== "status" && !args.includes("off") && down.serve) return fail;
      if (args[1] === "status") {
        if (serve.size === 0) return ok("{}");
        const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
        const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`macbook-pro.tail0000.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
        return ok(JSON.stringify({ TCP, Web }));
      }
      const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
      if (args.includes("off")) {
        serve.delete(httpsPort);
        return ok();
      }
      serve.set(httpsPort, args.at(-1)!);
      return ok(`Available within your tailnet:\n\nhttps://macbook-pro.tail0000.ts.net:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
    };
    const refused = async (response: Response) => [response.status, ((await response.json()) as Json).code];
    try {
      const inbox = await startInboxServer({ dataDir, binaryPath: null, phones: true, tailscale });
      const main = `http://127.0.0.1:${inbox.port}`;
      const on = await fetch(`${main}/api/inbox/tailnet`, { method: "POST", body: JSON.stringify({ on: true }) });
      expect(((await on.json()) as Json).tailnet).toMatchObject({ on: true, address: "macbook-pro.tail0000.ts.net:8443" });
      // What tailscale serve forwards to: the door listener, never the window's port.
      const target = serve.get(8443)!;
      const doorPort = Number(new URL(target).port);
      expect(target).toBe(`http://127.0.0.1:${doorPort}`);
      expect(doorPort).not.toBe(inbox.port);
      expect(JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8")).tailnet).toEqual({ https_port: 8443, door_port: doorPort });
      const tailnetDoor = `http://127.0.0.1:${doorPort}`;

      // A tailnet peer through serve: the door works there.
      const made = (await (await fetch(`${main}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as Json;
      const paired = await fetch(`${tailnetDoor}/api/inbox/device/pair`, { method: "POST", headers: { Host: "macbook-pro.tail0000.ts.net:8443", "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) });
      expect(paired.status).toBe(201);
      const { token } = (await paired.json()) as Json;
      expect((await fetch(`${tailnetDoor}/api/inbox/device/threads`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);

      // The same peer spoofing a loopback Host (serve passes it through) reaches no window route there.
      for (const host of ["localhost", "127.0.0.1", `127.0.0.1:${inbox.port}`, "macbook-pro.tail0000.ts.net:8443"]) {
        for (const [method, path] of [
          ["GET", "/"],
          ["GET", "/api/inbox/threads"],
          ["POST", "/api/inbox/pairing"],
          ["POST", "/mcp"],
          ["GET", "/api/inbox/settings"],
          ["POST", "/api/inbox/settings"],
          ["POST", "/api/inbox/restart"],
          ["POST", "/api/inbox/projects/prj_x/delete"],
          ["POST", "/api/inbox/bridge/poll"],
          ["POST", "/api/inbox/control/stop"],
          ["GET", "/api/inbox/devices"],
          ["POST", "/api/inbox/tailnet"],
        ] as const) {
          const response = await fetch(`${tailnetDoor}${path}`, { method, headers: { Host: host }, body: method === "POST" ? "{}" : undefined });
          expect([host, path, ...(await refused(response))]).toEqual([host, path, 404, "device_route_not_found"]);
        }
      }
      // The window's port never learns the tailnet name (phones use their own listener).
      expect((await fetch(`${main}/api/inbox/threads`, { headers: { Host: "macbook-pro.tail0000.ts.net:8443" } })).status).toBe(403);
      // The window's own port is unchanged: a loopback client with no Origin is served as before.
      expect((await fetch(`${main}/api/inbox/threads`, { headers: { Host: "localhost" } })).status).toBe(200);
      expect((await fetch(`${main}/api/inbox/pairing`, { method: "POST", headers: { Host: "localhost" }, body: "{}" })).status).toBe(201);

      // Off while Tailscale cannot answer: nothing changes and the window is told, so door_port still names the mapping to take down.
      down.status = true;
      const stuck = await fetch(`${main}/api/inbox/tailnet`, { method: "POST", body: JSON.stringify({ on: false }) });
      expect(await refused(stuck)).toEqual([409, "tailnet_unavailable"]);
      expect(serve.get(8443)).toBe(target);
      expect(JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8")).tailnet).toEqual({ https_port: 8443, door_port: doorPort });
      expect((await fetch(`${tailnetDoor}/api/inbox/device/health`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
      down.status = false;

      // Off: the mapping and the listener are gone; the switch is cleared.
      await fetch(`${main}/api/inbox/tailnet`, { method: "POST", body: JSON.stringify({ on: false }) });
      expect(serve.has(8443)).toBe(false);
      expect(await fetch(`${tailnetDoor}/api/inbox/device/health`).then(() => "answered", () => "closed")).toBe("closed");
      expect(JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8")).tailnet).toBeUndefined();

      // On again, then a clean stop: both go, the switch stays on for the next start, which publishes again.
      await fetch(`${main}/api/inbox/tailnet`, { method: "POST", body: JSON.stringify({ on: true }) });
      expect(serve.has(8443)).toBe(true);
      inbox.stop();
      expect(serve.has(8443)).toBe(false);
      expect(JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8")).tailnet.https_port).toBe(8443);
      let atRestart: string | undefined = "not called";
      const next = await startInboxServer({ dataDir, binaryPath: null, phones: true, tailscale, onRestartRequested: () => (atRestart = serve.get(8443)) });
      expect(serve.get(8443)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(serve.get(8443)).not.toBe(`http://127.0.0.1:${next.port}`);
      // Restart to update takes the mapping down before the new run starts (no race with its publish).
      expect((await fetch(`http://127.0.0.1:${next.port}/api/inbox/restart`, { method: "POST", body: "{}" })).status).toBe(200);
      await Bun.sleep(150);
      expect(atRestart).toBeUndefined();

      // After a crash (kill -9): the mapping still points at the dead run's door listener.
      const crashed = await startInboxServer({ dataDir, binaryPath: null, phones: true, tailscale });
      const deadDoor = serve.get(8443)!;
      crashed.stop();
      serve.set(8443, deadDoor);
      // The next start that cannot publish takes that leftover down rather than leave it.
      down.serve = true;
      const unpublished = await startInboxServer({ dataDir, binaryPath: null, phones: true, tailscale });
      expect(serve.has(8443)).toBe(false);
      unpublished.stop();
      down.serve = false;
      // With the Inbox stopped, uninstall --purge's take-down finds it by door_port.
      const leftover = `http://127.0.0.1:${JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8")).tailnet.door_port}`;
      serve.set(8443, leftover);
      expect(takeDownInboxTailnet(dataDir, tailscale)).toBe("removed");
      expect(serve.has(8443)).toBe(false);
      expect(takeDownInboxTailnet(dataDir, tailscale)).toBe("none");

      // A mapping someone else put on 8443 is never taken down.
      const third = await startInboxServer({ dataDir, binaryPath: null, phones: true, tailscale });
      serve.set(8443, "http://127.0.0.1:3000");
      third.stop();
      expect(serve.get(8443)).toBe("http://127.0.0.1:3000");
      expect(takeDownInboxTailnet(dataDir, tailscale)).toBe("none");
      // A data dir whose switch was never on spawns no tailscale at all.
      const before = calls.length;
      expect(takeDownInboxTailnet(mkdtempSync(join(tmpdir(), "plannotator-inbox-devices-none-")), tailscale)).toBe("none");
      expect(calls.length).toBe(before);
    } finally {
      resetServedHostnamesForTests();
    }
  });
  test("7.11: a phone's Send skips only what the person chose (skip: [keys]); skip_unanswered is ignored; one Send to one session is one reply", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-inbox-devices-words-"));
    roots.push(dataDir);
    const inbox = await startInboxServer({ dataDir, binaryPath: null, phones: true, setAsideDelayMs: 60_000 });
    try {
      const base = `http://127.0.0.1:${inbox.port}`;
      const made = (await (await fetch(`${base}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as Json;
      const pair = await fetch(`${base}/api/inbox/device/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }),
      });
      const token = ((await pair.json()) as Json).token as string;
      const reply = (message: string, body: Json, key: string = crypto.randomUUID()) =>
        fetch(`${base}/api/inbox/device/messages/${message}/reply`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ idempotency_key: key, ...body }),
        });
      // One session asks twice in one thread, one open question each: the owner's thread on 0.28.20.
      const ask = (n: number) => {
        const project = inbox.store.ensureProject({ name: `films-${n}`, root: join(dataDir, `films-${n}`) });
        const author = { kind: "agent" as const, host: "claude-code", session: `ses_films${n}`, name: "Claude Code" };
        const question = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
        const first = inbox.store.sendMessage({ project_id: project.id, author, body: question("Is this the film you submit?") }).message;
        const second = inbox.store.sendMessage({ project_id: project.id, author, reply_to: first.id, body: question("Is this the film you upload?") }).message;
        return { first: first.id, second: second.id, keys: [inbox.store.questionsOf(first.id)[0]!.key, inbox.store.questionsOf(second.id)[0]!.key] as const };
      };
      const thread = (id: string) => inbox.store.thread(id)!;
      const states = (id: string) => thread(id).messages.flatMap((m) => m.questions ?? []).map((q) => q.state);
      const people = (id: string) => thread(id).messages.filter((m) => m.author.kind === "person");
      const words = "Is there a way to attach video?";

      // The default (Keep open): a words-only Send, with or without the old flag, skips nothing. One reply, to the latest message.
      for (const [n, extra] of [[0, {}], [1, { skip_unanswered: true }]] as const) {
        const t = ask(n);
        expect((await reply(t.second, { words, questions: [], ...extra })).status).toBe(200);
        expect(states(t.first)).toEqual(["open", "open"]);
        // Pinned word for word on purpose: the still-open line is the approved agent wording (approval "inbox-words-only-reply").
        expect(people(t.first).map((m) => [m.reply_to, m.body])).toEqual([
          [t.second, `${words}\n\nNo questions answered yet; all 2 are still open. Don't re-ask them; the person will answer in the Inbox.`],
        ]);
      }

      // What the iPhone app sent on 0.28.20 (a reply to each message, skip_unanswered: true): now it skips nothing.
      const old = ask(2);
      expect((await reply(old.first, { words: "", questions: [], skip_unanswered: true })).status).toBe(422);
      expect((await reply(old.second, { words, questions: [], skip_unanswered: true })).status).toBe(200);
      expect(states(old.first)).toEqual(["open", "open"]);

      // The person tapped Skip them: one reply to the latest message, skipping both questions (one names its message).
      const t = ask(3);
      const key = crypto.randomUUID();
      const skipBody = { words, questions: [], skip: [{ message_id: t.first, key: t.keys[0] }, t.keys[1]] };
      expect((await reply(t.second, skipBody, key)).status).toBe(200);
      expect(states(t.first)).toEqual(["sent", "sent"]);
      expect(people(t.first).map((m) => [m.reply_to, m.body.split("\n")[0]])).toEqual([[t.second, "Skipped 2 questions."]]);
      // Replayed (the door's idempotency log): the same answer, nothing new.
      const again = await reply(t.second, skipBody, key);
      expect(again.headers.get("Idempotent-Replayed")).toBe("true");
      expect(people(t.first)).toHaveLength(1);

      // Answers on both messages: one reply, each answer under its message's id.
      const both = ask(4);
      const answer = (k: string) => {
        const q = [...inbox.store.questionsOf(both.first), ...inbox.store.questionsOf(both.second)].find((x) => x.key === k)!;
        return { v: 1, key: k, kind: q.kind, prompt: q.prompt, selected: ["Yes"] };
      };
      const res = await reply(both.second, {
        words: "",
        questions: [
          { message_id: both.first, key: both.keys[0], revision: 0, answer: answer(both.keys[0]) },
          { key: both.keys[1], revision: 0, answer: answer(both.keys[1]) },
        ],
      });
      expect(res.status).toBe(200);
      expect(states(both.first)).toEqual(["sent", "sent"]);
      const sent = people(both.first);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body.split("\n")[0]).toBe("Answered 2 questions.");
      expect(sent[0]!.body).toContain(`### Your message ${both.first}`);
    } finally {
      inbox.stop();
    }
  });

  test("one command sent twice at once is applied once: the second waits for the first and replays its answer", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-inbox-devices-race-"));
    roots.push(dataDir);
    // The window's handler, counted: the door hands each allowed request to it.
    let applied = 0;
    const phones = createInboxDevices({
      dataDir,
      serverSession: "0".repeat(32),
      port: () => 1,
      registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      dispatch: async () => {
        applied += 1;
        await Bun.sleep(20);
        return Response.json({ thread: { thread_id: "msg_x" } });
      },
    });
    const made = (await (await phones.windowRoute(new Request("http://127.0.0.1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1/api/inbox/pairing")))!.json()) as Json;
    const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
    const paired = (await (await phones.door(new Request(pairUrl, { method: "POST", body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) }), pairUrl)).json()) as Json;
    const url = new URL("http://127.0.0.1/api/inbox/device/threads/msg_x/seen");
    const send = () =>
      phones.door(new Request(url, { method: "POST", headers: { Authorization: `Bearer ${paired.token}` }, body: JSON.stringify({ idempotency_key: "same-tap" }) }), url);
    // Both bodies are already in memory, so both requests reach the key check in the same turn.
    const [a, b] = await Promise.all([send(), send()]);
    expect(applied).toBe(1);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.headers.get("idempotent-replayed"), b.headers.get("idempotent-replayed")]).toEqual([null, "true"]);
  });

  test("through the relay (asDevice), a message image's path rides to the window's route with its query; a removed phone is refused", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-inbox-devices-relay-image-"));
    roots.push(dataDir);
    const asked: string[] = [];
    const phones = createInboxDevices({
      dataDir,
      serverSession: "0".repeat(32),
      port: () => 1,
      registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      dispatch: async (req) => {
        const url = new URL(req.url);
        asked.push(`${req.method} ${url.pathname}${url.search}`);
        return new Response(ONE_PIXEL_PNG, { headers: { "Content-Type": "image/png" } });
      },
    });
    const made = (await (await phones.windowRoute(new Request("http://127.0.0.1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1/api/inbox/pairing")))!.json()) as Json;
    const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
    const paired = (await (await phones.door(new Request(pairUrl, { method: "POST", body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) }), pairUrl)).json()) as Json;
    const path = `/api/inbox/device/messages/msg_x/image?path=${encodeURIComponent("shots/my shot.png")}`;
    const answer = await phones.asDevice(paired.device.id, { method: "GET", path });
    expect(answer.status).toBe(200);
    expect(Buffer.from(await answer.arrayBuffer()).equals(ONE_PIXEL_PNG)).toBe(true);
    expect(asked).toEqual([`GET /api/inbox/messages/msg_x/image?path=${encodeURIComponent("shots/my shot.png")}`]);
    const revokeUrl = new URL("http://127.0.0.1/api/inbox/device/revoke");
    await phones.door(new Request(revokeUrl, { method: "POST", headers: { Authorization: `Bearer ${paired.token}` }, body: "{}" }), revokeUrl);
    const after = await phones.asDevice(paired.device.id, { method: "GET", path });
    expect(after.status).toBe(401);
    expect(asked.length).toBe(1);
  });
});

describe("the door's parity routes, in process (7.39 to 7.49)", () => {
  const roots: string[] = [];
  const servers: { stop: () => void }[] = [];
  afterAll(() => {
    for (const server of servers) server.stop();
    resetServedHostnamesForTests();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const ask = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

  /** Pair a phone at `doorBase` with an offer made on the window at `windowBase`; returns its token. */
  const pairPhone = async (windowBase: string, doorBase = windowBase): Promise<string> => {
    const made = (await (await fetch(`${windowBase}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as Json;
    const paired = await fetch(`${doorBase}/api/inbox/device/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }),
    });
    expect(paired.status).toBe(201);
    return ((await paired.json()) as Json).token as string;
  };

  const world = async (options: Partial<Parameters<typeof startInboxServer>[0]> = {}) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-devices-parity-")));
    roots.push(root);
    const ledger = join(root, "ledger");
    mkdirSync(ledger, { recursive: true });
    const inbox = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, phones: true, setAsideDelayMs: 60_000, ...options });
    servers.push(inbox);
    const base = `http://127.0.0.1:${inbox.port}`;
    const token = await pairPhone(base);
    /** The phone: a JSON body, or a raw one (`raw`), with its bearer token and no Origin. */
    const door = (path: string, init: { body?: unknown; raw?: BodyInit; headers?: Record<string, string>; doorBase?: string; fresh?: boolean } = {}) =>
      fetch(`${init.doorBase ?? base}/api/inbox/device/${path}`, {
        // `fresh`: a connection of its own (a body the server stopped reading leaves its connection unusable).
        ...(init.fresh ? { keepalive: false } : {}),
        method: init.body === undefined && init.raw === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
        body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
      });
    /** One poll from an agent's connection, saying where it works: live for 30 s. */
    const poll = async (session: string, host: string) => {
      const response = await fetch(`${base}/api/inbox/bridge/poll`, {
        method: "POST",
        headers: { Authorization: `Bearer ${inbox.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session, host, waitMs: 0, project_path: ledger, started_at: Date.now(), busy: false }),
      });
      expect(response.status).toBe(200);
    };
    return { root, ledger, inbox, base, token, door, poll };
  };

  test("7.62: a thread's reply draft, read only; the row's unsent rides the list", async () => {
    const { ledger, inbox, base, door } = await world();
    const project = inbox.store.ensureProject({ name: "ledger", root: ledger });
    const asked = inbox.store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses-d", name: null }, body: "The build is green." }).message;
    expect(((await (await door(`threads/${asked.id}/draft`)).json()) as Json).draft).toBeNull();
    const saved = await fetch(`${base}/api/inbox/threads/${asked.id}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: inbox.serverSession, body: "Ship it, but keep the totals", base: null }),
    });
    expect(saved.status).toBe(200);
    const read = (await (await door(`threads/${asked.id}/draft`)).json()) as Json;
    expect(read.draft).toMatchObject({ v: 1, thread_id: asked.id, body: "Ship it, but keep the totals" });
    const list = (await (await door("threads")).json()) as Json;
    const row = list.sections.flatMap((s: Json) => s.threads).find((r: Json) => r.thread_id === asked.id);
    expect(row.unsent).toEqual({ reply_at: read.draft.updated_at, picks: 0, comments: 0 });
    // Writing a draft is the window's: the door has no route for it.
    const refused = await door(`threads/${asked.id}/draft`, { body: { idempotency_key: "draft-1", body: "x", base: null } });
    expect(refused.status).toBe(404);
  });

  test("7.39 to 7.41: the live sessions, a thread the phone starts (replayed by its key, refusals unchanged), and Send to another session", async () => {
    const { ledger, inbox, door, poll } = await world();
    await poll("ses-a", "claude-code");
    await poll("ses-b", "pi");

    const sessions = (await (await door("sessions?session=ses-a")).json()) as Json;
    expect(Object.keys(sessions).sort()).toEqual(["home", "projects", "serverSession", "session"]);
    expect(sessions.session).toEqual({ session: "ses-a", live: true });
    expect(sessions.projects.map((group: Json) => group.project.root)).toEqual([ledger]);
    expect(sessions.projects[0].sessions.map((s: Json) => s.session).sort()).toEqual(["ses-a", "ses-b"]);

    const started = await door("messages", { body: { idempotency_key: "compose-1", to: { session: "ses-a" }, body: "Add a retry budget." } });
    expect(started.status).toBe(200);
    const first = (await started.json()) as Json;
    expect(Object.keys(first).sort()).toEqual(["message", "project", "replayed", "thread_id"]);
    expect(first).toMatchObject({ replayed: false, project: { root: ledger }, message: { author: { kind: "person" }, to: { host: "claude-code", session: "ses-a" } } });
    // A retry with the key: the recorded answer, and still one message.
    const again = await door("messages", { body: { idempotency_key: "compose-1", to: { session: "ses-a" }, body: "Add a retry budget." } });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(((await again.json()) as Json).message.id).toBe(first.message.id);
    expect(inbox.store.thread(first.thread_id)!.messages).toHaveLength(1);
    // No live session: the window's refusal, and nothing written.
    // draft_id deletes a shared draft, and drafts stay on the computer: the door refuses it before the window runs.
    const drafted = await door("messages", { body: { idempotency_key: "compose-3", to: { session: "ses-a" }, body: "Hi", draft_id: "drf_01K70000000000000000000001" } });
    expect([drafted.status, ((await drafted.json()) as Json).field]).toEqual([422, "draft_id"]);
    const gone = await door("messages", { body: { idempotency_key: "compose-2", to: { session: "ses-gone" }, body: "Hello" } });
    expect([gone.status, ((await gone.json()) as Json).code]).toEqual([409, "session_not_live"]);

    const moved = await door(`messages/${first.message.id}/to`, { body: { idempotency_key: "to-1", to: { host: "pi", session: "ses-b" } } });
    expect(moved.status).toBe(200);
    const m = (await moved.json()) as Json;
    expect(Object.keys(m).sort()).toEqual(["message", "row"]);
    expect(m.message.to).toEqual({ host: "pi", session: "ses-b" });
    const nowhere = await door(`messages/${first.message.id}/to`, { body: { idempotency_key: "to-2", to: { session: "ses-gone" } } });
    expect([nowhere.status, ((await nowhere.json()) as Json).code]).toEqual([409, "session_not_live"]);
  });

  test("7.56: 👍 Looks good and its Undo, replayed by the key; the window's refusals pass through; nothing is sent", async () => {
    const { ledger, inbox, door } = await world();
    const project = inbox.store.ensureProject({ name: "ledger", root: ledger });
    const author = { kind: "agent" as const, host: "claude-code", session: "ses-a", name: null };
    const news = inbox.store.sendMessage({ project_id: project.id, author, body: "Merged. CI is green." }).message;
    const acked = await door(`messages/${news.id}/ack`, { body: { idempotency_key: "ack-1" } });
    expect(acked.status).toBe(200);
    const a = (await acked.json()) as Json;
    expect(Object.keys(a).sort()).toEqual(["message", "thread"]);
    expect(a.message.ack).toMatchObject({ label: "Looks good" });
    expect(a.thread).toMatchObject({ section: "quiet", ack: { label: "Looks good" } });
    const again = await door(`messages/${news.id}/ack`, { body: { idempotency_key: "ack-1" } });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(inbox.store.thread(news.thread_id)!.messages).toHaveLength(1);
    const undone = await door(`messages/${news.id}/ack`, { body: { idempotency_key: "ack-2", ack: false } });
    expect(((await undone.json()) as Json).message.ack).toBeNull();
    const asking = inbox.store.sendMessage({ project_id: project.id, author, body: ask("Ship it?"), reply_to: news.id }).message;
    const open = await door(`messages/${asking.id}/ack`, { body: { idempotency_key: "ack-3" } });
    expect([open.status, ((await open.json()) as Json).code]).toEqual([409, "question_open"]);
  });

  test("7.42: search, read only, with its query; a phone's fetch metadata never reaches the window's cross-site check", async () => {
    const { ledger, inbox, door } = await world();
    const project = inbox.store.ensureProject({ name: "ledger", root: ledger });
    const sent = inbox.store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "pi", session: "ses_s", name: "Pi" }, body: "The webhook retry budget is ready." }).message;
    let body: Json = {};
    for (let i = 0; i < 40; i++) {
      const answer = await door("search?q=webhook", { headers: { "Sec-Fetch-Site": "cross-site" } });
      expect(answer.status).toBe(200);
      body = (await answer.json()) as Json;
      if (!body.indexing) break;
      await Bun.sleep(50);
    }
    expect(body).toMatchObject({ q: "webhook", indexing: false });
    expect(JSON.stringify(body.groups)).toContain(sent.thread_id);
    expect((await door("search?status=nope")).status).toBe(422);
  });

  test("7.43 to 7.45: the project menu's batches; a replayed key answers the recorded batch and never runs a second one", async () => {
    const { ledger, inbox, door } = await world();
    const store = inbox.store;
    const project = store.ensureProject({ name: "ledger", root: ledger });
    const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: "Claude Code" });
    const a = store.sendMessage({ project_id: project.id, author: agent("ses_1"), body: ask("Ship today?") }).message.thread_id;
    const b = store.sendMessage({ project_id: project.id, author: agent("ses_2"), body: ask("Which index?") }).message.thread_id;
    const readAt = (id: string) => store.listRow(id)!.read_at;

    const read = await door(`projects/${project.id}/read`, { body: { idempotency_key: "menu-read" } });
    expect(read.status).toBe(200);
    const batch = (await read.json()) as Json;
    expect([...batch.batch.read].sort()).toEqual([a, b].sort());
    expect(readAt(a)).toBeTruthy();
    const undo = await door(`projects/${project.id}/unread`, { body: { idempotency_key: "menu-unread", threads: batch.batch.read } });
    expect(undo.status).toBe(200);
    expect([readAt(a), readAt(b)]).toEqual([null, null]);
    // The first key again (a retry whose answer was lost): the recorded answer; the threads stay as the Undo left them.
    const replay = await door(`projects/${project.id}/read`, { body: { idempotency_key: "menu-read" } });
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(((await replay.json()) as Json).batch).toEqual(batch.batch);
    expect([readAt(a), readAt(b)]).toEqual([null, null]);

    const archive = await door(`projects/${project.id}/resolve`, { body: { idempotency_key: "menu-archive" } });
    const archived = (await archive.json()) as Json;
    expect([...archived.batch.resolved].sort()).toEqual([a, b].sort());
    expect(store.listRow(a)!.resolved_at).toBeTruthy();
    const back = await door(`projects/${project.id}/resolve`, { body: { idempotency_key: "menu-unarchive", resolved: false, threads: archived.batch } });
    expect(back.status).toBe(200);
    expect(store.listRow(a)!.resolved_at).toBeNull();
    // The window's refusals, unchanged.
    const bad = await door("projects/prj_x/read", { body: { idempotency_key: "menu-bad" } });
    expect([bad.status, ((await bad.json()) as Json).code]).toEqual([422, "validation_error"]);
  });

  test("7.46 and 7.47: the skill catalog and one skill's SKILL.md (a scratch HOME's skill folders only)", async () => {
    const { root, door } = await world();
    const names = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"] as const;
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const home = join(root, "home");
    try {
      process.env.HOME = home;
      process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
      process.env.CODEX_HOME = join(home, ".codex");
      process.env.XDG_CONFIG_HOME = join(home, ".config");
      const dir = join(home, ".claude", "skills", "readback");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: readback\ndescription: State the request back.\ndisable-model-invocation: true\n---\n\n# Readback\n");
      const list = (await (await door("skills")).json()) as Json;
      expect(list.skills.map((s: Json) => [s.name, s.humanOnly])).toEqual([["readback", true]]);
      const content = (await (await door("skills/content?name=readback")).json()) as Json;
      expect(content.skill).toMatchObject({ name: "readback", humanOnly: true, truncated: false });
      expect(content.skill.content).toContain("# Readback");
      expect((await door("skills/content?name=nope")).status).toBe(404);
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  test("7.48 and 7.49: an upload and a drawing as raw bodies, the key in the query; replayed by it; the window's refusals; a sent upload becomes an attachment", async () => {
    const { door, poll } = await world();
    const missing = await door("uploads?name=notes.txt", { raw: "hello" });
    expect([missing.status, ((await missing.json()) as Json).field]).toEqual([422, "idempotency_key"]);

    const uploaded = await door("uploads?name=notes.txt&idempotency_key=up-1", { raw: "Retry three times.\n", headers: { "Content-Type": "text/plain" } });
    expect(uploaded.status).toBe(200);
    const upload = ((await uploaded.json()) as Json).upload;
    expect(upload).toMatchObject({ name: "notes.txt", size: 19 });
    expect(upload.upload_id).toMatch(/^upl_/);
    const again = await door("uploads?name=notes.txt&idempotency_key=up-1", { raw: "Retry three times.\n" });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(((await again.json()) as Json).upload.upload_id).toBe(upload.upload_id);
    const secret = await door("uploads?name=.env&idempotency_key=up-2", { raw: "TOKEN=x" });
    expect([secret.status, ((await secret.json()) as Json).code]).toEqual([422, "upload_refused"]);

    await poll("ses-a", "claude-code");
    const sent = await door("messages", { body: { idempotency_key: "compose-up", to: { session: "ses-a" }, body: "See the notes.", uploads: [upload.upload_id] } });
    expect(sent.status).toBe(200);
    expect(((await sent.json()) as Json).message.attachments.map((x: Json) => x.name)).toEqual(["notes.txt"]);

    const drawn = await door("markups?idempotency_key=mk-1", { raw: ONE_PIXEL_PNG, headers: { "Content-Type": "image/png" } });
    expect(drawn.status).toBe(200);
    const markup = (await drawn.json()) as Json;
    expect(markup.name).toBe(`${createHash("sha256").update(ONE_PIXEL_PNG).digest("hex")}.png`);
    expect(markup.url).toBe(`/api/inbox/markups/${markup.name}`);
    const read = await door(`markups/${markup.name}`);
    expect(Buffer.from(await read.arrayBuffer()).equals(ONE_PIXEL_PNG)).toBe(true);
    expect((await door("markups?idempotency_key=mk-2", { raw: "<svg/>" })).status).toBe(422);
  });

  test("7.57: a reply carries uploads through the door unchanged: they become the reply's attachments, a replay copies nothing, a gone id is the window's 404", async () => {
    const { ledger, inbox, door } = await world();
    const { store } = inbox;
    const project = store.ensureProject({ name: "ledger", root: ledger });
    const asked = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses-a", name: null }, body: "The chart is rendered." }).message;

    const uploaded = await door("uploads?name=pasted-image-2026-10-16-0912.png&idempotency_key=paste-up-1", { raw: ONE_PIXEL_PNG, headers: { "Content-Type": "image/png" } });
    const upload = ((await uploaded.json()) as Json).upload;
    const body = { idempotency_key: "paste-reply-1", words: "This is what I see.", questions: [], uploads: [upload.upload_id] };
    const sent = await door(`messages/${asked.id}/reply`, { body });
    expect(sent.status).toBe(200);
    const reply = ((await sent.json()) as Json).reply;
    expect(reply.attachments.map((a: Json) => [a.name, a.kind])).toEqual([["pasted-image-2026-10-16-0912.png", "image"]]);
    expect(store.message(reply.id)!.attachments!.map((a) => a.id)).toEqual(reply.attachments.map((a: Json) => a.id));

    const again = await door(`messages/${asked.id}/reply`, { body });
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(((await again.json()) as Json).reply.id).toBe(reply.id);
    // The window's own replay (another key on the door, the store's key the same) copies nothing either.
    const replayed = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/messages/${asked.id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(((await replayed.json()) as Json).replayed).toBe(true);
    expect(readdirSync(join(inbox.store.dir, "uploads")).filter((name) => name.startsWith("att_"))).toHaveLength(1);

    const gone = await door(`messages/${asked.id}/reply`, { body: { ...body, idempotency_key: "paste-reply-2" } });
    expect([gone.status, ((await gone.json()) as Json).code]).toEqual([404, "upload_not_found"]);
  });

  test("a raw body past its bound is refused promptly and never buffered whole: a chunked drawing past the door's 32 MB, an upload declaring more than 100 MB; neither is recorded under its key; the window's drawing route keeps the 128 MiB request bound", async () => {
    const { base, token, door } = await world();
    // A chunked body (no Content-Length) of 1 MiB chunks, up to 400 MiB, made only as the server reads it.
    const chunk = new Uint8Array(1024 * 1024);
    let made = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (made >= 400) return controller.close();
        made += 1;
        controller.enqueue(chunk);
      },
    });
    const started = Date.now();
    const big = await door("markups?idempotency_key=big-1", { raw: endless, headers: { "Content-Type": "image/png" }, fresh: true });
    expect([big.status, ((await big.json()) as Json).code]).toEqual([413, "markup_too_large"]);
    expect(big.headers.get("connection")).toBe("close");
    expect(Date.now() - started).toBeLessThan(10_000);
    // Read up to the bound and a little past it (what was already in flight), never the 400 MiB.
    expect(made).toBeGreaterThan(32);
    expect(made).toBeLessThan(120);
    // Not recorded: the same key with a drawing that fits is applied, not answered 413 again.
    const fits = await door("markups?idempotency_key=big-1", { raw: ONE_PIXEL_PNG, headers: { "Content-Type": "image/png" }, fresh: true });
    expect([fits.status, fits.headers.get("idempotent-replayed")]).toEqual([200, null]);
    // The window's own markup route keeps its ceiling (the request bound, 128 MiB): a 40 MB full-size drawing is kept.
    const fullSize = new Uint8Array(40 * 1024 * 1024);
    fullSize.set(ONE_PIXEL_PNG);
    const windowBig = await fetch(`${base}/api/inbox/markups`, { method: "POST", body: fullSize, keepalive: false });
    expect(windowBig.status).toBe(200);
    expect(((await windowBig.json()) as Json).name).toBe(`${createHash("sha256").update(fullSize).digest("hex")}.png`);
    // The same 40 MB through the door is past the phone's 32 MB.
    const doorBig = await door("markups?idempotency_key=big-3", { raw: fullSize, headers: { "Content-Type": "image/png" }, fresh: true });
    expect([doorBig.status, ((await doorBig.json()) as Json).code]).toEqual([413, "markup_too_large"]);

    // An upload that declares 110 MB (past the 100 MB bound, under Bun's 128 MiB request bound): refused from its headers.
    const port = Number(new URL(base).port);
    /** A POST that declares `length` bytes and sends 64 KiB of them, over a raw socket: the answer, as text. */
    const declare = (path: string, length: number, headers: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        let data = "";
        const done = () => resolve(data);
        const timer = setTimeout(() => {
          socket.destroy();
          done();
        }, 5_000);
        socket.on("data", (d) => {
          data += d.toString("latin1");
          // The whole answer is here (headers and the Content-Length body): stop sending. Bun reads and drops the rest of a body
          // the handler stopped reading, so it does not close the socket itself.
          const head = data.indexOf("\r\n\r\n");
          const answered = /content-length: (\d+)/i.exec(data);
          if (head >= 0 && (answered ? data.length - head - 4 >= Number(answered[1]) : true)) {
            clearTimeout(timer);
            socket.destroy();
            done();
          }
        });
        socket.on("close", () => {
          clearTimeout(timer);
          done();
        });
        socket.on("error", reject);
        socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headers}Content-Length: ${length}\r\n\r\n`);
        socket.write(Buffer.alloc(64 * 1024));
      });
    // An upload that declares 110 MB (past the 100 MB bound, under the 128 MiB request bound): refused by the door from its headers.
    const answer = await declare("/api/inbox/device/uploads?name=big.bin&idempotency_key=big-2", 110 * 1024 * 1024, `Authorization: Bearer ${token}\r\nContent-Type: application/octet-stream\r\n`);
    expect(answer).toMatch(/^HTTP\/1\.1 413/);
    expect(answer).toContain('"code":"upload_too_large"');
    expect(answer.toLowerCase()).toContain("connection: close");
    // The window's drawing route: past the request bound (128 MiB) it is refused too.
    const windowOver = await declare("/api/inbox/markups", 129 * 1024 * 1024, "Content-Type: image/png\r\n");
    expect(windowOver).toMatch(/^HTTP\/1\.1 413/);
  });

  test("a raw upload over the tailnet's door listener, replayed by its key through the window port's door", async () => {
    const serve = new Map<number, string>();
    const tailscale: TailscaleRunner = (args) => {
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (args[1] === "status") {
        if (serve.size === 0) return ok("{}");
        const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
        const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`macbook-pro.tail0000.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
        return ok(JSON.stringify({ TCP, Web }));
      }
      const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
      if (args.includes("off")) {
        serve.delete(httpsPort);
        return ok();
      }
      serve.set(httpsPort, args.at(-1)!);
      return ok(`Available within your tailnet:\n\nhttps://macbook-pro.tail0000.ts.net:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
    };
    const { base, door } = await world({ tailscale });
    const on = await fetch(`${base}/api/inbox/tailnet`, { method: "POST", body: JSON.stringify({ on: true }) });
    expect(((await on.json()) as Json).tailnet.on).toBe(true);
    const tailnetDoor = serve.get(8443)!;
    const bytes = new Uint8Array(3 * 1024 * 1024).fill(97);
    const viaTailnet = await door("uploads?name=big.txt&idempotency_key=tail-1", {
      raw: bytes,
      doorBase: tailnetDoor,
      headers: { Host: "macbook-pro.tail0000.ts.net:8443", "Content-Type": "application/octet-stream" },
    });
    expect(viaTailnet.status).toBe(200);
    const upload = ((await viaTailnet.json()) as Json).upload;
    expect(upload.size).toBe(bytes.length);
    const viaLoopback = await door("uploads?name=big.txt&idempotency_key=tail-1", { raw: bytes });
    expect(viaLoopback.headers.get("idempotent-replayed")).toBe("true");
    // The 3 MB it sent again is read and dropped only up to 1 MiB; then the connection closes after the answer.
    expect(viaLoopback.headers.get("connection")).toBe("close");
    expect(((await viaLoopback.json()) as Json).upload.upload_id).toBe(upload.upload_id);
    // A large file the window refuses before reading it still gets its answer (the door reads the rest and drops it).
    const refused = await door("uploads?name=.env&idempotency_key=tail-2", { raw: bytes, doorBase: tailnetDoor, headers: { Host: "macbook-pro.tail0000.ts.net:8443" } });
    expect([refused.status, ((await refused.json()) as Json).code]).toEqual([422, "upload_refused"]);
    await fetch(`${base}/api/inbox/tailnet`, { method: "POST", body: JSON.stringify({ on: false }) });
  });

  test("through the relay (asDevice): uploads and drawings are refused before the window runs; the other new rows are carried with their query", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-inbox-devices-relay-parity-"));
    roots.push(dataDir);
    const asked: string[] = [];
    const phones = createInboxDevices({
      dataDir,
      serverSession: "0".repeat(32),
      port: () => 1,
      registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      dispatch: async (req) => {
        const url = new URL(req.url);
        asked.push(`${req.method} ${url.pathname}${url.search}`);
        return Response.json({ ok: true });
      },
    });
    const made = (await (await phones.windowRoute(new Request("http://127.0.0.1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1/api/inbox/pairing")))!.json()) as Json;
    const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
    const paired = (await (await phones.door(new Request(pairUrl, { method: "POST", body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) }), pairUrl)).json()) as Json;
    const id = paired.device.id as string;
    for (const path of ["/api/inbox/device/uploads?name=a.txt&idempotency_key=r-1", "/api/inbox/device/markups?idempotency_key=r-2"]) {
      const refused = await phones.asDevice(id, { method: "POST", path, body: { idempotency_key: "r-x" } });
      expect([path, refused.status, ((await refused.json()) as Json).code]).toEqual([path, 413, "relay_upload_unavailable"]);
    }
    expect(asked).toEqual([]);
    const carried: [string, string, Json?][] = [
      ["GET", "/api/inbox/device/sessions?session=ses-a"],
      ["POST", "/api/inbox/device/messages", { idempotency_key: "c-1", to: { session: "ses-a" }, body: "Hi" }],
      ["POST", "/api/inbox/device/messages/msg_x/to", { idempotency_key: "c-2", to: { session: "ses-b" } }],
      ["GET", "/api/inbox/device/search?q=retry&status=waiting"],
      ["POST", "/api/inbox/device/projects/prj_x/read", { idempotency_key: "c-3" }],
      ["POST", "/api/inbox/device/projects/prj_x/unread", { idempotency_key: "c-4", threads: [] }],
      ["POST", "/api/inbox/device/projects/prj_x/resolve", { idempotency_key: "c-5" }],
      ["GET", "/api/inbox/device/skills"],
      ["GET", "/api/inbox/device/skills/content?name=readback"],
      ["POST", "/api/inbox/device/messages/msg_x/guide/annotations", { idempotency_key: "c-6", annotation: {} }],
    ];
    for (const [method, path, body] of carried) expect([path, (await phones.asDevice(id, { method, path, body })).status]).toEqual([path, 200]);
    expect(asked).toEqual([
      "GET /api/inbox/sessions?session=ses-a",
      "POST /api/inbox/messages",
      "POST /api/inbox/messages/msg_x/to",
      "GET /api/inbox/search?q=retry&status=waiting",
      "POST /api/inbox/projects/prj_x/read",
      "POST /api/inbox/projects/prj_x/unread",
      "POST /api/inbox/projects/prj_x/resolve",
      "GET /api/inbox/skills",
      "GET /api/inbox/skills/content?name=readback",
      "POST /api/inbox/messages/msg_x/guide/annotations",
    ]);
  });
});
