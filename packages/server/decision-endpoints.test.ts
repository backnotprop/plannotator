/**
 * PR D: Tests for /api/decision poll + SSE endpoints
 *
 * For remote clients (separate process from server), the only way to get
 * the decision result is via HTTP. These endpoints provide both polling
 * and real-time SSE options.
 */
import { describe, test, expect, afterAll, beforeAll } from "bun:test";

describe("/api/decision endpoints", () => {
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

  test("GET /api/decision returns pending before user decides", async () => {
    const { startPlannotatorServer } = await import("./index");

    const controller = new AbortController();
    controllers.push(controller);
    const server = await startPlannotatorServer({
      plan: "# Test Plan",
      signal: controller.signal,
    });

    const response = await fetch(`${server.url}/api/decision`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.pending).toBe(true);
  });

  test("GET /api/decision returns result after approve", async () => {
    const { startPlannotatorServer } = await import("./index");

    const controller = new AbortController();
    controllers.push(controller);
    const server = await startPlannotatorServer({
      plan: "# Test Plan",
      signal: controller.signal,
    });

    // Approve the plan
    const approveResponse = await fetch(`${server.url}/api/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(approveResponse.status).toBe(200);

    // Now check decision
    const response = await fetch(`${server.url}/api/decision`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.pending).toBeUndefined();
    expect(body.approved).toBe(true);
  });

  test("GET /api/decision/stream returns SSE with decision result", async () => {
    const { startPlannotatorServer } = await import("./index");

    const controller = new AbortController();
    controllers.push(controller);
    const server = await startPlannotatorServer({
      plan: "# Test Plan",
      signal: controller.signal,
    });

    // Approve immediately, then start SSE — should get result immediately
    const approveResp = await fetch(`${server.url}/api/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(approveResp.status).toBe(200);

    // Now connect SSE — should immediately send the result
    const sseResponse = await fetch(`${server.url}/api/decision/stream`);
    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get("content-type")).toContain("text/event-stream");

    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    let result = "";
    // Read at least one SSE event
    for (let i = 0; i < 10; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
      if (result.includes("approved")) break;
    }
    reader.cancel();

    expect(result).toContain("data:");
    expect(result).toContain("approved");
  });
});
