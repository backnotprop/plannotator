/**
 * Launch PR 2: the permission hook's route and its lease, on a real store in
 * a temp dir. What each test guards: the question lands in the launch thread
 * under `perm:<session>` (so the answer is never a second turn for the
 * session), the answer decides in Claude Code's shape and records the
 * delivery, a wrong key or a deleted launch is refused, and a question no
 * hook holds any more is withdrawn with the right words.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxRunHostState } from "@plannotator/core/inbox-run-line";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { launchPermissionHooks } from "./inbox-launch";
import { createLaunchPermissions, fileTarget, type PermissionAnswer } from "./inbox-launch-permission";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const KEY = "k".repeat(64);
const LAUNCH = "lch_01J00000000000000000000000";
const SESSION = "0d6c2f1e-5b7a-4c8e-9f00-aaaaaaaaaaaa";
const LEASE = 60_000;
const EVENT = {
  session_id: SESSION,
  cwd: "/work/plannotator",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "bun run build", description: "Build" },
  permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun run:*" }], behavior: "allow", destination: "localSettings" }],
};

function setup(options: { holdMs?: number; startMs?: number; bypassAvailable?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-launch-permission-"));
  roots.push(dir);
  const clock = { now: options.startMs ?? Date.parse("2026-10-30T15:00:00.000Z") };
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "plannotator", root: "/work/plannotator" });
  const root = store.startPersonThread({
    project_id: project.id,
    body: "Make the Settings search fuzzy.",
    to: { host: "claude-code", session: SESSION },
    idempotency_key: "send-1",
    launch: { id: LAUNCH, agent: "claude-code", session_ref: SESSION.slice(0, 8), folder: "/work/plannotator", scratch: false, started_at: new Date(clock.now).toISOString(), ...(options.bypassAvailable ? { bypass_available: true as const } : {}) },
  }).message;
  const launchDir = join(dir, "launch", LAUNCH);
  mkdirSync(launchDir, { recursive: true });
  writeFileSync(join(launchDir, "settings.json"), JSON.stringify({ env: { PLANNOTATOR_LAUNCH: LAUNCH, PLANNOTATOR_LAUNCH_KEY: KEY } }));
  const host = { state: null as InboxRunHostState | null, readAt: 0 };
  let deleted = false;
  const rootOf = (): InboxMessage | null => (deleted ? null : store.message(root.id));
  const permissions = createLaunchPermissions({
    store,
    launchDir: () => launchDir,
    rootOf,
    roots: () => (deleted ? [] : [store.message(root.id)!]),
    displayFolder: (path) => path.replace("/work", "~"),
    host: { stateOf: () => host.state, readAt: () => host.readAt },
    onChange: () => {},
    // A held call waits in real time: its clock must move.
    now: options.holdMs ? Date.now : () => clock.now,
    holdMs: options.holdMs ?? 0,
    leaseMs: LEASE,
  });
  const call = async (body: Record<string, unknown>): Promise<{ status: number; body: PermissionAnswer & { code?: string } }> => {
    const response = await permissions.handle(new Request(`http://127.0.0.1/api/inbox/launch/${LAUNCH}/permission`, { method: "POST", body: JSON.stringify(body) }), LAUNCH);
    return { status: response.status, body: (await response.json()) as PermissionAnswer & { code?: string } };
  };
  const answer = (messageId: string, pick: { selected?: string[]; other?: string; confirmFull?: boolean }) => {
    const question = store.questionsOf(messageId)[0]!;
    const picked = { v: 1 as const, key: question.key, kind: "single" as const, prompt: question.prompt, selected: pick.selected ?? [], ...(pick.other ? { other: pick.other } : {}) };
    // The window's way: the pick (with the person's confirmation when it says so), then the Send.
    const saved = store.savePicks(messageId, [{ key: question.key, revision: question.revision, answer: picked }], { unsentOnly: true, confirmFull: pick.confirmFull === true });
    return store.sendReply(messageId, { idempotency_key: `answer-${messageId}`, questions: [{ key: question.key, revision: saved[0]!.revision }] }).reply!;
  };
  return { store, clock, root, host, launchDir, permissions, call, answer, deleteLaunch: () => (deleted = true) };
}

describe("the permission route", () => {
  test("asks in the launch thread as perm:<session>, a reply to its latest message, never waking the session", async () => {
    const { store, root, call } = setup();
    const first = await call({ key: KEY, request_id: "req-00000001", event: EVENT });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("waiting");
    const question = store.message(first.body.message_id!)!;
    expect(question.thread_id).toBe(root.id);
    expect(question.reply_to).toBe(root.id);
    expect(question.author).toEqual({ kind: "agent", host: "claude-code", session: `perm:${SESSION}`, name: "Claude Code" });
    expect(question.wakes).toBeUndefined();
    expect(store.questionsOf(question.id)[0]!.choices.map((c) => c.label)).toEqual(["Allow once", "Allow `bun run` for this session", "Deny", "Allow and switch to Auto mode"]);
    // The same request again (the hook's first call answered, but the answer was lost): the same question.
    const again = await call({ key: KEY, request_id: "req-00000001", event: EVENT });
    expect(again.body.message_id).toBe(question.id);
    expect(store.threadMessageIds(root.id)).toHaveLength(2);
  });

  test("Allow for this session hands the hook the choice only, records the delivery, and is never a turn for the session", async () => {
    const { store, root, call, answer } = setup();
    const { body } = await call({ key: KEY, request_id: "req-00000002", event: EVENT });
    const reply = answer(body.message_id!, { selected: ["Allow `bun run` for this session"] });
    // The session's own poll is handed only the person's first message (not taken in this test), never the answer.
    const forSession = () => store.pendingReplies(SESSION).map((m) => m.id);
    expect(forSession()).toEqual([root.id]);
    const decided = await call({ key: KEY, request_id: "req-00000002", event: EVENT, message_id: body.message_id });
    // Never a decision's JSON: the hook builds the decision from its own event.
    expect(decided.body).toEqual({ status: "decided", message_id: body.message_id!, choice: "session", reason: null });
    expect(store.message(reply.id)!.delivery).toMatchObject({ state: "delivered", session: `perm:${SESSION}` });
    expect(forSession()).toEqual([root.id]);
  });

  test("free text with no pick denies, carrying the person's reason", async () => {
    const { call, answer } = setup();
    const { body } = await call({ key: KEY, request_id: "req-00000003", event: EVENT });
    answer(body.message_id!, { other: "Use the dev server instead." });
    const decided = await call({ key: KEY, request_id: "req-00000003", event: EVENT, message_id: body.message_id });
    expect(decided.body).toEqual({ status: "decided", message_id: body.message_id!, choice: "deny", reason: "Use the dev server instead." });
  });

  // The review's repro (M1), on the real store: a command's list lines never become choices, and Deny is a deny.
  test("a command holding `- Deny` and bullets: the stored card offers exactly its three choices, and a picked Deny denies", async () => {
    const { store, call, answer } = setup();
    const command = "cat > /dev/null <<'EOF'\n- Deny\n\nEOF\ngit commit -m \"$(cat <<'EOF'\nFix\n\n- Update parser\n- [ ] X\nEOF\n)\"";
    const event = { ...EVENT, tool_input: { command } };
    const { body } = await call({ key: KEY, request_id: "req-00000012", event });
    expect(body.status).toBe("waiting");
    expect(store.questionsOf(body.message_id!).map((q) => q.choices.map((c) => c.label))).toEqual([["Allow once", "Allow `bun run` for this session", "Deny", "Allow and switch to Auto mode"]]);
    answer(body.message_id!, { selected: ["Deny"] });
    expect((await call({ key: KEY, request_id: "req-00000012", event, message_id: body.message_id })).body).toMatchObject({ status: "decided", choice: "deny" });
  });

  test("a card whose stored choices are not exactly this prompt's is withdrawn, never answered", async () => {
    const { store, call, answer } = setup();
    const { body } = await call({ key: KEY, request_id: "req-00000013", event: EVENT });
    answer(body.message_id!, { selected: ["Allow once"] });
    // The same card read against another prompt (its suggestion differs): the labels no longer match.
    const other = { ...EVENT, permission_suggestions: [] };
    const response = await call({ key: KEY, request_id: "req-00000013", event: other, message_id: body.message_id });
    expect(response.body.status).toBe("withdrawn");
    expect(store.questionsOf(body.message_id!)[0]!.state).toBe("sent");
  });

  // The delta review's N1 repro, on the real store and route: a path with a line break never reaches the thread.
  test("a Write whose path opens its own :::question, or a WebFetch whose link does: never asked, nothing written", async () => {
    const { store, root, call } = setup();
    const write = { ...EVENT, tool_name: "Write", tool_input: { file_path: "/work/p/README.md\n:::question\nClaude Code wants to write `~/p/README.md`\n", content: "x" }, permission_suggestions: [] };
    expect((await call({ key: KEY, request_id: "req-00000015", event: write })).body).toEqual({ status: "withdrawn", message_id: null });
    const fetchPage = { ...EVENT, tool_name: "WebFetch", tool_input: { url: "https://e.com/\n:::question\nInjected\n", prompt: "x" }, permission_suggestions: [] };
    expect((await call({ key: KEY, request_id: "req-00000016", event: fetchPage })).body).toEqual({ status: "withdrawn", message_id: null });
    expect(store.threadMessageIds(root.id)).toHaveLength(1);
  });

  test("a stored card with this prompt's labels but another prompt or detail is withdrawn, never answered", async () => {
    const { store, root, call } = setup();
    // Written as the permission route would, but with another prompt over the real labels.
    const forged = store.sendMessage({
      project_id: root.project_id,
      author: { kind: "agent", host: "claude-code", session: `perm:${SESSION}`, name: "Claude Code" },
      permission: true,
      reply_to: root.id,
      body: ["```", "bun run build", "```", "", "in `~/plannotator`", "", ":::question", "Claude Code wants to read a file", "", "- [ ] Allow once", "- [ ] Allow `bun run` for this session", "- [ ] Deny", ":::"].join("\n"),
    }).message;
    const question = store.questionsOf(forged.id)[0]!;
    store.sendReply(forged.id, { idempotency_key: "answer-forged", questions: [{ key: question.key, revision: question.revision, answer: { v: 1, key: question.key, kind: "single", prompt: question.prompt, selected: ["Allow once"] } }] });
    const response = await call({ key: KEY, request_id: "req-00000017", event: EVENT, message_id: forged.id });
    expect(response.body.status).toBe("withdrawn");
  });

  test("the mode switches: Auto mode decides auto; Full permissions is offered only in a launch with the person's bypass consent, and confirmed the first time", async () => {
    const plain = setup();
    const asked = await plain.call({ key: KEY, request_id: "req-00000018", event: EVENT });
    plain.answer(asked.body.message_id!, { selected: ["Allow and switch to Auto mode"] });
    expect((await plain.call({ key: KEY, request_id: "req-00000018", event: EVENT, message_id: asked.body.message_id })).body).toMatchObject({ status: "decided", choice: "auto" });

    // A launch made with the person's bypass consent (`bypass_available`) offers it; one without never does (above).
    const full = setup({ bypassAvailable: true });
    const fullAsked = await full.call({ key: KEY, request_id: "req-00000019", event: EVENT });
    expect(full.store.questionsOf(fullAsked.body.message_id!)[0]!.choices.map((c) => c.label).slice(-1)).toEqual(["Allow and switch to Full permissions"]);
    // The first time in the session, Full permissions needs the person's confirmation (the store's rule, not only the window's).
    expect(() => full.answer(fullAsked.body.message_id!, { selected: ["Allow and switch to Full permissions"] })).toThrow("confirm_full");
    full.answer(fullAsked.body.message_id!, { selected: ["Allow and switch to Full permissions"], confirmFull: true });
    expect((await full.call({ key: KEY, request_id: "req-00000019", event: EVENT, message_id: fullAsked.body.message_id })).body).toMatchObject({ status: "decided", choice: "full" });
    // The next prompt of the same session: no confirmation again.
    const again = await full.call({ key: KEY, request_id: "req-00000020", event: EVENT });
    full.answer(again.body.message_id!, { selected: ["Allow and switch to Full permissions"] });
    expect((await full.call({ key: KEY, request_id: "req-00000020", event: EVENT, message_id: again.body.message_id })).body).toMatchObject({ status: "decided", choice: "full" });
  });

  test("an answered prompt is never reopened: a stale pick (Deny at the current revision) is refused, and the record stays", async () => {
    const { store, call, answer } = setup();
    const asked = await call({ key: KEY, request_id: "req-00000021", event: EVENT });
    const id = asked.body.message_id!;
    answer(id, { selected: ["Allow once"] });
    expect((await call({ key: KEY, request_id: "req-00000021", event: EVENT, message_id: id })).body).toMatchObject({ status: "decided", choice: "once" });
    const sent = store.questionsOf(id)[0]!;
    const deny = { v: 1 as const, key: sent.key, kind: "single" as const, prompt: sent.prompt, selected: ["Deny"] };
    // Without `unsentOnly` too: a permission question is always unsent-only.
    expect(() => store.savePicks(id, [{ key: sent.key, revision: sent.revision, answer: deny }])).toThrow("already sent");
    expect(store.questionsOf(id)[0]).toMatchObject({ state: "sent", answer: { selected: ["Allow once"] } });
  });

  test("an answered prompt is never rewritten by a reply carrying its own answer: the words post, the answer stays", async () => {
    const { store, call, answer } = setup();
    const asked = await call({ key: KEY, request_id: "req-00000024", event: EVENT });
    const id = asked.body.message_id!;
    const first = answer(id, { selected: ["Allow once"] });
    expect((await call({ key: KEY, request_id: "req-00000024", event: EVENT, message_id: id })).body).toMatchObject({ status: "decided", choice: "once" });
    const sent = store.questionsOf(id)[0]!;
    const deny = { v: 1 as const, key: sent.key, kind: "single" as const, prompt: sent.prompt, selected: ["Deny"] };
    // A stale window or a phone sends Deny with words, at the current revision.
    const late = store.sendReply(id, { idempotency_key: "late-deny", words: "Actually, no.", questions: [{ key: sent.key, revision: sent.revision, answer: deny }] }).reply!;
    expect(late.body).toContain("Actually, no.");
    expect(store.questionsOf(id)[0]).toMatchObject({ state: "sent", revision: sent.revision, answer: { selected: ["Allow once"] }, sent_reply_id: first.id });
    // With no words, nothing is left to send: refused, and nothing is written.
    const before = store.threadMessageIds(store.message(id)!.thread_id).length;
    expect(() => store.sendReply(id, { idempotency_key: "late-deny-2", questions: [{ key: sent.key, revision: sent.revision, answer: deny }] })).toThrow("already sent");
    expect(store.threadMessageIds(store.message(id)!.thread_id)).toHaveLength(before);
    expect(store.questionsOf(id)[0]).toMatchObject({ answer: { selected: ["Allow once"] }, sent_reply_id: first.id });
  });

  test("a file path that is a symbolic link shows where it points, and the question keeps it when re-checked", async () => {
    const { store, call, answer, launchDir } = setup();
    const real = join(launchDir, "real.txt");
    writeFileSync(real, "old");
    const link = join(launchDir, "link.txt");
    symlinkSync(real, link);
    const event = { ...EVENT, tool_name: "Write", tool_input: { file_path: link, content: "new" } };
    const asked = await call({ key: KEY, request_id: "req-00000025", event });
    const id = asked.body.message_id!;
    expect(store.questionsOf(id)[0]!.prompt).toBe("Claude Code wants to overwrite a file");
    expect(store.message(id)!.body).toContain(`Links to \`${real}\``);
    answer(id, { selected: ["Allow once"] });
    expect((await call({ key: KEY, request_id: "req-00000025", event, message_id: id })).body).toMatchObject({ status: "decided", choice: "once" });
    // A link to nothing: the write creates where it points.
    const dangling = join(launchDir, "dangling.txt");
    symlinkSync(join(launchDir, "missing.txt"), dangling);
    expect(await fileTarget(dangling)).toEqual({ exists: false, linksTo: join(launchDir, "missing.txt") });
  });

  test("a path the Inbox cannot read in time (an unreachable network path) never holds the Inbox: the Write says \"write a file\"", async () => {
    const hang = () => new Promise<never>(() => {});
    const started = Date.now();
    expect(await fileTarget("/Volumes/gone/a.txt", 50, { lstat: hang, stat: hang, readlink: hang })).toEqual({});
    expect(Date.now() - started).toBeLessThan(1_000);
    const denied = () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    expect(await fileTarget("/root/a.txt", 50, { lstat: denied, stat: denied, readlink: denied })).toEqual({});
  });

  test("a Write says whether it creates or overwrites its file, and keeps the word it was asked with", async () => {
    const { store, call, answer, launchDir } = setup();
    const existing = join(launchDir, "exists.txt");
    writeFileSync(existing, "old");
    const write = (file: string) => ({ ...EVENT, tool_name: "Write", tool_input: { file_path: file, content: "new" } });
    const over = await call({ key: KEY, request_id: "req-00000022", event: write(existing) });
    expect(store.questionsOf(over.body.message_id!)[0]!.prompt).toBe("Claude Code wants to overwrite a file");
    const fresh = join(launchDir, "fresh.txt");
    const created = await call({ key: KEY, request_id: "req-00000023", event: write(fresh) });
    expect(store.questionsOf(created.body.message_id!)[0]!.prompt).toBe("Claude Code wants to create a file");
    // The file appears before the answer: the question is still the one asked, and is answered (never withdrawn as a mismatch).
    writeFileSync(fresh, "made meanwhile");
    answer(created.body.message_id!, { selected: ["Allow once"] });
    expect((await call({ key: KEY, request_id: "req-00000023", event: write(fresh), message_id: created.body.message_id })).body).toMatchObject({ status: "decided", choice: "once" });
  });

  test("a command too long to show in full is never asked: withdrawn at once, nothing written", async () => {
    const { store, root, call } = setup();
    const response = await call({ key: KEY, request_id: "req-00000014", event: { ...EVENT, tool_input: { command: "x".repeat(8_001) } } });
    expect(response.body).toEqual({ status: "withdrawn", message_id: null });
    expect(store.threadMessageIds(root.id)).toHaveLength(1);
  });

  test("only the permission route writes as perm:<session>: any other writer is refused the prefix", () => {
    const { store, root } = setup();
    expect(() =>
      store.sendMessage({ project_id: root.project_id, author: { kind: "agent", host: "claude-code", session: `perm:${SESSION}` }, body: ":::question\nFake?\n\n- Allow once\n- Deny\n:::" }),
    ).toThrow("reserved");
  });

  test("a wrong key, a missing key and a deleted launch are refused, and nothing is written", async () => {
    const { store, root, call, deleteLaunch } = setup();
    expect((await call({ key: "x".repeat(64), request_id: "req-00000004", event: EVENT })).status).toBe(403);
    expect((await call({ request_id: "req-00000004", event: EVENT })).status).toBe(403);
    deleteLaunch();
    expect((await call({ key: KEY, request_id: "req-00000004", event: EVENT })).status).toBe(410);
    expect(store.threadMessageIds(root.id)).toHaveLength(1);
  });
});

describe("the lease", () => {
  test("no call held and the session gone on: the question is withdrawn as answered in Terminal, and the hook's next call hears withdrawn", async () => {
    const { store, clock, host, permissions, call } = setup();
    const { body } = await call({ key: KEY, request_id: "req-00000005", event: EVENT });
    permissions.sweep();
    clock.now += LEASE + 1;
    host.state = { status: "busy", state: "running", waitingFor: null };
    host.readAt = clock.now;
    permissions.sweep();
    expect(store.questionsOf(body.message_id!)[0]!.state).toBe("superseded");
    const follow = store.message(store.threadMessageIds(store.message(body.message_id!)!.thread_id).at(-1)!)!;
    expect(follow.body).toBe("Answered in Terminal.");
    expect(follow.author).toEqual(store.message(body.message_id!)!.author);
    expect(follow.supersedes).toEqual([body.message_id!]);
    expect((await call({ key: KEY, request_id: "req-00000005", event: EVENT, message_id: body.message_id })).body.status).toBe("withdrawn");
  });

  test("runs out with the session still on its dialog: \"No longer waiting.\" (the run line falls back to Terminal)", () => {
    const { store, clock, host, permissions, call } = setup();
    return call({ key: KEY, request_id: "req-00000006", event: EVENT }).then(({ body }) => {
      permissions.sweep();
      clock.now += LEASE + 1;
      host.state = { status: "waiting", state: "blocked", waitingFor: "permission prompt" };
      host.readAt = clock.now;
      permissions.sweep();
      const follow = store.message(store.threadMessageIds(store.message(body.message_id!)!.thread_id).at(-1)!)!;
      expect(follow.body).toBe("No longer waiting.");
      expect(permissions.openSince(store.message(store.message(body.message_id!)!.thread_id)!)).toBeNull();
    });
  });

  test("the hook is gone and the host says the session went on: withdrawn at once, without waiting out the lease", async () => {
    const { store, clock, host, permissions, call } = setup();
    const { body } = await call({ key: KEY, request_id: "req-00000011", event: EVENT });
    clock.now += 2_000;
    // A read from right after the question (the session may not have shown its dialog yet) proves nothing.
    host.state = { status: "busy", state: "running", waitingFor: null };
    host.readAt = clock.now;
    permissions.sweep();
    expect(store.questionsOf(body.message_id!)[0]!.state).toBe("open");
    clock.now += 8_000;
    host.readAt = clock.now;
    permissions.sweep();
    expect(store.questionsOf(body.message_id!)[0]!.state).toBe("superseded");
    expect(store.message(store.threadMessageIds(store.message(body.message_id!)!.thread_id).at(-1)!)!.body).toBe("Answered in Terminal.");
  });

  test("a call renews it: a hook that keeps calling is never withdrawn", async () => {
    const { store, clock, permissions, call } = setup();
    const { body } = await call({ key: KEY, request_id: "req-00000007", event: EVENT });
    for (let i = 0; i < 5; i++) {
      clock.now += LEASE - 1_000;
      permissions.sweep();
      await call({ key: KEY, request_id: "req-00000007", event: EVENT, message_id: body.message_id });
    }
    expect(store.questionsOf(body.message_id!)[0]!.state).toBe("open");
  });

  test("an Inbox restart: an open question gets a fresh lease, so the hook that comes back still decides it", async () => {
    const first = setup();
    const { body } = await first.call({ key: KEY, request_id: "req-00000008", event: EVENT });
    first.clock.now += 10 * LEASE;
    // A new instance on the same store: no lease in memory, so the question is adopted, not withdrawn.
    const restarted = createLaunchPermissions({
      store: first.store,
      launchDir: () => first.launchDir,
      rootOf: () => first.store.message(first.root.id),
      roots: () => [first.store.message(first.root.id)!],
      displayFolder: (path) => path.replace("/work", "~"),
      host: { stateOf: () => null, readAt: () => 0 },
      onChange: () => {},
      now: () => first.clock.now,
      holdMs: 0,
    });
    restarted.sweep();
    expect(first.store.questionsOf(body.message_id!)[0]!.state).toBe("open");
    first.answer(body.message_id!, { selected: ["Deny"] });
    const response = await restarted.handle(
      new Request("http://127.0.0.1/", { method: "POST", body: JSON.stringify({ key: KEY, request_id: "req-00000008", event: EVENT, message_id: body.message_id }) }),
      LAUNCH,
    );
    expect(((await response.json()) as { choice: string }).choice).toBe("deny");
  });

  test("Stop withdraws at once", async () => {
    const { store, root, permissions, call } = setup();
    const { body } = await call({ key: KEY, request_id: "req-00000009", event: EVENT });
    expect(permissions.openSince(store.message(root.id)!)).not.toBeNull();
    permissions.withdrawAll(store.message(root.id)!);
    expect(store.questionsOf(body.message_id!)[0]!.state).toBe("superseded");
    expect(permissions.openSince(store.message(root.id)!)).toBeNull();
  });

  test("while the hook holds a call, the host saying the session went on never withdraws it (parallel work can read busy)", async () => {
    // Real time here: the call holds for real. The question was asked well before the host read.
    const { store, host, permissions, call } = setup({ holdMs: 1_500, startMs: Date.now() - 30_000 });
    const asked = await call({ key: KEY, request_id: "req-00000010", event: EVENT });
    const held = call({ key: KEY, request_id: "req-00000010", event: EVENT, message_id: asked.body.message_id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    host.state = { status: "busy", state: "running", waitingFor: null };
    host.readAt = Date.now();
    permissions.sweep();
    expect(store.questionsOf(asked.body.message_id!)[0]!.state).toBe("open");
    expect((await held).body.status).toBe("waiting");
  });
});

describe("the hook in the launch's settings file", () => {
  test("every tool, four days, the Inbox's own command: quoted when its path needs it", () => {
    expect(launchPermissionHooks(["/Users/me/My Apps/plannotator"])).toEqual({
      PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: "'/Users/me/My Apps/plannotator' inbox permission-hook", timeout: 345_600 }] }],
    });
    expect(launchPermissionHooks(["/opt/bun", "/repo/apps/hook/server/index.ts"]).PermissionRequest[0]!.hooks[0]!.command).toBe("/opt/bun /repo/apps/hook/server/index.ts inbox permission-hook");
  });
});
