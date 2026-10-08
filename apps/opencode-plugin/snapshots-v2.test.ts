/**
 * Plannotator Snapshots on the REAL OpenCode 2: the installed `opencode2`
 * serving with this plugin installed from its packed tarball (through a
 * throwaway registry, as in inbox-v2.test.ts), against a REAL Snapshots hub
 * started the way a person's first `plannotator snapshot` starts it
 * (`plannotator snapshot hub --background` under a temp HOME and data dir; the
 * compiled binary when PLANNOTATOR_INBOX_TEST_BINARY names one, the CLI from
 * source otherwise). The model is a scripted OpenAI-compatible endpoint
 * (tests/helpers/scripted-model.ts), so the proofs read the delivered turn
 * from what OpenCode sent it. The native app never runs: the temp HOME has no
 * app and neither build embeds one, so the test plays the HUD through the hub
 * API (capture a PNG, a note, Send, Ask), exactly the calls the HUD makes.
 *
 * Works on macOS and Linux: `/plannotator-snapshot` links the session on both
 * (on macOS the CLI summons and then answers "not installed"; elsewhere the
 * plugin answers "macOS for now"), and its failure notice is promoted by the
 * person's next prompt, so the Send that follows is queued as a turn of its own.
 *
 * Runs where OPENCODE2_BIN and OPENCODE_PLUGIN_TARBALL name the host and the
 * packed plugin (the "OpenCode 2 installed package" CI job); skipped otherwise.
 * INBOX_PROOF_DIR=<dir> keeps a transcript per proof under <dir>/opencode2-snapshots/.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createInboxWorld, destroyInboxWorld, stubBuiltHtml, waitFor, worldEnv, type InboxWorld } from "../../tests/helpers/inbox-world";
import { lastMessage, startScriptedModel, type ScriptedModel, type ScriptedRequest, type ScriptedTurn } from "../../tests/helpers/scripted-model";
import { startCliSnapshotsHub, stopCliSnapshotsHub, type CliSnapshotsHub } from "../../tests/helpers/snapshots-world";

const opencodeBin = process.env.OPENCODE2_BIN;
const tarball = process.env.OPENCODE_PLUGIN_TARBALL;
const packageJson = JSON.parse(readFileSync(path.join(import.meta.dir, "package.json"), "utf8")) as { name: string; version: string };
const AUTH = { Authorization: `Basic ${Buffer.from("opencode:plannotator-proof").toString("base64")}` };
/** A cold runner installs the plugin in about 47 s (the smoke's measurement). */
const PLUGIN_TIMEOUT_MS = 300_000;
const SNAPSHOT_HEADLINE = "Plannotator: 1 snapshot from you";
const QUESTION = "Which field is wrong in this snapshot?";
const ANSWER = "The refund amount field shows cents as dollars.";

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
  for (const w of worlds.splice(0)) {
    stopCliSnapshotsHub(w);
    destroyInboxWorld(w);
  }
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
  events: OpenCodeEvent[];
  api<T = unknown>(method: string, route: string, body?: unknown): Promise<T>;
  stop(): Promise<void>;
}

