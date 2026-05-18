/**
 * PR F: Tests for optional sessionId and cwd on ServerOptions
 *
 * Adding optional sessionId/cwd fields enables future session isolation
 * without breaking any existing callers.
 */
import { describe, test, expect, afterAll, beforeAll } from "bun:test";

describe("optional sessionId/cwd on ServerOptions", () => {
  const controllers: AbortController[] = [];
  let savedPort: string | undefined;
  let savedRemote: string | undefined;

  beforeAll(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    delete process.env.PLANNOTATOR_PORT;
    delete process.env.PLANNOTATOR_REMOTE;
    delete process.env.PLANNOTATOR_SERVER_URL;
  });

  afterAll(() => {
    for (const c of controllers) c.abort();
    if (savedPort) process.env.PLANNOTATOR_PORT = savedPort;
    if (savedRemote) process.env.PLANNOTATOR_REMOTE = savedRemote;
  });

  test("ServerResult includes sessionId when provided", async () => {
    const { startPlannotatorServer } = await import("./index");

    const controller = new AbortController();
    controllers.push(controller);
    const server = await startPlannotatorServer({
      plan: "# Test",
      signal: controller.signal,
      sessionId: "my-custom-session-id",
    });

    expect(server.sessionId).toBe("my-custom-session-id");
  });

  test("ServerResult auto-generates sessionId when not provided", async () => {
    const { startPlannotatorServer } = await import("./index");

    const controller = new AbortController();
    controllers.push(controller);
    const server = await startPlannotatorServer({
      plan: "# Test",
      signal: controller.signal,
    });

    expect(server.sessionId).toBeDefined();
    expect(server.sessionId.length).toBeGreaterThan(0);
    // Should be a UUID format
    expect(server.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test("ServerResult includes cwd from options", async () => {
    const { startPlannotatorServer } = await import("./index");

    const controller = new AbortController();
    controllers.push(controller);
    const server = await startPlannotatorServer({
      plan: "# Test",
      signal: controller.signal,
      cwd: "/tmp/custom-cwd",
    });

    expect(server.cwd).toBe("/tmp/custom-cwd");
  });

  test("ServerResult defaults cwd to process.cwd()", async () => {
    const { startPlannotatorServer } = await import("./index");

    const controller = new AbortController();
    controllers.push(controller);
    const server = await startPlannotatorServer({
      plan: "# Test",
      signal: controller.signal,
    });

    expect(server.cwd).toBe(process.cwd());
  });
});
