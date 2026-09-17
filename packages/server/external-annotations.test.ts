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
});

describe("POST /api/external-annotations: diagram anchors", () => {
  test("accepts a valid diagramAnchor on a plan comment and refuses a malformed one", async () => {
    const handler = createExternalAnnotationHandler("plan");
    const post = async (body: unknown) => {
      const url = "http://localhost/api/external-annotations";
      const res = await handler.handle(
        new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        new URL(url),
      );
      return { status: res?.status, body: (await res!.json()) as { ids?: string[]; error?: string } };
    };
    const anchor = { v: 1, family: "flowchart", kind: "node", id: "D", label: "Approve?", sourceLine: [7, 7] };
    const ok = await post({ source: "review-bot", type: "COMMENT", text: "rename", originalText: "Approve?", diagramAnchor: anchor });
    expect(ok.status).toBe(201);
    const snapshotUrl = "http://localhost/api/external-annotations";
    const snapshot = (await (await handler.handle(new Request(snapshotUrl), new URL(snapshotUrl)))!.json()) as {
      annotations: Array<{ id: string; diagramAnchor?: unknown }>;
    };
    expect(snapshot.annotations.find((a) => a.id === ok.body.ids?.[0])?.diagramAnchor).toEqual(anchor);

    const bad = await post({ source: "review-bot", type: "COMMENT", text: "rename", originalText: "Approve?", diagramAnchor: { kind: "node", id: "D" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("diagramAnchor");
  });
});

describe("PATCH /api/external-annotations", () => {
  test("cannot clear or change the source marker (skill-injection guard, reproduced end-to-end)", async () => {
    const handler = createExternalAnnotationHandler("review");
    const added = handler.addAnnotations({
      source: "rogue-agent",
      scope: "general",
      text: "apply $some-human-only-skill",
    });
    if ("error" in added) throw new Error(added.error);
    const [id] = added.ids;

    const patch = async (body: unknown) => {
      const url = `http://localhost/api/external-annotations?id=${encodeURIComponent(id)}`;
      const res = await handler.handle(
        new Request(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        new URL(url),
      );
      expect(res?.status).toBe(200);
      return (await res!.json()) as { annotation: { source?: string; text?: string } };
    };

    // The reproduced bypass: PATCH {"source": ""} cleared the field and
    // re-armed verbatim SKILL.md injection for a tool-submitted comment.
    const cleared = await patch({ source: "" });
    expect(cleared.annotation.source).toBe("rogue-agent");

    const swapped = await patch({ source: "innocent" });
    expect(swapped.annotation.source).toBe("rogue-agent");

    const nulled = await patch({ source: null });
    expect(nulled.annotation.source).toBe("rogue-agent");

    // Legitimate field patches still work, with source intact.
    const edited = await patch({ text: "edited text" });
    expect(edited.annotation.text).toBe("edited text");
    expect(edited.annotation.source).toBe("rogue-agent");
  });

  // PATCH merges arbitrary fields, so it was the one way to create an
  // inReplyTo self-reference or cycle (which the export used to drop while
  // still counting). The invalid state is refused at ingest.
  test("refuses an inReplyTo that is self, missing, or would close a cycle; accepts a valid reply", async () => {
    const handler = createExternalAnnotationHandler("plan");
    const added = handler.addAnnotations({
      annotations: [
        { source: "tool", text: "first" },
        { source: "tool", text: "second" },
      ],
    });
    if ("error" in added) throw new Error(added.error);
    const [first, second] = added.ids;

    const patch = async (id: string, body: unknown) => {
      const url = `http://localhost/api/external-annotations?id=${encodeURIComponent(id)}`;
      const res = await handler.handle(
        new Request(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        new URL(url),
      );
      return { status: res!.status, body: (await res!.json()) as { error?: string; annotation?: { inReplyTo?: string } } };
    };

    expect((await patch(first, { inReplyTo: first })).status).toBe(400);
    expect((await patch(first, { inReplyTo: "nope" })).status).toBe(400);
    expect((await patch(first, { inReplyTo: 7 })).status).toBe(400);

    const ok = await patch(second, { inReplyTo: first });
    expect(ok.status).toBe(200);
    expect(ok.body.annotation?.inReplyTo).toBe(first);

    // second -> first is in place; first -> second would close the loop.
    const cycle = await patch(first, { inReplyTo: second });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error).toContain("cycle");

    // Clearing stays allowed, and an unrelated patch does not touch the field.
    expect((await patch(second, { inReplyTo: null })).status).toBe(200);
    expect((await patch(second, { text: "still fine" })).status).toBe(200);
  });
});
