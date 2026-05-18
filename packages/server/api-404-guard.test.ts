/**
 * PR B: Tests for API route 404 guards
 *
 * Unknown /api/* paths should return JSON 404, not HTML.
 */
import { describe, test, expect, afterAll, beforeAll } from "bun:test";

describe("API route 404 guards", () => {
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

  test("/api/nonexistent on plan server returns JSON 404", async () => {
    const { startPlannotatorServer } = await import("./index");

    const controller = new AbortController();
    controllers.push(controller);
    const server = await startPlannotatorServer({
      plan: "# Test Plan\n\nHello",
      signal: controller.signal,
    });

    const response = await fetch(`${server.url}/api/nonexistent-route`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json() as any;
    expect(body.error).toBe("Not found");
    expect(body.path).toBe("/api/nonexistent-route");
  });

  test("non-API route still serves HTML (SPA fallback)", async () => {
    const { startPlannotatorServer } = await import("./index");

    const controller = new AbortController();
    controllers.push(controller);
    const server = await startPlannotatorServer({
      plan: "# Test",
      signal: controller.signal,
    });

    const response = await fetch(`${server.url}/some/random/path`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
