/**
 * A Rex session is never given a second tab while its first may still run (inbox-rex-resume.ts).
 *
 * The failure this catches: after an Inbox restart, a reply to a Claude Code or Pi still running in its Rex tab
 * starting a second process on the same session id.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_REX_RESUME_AFTER_BOOT_MS, inboxListingRunsSession, inboxListingSessionAgents, inboxProcessListing, inboxProcessStartedAt, inboxRexResumeHeld, inboxCommandBeforeName } from "./inbox-rex-resume";

const ID = "0b9f6c1e-2d3a-4c5b-8e7f-123456789abc";
const CLAUDE = `  412   401 claude --resume ${ID} --settings /tmp/s.json --permission-mode auto`;
const TAB = `  401     1 /bin/zsh -l -c cd '/work/app' && exec claude --session-id '${ID}' --settings /tmp/s.json`;
// A running Pi as ps lists it: Pi sets process.title = "pi", so no argument names its session.
const PI = "  518   502 pi";

describe("which process runs a session", () => {
  test("Claude Code resumed, or the tab's own shell line: each names it", () => {
    for (const line of [CLAUDE, TAB]) expect(inboxListingRunsSession(`  1     0 /sbin/launchd\n${line}\n`, ID)).toBe(true);
  });

  test("a thread whose name reads like another session's flag (`--name '--resume <id>'`) is never that session's process", () => {
    const other = "99999999-2222-4333-8444-555555555555";
    const named = `  402     1 claude --session-id ${ID} --name --resume ${other} --settings /tmp/s.json`;
    const tab = `  403     1 /bin/zsh -l -c cd '/work/app' && exec claude '--session-id' '${ID}' '--name' '--session-id ${other}' '--settings' /tmp/s.json`;
    for (const line of [named, tab]) {
      expect(inboxListingRunsSession(line, other)).toBe(false);
      expect(inboxCommandBeforeName(line)).not.toContain(other);
    }
    // Its own session is still found.
    expect(inboxListingRunsSession(named, ID)).toBe(true);
  });

  test("a session the person resumed by hand with `--name` first (`claude --name foo --resume <id>`) is still that session's process, so a reply never opens a second copy", () => {
    for (const line of [`  404     1 claude --name foo --resume ${ID}`, `  405     1 claude --name 'my fix' --session-id ${ID} --settings /tmp/s.json`]) {
      expect(inboxListingRunsSession(line, ID)).toBe(true);
    }
    // A line that names no session is left whole.
    expect(inboxCommandBeforeName("claude --name foo")).toBe("claude --name foo");
  });

  test("another session, a longer id that starts the same, the id only elsewhere on the line, or a Pi (its argv is not listed): not by the listing alone", () => {
    expect(inboxListingRunsSession(CLAUDE.replace(ID, "11111111-2222-4333-8444-555555555555"), ID)).toBe(false);
    expect(inboxListingRunsSession(CLAUDE.replace(ID, `${ID}0`), ID)).toBe(false);
    expect(inboxListingRunsSession(`  9 1 grep ${ID}`, ID)).toBe(false);
    expect(inboxListingRunsSession(PI, ID)).toBe(false);
  });

  test("an OpenCode in its Rex tab (`--session ses_<id>`, its own id shape) runs it, so a reply never opens a second OpenCode on it", () => {
    const SES = "ses_1f6c2b4e8a9d0K3mQx";
    const OPENCODE = `  733   720 opencode2 --standalone --session ${SES}`;
    expect(inboxListingRunsSession(`  1     0 /sbin/launchd\n${OPENCODE}\n`, SES)).toBe(true);
    expect(inboxListingRunsSession(`  720     1 /bin/sh -c cd '/work/app' && exec env PLANNOTATOR_INBOX_TOOL=1 opencode2 --standalone --session '${SES}'\n`, SES)).toBe(true);
    // A longer id sharing the prefix (with an underscore or more letters) is another session.
    expect(inboxListingRunsSession(OPENCODE.replace(SES, `${SES}_2`), SES)).toBe(false);
    expect(inboxListingRunsSession(OPENCODE.replace(SES, `${SES}x`), SES)).toBe(false);
    expect(inboxListingSessionAgents(`  1     0 /sbin/launchd\n${OPENCODE}\n`, SES)).toEqual({ agents: [733], wrapped: false });
  });

  test("the processes Stop may end are the agent itself, never the shell or wrapper it was started from", () => {
    // A person's own shell pane ran `sh -c '… claude --resume <id>'`: only the Claude Code under it is named.
    const wrapper = `  640   600 /bin/sh -c claude --resume '${ID}'`;
    const agent = `  641   640 claude --resume ${ID}`;
    expect(inboxListingSessionAgents(`  600     1 -zsh\n${wrapper}\n${agent}\n`, ID)).toEqual({ agents: [641], wrapped: false });
    expect(inboxListingSessionAgents(`  1     0 /sbin/launchd\n${CLAUDE}\n`, ID)).toEqual({ agents: [412], wrapped: false });
    expect(inboxListingSessionAgents(`  9 1 grep ${ID}\n${PI}\n`, ID)).toEqual({ agents: [], wrapped: false });
    // `tmux new 'claude --resume <id>'` in a pane: the client (a leaf) and the server name it; Claude runs under the
    // server. Only Claude is the agent; the client never gets the signal.
    const client = `  700   600 tmux new claude --resume ${ID}`;
    const server = `  701     1 tmux new claude --resume ${ID}`;
    const underTmux = `  702   701 /Users/me/.local/share/claude/versions/2.1.327 --resume ${ID}`;
    expect(inboxListingSessionAgents(`${client}\n${server}\n${underTmux}\n`, ID)).toEqual({ agents: [702], wrapped: false });
    // Only the wrapper is listed (its agent runs where `ps` does not name it): nothing to end, and it is not gone.
    expect(inboxListingSessionAgents(`${client}\n`, ID)).toEqual({ agents: [], wrapped: true });
    // An agent run by node (an npm install): the agent too.
    expect(inboxListingSessionAgents(`  800   1 node /usr/local/lib/node_modules/opencode/bin/opencode --session ses_abc\n`, "ses_abc")).toEqual({ agents: [800], wrapped: false });
  });

  test("when a process started: this one, a moment ago or earlier; none for a pid with no process", async () => {
    const started = await inboxProcessStartedAt(process.pid);
    expect(started).not.toBeNull();
    expect(started!).toBeLessThanOrEqual(Date.now());
    expect(started!).toBeGreaterThan(Date.now() - 24 * 60 * 60_000);
    expect(await inboxProcessStartedAt(2 ** 22 + 12_345)).toBeNull();
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
