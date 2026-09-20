import { afterEach, describe, expect, test } from "bun:test";
import { createTestEnvironment } from "../../tests/helpers/environment";
import PlannotatorPlugin from "./index";

/**
 * OpenCode 1 slash-command interception.
 *
 * The V1 plugin clears `output.parts` IN PLACE before anything reaches the
 * model. Now that the shared markdown stubs carry real instructions ("run the
 * plannotator CLI and relay stdout", for OpenCode 2 hosts on the stale
 * channels), a regression here would leak those instructions to the OpenCode 1
 * model and re-open the #713 class: OpenCode resolves prompt parts over
 * "<body> <arguments>" and auto-attaches any file path it finds, which on a
 * large file blows the context before the annotation UI even opens.
 *
 * Interception lives on the always-built plugin object; `shouldRegisterSubmitPlan`
 * only gates `plugin.tool`, so `workflow: "manual"` must intercept too.
 */

const envKeys = ["PLANNOTATOR_BIN", "PLANNOTATOR_DATA_DIR"] as const;
const environment = createTestEnvironment(envKeys, "plannotator-oc1-intercept-");

afterEach(() => environment.restore());

const COMMANDS = ["plannotator-review", "plannotator-annotate", "plannotator-last"] as const;

function makeClient() {
  return {
    app: {
      log: async () => ({}),
      agents: async () => ({ data: [] }),
    },
    config: { get: async () => ({ data: {} }) },
    session: {
      messages: async () => ({ data: [] }),
      prompt: async () => ({}),
    },
  };
}

async function interceptionHandler(options: Record<string, unknown>) {
  const plugin = await PlannotatorPlugin(
    { client: makeClient(), directory: "/project" } as never,
    // "cli" keeps the embedded server out of the test; the CLI spawn then fails
    // fast against the bogus PLANNOTATOR_BIN below and is swallowed by
    // handleCliCommand's own catch.
    { runtime: "cli", ...options } as never,
  );
  return (plugin as Record<string, any>)["command.execute.before"] as (
    input: Record<string, unknown>,
    output: { parts: unknown[] },
  ) => Promise<void>;
}

describe("OpenCode 1 command interception", () => {
  for (const workflow of ["plan-agent", "manual"] as const) {
    for (const command of COMMANDS) {
      test(`${workflow}: /${command} empties output.parts before the model sees it`, async () => {
        environment.reset();
        process.env.PLANNOTATOR_BIN = "/nonexistent/plannotator-interception-test";
        process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();

        const handler = await interceptionHandler({ workflow });
        const parts = [{ type: "text", text: "run the plannotator CLI and relay stdout" }];
        const output = { parts };

        await handler(
          { command, sessionID: "session-1", arguments: "" },
          output,
        );

        expect(parts.length).toBe(0);
        // Mutated in place, never reassigned: the caller holds this exact array
        // and ignores anything assigned to output.parts.
        expect(output.parts).toBe(parts);
      });
    }
  }

  test("an unrelated command keeps its parts untouched", async () => {
    environment.reset();
    process.env.PLANNOTATOR_BIN = "/nonexistent/plannotator-interception-test";
    process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();

    const handler = await interceptionHandler({ workflow: "plan-agent" });
    const output = { parts: [{ type: "text", text: "someone else's command" }] };
    await handler({ command: "other-command", sessionID: "session-1", arguments: "" }, output);

    expect(output.parts.length).toBe(1);
  });
});
