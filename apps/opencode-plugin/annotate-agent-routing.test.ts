import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { handleCliCommand } from "./cli-bridge";
import { createV2BridgeClient } from "./v2-client";

// #1612, CLI-bridge runtime (the reporter's `cli` plugin runtime, and the path
// OpenCode 2's native commands run through): feedback from /plannotator-last is
// delivered to the agent that wrote the annotated message.

const environment = createTestEnvironment(
  ["PLANNOTATOR_BIN", "PLANNOTATOR_TEST_OUTCOME", "PLANNOTATOR_TEST_RECORD_FILE"],
  "plannotator-opencode-agent-routing-",
);
const fixturePath = fileURLToPath(new URL("./fixtures/test-annotate-cli.ts", import.meta.url));

afterEach(() => environment.restore());

function prepare(outcome: Record<string, unknown>): string {
  environment.reset();
  const recordFile = path.join(environment.makeTempDir(), "record.json");
  process.env.PLANNOTATOR_BIN = fixturePath;
  process.env.PLANNOTATOR_TEST_OUTCOME = JSON.stringify(outcome);
  process.env.PLANNOTATOR_TEST_RECORD_FILE = recordFile;
  return recordFile;
}

/** A session where the user switched from `build` to a custom agent. */
const V1_MESSAGES = [
  { info: { role: "user", id: "u1", agent: "agent-engineer" }, parts: [{ type: "text", text: "q" }] },
  { info: { role: "assistant", id: "a1", agent: "agent-engineer" }, parts: [{ type: "text", text: "Engineer answer" }] },
  { info: { role: "user", id: "u2", agent: "build" }, parts: [{ type: "text", text: "q2" }] },
  { info: { role: "assistant", id: "a2", agent: "build" }, parts: [{ type: "text", text: "Build answer" }] },
];

const AGENTS = [
  { name: "build", mode: "primary" },
  { name: "agent-engineer", mode: "primary" },
];

function v1Client(messages: unknown[] = V1_MESSAGES, agents: unknown[] = AGENTS) {
  return {
    app: {
      log: mock((_entry: unknown) => {}),
      agents: mock(async (_input?: unknown) => ({ data: agents as never[] })),
    },
    session: {
      messages: mock(async (_input: unknown) => ({ data: messages as never[] })),
      prompt: mock(async (_input: unknown) => ({})),
    },
  };
}

function deliveredBody(client: ReturnType<typeof v1Client>): Record<string, unknown> {
  expect(client.session.prompt).toHaveBeenCalledTimes(1);
  return (client.session.prompt.mock.calls[0]![0] as { body: Record<string, unknown> }).body;
}

async function runLast(client: unknown) {
  await handleCliCommand({
    command: "plannotator-last",
    client: client as never,
    sessionId: "session-1",
    rawArgs: "",
  });
}

describe("/plannotator-last over the CLI bridge (OpenCode 1)", () => {
  test("feedback on a custom agent's message names that agent", async () => {
    const recordFile = prepare({ decision: "annotated", feedback: "Tighten this.", selectedMessageId: "a1" });
    const client = v1Client();

    await runLast(client);

    expect(deliveredBody(client).agent).toBe("agent-engineer");
    // The agent stays plugin-side: the binary's payload is unchanged.
    const stdin = JSON.parse(JSON.parse(readFileSync(recordFile, "utf8")).stdin);
    expect(stdin.recentMessages.map((m: Record<string, unknown>) => Object.keys(m).sort()))
      .toEqual([["messageId", "text"], ["messageId", "text"]]);
  });

  test("approve-with-notes on a picked message names that message's agent", async () => {
    prepare({ decision: "approved", feedback: "Keep this caveat.", selectedMessageId: "a1" });
    const client = v1Client();

    await runLast(client);

    expect(deliveredBody(client).agent).toBe("agent-engineer");
  });

  test("an unknown writer leaves the prompt exactly as before (no agent key)", async () => {
    prepare({ decision: "annotated", feedback: "Tighten this.", selectedMessageId: "a1" });
    // An older OpenCode that records no agent on its messages.
    const client = v1Client(V1_MESSAGES.map((m) => ({ ...m, info: { ...m.info, agent: undefined } })));

    await runLast(client);

    expect("agent" in deliveredBody(client)).toBe(false);
    expect(client.app.agents).not.toHaveBeenCalled();
  });

  test("an agent that is no longer configured is not named", async () => {
    prepare({ decision: "annotated", feedback: "Tighten this.", selectedMessageId: "a1" });
    const client = v1Client(V1_MESSAGES, [{ name: "build", mode: "primary" }]);

    await runLast(client);

    expect("agent" in deliveredBody(client)).toBe(false);
  });
});

describe("/plannotator-annotate over the CLI bridge (OpenCode 1)", () => {
  test("file feedback goes to the agent the user is talking to", async () => {
    prepare({ decision: "annotated", feedback: "Rename section 2." });
    const client = v1Client(V1_MESSAGES.slice(0, 2));

    await handleCliCommand({
      command: "plannotator-annotate",
      client: client as never,
      sessionId: "session-1",
      rawArgs: "notes.md",
    });

    expect(deliveredBody(client).agent).toBe("agent-engineer");
  });
});

describe("/plannotator-last over the CLI bridge (OpenCode 2)", () => {
  /** Flat V2 messages; assistants carry `agent`, users do not. */
  const V2_CONTEXT = [
    { id: "a1", type: "assistant", agent: "agent-engineer", content: [{ type: "text", text: "Engineer answer" }] },
    { id: "a2", type: "assistant", agent: "build", content: [{ type: "text", text: "Build answer" }] },
  ];

  function v2Client(sessionAgent: string) {
    const switchAgent = mock(async (_input: { sessionID: string; agent: string }) => ({}));
    const prompt = mock(async (_input: unknown) => ({}));
    const client = createV2BridgeClient({
      ctx: {
        session: {
          context: async () => V2_CONTEXT,
          get: async () => ({ agent: sessionAgent }) as never,
          switchAgent,
          prompt,
        },
      },
      getAgents: async () => AGENTS,
      warn: () => {},
    });
    return { client, switchAgent, prompt };
  }

  test("switches the session to the annotated message's agent before delivering", async () => {
    prepare({ decision: "annotated", feedback: "Tighten this.", selectedMessageId: "a1" });
    const { client, switchAgent, prompt } = v2Client("build");

    await runLast(client);

    expect(switchAgent).toHaveBeenCalledWith({ sessionID: "session-1", agent: "agent-engineer" });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  // `Session.switchAgent` writes an `agent-switched` transcript row every
  // time, so a no-op switch must not be requested.
  test("already on that agent: no switch row, feedback still delivered", async () => {
    prepare({ decision: "annotated", feedback: "Tighten this.", selectedMessageId: "a1" });
    const { client, switchAgent, prompt } = v2Client("agent-engineer");

    await runLast(client);

    expect(switchAgent).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
