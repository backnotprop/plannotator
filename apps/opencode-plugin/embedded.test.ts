import { describe, expect, mock, test } from "bun:test";
import { deliverEmbeddedAnnotateMessagePrompt } from "./embedded";
import { OpenCodePromptDeliveryError } from "./prompt-delivery-error";

describe("embedded annotate prompt delivery", () => {
  test("delivers approved message feedback as non-blocking notes", async () => {
    const client = {
      app: { log: mock(() => {}) },
      session: { prompt: mock(async () => {}) },
    };

    await deliverEmbeddedAnnotateMessagePrompt({
      client,
      sessionId: "session-1",
      approved: true,
      feedback: "Retain this caveat.",
    });

    const prompt = client.session.prompt.mock.calls[0]?.[0].body.parts[0].text;
    expect(prompt).toContain("artifact is approved");
    expect(prompt).toContain("non-blocking guidance");
    expect(prompt).toContain("Retain this caveat.");
    expect(prompt).not.toContain("Please address");
  });

  test("logs and rejects when approved message notes cannot be injected", async () => {
    const client = {
      app: { log: mock(() => {}) },
      session: {
        prompt: mock(async () => {
          throw new Error("session busy");
        }),
      },
    };

    try {
      await deliverEmbeddedAnnotateMessagePrompt({
        client,
        sessionId: "session-1",
        approved: true,
        feedback: "Retain this caveat.",
      });
      throw new Error("Expected prompt delivery to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenCodePromptDeliveryError);
    }
    expect(client.app.log).toHaveBeenCalledWith({
      level: "error",
      message: expect.stringContaining("Could not deliver approved annotation notes"),
    });
  });
});
