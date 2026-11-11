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

test("sort=newest orders by the latest message; no sort is best match; another value is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-search-sort-"));
  roots.push(dir);
  let clock = Date.parse("2026-10-01T10:00:00Z");
  const store = InboxStore.open(dir, { now: () => new Date((clock += 60_000)) });
  const project = store.ensureProject({ name: "api", root: "/w/api" });
  const phrase = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Notes", thread: "a", body: "The rate limit holds." }).message;
  const whole = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Notes", thread: "b", body: "A limit on the rate of retries." }).message;
  const routes = createInboxSearchRoutes({ store, serverSession: "s" });
  disposers.push(() => routes.dispose());
  await routes.index.ensureBuilt();

  const ask = async (query: string) => {
    const url = new URL(`http://127.0.0.1:1${INBOX_SEARCH_PATH}?${query}`);
    const res = await routes.handle(new Request(url), url);
    return (await res!.json()) as { groups: { messages?: { id: string }[] } };
  };
  const ids = (answer: { groups: { messages?: { id: string }[] } }) => (answer.groups.messages ?? []).map((m) => m.id);

  expect(ids(await ask("q=rate+limit"))).toEqual([phrase.id, whole.id]);
  expect(ids(await ask("q=rate+limit&sort=best"))).toEqual([phrase.id, whole.id]);
  expect(ids(await ask("q=rate+limit&sort=newest"))).toEqual([whole.id, phrase.id]);
  await expect(ask("q=rate+limit&sort=oldest")).rejects.toMatchObject({ code: "validation_error" });
});
