import { describe, expect, test, mock } from "bun:test";
import { createExternalAnnotationHandler } from "./external-annotations";

describe("external annotations daemon event publication", () => {
  test("serves the legacy persistent stream route outside daemon-backed sessions", async () => {
    const handler = createExternalAnnotationHandler("plan");
    const disableIdleTimeout = mock(() => {});
    const abort = new AbortController();

    const res = await handler.handle(
      new Request("http://localhost/api/external-annotations/stream", { signal: abort.signal }),
      new URL("http://localhost/api/external-annotations/stream"),
      { disableIdleTimeout },
    );

    expect(disableIdleTimeout).toHaveBeenCalledTimes(1);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("text/event-stream");

    const reader = res!.body!.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain('"type":"snapshot"');
    expect(text).toContain('"annotations":[]');
    await reader.cancel();
    abort.abort();
  });

  test("rejects the old persistent stream route for daemon-backed sessions", async () => {
    const handler = createExternalAnnotationHandler("plan", {
      registerSnapshotProvider: () => () => {},
    });
    const disableIdleTimeout = mock(() => {});

    const res = await handler.handle(
      new Request("http://localhost/api/external-annotations/stream"),
      new URL("http://localhost/api/external-annotations/stream"),
      { disableIdleTimeout },
    );

    expect(disableIdleTimeout).toHaveBeenCalledTimes(0);
    expect(res?.status).toBe(410);
    expect(res?.headers.get("content-type")).not.toContain("text/event-stream");
  });

  test("publishes store mutations through the daemon callback", async () => {
    const events: unknown[] = [];
    const handler = createExternalAnnotationHandler("plan", {
      publishEvent: (event) => events.push(event),
    });

    const res = await handler.handle(
      new Request("http://localhost/api/external-annotations", {
        method: "POST",
        body: JSON.stringify({ source: "lint", text: "Needs work" }),
      }),
      new URL("http://localhost/api/external-annotations"),
    );

    expect(res?.status).toBe(201);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "add" });
  });

  test("registers and unregisters a snapshot provider", () => {
    let provider: (() => unknown) | undefined;
    let unregistered = false;
    const handler = createExternalAnnotationHandler("plan", {
      registerSnapshotProvider: (next) => {
        provider = next;
        return () => {
          unregistered = true;
        };
      },
    });

    expect(provider?.()).toEqual({ type: "snapshot", annotations: [], version: 0 });
    handler.dispose();
    expect(unregistered).toBe(true);
  });

  test("dispose closes active streams", async () => {
    const handler = createExternalAnnotationHandler("plan");
    const res = await handler.handle(
      new Request("http://localhost/api/external-annotations/stream"),
      new URL("http://localhost/api/external-annotations/stream"),
    );

    const reader = res!.body!.getReader();
    await reader.read();
    handler.dispose();
    const next = await reader.read();

    expect(next.done).toBe(true);
  });
});
