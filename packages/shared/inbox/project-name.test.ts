/**
 * The name the Inbox shows for a project is its folder's real name (the
 * stress test of 2026-10-12, rows 1 to 5 and 75). Before, it was the
 * history-folder slug (a-z, 0-9 and hyphens, cut at 30): a Japanese repo read
 * "project", Vietnamese lost its letters, two "api" folders read the same, and
 * a long name ended in a stray hyphen. The slug stays the folder key, and
 * nothing on disk is rewritten.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeTag } from "@plannotator/core/project";
import { inboxProjectLabels } from "./project-name";
import { InboxStore, inboxProjectKey } from "./store";

const p = (id: string, root: string, name = sanitizeTag(root.split("/").pop() ?? "") ?? "project") => ({ id, root, name });

describe("inboxProjectLabels", () => {
  test("the folder's own name, whatever its script, at its full length", () => {
    const long = "northwind-industries-holdings-platform-billing-service";
    const labels = inboxProjectLabels([
      p("a", "/home/me/src/請求サービス"),
      p("b", "/home/me/src/خدمة-الفواتير"),
      p("c", "/home/me/src/dịch-vụ-thanh-toán"),
      p("d", "/home/me/src/платёжный-сервис"),
      p("e", `/home/me/src/${long}`),
    ]);
    expect(labels.get("a")).toBe("請求サービス");
    expect(labels.get("b")).toBe("خدمة-الفواتير");
    expect(labels.get("c")).toBe("dịch-vụ-thanh-toán");
    expect(labels.get("d")).toBe("платёжный-сервис");
    expect(labels.get("e")).toBe(long);
    // What the slug made of them, for the record: what the window showed before.
    expect(sanitizeTag("請求サービス")).toBeNull();
    expect(sanitizeTag(long)).toBe("northwind-industries-holdings");
  });

  test("two folders with one name each name their parent folder", () => {
    const labels = inboxProjectLabels([p("w", "/Users/me/work/api"), p("h", "/Users/me/personal/api"), p("x", "/Users/me/src/docs")]);
    expect(labels.get("w")).toBe("api · work");
    expect(labels.get("h")).toBe("api · personal");
    expect(labels.get("x")).toBe("docs");
  });

  test("as many parents as it takes when the parents match too, and names that differ only in case count as one", () => {
    const labels = inboxProjectLabels([p("a", "/a/client/api"), p("b", "/b/client/api"), p("c", "/c/Api")]);
    expect(labels.get("a")).toBe("api · a/client");
    expect(labels.get("b")).toBe("api · b/client");
    expect(labels.get("c")).toBe("Api · c");
  });

  test("a filesystem root keeps the stored name; Windows separators split too", () => {
    const labels = inboxProjectLabels([p("r", "/", "project"), p("w", "C:\\Users\\me\\repos\\ledger")]);
    expect(labels.get("r")).toBe("project");
    expect(labels.get("w")).toBe("ledger");
  });
});

describe("the store reads the real name, without rewriting the project", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test("rows, threads, the project list and Storage name the folder; the key is the slug's", () => {
    dir = mkdtempSync(join(tmpdir(), "inbox-project-name-"));
    const store = InboxStore.open(dir);
    const root = "/Users/me/src/請求サービス";
    const project = store.ensureProject({ name: "project", root });
    expect(project.name).toBe("請求サービス");
    expect(project.key).toBe(inboxProjectKey("project", root));
    const sent = store.sendMessage({ project_id: project.id, body: "Ready for review.", author: { kind: "agent", host: "claude-code", session: "ses_1", name: "Claude Code" } });
    expect(store.listRows()[0]!.project.name).toBe("請求サービス");
    expect(store.thread(sent.message.thread_id)!.project.name).toBe("請求サービス");
    expect(store.listProjects()[0]!.name).toBe("請求サービス");
    expect(store.diskUsage().projects[0]!.name).toBe("請求サービス");
    // A second "api" relabels the first on the next read; a fresh read of the store does the same.
    const work = store.ensureProject({ name: "api", root: "/Users/me/work/api" });
    expect(work.name).toBe("api");
    store.ensureProject({ name: "api", root: "/Users/me/personal/api" });
    expect(store.project(work.id)!.name).toBe("api · work");
    const again = InboxStore.open(dir);
    expect(again.project(work.id)!.name).toBe("api · work");
    expect(again.project(project.id)!.name).toBe("請求サービス");
  });
});
