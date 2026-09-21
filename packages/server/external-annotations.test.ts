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

// ---------------------------------------------------------------------------
// PATCH body validation (#1560 follow-up)
// ---------------------------------------------------------------------------

/**
 * PATCH used to merge its body verbatim, so it could store values POST
 * refuses. `{"diagramAnchor": null}` was answered 200 and then took the whole
 * page down when the renderer read `.family` off it. Every field a PATCH can
 * set now runs the validator POST runs.
 */
describe("PATCH /api/external-annotations: body validation", () => {
  const seed = (handler: ReturnType<typeof createExternalAnnotationHandler>, body: unknown) => {
    const added = handler.addAnnotations(body);
    if ("error" in added) throw new Error(added.error);
    return added.ids[0]!;
  };

  const patchWith = (handler: ReturnType<typeof createExternalAnnotationHandler>, id: string) =>
    async (body: unknown) => {
      const url = `http://localhost/api/external-annotations?id=${encodeURIComponent(id)}`;
      const res = await handler.handle(
        new Request(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        new URL(url),
      );
      return {
        status: res!.status,
        body: (await res!.json()) as { error?: string; annotation?: Record<string, unknown> },
      };
    };

  const VALID_ANCHOR = { v: 1, family: "flowchart", kind: "node", id: "D", label: "Approve?", sourceLine: [7, 7] };

  test("refuses every malformed diagramAnchor and never stores one", async () => {
    const handler = createExternalAnnotationHandler("plan");
    const id = seed(handler, {
      source: "linter",
      type: "COMMENT",
      text: "external finding",
      originalText: "Approve?",
      diagramAnchor: VALID_ANCHOR,
    });
    const patch = patchWith(handler, id);

    // The reported crash vector first: `null` answered 200 and blanked the page.
    const nulled = await patch({ diagramAnchor: null });
    expect(nulled.status).toBe(400);
    expect(nulled.body.error).toContain("diagramAnchor");

    for (const bad of [
      "nope",
      7,
      {},
      [],
      { ...VALID_ANCHOR, v: 2 },
      { ...VALID_ANCHOR, family: "not-a-family" },
      { ...VALID_ANCHOR, kind: "node", id: undefined, from: undefined, to: undefined },
    ]) {
      const res = await patch({ diagramAnchor: bad });
      expect(res.status).toBe(400);
    }

    // The stored anchor is untouched by every refused patch.
    const url = "http://localhost/api/external-annotations";
    const snapshot = (await (await handler.handle(new Request(url), new URL(url)))!.json()) as {
      annotations: Array<{ id: string; diagramAnchor?: unknown }>;
    };
    expect(snapshot.annotations.find((a) => a.id === id)?.diagramAnchor).toEqual(VALID_ANCHOR);
  });

  test("accepts a valid diagramAnchor and normalizes it through the parser", async () => {
    const handler = createExternalAnnotationHandler("plan");
    const id = seed(handler, { source: "linter", text: "note" });
    const patch = patchWith(handler, id);

    const ok = await patch({ diagramAnchor: { ...VALID_ANCHOR, label: "x".repeat(600), stowaway: "dropped" } });
    expect(ok.status).toBe(200);
    const stored = ok.body.annotation?.diagramAnchor as Record<string, unknown>;
    // Parser caps (400) and drops unknown keys — the same normalization POST applies.
    expect((stored.label as string).length).toBe(400);
    expect(stored).not.toHaveProperty("stowaway");

    // An out-of-range source line drops to null while the target survives.
    const negative = await patch({ diagramAnchor: { ...VALID_ANCHOR, sourceLine: [-3, -3] } });
    expect(negative.status).toBe(200);
    expect((negative.body.annotation?.diagramAnchor as { sourceLine: unknown }).sourceLine).toBeNull();
  });

  test("validates the other structured fields and the scalars", async () => {
    const handler = createExternalAnnotationHandler("plan");
    const id = seed(handler, { source: "linter", text: "note" });
    const patch = patchWith(handler, id);

    expect((await patch({ htmlAnchor: null })).status).toBe(400);
    expect((await patch({ htmlAnchor: { tagName: "div" } })).status).toBe(400);
    expect((await patch({ htmlAnchor: { selector: "#a", tagName: "div" } })).status).toBe(200);

    expect((await patch({ elementContext: { id: "no-tag" } })).status).toBe(400);
    expect((await patch({ elementContext: { tag: "BUTTON" } })).status).toBe(200);

    expect((await patch({ images: "nope" })).status).toBe(400);
    expect((await patch({ images: [{ name: "a" }] })).status).toBe(400);
    expect((await patch({ images: [{ path: "/tmp/a.png", name: "a" }] })).status).toBe(200);

    expect((await patch({ type: "NOT_A_TYPE" })).status).toBe(400);
    expect((await patch({ type: "DELETION" })).status).toBe(200);
    expect((await patch({ text: 7 })).status).toBe(400);
    expect((await patch({ originalText: {} })).status).toBe(400);
    expect((await patch({ pageUrl: "/a".padEnd(4000, "b") })).status).toBe(400);
    expect((await patch({ pageUrl: "/settings?tab=2" })).status).toBe(200);
  });

  test("drops unknown keys instead of storing them, and keeps id immutable", async () => {
    const handler = createExternalAnnotationHandler("plan");
    const id = seed(handler, { source: "linter", text: "note" });
    const patch = patchWith(handler, id);

    const res = await patch({ text: "edited", notAField: { deep: true }, id: "hijacked" });
    expect(res.status).toBe(200);
    expect(res.body.annotation?.text).toBe("edited");
    expect(res.body.annotation?.id).toBe(id);
    expect(res.body.annotation).not.toHaveProperty("notAField");
  });

  test("refuses a non-object body", async () => {
    const handler = createExternalAnnotationHandler("plan");
    const id = seed(handler, { source: "linter", text: "note" });
    const patch = patchWith(handler, id);
    expect((await patch([{ text: "x" }])).status).toBe(400);
    expect((await patch("text")).status).toBe(400);
    expect((await patch(null)).status).toBe(400);
  });

  test("review mode keeps its own field set", async () => {
    const handler = createExternalAnnotationHandler("review");
    const id = seed(handler, { source: "linter", filePath: "a.ts", lineStart: 1, lineEnd: 1, text: "note" });
    const patch = patchWith(handler, id);

    expect((await patch({ severity: "catastrophic" })).status).toBe(400);
    expect((await patch({ severity: "nit" })).status).toBe(200);
    expect((await patch({ decorations: ["blocking"] })).status).toBe(200);
    expect((await patch({ decorations: ["explode"] })).status).toBe(400);
    expect((await patch({ suggestedCode: "const a = 1;" })).status).toBe(200);
    expect((await patch({ lineStart: "3" })).status).toBe(400);
    // A plan-only field is not a review field: dropped, not stored.
    const dropped = await patch({ diagramAnchor: VALID_ANCHOR });
    expect(dropped.status).toBe(200);
    expect(dropped.body.annotation).not.toHaveProperty("diagramAnchor");
  });
});
