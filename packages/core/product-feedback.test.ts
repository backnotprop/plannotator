/**
 * The agent names a feedback submission carries: names only, deduplicated and
 * capped, absent when there are none; and a Worker older than the field (it
 * refuses unknown fields by name) still gets the feedback, without them. The
 * network is a fake `fetch`; nothing leaves the process.
 */
import { describe, expect, test } from "bun:test";
import {
  FEEDBACK_AGENTS_MAX,
  feedbackAgentNames,
  productFeedbackPayload,
  sendProductFeedback,
  type ProductFeedbackPayload,
} from "./product-feedback";

const META = { version: "0.28.40", os: "macOS", surface: "inbox" as const };

describe("feedbackAgentNames", () => {
  test("keeps short names only: no paths, ids, commas, markup, non-strings or long text", () => {
    expect(
      feedbackAgentNames([
        "Claude Code",
        "/Users/ada/work/secret",
        "~/.codex",
        "a, b",
        "<b>Pi</b>",
        42,
        null,
        { name: "Pi" },
        "",
        "   ",
        "The inbox list is infuriating, always jumping around",
        "Codex",
      ]),
    ).toEqual(["Claude Code", "Codex"]);
  });

  test("deduplicates (case and spacing aside), keeping the first and its order", () => {
    expect(feedbackAgentNames(["Codex", "Claude Code", "codex", "  Claude   Code ", "CODEX", "Pi"])).toEqual(["Codex", "Claude Code", "Pi"]);
  });

  test(`caps the list at ${FEEDBACK_AGENTS_MAX}`, () => {
    const many = Array.from({ length: 20 }, (_, i) => `Agent ${i}`);
    expect(feedbackAgentNames(many)).toEqual(many.slice(0, FEEDBACK_AGENTS_MAX));
  });
});

describe("productFeedbackPayload", () => {
  test("carries the cleaned names, and no agents key at all when there are none", () => {
    const withAgents = productFeedbackPayload({ message: "hi" }, { ...META, agents: ["Codex", "codex", "/tmp/x"] });
    expect(withAgents.agents).toEqual(["Codex"]);
    for (const agents of [undefined, [], ["", "/nope"]]) {
      const payload = productFeedbackPayload({ message: "hi" }, { ...META, agents });
      expect(Object.keys(payload).sort()).toEqual(["message", "os", "surface", "version"]);
    }
  });
});

describe("sendProductFeedback against a Worker that predates agents", () => {
  /** A fake Worker: records each body, refuses `agents` like the strict validation before the field existed. */
  function oldWorker(refusal = "Unknown field: agents") {
    const bodies: Record<string, unknown>[] = [];
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("agents" in body) return Response.json({ error: refusal }, { status: 400 });
      return Response.json({ ok: true }, { status: 201 });
    }) as typeof fetch;
    return { bodies, fake };
  }
  const payload: ProductFeedbackPayload = { message: "The list jumps around", version: "0.28.40", os: "macOS", surface: "inbox", agents: ["Claude Code", "Codex"] };

  test("the feedback goes again without the names, and is sent", async () => {
    const { bodies, fake } = oldWorker();
    expect(await sendProductFeedback(payload, { url: "http://127.0.0.1:9/feedback", fetch: fake })).toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
    const { agents: _agents, ...rest } = payload;
    expect(bodies[1]).toEqual(rest);
  });

  test("any other refusal is the Worker's answer, not retried", async () => {
    const { bodies, fake } = oldWorker("Too many requests. Try again later.");
    const result = await sendProductFeedback(payload, { url: "http://127.0.0.1:9/feedback", fetch: fake });
    expect(result).toMatchObject({ ok: false, unavailable: false, reason: "Too many requests. Try again later." });
    expect(bodies).toHaveLength(1);
  });

  test("a payload without names is sent once", async () => {
    const { bodies, fake } = oldWorker();
    const { agents: _agents, ...without } = payload;
    expect(await sendProductFeedback(without, { url: "http://127.0.0.1:9/feedback", fetch: fake })).toEqual({ ok: true });
    expect(bodies).toHaveLength(1);
  });
});
