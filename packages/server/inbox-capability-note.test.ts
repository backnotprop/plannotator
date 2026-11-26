/**
 * An agent on a linked computer turns a switch here: this computer's person sees it here too (inbox-capability-note.ts).
 * In process, no Inbox: the device door with a recorder for the window's route, and a store of its own.
 *
 * What regresses: the note reaching the settings route (which refuses any field it does not know); a note posted for a
 * write that did not apply, or twice for a replayed key; another field slipping past the door with it; words of the
 * other computer's reaching the line (only the switch, the way, a cleaned agent name and this Inbox's own name for that
 * computer); a second turn by the same agent starting a second thread; the line ringing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxDevices } from "./inbox-devices";
import { capabilityNoteLines, capabilityNoteOf, postCapabilityNotes } from "./inbox-capability-note";

type Json = Record<string, any>;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function door(status = 200) {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-capability-note-door-"));
  roots.push(dataDir);
  const handed: { path: string; body: Json }[] = [];
  const noted: { device: string; note: unknown; written: Json }[] = [];
  const devices = createInboxDevices({
    dataDir,
    serverSession: "0".repeat(32),
    port: () => 1,
    registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    dispatch: async (req) => {
      handed.push({ path: new URL(req.url).pathname, body: (await req.json()) as Json });
      return Response.json({ board: { on: true } }, { status });
    },
    noted: (device, note, written) => noted.push({ device: device.name, note, written }),
  });
  const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
  const pair = async (body: Json) => (await (await devices.door(new Request(pairUrl, { method: "POST", body: JSON.stringify(body) }), pairUrl)).json()) as Json;
  const post = (token: string, body: Json) => {
    const url = new URL("http://127.0.0.1/api/inbox/device/capabilities");
    return devices.door(new Request(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), url);
  };
  return { devices, handed, noted, pair, post };
}

describe("a capability turned here by an agent on a linked computer", () => {
  test("the door takes the note, hands the settings route the write alone, and tells it once the write applied", async () => {
    const d = door();
    const machine = await d.pair({ name: "MacBook", platform: "machine", secret: d.devices.machineDoor.openMachineOffer().secret });
    const body = { idempotency_key: "k1", board: { on: true }, capability_note: { agent: "Claude Code", host: "claude-code" } };
    expect((await d.post(machine.token, body)).status).toBe(200);
    expect(d.handed).toEqual([{ path: "/api/inbox/settings", body: { idempotency_key: "k1", board: { on: true } } }]);
    expect(d.noted).toEqual([{ device: "MacBook", note: { agent: "Claude Code", host: "claude-code" }, written: { idempotency_key: "k1", board: { on: true } } }]);
    // The same key again is the first answer: no second line.
    expect((await d.post(machine.token, body)).status).toBe(200);
    expect(d.noted).toHaveLength(1);
    // Any other field is still refused, note or not.
    expect((await d.post(machine.token, { idempotency_key: "k2", board: { on: false }, capability_note: { agent: "x" }, theme: "dark" })).status).toBe(422);
    expect(d.noted).toHaveLength(1);
  });

  test("a write the settings route refused posts nothing", async () => {
    const d = door(422);
    const machine = await d.pair({ name: "MacBook", platform: "machine", secret: d.devices.machineDoor.openMachineOffer().secret });
    await d.post(machine.token, { idempotency_key: "k1", scheduled_threads: { on: true }, capability_note: { agent: "Claude Code" } });
    expect(d.noted).toEqual([]);
  });

  test("the line is made here: the switch and its way from the write, the agent's name cleaned, nothing else of theirs", () => {
    // No control character, markdown or link survives, and it is one short line.
    expect(capabilityNoteOf({ agent: "Claude\u0007 Code\n\n[click](https://x) @here " + "y".repeat(80), host: "claude code; rm" })).toEqual({ agent: `Claude Code click https x here ${"y".repeat(29)}`, host: null });
    expect(capabilityNoteOf({ agent: "   " })).toEqual({ agent: "An agent", host: null });
    expect(capabilityNoteOf("Turned off everything")).toBeNull();
    expect(capabilityNoteLines({ agent: "Codex", host: "codex" }, "MacBook", { idempotency_key: "k", scheduled_threads: { on: true }, words: "ignored" })).toEqual(["Codex on MacBook turned on Routines."]);
  });

  test("posted as that agent with no session here, an Inbox note with no sound; the same agent's next turn lands in its thread", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-capability-note-store-"));
    roots.push(dir);
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "~", root: dir });
    const note = { agent: "Claude Code", host: "claude-code" };
    const first = postCapabilityNotes(store, project.id, note, "MacBook", { board: { on: false } })!;
    const second = postCapabilityNotes(store, project.id, note, "MacBook", { scheduled_threads: { on: true } })!;
    expect(second).toBe(first);
    const messages = store.thread(first)!.messages;
    expect(messages.map((m) => m.body)).toEqual(["Claude Code on MacBook turned off Board.", "Claude Code on MacBook turned on Routines."]);
    expect(messages.map((m) => [m.author, m.launch_note])).toEqual([
      [{ kind: "agent", host: "claude-code", session: null, name: "Claude Code" }, true],
      [{ kind: "agent", host: "claude-code", session: null, name: "Claude Code" }, true],
    ]);
    // Another agent there gets its own thread.
    expect(postCapabilityNotes(store, project.id, { agent: "Codex", host: "codex" }, "MacBook", { board: { on: true } })).not.toBe(first);
  });
});
