/**
 * A skill emoji's reply in the window's search (inbox-search-shown.ts), on the route alone (no Inbox started): the
 * window's row reads "🦃 /bro", as the thread draws it; the index the agents' search reads (inbox-mcp-search.ts,
 * inbox-far-find.ts) keeps the body's own words, and the agent's thread read is the body it was sent.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxSearchRoutes, INBOX_SEARCH_PATH } from "./inbox-search";

const roots: string[] = [];
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CLAUDE: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };

test("the window's search row reads a skill emoji's reply as “🦃 /bro”; the agents' index and read keep the body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-search-shown-"));
  roots.push(dir);
  let clock = Date.parse("2026-11-26T10:00:00Z");
  const store = InboxStore.open(dir, { now: () => new Date((clock += 60_000)) });
  const project = store.ensureProject({ name: "harbor", root: "/w/harbor" });
  const first = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Retry budget", thread: "a", body: "The retry budget is wired." }).message;
  const pressed = store.sendReply(first.id, { idempotency_key: "p1", words: "/bro", skill_reaction: { emoji: "🦃", skill: "bro" } }).reply!;
  const second = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Docs", thread: "b", body: "The docs build is green." }).message;
  const typed = store.sendReply(second.id, { idempotency_key: "t1", words: "/bro" }).reply!;
  const routes = createInboxSearchRoutes({ store, serverSession: "s" });
  disposers.push(() => routes.dispose());
  await routes.index.ensureBuilt();

  const url = new URL(`http://127.0.0.1:1${INBOX_SEARCH_PATH}?q=bro&group=messages`);
  const answer = (await (await routes.handle(new Request(url), url))!.json()) as { groups: { messages: { id: string; snippet: { text: string } }[] } };
  const windowSnippet = (id: string) => answer.groups.messages.find((row) => row.id === id)?.snippet.text;
  expect(windowSnippet(pressed.id)).toBe("🦃 /bro");
  expect(windowSnippet(typed.id)).toBe("/bro");

  const agents = routes.index.search({ q: "bro", group: "messages", offset: 0, limit: 10 });
  const agentSnippet = (id: string) => agents.groups?.messages?.find((row) => row.type === "message" && row.id === id);
  expect(agentSnippet(pressed.id)).toMatchObject({ snippet: { text: "/bro" } });
  expect(store.agentThread(first.id)!.messages.find((m) => m.id === pressed.id)!.body).toBe("/bro");

  // The list's row for the thread: its latest message, the person's, as its words.
  const rows = store.listRows({ projectId: project.id });
  expect(rows.find((row) => row.thread_id === first.thread_id)?.latest_preview).toBe("You: 🦃 /bro");
  expect(rows.find((row) => row.thread_id === second.thread_id)?.latest_preview).toBe("You: /bro");
});
