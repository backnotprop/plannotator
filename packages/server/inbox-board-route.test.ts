/**
 * What the Board page (approval "inbox-board", step 2) reads from
 * `GET /api/inbox/cards` beside the cards: each linked thread's list row
 * (`threads`, its subject and section, so the open card names its threads)
 * and each card's project (`projects`, its folder name). A real Inbox in a
 * temp data dir. Guards: a card whose thread was deleted naming a thread that
 * is gone, and a card pointing at a project the page cannot name.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("the cards answer names each linked thread (its list row) and each card's project; a deleted thread is left out", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-board-route-")));
  roots.push(root);
  const folder = join(root, "billing-app");
  mkdirSync(folder, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), phones: false });
  servers.push(server);
  const store = server.store;
  const project = store.ensureProject({ name: "billing-app", root: folder });
  const agent = { kind: "agent" as const, host: "claude-code", session: "ses_a", name: "Claude Code" };
  const kept = store.sendMessage({ project_id: project.id, author: agent, body: "The retry worker is ready for your look." }).message;
  const gone = store.sendMessage({ project_id: project.id, author: { ...agent, session: "ses_b" }, body: "An older thread." }).message;
  const card = store.createCard({ project_id: project.id, by: agent, title: "Retry worker", threads: [kept.id, gone.id] }).card;
  store.deleteThread(gone.id);

  const base = `http://127.0.0.1:${server.port}`;
  const answer = (await (await fetch(`${base}/api/inbox/cards`)).json()) as {
    cards: { id: string; threads: string[] }[];
    threads: Record<string, { subject: string | null; section: string; thread_id: string }>;
    projects: Record<string, { name: string; root: string }>;
  };
  expect(answer.cards.find((c) => c.id === card.id)!.threads).toEqual([kept.id]);
  expect(Object.keys(answer.threads)).toEqual([kept.id]);
  expect(answer.threads[kept.id]).toMatchObject({ thread_id: kept.id, subject: "The retry worker is ready for your look.", section: "new" });
  expect(answer.projects[project.id]).toEqual({ id: project.id, name: "billing-app", root: folder });
});

test("dropped/seen marks only the drops the window names: an agent's drop it never showed stays unseen", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-board-seen-")));
  roots.push(root);
  const folder = join(root, "app");
  mkdirSync(folder, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), phones: false });
  servers.push(server);
  const store = server.store;
  const project = store.ensureProject({ name: "app", root: folder });
  const agent = { kind: "agent" as const, host: "codex", session: "ses_c", name: "Codex" };
  const shown = store.createCard({ project_id: project.id, by: agent, title: "Shown" }).card;
  const later = store.createCard({ project_id: project.id, by: agent, title: "Dropped after the page drew" }).card;
  store.updateCard(shown.id, { by: agent, column: "dropped", reason: "Folded into another card" });
  store.updateCard(later.id, { by: agent, column: "dropped", reason: "Not needed" });
  const heardBefore = store.card(shown.id)!.heard_at;

  const base = `http://127.0.0.1:${server.port}`;
  const post = (body: unknown) => fetch(`${base}/api/inbox/cards/dropped/seen`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const answer = await post({ cards: [shown.id] });
  expect(answer.status).toBe(200);
  expect(((await answer.json()) as { cards: { id: string }[] }).cards.map((c) => c.id)).toEqual([shown.id]);
  expect(store.card(shown.id)!.dropped!.seen_at).not.toBeNull();
  // Seeing is not hearing: the card's last-heard time stays.
  expect(store.card(shown.id)!.heard_at).toBe(heardBefore);
  expect(store.card(later.id)!.dropped!.seen_at).toBeNull();
  expect(((await (await fetch(`${base}/api/inbox/cards`)).json()) as { dropped_unseen: number }).dropped_unseen).toBe(1);
  // A malformed list is refused, and nothing is marked.
  expect((await post({ cards: ["not-a-card"] })).status).toBe(422);
  expect((await post({ cards: "crd_x" })).status).toBe(422);
  // Required: no list is refused, never "every unseen drop".
  expect((await post({})).status).toBe(422);
  expect(store.card(later.id)!.dropped!.seen_at).toBeNull();
});
