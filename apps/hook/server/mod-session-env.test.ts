import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_REMINDER_ENV } from "../hooks/mod/inbox";
import { MOD_SESSION_ONLY_ENV, scrubModSessionEnv } from "./mod-session-env";

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

  // At startup, before the first spawn: beside the other variables a host hands
  // the CLI (the bridge token, the result file), ahead of every subcommand.
  test("the CLI scrubs them at startup, before it parses its arguments", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const scrub = source.indexOf("\nscrubModSessionEnv();");
    expect(scrub).toBeGreaterThan(0);
    expect(scrub).toBeLessThan(source.indexOf("const rawArgs = process.argv.slice(2);"));
    expect(source.indexOf("\ntakeEnvPullSessionBridgeConfig();")).toBeLessThan(scrub);
  });
});
