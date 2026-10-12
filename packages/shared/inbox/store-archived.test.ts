/**
 * An agent's reply into an archived thread is news again (mail apps' rule):
 * the store derives `agent_after_archive` from the log (the seq of the root
 * line that set the current `resolved_at`, against each agent message's
 * first line), writes nothing for it, and a replay from disk finds the same.
 * The failure this guards: such a reply stayed hidden in Settings' Archived
 * block, where the person does not look for news.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { inboxRowArchived } from "./list";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-archived-store-"))) {
  if (!roots.includes(dir)) roots.push(dir);
  return { store: InboxStore.open(dir), dir };
}

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const QUESTION = "One more call.\n\n:::question\nShip it today?\n\nStopped: the release waits on this.\n\n- [ ] Yes\n- [ ] No\n:::";

describe("an agent message after the archive", () => {
  test("brings the archived thread back as news, stays resolved, and replays the same", () => {
    const { store, dir } = open();
    const project = store.ensureProject({ name: "billing", root: "/work/billing" });
    const root = store.sendMessage({ project_id: project.id, author: AGENT, body: "The nightly build is green." }).message;
    store.markSeen(root.id);
    store.resolveThread(root.id, true);
    // Root-line rewrites while archived (a look) are not a new archive line.
    store.markSeen(root.id);
    let row = store.listRow(root.id)!;
    expect(row).toMatchObject({ agent_after_archive: false, section: "quiet" });
    expect(inboxRowArchived(row)).toBe(true);

    const reply = store.sendMessage({ project_id: project.id, author: AGENT, body: QUESTION, reply_to: root.id }).message;
    expect(reply.thread_id).toBe(root.id);
    row = store.listRow(root.id)!;
    expect(row.resolved_at).not.toBeNull();
    expect(row).toMatchObject({ agent_after_archive: true, section: "stopped", unread: true });
    expect(inboxRowArchived(row)).toBe(false);

    // Derived, so a store read again from disk agrees line for line.
    expect(InboxStore.open(dir).listRow(root.id)).toEqual(row);

    // Archiving again after the reply puts the archive line after it: archived again.
    store.resolveThread(root.id, false);
    store.resolveThread(root.id, true);
    expect(store.listRow(root.id)).toMatchObject({ agent_after_archive: false, section: "quiet" });
    expect(InboxStore.open(dir).listRow(root.id)).toMatchObject({ agent_after_archive: false, section: "quiet" });
  });

  test("with no agent message after the archive line it stays archived", () => {
    const { store } = open();
    const project = store.ensureProject({ name: "billing", root: "/work/billing" });
    const root = store.sendMessage({ project_id: project.id, author: AGENT, body: "A note." }).message;
    store.resolveThread(root.id, true);
    expect(store.listRow(root.id)).toMatchObject({ agent_after_archive: false, section: "quiet" });
    expect(inboxRowArchived(store.listRow(root.id)!)).toBe(true);
  });
});
