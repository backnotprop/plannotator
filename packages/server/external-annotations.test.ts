import { describe, expect, test, mock } from "bun:test";
import { createExternalAnnotationHandler } from "./external-annotations";

describe("external annotations SSE", () => {
  test("disables idle timeout for stream requests", async () => {
    const handler = createExternalAnnotationHandler("plan");
    const disableIdleTimeout = mock(() => {});

    const res = await handler.handle(
      new Request("http://localhost/api/external-annotations/stream"),
      new URL("http://localhost/api/external-annotations/stream"),
      { disableIdleTimeout },
    );

    expect(disableIdleTimeout).toHaveBeenCalledTimes(1);
    expect(res?.headers.get("content-type")).toBe("text/event-stream");
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
