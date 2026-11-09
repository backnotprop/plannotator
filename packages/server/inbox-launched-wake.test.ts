/**
 * A session the Inbox launched learns it on its first turn (approval "inbox-launched-agent-note"): the server marks
 * only a launched thread's root, handed to the session its launch started (`inboxLaunchedWakeOf`, which `ownerCommand`
 * in inbox.ts puts on the bridge command as `launched`), and the wake every connection words
 * (`inboxWakeText`) adds INBOX_LAUNCHED_LINE after the naming line, then the project-folder line for its agent. The
 * failures this catches: a session the person started (or any later wake) told it was launched; a launch into a
 * scratch, made or cloned folder told other agents work there; Pi given Claude Code's line or the other way round;
 * the lines moving above the instruction (the fixed second line every connection relies on).
 */
import { describe, expect, test } from "bun:test";
import { inboxLaunchedWakeOf } from "@plannotator/core/inbox-run-line";
import type { InboxLaunchRecord } from "@plannotator/core/inbox-types";
import {
  INBOX_LAUNCHED_LINE,
  INBOX_LAUNCHED_PROJECT_LINE_CLAUDE,
  INBOX_LAUNCHED_PROJECT_LINE_PI,
  INBOX_NAME_THREAD_LINE,
  INBOX_NEW_THREAD_INSTRUCTION,
  INBOX_WAKE_INSTRUCTION,
  inboxWakeText,
  type InboxReplyCommand,
} from "@plannotator/shared/inbox/connection";

const ROOT = "msg_01JZROOT0000000000000000";
const SESSION = "6f0c1e2a-0000-4000-8000-000000000001";

const launch = (over: Partial<InboxLaunchRecord> = {}): InboxLaunchRecord => ({
  id: "lch_01JZ0000000000000000000000",
  agent: "claude-code",
  session_ref: "4f1c9a2e",
  session: SESSION,
  folder: "/work/app",
  scratch: false,
  started_at: "2026-11-09T15:00:00.000Z",
  ...over,
});

/** A launched thread's root, as the store keeps it once the launch started (`settleLaunch`). */
const root = (over: Partial<InboxLaunchRecord> = {}, to: string = SESSION) => ({ id: ROOT, thread_id: ROOT, to: { host: "claude-code", session: to }, launch: launch(over) });

const command = (launched?: InboxReplyCommand["launched"], over: Partial<InboxReplyCommand> = {}): InboxReplyCommand => ({
  type: "message",
  id: ROOT,
  thread_id: ROOT,
  reply_to: null,
  subject: "Fix the flaky upload test",
  body: "The upload test fails one run in five. Find out why.",
  url: `http://127.0.0.1:4100/#thread=${ROOT}`,
  new_thread: true,
  ...(launched ? { launched } : {}),
  ...over,
});

const LAUNCHED_WORDS = [INBOX_LAUNCHED_LINE, INBOX_LAUNCHED_PROJECT_LINE_CLAUDE, INBOX_LAUNCHED_PROJECT_LINE_PI];

describe("which wake is a launched session's first", () => {
  test("a launched root, to the session it started, in a project folder: its agent and project", () => {
    expect(inboxLaunchedWakeOf(root())).toEqual({ agent: "claude-code", project: true });
    expect(inboxLaunchedWakeOf(root({ agent: "pi" }))).toEqual({ agent: "pi", project: true });
  });

  test("a scratch folder, a folder the Send made, a clone: not a project folder", () => {
    expect(inboxLaunchedWakeOf(root({ scratch: true }))).toEqual({ agent: "claude-code", project: false });
    expect(inboxLaunchedWakeOf(root({ made_folder: true, made_inode: "1:2" }))).toEqual({ agent: "claude-code", project: false });
    expect(inboxLaunchedWakeOf(root({ agent: "pi", clone: { url: "https://github.com/acme/app.git", host: "github.com", slug: "acme/app", state: "done" } }))).toEqual({ agent: "pi", project: false });
  });

  test("nothing else is: a later message, a root moved to another session, a deleted launch, a thread no launch made", () => {
    expect(inboxLaunchedWakeOf({ ...root(), id: "msg_01JZLATER000000000000000" })).toBeNull();
    expect(inboxLaunchedWakeOf(root({}, "ses-the-person-moved-it-to"))).toBeNull();
    expect(inboxLaunchedWakeOf(root({ deleted_at: "2026-11-09T16:00:00.000Z" }))).toBeNull();
    expect(inboxLaunchedWakeOf({ id: ROOT, thread_id: ROOT, to: { session: SESSION } })).toBeNull();
    expect(inboxLaunchedWakeOf({ ...root(), to: null })).toBeNull();
  });
});

describe("the launched session's first wake", () => {
  test("Claude Code in a project folder: Line A then Line B′, after the instruction and the naming line", () => {
    const lines = inboxWakeText(command({ agent: "claude-code", project: true }, { name_thread: true })).split("\n");
    expect(lines.slice(0, 5)).toEqual([`Plannotator Inbox: Fix the flaky upload test (${ROOT})`, INBOX_NEW_THREAD_INSTRUCTION, INBOX_NAME_THREAD_LINE, INBOX_LAUNCHED_LINE, INBOX_LAUNCHED_PROJECT_LINE_CLAUDE]);
    expect(lines).not.toContain(INBOX_LAUNCHED_PROJECT_LINE_PI);
  });

  test("Pi in a project folder: Line A then Line B, right after the instruction when there is no naming line", () => {
    const lines = inboxWakeText(command({ agent: "pi", project: true })).split("\n");
    expect(lines.slice(1, 4)).toEqual([INBOX_NEW_THREAD_INSTRUCTION, INBOX_LAUNCHED_LINE, INBOX_LAUNCHED_PROJECT_LINE_PI]);
    expect(lines).not.toContain(INBOX_LAUNCHED_PROJECT_LINE_CLAUDE);
  });

  test("not a project folder: Line A alone, for either agent", () => {
    for (const agent of ["claude-code", "pi"] as const) {
      const lines = inboxWakeText(command({ agent, project: false })).split("\n");
      expect(lines.slice(1, 3)).toEqual([INBOX_NEW_THREAD_INSTRUCTION, INBOX_LAUNCHED_LINE]);
      expect(lines).not.toContain(INBOX_LAUNCHED_PROJECT_LINE_CLAUDE);
      expect(lines).not.toContain(INBOX_LAUNCHED_PROJECT_LINE_PI);
    }
  });

  test("an agent this connection does not know, in a project folder: Line A alone", () => {
    const lines = inboxWakeText(command({ agent: "codex" as "pi", project: true })).split("\n");
    expect(lines.filter((line) => LAUNCHED_WORDS.includes(line))).toEqual([INBOX_LAUNCHED_LINE]);
  });

  test("a wake without it (a session the person started, a later reply): none of the launched words", () => {
    for (const wake of [inboxWakeText(command()), inboxWakeText(command(undefined, { type: "reply", reply_to: "msg_01JZASK00000000000000000", new_thread: false }))]) {
      for (const words of LAUNCHED_WORDS) expect(wake).not.toContain(words);
    }
    expect(inboxWakeText(command(undefined, { type: "reply", reply_to: "msg_01JZASK00000000000000000" })).split("\n")[1]).toBe(INBOX_WAKE_INSTRUCTION);
  });
});
