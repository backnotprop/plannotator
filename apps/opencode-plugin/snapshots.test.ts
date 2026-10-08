/**
 * Plannotator Snapshots on OpenCode 2 (snapshots.ts) against a REAL Snapshots
 * hub in this process (tests/helpers/snapshots-hub.ts), through the real
 * plugin setup (server.ts) over a fake OpenCode 2 context whose session
 * domain records prompts and notices and whose event stream the test drives.
 * The person is played through the hub's HUD routes.
 *
 * What regresses if this fails:
 *  - `/plannotator-snapshot` stops being a native command that summons with
 *    the root session (`--session opencode:<root>`) and returns;
 *  - a Send stops arriving as ONE queued prompt with the hub's text;
 *  - Ask from the HUD stops being a turn of the session;
 *  - the command's line starts reaching the model;
 *  - the switch off stops leaving OpenCode untouched (no command, no link).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestSnapshotsHub, tempSnapshotsDataDir, type TestSnapshotsHub } from "../../tests/helpers/snapshots-hub";
import serverPlugin from "./server";
import { SNAPSHOTS_COMMAND } from "./snapshots";
import { dropSessionUrlNotices } from "./v2-client";

const ROOT = "ses_root";
const CHILD = "ses_child";
const cleanups: Array<() => void> = [];
const saved = { dataDir: process.env.PLANNOTATOR_DATA_DIR, bin: process.env.PLANNOTATOR_BIN, snapshots: process.env.PLANNOTATOR_SNAPSHOTS };

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  restore("PLANNOTATOR_DATA_DIR", saved.dataDir);
  restore("PLANNOTATOR_BIN", saved.bin);
  restore("PLANNOTATOR_SNAPSHOTS", saved.snapshots);
});

async function world(): Promise<TestSnapshotsHub> {
  const dataDir = tempSnapshotsDataDir();
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const hub = await startTestSnapshotsHub(dataDir);
  cleanups.push(() => {
    hub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return hub;
}

/** A `plannotator` stand-in that records its arguments and answers like `plannotator snapshot --session`. */
function stubPlannotator(): () => string[] {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-snapshots-bin-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls.log");
  const bin = join(dir, "plannotator");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\necho "Plannotator Snapshots is open: drag a box around what you mean, mark it, and press ⌘↩."\n`);
  chmodSync(bin, 0o755);
  process.env.PLANNOTATOR_BIN = bin;
  return () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
}

function fakeOpenCode() {
  const listeners = new Set<(event: unknown) => void>();
  const prompts: any[] = [];
  const synthetics: any[] = [];
  const commands = new Map<string, { description?: string; execute: (input: any) => Promise<void> }>();
  const contextHooks: Array<(event: { messages: unknown[] }) => unknown> = [];
  const emit = (type: string, data: Record<string, unknown>) => {
    for (const listener of listeners) listener({ type, data });
  };
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const ctx: any = {
    options: { workflow: "manual" },
    location: { directory: process.cwd() },
    agent: { list: async () => ({ data: [] }) },
    command: {
      transform: async (apply: (draft: any) => void) => {
        apply({ add: (definition: any) => commands.set(definition.name, definition) });
        return { dispose: async () => {} };
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ location: { directory: process.cwd() }, ...(sessionID === CHILD ? { parentID: ROOT } : {}) }),
      hook: async (name: string, callback: any) => {
        if (name === "context") contextHooks.push(callback);
        return { dispose: async () => {} };
      },
      prompt: async (input: any) => {
        prompts.push(input);
        // A question from Ask: OpenCode delivers it and the model answers.
        if (input.metadata?.source === "plannotator-ask") {
          setTimeout(() => {
            emit("session.execution.started", { sessionID: input.sessionID });
            emit("session.inbox.delivered", { sessionID: input.sessionID, inboxID: input.id });
            emit("session.step.started", { sessionID: input.sessionID });
            emit("session.text.delta", { sessionID: input.sessionID, assistantMessageID: "m1", ordinal: 0, delta: "That is the Save button." });
            emit("session.step.ended", { sessionID: input.sessionID, finish: "stop" });
            emit("session.execution.succeeded", { sessionID: input.sessionID });
          }, 10);
        }
        return { id: input.id };
      },
      synthetic: async (input: any) => {
        synthetics.push(input);
        return { id: `row_${synthetics.length}` };
      },
      wait: async () => undefined,
      context: async () => [],
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          const queue: unknown[] = [];
          let wake: (() => void) | null = null;
          const listener = (event: unknown) => {
            queue.push(event);
            wake?.();
          };
          listeners.add(listener);
          try {
            while (!signal.aborted && !controller.signal.aborted) {
              if (queue.length) {
                yield queue.shift();
                continue;
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
                signal.addEventListener("abort", () => resolve(), { once: true });
                controller.signal.addEventListener("abort", () => resolve(), { once: true });
              });
              wake = null;
            }
          } finally {
            listeners.delete(listener);
          }
        },
      }),
    },
  };
  return { ctx, prompts, synthetics, commands, contextHooks, emit };
}

describe("Plannotator Snapshots on OpenCode 2", () => {
  test("/plannotator-snapshot summons for the root session and returns; the Send arrives once as a queued prompt", async () => {
    const hub = await world();
    const calls = stubPlannotator();
    const fake = fakeOpenCode();
    await serverPlugin.setup(fake.ctx as never);
    const command = fake.commands.get(SNAPSHOTS_COMMAND);
    expect(command).toBeDefined();

    // From a subagent's session: the root session is the destination.
    await command!.execute({ sessionID: CHILD, prompt: { text: "--app" } });
    if (process.platform === "darwin") {
      expect(calls()).toEqual([`snapshot --session opencode:${ROOT} --app`]);
      expect(fake.synthetics.at(-1)).toMatchObject({ sessionID: CHILD, resume: false, description: expect.stringMatching(/^Plannotator Snapshots is open/) });
    } else {
      expect(calls()).toEqual([]);
      expect(fake.synthetics.at(-1)?.description).toContain("plannotator snapshot add");
    }
    // The line is for the person: the model never reads it.
    const messages: unknown[] = [{ role: "assistant", content: "ok" }, { role: "user", content: fake.synthetics.at(-1).text }, { role: "user", content: "next" }];
    dropSessionUrlNotices(messages);
    expect(messages).toHaveLength(2);
    expect(fake.prompts).toHaveLength(0);

    // What the real `plannotator snapshot --session` does on the hub.
    await hub.summon("opencode", ROOT);
    await hub.waitForState((state) => state.connections.some((c: { host: string; sessionId: string }) => c.host === "opencode" && c.sessionId === ROOT));
    const { collectionId } = await hub.capture();
    const sent = await hub.send(collectionId);
    await hub.waitForState((state) => state.lastSent?.send?.state === "delivered");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const deliveries = fake.prompts.filter((prompt) => prompt.metadata?.source === "plannotator-snapshots");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ sessionID: ROOT, text: sent.text, delivery: "queue" });
  });

  test("a session that runs here links on its own, and Ask from the HUD is a real turn of it", async () => {
    const hub = await world();
    const fake = fakeOpenCode();
    await serverPlugin.setup(fake.ctx as never);
    fake.emit("session.execution.started", { sessionID: ROOT });
    fake.emit("session.execution.succeeded", { sessionID: ROOT });
    await hub.waitForState((state) => state.connections.some((c: { sessionId: string; canAsk: boolean }) => c.sessionId === ROOT && c.canAsk));
    const answer = await hub.ask("What is this button?", { host: "opencode", sessionId: ROOT });
    expect(answer.text).toBe("That is the Save button.");
    const asks = fake.prompts.filter((prompt) => prompt.metadata?.source === "plannotator-ask");
    expect(asks).toHaveLength(1);
    expect(asks[0].text).toContain("What is this button?");
    expect(asks[0].text).toContain("Plannotator Snapshots");
  });

  test("switched off: no command, and no session links to the hub", async () => {
    const hub = await world();
    process.env.PLANNOTATOR_SNAPSHOTS = "0";
    const fake = fakeOpenCode();
    await serverPlugin.setup(fake.ctx as never);
    expect(fake.commands.has(SNAPSHOTS_COMMAND)).toBe(false);
    expect([...fake.commands.keys()]).toEqual(["plannotator-review", "plannotator-annotate", "plannotator-last"]);
    fake.emit("session.execution.started", { sessionID: ROOT });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await hub.state()).connections).toEqual([]);
  });
});
