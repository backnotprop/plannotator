/**
 * "Recent activity" (approval "inbox-recent-activity-filter"): which reply draft saves are the person's doing in the
 * thread (inbox-reply-drafts.ts `onEdited`, which the server notes in acted.json). On the route itself, over a real
 * store in a temp dir: no Inbox is started.
 *
 * What this catches: a save that changes nothing (the box saving an untouched draft again, an empty box saved with no
 * draft there) counted as an act, which would put a thread the person only looked at in Recent activity; a real change
 * (new words, a recipient, a deletion) not counted.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxReplyDrafts } from "./inbox-reply-drafts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-draft-acts-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const thread = () => store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: null }, body: "The export is ready." }).message.thread_id;
  const changed: string[] = [];
  const edited: string[] = [];
  const drafts = createInboxReplyDrafts({
    store,
    serverSession: "srv_1",
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: (id) => changed.push(id),
    onEdited: (id) => edited.push(id),
  });
  /** The window's save (api.ts `replyDraftSaveBody`), or its Discard (`/delete`). */
  const post = async (id: string, body: Record<string, unknown>, discard = false) => {
    const url = new URL(`http://127.0.0.1/api/inbox/threads/${id}/draft${discard ? "/delete" : ""}`);
    const res = await drafts.route(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), url);
    expect(res?.status).toBe(200);
    return (await res!.json()) as { draft?: { updated_at: string } | null };
  };
  const save = (id: string, words: string, base: string | null, extra: Record<string, unknown> = {}) =>
    post(id, { body: words, base, base_body: null, files_add: [], files_remove: [], files_place: [], ...extra });
  return { thread, post, save, changed, edited };
}

test("a save that changes the draft is an act; the same draft saved again, or an empty box with no draft, is not", async () => {
  const { thread, post, save, changed, edited } = setup();
  const t = thread();
  const first = await save(t, "Looks right, one quest", null);
  expect(edited).toEqual([t]);

  // The box saves the untouched draft again (it opened, or the person only focused it): the windows still hear of
  // the save, but it is no act.
  const again = await save(t, "Looks right, one quest", first.draft!.updated_at);
  expect(again.draft!.updated_at).not.toBe(first.draft!.updated_at);
  expect(changed).toEqual([t, t]);
  expect(edited).toEqual([t]);

  // New words, then a recipient chosen: each is an act.
  const words = await save(t, "Looks right, one question first", again.draft!.updated_at);
  expect(edited).toEqual([t, t]);
  await save(t, "Looks right, one question first", words.draft!.updated_at, { recipients: ["ses_a"] });
  expect(edited).toEqual([t, t, t]);

  // An empty box saved where there is no draft, and a Discard with nothing to discard: nothing the person did.
  const other = thread();
  expect((await save(other, "", null)).draft).toBeNull();
  await post(other, {}, true);
  expect(edited).toEqual([t, t, t]);

  // Discard of the draft there is one.
  await post(t, {}, true);
  expect(edited).toEqual([t, t, t, t]);
});
