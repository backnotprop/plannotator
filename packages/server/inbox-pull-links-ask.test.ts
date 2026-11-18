/**
 * The `thread` ask (a PR page's Start a thread): kept with the PR's owner and read back after a restart, so the PR's
 * row and page keep opening its thread. What regresses: the store dropping an ask it does not know, which makes the
 * PR's page the launchpad again and offers a second thread.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxPullLinks } from "./inbox-pull-links";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("a thread started from a PR's page keeps its `thread` ask across a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "pull-links-ask-"));
  dirs.push(dir);
  const key = "github.com/northwind/web-app#880";
  createInboxPullLinks(dir).set([key], "thr_1", { ask: "thread" });
  expect(createInboxPullLinks(dir).get(key)).toMatchObject({ thread_id: "thr_1", ask: "thread" });
});
