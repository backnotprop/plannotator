import { describe, expect, mock, test } from "bun:test";
import {
  getAssistantMessageModel,
  resolveTargetAgent,
  resolveValidatedTargetAgent,
  shouldPreserveActiveModel,
} from "./agent-switch";

describe("OpenCode agent switch validation", () => {
  test("preserves the active model unless the target agent's default is explicitly requested", () => {
    expect(shouldPreserveActiveModel(undefined)).toBe(true);
    expect(shouldPreserveActiveModel("current")).toBe(true);
    expect(shouldPreserveActiveModel("agent-default")).toBe(false);
  });
  test("reads the model from the assistant message that submitted the plan", async () => {
    const message = mock(async () => ({
      data: {
        info: {
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-opus-5",
        },
      },
    }));

    await expect(getAssistantMessageModel({
      client: { session: { message } },
      sessionId: "session-1",
      messageId: "message-1",
    })).resolves.toEqual({ providerID: "anthropic", modelID: "claude-opus-5" });

    expect(message).toHaveBeenCalledWith({
      path: { id: "session-1", messageID: "message-1" },
    });
  });

  test("omits unavailable or malformed assistant message models", async () => {
    const malformed = await getAssistantMessageModel({
      client: {
        session: {
          message: async () => ({
            data: { info: { role: "assistant", providerID: "anthropic" } },
          }),
        },
      },
      sessionId: "session-1",
      messageId: "message-1",
    });
    expect(malformed).toBeUndefined();

    const unavailable = await getAssistantMessageModel({
      client: { session: { message: async () => { throw new Error("not found"); } } },
      sessionId: "session-1",
      messageId: "message-1",
    });
    expect(unavailable).toBeUndefined();
  });

  test("preserves no-agent defaults", () => {
    expect(resolveTargetAgent(undefined)).toBeUndefined();
    expect(resolveTargetAgent("disabled")).toBeUndefined();
    expect(resolveTargetAgent("   ")).toBeUndefined();
  });

  test("normalizes no-agent defaults before validation", async () => {
    const agents = mock(async () => ({ data: [{ name: "build" }] }));

    await expect(resolveValidatedTargetAgent({
      client: { app: { agents } },
      targetAgent: "disabled",
    })).resolves.toBeUndefined();

    expect(agents).not.toHaveBeenCalled();
  });

  test("keeps explicit agents that OpenCode reports", async () => {
    const agents = mock(async () => ({
      data: [{ name: "plan" }, { name: "build" }],
    }));
    const showToast = mock(() => undefined);
    const client = {
      app: { agents },
      tui: { showToast },
    };

    await expect(resolveValidatedTargetAgent({
      client,
      targetAgent: "build",
      directory: "/repo",
    })).resolves.toBe("build");

    expect(agents).toHaveBeenCalledWith({ query: { directory: "/repo" } });
    expect(showToast).not.toHaveBeenCalled();
  });

  test("omits invalid explicit agents and warns visibly", async () => {
    const agents = mock(async () => ({ data: [{ name: "plan" }] }));
    const log = mock(() => undefined);
    const showToast = mock(() => undefined);
    const client = {
      app: { agents, log },
      tui: { showToast },
    };

    await expect(resolveValidatedTargetAgent({
      client,
      targetAgent: "build",
    })).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith({
      level: "info",
      message: '[Plannotator] Configured OpenCode agent "build" is not available; sending feedback without switching agents.',
    });
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: "Plannotator",
        message: 'Configured OpenCode agent "build" is not available; sending feedback without switching agents.',
        variant: "warning",
      },
    });
  });

  test("names plan approval in the warning on the plan path", async () => {
    const agents = mock(async () => ({ data: [{ name: "plan" }] }));
    const log = mock(() => undefined);
    const showToast = mock(() => undefined);
    const client = {
      app: { agents, log },
      tui: { showToast },
    };

    await expect(resolveValidatedTargetAgent({
      client,
      targetAgent: "build",
      delivery: "plan-approval",
    })).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith({
      level: "info",
      message: '[Plannotator] Configured OpenCode agent "build" is not available; approving the plan without switching agents.',
    });
  });

  test("omits explicit agents when OpenCode agent lookup fails", async () => {
    const agents = mock(async () => {
      throw new Error("agents unavailable");
    });
    const showToast = mock(() => undefined);
    const client = {
      app: { agents },
      tui: { showToast },
    };

    await expect(resolveValidatedTargetAgent({
      client,
      targetAgent: "build",
    })).resolves.toBeUndefined();

    expect(showToast).toHaveBeenCalled();
  });
});
