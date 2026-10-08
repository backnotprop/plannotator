/**
 * A real Plannotator Snapshots hub for host tests (Pi, OpenCode, the shared
 * link): `startSnapshotsHubServer` in this process under a temp data dir, plus
 * the calls the HUD makes (attach, capture, send, ask), so a test can play the
 * person pressing Send or asking from the HUD without the native app.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSnapshotsHubServer, type SnapshotsHubServer } from "../../packages/server/snapshots/server";

/** A 1×1 PNG: what a capture needs to be a snapshot. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** What the HUD and the CLI do to a hub, by its url and hub token (in process or started by the CLI). */
export interface SnapshotsHubClient {
  url: string;
  /** The hub token's routes (summon, as `plannotator snapshot --session` does). */
  summon(host: string, sessionId: string): Promise<void>;
  /** Add a snapshot to the open collection, as the native app does after a capture. */
  capture(): Promise<{ collectionId: string; snapshotId: string }>;
  /** The person presses Send. */
  send(collectionId: string, body?: Record<string, unknown>): Promise<{ sendId: string; text: string }>;
  /** Ask from the HUD; resolves with the streamed text once the answer ends. */
  ask(question: string, extra?: Record<string, unknown>): Promise<{ text: string; messages: Array<Record<string, unknown>> }>;
  state(): Promise<Record<string, any>>;
  /** Wait until `check` holds on the hub's state. */
  waitForState(check: (state: Record<string, any>) => boolean, timeoutMs?: number): Promise<Record<string, any>>;
}

export interface TestSnapshotsHub extends SnapshotsHubClient {
  server: SnapshotsHubServer;
  stop(): void;
}

export async function startTestSnapshotsHub(dataDir: string): Promise<TestSnapshotsHub> {
  const server = startSnapshotsHubServer({ dataDir, version: "test", cli: ["plannotator"] });
  const client = await snapshotsHubClient(server.entry.url, server.entry.token);
  return {
    ...client,
    server,
    stop() {
      server.stop();
    },
  };
}

/** Attach as the HUD to the hub at `url` (hub token `token`). */
export async function snapshotsHubClient(url: string, token: string): Promise<SnapshotsHubClient> {
  const hubHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const attach = (await (await fetch(`${url}/api/snapshots/attach`, { method: "POST", headers: hubHeaders, body: "{}" })).json()) as { hudToken: string };
  const hud = { authorization: `Bearer ${attach.hudToken}`, "content-type": "application/json" };
  const scratch = mkdtempSync(join(tmpdir(), "plannotator-snapshots-capture-"));
  let captures = 0;

  const state = async () => (await (await fetch(`${url}/api/snapshots/state`, { headers: hud })).json()) as Record<string, any>;

  return {
    url,
    async summon(host, sessionId) {
      const response = await fetch(`${url}/api/snapshots/summon`, { method: "POST", headers: hubHeaders, body: JSON.stringify({ host, sessionId }) });
      if (!response.ok) throw new Error(`summon: ${response.status}`);
    },
    async capture() {
      captures += 1;
      const file = join(scratch, `capture-${captures}.png`);
      writeFileSync(file, PNG_1X1);
      const response = await fetch(`${url}/api/snapshots/capture`, { method: "POST", headers: hud, body: JSON.stringify({ file, kind: "region" }) });
      const body = (await response.json()) as { snapshot?: { id: string }; collectionId?: string; error?: string };
      if (!response.ok || !body.snapshot || !body.collectionId) throw new Error(`capture: ${body.error ?? response.status}`);
      return { collectionId: body.collectionId, snapshotId: body.snapshot.id };
    },
    async send(collectionId, body = {}) {
      const response = await fetch(`${url}/api/snapshots/collection/${collectionId}/send`, { method: "POST", headers: hud, body: JSON.stringify(body) });
      const answer = (await response.json()) as { sendId?: string; text?: string; error?: string };
      if (!response.ok || !answer.sendId || typeof answer.text !== "string") throw new Error(`send: ${answer.error ?? response.status}`);
      return { sendId: answer.sendId, text: answer.text };
    },
    async ask(question, extra = {}) {
      const response = await fetch(`${url}/api/snapshots/ask`, { method: "POST", headers: hud, body: JSON.stringify({ question, ...extra }) });
      if (!response.ok) throw new Error(`ask: ${response.status} ${await response.text()}`);
      const raw = await response.text();
      const messages = raw
        .split("\n\n")
        .map((chunk) => chunk.replace(/^data: /, "").trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const text = messages
        .map((message) => (message.type === "text_delta" && typeof message.delta === "string" ? message.delta : ""))
        .join("");
      return { text, messages };
    },
    state,
    async waitForState(check, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const current = await state();
        if (check(current)) return current;
        if (Date.now() > deadline) throw new Error(`hub state never matched: ${JSON.stringify({ connections: current.connections, lastSent: current.lastSent })}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}

export function tempSnapshotsDataDir(): string {
  return mkdtempSync(join(tmpdir(), "plannotator-snapshots-data-"));
}
