/**
 * The `thread` ask (a PR page's Start a thread) and its `page` mark: kept with the PR's owner and read back after a
 * restart, so the PR's row and page keep opening its thread. What regresses: the store dropping an ask it does not know
 * (the PR's page the launchpad again, a second thread offered); the mark lost when that thread asks for a guided review
 * (the PR's page stops being its thread); or kept when the PR goes to another thread.
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

test("the page mark: set by the `thread` ask, kept when that thread asks for a guided review, dropped for another thread", () => {
  const dir = mkdtempSync(join(tmpdir(), "pull-links-page-"));
  dirs.push(dir);
  const key = "github.com/northwind/web-app#880";
  const links = createInboxPullLinks(dir);
  links.set([key], "thr_1", { ask: "thread" });
  expect(createInboxPullLinks(dir).get(key)).toMatchObject({ ask: "thread", page: true });
  links.set([key], "thr_1", { ask: "guide" });
  expect(createInboxPullLinks(dir).get(key)).toMatchObject({ thread_id: "thr_1", ask: "guide", page: true });
  links.set([key], "thr_2", { ask: "guide" });
  expect(createInboxPullLinks(dir).get(key)?.page).toBeUndefined();
});
