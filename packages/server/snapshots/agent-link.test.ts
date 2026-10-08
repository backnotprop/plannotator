/**
 * The Pi / OpenCode link to the Plannotator Snapshots hub
 * (packages/shared/snapshots/agent-link.ts) against a REAL hub in this
 * process, driven the way the HUD drives it: a send arrives in the session
 * once (even while the session takes longer than the hub's re-send
 * interval), Ask is answered by the session's own bridge with the Snapshots
 * surface line, two processes of one session leave sends and Ask to the one
 * the person used last, and nothing is made before a hub exists.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runPullSessionBridgeClient } from "@plannotator/ai/session-bridge-pull-client";
import type { SessionBridge, SessionBridgeAskRequest } from "@plannotator/ai/session-bridge";
import {
  SnapshotsAgentLink,
  summonSnapshots,
  SNAPSHOTS_MACOS_ONLY_TEXT,
  SNAPSHOTS_UPDATE_TEXT,
} from "@plannotator/shared/snapshots/agent-link";
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

function link(
  dataDir: string,
  sessionId: string,
  options: { processId?: string; deliver: (text: string) => Promise<void>; bridge?: SessionBridge; onBridge?: () => void },
) {
  const bridge = options.bridge ?? fakeBridge("");
  const created = new SnapshotsAgentLink({
    dataDir,
    host: "pi",
    sessionId,
    processId: options.processId ?? "proc-a",
    cwd: process.cwd(),
    createBridge: () => {
      options.onBridge?.();
      return bridge;
    },
    ask: { turn: true, transient: false },
    target: { deliver: options.deliver, isBusy: () => false },
    runClient: runPullSessionBridgeClient,
    retryMs: 50,
    leaseEveryMs: 100,
  });
  cleanups.push(() => created.dispose());
  created.start();
  return created;
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

  // Two processes of one session (`pi -c` twice) share ONE hub connection.
  // The failure: a Send or an Ask lands in whichever process held the poll,
  // not the one the person is using.
  test("two processes of one session: sends and Ask go to the process the person used last, and follow them when they switch", async () => {
    const { hub, dataDir } = await world();
    const delivered: Array<{ by: string; text: string }> = [];
    const bridgeA = fakeBridge("from A");
    const bridgeB = fakeBridge("from B");
    const a = link(dataDir, "s-two", { processId: "proc-a", bridge: bridgeA, deliver: async (text) => void delivered.push({ by: "a", text }) });
    await until(() => a.connected);
    // The person starts a second process on the session: it is the one in use now.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const b = link(dataDir, "s-two", { processId: "proc-b", bridge: bridgeB, deliver: async (text) => void delivered.push({ by: "b", text }) });
    await until(() => b.connected && !a.connected && !a.isLeader);

    await hub.summon("pi", "s-two");
    const first = await hub.send((await hub.capture()).collectionId);
    await hub.waitForState((current) => current.lastSent?.send?.sendId === first.sendId && current.lastSent.send.state === "delivered");
    expect((await hub.ask("Which one?", { host: "pi", sessionId: "s-two" })).text).toBe("from B");

    // The person types in the first process again: it takes the session back.
    a.noteHumanInput("back here");
    await until(() => a.connected && !b.isLeader);
    const second = await hub.send((await hub.capture()).collectionId);
    await hub.waitForState((current) => current.lastSent?.send?.sendId === second.sendId && current.lastSent.send.state === "delivered");
    expect((await hub.ask("And now?", { host: "pi", sessionId: "s-two" })).text).toBe("from A");

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(delivered).toEqual([
      { by: "b", text: first.text },
      { by: "a", text: second.text },
    ]);
    expect(bridgeA.asked).toHaveLength(1);
    expect(bridgeB.asked).toHaveLength(1);
  }, 20_000);

  test("no hub: no bridge is made and nothing connects", async () => {
    const dataDir = tempSnapshotsDataDir();
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    let bridges = 0;
    const idle = link(dataDir, "s-none", { deliver: async () => undefined, onBridge: () => void (bridges += 1) });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bridges).toBe(0);
    expect(idle.connected).toBe(false);
  });

  test("summon off macOS explains and starts nothing", async () => {
    const answer = await summonSnapshots({ dataDir: "/nonexistent", host: "pi", sessionId: "x", args: "", cwd: process.cwd(), platform: "linux" });
    expect(answer).toEqual({ ok: false, text: SNAPSHOTS_MACOS_ONLY_TEXT });
  });

  test("a plannotator from before Snapshots: say to update, not the raw error", async () => {
    const dir = tempSnapshotsDataDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bin = `${dir}/plannotator`;
    await Bun.write(bin, "#!/bin/sh\necho \"Unknown command: snapshot\" >&2\nexit 1\n");
    const { chmodSync } = await import("node:fs");
    chmodSync(bin, 0o755);
    const answer = await summonSnapshots({ dataDir: dir, host: "pi", sessionId: "x", args: "", cwd: process.cwd(), platform: "darwin", env: { ...process.env, PLANNOTATOR_BIN: bin } });
    expect(answer).toEqual({ ok: false, text: SNAPSHOTS_UPDATE_TEXT });
  });
});
