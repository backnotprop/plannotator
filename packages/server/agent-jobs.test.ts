import { describe, expect, test } from "bun:test";
import { createAgentJobHandler } from "./agent-jobs";

describe("agent job auth", () => {
  test("rejects launch requests without the session token", async () => {
    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost:19432",
      getCwd: () => process.cwd(),
      authToken: "session-token",
    });

    const req = new Request("http://localhost/api/agents/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "missing-provider",
        command: ["/usr/bin/true"],
        label: "Injected",
      }),
    });

    const res = await handler.handle(req, new URL(req.url));
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "Unauthorized agent job request" });
  });

  test("checks auth before provider validation", async () => {
    const handler = createAgentJobHandler({
      mode: "review",
      getServerUrl: () => "http://localhost:19432",
      getCwd: () => process.cwd(),
      authToken: "session-token",
    });

    const req = new Request("http://localhost/api/agents/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Plannotator-Agent-Token": "session-token",
      },
      body: JSON.stringify({
        provider: "missing-provider",
        command: ["/usr/bin/true"],
        label: "Injected",
      }),
    });

    const res = await handler.handle(req, new URL(req.url));
    expect(res?.status).toBe(400);
    expect(await res?.json()).toEqual({
      error: "Unknown or unavailable provider: missing-provider",
    });
  });
});
