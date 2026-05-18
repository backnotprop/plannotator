import { describe, expect, test } from "vitest";
import { completeSession, createSimulatorDaemonClient } from "./client";

describe("simulator daemon completion client", () => {
  test.each([
    ["plan", "/api/approve", { planSave: { enabled: false } }],
    ["review", "/api/feedback", { approved: true, feedback: "LGTM", annotations: [] }],
    ["annotate", "/api/approve", {}],
    ["archive", "/api/done", {}],
  ] as const)("completes %s sessions through the session API", async (mode, path, body) => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, init });
      return Response.json({ ok: true });
    }) as typeof fetch;

    await completeSession(fetchImpl, "http://127.0.0.1:19432/s/session-1", mode);

    expect(requests[0].url).toBe(`http://127.0.0.1:19432/s/session-1${path}`);
    expect(requests[0].init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0].init?.body))).toEqual(body);
  });

  test("posts debug logs to the daemon event stream", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, init });
      return Response.json({ ok: true });
    }) as typeof fetch;

    await createSimulatorDaemonClient("http://127.0.0.1:19432", fetchImpl, { authToken: "secret" }).postDebugLog({
      source: "agent-simulator",
      scenarioId: "claude-plan-hook",
      message: "queued claude-plan-hook",
    });

    expect(requests[0].url).toBe("http://127.0.0.1:19432/daemon/events/debug");
    expect(requests[0].init?.method).toBe("POST");
    expect(new Headers(requests[0].init?.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      source: "agent-simulator",
      scenarioId: "claude-plan-hook",
      message: "queued claude-plan-hook",
    });
  });
});
