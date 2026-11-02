/**
 * Voice dictation's server (approval "inbox-voice") on a real Inbox, with a fake `codex` on a scratch PATH
 * (tests/helpers/fake-codex-app-server.ts) and both OpenAI endpoints faked on loopback. No real Codex, no real
 * `~/.codex`, no call to OpenAI.
 *
 * What regresses: Codex started while voice is off, a token or key reaching a page or a log, a browser disguise, any
 * retry past the one token refresh, a 403 retried, a key accepted on a plain-http path or from a guest, audio forwarded
 * to a linked machine, the announcement shown to the wrong computer or twice, Codex left running.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorRouteNames } from "./inbox-devices";
import { doorWriteKind } from "./inbox-outbox";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { startInboxServer, type InboxServer } from "./inbox";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { INBOX_VOICE_MAX_CLIP_BYTES } from "@plannotator/core/inbox-types";
import { installFakeCodex, type FakeCodex, type FakeCodexState } from "../../tests/helpers/fake-codex-app-server";

const FIRST_TOKEN = "tok-first-secret-value";
const FRESH_TOKEN = "tok-fresh-secret-value";
const KEY = "sk-test-key-never-shown-4f2a";
const CHATGPT: FakeCodexState = { account: { type: "chatgpt", email: "someone@example.com", planType: "pro" }, authMethod: "chatgpt", token: FIRST_TOKEN, refreshedToken: FRESH_TOKEN };
const MAGIC = "macbook-pro.tail0000.ts.net";
const OWNER = "ramos@example.com";

const roots: string[] = [];
const servers: InboxServer[] = [];
const upstreams: { stop(force?: boolean): unknown }[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const upstream of upstreams.splice(0)) upstream.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

/** A minimal 24 kHz mono WAV. */
function wav(samples = 240): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(44 + samples * 2));
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

interface Seen {
  headers: Headers;
  form: FormData;
}

/** A fake endpoint: answers each request with the next of `answers` (the last repeats), and keeps what it was sent. */
function fakeEndpoint(answers: (() => Response | Promise<Response>)[]) {
  const seen: Seen[] = [];
  let next = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      seen.push({ headers: req.headers, form: await req.formData() });
      const answer = answers[Math.min(next++, answers.length - 1)]!;
      return answer();
    },
  });
  upstreams.push(server);
  return { url: `http://127.0.0.1:${server.port}/`, seen };
}

const ok = (text: string) => () => Response.json({ text, asset_pointer: "x", asset_ttl: 1 });

interface WorldOptions {
  version?: string;
  usedBefore?: boolean;
  codex?: FakeCodexState | null;
  chatgpt?: ReturnType<typeof fakeEndpoint>;
  openai?: ReturnType<typeof fakeEndpoint>;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
  tailnet?: boolean;
}

