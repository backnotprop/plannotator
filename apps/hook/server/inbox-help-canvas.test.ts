/**
 * `plannotator inbox --help` and `plannotator inbox call` with the canvas off (the default) and on (config.json
 * `inboxCanvas`). The canvas is a command, `plannotator inbox canvas`, never an action of the agent tool (the owner,
 * 2026-11-24): off, an agent reads no word of it; on, one line under "Commands and flags" points at its own --help.
 * What can regress: a `canvas` action or tool section coming back, or the canvas leaking into the guide of a person
 * who never turned it on.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentEnvironmentFor } from "@plannotator/server/inbox-agents";
import { INBOX_CALL_ACTIONS, INBOX_CALL_USAGE } from "./cli";
import { parseCallCommand } from "./inbox-call-command";
import { formatInboxHelp, INBOX_CANVAS_COMMAND_LINE } from "./inbox-help";

const home = join(tmpdir(), "plannotator-canvas-help-no-home");
const guide = (canvas?: boolean) =>
  formatInboxHelp({ command: ["plannotator"], dataDir: "/home/someone/.plannotator", platform: "linux", canvas, agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: { HOME: home, PATH: "" } }) });
const actionsLine = (text: string) => text.split("\n").find((line) => line.startsWith("- Actions: "))!;

describe("the canvas in the agent's guide", () => {
  test("off (the default): not a word of the canvas", () => {
    for (const text of [guide(), guide(false)]) {
      expect(text).not.toContain("inbox canvas");
      expect(text.split("\n")).not.toContain("### canvas");
      expect(actionsLine(text)).not.toContain("`canvas`");
    }
  });

  test("on: one line naming the command's --help, and still no canvas action or tool section", () => {
    const text = guide(true);
    expect(text.split("\n")).toContain(INBOX_CANVAS_COMMAND_LINE);
    expect(text.split("\n")).not.toContain("### canvas");
    expect(actionsLine(text)).not.toContain("`canvas`");
    // Everything else is the same guide: the line is all the canvas adds.
    expect(text.replace(`\n\n${INBOX_CANVAS_COMMAND_LINE}`, "")).toBe(guide(false));
  });

  test("inbox call has no canvas action to name or to take", () => {
    expect(INBOX_CALL_ACTIONS).not.toContain("canvas");
    expect(String(INBOX_CALL_USAGE)).not.toMatch(/\bcanvas\b/);
    const refused = parseCallCommand(["canvas", "{}"], INBOX_CALL_ACTIONS);
    expect(refused).toMatchObject({ ok: false, code: "unknown_action" });
  });
});
