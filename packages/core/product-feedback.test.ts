/**
 * The agent names a feedback submission carries: names only, deduplicated and
 * capped, absent when there are none; and a Worker older than the field (it
 * refuses unknown fields by name) still gets the feedback, without them. The
 * network is a fake `fetch`; nothing leaves the process.
 */
import { describe, expect, test } from "bun:test";
import {
  FEEDBACK_AGENTS_MAX,
  FEEDBACK_RESEND_MIN_MS,
  FEEDBACK_UNAVAILABLE,
  feedbackAgentNames,
  productFeedbackPayload,
  sendProductFeedback,
  type ProductFeedbackPayload,
} from "./product-feedback";

const META = { version: "0.28.40", os: "macOS", surface: "inbox" as const };

describe("feedbackAgentNames", () => {
  test("keeps short names only: no paths (absolute, relative or ~), commas, markup, non-strings or long text", () => {
    expect(
      feedbackAgentNames([
        "Claude Code",
        "/Users/ada/work/secret",
        "Users/ada/secret",
        "x/../../etc",
        "src/app",
        "~/.codex",
        "notes.md",
        "a, b",
        "<b>Pi</b>",
        42,
        null,
        { name: "Pi" },
        "",
        "   ",
        "The search box forgets my last query, every single time",
        "Codex",
        "Windsurf / Devin",
      ]),
    ).toEqual(["Claude Code", "Codex", "Windsurf / Devin"]);
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
  const payload: ProductFeedbackPayload = { message: "The search box forgets my last query.", version: "0.28.40", os: "macOS", surface: "inbox", agents: ["Claude Code", "Codex"] };

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

  test("one deadline for both sends: a slow refusal that leaves too little time sends nothing more, and says nothing was saved", async () => {
    const bodies: unknown[] = [];
    const budget = FEEDBACK_RESEND_MIN_MS + 300;
    const slow = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      // The old Worker answers after most of the budget is gone.
      await new Promise((r) => setTimeout(r, 400));
      return Response.json({ error: "Unknown field: agents" }, { status: 400 });
    }) as typeof fetch;
    const started = Date.now();
    const result = await sendProductFeedback(payload, { url: "http://127.0.0.1:9/feedback", fetch: slow, timeoutMs: budget });
    expect(Date.now() - started).toBeLessThan(budget);
    expect(bodies).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, unavailable: true, reason: FEEDBACK_UNAVAILABLE });
  });

  test("the resend gets only the time left, so the whole exchange ends within the one deadline", async () => {
    const budget = FEEDBACK_RESEND_MIN_MS + 600;
    let calls = 0;
    const firstSlowThenHang = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((r) => setTimeout(r, 200));
        return Response.json({ error: "Unknown field: agents" }, { status: 400 });
      }
      // The resend never answers: only its share of the deadline stops it.
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as typeof fetch;
    const started = Date.now();
    const result = await sendProductFeedback(payload, { url: "http://127.0.0.1:9/feedback", fetch: firstSlowThenHang, timeoutMs: budget });
    const took = Date.now() - started;
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: false, unavailable: true });
    // A fresh full timeout for the resend would take 200 + budget.
    expect(took).toBeLessThan(budget + 100);
  });

  test("a payload without names is sent once", async () => {
    const { bodies, fake } = oldWorker();
    const { agents: _agents, ...without } = payload;
    expect(await sendProductFeedback(without, { url: "http://127.0.0.1:9/feedback", fetch: fake })).toEqual({ ok: true });
    expect(bodies).toHaveLength(1);
  });
});
