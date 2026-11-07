import { describe, expect, test } from "bun:test";
import { INBOX_CLAUDE_PLUGIN_INSTALL, inboxLaunchNotReadyWords, inboxMachineLaunchWords } from "./inbox-launch-ready";
import type { InboxLaunchNotReady } from "./inbox-types";

const CODES: InboxLaunchNotReady[] = ["missing", "too_old", "plugin_off", "tool_off", "signed_out", "unknown"];

describe("why an agent can't start on a machine, in that machine's name", () => {
  test("every reason names the machine, or this computer when it is this one", () => {
    for (const code of CODES) {
      expect(inboxLaunchNotReadyWords({ agent: "Claude Code", code, machine: "Mac mini" }).line).toContain("on Mac mini");
      const here = inboxLaunchNotReadyWords({ agent: "Claude Code", code, machine: null });
      expect(here.line).toContain("on this computer");
      expect(`${here.line} ${here.fix ?? ""}`).not.toContain("null");
    }
  });

  test("signed out over SSH says why, not to sign in again (signing in would not help)", () => {
    const plain = inboxLaunchNotReadyWords({ agent: "Claude Code", code: "signed_out", machine: "Mac mini" });
    const ssh = inboxLaunchNotReadyWords({ agent: "Claude Code", code: "signed_out", machine: "Mac mini", overSsh: true });
    expect(plain.fix).toContain("`claude`");
    expect(ssh.fix).toContain("SSH");
    expect(ssh.fix).not.toContain("`claude`");
  });

  test("the plugin missing comes with the command to run there, in the fix itself too (a refusal has no copy button); nothing else hands one out", () => {
    for (const code of CODES) {
      const words = inboxLaunchNotReadyWords({ agent: "Claude Code", code, machine: "Mac mini" });
      expect(words.command).toBe(code === "plugin_off" ? INBOX_CLAUDE_PLUGIN_INSTALL : null);
    }
    const fix = inboxLaunchNotReadyWords({ agent: "Claude Code", code: "plugin_off", machine: "Mac mini" }).fix!;
    for (const line of INBOX_CLAUDE_PLUGIN_INSTALL.split("\n")) expect(fix).toContain(line);
  });

  test("launch off and a too-old Plannotator read differently: one is fixed by updating, the other is not", () => {
    expect(inboxMachineLaunchWords("Mac mini", "update")).toContain("Update Plannotator on Mac mini");
    expect(inboxMachineLaunchWords("Mac mini", "off")).not.toContain("Update");
  });
});
