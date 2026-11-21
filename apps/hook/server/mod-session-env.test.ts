import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_REMINDER_ENV } from "../hooks/mod/inbox";
import { parsePlanReviewEnv } from "@plannotator/shared/config";
import { HOST_PLAN_CARD_ENV, HOST_PLAN_CARD_MARKER } from "../hooks/mod/enabled";
import { MOD_PLAN_REVIEW_MARKER, MOD_SESSION_ONLY_ENV, planReviewEnvFor, scrubModSessionEnv } from "./mod-session-env";

describe("variables the mod sets for its plugin's hooks only", () => {
  test("the Inbox reminder is one of them, under the name the mod sets", () => {
    expect(MOD_SESSION_ONLY_ENV).toContain(INBOX_REMINDER_ENV);
  });

  test("scrubbed from the environment; everything else kept", () => {
    const env: NodeJS.ProcessEnv = {
      [INBOX_REMINDER_ENV]: "Plannotator Inbox is on: …",
      PLANNOTATOR_SESSION_TAG: "claude-code:s-1",
      PATH: "/usr/bin",
    };
    scrubModSessionEnv(env);
    expect(INBOX_REMINDER_ENV in env).toBe(false);
    expect(env.PLANNOTATOR_SESSION_TAG).toBe("claude-code:s-1");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("the plan review switch's marker is the name the mod sets", () => {
    expect(MOD_PLAN_REVIEW_MARKER).toBe(HOST_PLAN_CARD_MARKER);
    expect(HOST_PLAN_CARD_ENV).toEqual({ name: "PLANNOTATOR_PLAN_REVIEW", value: "0" });
  });

  // A host plan card session's `0` must not reach a later Claude Code through a
  // server, the Inbox or an "Open in" terminal this process starts.
  test("the mod's marked 0 is scrubbed and kept for this process's own plan hook; a person's own value stays", () => {
    const marked: NodeJS.ProcessEnv = { PLANNOTATOR_PLAN_REVIEW: "0", [MOD_PLAN_REVIEW_MARKER]: "claude-code:orca-1", PATH: "/usr/bin" };
    expect(scrubModSessionEnv(marked)).toEqual({ setBy: "claude-code:orca-1" });
    expect(["PLANNOTATOR_PLAN_REVIEW" in marked, MOD_PLAN_REVIEW_MARKER in marked, marked.PATH]).toEqual([false, false, "/usr/bin"]);

    for (const value of ["0", "1", "off"]) {
      const own: NodeJS.ProcessEnv = { PLANNOTATOR_PLAN_REVIEW: value };
      expect(scrubModSessionEnv(own)).toBeNull();
      expect(own.PLANNOTATOR_PLAN_REVIEW).toBe(value);
    }
    // A marker beside a value that is not the mod's `0` (the person changed it): the marker goes, the value stays.
    const changed: NodeJS.ProcessEnv = { PLANNOTATOR_PLAN_REVIEW: "1", [MOD_PLAN_REVIEW_MARKER]: "claude-code:orca-1" };
    expect(scrubModSessionEnv(changed)).toBeNull();
    expect([changed.PLANNOTATOR_PLAN_REVIEW, MOD_PLAN_REVIEW_MARKER in changed]).toEqual(["1", false]);
  });

  test("the plan hook counts the mod's 0 only for the session that set it", () => {
    const modSwitch = { setBy: "claude-code:orca-1" };
    expect(parsePlanReviewEnv(planReviewEnvFor(modSwitch, "orca-1", {}))).toBe(false);
    expect(parsePlanReviewEnv(planReviewEnvFor(modSwitch, "terminal-2", {}))).toBeUndefined();
    expect(parsePlanReviewEnv(planReviewEnvFor(modSwitch, undefined, {}))).toBeUndefined();
    // No mod switch: the environment as it is (a person's own value).
    expect(parsePlanReviewEnv(planReviewEnvFor(null, "orca-1", { PLANNOTATOR_PLAN_REVIEW: "off" }))).toBe(false);
  });

  // At startup, before the first spawn: beside the other variables a host hands
  // the CLI (the bridge token, the result file), ahead of every subcommand.
  test("the CLI scrubs them at startup, before it parses its arguments", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const scrub = source.indexOf("\nconst modPlanReviewSwitch = scrubModSessionEnv();");
    expect(scrub).toBeGreaterThan(0);
    expect(scrub).toBeLessThan(source.indexOf("const rawArgs = process.argv.slice(2);"));
    expect(source.indexOf("\ntakeEnvPullSessionBridgeConfig();")).toBeLessThan(scrub);
  });
});
