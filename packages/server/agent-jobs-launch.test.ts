/**
 * Launch-plumbing tests for the custom-reviews `reviewProfileId` field.
 *
 * These exercise the Bun POST /api/agents/jobs handler contract that the Pi
 * mirror must match byte-for-byte:
 *  - `reviewProfileId` is parsed from the body and forwarded into buildCommand.
 *  - Unknown fields are rejected (fail loud, not silently ignored).
 *  - An absent id forwards no `reviewProfileId` (review.ts resolves that to
 *    builtin:default).
 *  - The launched job carries the reviewProfileId/Label stamped by buildCommand.
 *
 * `Bun.which` is mocked so capability detection reports providers available
 * regardless of whether the host has the CLIs installed (CI parity).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const realWhich = Bun.which;
beforeEach(() => {
  // Make every provider "available" so the capability gate doesn't depend on
  // the host having claude/codex installed.
  (Bun as { which: typeof Bun.which }).which = (() => "/fake/bin") as typeof Bun.which;
});
afterEach(() => {
  (Bun as { which: typeof Bun.which }).which = realWhich;
});

// Imported after the which-mock is in place at module top so the factory's
// one-time capability scan sees available providers. createAgentJobHandler reads
// Bun.which at call time (inside the factory), so import timing is irrelevant —
// but the per-test beforeEach guarantees availability anyway.
const { createAgentJobHandler } = await import("./agent-jobs");

function post(body: unknown): Request {
  return new Request("http://localhost/api/agents/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const JOBS_URL = new URL("http://localhost/api/agents/jobs");

describe("POST /api/agents/jobs — reviewProfileId launch plumbing", () => {
  test("forwards reviewProfileId into buildCommand config", async () => {
    let seenConfig: Record<string, unknown> | undefined;
    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost:1234",
      getCwd: () => "/tmp",
      async buildCommand(_provider, config) {
        seenConfig = config;
        // Return a no-op command that won't actually spawn anything useful.
        return { command: ["true"], reviewProfileId: "user:security", reviewProfileLabel: "Security" };
      },
    });

    const res = await handler.handle(post({ provider: "codex", reviewProfileId: "user:security" }), JOBS_URL);

    expect(res?.status).toBe(201);
    expect(seenConfig?.reviewProfileId).toBe("user:security");
    handler.killAll();
  });

  test("rejects unknown fields with 400", async () => {
    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost:1234",
      getCwd: () => "/tmp",
      async buildCommand() {
        return { command: ["true"] };
      },
    });

    const res = await handler.handle(post({ provider: "codex", reviewPrompt: "inline" }), JOBS_URL);

    expect(res?.status).toBe(400);
    const json = await res!.json();
    expect(json.error).toContain("reviewPrompt");
    handler.killAll();
  });

  test("absent reviewProfileId forwards no reviewProfileId in config", async () => {
    let seenConfig: Record<string, unknown> | undefined;
    let called = false;
    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost:1234",
      getCwd: () => "/tmp",
      async buildCommand(_provider, config) {
        called = true;
        seenConfig = config;
        return { command: ["true"] };
      },
    });

    const res = await handler.handle(post({ provider: "codex" }), JOBS_URL);

    expect(res?.status).toBe(201);
    expect(called).toBe(true);
    // No config keys at all → buildCommand receives undefined (review.ts maps
    // that to builtin:default).
    expect(seenConfig?.reviewProfileId).toBeUndefined();
    handler.killAll();
  });

  test("launched job carries reviewProfileId and reviewProfileLabel stamped by buildCommand", async () => {
    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost:1234",
      getCwd: () => "/tmp",
      async buildCommand() {
        return {
          command: ["true"],
          reviewProfileId: "user:api-contracts",
          reviewProfileLabel: "API Contracts",
        };
      },
    });

    const res = await handler.handle(post({ provider: "claude", reviewProfileId: "user:api-contracts" }), JOBS_URL);

    expect(res?.status).toBe(201);
    const { job } = await res!.json();
    expect(job.reviewProfileId).toBe("user:api-contracts");
    expect(job.reviewProfileLabel).toBe("API Contracts");
    handler.killAll();
  });

  test("a job launched without a profile omits the profile fields entirely", async () => {
    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost:1234",
      getCwd: () => "/tmp",
      async buildCommand() {
        return { command: ["true"] };
      },
    });

    const res = await handler.handle(post({ provider: "codex" }), JOBS_URL);

    expect(res?.status).toBe(201);
    const { job } = await res!.json();
    expect("reviewProfileId" in job).toBe(false);
    expect("reviewProfileLabel" in job).toBe(false);
    handler.killAll();
  });
});