async function world(options: WorldOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-voice-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home);
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const config = { ...(options.usedBefore ? { inboxNotifications: { dismissed: true }, inboxSound: { dialogShownFor: "0.1.0" }, inboxListIntro: { shownAt: "2026-10-01T00:00:00.000Z" } } : {}), ...options.config };
  if (Object.keys(config).length > 0) writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  const codex = options.codex === null ? null : installFakeCodex(root, options.codex ?? CHATGPT);
  const environment = createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: codex ? `${codex.bin}:/usr/bin:/bin` : "/nowhere", ...options.env } });
  const serve = new Map<number, string>();
  const run: TailscaleRunner = (args) => {
    const done = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return done(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
    if (args[1] === "status") {
      if (serve.size === 0) return done("{}");
      return done(
        JSON.stringify({
          TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
          Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
        }),
      );
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return done(`https://${MAGIC}:${httpsPort}/\n`);
  };
  const server = await startInboxServer({
    dataDir,
    binaryPath: null,
    phones: false,
    version: options.version ?? "dev",
    agentEnvironment: environment,
    voice: { chatgptUrl: options.chatgpt?.url ?? "http://127.0.0.1:9/never", openaiUrl: options.openai?.url ?? "http://127.0.0.1:9/never", extraClis: [] },
    ...(options.tailnet ? { tailscale: run, publishTailnet: true } : {}),
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const session = server.serverSession;
  const json = (path: string, body: Record<string, unknown>) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: session, ...body }) });
  const settings = async () => (await (await fetch(`${base}/api/inbox/settings`)).json()) as { voice: Record<string, unknown> & { key: { source: string | null; last4: string | null } } };
  const turnOn = async (voice: Record<string, unknown> = {}) => expect((await json("/api/inbox/settings", { voice: { on: true, ...voice } })).status).toBe(200);
  const transcribe = (clip: Uint8Array<ArrayBuffer> = wav(), init: RequestInit = {}) =>
    fetch(`${base}/api/inbox/voice/transcribe?serverSession=${session}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: clip, ...init });
  const status = async (query = "") => (await (await fetch(`${base}/api/inbox/voice/status${query}`)).json()) as { state: string; plan: string | null };
  const saved = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as { inboxVoice?: unknown; inboxVoiceIntro?: { dueAt?: string; shownAt?: string } };
  return { root, dataDir, codex: codex as FakeCodex, server, base, session, json, settings, turnOn, transcribe, status, saved };
}

const body = async (response: Response) => (await response.json()) as { text?: string; code?: string; reason?: string; engine?: string };

/** Codex's stop is a signal away: wait for its last log line. */
async function codexStopped(codex: FakeCodex) {
  for (let i = 0; i < 100 && !codex.allStopped(); i++) await Bun.sleep(20);
  expect(codex.allStopped()).toBe(true);
}

describe("off", () => {
  test("is the default, starts no Codex, and transcribes nothing", async () => {
    const w = await world();
    expect((await w.settings()).voice).toMatchObject({ on: false, phones_only: false, engine: "codex" });
    expect(await w.status()).toEqual({ state: "off", plan: null });
    const refused = await w.transcribe();
    expect(refused.status).toBe(409);
    expect((await body(refused)).code).toBe("voice_off");
    expect(w.codex.starts()).toBe(0);
  });

  test("a save that didn't reach config.json says so", async () => {
    const w = await world();
    // Not valid JSON: never written over.
    writeFileSync(join(w.dataDir, "config.json"), "{ broken");
    const answer = await w.json("/api/inbox/settings", { voice: { on: true } });
    expect(answer.status).toBe(500);
    expect((await body(answer)).code).toBe("config_not_saved");
  });

  test("settings refuse anything but the three fields, and save nothing", async () => {
    const w = await world();
    expect((await w.json("/api/inbox/settings", { voice: { on: "yes" } })).status).toBe(422);
    expect((await w.json("/api/inbox/settings", { voice: { engine: "whisper" } })).status).toBe(422);
    expect((await w.json("/api/inbox/settings", { voice: { key: KEY } })).status).toBe(422);
    expect((await w.settings()).voice.on).toBe(false);
  });
});

describe("through Codex's ChatGPT login", () => {
  test("posts the same WAV with the token and an honest identity, returns only the words, stops Codex", async () => {
    const chatgpt = fakeEndpoint([ok("  Rename the build step.  ")]);
    const w = await world({ chatgpt });
    await w.turnOn();
    const clip = wav();
    const response = await w.transcribe(clip);
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ text: "Rename the build step." });
    expect(raw).not.toContain("tok-");

    expect(chatgpt.seen).toHaveLength(1);
    const sent = chatgpt.seen[0]!;
    expect(sent.headers.get("authorization")).toBe(`Bearer ${FIRST_TOKEN}`);
    // Decided by the owner: never a browser's identity.
    expect(sent.headers.get("user-agent")).toMatch(/^Plannotator\//);
    for (const header of ["cookie", "origin", "referer", "sec-ch-ua", "sec-fetch-site"]) expect(sent.headers.get(header)).toBeNull();
    const file = sent.form.get("file") as File;
    expect(file.name).toBe("voice.wav");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(clip);

    const start = w.codex.calls().find((call) => call.event === "start");
    expect(start).toMatchObject({ marker: "1" });
    expect(start?.event === "start" && start.argv).toContain("app-server");
    expect(start?.event === "start" && start.argv.join(" ")).toContain("mcp_servers.plannotator-inbox");
    await codexStopped(w.codex);
  });

  test("a 401: one token refresh, the same clip again, and the words", async () => {
    const chatgpt = fakeEndpoint([() => new Response("no", { status: 401 }), ok("Second time.")]);
    const w = await world({ chatgpt });
    await w.turnOn();
    expect(await body(await w.transcribe())).toEqual({ text: "Second time." });
    expect(chatgpt.seen.map((s) => s.headers.get("authorization"))).toEqual([`Bearer ${FIRST_TOKEN}`, `Bearer ${FRESH_TOKEN}`]);
    expect(w.codex.calls().filter((call) => call.event === "call" && call.method === "getAuthStatus").map((call) => call.event === "call" && call.params.refreshToken)).toEqual([false, true]);
  });

  test("a 401 after the refresh is an expired login, and stops there", async () => {
    const chatgpt = fakeEndpoint([() => new Response("no", { status: 401 })]);
    const w = await world({ chatgpt });
    await w.turnOn();
    const response = await w.transcribe();
    expect((await body(response)).code).toBe("voice_expired");
    expect(chatgpt.seen).toHaveLength(2);
    await codexStopped(w.codex);
  });

  test("a 401 with no token after the refresh is an expired login, with no second post", async () => {
    const chatgpt = fakeEndpoint([() => new Response("no", { status: 401 })]);
    const w = await world({ chatgpt, codex: { ...CHATGPT, refreshedToken: null } });
    await w.turnOn();
    expect((await body(await w.transcribe())).code).toBe("voice_expired");
    expect(chatgpt.seen).toHaveLength(1);
  });

  test.each([
    ["a 403", () => new Response("<html>Just a moment</html>", { status: 403, headers: { "Content-Type": "text/html" } })],
    ["a challenge marked by Cloudflare on a 200", () => new Response("<html></html>", { status: 200, headers: { "cf-mitigated": "challenge", "Content-Type": "text/html" } })],
    ["a 200 that is a page, not JSON", () => new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } })],
    ["a 429", () => new Response("{}", { status: 429, headers: { "Content-Type": "application/json" } })],
    ["a 401 marked by Cloudflare", () => new Response("<html></html>", { status: 401, headers: { "cf-mitigated": "challenge", "Content-Type": "text/html" } })],
    ["a redirect", () => new Response("", { status: 302, headers: { Location: "https://example.com/" } })],
  ])("%s is refused once, with no retry and no refresh", async (_name, answer) => {
    const chatgpt = fakeEndpoint([answer]);
    const w = await world({ chatgpt });
    await w.turnOn();
    const response = await w.transcribe();
    expect(response.status).toBe(502);
    expect((await body(response)).code).toBe("voice_refused");
    expect(chatgpt.seen).toHaveLength(1);
    expect(w.codex.methods()).toEqual(["getAuthStatus"]);
    await codexStopped(w.codex);
  });

  test("no answer at all, or a server error, is a network failure the window can retry", async () => {
    const gone = await world();
    await gone.turnOn();
    expect((await body(await gone.transcribe())).code).toBe("voice_unreachable");
    await codexStopped(gone.codex);
    const chatgpt = fakeEndpoint([() => new Response("oops", { status: 503 })]);
    const failing = await world({ chatgpt });
    await failing.turnOn();
    expect((await body(await failing.transcribe())).code).toBe("voice_unreachable");
    expect(chatgpt.seen).toHaveLength(1);
  });

  test("empty words are said, not inserted", async () => {
    const w = await world({ chatgpt: fakeEndpoint([ok("   ")]) });
    await w.turnOn();
    expect((await body(await w.transcribe())).code).toBe("voice_empty");
  });

  test.each([
    ["no Codex on this computer", null, "missing"],
    ["no sign-in", { authMethod: null, token: null }, "signedout"],
    ["an API key login", { authMethod: "apikey", token: "sk-a-key-not-a-chatgpt-token" }, "apikey"],
    ["another login", { authMethod: "amazonBedrock", token: "x" }, "other"],
  ] as const)("%s: not ready, nothing posted", async (_name, codex, reason) => {
    const chatgpt = fakeEndpoint([ok("never")]);
    const w = await world({ chatgpt, codex });
    await w.turnOn();
    const answer = await body(await w.transcribe());
    expect(answer).toMatchObject({ code: "voice_not_ready", reason, engine: "codex" });
    expect(chatgpt.seen).toHaveLength(0);
  });

  test("Codex that cannot answer is said as such, and is stopped", async () => {
    const chatgpt = fakeEndpoint([ok("never")]);
    const w = await world({ chatgpt, codex: { ...CHATGPT, failMethod: "getAuthStatus" } });
    await w.turnOn();
    expect((await body(await w.transcribe())).code).toBe("voice_codex_failed");
    expect(chatgpt.seen).toHaveLength(0);
    await codexStopped(w.codex);
  });

  test("a page that gives up stops the post and stops Codex", async () => {
    let posted: () => void;
    const reached = new Promise<void>((resolve) => (posted = resolve));
    const chatgpt = fakeEndpoint([
      () => {
        posted();
        return new Promise<Response>(() => {});
      },
    ]);
    const w = await world({ chatgpt });
    await w.turnOn();
    const leave = new AbortController();
    const attempt = w.transcribe(wav(), { signal: leave.signal }).catch(() => null);
    await reached;
    leave.abort();
    await attempt;
    await codexStopped(w.codex);
  });

  test("a clip that is not a WAV, or not typed as one, never reaches Codex", async () => {
    const w = await world();
    await w.turnOn();
    const notWav = new Uint8Array(new ArrayBuffer(100));
    expect((await body(await w.transcribe(notWav))).code).toBe("voice_bad_clip");
    expect((await body(await w.transcribe(wav(), { headers: { "Content-Type": "text/plain", Connection: "close" } }))).code).toBe("voice_bad_clip");
    expect(w.codex.starts()).toBe(0);
  });

  test("a clip past the limit is refused without being read, whatever its length header says", async () => {
    const w = await world();
    await w.turnOn();
    const stream = () =>
      new ReadableStream({
        start(controller) {
          for (let sent = 0; sent <= INBOX_VOICE_MAX_CLIP_BYTES; sent += 1 << 20) controller.enqueue(new Uint8Array(1 << 20));
          controller.close();
        },
      });
    const sent = await w.transcribe(undefined, { body: stream(), headers: { "Content-Type": "audio/wav", Connection: "close" } });
    expect((await body(sent)).code).toBe("voice_bad_clip");
    expect(w.codex.starts()).toBe(0);
  });

  test("a clip from another server session is refused", async () => {
    const w = await world();
    await w.turnOn();
    const response = await fetch(`${w.base}/api/inbox/voice/transcribe?serverSession=other`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav() });
    expect(response.status).toBe(409);
    expect(w.codex.starts()).toBe(0);
  });
});

describe("the status Settings and the mic read", () => {
  test("a `codex` that floods stdout with no newline answers unknown, promptly, and the Inbox stays up", async () => {
    const w = await world();
    await w.turnOn();
    writeFileSync(join(w.codex.bin, "codex"), "#!/bin/sh\nexec tr -d '\\n' < /dev/zero\n");
    const began = Date.now();
    const answer = await w.status("?fresh=1");
    expect(answer.state).toBe("unknown");
    expect(Date.now() - began).toBeLessThan(5_000);
    expect((await fetch(`${w.base}/api/inbox/health`)).status).toBe(200);
  }, 15_000);

  test("comes from account/read: the type and the plan, never a token or the email, and never getAuthStatus", async () => {
    const w = await world();
    await w.turnOn();
    const response = await fetch(`${w.base}/api/inbox/voice/status`);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ state: "ready", plan: "pro" });
    expect(raw).not.toContain("example.com");
    expect(w.codex.methods()).toEqual(["account/read"]);
    await codexStopped(w.codex);
  });

  test.each([
    ["signedout", { account: null }],
    ["apikey", { account: { type: "apiKey" } }],
    ["other", { account: { type: "amazonBedrock" } }],
    ["unknown", { failMethod: "account/read" }],
    ["unknown", { crash: true }],
  ])("%s", async (state, codex) => {
    const w = await world({ codex });
    await w.turnOn();
    expect((await w.status()).state).toBe(state);
    await codexStopped(w.codex);
  });

  test("no Codex: missing, nothing started", async () => {
    const w = await world({ codex: null });
    await w.turnOn();
    expect((await w.status()).state).toBe("missing");
  });

  test("Settings and the mic share one read; Check again asks afresh", async () => {
    const w = await world({ codex: { account: null } });
    await w.turnOn();
    expect((await w.status()).state).toBe("signedout");
    w.codex.set(CHATGPT);
    expect((await w.status()).state).toBe("signedout");
    expect(w.codex.starts()).toBe(1);
    expect((await w.status("?fresh=1")).state).toBe("ready");
    expect(w.codex.starts()).toBe(2);
  });

  test("another site cannot start a Codex with a read", async () => {
    const w = await world();
    await w.turnOn();
    const response = await fetch(`${w.base}/api/inbox/voice/status`, { headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" } });
    expect(response.status).toBe(403);
    expect(w.codex.starts()).toBe(0);
  });
});

describe("the OpenAI API key", () => {
  test("a pasted key: a private file, the last 4 to a page, the key itself nowhere", async () => {
    const openai = fakeEndpoint([ok("By key.")]);
    const w = await world({ openai });
    await w.turnOn({ engine: "api" });
    expect((await w.status()).state).toBe("nokey");
    const saved = await w.json("/api/inbox/voice/key", { key: `  ${KEY}\n` });
    const raw = await saved.text();
    expect(JSON.parse(raw)).toEqual({ key: { source: "saved", last4: "4f2a" } });
    expect(raw).not.toContain(KEY);

    const path = join(w.dataDir, "inbox", "voice-key");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim()).toBe(KEY);
    const settings = JSON.stringify(await w.settings());
    expect(settings).not.toContain(KEY);
    expect((await w.settings()).voice.key).toEqual({ source: "saved", last4: "4f2a" });
    expect(readFileSync(join(w.dataDir, "config.json"), "utf8")).not.toContain(KEY);

    expect((await w.status()).state).toBe("ready");
    expect(await body(await w.transcribe())).toEqual({ text: "By key." });
    const sent = openai.seen[0]!;
    expect(sent.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(sent.form.get("model")).toBe("gpt-transcribe");
    expect(sent.form.get("file")).toBeInstanceOf(File);
    expect(w.codex.starts()).toBe(0);

    expect(await (await w.json("/api/inbox/voice/key", { key: null })).json()).toEqual({ key: { source: null, last4: null } });
    expect(existsSync(path)).toBe(false);
  });

  test("a saved key wins over OPENAI_API_KEY; with none saved the env key works and shows no digits", async () => {
    const openai = fakeEndpoint([ok("Heard.")]);
    const w = await world({ openai, env: { OPENAI_API_KEY: "sk-from-the-environment" } });
    await w.turnOn({ engine: "api" });
    expect((await w.settings()).voice.key).toEqual({ source: "env", last4: null });
    await w.transcribe();
    await w.json("/api/inbox/voice/key", { key: KEY });
    await w.transcribe();
    expect(openai.seen.map((s) => s.headers.get("authorization"))).toEqual(["Bearer sk-from-the-environment", `Bearer ${KEY}`]);
  });

  test("something that is not a key is refused and not saved", async () => {
    const w = await world();
    for (const key of ["short", "two words in a key", 7]) {
      expect((await w.json("/api/inbox/voice/key", { key })).status).toBe(422);
    }
    expect(existsSync(join(w.dataDir, "inbox", "voice-key"))).toBe(false);
  });

  test.each([
    ["a 401", 401, "voice_key_refused", 1],
    ["a 403", 403, "voice_key_refused", 1],
    ["a 429", 429, "voice_refused", 1],
    ["a 500", 500, "voice_unreachable", 1],
  ] as const)("%s", async (_name, status, code, posts) => {
    const openai = fakeEndpoint([() => Response.json({ error: { message: KEY } }, { status })]);
    const w = await world({ openai });
    await w.turnOn({ engine: "api" });
    await w.json("/api/inbox/voice/key", { key: KEY });
    const response = await w.transcribe();
    const raw = await response.text();
    expect(JSON.parse(raw)).toMatchObject({ code, engine: "api" });
    // Upstream's words never come back.
    expect(raw).not.toContain(KEY);
    expect(openai.seen).toHaveLength(posts);
  });

  test("no key: not ready, nothing posted", async () => {
    const openai = fakeEndpoint([ok("never")]);
    const w = await world({ openai });
    await w.turnOn({ engine: "api" });
    expect(await body(await w.transcribe())).toMatchObject({ code: "voice_not_ready", reason: "nokey" });
    expect(openai.seen).toHaveLength(0);
  });
});

describe("over the tailnet", () => {
  async function tailnetWorld(options: WorldOptions = {}) {
    const w = await world({ ...options, tailnet: true });
    const listener = w.server.tailscale.listenerPort()!;
    const own = { Host: `${MAGIC}:${w.server.port}`, "Tailscale-User-Login": OWNER, Origin: `https://${MAGIC}:${w.server.port}` };
    const through = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${listener}${path}`, { ...init, headers: { ...own, ...init.headers } });
    return { ...w, through };
  }

  const postKey = (w: Awaited<ReturnType<typeof tailnetWorld>>, key: unknown, headers: Record<string, string>) =>
    w.through("/api/inbox/voice/key", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: w.session, key }) });

  test("the owner's key over the tailnet's HTTPS: a private file, the last 4 back", async () => {
    const w = await tailnetWorld();
    const saved = await postKey(w, KEY, { "X-Forwarded-Proto": "https" });
    const raw = await saved.text();
    expect(JSON.parse(raw)).toEqual({ key: { source: "saved", last4: "4f2a" } });
    expect(raw).not.toContain(KEY);
    const path = join(w.dataDir, "inbox", "voice-key");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await w.settings()).voice.key).toEqual({ source: "saved", last4: "4f2a" });
    expect(await (await postKey(w, null, { "X-Forwarded-Proto": "https" })).json()).toEqual({ key: { source: null, last4: null } });
    expect(existsSync(path)).toBe(false);
  });

  test.each([
    ["no scheme from serve: a mapping that isn't TLS", {}],
    ["http named outright", { "X-Forwarded-Proto": "http" }],
  ])("a plain-http path is refused before the key is read: %s", async (_name, headers: Record<string, string>) => {
    const w = await tailnetWorld();
    const response = await postKey(w, KEY, headers);
    expect(response.status).toBe(403);
    expect((await body(response)).code).toBe("https_required");
    expect(existsSync(join(w.dataDir, "inbox", "voice-key"))).toBe(false);
  });

  test("the key is never logged: not when saved, refused, malformed or over plain http, in no stream and no file but its own", async () => {
    const w = await tailnetWorld();
    const written: string[] = [];
    const keep = (...parts: unknown[]) => void written.push(parts.map((part) => (typeof part === "string" ? part : part instanceof Uint8Array ? new TextDecoder().decode(part) : JSON.stringify(part))).join(" "));
    const streams = (["stdout", "stderr"] as const).map((name) => spyOn(process[name], "write").mockImplementation(((chunk: unknown) => (keep(chunk), true)) as never));
    const consoles = (["log", "info", "warn", "error", "debug"] as const).map((name) => spyOn(console, name).mockImplementation(keep));
    try {
      await postKey(w, `two words ${KEY}`, { "X-Forwarded-Proto": "https" });
      await postKey(w, KEY, {});
      await w.through("/api/inbox/voice/key", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" }, body: `{"serverSession":"${w.session}","key":"${KEY}` });
      await w.through("/api/inbox/voice/key", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" }, body: JSON.stringify({ serverSession: "0".repeat(32), key: KEY }) });
      expect((await postKey(w, KEY, { "X-Forwarded-Proto": "https" })).status).toBe(200);
    } finally {
      for (const spy of [...streams, ...consoles]) spy.mockRestore();
    }
    expect(written.join("\n")).not.toContain(KEY);
    const files = readdirSync(w.dataDir, { recursive: true, encoding: "utf8" }).map((file) => join(w.dataDir, file)).filter((file) => statSync(file).isFile());
    expect(files.filter((file) => readFileSync(file).includes(KEY))).toEqual([join(w.dataDir, "inbox", "voice-key")]);
  });

  test("a phone's clip goes to its Inbox, which transcribes: words back, no token, and the computer named", async () => {
    const chatgpt = fakeEndpoint([ok("From the phone.")]);
    const w = await tailnetWorld({ chatgpt });
    await w.turnOn();
    const response = await w.through(`/api/inbox/voice/transcribe?serverSession=${w.session}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav() });
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ text: "From the phone." });
    expect(raw).not.toContain("tok-");
    const settings = (await (await w.through("/api/inbox/settings")).json()) as { voice: { computer: string | null } };
    expect(settings.voice.computer).toBeTruthy();
    expect((await w.settings()).voice.computer).toBeNull();
  });

  test("the announcement is never claimed from there", async () => {
    const w = await tailnetWorld({ version: "0.30.0", usedBefore: true });
    const response = await w.through("/api/inbox/voice/intro", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: w.session }) });
    expect(await response.json()).toEqual({ show: false });
    expect(w.codex.starts()).toBe(0);
    expect(w.saved().inboxVoiceIntro?.shownAt).toBeUndefined();
  });

  describe("a login the owner allowed, who isn't the owner", () => {
    const GUEST = "guest@example.com";
    async function guestWorld(options: WorldOptions = {}) {
      const w = await tailnetWorld({ ...options, config: { ...options.config, inboxTailscaleAllow: [GUEST] } });
      const asGuest = (path: string, init: RequestInit = {}) => w.through(path, { ...init, headers: { "Tailscale-User-Login": GUEST, ...init.headers } });
      const post = (path: string, payload: Record<string, unknown>) =>
        asGuest(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: w.session, ...payload }) });
      return { ...w, asGuest, post };
    }

    test("gets no use of the owner's login or key: no route, no Codex, nothing upstream", async () => {
      const chatgpt = fakeEndpoint([ok("Never.")]);
      const w = await guestWorld({ chatgpt });
      await w.turnOn();
      const started = w.codex.starts();
      const answers = [
        await w.asGuest(`/api/inbox/voice/transcribe?serverSession=${w.session}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav() }),
        await w.asGuest("/api/inbox/voice/status?fresh=1"),
        await w.post("/api/inbox/voice/intro", {}),
        await w.post("/api/inbox/voice/key", { key: KEY }),
      ];
      for (const answer of answers) {
        expect(answer.status).toBe(403);
        expect((await body(answer)).code).toBe("owner_only");
      }
      expect(w.codex.starts()).toBe(started);
      expect(chatgpt.seen).toHaveLength(0);
    });

    test("can't change voice, and a mixed save writes nothing", async () => {
      const w = await guestWorld();
      await w.turnOn();
      for (const voice of [{ on: false }, { engine: "api" }, { phones_only: true }]) {
        const answer = await w.post("/api/inbox/settings", { voice });
        expect(answer.status).toBe(403);
        expect((await body(answer)).code).toBe("owner_only");
      }
      expect((await w.post("/api/inbox/settings", { text_size: 15, voice: { on: false } })).status).toBe(403);
      expect((await w.settings()).voice).toMatchObject({ on: true, engine: "codex", phones_only: false });
      expect(((await (await fetch(`${w.base}/api/inbox/settings`)).json()) as { text_size: number }).text_size).not.toBe(15);
    });

    test("is told voice is off here, with no sign of the key, and the owner isn't", async () => {
      const w = await guestWorld();
      await w.turnOn();
      expect((await w.json("/api/inbox/voice/key", { key: KEY })).status).toBe(200);
      const seen = (await (await w.asGuest("/api/inbox/settings")).json()) as { voice: Record<string, unknown> };
      expect(seen.voice).toMatchObject({ on: false, guest: true, intro_due: false, key: { source: null, last4: null } });
      expect(JSON.stringify(seen)).not.toContain(KEY.slice(-4));
      const owner = (await (await w.through("/api/inbox/settings")).json()) as { voice: Record<string, unknown> };
      expect(owner.voice).toMatchObject({ on: true, guest: false });
      expect((await w.through(`/api/inbox/voice/status`)).status).toBe(200);
    });
  });

  test("the window's worklet is served from this origin, as a script", async () => {
    const w = await tailnetWorld();
    const response = await w.through("/api/inbox/voice/worklet.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toContain("registerProcessor");
  });
});