/** `opencode2 serve` in the world, with the packed plugin installed through a throwaway registry and the scripted model as its provider. */
async function openOpenCode(w: InboxWorld, m: ScriptedModel): Promise<OpenCodeHost> {
  const port = await freePort();
  const registryPort = await freePort();
  const registryUrl = `http://127.0.0.1:${registryPort}`;
  const npmRegistry = Bun.serve({
    hostname: "127.0.0.1",
    port: registryPort,
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
      return new Response("not found", { status: 404 });
    },
  });
  const xdg = path.join(w.root, "opencode");
  for (const dir of ["config", "data", "cache"]) mkdirSync(path.join(xdg, dir), { recursive: true });
  const server = Bun.spawn([opencodeBin!, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: w.project,
    env: {
      ...process.env,
      ...worldEnv(w),
      // Snapshots is on by default; nothing inherited may turn it off or point at a real app.
      PLANNOTATOR_SNAPSHOTS: "",
      PLANNOTATOR_SNAPSHOTS_APP: "",
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
  const host: OpenCodeHost = { events, api, stop };
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
    await waitFor(
      "the native /plannotator-snapshot command",
      async () => {
        const listed = await api<{ data?: { name?: string }[] }>("GET", "/api/command").catch(() => null);
        return listed?.data?.some((command) => command.name === "plannotator-snapshot");
      },
      60_000,
    );
  } catch (error) {
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- opencode2 stderr ---\n${await stderr}`);
  }
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

async function newSession(host: OpenCodeHost): Promise<string> {
  return (await host.api<{ data: { id: string } }>("POST", "/api/session", {})).data.id;
}

async function type(host: OpenCodeHost, sessionID: string, text: string): Promise<void> {
  await host.api("POST", `/api/session/${sessionID}/prompt`, { text });
}

async function idle(host: OpenCodeHost, sessionID: string): Promise<void> {
  await host.api("POST", `/api/experimental/session/${sessionID}/wait`, {});
}

/** Model requests whose last message is a Snapshots send. */
function snapshotRequests(m: ScriptedModel): string[] {
  return m.requests
    .map((request) => lastMessage(request))
    .filter((last) => last.role === "user" && last.text.startsWith(SNAPSHOT_HEADLINE))
    .map((last) => last.text);
}

/** Rows OpenCode admitted into the session carrying a Snapshots send. */
function snapshotRows(host: OpenCodeHost, sessionID: string): Record<string, unknown>[] {
  return host.events
    .filter((event) => event.type === "session.inbox.enqueued" && event.data?.sessionID === sessionID)
    .map((event) => (event.data?.item ?? {}) as Record<string, unknown>)
    .filter((item) => JSON.stringify(item).includes(SNAPSHOT_HEADLINE));
}

function model(): ScriptedModel {
  const m = startScriptedModel((request: ScriptedRequest): ScriptedTurn => {
    if (request.tools.length === 0) return { text: "Refund form snapshot" }; // the title request
    const last = lastMessage(request);
    if (last.role === "user" && last.text.includes(QUESTION)) return { text: ANSWER };
    if (last.role === "user" && last.text.startsWith(SNAPSHOT_HEADLINE)) return { text: "Got the snapshot." };
    return { text: "OK." };
  });
  models.push(m);
  return m;
}

/** Set the send's note, as the HUD's note field does (its own HUD token). */
async function setNote(hub: CliSnapshotsHub, collectionId: string, note: string): Promise<void> {
  const attach = (await (
    await fetch(`${hub.url}/api/snapshots/attach`, { method: "POST", headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" }, body: "{}" })
  ).json()) as { hudToken: string };
  const response = await fetch(`${hub.url}/api/snapshots/collection/${collectionId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${attach.hudToken}`, "content-type": "application/json" },
    body: JSON.stringify({ note }),
  });
  if (!response.ok) throw new Error(`note: ${response.status} ${await response.text()}`);
}

describe.skipIf(!opencodeBin || !tarball)("OpenCode 2 ↔ Plannotator Snapshots (the installed package on the real OpenCode 2, a hub started by the CLI)", () => {
  test("/plannotator-snapshot links the session; the person's Send arrives once as a queued turn with the image path and the note; Ask from the HUD is answered as a turn", async () => {
    const w = createInboxWorld("plannotator-snapshots-oc2-", "01-send-once-and-ask", "opencode2-snapshots");
    worlds.push(w);
    const hub = await startCliSnapshotsHub(w);
    const m = model();
    const host = await openOpenCode(w, m);
    const session = await newSession(host);

    // The person runs the command. On macOS the CLI summons this session and then
    // answers "not installed" (no app in the temp HOME); elsewhere the plugin
    // answers "macOS for now". Either way the session links on demand.
    await host.api("POST", `/api/session/${session}/command`, { name: "plannotator-snapshot", text: "" });
    const linked = await hub.waitForState(
      (state) => state.connections?.some((c: { host: string; sessionId: string; canAsk: boolean }) => c.host === "opencode" && c.sessionId === session && c.canAsk),
      30_000,
    );
    w.proof(`> /plannotator-snapshot in OpenCode session ${session} (${process.platform})\nhub connections: ${JSON.stringify(linked.connections)}\n`);
    // The person's next prompt promotes the command's failure notice with it, so nothing of ours is pending.
    await type(host, session, "Look at what I send next.");
    await waitFor("the person's turn at the model", () => m.requests.some((request) => lastMessage(request).text === "Look at what I send next."), 60_000);
    await idle(host, session);
    const before = m.requests.length;

    // The HUD: summon (as `plannotator snapshot --session opencode:<id>` does), a capture, a note, Send.
    await hub.summon("opencode", session);
    const { collectionId } = await hub.capture();
    await setNote(hub, collectionId, "The refund total is wrong here.");
    const sent = await hub.send(collectionId);
    expect(sent.text.startsWith(SNAPSHOT_HEADLINE)).toBe(true);
    expect(sent.text).toContain("The refund total is wrong here.");
    const image = /^Image: (\S+\.png) /m.exec(sent.text)?.[1];
    expect(image && path.isAbsolute(image) && image.startsWith(w.dataDir)).toBe(true);
    w.proof(`> the person presses Send (${sent.sendId})\n${sent.text}\n`);

    const delivered = await waitFor("the Send at the model", () => snapshotRequests(m)[0], 60_000);
    expect(delivered).toBe(sent.text);
    const state = await hub.waitForState((current) => current.lastSent?.send?.sendId === sent.sendId && current.lastSent.send.state === "delivered", 30_000);
    expect(state.lastSent.send.host).toBe("opencode");
    await idle(host, session);
    // Past the hub's 5 s re-send: still exactly one.
    await Bun.sleep(7_000);
    expect(snapshotRequests(m)).toEqual([sent.text]);
    const rows = snapshotRows(host, session);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivery).toBe("queue");
    expect(m.requests.length).toBeGreaterThan(before);
    w.proof(`the model received the Send once, as ONE queued row (delivery ${rows[0]!.delivery}); hub: ${state.lastSent.send.state}\n`);

    // Ask from the HUD: a real turn in the session, the model's text streamed back.
    const answer = await hub.ask(QUESTION, { host: "opencode", sessionId: session });
    expect(answer.text).toContain(ANSWER);
    const askRequest = m.requests.find((request) => lastMessage(request).role === "user" && lastMessage(request).text.includes(QUESTION));
    expect(askRequest).toBeTruthy();
    expect(lastMessage(askRequest!).text).toContain("Plannotator Snapshots");
    w.proof(`> Ask from the HUD: ${QUESTION}\nthe session answered as a turn: ${answer.text}\n`);
    await idle(host, session);
    expect(snapshotRequests(m)).toEqual([sent.text]);
  }, 900_000);
});
