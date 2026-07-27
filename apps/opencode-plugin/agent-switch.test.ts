import { describe, expect, mock, test } from "bun:test";
import { resolveTargetAgent, resolveValidatedTargetAgent } from "./agent-switch";

describe("OpenCode agent switch validation", () => {
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
