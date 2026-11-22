/**
 * Where the person wrote a message, as the agent reads it (inbox-sent-from.ts, packages/core/inbox-sent-from.ts).
 * What regresses: the server guessing a place it cannot vouch for (a loopback request, this computer's own tailnet
 * page, a phone claiming a place, a stored value of another shape); a place it can vouch for dropping out of a read an
 * agent has (the delivered turn, read_thread's text, its JSON); a message from this computer, or an older one, reading
 * any differently than before. No server: the store under a temp folder and the pure parts. The same through the real
 * listeners and a linked machine's forward is in inbox-tailnet-owner.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxSentFromLine, inboxSentFromOf, inboxSentFromPlaceOf, type InboxMessage, type InboxSentFrom, type InboxSentFromPlace } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxBodyForAgent } from "@plannotator/shared/inbox/uploads";
import { AGENT_PLATFORM, MACHINE_PLATFORM } from "./inbox-devices";
import { agentMessage, agentMessageLine, inboxFullReadLines, messageLineText, messageText } from "./inbox-mcp-read";
import { InboxOutbox } from "./inbox-outbox";
import { inboxForwardedPlace, inboxRequestSentFrom, type InboxSentFromFacts } from "./inbox-sent-from";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-sent-from-"));
  roots.push(root);
  return join(root, "data");
}

const LOCAL: InboxSentFromFacts = { via: "local", ownNode: false, cloudflare: false, door: null };
const door = (platform: string, machineName: string | null = null, place: InboxSentFromPlace | null = null): InboxSentFromFacts => ({ ...LOCAL, door: { platform, machineName, place } });

describe("what the server can vouch for, from the request alone", () => {
  const CASES: { name: string; facts: InboxSentFromFacts; from: InboxSentFrom | null }[] = [
    { name: "this computer's window (the loopback port)", facts: LOCAL, from: null },
    { name: "another device over the tailnet listener", facts: { ...LOCAL, via: "tailnet" }, from: { kind: "tailnet" } },
    { name: "this computer's own browser on its tailnet address", facts: { ...LOCAL, via: "tailnet", ownNode: true }, from: null },
    { name: "the Cloudflare Access door (dispatched as the tailnet)", facts: { ...LOCAL, via: "tailnet", cloudflare: true }, from: { kind: "cloudflare" } },
    { name: "a paired phone through the device door", facts: door("ios"), from: { kind: "phone" } },
    { name: "a phone saying it was somewhere else: its word never counts", facts: door("android", null, "tailnet"), from: { kind: "phone" } },
    { name: "a linked computer's own window", facts: door(MACHINE_PLATFORM, "Ada's MacBook"), from: { kind: "machine", name: "Ada's MacBook" } },
    { name: "a linked computer, the person on its tailnet", facts: door(MACHINE_PLATFORM, "Ada's MacBook", "tailnet"), from: { kind: "machine", name: "Ada's MacBook", via: "tailnet" } },
    { name: "a linked computer with no name the Inbox knows", facts: door(MACHINE_PLATFORM, "  "), from: null },
    { name: "a cloud agent's device: never the person", facts: door(AGENT_PLATFORM), from: null },
  ];
  for (const { name, facts, from } of CASES) {
    test(name, () => expect(inboxRequestSentFrom(facts)).toEqual(from));
  }

  test("a linked computer says on only where the person was away from it, never another computer's word", () => {
    expect(inboxForwardedPlace(null)).toBeNull();
    expect(inboxForwardedPlace({ kind: "tailnet" })).toBe("tailnet");
    expect(inboxForwardedPlace({ kind: "phone" })).toBe("phone");
    expect(inboxForwardedPlace({ kind: "machine", name: "Bob's Mini", via: "tailnet" })).toBeNull();
  });

  test("the forwarded header: one of the places, else nothing", () => {
    expect(inboxSentFromPlaceOf("tailnet")).toBe("tailnet");
    expect(inboxSentFromPlaceOf(" Cloudflare ")).toBe("cloudflare");
    for (const value of [null, undefined, "", "machine", "localhost", "tailnet; phone"]) expect(inboxSentFromPlaceOf(value)).toBeNull();
  });

  test("the outbox holds the place with the write, so a retry after a restart still says it", () => {
    const dir = dataDir();
    const machine = "ibx_01K00000000000000000000000";
    InboxOutbox.open(dir).submit(machine, "messages/msg_1/reply", { idempotency_key: "k1", words: "yes" }, null, true, "tailnet");
    InboxOutbox.open(dir).submit(machine, "messages/msg_1/reply", { idempotency_key: "k2", words: "no" }, null, true, null);
    const reopened = InboxOutbox.open(dir);
    expect(reopened.get("k1")?.sent_from).toBe("tailnet");
    expect(reopened.get("k2")).not.toHaveProperty("sent_from");
  });
});

describe("the line an agent reads", () => {
  test("each place the server vouches for is one line saying it is not this computer; anything else is none", () => {
    const places: InboxSentFrom[] = [{ kind: "tailnet" }, { kind: "cloudflare" }, { kind: "phone" }, { kind: "machine", name: "Ada's MacBook" }, { kind: "machine", name: "Ada's MacBook", via: "phone" }];
    const lines = places.map((sent_from) => inboxSentFromLine({ sent_from }));
    for (const line of lines) {
      expect(line).not.toBe("");
      expect(line.split("\n")).toHaveLength(1);
      expect(line).toContain("not from this computer");
    }
    expect(new Set(lines).size).toBe(places.length);
    expect(lines[3]).toContain("`Ada's MacBook`");
    for (const sent_from of [undefined, null, "tailnet", {}, { kind: "localhost" }, { kind: "machine" }, { kind: "machine", name: "\u0000​ " }]) {
      expect(inboxSentFromLine({ sent_from })).toBe("");
    }
  });

  test("a machine's name is one quoted line: no line break, no backtick that closes the quote", () => {
    const read = inboxSentFromOf({ kind: "machine", name: "Mini`\n‮evil", via: "nowhere" });
    expect(read).toEqual({ kind: "machine", name: "Mini' evil" });
    expect(inboxSentFromLine({ sent_from: { kind: "machine", name: "x".repeat(500) } }).length).toBeLessThan(200);
  });
});

describe("every read an agent has, from the store", () => {
  const WORDS = "send me the link to the preview you built";
  function world() {
    const dir = dataDir();
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "shop", root: "/work/shop" });
    const asked = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses-a", name: "Claude Code" }, body: "The preview is up.", idempotency_key: "a1" }).message;
    return { dir, store, project, asked };
  }
  const context = (rootId: string) => ({ previousId: null, previousDate: null, rootId });

  test("a reply from another device: the line under the words in the delivered turn, read_thread's text, its line and its JSON; the stored body stays the words", () => {
    const { dir, store, asked } = world();
    const { reply } = store.sendReply(asked.id, { idempotency_key: "r1", words: WORDS, sent_from: { kind: "tailnet" } });
    const line = inboxSentFromLine(reply);
    expect(line).not.toBe("");
    expect(reply.body).toBe(WORDS);
    // Kept on disk, read back by the next start.
    const stored = InboxStore.open(dir).message(reply.id)!;
    expect(stored.sent_from).toEqual({ kind: "tailnet" });
    expect(inboxBodyForAgent(stored)).toBe(`${WORDS}\n\n${line}`);
    const wire = store.thread(asked.thread_id)!.messages.at(-1)!;
    expect(messageText(agentMessage(wire), context(asked.thread_id))).toContain(`${WORDS}\n${line}`);
    expect(messageLineText(agentMessageLine(wire), context(asked.thread_id))).toContain(line);
    expect(agentMessage(wire).sent_from).toBe(line);
    expect(inboxFullReadLines(wire).sent_from).toBe(line);
  });

  test("a new thread the person started from the phone app carries it too", () => {
    const { store, project } = world();
    const { message } = store.startPersonThread({ project_id: project.id, body: WORDS, to: { host: "claude-code", session: "ses-a" }, idempotency_key: "n1", sent_from: { kind: "phone" } });
    expect(inboxBodyForAgent(message)).toBe(`${WORDS}\n\n${inboxSentFromLine({ sent_from: { kind: "phone" } })}`);
  });

  test("a reply from this computer, and one an older Inbox wrote, read exactly as before", () => {
    const { store, asked } = world();
    const { reply } = store.sendReply(asked.id, { idempotency_key: "r2", words: WORDS, sent_from: null });
    expect(reply).not.toHaveProperty("sent_from");
    expect(inboxBodyForAgent(reply)).toBe(WORDS);
    const wire = store.thread(asked.thread_id)!.messages.at(-1)!;
    expect(agentMessage(wire)).not.toHaveProperty("sent_from");
    expect(inboxFullReadLines(wire)).toBe(wire as never);
    // A value of another shape (a newer Inbox wrote it): no line, and nothing else changes.
    const odd = { ...wire, sent_from: { kind: "satellite" } } as unknown as InboxMessage;
    expect(inboxBodyForAgent(odd)).toBe(WORDS);
    expect(agentMessage(odd as never)).not.toHaveProperty("sent_from");
    expect(inboxFullReadLines(odd)).not.toHaveProperty("sent_from");
  });
});
