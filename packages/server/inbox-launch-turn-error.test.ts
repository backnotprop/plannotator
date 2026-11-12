/**
 * A launched session's turn that ended in an error it wrote down (Claude Code's transcript; approval
 * "inbox-failed-turn-note"), on a real launch engine over a temp data dir with the engine's fake host. What each
 * test guards: the error becomes ONE note in the thread however often the sweep reads it, an Inbox restart
 * included; only a session this Inbox launched is ever read; the next good turn clears the run line and keeps the
 * note; a long, many-line error is one line of 300 characters at most, cut between words and never inside a link;
 * Try again sends the person's message to the session again (a plain reply a read had settled included), and the
 * old error never comes back after it. Claude Code's transcript reader: the last turn's error entry, every error
 * kind alike, a line cut short or a tool's result never mistaken for the turn's end, a capped, read-only read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";
import { CLAUDE_TRANSCRIPT_TAIL_BYTES, claudeTranscriptPath, claudeTranscriptTurnError, claudeTurnErrorOf } from "./inbox-launch-claude";
import { launchTurnErrorNote, type LaunchTurnError } from "./inbox-launch-host";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function setEnv(name: string, value: string) {
  const before = process.env[name];
  process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-turn-error-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "project");
  for (const dir of [dataDir, home, folder]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const clock = { now: Date.parse("2026-11-11T15:00:00.000Z") };
  const store = InboxStore.open(dataDir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "project", root: folder });
  /** What the fake session's last turn ended in, by session; and every session the engine asked about. */
  const errors = new Map<string, LaunchTurnError | null>();
  const asked: string[] = [];
  const fake = fakeLaunchHost();
  fake.host.turnError = (_launch, session) => (asked.push(session), errors.get(session) ?? null);
  const engine = () => {
    const made = createInboxLaunch({
      store,
      live: { runStateOf: () => null },
      dataDir,
      serverSession: "srv",
      homeDir: home,
      platform: "darwin",
      loginEnv: async () => ({ HOME: home, PATH: "" }),
      ownEnv: () => ({ HOME: home, PATH: "" }),
      installDirs: [],
      displayFolder: (path) => path,
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      json: (body, status = 200) => Response.json(body, { status }),
      onChange: () => {},
      selfCommand: ["plannotator"],
      hosts: () => [fake.host],
      now: () => clock.now,
    });
    restore.push(() => made.stop());
    return made;
  };
  let launch = engine();
  const post = (id: string, action: string) =>
    launch.route(
      new Request(`http://127.0.0.1/api/inbox/launch/${id}/${action}`, { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv" }) }),
      `/api/inbox/launch/${id}/${action}`,
      "local",
    );
  /** A New message that started the fake agent, which took it and is idle. */
  const started = async (body = "Tidy the readme.") => {
    const target = launch.target({ launch: { agent: FAKE, project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body, resolveProject: async () => project });
    const root = store.startPersonThread({ project_id: project.id, body, to: prepared.to, idempotency_key: `send-${body}`, thread_name: "Tidy", launch: prepared.launch }).message;
    launch.begin(root);
    await until(() => !!store.message(root.id)!.launch!.session_ref);
    const session = store.message(root.id)!.to!.session;
    fake.poll(session, true, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session });
    fake.poll(session, false, clock.now);
    return { root: store.message(root.id)!, session, launchId: prepared.launch.id };
  };
  const notes = (root: InboxMessage) =>
    store
      .threadMessageIds(root.thread_id)
      .map((id) => store.message(id)!)
      .filter((m) => m.author.kind === "agent");
  return { store, clock, project, fake, errors, asked, started, notes, post, launch: () => launch, restart: () => (launch.stop(), (launch = engine())) };
}

const CREDIT = "Credit balance too low · Add funds: https://platform.claude.com/settings/billing";

describe("a launched session's turn that ended in an error", () => {
  test("one note from the session in the shared sentence, however often it is read, an Inbox restart included", async () => {
    const w = world();
    const { root, session } = await w.started();
    w.errors.set(session, { key: "e-1", text: CREDIT, at: w.clock.now });
    for (let i = 0; i < 3; i++) w.launch().sweep(i % 2 === 0);
    expect(w.notes(root).map((m) => m.body)).toEqual([launchTurnErrorNote("Fake Agent", CREDIT)]);
    expect(w.notes(root)[0]!.body).toBe(`Fake Agent's turn ended with an error: ${CREDIT}`);
    expect(w.notes(root)[0]!.author).toMatchObject({ kind: "agent", host: FAKE, session, name: "Fake Agent" });
    // Marked for the window's notification: one note, so one notice (the window notifies on its first line only).
    expect(w.notes(root)[0]!.turn_error).toBe(true);
    expect(await w.launch().runOf(root.id)).toMatchObject({ state: "failed", turn_error: true });

    // The Inbox starts again with the transcript unchanged: the line is back, the note is not written twice.
    w.restart();
    w.launch().sweep(false);
    expect(w.notes(root)).toHaveLength(1);
    expect(await w.launch().runOf(root.id)).toMatchObject({ state: "failed", turn_error: true });
  });

  test("only a session this Inbox launched is read: never another session, nor the one a moved root went to", async () => {
    const w = world();
    const { session } = await w.started();
    // The same agent's session the person started themselves, writing in its own thread.
    w.store.sendMessage({ project_id: w.project.id, author: { kind: "agent", host: FAKE, session: "theirs", name: "Fake Agent" }, body: "Hi.", idempotency_key: "theirs" });
    w.errors.set("theirs", { key: "e-x", text: "nope", at: w.clock.now });
    w.launch().sweep(true);
    expect(new Set(w.asked)).toEqual(new Set([session]));
  });

  test("the next good turn clears the line and keeps the note", async () => {
    const w = world();
    const { root, session } = await w.started();
    w.errors.set(session, { key: "e-1", text: "Rate limited.", at: w.clock.now });
    w.launch().sweep(false);
    expect((await w.launch().runOf(root.id))?.turn_error).toBe(true);
    // The person writes again; the session takes it and works: the line says it works.
    const reply = w.store.sendReply(w.notes(root)[0]!.id, { words: "Try now.", idempotency_key: "r1" }).reply;
    w.fake.poll(session, true, w.clock.now);
    w.store.recordDelivery(reply.id, { host: FAKE, session });
    w.launch().sweep(false);
    expect((await w.launch().runOf(root.id))?.state).toBe("working");
    // It ends well: no line; the note is still there.
    w.errors.set(session, null);
    w.store.sendMessage({ project_id: w.project.id, author: { kind: "agent", host: FAKE, session, name: "Fake Agent" }, body: "Done.", reply_to: reply.id, idempotency_key: "done" });
    w.fake.poll(session, false, w.clock.now);
    w.launch().sweep(false);
    expect(await w.launch().runOf(root.id)).toBeNull();
    expect(w.notes(root).map((m) => m.body)).toEqual(["Fake Agent's turn ended with an error: Rate limited.", "Done."]);
  });

  test("Try again sends the person's message to the session again, and the old error never comes back", async () => {
    const w = world();
    const { root, session, launchId } = await w.started();
    // A plain reply the session took (a read settled it), whose turn ended in the error.
    const answer = w.store.sendMessage({ project_id: w.project.id, author: { kind: "agent", host: FAKE, session, name: "Fake Agent" }, body: "Which file?", reply_to: root.id, idempotency_key: "a1" }).message;
    const reply = w.store.sendReply(answer.id, { words: "The readme.", idempotency_key: "r1" }).reply;
    w.store.recordDelivery(reply.id, { host: FAKE, session });
    expect(w.store.pendingReplies(session)).toEqual([]);
    w.errors.set(session, { key: "e-1", text: "Overloaded.", at: w.clock.now });
    w.launch().sweep(false);

    const answered = (await (await w.post(launchId, "retry"))!.json()) as { run: { state: string } | null };
    expect(answered.run?.state).not.toBe("failed");
    expect(w.store.pendingReplies(session).map((m) => m.id)).toEqual([reply.id]);
    expect(w.store.message(reply.id)!.delivery).toBeUndefined();
    // The transcript still ends in that error until the message goes in: it stands for nothing now.
    w.launch().sweep(false);
    expect((await w.launch().runOf(root.id))?.turn_error).toBeUndefined();
    // It goes in once, and a new error is a new note.
    w.store.recordDelivery(reply.id, { host: FAKE, session });
    expect(w.store.pendingReplies(session)).toEqual([]);
    w.errors.set(session, { key: "e-2", text: "Overloaded again.", at: w.clock.now });
    w.launch().sweep(false);
    expect(w.notes(root).map((m) => m.body).filter((b) => b.includes("turn ended"))).toHaveLength(2);
    expect((await w.launch().runOf(root.id))?.turn_error).toBe(true);
  });
});

describe("the note's words", () => {
  test("a long error of many lines is one line of 300 characters at most, cut between words, never inside a link", () => {
    const words = `${"The request could not be completed\nbecause ".repeat(6)}see https://platform.claude.com/settings/billing?from=inbox for more`;
    const note = launchTurnErrorNote("Claude Code", words);
    const shown = note.slice("Claude Code's turn ended with an error: ".length);
    expect(note).not.toContain("\n");
    expect([...shown].length).toBeLessThanOrEqual(300);
    expect(shown.endsWith("…")).toBe(true);
    expect(shown).not.toContain("https://platform.claude.com/settings/bil");
    expect(shown.slice(0, -1).trimEnd().endsWith("see")).toBe(true);
    // Through a word only when that word fills most of the room.
    expect(launchTurnErrorNote("Pi", "x".repeat(400)).endsWith(`${"x".repeat(299)}…`)).toBe(true);
  });
});

describe("Claude Code's transcript", () => {
  const entry = (record: Record<string, unknown>) => JSON.stringify(record);
  const prompt = (text: string) => entry({ type: "user", uuid: "u-1", message: { role: "user", content: text } });
  const failed = (error: string, text: string, uuid = "a-err") =>
    entry({ type: "assistant", uuid, timestamp: "2026-11-11T15:00:00.000Z", isApiErrorMessage: true, error, message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] } });
  const good = entry({ type: "assistant", uuid: "a-ok", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } });

  test("the last turn's error entry, every error kind alike, with the entry's own words", () => {
    for (const kind of ["billing_error", "rate_limit", "authentication_failed", "overloaded", "server_error", "a_kind_added_later"]) {
      const found = claudeTurnErrorOf([prompt("hi"), failed(kind, `words for ${kind}`), entry({ type: "system", subtype: "turn_duration" }), ""].join("\n"));
      expect(found).toEqual({ key: "a-err", text: `words for ${kind}`, at: Date.parse("2026-11-11T15:00:00.000Z") });
    }
  });

  test("a turn that ended well, or a prompt after the error, is no error; a tool's result goes on with the turn", () => {
    expect(claudeTurnErrorOf([prompt("hi"), failed("rate_limit", "x"), prompt("again"), good].join("\n"))).toBeNull();
    expect(claudeTurnErrorOf([failed("rate_limit", "x"), prompt("again")].join("\n"))).toBeNull();
    const toolResult = entry({ type: "user", uuid: "u-2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
    expect(claudeTurnErrorOf([prompt("hi"), failed("server_error", "API Error: 500"), toolResult].join("\n"))?.text).toBe("API Error: 500");
  });

  test("a line still being written, or one cut by the read, is not read", () => {
    const half = failed("rate_limit", "later").slice(0, 40);
    expect(claudeTurnErrorOf([failed("billing_error", "first"), half].join("\n"))?.text).toBe("first");
    expect(claudeTurnErrorOf(`${good.slice(10)}\n`)).toBeNull();
  });

  test("the file: missing is nothing; only its end is read; a write after it is seen", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-transcript-"));
    restore.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = claudeTranscriptPath(join(dir, ".claude"), "/Users/me/my project", "1234abcd-0000-4000-8000-000000000000")!;
    expect(path).toBe(join(dir, ".claude", "projects", "-Users-me-my-project", "1234abcd-0000-4000-8000-000000000000.jsonl"));
    expect(claudeTranscriptPath(dir, "/x", "../etc/passwd")).toBeNull();
    expect(claudeTranscriptTurnError(path)).toBeNull();
    mkdirSync(join(dir, ".claude", "projects", "-Users-me-my-project"), { recursive: true });
    // An error far back, then more than the read's room of good turns: only the end counts.
    writeFileSync(path, `${failed("rate_limit", "old")}\n${`${good}\n`.repeat(Math.ceil((CLAUDE_TRANSCRIPT_TAIL_BYTES * 2) / good.length))}`);
    expect(claudeTranscriptTurnError(path)).toBeNull();
    appendFileSync(path, `${prompt("hi")}\n${failed("billing_error", CREDIT, "a-new")}\n`);
    expect(claudeTranscriptTurnError(path)).toMatchObject({ key: "a-new", text: CREDIT });
  });
});
