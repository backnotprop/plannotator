/**
 * Why a reply to a T3 Code thread waits (`t3_wait` on the reply, which every
 * window reads): the T3 wake (inbox-t3-wake.ts) against a scripted T3 MCP
 * server on loopback (tests/helpers/fake-t3.ts), over the T3 client the Inbox
 * ships, with a store in a temp folder. No Inbox server and no T3 run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxMessage } from "@plannotator/core/inbox-types";
import { T3Credentials } from "@plannotator/t3-code/auth";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxT3Wake, type InboxT3Wake } from "./inbox-t3-wake";
import { INBOX_REPLY_ARRIVES_TEXT, INBOX_REPLY_LOOK_TEXT, INBOX_REPLY_READ_LATER_TEXT, INBOX_REPLY_T3_WHILE_RUNNING_TEXT, replyNextStepText, t3WokenOnlyWhileRunning } from "./inbox-mcp";
import { type FakeT3, startFakeT3, type T3Access, type T3RuntimeMode, t3ScopeOf } from "../../tests/helpers/fake-t3";

const THREAD = "00000000-0000-4000-8000-000000000001";
const ELSEWHERE = "00000000-0000-4000-8000-000000000009";
const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "t3", session: THREAD, name: "T3 Code" };

const roots: string[] = [];
const wakes: InboxT3Wake[] = [];
const fakes: FakeT3[] = [];
afterEach(() => {
  for (const wake of wakes.splice(0)) wake.stop();
  for (const fake of fakes.splice(0)) fake.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const commandOf = (item: InboxMessage): InboxReplyCommand => ({ type: "reply", id: item.id, thread_id: item.thread_id, reply_to: item.reply_to ?? null, subject: null, body: item.body, url: "http://127.0.0.1/#thread" });

function world(options: { access?: T3Access; modes?: Record<string, T3RuntimeMode>; threads?: string[]; skip?: () => boolean } = {}) {
  const t3 = startFakeT3({ threads: options.threads ?? [THREAD], ...(options.access ? { access: options.access } : {}), ...(options.modes ? { modes: options.modes } : {}) });
  fakes.push(t3);
  const root = mkdtempSync(join(tmpdir(), "plannotator-t3-wait-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const store = InboxStore.open(join(dataDir, "inbox"));
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const clock = { now: Date.now() };
  const grant = new T3Credentials(dataDir, t3.endpoint);
  /** As `plannotator t3 login` saves it; `token` other than the fake's is one T3 refuses (lapsed or revoked). */
  const login = (epoch: string, options: { token?: string; scoped?: boolean } = {}) =>
    grant.save({ endpoint: t3.endpoint.href, epoch, tokens: { access_token: options.token ?? t3.state.token, token_type: "Bearer", ...(options.scoped ? { scope: t3ScopeOf(t3.state.access) } : {}) } });
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "Ship the worker today?", wakes: false }).message;
  const start = () => {
    const wake = createInboxT3Wake({ store, dataDir, commandOf, now: () => clock.now, log: () => {}, grantCheckMs: 60_000, ...(options.skip ? { skip: options.skip } : {}) });
    wakes.push(wake);
    return wake;
  };
  const reply = (words: string, key = "k1") => store.sendReply(asked.id, { words, idempotency_key: key }).reply!;
  const waitOf = (id: string) => store.message(id)?.t3_wait ?? null;
  return { t3, store, clock, login, logout: () => grant.forget(), start, reply, waitOf, asked };
}

