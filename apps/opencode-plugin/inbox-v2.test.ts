/**
 * The OpenCode 2 connection to the Plannotator Inbox, proved on the REAL
 * OpenCode 2: the installed `opencode2` serving with this plugin installed
 * from its packed tarball (the installed-package path of
 * `fixtures/v2-installed-smoke.ts`, through a throwaway registry), against a
 * real Inbox (`plannotator inbox --background` under a temp data dir; the
 * compiled binary when PLANNOTATOR_INBOX_TEST_BINARY names one). The model is
 * a scripted OpenAI-compatible endpoint (tests/helpers/scripted-model.ts)
 * configured as an OpenCode provider: OpenCode sends it exactly what it would
 * send a provider, so the proofs read the tool list and the wake turn from
 * those requests, and OpenCode's own event stream shows how the wake was
 * admitted. The person's Send goes through the window's route. No mocks.
 *
 * Runs where OPENCODE2_BIN and OPENCODE_PLUGIN_TARBALL name the host and the
 * packed plugin (the "OpenCode 2 installed package" CI job); skipped otherwise.
 * INBOX_PROOF_DIR=<dir> keeps a transcript per proof under <dir>/opencode2/.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { INBOX_WAKE_INSTRUCTION, inboxWakeText } from "@plannotator/shared/inbox/connection";
import {
  createInboxWorld,
  destroyInboxWorld,
  gate,
  listedThreads,
  personSends,
  QUESTION,
  registry,
  startInbox,
  stubBuiltHtml,
  SUBJECT,
  thread,
  waitFor,
  worldEnv,
  type InboxWorld,
} from "../../tests/helpers/inbox-world";
import { lastMessage, startScriptedModel, type ScriptedModel, type ScriptedRequest, type ScriptedTurn } from "../../tests/helpers/scripted-model";

const opencodeBin = process.env.OPENCODE2_BIN;
const tarball = process.env.OPENCODE_PLUGIN_TARBALL;
const packageJson = JSON.parse(readFileSync(path.join(import.meta.dir, "package.json"), "utf8")) as { name: string; version: string };
const AUTH = { Authorization: `Basic ${Buffer.from("opencode:plannotator-proof").toString("base64")}` };
/** A cold runner installs the plugin in about 47 s (the smoke's measurement). */
const PLUGIN_TIMEOUT_MS = 300_000;

let stubs: string[] = [];
const worlds: InboxWorld[] = [];
const models: ScriptedModel[] = [];
const hosts: OpenCodeHost[] = [];

