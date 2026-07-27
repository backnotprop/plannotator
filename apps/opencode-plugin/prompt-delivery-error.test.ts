import { describe, expect, test } from "bun:test";
import {
  deliverOpenCodePrompt,
  OpenCodePromptDeliveryError,
  shouldFallbackAfterEmbeddedError,
} from "./prompt-delivery-error";

describe("OpenCode prompt-delivery errors", () => {
  test("never falls back after prompt delivery fails", () => {
    const deliveryError = new OpenCodePromptDeliveryError("delivery failed");

    expect(shouldFallbackAfterEmbeddedError("auto", deliveryError)).toBe(false);
    expect(shouldFallbackAfterEmbeddedError("embedded", deliveryError)).toBe(false);
  });

  test("recognizes delivery errors across separately bundled runtimes", () => {
    const bundledError = Object.assign(new Error("delivery failed"), {
      name: "OpenCodePromptDeliveryError",
      code: "PLANNOTATOR_OPENCODE_PROMPT_DELIVERY",
    });

    expect(shouldFallbackAfterEmbeddedError("auto", bundledError)).toBe(false);
  });

  test("keeps existing fallback policy for runtime startup failures", () => {
    const startupError = new Error("embedded bundle unavailable");

    expect(shouldFallbackAfterEmbeddedError("auto", startupError)).toBe(true);
    expect(shouldFallbackAfterEmbeddedError("embedded", startupError)).toBe(false);
  });

  test("treats a missing session prompt API as a delivery failure", async () => {
    const client = {
      app: { log: () => {} },
      session: {},
    };

    await expect(deliverOpenCodePrompt({
      client,
      prompt: { path: { id: "session-1" } },
      failureMessage: "Could not deliver notes.",
    })).rejects.toBeInstanceOf(OpenCodePromptDeliveryError);
  });
});
