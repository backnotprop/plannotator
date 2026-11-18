/**
 * A Rex session is never given a second tab while its first may still run (inbox-rex-resume.ts).
 *
 * The failure this catches: after an Inbox restart, a reply to a Claude Code or Pi still running in its Rex tab
 * starting a second process on the same session id.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_REX_RESUME_AFTER_BOOT_MS, inboxListingRunsSession, inboxListingSessionPids, inboxProcessListing, inboxRexResumeHeld } from "./inbox-rex-resume";

const ID = "0b9f6c1e-2d3a-4c5b-8e7f-123456789abc";
const CLAUDE = `  412   401 claude --resume ${ID} --settings /tmp/s.json --permission-mode auto`;
const TAB = `  401     1 /bin/zsh -l -c cd '/work/app' && exec claude --session-id '${ID}' --settings /tmp/s.json`;
// A running Pi as ps lists it: Pi sets process.title = "pi", so no argument names its session.
const PI = "  518   502 pi";

describe("which process runs a session", () => {
  test("Claude Code resumed, or the tab's own shell line: each names it", () => {
    for (const line of [CLAUDE, TAB]) expect(inboxListingRunsSession(`  1     0 /sbin/launchd\n${line}\n`, ID)).toBe(true);
  });

  test("another session, a longer id that starts the same, the id only elsewhere on the line, or a Pi (its argv is not listed): not by the listing alone", () => {
    expect(inboxListingRunsSession(CLAUDE.replace(ID, "11111111-2222-4333-8444-555555555555"), ID)).toBe(false);
    expect(inboxListingRunsSession(CLAUDE.replace(ID, `${ID}0`), ID)).toBe(false);
    expect(inboxListingRunsSession(`  9 1 grep ${ID}`, ID)).toBe(false);
    expect(inboxListingRunsSession(PI, ID)).toBe(false);
  });

  test("an OpenCode in its Rex tab (`--session <id>`) runs it, so a reply never opens a second OpenCode on it", () => {
    const OPENCODE = `  733   720 opencode2 --standalone --session ${ID}`;
    expect(inboxListingRunsSession(`  1     0 /sbin/launchd\n${OPENCODE}\n`, ID)).toBe(true);
    expect(inboxListingRunsSession(OPENCODE.replace(ID, `${ID}0`), ID)).toBe(false);
  });

  test("the processes Stop may end are the agent itself, never the shell it was started from", () => {
    // A person's own shell pane ran `sh -c '… claude --resume <id>'`: only the Claude Code under it is named.
    const wrapper = `  640   600 /bin/sh -c claude --resume '${ID}'`;
    const agent = `  641   640 claude --resume ${ID}`;
    expect(inboxListingSessionPids(`  600     1 -zsh\n${wrapper}\n${agent}\n`, ID)).toEqual([641]);
    expect(inboxListingSessionPids(`  1     0 /sbin/launchd\n${CLAUDE}\n`, ID)).toEqual([412]);
    expect(inboxListingSessionPids(`  9 1 grep ${ID}\n${PI}\n`, ID)).toEqual([]);
  });

  test("the listing is this computer's processes, this one among them", async () => {
    const listing = await inboxProcessListing();
    expect(listing).not.toBeNull();
    expect(listing!.split("\n").some((line) => new RegExp(`^\\s*${process.pid}\\s`).test(line))).toBe(true);
  });
});

describe("whether a new tab may start", () => {
  const boot = 1_000_000;
  const after = boot + INBOX_REX_RESUME_AFTER_BOOT_MS;
  const listed = (text: string | null) => async () => text;

  test("too soon after the Inbox started, nothing is even listed: its connection may not have come back yet", async () => {
    let reads = 0;
    expect(await inboxRexResumeHeld({ session: ID, now: after - 1, bootAt: boot, listing: async () => (reads++, "") })).toBe("may_run");
    expect(reads).toBe(0);
  });

  test("later: held while a process runs it or the listing failed; free when none does", async () => {
    expect(await inboxRexResumeHeld({ session: ID, now: after, bootAt: boot, listing: listed(CLAUDE) })).toBe("still_runs");
    expect(await inboxRexResumeHeld({ session: ID, now: after, bootAt: boot, listing: listed(null) })).toBe("still_runs");
    expect(await inboxRexResumeHeld({ session: ID, now: after, bootAt: boot, listing: listed("  1 0 /sbin/launchd\n") })).toBeNull();
  });

  test("a Pi: the agent's own check (its claim) reads the same listing and holds it", async () => {
    const seen: string[] = [];
    const runs = (listing: string, session: string) => (seen.push(session), listing.includes(PI));
    expect(await inboxRexResumeHeld({ session: ID, now: after, bootAt: boot, listing: listed(`  1 0 /sbin/launchd\n${PI}\n`), runs })).toBe("still_runs");
    expect(seen).toEqual([ID]);
    expect(await inboxRexResumeHeld({ session: ID, now: after, bootAt: boot, listing: listed("  1 0 /sbin/launchd\n"), runs })).toBeNull();
  });
});
