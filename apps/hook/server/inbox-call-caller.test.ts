/**
 * `plannotator inbox call --session <id>` with a bare id (no host) in a shell that names that very session: the call
 * is that session, host and name too. Before, it was refused as a mismatch with itself, and where it went through it
 * wrote as a session with no host: a reply to that message read as for "An agent", and the window could not tell it
 * from a script nothing wakes. Only the rule (inbox-call-command.test.ts proves the command through a real Inbox).
 */
import { expect, test } from "bun:test";
import { inboxCallerOf } from "./inbox-call-command";

const caller = (flag: string | null, env: Record<string, string>) => {
  const answer = inboxCallerOf(flag, env);
  return answer.ok ? answer.caller : answer.code;
};

test("a bare --session id this shell names is that session, with its host and name", () => {
  expect(caller("ses-ops", { PLANNOTATOR_SESSION_TAG: "claude-code:ses-ops" })).toEqual({ host: "claude-code", session: "ses-ops", name: "Claude Code" });
  expect(caller("ses-pi", { PI_SESSION_ID: "ses-pi" })).toEqual({ host: "pi", session: "ses-pi", name: "Pi" });
  // Beside another agent's marker the shell's own session still names it.
  expect(caller("ses-ops", { PLANNOTATOR_SESSION_TAG: "claude-code:ses-ops", OPENCODE: "1" })).toEqual({ host: "claude-code", session: "ses-ops", name: "Claude Code" });
});

test("anything else is as before: another id is refused, a shell that names no session keeps the bare id, no flag is the shell's session", () => {
  expect(caller("ses-other", { PLANNOTATOR_SESSION_TAG: "claude-code:ses-ops" })).toBe("session_mismatch");
  expect(caller("ses-ops", {})).toEqual({ session: "ses-ops" });
  expect(caller("ses-ops", { CLAUDECODE: "1" })).toEqual({ session: "ses-ops" });
  expect(caller(null, { PLANNOTATOR_SESSION_TAG: "claude-code:ses-ops" })).toEqual({ host: "claude-code", session: "ses-ops", name: "Claude Code" });
  expect(caller(null, {})).toBeNull();
});
