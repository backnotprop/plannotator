/**
 * The agent names the Inbox's Feedback send adds: read from the hosts of the
 * agent messages in the store, by Plannotator's own names, the most recently
 * used first, deduplicated and capped. Never an agent's own display name, a
 * session, a subject or a count. The route is driven directly (no Inbox is
 * started) with a fake send, so nothing leaves the process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEEDBACK_AGENTS_MAX, type ProductFeedbackPayload } from "@plannotator/core/product-feedback";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxFeedback, feedbackAgentNameOfHost, inboxFeedbackAgents, inboxStoreFeedbackAgents, INBOX_FEEDBACK_PATH, type InboxFeedbackStore } from "./inbox-feedback";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

  test("a host used again later counts from its latest message, not its first", () => {
    expect(
      inboxFeedbackAgents([
        agent("claude-code", "2026-11-01T10:00:00.000Z"),
        agent("codex", "2026-11-02T10:00:00.000Z"),
        // Claude Code again, after Codex: it leads.
        agent("claude", "2026-11-03T10:00:00.000Z"),
      ]),
    ).toEqual(["Claude Code", "Codex"]);
  });

  test("a message without a time is skipped, never a failure", () => {
    expect(inboxFeedbackAgents([{ author: agent("pi", "").author, created_at: undefined }, agent("codex", "2026-11-02T10:00:00.000Z")])).toEqual(["Codex"]);
  });

  test("an empty Inbox has no names", () => {
    expect(inboxFeedbackAgents([])).toEqual([]);
  });
});

describe("inboxStoreFeedbackAgents over a real store", () => {
  test("reads every thread's messages, replies included", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-feedback-agents-"));
    roots.push(dir);
    let clock = Date.parse("2026-11-01T10:00:00.000Z");
    const store = InboxStore.open(dir, { now: () => new Date((clock += 60_000)) });
    const project = store.ensureProject({ name: "demo", root: join(dir, "demo") });
    const author = (host: string): InboxAuthor => ({ kind: "agent", host, session: `ses_${host.replace(/[^a-z]/g, "")}000000000001`, name: null });
    const root = store.sendMessage({ project_id: project.id, author: author("claude-code"), subject: "First", body: "One", reply_to: null, thread: null }).message;
    store.sendMessage({ project_id: project.id, author: author("pi"), subject: "Second", body: "Two", reply_to: null, thread: null });
    // A reply from another agent in the first thread counts too.
    store.sendMessage({ project_id: project.id, author: author("codex"), subject: null, body: "Three", reply_to: root.id, thread: null });
    expect(inboxStoreFeedbackAgents(store)).toEqual(["Codex", "Pi", "Claude Code"]);
  });
});

describe("the Feedback route adds the names", () => {
  /** A store holding one agent message per name given; `null`: a store whose read fails. */
  const storeOf = (hosts: string[] | null): InboxFeedbackStore =>
    hosts === null
      ? {
          threadIds: () => {
            throw new Error("store gone");
          },
          threadMessageIds: () => [],
          message: () => null,
        }
      : {
          threadIds: () => hosts.map((_, i) => `msg_${i}`),
          threadMessageIds: (id) => [id],
          message: (id) => agent(hosts[Number(id.slice(4))]!, `2026-11-0${Number(id.slice(4)) + 1}T00:00:00.000Z`),
        };
  const route = (hosts: string[] | null = []) => {
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
      store: storeOf(hosts),
    });
    const post = (body: unknown) =>
      feedback.route(new Request(`http://127.0.0.1${INBOX_FEEDBACK_PATH}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), INBOX_FEEDBACK_PATH);
    return { sent, post };
  };

  test("the names go with the person's words; nothing else is added", async () => {
    const { sent, post } = route(["codex", "claude-code"]);
    const res = await post({ message: "The search box forgets my last query.", serverSession: "s" });
    expect(res!.status).toBe(200);
    expect(sent[0]).toEqual({ message: "The search box forgets my last query.", version: "0.28.40", os: "macOS", surface: "inbox", agents: ["Claude Code", "Codex"] });
  });

  test("the window cannot choose the names: an agents field from the page is refused", async () => {
    const { sent, post } = route(["codex"]);
    const res = await post({ message: "hi", agents: ["Something else"] });
    expect(res!.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  test("no names, or a read that fails, still sends the feedback, without an agents key", async () => {
    for (const hosts of [[], ["acme-internal-agent"], null]) {
      const { sent, post } = route(hosts);
      const res = await post({ message: "still sent" });
      expect(res!.status).toBe(200);
      expect(Object.keys(sent[0]!).sort()).toEqual(["message", "os", "surface", "version"]);
    }
  });
});
