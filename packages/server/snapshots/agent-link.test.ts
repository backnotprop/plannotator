/**
 * The Pi / OpenCode link to the Plannotator Snapshots hub
 * (packages/shared/snapshots/agent-link.ts) against a REAL hub in this
 * process, driven the way the HUD drives it: a send arrives in the session
 * once (even while the session takes longer than the hub's re-send
 * interval), Ask is answered by the session's own bridge with the Snapshots
 * surface line, and a second process of the same session never delivers a
 * send the first one took.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runPullSessionBridgeClient } from "@plannotator/ai/session-bridge-pull-client";
import type { SessionBridge, SessionBridgeAskRequest } from "@plannotator/ai/session-bridge";
import { SnapshotsAgentLink, summonSnapshots, SNAPSHOTS_MACOS_ONLY_TEXT } from "@plannotator/shared/snapshots/agent-link";
import { startTestSnapshotsHub, tempSnapshotsDataDir, type TestSnapshotsHub } from "../../../tests/helpers/snapshots-hub";
import { SNAPSHOTS_ASK_SURFACE } from "./connections";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function fakeBridge(answer: string): SessionBridge & { asked: SessionBridgeAskRequest[] } {
  const asked: SessionBridgeAskRequest[] = [];
  return {
    host: "pi",
    modes: { turn: true, transient: false },
    asked,
    status: () => "ready",
    ask(req, sink) {
      asked.push(req);
      setTimeout(() => {
        sink.delta(answer);
        sink.done(answer);
      }, 10);
    },
  };
}

async function world(): Promise<{ hub: TestSnapshotsHub; dataDir: string }> {
  const dataDir = tempSnapshotsDataDir();
  const hub = await startTestSnapshotsHub(dataDir);
  cleanups.push(() => {
    hub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { hub, dataDir };
}

function link(dataDir: string, sessionId: string, options: { processId?: string; deliver: (text: string) => Promise<void>; bridge?: SessionBridge }) {
  const created = new SnapshotsAgentLink({
    dataDir,
    host: "pi",
    sessionId,
    processId: options.processId ?? "proc-a",
    cwd: process.cwd(),
    bridge: options.bridge ?? fakeBridge(""),
    ask: { turn: true, transient: false },
    target: { deliver: options.deliver, isBusy: () => false },
    runClient: runPullSessionBridgeClient,
    retryMs: 50,
  });
  cleanups.push(() => created.dispose());
  created.start();
  return created;
}

describe("Snapshots agent link", () => {
  test("the person's Send arrives in the linked session exactly once, even when the session takes longer than the re-send interval", async () => {
    const { hub, dataDir } = await world();
    const delivered: string[] = [];
    link(dataDir, "s-1", {
      deliver: async (text) => {
        delivered.push(text);
        // Longer than the hub's 5 s re-send: the re-sent `deliver` must not be a second turn.
        await new Promise((resolve) => setTimeout(resolve, 6_000));
      },
    });
    await hub.waitForState((state) => state.connections.some((c: { sessionId: string }) => c.sessionId === "s-1"));
    await hub.summon("pi", "s-1");
    const { collectionId } = await hub.capture();
    const sent = await hub.send(collectionId);
    const state = await hub.waitForState((current) => current.lastSent?.send?.state === "delivered", 15_000);
    expect(state.lastSent.send.sendId).toBe(sent.sendId);
    expect(delivered).toEqual([sent.text]);
    expect(sent.text).toStartWith("Plannotator: 1 snapshot");
  }, 20_000);

  test("Ask from the HUD is a turn of the linked session, framed with the Snapshots surface", async () => {
    const { hub, dataDir } = await world();
    const bridge = fakeBridge("It is the login button.");
    link(dataDir, "s-ask", { deliver: async () => undefined, bridge });
    await hub.waitForState((state) => state.connections.some((c: { sessionId: string; canAsk: boolean }) => c.sessionId === "s-ask" && c.canAsk));
    const answer = await hub.ask("What is this?", { host: "pi", sessionId: "s-ask" });
    expect(answer.text).toBe("It is the login button.");
    expect(bridge.asked).toHaveLength(1);
    expect(bridge.asked[0]!.text).toContain(SNAPSHOTS_ASK_SURFACE);
    expect(bridge.asked[0]!.text).toContain("What is this?");
  });

  test("two processes of one session: only one delivers a send", async () => {
    const { hub, dataDir } = await world();
    const delivered: string[] = [];
    const deliver = async (text: string) => {
      delivered.push(text);
    };
    link(dataDir, "s-two", { processId: "proc-a", deliver });
    link(dataDir, "s-two", { processId: "proc-b", deliver });
    await hub.waitForState((state) => state.connections.some((c: { sessionId: string }) => c.sessionId === "s-two"));
    await hub.summon("pi", "s-two");
    const { collectionId } = await hub.capture();
    const sent = await hub.send(collectionId);
    await hub.waitForState((current) => current.lastSent?.send?.state === "delivered");
    // Give a late re-send the chance to land on the other process.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(delivered).toEqual([sent.text]);
  });

  test("summon off macOS explains and starts nothing", async () => {
    const answer = await summonSnapshots({ dataDir: "/nonexistent", host: "pi", sessionId: "x", args: "", cwd: process.cwd(), platform: "linux" });
    expect(answer).toEqual({ ok: false, text: SNAPSHOTS_MACOS_ONLY_TEXT });
  });
});
