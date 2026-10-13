import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
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

  // OpenCode runs a model turn for the command's own message whatever the hook
  // does, so feedback sent as a separate prompt ran a SECOND turn that answered
  // the same review again. Failure caught: the feedback leaving the command's
  // own message, or that message being answered by a different agent, model
  // or variant than the separate prompt was.
  const routing = [
    {
      name: "a review agent switch answers on that agent's model and variant",
      outcome: { decision: "annotated", feedback: "Rename the helper.", agentSwitch: "reviewer" },
      expected: { agent: "reviewer", model: { providerID: "acme", modelID: "careful-1", variant: "max" } },
    },
    {
      // The old prompt named no agent, so OpenCode's default agent answered on
      // the session's model, whatever the TUI had picked for the command.
      name: "no agent named: OpenCode's default agent on the session's model",
      outcome: { decision: "annotated", feedback: "Rename the helper." },
      expected: { agent: "build", model: { providerID: "acme", modelID: "everyday-1" } },
    },
  ];
  for (const { name, outcome, expected } of routing) {
    test.skipIf(process.platform === "win32")(`feedback becomes the command's own message: ${name}`, async () => {
      environment.reset();
      const root = environment.makeTempDir();
      process.env.PLANNOTATOR_DATA_DIR = root;
      const binary = path.join(root, "fake-cli.ts");
      writeFileSync(binary, `#!/usr/bin/env bun
await Bun.stdin.text();
console.log(${JSON.stringify(JSON.stringify(outcome))});
`, { mode: 0o755 });
      process.env.PLANNOTATOR_BIN = binary;

      const client: any = makeClient();
      const sent: unknown[] = [];
      client.session.prompt = async (request: unknown) => {
        sent.push(request);
        return {};
      };
      client.session.get = async () => ({ data: { id: "ses_1", model: { id: "everyday-1", providerID: "acme", variant: "default" } } });
      client.app.agents = async () => ({
        data: [
          { name: "build", mode: "primary" },
          { name: "reviewer", mode: "primary", model: { providerID: "acme", modelID: "careful-1" }, variant: "max" },
        ],
      });
      client.config.providers = async () => ({
        data: { providers: [{ id: "acme", models: { "careful-1": { variants: { max: {} } }, "everyday-1": {} } }] },
      });
      const plugin = await PlannotatorPlugin(
        { client, directory: root } as never,
        { runtime: "cli" } as never,
      ) as Record<string, any>;

      const parts: any[] = [{ type: "text", text: "stub body" }];
      await plugin["command.execute.before"](
        { command: "plannotator-review", sessionID: "ses_1", arguments: "" },
        { parts },
      );

      expect(sent).toHaveLength(0);
      expect(parts).toHaveLength(1);
      expect(parts[0].text).toContain("Rename the helper.");

      // OpenCode then builds the command's message from those parts, with the
      // agent and model the TUI picked for the command.
      const tuiPick = { agent: "plan", model: { providerID: "acme", modelID: "tui-pick", variant: "low" } };
      const message = structuredClone(tuiPick);
      await plugin["chat.message"](
        { sessionID: "ses_1", agent: "plan" },
        { message, parts: [{ ...parts[0], id: "prt_1" }] },
      );
      expect(message).toEqual(expected as never);

      // One-shot: the next message in the session is the user's own.
      const next = structuredClone(tuiPick);
      await plugin["chat.message"](
        { sessionID: "ses_1", agent: "plan" },
        { message: next, parts: [{ ...parts[0], id: "prt_2" }] },
      );
      expect(next).toEqual(tuiPick);
    }, 20_000);
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

// 0.28.1 regression: the feedback now rides the command's own message, which
// is retargeted to the feedback's agent. `/plannotator-annotate` reads "the
// agent the user is talking to" from the last user message (#1612), and up to
// 0.28.0 that was the previous command's message, still on the agent the user
// ran it on. Both sequences the 0.28.1 smoke ran are pinned to what 0.28.0 did.
// Failure caught: a follow-up annotate answered by whichever agent answered
// the PREVIOUS command's feedback (sequence B lands on `build`, which can edit
// files, for a user who is on `plan`).
describe("OpenCode 1 follow-up commands keep the user's agent", () => {
  async function session(root: string) {
    const binary = path.join(root, "fake-cli.ts");
    // One stub CLI for all three commands, answering each with feedback.
    writeFileSync(binary, `#!/usr/bin/env bun
await Bun.stdin.text();
const command = process.argv[2];
const feedback = command === "opencode-review" ? "Review feedback." : command === "opencode-annotate-last" ? "Last feedback." : "Annotate feedback.";
console.log(JSON.stringify({ decision: "annotated", feedback }));
`, { mode: 0o755 });
    process.env.PLANNOTATOR_BIN = binary;

    // The session as OpenCode stores it: messages carry the agent they were
    // built with (after any chat.message retarget).
    const messages: any[] = [];
    let nextId = 0;
    const say = (role: "user" | "assistant", agent: string, text: string) => {
      const info = { id: `msg_${String(nextId++).padStart(3, "0")}`, role, agent, model: { providerID: "fake", modelID: `${agent}-model` } };
      messages.push({ info, parts: [{ type: "text", text }] });
      return info;
    };
    const client: any = makeClient();
    client.session.messages = async () => ({ data: structuredClone(messages) });
    client.session.prompt = async () => {
      throw new Error("feedback must ride the command's own message");
    };
    client.session.get = async () => ({ data: { id: "ses_1", version: "1.18.34", model: { id: "build-model", providerID: "fake" } } });
    client.app.agents = async () => ({
      data: [
        { name: "build", mode: "primary", model: { providerID: "fake", modelID: "build-model" } },
        { name: "plan", mode: "primary", model: { providerID: "fake", modelID: "plan-model" } },
      ],
    });
    client.config.providers = async () => ({ data: { providers: [{ id: "fake", models: { "build-model": {}, "plan-model": {} } }] } });
    const plugin = await PlannotatorPlugin({ client, directory: root } as never, { runtime: "cli" } as never) as Record<string, any>;

    /** Run a command the way OpenCode 1 does; returns the agent that answers. */
    const run = async (command: string, args: string, userAgent: string): Promise<string> => {
      const parts: any[] = [];
      await plugin["command.execute.before"]({ command, sessionID: "ses_1", arguments: args }, { parts });
      // OpenCode builds the command's message on the user's agent, then lets
      // chat.message see it before storing it.
      const info: any = { id: `msg_${String(nextId++).padStart(3, "0")}`, role: "user", agent: userAgent, model: { providerID: "fake", modelID: `${userAgent}-model` } };
      const messageParts = parts.map((part, index) => ({ ...part, id: `prt_${index}` }));
      await plugin["chat.message"]({ sessionID: "ses_1", agent: userAgent }, { message: info, parts: messageParts });
      messages.push({ info, parts: messageParts });
      say("assistant", info.agent, `reply to ${command}`);
      return info.agent;
    };
    return { say, run };
  }

  test.skipIf(process.platform === "win32")("A: /plannotator-last on plan's message, then /plannotator-annotate on build", async () => {
    environment.reset();
    const root = environment.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = root;
    const { say, run } = await session(root);
    say("user", "plan", "typed on plan");
    say("assistant", "plan", "Plan answer");

    // #1612: the writer of the annotated message answers its feedback.
    expect(await run("plannotator-last", "", "build")).toBe("plan");
    // 0.28.0: the user ran this on build, so build answers.
    expect(await run("plannotator-annotate", "notes.md", "build")).toBe("build");
  }, 20_000);

  test.skipIf(process.platform === "win32")("B: /plannotator-review on plan with no switch, then /plannotator-annotate on plan", async () => {
    environment.reset();
    const root = environment.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = root;
    const { say, run } = await session(root);
    say("user", "plan", "typed on plan");
    say("assistant", "plan", "Plan answer");

    // No agent named: OpenCode's default agent answered the review feedback.
    expect(await run("plannotator-review", "", "plan")).toBe("build");
    // 0.28.0: the annotate feedback goes back to plan, never to build.
    expect(await run("plannotator-annotate", "notes.md", "plan")).toBe("plan");
  }, 20_000);
});