describe("a reply waiting on T3 says why", () => {
  test("no sign-in at all: sign_in, and gone once a login lets it go in", async () => {
    const w = world();
    const wake = w.start();
    const reply = w.reply("Yes, ship it.");
    await wake.sweep();
    expect(w.waitOf(reply.id)).toBe("sign_in");
    expect(w.t3.turns).toHaveLength(0);

    w.login("e1", { scoped: true });
    await wake.sweep();
    expect(w.t3.turns).toHaveLength(1);
    const after = w.store.message(reply.id)!;
    expect(after.delivery).toMatchObject({ host: "t3", session: THREAD });
    expect(after.t3_wait ?? null).toBeNull();
    expect("t3_wait" in after).toBe(false);
  });

  test("a sign-in T3 refuses (lapsed or revoked): sign_in_again, and gone after a new one", async () => {
    const w = world();
    w.login("e1", { token: "lapsed-token", scoped: true });
    const wake = w.start();
    const reply = w.reply("Yes, ship it.");
    await wake.sweep();
    expect(w.waitOf(reply.id)).toBe("sign_in_again");

    w.login("e2", { scoped: true });
    await wake.sweep();
    expect(w.store.message(reply.id)!.delivery).toBeTruthy();
    expect(w.waitOf(reply.id)).toBeNull();
  });

  test("a sign-in whose mode does not cover the thread: access, known from its scope before any send", async () => {
    const w = world({ access: "read-only" });
    w.login("e1", { scoped: true });
    const wake = w.start();
    const reply = w.reply("Yes, ship it.");
    await wake.sweep();
    expect(w.waitOf(reply.id)).toBe("access");
    expect(w.t3.sendCalls).toBe(0);

    // Signed in again with a mode that covers the thread (auto).
    w.t3.state.access = "full-access";
    w.login("e2", { scoped: true });
    await wake.sweep();
    expect(w.t3.turns).toHaveLength(1);
    expect(w.waitOf(reply.id)).toBeNull();
  });

  test("a mode T3 denies at the send (a sign-in saved with no scope): access", async () => {
    const w = world({ access: "approval-required", modes: { [THREAD]: "full-access" } });
    w.login("e1");
    const wake = w.start();
    const reply = w.reply("Yes, ship it.");
    await wake.sweep();
    expect(w.t3.sendCalls).toBe(1);
    expect(w.t3.turns).toHaveLength(0);
    expect(w.waitOf(reply.id)).toBe("access");
  });

  test("T3 not answering: closed, kept while it retries, gone once T3 takes it", async () => {
    const w = world();
    w.login("e1", { scoped: true });
    w.t3.state.readFailure = { code: "orchestration_error", message: "The request could not be completed." };
    const wake = w.start();
    const reply = w.reply("Yes, ship it.");
    await wake.sweep();
    expect(w.waitOf(reply.id)).toBe("closed");
    // Inside the backoff nothing is asked and the reason stays.
    await wake.sweep();
    expect(w.waitOf(reply.id)).toBe("closed");

    w.t3.state.readFailure = null;
    w.clock.now += 11 * 60_000;
    await wake.sweep();
    expect(w.t3.turns).toHaveLength(1);
    expect(w.waitOf(reply.id)).toBeNull();
  });

  test("a sign-in whose T3 does not have the thread writes nothing: no sign-in here fixes it", async () => {
    const w = world({ threads: [ELSEWHERE] });
    w.login("e1", { scoped: true });
    const wake = w.start();
    const reply = w.reply("Yes, ship it.");
    await wake.sweep();
    expect(w.waitOf(reply.id)).toBeNull();
  });

  test("a reply its own connection delivers (the Claude Code mod polls as the thread) is cleared", async () => {
    let modPolls = false;
    const w = world({ skip: () => modPolls });
    const wake = w.start();
    const reply = w.reply("Yes, ship it.");
    await wake.sweep();
    expect(w.waitOf(reply.id)).toBe("sign_in");
    modPolls = true;
    await wake.sweep();
    expect(w.waitOf(reply.id)).toBeNull();
  });

  test("the reason carries no grant, token, URL or epoch, and writes one line per change", async () => {
    const w = world();
    w.login("secret-epoch", { token: "lapsed-secret-token", scoped: true });
    const wake = w.start();
    const reply = w.reply("Yes, ship it.");
    await wake.sweep();
    expect(w.waitOf(reply.id)).toBe("sign_in_again");
    const record = JSON.stringify(w.store.message(reply.id));
    for (const secret of ["lapsed-secret-token", "secret-epoch", w.t3.endpoint.href, w.t3.endpoint.host, "oauth", "Bearer"]) expect(record).not.toContain(secret);
    const cursor = w.store.cursor();
    await wake.sweep();
    await wake.sweep();
    expect(w.store.cursor()).toBe(cursor);
  });
});

