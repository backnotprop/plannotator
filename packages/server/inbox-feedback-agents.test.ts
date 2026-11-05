/**
 * The agent names the Inbox's Feedback send adds: read from the hosts of the
 * agent messages in the store, by Plannotator's own names, the most recently
 * used first, deduplicated and capped. Never an agent's own display name, a
 * session, a subject or a count. The route is driven directly (no Inbox is
 * started) with a fake send, so nothing leaves the process.
 */
import { describe, expect, test } from "bun:test";
import { FEEDBACK_AGENTS_MAX, type ProductFeedbackPayload } from "@plannotator/core/product-feedback";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { createInboxFeedback, feedbackAgentNameOfHost, inboxFeedbackAgents, INBOX_FEEDBACK_PATH } from "./inbox-feedback";

const agent = (host: string | null, at: string, extra: { name?: string; session?: string } = {}) => ({
  author: { kind: "agent", host, session: extra.session ?? "ses_0123456789abcdef", name: extra.name ?? null } as InboxAuthor,
  created_at: at,
});
const person = (at: string) => ({ author: { kind: "person" } as InboxAuthor, created_at: at });

describe("inboxFeedbackAgents", () => {
  test("names each host the person used once, by Plannotator's name, the most recent first", () => {
    expect(
      inboxFeedbackAgents([
        agent("claude-code", "2026-11-01T10:00:00.000Z"),
        agent("codex", "2026-11-03T10:00:00.000Z"),
        // `claude` is Claude Code too: one name.
        agent("claude", "2026-11-02T10:00:00.000Z"),
        person("2026-11-04T10:00:00.000Z"),
        agent("pi", "2026-10-01T10:00:00.000Z"),
      ]),
    ).toEqual(["Codex", "Claude Code", "Pi"]);
  });

  test("never sends what an agent called itself, its session, or a host Plannotator does not know", () => {
    const names = inboxFeedbackAgents([
      agent("codex", "2026-11-01T10:00:00.000Z", { name: "Ada's release bot", session: "019a0000-0000-7000-8000-000000000000" }),
      agent("acme-internal-agent", "2026-11-02T10:00:00.000Z", { name: "Acme" }),
      agent("/Users/ada/project", "2026-11-02T10:00:00.000Z"),
      agent(null, "2026-11-02T10:00:00.000Z", { name: "Mystery" }),
    ]);
    expect(names).toEqual(["Codex"]);
  });

  test(`at most ${FEEDBACK_AGENTS_MAX} names, the most recently used kept`, () => {
    const hosts = ["claude-code", "codex", "pi", "opencode", "cursor", "qwen", "dsh", "t3", "gemini", "amp", "kiro"];
    const names = inboxFeedbackAgents(hosts.map((host, i) => agent(host, `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`)));
    expect(names).toHaveLength(FEEDBACK_AGENTS_MAX);
    expect(names[0]).toBe(feedbackAgentNameOfHost("kiro"));
    expect(names).not.toContain("Claude Code");
  });

  test("an empty Inbox has no names", () => {
    expect(inboxFeedbackAgents([])).toEqual([]);
  });
});

describe("the Feedback route adds the names", () => {
  const route = (agents?: () => Iterable<string>) => {
    const sent: ProductFeedbackPayload[] = [];
    const feedback = createInboxFeedback({
      version: "0.28.40",
      json: (body, status = 200) => Response.json(body, { status }),
      url: () => "http://127.0.0.1:9/feedback",
      send: async (payload) => {
        sent.push(payload);
        return { ok: true };
      },
      platform: "darwin",
      ...(agents ? { agents } : {}),
    });
    const post = (body: unknown) =>
      feedback.route(new Request(`http://127.0.0.1${INBOX_FEEDBACK_PATH}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), INBOX_FEEDBACK_PATH);
    return { sent, post };
  };

  test("the names go with the person's words; nothing else is added", async () => {
    const { sent, post } = route(() => ["Claude Code", "Codex"]);
    const res = await post({ message: "The inbox list keeps jumping", serverSession: "s" });
    expect(res!.status).toBe(200);
    expect(sent[0]).toEqual({ message: "The inbox list keeps jumping", version: "0.28.40", os: "macOS", surface: "inbox", agents: ["Claude Code", "Codex"] });
  });

  test("the window cannot choose the names: an agents field from the page is refused", async () => {
    const { sent, post } = route(() => ["Codex"]);
    const res = await post({ message: "hi", agents: ["Something else"] });
    expect(res!.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  test("no names, or a read that fails, still sends the feedback, without an agents key", async () => {
    for (const agents of [undefined, () => [], () => { throw new Error("store gone"); }]) {
      const { sent, post } = route(agents);
      const res = await post({ message: "still sent" });
      expect(res!.status).toBe(200);
      expect(Object.keys(sent[0]!).sort()).toEqual(["message", "os", "surface", "version"]);
    }
  });
});
