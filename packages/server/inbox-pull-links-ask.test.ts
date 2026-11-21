/**
 * The `thread` ask (a PR page's Start a thread) and its `page` mark: kept with the PR's owner and read back after a
 * restart, so the PR's row and page keep opening its thread. What regresses: the store dropping an ask it does not know
 * (the PR's page the launchpad again, a second thread offered); the mark lost when that thread asks for a guided review
 * (the PR's page stops being its thread); or kept when the PR goes to another thread.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("a guided review and a Picture it on the way together: asking for one never drops the other; another thread drops both", () => {
  const dir = mkdtempSync(join(tmpdir(), "pull-links-picture-it-"));
  dirs.push(dir);
  const key = "github.com/northwind/web-app#880";
  const links = createInboxPullLinks(dir);
  links.set([key], "thr_1", { ask: "thread" });
  links.set([key], "thr_1", { ask: "guide" }, "2026-11-18T10:00:00.000Z");
  links.set([key], "thr_1", { ask: "picture_it" }, "2026-11-18T10:01:00.000Z");
  expect(createInboxPullLinks(dir).get(key)).toMatchObject({ thread_id: "thr_1", ask: "guide", picture_it_at: "2026-11-18T10:01:00.000Z", page: true });
  links.set([key], "thr_1", { ask: "custom" }, "2026-11-18T10:02:00.000Z");
  expect(createInboxPullLinks(dir).get(key)).toMatchObject({ ask: "custom", picture_it_at: "2026-11-18T10:01:00.000Z" });
  links.set([key], "thr_2", { ask: "guide" });
  expect(createInboxPullLinks(dir).get(key)?.picture_it_at).toBeUndefined();
});

test("a link stored with the single `picture_it` ask reads as a Picture it asked at that time, with no other ask", () => {
  const dir = mkdtempSync(join(tmpdir(), "pull-links-picture-it-old-"));
  dirs.push(dir);
  const key = "github.com/northwind/web-app#880";
  mkdirSync(join(dir, "inbox"), { recursive: true });
  writeFileSync(join(dir, "inbox", "pull-links.json"), JSON.stringify({ v: 1, links: { [key]: { thread_id: "thr_1", at: "2026-11-18T09:00:00.000Z", ask: "picture_it" } } }));
  const owner = createInboxPullLinks(dir).get(key);
  expect(owner).toMatchObject({ thread_id: "thr_1", picture_it_at: "2026-11-18T09:00:00.000Z" });
  expect(owner?.ask).toBeUndefined();
});