beforeAll(() => {
  stubs = stubBuiltHtml();
});
afterAll(() => {
  const { rmSync } = require("node:fs") as typeof import("node:fs");
  for (const file of stubs) rmSync(file, { force: true });
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const model of models.splice(0)) model.stop();
  for (const w of worlds.splice(0)) destroyInboxWorld(w);
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface OpenCodeEvent {
  type: string;
  data?: Record<string, unknown>;
}

interface OpenCodeHost {
  url: string;
  events: OpenCodeEvent[];
  api<T = unknown>(method: string, route: string, body?: unknown): Promise<T>;
  stop(): Promise<void>;
}

/** `opencode2 serve` in the world, with the packed plugin installed through a throwaway registry and the scripted model as its provider. */
async function openOpenCode(w: InboxWorld, m: ScriptedModel): Promise<OpenCodeHost> {
  const npmRegistry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (decodeURIComponent(pathname.slice(1)) === packageJson.name) {
        return Response.json({
          name: packageJson.name,
          "dist-tags": { latest: packageJson.version },
          versions: { [packageJson.version]: { ...packageJson, dist: { tarball: `${registryUrl}/plugin.tgz` } } },
        });
      }
      if (pathname === "/plugin.tgz") return new Response(Bun.file(path.resolve(tarball!)));
      // The plugin has no runtime dependencies: nothing else is served.
      return new Response("not found", { status: 404 });
    },
  });
  const registryUrl = `http://127.0.0.1:${npmRegistry.port}`;
  const port = await freePort();
  // One OpenCode home per world, so the second server reuses the installed plugin.
  const xdg = path.join(w.root, "opencode");
  for (const dir of ["config", "data", "cache"]) mkdirSync(path.join(xdg, dir), { recursive: true });
  const server = Bun.spawn([opencodeBin!, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: w.project,
    env: {
      ...process.env,
      ...worldEnv(w),
      XDG_CONFIG_HOME: path.join(xdg, "config"),
      XDG_DATA_HOME: path.join(xdg, "data"),
      XDG_CACHE_HOME: path.join(xdg, "cache"),
      OPENCODE_DB: path.join(xdg, "opencode.db"),
      OPENCODE_SERVER_PASSWORD: "plannotator-proof",
      OPENCODE_PASSWORD: "plannotator-proof",
      NPM_CONFIG_REGISTRY: registryUrl,
      npm_config_registry: registryUrl,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugins: [{ package: `${packageJson.name}@${packageJson.version}`, options: { workflow: "manual" } }],
        providers: {
          scripted: {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { apiKey: "scripted", baseURL: m.baseUrl },
            models: { scripted: { name: "Scripted" } },
          },
        },
        model: "scripted/scripted",
      }),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(server.stderr).text().catch(() => "");
  const url = `http://127.0.0.1:${port}`;
  const directory = encodeURIComponent(w.project);
  const api = async <T,>(method: string, route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: { ...AUTH, "x-opencode-directory": directory, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const events: OpenCodeEvent[] = [];
  const stopEvents = new AbortController();
  const stop = async () => {
    stopEvents.abort();
    server.kill();
    await Promise.race([server.exited, Bun.sleep(10_000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
    npmRegistry.stop(true);
  };
  const host: OpenCodeHost = { url, events, api, stop };
  hosts.push(host);
  try {
    await waitFor("OpenCode 2 to answer", async () => (await fetch(`${url}/api/info`, { headers: AUTH }).catch(() => null))?.ok, 120_000);
    await waitFor(
      "the plugin to activate",
      async () => {
        const listed = await api<{ data?: ({ id?: string; status?: string; error?: string } | string)[] }>("GET", "/api/plugin").catch(() => null);
        const entry = listed?.data?.find((plugin) => (typeof plugin === "string" ? plugin === "plannotator" : plugin.id === "plannotator"));
        if (entry && typeof entry !== "string" && entry.status === "failed") throw new Error(`plugin failed: ${entry.error}`);
        return !!entry;
      },
      PLUGIN_TIMEOUT_MS,
    );
  } catch (error) {
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- opencode2 stderr ---\n${await stderr}`);
  }
  // OpenCode's own event stream, kept for the proofs.
  void (async () => {
    try {
      const response = await fetch(`${url}/api/event`, { headers: { ...AUTH, "x-opencode-directory": directory }, signal: stopEvents.signal });
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!data) continue;
          try {
            events.push(JSON.parse(data) as OpenCodeEvent);
          } catch {
            // Not an event.
          }
        }
      }
    } catch {
      // Stopped.
    }
  })();
  return host;
}

function knob(w: InboxWorld, on: boolean): void {
  mkdirSync(w.dataDir, { recursive: true });
  writeFileSync(path.join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { opencode: on } }));
}

async function newSession(host: OpenCodeHost): Promise<string> {
  return (await host.api<{ data: { id: string } }>("POST", "/api/session", {})).data.id;
}

/** The person types into the session (OpenCode's default admission). */
async function type(host: OpenCodeHost, sessionID: string, text: string): Promise<void> {
  await host.api("POST", `/api/session/${sessionID}/prompt`, { text });
}

async function idle(host: OpenCodeHost, sessionID: string): Promise<void> {
  await host.api("POST", `/api/experimental/session/${sessionID}/wait`, {});
}

/** Every model request whose last message is an Inbox wake, by its first line. */
function wakeRequests(m: ScriptedModel): string[] {
  return m.requests.map((request) => lastMessage(request)).filter((last) => last.role === "user" && last.text.startsWith("Plannotator Inbox: ")).map((last) => last.text);
}

/** Rows OpenCode admitted into the session carrying the Inbox's source. */
function wakeRows(host: OpenCodeHost, sessionID: string): Record<string, unknown>[] {
  return host.events
    .filter((event) => event.type === "session.inbox.enqueued" && event.data?.sessionID === sessionID)
    .map((event) => (event.data?.item ?? {}) as Record<string, unknown>)
    .filter((item) => JSON.stringify(item).includes("Plannotator Inbox: "));
}

function model(script: (request: ScriptedRequest) => ScriptedTurn | null): ScriptedModel {
  const m = startScriptedModel((request) => {
    if (request.tools.length === 0) return { text: "Refund webhook 409" }; // the title request
    const own = script(request);
    if (own) return own;
    const last = lastMessage(request);
    if (last.role === "tool") return { text: "Done." };
    if (last.text.includes("Ask the person")) return { toolCall: { name: "plannotator_inbox", arguments: { action: "send_message", body: QUESTION } } };
    return { text: "OK." };
  });
  models.push(m);
  return m;
}

function sentFrom(m: ScriptedModel): { message_id: string; thread_id: string } {
  const result = m.requests.map((request) => lastMessage(request)).find((last) => last.role === "tool" && last.text.includes('"message_id"'));
  if (!result) throw new Error("no send_message result reached the model");
  return JSON.parse(result.text.slice(result.text.indexOf("{")));
}

function toolsOfLastTurn(m: ScriptedModel): string[] {
  return m.requests.filter((request) => request.tools.length > 0).at(-1)?.tools ?? [];
}

describe.skipIf(!opencodeBin || !tarball)("OpenCode 2 ↔ Plannotator Inbox (the installed package on the real OpenCode 2, a real Inbox)", () => {
  test("silent without a registry; no tool with the switch off; with both, the tool carries what the Inbox's /mcp offers", async () => {
    const w = createInboxWorld("plannotator-inbox-oc2-", "01-registry-switch-and-tool-list", "opencode2");
    worlds.push(w);
    const m = model(() => null);

    knob(w, true);
    let host = await openOpenCode(w, m);
    let session = await newSession(host);
    await type(host, session, "hello");
    await waitFor("the model turn", () => toolsOfLastTurn(m).length > 0, 60_000);
    await idle(host, session);
    expect(toolsOfLastTurn(m)).not.toContain("plannotator_inbox");
    expect(existsSync(path.join(w.dataDir, "inbox"))).toBe(false);
    w.proof(`switch on, no inbox/inbox.json: tools sent to the model = ${JSON.stringify(toolsOfLastTurn(m))}; no inbox folder`);
    await host.stop();

    startInbox(w);
    knob(w, false);
    const before = m.requests.length;
    host = await openOpenCode(w, m);
    session = await newSession(host);
    await type(host, session, "hello");
    await waitFor("the model turn", () => m.requests.slice(before).some((request) => request.tools.length > 0), 60_000);
    await idle(host, session);
    expect(toolsOfLastTurn(m)).not.toContain("plannotator_inbox");
    w.proof(`Inbox running, switch off for opencode: tools sent = ${JSON.stringify(toolsOfLastTurn(m))}`);
    await host.stop();

    knob(w, true);
    const again = m.requests.length;
    host = await openOpenCode(w, m);
    session = await newSession(host);
    await type(host, session, "hello");
    await waitFor("the model turn", () => m.requests.slice(again).some((request) => request.tools.length > 0), 60_000);
    await idle(host, session);
    const sent = m.requests.filter((request) => request.tools.length > 0).at(-1)!;
    expect(sent.tools).toContain("plannotator_inbox");
    const tool = sent.toolDefinitions.find((definition) => definition.name === "plannotator_inbox")!;
    const actions = (tool.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum;
    expect(actions).toContain("send_message");
    expect(tool.description).toContain("Plannotator Inbox: <subject> (<reply id>)");
    w.proof(`Inbox running (port ${registry(w).port}), switch on for opencode: plannotator_inbox sent with actions ${JSON.stringify(actions)}`);
  }, 900_000);

  test("send_message lands a thread; the person's Send is queued into the idle session once (never steer), Delivered to OpenCode; a typed prompt goes first and takes the wake's turn over", async () => {
    const w = createInboxWorld("plannotator-inbox-oc2-", "02-wake-queue-and-take-over", "opencode2");
    worlds.push(w);
    knob(w, true);
    startInbox(w);
    const personTurn = gate();
    const wakeTurn = gate();
    const m = model((request) => {
      const last = lastMessage(request);
      if (last.role === "user" && last.text === "Refactor the webhook handler.") return { text: "Refactoring.", hold: personTurn.promise };
      const wake = /^Plannotator Inbox: .* \((msg_[^)]+)\)$/.exec(last.text.split("\n", 1)[0] ?? "");
      if (last.role === "user" && wake) {
        return { toolCall: { name: "plannotator_inbox", arguments: { action: "send_message", body: "Done: retries reuse the key.", reply_to: wake[1] } }, hold: wakeTurn.promise };
      }
      return null;
    });
    const host = await openOpenCode(w, m);
    const session = await newSession(host);
    await type(host, session, "Ask the person what to do on a 409.");
    await waitFor("the send_message result", () => m.requests.some((request) => lastMessage(request).role === "tool"), 60_000);
    await idle(host, session);
    const asked = sentFrom(m);
    const t = await thread(w, asked.thread_id);
    expect(t.project.root).toBe(w.project);
    expect(t.messages[0]?.author).toMatchObject({ kind: "agent", host: "opencode", name: "OpenCode", session });
    w.proof(`> plannotator_inbox send_message from OpenCode session ${session}\nthread ${asked.thread_id}: author ${JSON.stringify(t.messages[0]?.author)}\n`);

    // The person works in the session; the reply waits.
    await type(host, session, "Refactor the webhook handler.");
    await waitFor("the person's turn at the model", () => m.requests.some((request) => lastMessage(request).text === "Refactor the webhook handler."), 60_000);
    const words = "Retry with the same key.\n\nAnd log the 409 body.";
    const replyId = await personSends(w, asked.message_id, words);
    await Bun.sleep(4_000);
    expect(wakeRequests(m)).toEqual([]);
    expect(wakeRows(host, session)).toEqual([]);
    w.proof("the person's turn runs (model held): the reply waits in the plugin, 0 wake rows after 4 s");
    personTurn.release();

    const wake = await waitFor("the wake turn at the model", () => wakeRequests(m)[0], 60_000);
    const lines = wake.split("\n");
    expect(lines[0]).toBe(`Plannotator Inbox: ${SUBJECT} (${replyId})`);
    expect(lines[1]).toBe(INBOX_WAKE_INSTRUCTION);
    const reply = (await thread(w, asked.thread_id)).messages.find((message) => message.id === replyId)!;
    expect(wake).toBe(inboxWakeText({ id: replyId, subject: SUBJECT, body: reply.body }));
    const rows = wakeRows(host, session);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivery).toBe("queue");
    w.proof(`OpenCode admitted the wake as ONE row: type ${rows[0]!.type}, delivery ${rows[0]!.delivery}; the model received it:\n${wake}\n`);

    const delivered = await waitFor("the delivery record", async () => (await thread(w, asked.thread_id)).messages.find((message) => message.id === replyId)?.delivery);
    expect(delivered).toMatchObject({ state: "delivered", host: "opencode", session });
    const row = (await listedThreads(w)).find((r) => r.thread_id === asked.thread_id);
    expect(row?.sent?.checked_at).toBe(delivered.at);
    w.proof(`thread shows: Delivered to OpenCode, ${delivered.at} (reply.delivery ${JSON.stringify(delivered)})`);

    // The person types into the wake's own turn: theirs from here; nothing is interrupted or sent again.
    await type(host, session, "Actually, hold off on that.");
    await Bun.sleep(1_000);
    wakeTurn.release();
    await waitFor("the typed prompt at the model", () => m.requests.some((request) => request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Actually, hold off on that."))), 60_000);
    await idle(host, session);
    await Bun.sleep(3_000);
    expect(wakeRows(host, session)).toHaveLength(1);
    expect(host.events.filter((event) => event.type === "session.execution.interrupted" && event.data?.sessionID === session)).toEqual([]);
    const answered = (await thread(w, asked.thread_id)).messages.at(-1);
    expect(answered?.author).toMatchObject({ kind: "agent", session });
    w.proof(`a prompt typed into the wake's turn took it over: 1 wake row, 0 interrupts; the wake's answer (reply_to ${replyId}) landed in the thread: Replied`);
  }, 900_000);

  test("two OpenCode 2 servers on one session: the reply goes to the one the person works in, once", async () => {
    const w = createInboxWorld("plannotator-inbox-oc2-", "03-two-servers-follow-the-person", "opencode2");
    worlds.push(w);
    knob(w, true);
    startInbox(w);
    const personTurn = gate();
    // In B the agent reads the project's decisions through the tool, then its turn is held.
    const m = model((request) => {
      const last = lastMessage(request);
      if (last.role === "user" && last.text === "Refactor the webhook handler.") return { toolCall: { name: "plannotator_inbox", arguments: { action: "list_decisions" } } };
      if (last.role === "tool" && last.text.includes("decision")) return { text: "Refactoring.", hold: personTurn.promise };
      return null;
    });
    // A and B share one OpenCode home and database: one session, two processes.
    const a = await openOpenCode(w, m);
    const session = await newSession(a);
    await type(a, session, "Ask the person what to do on a 409.");
    await waitFor("the send_message result", () => m.requests.some((request) => lastMessage(request).role === "tool"), 60_000);
    await idle(a, session);
    const asked = sentFrom(m);
    const b = await openOpenCode(w, m);

    // The person works in B (its turn held at the model); A sits idle.
    await type(b, session, "Refactor the webhook handler.");
    await waitFor("B's held turn at the model", () => m.requests.some((request) => lastMessage(request).role === "tool" && lastMessage(request).text.includes("decision")), 60_000);
    const replyId = await personSends(w, asked.message_id, "Retry with the same key.");
    await Bun.sleep(8_000);
    expect(wakeRequests(m)).toEqual([]);
    expect(wakeRows(a, session)).toEqual([]);
    w.proof(`session ${session} open in servers A and B; the person works in B (its agent called plannotator_inbox, then its turn held), A idle: 8 s after Send, 0 wake rows in A, 0 wake requests at the model`);
    personTurn.release();

    await waitFor("the wake turn at the model", () => wakeRequests(m)[0], 60_000);
    await idle(b, session);
    await Bun.sleep(5_000);
    expect(wakeRequests(m)).toHaveLength(1);
    expect(wakeRows(b, session)).toHaveLength(1);
    expect(wakeRows(a, session)).toEqual([]);
    const delivered = (await thread(w, asked.thread_id)).messages.find((message) => message.id === replyId)?.delivery;
    expect(delivered).toMatchObject({ state: "delivered", host: "opencode", session });
    w.proof(`B's turn ended: the reply was queued in B, once (wake rows A 0, B 1; delivered at ${delivered?.at})`);
  }, 900_000);
});
