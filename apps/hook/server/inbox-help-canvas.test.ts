/**
 * `plannotator inbox --help` and `plannotator inbox call` with the canvas off (the default) and on (config.json
 * `inboxCanvas`): off, an agent reads no `canvas` section and is not offered the action; on, the guide has the
 * section and the action. What can regress: the canvas leaking into the guide of a person who never turned it on.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentEnvironmentFor } from "@plannotator/server/inbox-agents";
import { INBOX_CALL_ACTIONS, INBOX_CALL_USAGE } from "./cli";
import { parseCallCommand } from "./inbox-call-command";
import { formatInboxHelp } from "./inbox-help";

const home = join(tmpdir(), "plannotator-canvas-help-no-home");
const guide = (canvas?: boolean) =>
  formatInboxHelp({ command: ["plannotator"], dataDir: "/home/someone/.plannotator", platform: "linux", canvas, agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: { HOME: home, PATH: "" } }) });
const actionsLine = (text: string) => text.split("\n").find((line) => line.startsWith("- Actions: "))!;

describe("the canvas in the agent's guide", () => {
  test("off (the default): no canvas section and no canvas action", () => {
    for (const text of [guide(), guide(false)]) {
      expect(text.split("\n")).not.toContain("### canvas");
      expect(actionsLine(text)).not.toContain("`canvas`");
    }
  });

  test("on: the canvas section and the action are there", () => {
    const text = guide(true);
    expect(text.split("\n")).toContain("### canvas");
    expect(actionsLine(text)).toContain("`canvas`");
  });

  test("the shell's usage and an unknown action's refusal never name it, as for steps and routine", () => {
    expect(INBOX_CALL_ACTIONS).toContain("canvas");
    const usageActions = String(INBOX_CALL_USAGE).split("\n").find((line) => line.startsWith("Actions: "));
    expect(usageActions).toContain("thread_pulls");
    expect(usageActions).not.toMatch(/\bcanvas\b/);
    const refused = parseCallCommand(["nope"], INBOX_CALL_ACTIONS);
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toMatch(/\bcanvas\b/);
  });
});