describe("linked machines", () => {
  test("no voice route is a door route or a forwardable write", () => {
    expect(doorRouteNames().filter((route) => route.includes("voice"))).toEqual([]);
    for (const route of ["voice/transcribe", "voice/key", "voice/intro"]) expect(doorWriteKind(route)).toBeNull();
  });
});

describe("the announcement", () => {
  const claim = async (w: Awaited<ReturnType<typeof world>>) => ((await (await w.json("/api/inbox/voice/intro", {})).json()) as { show: boolean }).show;

  test("a fresh install is marked shown; a dev build decides nothing", async () => {
    const fresh = await world({ version: "0.30.0" });
    expect(fresh.saved().inboxVoiceIntro?.shownAt).toMatch(/^\d{4}-/);
    expect((await fresh.settings()).voice.intro_due).toBe(false);
    expect(await claim(fresh)).toBe(false);
    expect(fresh.codex.starts()).toBe(0);
    const dev = await world({ version: "dev", usedBefore: true });
    expect(dev.saved().inboxVoiceIntro).toBeUndefined();
    expect((await dev.settings()).voice.intro_due).toBe(false);
  });

  test("someone with a ChatGPT login in Codex: of two tabs, one shows it, once, ever; Codex asked once", async () => {
    const w = await world({ version: "0.30.0", usedBefore: true });
    expect((await w.settings()).voice.intro_due).toBe(true);
    expect(w.codex.starts()).toBe(0);
    const answers = await Promise.all([claim(w), claim(w)]);
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(await claim(w)).toBe(false);
    expect(w.saved().inboxVoiceIntro?.shownAt).toMatch(/^\d{4}-/);
    expect((await w.settings()).voice.intro_due).toBe(false);
    expect(w.codex.methods()).toEqual(["account/read"]);
    await codexStopped(w.codex);
  });

  test.each([
    ["no ChatGPT login", { account: null }],
    ["a Codex API key", { account: { type: "apiKey" } }],
  ])("%s: not shown, not spent, and asked only once this start", async (_name, codex) => {
    const w = await world({ version: "0.30.0", usedBefore: true, codex });
    expect(await claim(w)).toBe(false);
    expect((await w.settings()).voice.intro_due).toBe(false);
    expect(await claim(w)).toBe(false);
    expect(w.codex.starts()).toBe(1);
    expect(w.saved().inboxVoiceIntro?.shownAt).toBeUndefined();
  });

  test("no Codex: nothing started", async () => {
    const w = await world({ version: "0.30.0", usedBefore: true, codex: null });
    expect(await claim(w)).toBe(false);
    expect(w.saved().inboxVoiceIntro?.shownAt).toBeUndefined();
  });

  test.each([
    ["the sound dialog", { inboxSound: { dialogDueFor: "0.30.0" } }],
    ["the list options dialog", { inboxListIntro: { dueAt: "2026-10-30T00:00:00.000Z" } }],
  ])("%s due: no check, no claim", async (_name, config) => {
    const w = await world({ version: "0.30.0", usedBefore: true, config });
    expect(await claim(w)).toBe(false);
    expect(w.codex.starts()).toBe(0);
    expect(w.saved().inboxVoiceIntro?.shownAt).toBeUndefined();
  });

  test("turning voice on in Settings first leaves nothing to announce, even after it is turned off again", async () => {
    const w = await world({ version: "0.30.0", usedBefore: true });
    await w.turnOn();
    await w.json("/api/inbox/settings", { voice: { on: false } });
    expect((await w.settings()).voice.intro_due).toBe(false);
    expect(await claim(w)).toBe(false);
  });

  test("a claim from another server session is refused", async () => {
    const w = await world({ version: "0.30.0", usedBefore: true });
    const response = await fetch(`${w.base}/api/inbox/voice/intro`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: "other" }) });
    expect(response.status).toBe(409);
    expect(w.saved().inboxVoiceIntro?.shownAt).toBeUndefined();
  });
});
