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
import { inboxSentFromLine, inboxSentFromName, inboxSentFromOf, inboxSentFromPlaceOf, type InboxMessage, type InboxSentFrom, type InboxSentFromPlace } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxBodyForAgent } from "@plannotator/shared/inbox/uploads";
import { AGENT_PLATFORM, MACHINE_PLATFORM } from "./inbox-devices";
import { agentMessage, agentMessageLine, inboxFullReadLines, messageLineText, messageText } from "./inbox-mcp-read";
import { InboxOutbox } from "./inbox-outbox";
import { createInboxLiveSessions } from "./inbox-sessions";
import { inboxForwardedPlace, inboxRequestSentFrom, type InboxSentFromFacts } from "./inbox-sent-from";
import { inboxFarReaderName, inboxMachineRecordName, inboxMessageForReader, inboxSentFromForReader, inboxSentFromReader } from "./inbox-sent-from-reader";
import { reaskThreadAll } from "@plannotator/shared/inbox/reask-all";

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
    { name: "this computer's window, with its marks: here", facts: { ...LOCAL, window: true }, from: { kind: "here" } },
    { name: "this computer's own browser on its tailnet address, with the window's marks: here", facts: { ...LOCAL, via: "tailnet", ownNode: true, window: true }, from: { kind: "here" } },
    { name: "another device over the tailnet, with the window's marks: still the tailnet", facts: { ...LOCAL, via: "tailnet", window: true }, from: { kind: "tailnet" } },
    { name: "the Cloudflare door, with the window's marks: still Cloudflare", facts: { ...LOCAL, via: "tailnet", cloudflare: true, window: true }, from: { kind: "cloudflare" } },
    { name: "a linked computer's forward is never here", facts: { ...door(MACHINE_PLATFORM, "Ada's MacBook"), window: true }, from: { kind: "machine", name: "Ada's MacBook" } },
  ];
  for (const { name, facts, from } of CASES) {
    test(name, () => expect(inboxRequestSentFrom(facts)).toEqual(from));
  }

  test("a linked computer's name is recorded clean, as the line reads it; an empty one falls back to its device's name", () => {
    const named = (machineName: string | null, deviceName: string | null = null) => inboxRequestSentFrom({ ...LOCAL, door: { platform: MACHINE_PLATFORM, machineName, deviceName, place: null } });
    expect(named("Mini`\n\u202eevil")).toEqual({ kind: "machine", name: "Mini' evil" });
    expect(named("", "Bob's Mini")).toEqual({ kind: "machine", name: "Bob's Mini" });
    expect(named("\u0000\u200b ", "Bob's Mini")).toEqual({ kind: "machine", name: "Bob's Mini" });
    expect(named(null, "Bob's Mini")).toEqual({ kind: "machine", name: "Bob's Mini" });
    expect(named("Ada's MacBook", "Bob's Mini")).toEqual({ kind: "machine", name: "Ada's MacBook" });
    expect(named("", " ")).toBeNull();
    // Long: cut to 64, and the record reads back as it was written.
    const long = named("x".repeat(500)) as { name: string };
    expect(long.name.length).toBe(64);
    expect(inboxSentFromOf(long)).toEqual(long);
  });

  test("a long name is cut between whole characters: an emoji is never split", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    for (let pad = 50; pad < 64; pad++) {
      const name = inboxSentFromName(`${"a".repeat(pad)}${family.repeat(4)}`);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name.endsWith("…")).toBe(true);
      const kept = name.slice(pad, -1);
      expect(kept.length % family.length).toBe(0);
      expect(kept).toBe(family.repeat(kept.length / family.length));
    }
  });

  test("a linked computer says on only where the person was away from it, never another computer's word", () => {
    expect(inboxForwardedPlace(null)).toBeNull();
    expect(inboxForwardedPlace({ kind: "tailnet" })).toBe("tailnet");
    expect(inboxForwardedPlace({ kind: "phone" })).toBe("phone");
    expect(inboxForwardedPlace({ kind: "machine", name: "Bob's Mini", via: "tailnet" })).toBeNull();
    // Its own window: nothing to say on.
    expect(inboxForwardedPlace({ kind: "here" })).toBeNull();
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
    for (const sent_from of [undefined, null, "tailnet", {}, { kind: "localhost" }, { kind: "machine" }, { kind: "machine", name: "\u0000​ " }, { kind: "here" }]) {
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

  test("a New message in a thread from another device carries it; one from this computer carries nothing", () => {
    const { dir, store, asked } = world();
    const to = { host: "claude-code", session: "ses-a" };
    const away = store.sendNewMessage(asked.thread_id, { body: WORDS, to, idempotency_key: "m1", sent_from: { kind: "cloudflare" } }).message;
    expect(away.body).toBe(WORDS);
    const stored = InboxStore.open(dir).message(away.id)!;
    expect(stored.sent_from).toEqual({ kind: "cloudflare" });
    expect(inboxBodyForAgent(stored)).toBe(`${WORDS}\n\n${inboxSentFromLine({ sent_from: { kind: "cloudflare" } })}`);
    const here = store.sendNewMessage(asked.thread_id, { body: WORDS, to, idempotency_key: "m2", sent_from: null }).message;
    expect(here).not.toHaveProperty("sent_from");
    expect(inboxBodyForAgent(here)).toBe(WORDS);
  });

  test("a Re-ask pressed on the phone carries it", () => {
    const { store, project } = world();
    const asked = store.sendMessage({
      project_id: project.id,
      author: { kind: "agent", host: "claude-code", session: "ses-a", name: "Claude Code" },
      body: ":::question\nWhich region?\n\n- [ ] EU\n- [ ] US\n:::",
      idempotency_key: "a2",
    }).message;
    const { reply } = store.sendReask(asked.id, { idempotency_key: "q1", sent_from: { kind: "phone" } });
    expect(reply.sent_from).toEqual({ kind: "phone" });
    expect(inboxBodyForAgent(reply)).toContain(inboxSentFromLine({ sent_from: { kind: "phone" } }));
  });

  test("the thread's New message route records what the server told from the request, and nothing without it", async () => {
    const { store, asked } = world();
    const live = createInboxLiveSessions({ store, serverSession: "srv", resolveRoot: async (path) => path });
    (await live.pollStarted("ses-a", "claude-code", {}))();
    const send = async (key: string, sentFrom?: () => InboxSentFrom | null) => {
      const req = new Request(`http://127.0.0.1:4000/api/inbox/threads/${asked.thread_id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "ses-a", body: WORDS, idempotency_key: key }),
      });
      const response = await live.route(req, new URL(req.url).pathname, sentFrom);
      expect(response?.status).toBe(200);
      return store.message(((await response!.json()) as { message: InboxMessage }).message.id)!;
    };
    const tailnet = await send("m1", () => inboxRequestSentFrom({ ...LOCAL, via: "tailnet" }));
    expect(tailnet.sent_from).toEqual({ kind: "tailnet" });
    expect(inboxBodyForAgent(tailnet)).toBe(`${WORDS}\n\n${inboxSentFromLine({ sent_from: { kind: "tailnet" } })}`);
    const forwarded = await send("m2", () => inboxRequestSentFrom(door(MACHINE_PLATFORM, "Ada's MacBook", "phone")));
    expect(forwarded.sent_from).toEqual({ kind: "machine", name: "Ada's MacBook", via: "phone" });
    expect(await send("m3", () => inboxRequestSentFrom(LOCAL))).not.toHaveProperty("sent_from");
    expect(await send("m4")).not.toHaveProperty("sent_from");
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

describe("an agent on a linked computer reads the thread here (a far read)", () => {
  // This computer is "MacBook" to the reader, which this Inbox calls "Studio".
  const STUDIO = inboxSentFromReader("Studio", "MacBook");
  const CASES: { name: string; sent_from?: unknown; reader?: ReturnType<typeof inboxSentFromReader>; from: InboxSentFrom | null }[] = [
    { name: "written in the reader's own window: its own computer, no line", sent_from: { kind: "machine", name: "Studio" }, from: null },
    { name: "on the phone through the reader's computer: the phone, as the reader's own record would say", sent_from: { kind: "machine", name: "Studio", via: "phone" }, from: { kind: "phone" } },
    { name: "over the reader's tailnet: the tailnet", sent_from: { kind: "machine", name: "Studio", via: "tailnet" }, from: { kind: "tailnet" } },
    { name: "in this computer's own window (here): this computer, as the reader shows it", sent_from: { kind: "here" }, from: { kind: "machine", name: "MacBook" } },
    { name: "no record (a program's write, an Inbox note, a message older than the records): no line, as before", from: null },
    { name: "over this computer's tailnet: as it is", sent_from: { kind: "tailnet" }, from: { kind: "tailnet" } },
    { name: "through this computer's Cloudflare door: as it is", sent_from: { kind: "cloudflare" }, from: { kind: "cloudflare" } },
    { name: "this computer's phone app: as it is", sent_from: { kind: "phone" }, from: { kind: "phone" } },
    { name: "a third computer: as it is", sent_from: { kind: "machine", name: "Mini", via: "tailnet" }, from: { kind: "machine", name: "Mini", via: "tailnet" } },
    { name: "a record of another shape: none, as a local read", sent_from: { kind: "satellite" }, from: null },
    { name: "an older reader that names nothing: here says nothing", sent_from: { kind: "here" }, reader: inboxSentFromReader("Studio", null), from: null },
    { name: "a reader whose name is not known (none, or shared): its forwards read as a linked computer", sent_from: { kind: "machine", name: "Studio" }, reader: inboxSentFromReader("", "MacBook"), from: { kind: "machine", name: "Studio" } },
  ];
  for (const { name, sent_from, reader, from } of CASES) {
    test(name, () => expect(inboxSentFromForReader(sent_from === undefined ? {} : { sent_from }, reader ?? STUDIO)).toEqual(from));
  }

  test("the reader is told from what this Inbox records for its computer, so a forward and a read agree by construction", () => {
    for (const [machineName, deviceName] of [["Studio", null], ["", "Bob's Mini"], ["Mini`\n\u202eevil", null]] as const) {
      const recorded = inboxRequestSentFrom({ ...LOCAL, door: { platform: MACHINE_PLATFORM, machineName, deviceName, place: null } });
      const reader = inboxSentFromReader(inboxFarReaderName(inboxMachineRecordName(machineName, deviceName), ["Mini"]), "MacBook");
      expect(inboxSentFromForReader({ sent_from: recorded }, reader)).toBeNull();
    }
  });

  test("two linked computers recording the same name: neither is taken for the reader's own", () => {
    expect(inboxFarReaderName("Studio", ["Mini"])).toBe("Studio");
    expect(inboxFarReaderName("Studio", ["Mini", "Studio"])).toBe("");
    expect(inboxFarReaderName("", ["Mini"])).toBe("");
    const shared = inboxSentFromReader(inboxFarReaderName("Studio", ["Studio"]), "MacBook");
    expect(inboxSentFromForReader({ sent_from: { kind: "machine", name: "Studio" } }, shared)).toEqual({ kind: "machine", name: "Studio" });
  });

  test("the name the reader says for this computer is cleaned as a record's name: one line, no backtick, at most 64", () => {
    const said = `Mac\`Book\n\u202e${"x".repeat(80)}`;
    const from = inboxSentFromForReader({ sent_from: { kind: "here" } }, inboxSentFromReader("Studio", said));
    expect(from).toEqual({ kind: "machine", name: inboxSentFromName(said) });
    expect(inboxSentFromLine({ sent_from: from })).not.toContain("\n");
    expect((from as { name: string }).name.length).toBeLessThanOrEqual(64);
  });

  test("a message moved to the reader's side keeps everything else; none left means no field", () => {
    const own = { id: "m1", body: "Yes.", sent_from: { kind: "machine", name: "Studio" } };
    expect(inboxMessageForReader(own, STUDIO)).toEqual({ id: "m1", body: "Yes." });
    expect(inboxMessageForReader(own, STUDIO)).not.toHaveProperty("sent_from");
    expect(inboxMessageForReader({ id: "m2", body: "Yes.", sent_from: { kind: "here" } }, STUDIO).sent_from).toEqual({ kind: "machine", name: "MacBook" });
  });
});

describe("this computer's own window records here, and no reader on this computer sees it", () => {
  const WORDS = "send me the link to the preview you built";
  const both = () => {
    const store = InboxStore.open(dataDir());
    const project = store.ensureProject({ name: "shop", root: "/work/shop" });
    const ask = (key: string) => store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses-a", name: "Claude Code" }, body: "The preview is up.", idempotency_key: key }).message;
    // Two replies to one message, so their reads differ only by their ids.
    const asked = ask("a1");
    const plain = store.sendReply(asked.id, { idempotency_key: "r1", words: WORDS }).reply;
    const here = store.sendReply(asked.id, { idempotency_key: "r2", words: WORDS, sent_from: { kind: "here" } }).reply;
    const wire = (m: InboxMessage) => store.thread(m.thread_id)!.messages.find((w) => w.id === m.id)!;
    return { store, plain, here, wire };
  };
  const context = (rootId: string) => ({ previousId: null, previousDate: null, rootId });

  test("the delivered turn, read_thread's text, its one line, its JSON and format full read as a reply with no record", () => {
    const { store, plain, here, wire } = both();
    expect(store.message(here.id)!.sent_from).toEqual({ kind: "here" });
    expect(inboxBodyForAgent(store.message(here.id)!)).toBe(inboxBodyForAgent(store.message(plain.id)!));
    expect(inboxBodyForAgent(store.message(here.id)!)).toBe(WORDS);
    const [a, b] = [agentMessage(wire(here)), agentMessage(wire(plain))];
    expect(a).not.toHaveProperty("sent_from");
    expect(messageText(a, context(wire(here).thread_id)).replace(wire(here).id, "")).toBe(messageText(b, context(wire(plain).thread_id)).replace(wire(plain).id, ""));
    const [la, lb] = [agentMessageLine(wire(here)), agentMessageLine(wire(plain))];
    expect(la).not.toHaveProperty("sent_from");
    expect(messageLineText(la, context(wire(here).thread_id)).replace(wire(here).id, "")).toBe(messageLineText(lb, context(wire(plain).thread_id)).replace(wire(plain).id, ""));
    const full = inboxFullReadLines(wire(here));
    expect(full).not.toHaveProperty("sent_from");
    expect(Object.keys(full)).toEqual(Object.keys(wire(plain)));
    // The same record, byte for byte, as if it had none.
    const { sent_from: _here, ...bare } = wire(here);
    expect(JSON.stringify(full)).toBe(JSON.stringify(bare));
  });

  test("Re-ask all records where the person pressed it on every note, as a single Re-ask", () => {
    const store = InboxStore.open(dataDir());
    const project = store.ensureProject({ name: "shop", root: "/work/shop" });
    const block = [":::question", "Ship it?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
    const asked = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses-a", name: "Claude Code" }, body: block, idempotency_key: "q1" }).message;
    const result = reaskThreadAll(store, asked.thread_id, "press-1", () => true, { kind: "tailnet" });
    expect(result.asked).toHaveLength(1);
    const note = store.message(result.asked[0]!.reply_id)!;
    expect(note.sent_from).toEqual({ kind: "tailnet" });
    expect(inboxBodyForAgent(note)).toContain(inboxSentFromLine({ sent_from: { kind: "tailnet" } }));
  });
});
