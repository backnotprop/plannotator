import { describe, expect, test } from "bun:test";
import { createProvider } from "../provider.ts";
import { AntigravityLSProvider, AntigravityLSSession, buildAgyArgs } from "./antigravity-ls.ts";
import { ANTIGRAVITY_FALLBACK_MODELS, antigravityCatalogFromModels } from "@plannotator/core/model-catalog";

describe("AntigravityLSProvider", () => {
  test("creates provider from factory via createProvider", async () => {
    const provider = await createProvider({
      type: "antigravity-ls",
    });
    expect(provider).toBeInstanceOf(AntigravityLSProvider);
    expect(provider.name).toBe("antigravity-ls");
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.fork).toBe(false);
    expect(provider.capabilities.resume).toBe(true);
  });

  test("initializes with fallback models", () => {
    const provider = new AntigravityLSProvider({ type: "antigravity-ls" });
    expect(provider.models).toEqual(ANTIGRAVITY_FALLBACK_MODELS);
    expect(provider.modelsSource).toBe("fallback");
  });

  test("parses model list from agy output", () => {
    const sample = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`;
    const models = antigravityCatalogFromModels(sample);
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("gemini-3.8-flash");
    expect(models[0].default).toBe(true);
    expect(models[1].id).toBe("claude-sonnet-4-6");
  });

  test("resolves configured executable path with precedence", () => {
    const provider = new AntigravityLSProvider({
      type: "antigravity-ls",
      executablePath: "C:\\custom\\agy.exe",
    });
    expect(provider.resolveExecutablePath()).toBe("C:\\custom\\agy.exe");
  });

  test("creates session with initial plan context", async () => {
    const provider = new AntigravityLSProvider({ type: "antigravity-ls" });
    const session = await provider.createSession({
      context: {
        mode: "plan-review",
        plan: { plan: "# Implementation Plan\n\nStep 1" },
      },
    });
    expect(session).toBeInstanceOf(AntigravityLSSession);
    expect(session.id).toBeDefined();
    expect(session.isActive).toBe(false);
  });

  test("resumeSession preserves session ID", async () => {
    const provider = new AntigravityLSProvider({ type: "antigravity-ls" });
    const session = await provider.resumeSession("prev-session-123");
    expect(session.id).toBe("prev-session-123");
  });

  test("forkSession throws", async () => {
    const provider = new AntigravityLSProvider({ type: "antigravity-ls" });
    await expect(
      provider.forkSession({
        context: { mode: "plan-review", plan: { plan: "" } },
      })
    ).rejects.toThrow("Antigravity provider does not support forkSession");
  });

  describe("buildAgyArgs", () => {
    const provider = new AntigravityLSProvider({ type: "antigravity-ls" });

    test("defaults effort to medium for gemini-3.8-flash when unspecified", () => {
      const args = buildAgyArgs(
        {
          model: "gemini-3.8-flash",
          context: { mode: "plan-review", plan: { plan: "" } },
        },
        provider,
        "hello"
      );
      expect(args).toContain("--model");
      expect(args).toContain("gemini-3.8-flash");
      expect(args).toContain("--effort");
      expect(args).toContain("medium");
      expect(args).toContain("--sandbox");
      expect(args).toContain("--mode");
      expect(args).toContain("plan");
    });

    test("converts empty string or auto reasoningEffort to model default effort", () => {
      const argsWithEmpty = buildAgyArgs(
        {
          model: "gemini-3.8-flash",
          reasoningEffort: "",
          context: { mode: "plan-review", plan: { plan: "" } },
        },
        provider,
        "hello"
      );
      expect(argsWithEmpty).toContain("--effort");
      expect(argsWithEmpty).toContain("medium");

      const argsWithAuto = buildAgyArgs(
        {
          model: "gemini-3.8-flash",
          reasoningEffort: "auto",
          context: { mode: "plan-review", plan: { plan: "" } },
        },
        provider,
        "hello"
      );
      expect(argsWithAuto).toContain("--effort");
      expect(argsWithAuto).toContain("medium");
    });

    test("preserves explicit reasoning effort when provided", () => {
      const args = buildAgyArgs(
        {
          model: "gemini-3.8-flash",
          reasoningEffort: "low",
          context: { mode: "plan-review", plan: { plan: "" } },
        },
        provider,
        "hello"
      );
      expect(args).toContain("--effort");
      expect(args).toContain("low");
    });

    test("defaults gemini-3.1-pro to high effort when unspecified", () => {
      const args = buildAgyArgs(
        {
          model: "gemini-3.1-pro",
          context: { mode: "plan-review", plan: { plan: "" } },
        },
        provider,
        "hello"
      );
      expect(args).toContain("--model");
      expect(args).toContain("gemini-3.1-pro");
      expect(args).toContain("--effort");
      expect(args).toContain("high");
    });

    test("omits effort for models that do not take effort (e.g. claude)", () => {
      const args = buildAgyArgs(
        {
          model: "claude-sonnet-4-6",
          context: { mode: "plan-review", plan: { plan: "" } },
        },
        provider,
        "hello"
      );
      expect(args).toContain("--model");
      expect(args).toContain("claude-sonnet-4-6");
      expect(args).not.toContain("--effort");
    });

    test("includes conversation flag when conversationId is provided", () => {
      const args = buildAgyArgs(
        {
          context: { mode: "plan-review", plan: { plan: "" } },
        },
        provider,
        "follow up question",
        "conv-uuid-1234"
      );
      expect(args).toContain("--conversation");
      expect(args).toContain("conv-uuid-1234");
    });
  });
});

