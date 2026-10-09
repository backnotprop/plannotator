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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  stubBuiltHtml,
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
    if (w) destroyInboxWorld(w);
    for (const path of stubs) rmSync(path, { force: true });
  });

  test("7.1: the window makes an offer, with the QR link, the six digits, the computer and its addresses", async () => {
    const before = Date.now();
    const made = await offer();
    expect(Object.keys(made).sort()).toEqual(["addresses", "computer", "link", "offer"]);
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
      ["GET", "events"],
      ["POST", `messages/${threadId}/picks`],
      ["POST", `messages/${threadId}/reply`],
      ["POST", `messages/${threadId}/resolve`],
      ["POST", `threads/${threadId}/delete`],
      ["GET", `threads/${threadId}/attachments`],
      ["GET", "attachments/att_x/view"],
      ["GET", "html-assets/0000000000000001/sun.png"],
      ["POST", "annotations"],
      ["POST", "annotations/ann-1/remove"],
      ["GET", `messages/${threadId}/guide`],
      ["POST", `messages/${threadId}/guide/reviewed`],
      ["POST", `messages/${threadId}/decision`],
      ["GET", "decisions"],
      ["GET", `threads/${threadId}/sessions`],
      ["POST", `threads/${threadId}/message`],
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
    expect(Object.keys(h).sort()).toEqual(["app", "ok", "pid", "serverSession", "update", "version"]);
    expect(h).toMatchObject({ ok: true, app: "plannotator-inbox", serverSession });
    expect(await (await door("health", { token: null })).json()).toEqual({ error: "This request needs the phone's token.", code: "device_token_missing" });
  });

  test("what the door never answers: settings, restart, /mcp, the bridge, control, raw bytes, project delete, decision retire, pairing, the device list", async () => {
    for (const [method, path] of [
      ["GET", "settings"],
      ["POST", "restart"],
      ["POST", "mcp"],
      ["POST", "bridge/poll"],
      ["POST", "control/stop"],
      ["GET", "attachments/att_x"],
      ["POST", "projects/prj_x/delete"],
      ["POST", "decisions/dec_x/retire"],
      ["POST", "decisions/dec_x/replace"],
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
    expect(Object.keys(list).sort()).toEqual(["cursor", "decisions_waiting", "notice", "project", "projects", "sections", "serverSession", "update", "version"]);
    expect(list.sections.map((s: Json) => s.id)).toEqual(["stopped", "holding", "waiting", "sent", "new", "quiet"]);
    const row = list.sections.flatMap((s: Json) => s.threads).find((t: Json) => t.thread_id === threadId);
    expect(row).toMatchObject({ section: "waiting", unread: true, questions: { open: 2 } });
    const filtered = (await (await door(`threads?project=${row.project_id}`)).json()) as Json;
    expect(filtered.project).toBe(row.project_id);

    const projects = (await (await door("projects")).json()) as Json;
    expect(Object.keys(projects).sort()).toEqual(["cursor", "projects", "serverSession"]);
    expect(Object.keys(projects.projects[0]).sort()).toEqual(["created_at", "id", "key", "name", "root", "threads", "unread"]);

    const thread = (await (await door(`threads/${threadId}`)).json()) as Json;
    expect(Object.keys(thread).sort()).toEqual(["cursor", "decisions", "serverSession", "thread"]);
    expect(thread.thread.messages[0].questions).toHaveLength(2);
    expect(thread.thread.messages[0].questions[0]).toMatchObject({ kind: "single", state: "open", revision: 0, recommendation: "Yes" });

    const noKey = await door(`threads/${threadId}/seen`, { body: {} });
    expect(noKey.status).toBe(422);
    expect(await noKey.json()).toEqual({ error: "idempotency_key: required on a phone's command.", code: "validation_error", field: "idempotency_key" });
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
    expect(Object.keys(sent).sort()).toEqual(["decisions", "decisions_refused", "message_id", "questions", "replayed", "reply"]);
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
    expect(Object.keys(listed).sort()).toEqual(["annotations", "attachments", "serverSession"]);
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

  test("7.19 to 7.24: the guide and a tick, the decision switch, decisions, live sessions, New message", async () => {
    const guide = await door(`messages/${guideMessage}/guide`);
    expect(guide.status).toBe(200);
    const g = (await guide.json()) as Json;
    expect(Object.keys(g).sort()).toEqual(["guide", "message_id", "snapshot"]);
    expect(g.guide.title).toBe("Token refresh");
    const tick = await door(`messages/${guideMessage}/guide/reviewed`, { body: { idempotency_key: keys(), reviewed: [true] } });
    expect(await tick.json()).toEqual({ message_id: guideMessage, reviewed: [true] });
    expect((await door(`messages/${threadId}/guide`)).status).toBe(404);

    const thread = (await (await door(`threads/${threadId}`)).json()) as Json;
    const open = thread.thread.messages[0].questions[1];
    const decision = await door(`messages/${threadId}/decision`, {
      body: { idempotency_key: keys(), key: open.key, recording: true, draft: { text: "Ship behind a flag.", reason: null } },
    });
    expect(decision.status).toBe(200);
    expect(((await decision.json()) as Json).question).toMatchObject({ key: open.key, decision_recording: true, decision_draft: { text: "Ship behind a flag.", reason: null } });
    const decisions = (await (await door(`decisions?project=${thread.thread.project.id}`)).json()) as Json;
    expect(Object.keys(decisions).sort()).toEqual(["cursor", "decisions", "project_id", "serverSession", "waiting"]);
    expect(decisions.waiting.map((d: Json) => d.prompt)).toContain("Ship it behind a flag?");

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

  test("7.12 and 7.13: resolve, then delete the thread", async () => {
    const resolved = await door(`messages/${threadId}/resolve`, { body: { idempotency_key: keys(), resolved: true } });
    expect(((await resolved.json()) as Json).thread.resolved_at).toBeTruthy();
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
    stopInbox(w);
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
});
