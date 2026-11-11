/**
 * Who may start a review from a Send: the factory alone, on a temp store, with no Inbox server around it.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxCompose } from "./inbox-compose";

const send = async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "inbox-compose-review-")));
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "web", root: join(dir, "web") });
  const started: unknown[] = [];
  const { route } = createInboxCompose({
    store,
    serverSession: "s",
    live: { composeTarget: () => ({ host: "claude-code", session: "ses", root: project.root }), allLive: () => [] } as never,
    resolveProject: async () => project,
    readBody: (req) => req.json() as Promise<Record<string, unknown>>,
    json: (body, status = 200) => Response.json(body, { status }),
    onReviewStart: (...args) => started.push(args),
  });
  const url = new URL("http://localhost/api/inbox/messages");
  const res = await route(
    new Request(url, { method: "POST", body: JSON.stringify({ to: { host: "claude-code", session: "ses" }, body: "Please review.", idempotency_key: "00000000-0000-4000-8000-000000000021", review: { kind: "link", url: "https://github.com/o/app/pull/8", title: "T", ask: "guide" } }) }),
    url,
    false,
  );
  return { status: res!.status, started };
};

test("the person's own Send starts its review", async () => {
  const own = await send();
  expect(own.status).toBe(200);
  expect(own.started.length).toBe(1);
});
