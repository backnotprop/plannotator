/**
 * Droid's `/plannotator-inbox` is a script whose output the agent reads: the
 * address, the CLI's note, then the Inbox briefing. Failure caught: the
 * briefing (or the address) never printed, or a failed open reported as
 * success. Runs the real script against a stand-in `plannotator`.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_BRIEFING_FROM_NOW_ON, INBOX_FOLLOW_THROUGH_RULE } from "../packages/shared/inbox/connection";
import { runDroidInboxCommand } from "./helpers/droid-inbox-command";

describe.skipIf(process.platform === "win32")("Droid /plannotator-inbox", () => {
  test("opened: prints the address, the CLI's note, then the briefing", () => {
    const run = runDroidInboxCommand("echo 'http://127.0.0.1:61234/'; echo 'No browser opened: this is a remote session.' >&2");
    expect(run.argv).toBe("inbox --open");
    expect(run.status).toBe(0);
    const lines = run.stdout.split("\n");
    expect(lines[0]).toBe("Plannotator Inbox: http://127.0.0.1:61234/");
    expect(lines[1]).toBe("No browser opened: this is a remote session.");
    expect(run.stdout).toContain(INBOX_FOLLOW_THROUGH_RULE);
    expect(run.stdout).toContain(INBOX_BRIEFING_FROM_NOW_ON);
    expect(run.stdout.indexOf("Plannotator Inbox: ")).toBeLessThan(run.stdout.indexOf("## Using the Inbox"));
  });

  test("failed: exits with the CLI's status and its error, and no briefing", () => {
    const run = runDroidInboxCommand("echo 'Unknown inbox option: --open' >&2; exit 1");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Unknown inbox option: --open");
    expect(run.stdout).not.toContain("## Using the Inbox");
  });
});
