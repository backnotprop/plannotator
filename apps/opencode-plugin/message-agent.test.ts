import { describe, expect, mock, test } from "bun:test";
import {
  readLastUserAgent,
  resolveAddressableAgent,
  resolveAnnotatedMessageAgent,
} from "./message-agent";

// #1612: feedback on a message must be answered by the agent that wrote it.
describe("resolveAnnotatedMessageAgent", () => {
  const messages = [
    { messageId: "latest", agent: "build" },
    { messageId: "older", agent: "agent-engineer" },
  ];

  test("the picked message names its own agent, not the latest one's", () => {
    expect(resolveAnnotatedMessageAgent(messages, { selectedMessageId: "older" })).toBe("agent-engineer");
  });

  test("without a selection the agent is known only when every candidate agrees", () => {
    expect(resolveAnnotatedMessageAgent(messages, {})).toBeUndefined();
    // The no-picker case: one candidate, and the UI sends no selection id.
    expect(resolveAnnotatedMessageAgent([{ messageId: "only", agent: "agent-engineer" }], {}))
      .toBe("agent-engineer");
  });

  test("a multi-message submission never borrows one message's agent", () => {
    expect(resolveAnnotatedMessageAgent(messages, {
      selectedMessageId: "older",
      feedbackScope: "messages",
    })).toBeUndefined();
  });

  test("an unknown selection id or an unrecorded agent resolves to nothing", () => {
    expect(resolveAnnotatedMessageAgent(messages, { selectedMessageId: "gone" })).toBeUndefined();
    expect(resolveAnnotatedMessageAgent([{ messageId: "a" }], { selectedMessageId: "a" })).toBeUndefined();
  });
});

describe("readLastUserAgent", () => {
  test("reads the most recent user message that records an agent", () => {
    expect(readLastUserAgent([
      { info: { role: "user", agent: "build" } },
      { info: { role: "user", agent: "agent-engineer" } },
      { info: { role: "assistant", agent: "compaction" } },
      { info: { role: "user" } },
    ])).toBe("agent-engineer");
    expect(readLastUserAgent(undefined)).toBeUndefined();
  });
});

describe("resolveAddressableAgent", () => {
  function client(agents: unknown[] | Error) {
    return {
      app: {
        agents: mock(async () => {
          if (agents instanceof Error) throw agents;
          return { data: agents as Array<{ name?: string; mode?: string; hidden?: boolean }> };
        }),
        log: mock(() => {}),
      },
    };
  }

  test("keeps a listed primary agent", async () => {
    expect(await resolveAddressableAgent({
      client: client([{ name: "agent-engineer", mode: "primary" }]),
      agent: "agent-engineer",
    })).toBe("agent-engineer");
  });

  // OpenCode 1 rejects a prompt naming an unknown agent ("Agent not found"),
  // which would lose the feedback; hidden agents write messages (compaction)
  // but must never be addressed.
  test("drops unlisted, hidden and subagent names, and a failed listing", async () => {
    const cases: Array<[string, unknown[] | Error]> = [
      ["agent-engineer", [{ name: "build", mode: "primary" }]],
      ["compaction", [{ name: "compaction", mode: "primary", hidden: true }]],
      ["explore", [{ name: "explore", mode: "subagent" }]],
      ["agent-engineer", new Error("offline")],
    ];
    for (const [agent, listing] of cases) {
      expect(await resolveAddressableAgent({ client: client(listing), agent })).toBeUndefined();
    }
  });
});
