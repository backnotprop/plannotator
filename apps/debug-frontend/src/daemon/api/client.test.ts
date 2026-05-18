import { describe, expect, test } from "vitest";
import { createDaemonErrorResponse } from "@plannotator/shared/daemon-protocol";
import { sessionBootstrap, sessionListFixture } from "../../testing/fixtures/daemon";
import { createFixtureFetch } from "../../testing/fetch";
import { createDaemonApiClient } from "./client";

describe("daemon API client", () => {
  test("loads daemon session bootstrap through the session-scoped API base", async () => {
    const bootstrap = sessionBootstrap("plan", 1);
    const fixture = createFixtureFetch({
      "/s/plan-session-1/api/session": bootstrap,
    });
    const client = createDaemonApiClient({ fetch: fixture.fetch });

    const result = await client.getSessionBootstrap("plan-session-1");

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.apiBase).toBe("/s/plan-session-1/api");
    expect(fixture.requests).toEqual([{ url: "/s/plan-session-1/api/session", init: undefined }]);
    expect(fixture.requests[0].url).not.toBe("/api/session");
  });

  test("lists sessions from the daemon control plane", async () => {
    const fixture = createFixtureFetch({
      "/daemon/sessions?clean=1": sessionListFixture,
    });
    const client = createDaemonApiClient({ fetch: fixture.fetch });

    const result = await client.listSessions({ clean: true });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.sessions).toHaveLength(5);
  });

  test("builds daemon event and session-scoped API URLs", () => {
    const client = createDaemonApiClient({ baseUrl: "http://127.0.0.1:19432/root/" });

    expect(client.getEventsUrl()).toBe("http://127.0.0.1:19432/daemon/events");
    expect(client.getSessionApiUrl("plan-session_1", "/api/plan")).toBe(
      "http://127.0.0.1:19432/s/plan-session_1/api/plan",
    );
  });

  test("runs debug session actions through the session-scoped API", async () => {
    const fixture = createFixtureFetch({
      "/s/review-session-1/api/feedback": { ok: true },
    });
    const client = createDaemonApiClient({ fetch: fixture.fetch });

    const result = await client.runSessionAction(
      {
        id: "review-session-1",
        mode: "review",
        status: "active",
        url: "http://127.0.0.1/s/review-session-1",
        project: "plannotator",
        label: "Review",
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
      },
      "review-approve",
    );

    expect(result.ok).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].url).toBe("/s/review-session-1/api/feedback");
    expect(fixture.requests[0].init?.method).toBe("POST");
    expect(JSON.parse(String(fixture.requests[0].init?.body))).toMatchObject({
      approved: true,
      feedback: "LGTM",
      annotations: [],
    });
  });

  test("normalizes daemon error responses", async () => {
    const fixture = createFixtureFetch({
      "/s/missing-session/api/session": Response.json(
        createDaemonErrorResponse("session-not-found", "Session not found."),
        { status: 404 },
      ),
    });
    const client = createDaemonApiClient({ fetch: fixture.fetch });

    const result = await client.getSessionBootstrap("missing-session");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("daemon-error");
    expect(!result.ok && result.error.message).toBe("Session not found.");
  });

  test("normalizes malformed JSON", async () => {
    const fixture = createFixtureFetch({
      "/daemon/sessions": new Response("not json", { status: 200 }),
    });
    const client = createDaemonApiClient({ fetch: fixture.fetch });

    const result = await client.listSessions();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid-json");
  });

  test("normalizes network failures", async () => {
    const client = createDaemonApiClient({
      fetch: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    });

    const result = await client.listSessions();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("network-error");
    expect(!result.ok && result.error.message).toContain("connection refused");
  });

  test("rejects malformed success payloads", async () => {
    const fixture = createFixtureFetch({
      "/s/plan-session-1/api/session": { ok: true, session: { id: "plan-session-1" } },
    });
    const client = createDaemonApiClient({ fetch: fixture.fetch });

    const result = await client.getSessionBootstrap("plan-session-1");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalid-payload");
  });
});
