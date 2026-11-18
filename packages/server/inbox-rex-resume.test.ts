/**
 * A Rex session is never given a second tab while its first may still run (inbox-rex-resume.ts).
 *
 * The failure this catches: after an Inbox restart, a reply to a Claude Code or Pi still running in its Rex tab
 * starting a second process on the same session id.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_REX_MAY_RUN, INBOX_REX_STILL_RUNS } from "@plannotator/core/inbox-run-line";
import { INBOX_REX_RESUME_AFTER_BOOT_MS, inboxListingRunsSession, inboxRexResumeHeld } from "./inbox-rex-resume";

const ID = "0b9f6c1e-2d3a-4c5b-8e7f-123456789abc";
const CLAUDE = `  412   401 claude --resume ${ID} --settings /tmp/s.json --permission-mode auto`;
const PI = `  518   502 node /opt/pi/bin/pi --session-id ${ID} --model x`;
const TAB = `  401     1 /bin/zsh -l -c cd '/work/app' && exec claude --session-id '${ID}' --settings /tmp/s.json`;

describe("which process runs a session", () => {
  test("Claude Code resumed, Pi started, or the tab's own shell line: each names it", () => {
    for (const line of [CLAUDE, PI, TAB]) expect(inboxListingRunsSession(`  1     0 /sbin/launchd\n${line}\n`, ID)).toBe(true);
  });

  test("another session, a longer id that starts the same, or the id only elsewhere on the line: not it", () => {
    expect(inboxListingRunsSession(CLAUDE.replace(ID, "11111111-2222-4333-8444-555555555555"), ID)).toBe(false);
    expect(inboxListingRunsSession(CLAUDE.replace(ID, `${ID}0`), ID)).toBe(false);
    expect(inboxListingRunsSession(`  9 1 grep ${ID}`, ID)).toBe(false);
  });
});

describe("whether a new tab may start", () => {
  const boot = 1_000_000;
  const after = boot + INBOX_REX_RESUME_AFTER_BOOT_MS;

  test("too soon after the Inbox started, nothing is even listed: its connection may not have come back yet", () => {
    let listed = 0;
    expect(inboxRexResumeHeld({ session: ID, now: after - 1, bootAt: boot, listing: () => (listed++, "") })).toBe(INBOX_REX_MAY_RUN);
    expect(listed).toBe(0);
  });

  test("later: held while a process runs it (Claude Code or Pi) or the listing failed; free when none does", () => {
    expect(inboxRexResumeHeld({ session: ID, now: after, bootAt: boot, listing: () => CLAUDE })).toBe(INBOX_REX_STILL_RUNS);
    expect(inboxRexResumeHeld({ session: ID, now: after, bootAt: boot, listing: () => PI })).toBe(INBOX_REX_STILL_RUNS);
    expect(inboxRexResumeHeld({ session: ID, now: after, bootAt: boot, listing: () => null })).toBe(INBOX_REX_STILL_RUNS);
    expect(inboxRexResumeHeld({ session: ID, now: after, bootAt: boot, listing: () => "  1 0 /sbin/launchd\n" })).toBeNull();
  });
});