describe("the send's result line for a T3 thread", () => {
  test("woken by the Claude Code mod with no sign-in that reaches the thread: only while T3 keeps it running", async () => {
    const reaches = (value: boolean) => ({ t3WakeReaches: async () => value });
    const t3 = { agent_host: "t3", agent_session: THREAD };
    expect(await t3WokenOnlyWhileRunning(reaches(false), true, t3)).toBe(true);
    expect(replyNextStepText(true, "t3", true)).toBe(INBOX_REPLY_T3_WHILE_RUNNING_TEXT);
    // A sign-in that reaches it: the T3 wake delivers after T3 stops that Claude too.
    expect(await t3WokenOnlyWhileRunning(reaches(true), true, t3)).toBe(false);
    expect(replyNextStepText(true, "t3", false)).toBe(`${INBOX_REPLY_ARRIVES_TEXT} ${INBOX_REPLY_LOOK_TEXT}`);
    // Not woken at all, another host, or a lookup that fails: as before.
    expect(await t3WokenOnlyWhileRunning(reaches(false), false, t3)).toBe(false);
    expect(replyNextStepText(false, "t3", false)).toBe(INBOX_REPLY_READ_LATER_TEXT);
    expect(await t3WokenOnlyWhileRunning(reaches(false), true, { agent_host: "claude-code", agent_session: "ses_1" })).toBe(false);
    expect(await t3WokenOnlyWhileRunning({ t3WakeReaches: async () => Promise.reject(new Error("down")) }, true, t3)).toBe(true);
    expect(await t3WokenOnlyWhileRunning({}, true, t3)).toBe(false);
  });

  test("every agent but a T3 thread with no usable sign-in keeps its line, byte for byte", async () => {
    // The words as they were before the T3 sentence existed, written out: a change to them fails here.
    const ARRIVES = "The person's reply arrives in this session by itself, as a new message once the session is idle: end your turn, or go on with other work.";
    const LOOK = "If it has not arrived when you next work, call read_thread with this thread_id.";
    const LATER = "The person's reply won't arrive in this session by itself: go on with your work and call read_thread with this thread_id later.";
    // The T3 wake cannot reach anything: only a sender filed as a T3 thread is asked at all.
    const noSignIn = { t3WakeReaches: async () => false };
    const line = async (wakes: boolean, host: string | undefined, session = "ses_1", context: Parameters<typeof t3WokenOnlyWhileRunning>[0] = noSignIn) =>
      replyNextStepText(wakes, host, await t3WokenOnlyWhileRunning(context, wakes, { agent_host: host, agent_session: session }));
    // An interactive Claude Code session (the mod wakes it), Pi, OpenCode 2 and the other plugin hosts.
    for (const host of ["claude-code", "pi", "opencode", "dsh", "cline", "openclaw", "hermes"]) expect([host, await line(true, host)]).toEqual([host, ARRIVES]);
    // `claude -p` and other SDK sessions not under T3: the mod sends without the wake.
    expect(await line(false, "claude-code")).toBe(LATER);
    // Codex and Qwen Code, woken by the Inbox; and not woken (codex exec, no queue).
    for (const host of ["codex", "qwen"]) {
      expect(await line(true, host, "019a0000-0000-7000-8000-000000000001")).toBe(`${ARRIVES} ${LOOK}`);
      expect(await line(false, host, "019a0000-0000-7000-8000-000000000001")).toBe(LATER);
    }
    // An MCP-over-HTTP agent, naming no host or its own.
    expect(await line(false, undefined)).toBe(LATER);
    expect(await line(false, "cursor")).toBe(LATER);
    // A T3 thread with a sign-in the T3 wake can send under, and one nothing wakes.
    expect(await line(true, "t3", THREAD, { t3WakeReaches: async () => true })).toBe(`${ARRIVES} ${LOOK}`);
    expect(await line(false, "t3", THREAD)).toBe(LATER);
    // The one case that changes: a T3 thread its mod wakes, with no sign-in that can send into it.
    expect(await line(true, "t3", THREAD)).toBe(INBOX_REPLY_T3_WHILE_RUNNING_TEXT);
  });
});
