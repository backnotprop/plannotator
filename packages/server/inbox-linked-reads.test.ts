/**
 * Reads a linked computer's window makes of this Inbox's threads (mark `linked-reads`), called in process: the door's
 * routes (a linked machine reaches them, a phone does not), Viewed held as a `set`, a code span's hover held to the
 * thread's own folders for a linked machine, the file check over the tailnet and through the door, a review's
 * Code review switch said with its snapshot, and search with a Tag filter asking
 * only the machines that take it. No Inbox starts and nothing launches; every file is a fixture under a temp folder.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { INBOX_LINKED_READS_MARK } from "@plannotator/core/inbox-types";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { doorRouteOf } from "./inbox-devices";
import { inboxGuideRoute } from "./inbox-guides";
import { createInboxOpenInRoute, type InboxOpenInLauncher } from "./inbox-open-in";
import { doorWriteKind } from "./inbox-outbox";
import { searchAcrossMachines } from "./inbox-search-machines";

const MSG = "msg_01KAAAAAAAAAAAAAAAAAAAAAAA";

describe("the door", () => {
  const reads: [string, string, string][] = [
    ["GET", `threads/${MSG}/steps`, `/api/inbox/threads/${MSG}/steps`],
    ["GET", `messages/${MSG}/guide/file`, `/api/inbox/messages/${MSG}/guide/file`],
    ["GET", `messages/${MSG}/guide/review-image`, `/api/inbox/messages/${MSG}/guide/review-image`],
    ["GET", `messages/${MSG}/guide/review-markdown-image`, `/api/inbox/messages/${MSG}/guide/review-markdown-image`],
    ["GET", `messages/${MSG}/guide/package-changes`, `/api/inbox/messages/${MSG}/guide/package-changes`],
    ["POST", `messages/${MSG}/guide/viewed`, `/api/inbox/messages/${MSG}/guide/viewed`],
    ["GET", "open-in/file/code", "/api/inbox/open-in/file/code"],
    ["GET", "open-in/file", "/api/inbox/open-in/file"],
  ];

  test("a linked machine reaches each read; a phone gets the unknown route, as before", () => {
    for (const [method, route, window] of reads) {
      expect(doorRouteOf(method, route, true)?.windowPath).toBe(window);
      expect(doorRouteOf(method, route, false)).toBeNull();
    }
  });

  test("launching an app stays off the door, for a linked machine too", () => {
    expect(doorRouteOf("POST", "open-in/file", true)).toBeNull();
    expect(doorRouteOf("POST", "open-in", true)).toBeNull();
    expect(doorRouteOf("GET", "open-in/apps", true)).toBeNull();
  });

  test("Viewed goes through the outbox as a set, so it is held while that machine is away", () => {
    expect(doorWriteKind(`messages/${MSG}/guide/viewed`)).toBe("set");
  });
});

const launcher: InboxOpenInLauncher = {
  platform: "darwin",
  apps: () => [],
  reveal: async () => ({ ok: false }),
  openWithApp: async () => ({ ok: false }),
  openWithSystemDefault: async () => ({ ok: false }),
} as unknown as InboxOpenInLauncher;

/** A thread whose project holds docs/plan.md, a clone of another repository beside it, and a PR that would answer anything. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-linked-reads-")));
  const project = join(root, "project");
  const clone = join(root, "clone");
  const home = join(root, "home");
  for (const dir of [join(project, "docs"), join(clone, "src"), home]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, "docs", "plan.md"), "# Plan\n");
  writeFileSync(join(project, "docs", "deploy.pem"), "-----BEGIN PRIVATE KEY-----\n");
  writeFileSync(join(clone, "src", "secret-plan.ts"), "export const other = 1;\n");
  const store = InboxStore.open(join(root, "data"));
  const prj = store.ensureProject({ name: "project", root: project });
  const { message } = store.sendMessage({ project_id: prj.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" }, body: "See docs/plan.md." });
  const doors = new WeakMap<Request, { window: boolean }>();
  const pullsAsked: string[] = [];
  const route = createInboxOpenInRoute({
    store,
    serverSession: "s",
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    localOnly: () => Response.json({ code: "local_only" }, { status: 403 }),
    launcher,
    codeReviewOn: () => true,
    repoRoots: () => [clone],
    threadPulls: () => [],
    pullFile: async (pull) => {
      pullsAsked.push(pull);
      return { contents: "from the PR", label: "#1", platform: "github", url: "https://example.invalid" } as never;
    },
    home,
    doorOf: (req) => doors.get(req) ?? null,
  });
  const ask = async (path: string, params: Record<string, string>, from: "window" | "machine" | "machine-bare" = "window", via: "local" | "tailnet" = "local", method = "GET") => {
    const req = new Request(`http://127.0.0.1${path}?${new URLSearchParams(params)}`, { method, ...(method === "POST" ? { body: JSON.stringify({ ...params, app_id: "vscode" }), headers: { "Content-Type": "application/json" } } : {}) });
    if (from !== "window") doors.set(req, { window: from === "machine" });
    const res = (await route(req, path, via))!;
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { ask, thread: message.thread_id, message: message.id, pullsAsked };
}

describe("a code span's hover text", () => {
  test("this computer's window reads a repository's clone and a PR it names, as before", async () => {
    const w = world();
    expect((await w.ask("/api/inbox/open-in/file/code", { repo: "github.com/o/r", path: "src/secret-plan.ts" })).body).toMatchObject({ found: true, contents: "export const other = 1;\n" });
    expect((await w.ask("/api/inbox/open-in/file/code", { repo: "github.com/o/r", pull: "pr-9", path: "src/x.ts" })).body).toMatchObject({ found: true, contents: "from the PR" });
  });

  test("a linked machine reads its thread's own files, never another clone or a PR it names, and only from a window there", async () => {
    const w = world();
    expect((await w.ask("/api/inbox/open-in/file/code", { thread: w.thread, message: w.message, path: "docs/plan.md" }, "machine")).body).toEqual({ found: true, contents: "# Plan\n" });
    // Every clone of a repository, and a PR it names, are past its thread: as if missing.
    expect((await w.ask("/api/inbox/open-in/file/code", { repo: "github.com/o/r", path: "src/secret-plan.ts" }, "machine")).body).toEqual({ found: false });
    expect((await w.ask("/api/inbox/open-in/file/code", { repo: "github.com/o/r", pull: "pr-9", path: "src/x.ts" }, "machine")).body).toEqual({ found: false });
    expect(w.pullsAsked).toEqual([]);
    // Out of the thread's folders by path: as if missing.
    expect((await w.ask("/api/inbox/open-in/file/code", { thread: w.thread, message: w.message, path: "../clone/src/secret-plan.ts" }, "machine")).body).toEqual({ found: false });
    // A bare call there (no window's mark) is refused, as a file view is.
    expect((await w.ask("/api/inbox/open-in/file/code", { thread: w.thread, path: "docs/plan.md" }, "machine-bare")).status).toBe(403);
  });
});

describe("the file check over the tailnet", () => {
  test("is answered (a window's Copy path there), while launching stays this computer's", async () => {
    const w = world();
    const checked = await w.ask("/api/inbox/open-in/file", { thread: w.thread, message: w.message, path: "docs/plan.md" }, "window", "tailnet");
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ found: true, kind: "markdown" });
    expect(String(checked.body.path)).toEndWith(join("project", "docs", "plan.md"));
    expect((await w.ask("/api/inbox/open-in/file", { thread: w.thread, path: "docs/plan.md" }, "window", "tailnet", "POST")).body).toEqual({ code: "local_only" });
    expect((await w.ask("/api/inbox/open-in/apps", {}, "window", "tailnet")).body).toEqual({ code: "local_only" });
  });

  test("a linked machine's window gets its thread's file and the path here (its Copy path), never another clone", async () => {
    const w = world();
    const checked = await w.ask("/api/inbox/open-in/file", { thread: w.thread, message: w.message, path: "docs/plan.md" }, "machine", "tailnet");
    expect(checked.body).toMatchObject({ found: true, kind: "markdown" });
    expect(String(checked.body.path)).toEndWith(join("project", "docs", "plan.md"));
    // Every clone of a repository is past its thread: as if missing (this computer's window still finds it).
    expect((await w.ask("/api/inbox/open-in/file", { repo: "github.com/o/r", path: "src/secret-plan.ts" }, "machine", "tailnet")).body).toEqual({ found: false });
    expect((await w.ask("/api/inbox/open-in/file", { repo: "github.com/o/r", path: "src/secret-plan.ts" })).body).toMatchObject({ found: true });
    // A bare call there (no window's mark) is refused, as the hover's text is.
    expect((await w.ask("/api/inbox/open-in/file", { thread: w.thread, path: "docs/plan.md" }, "machine-bare", "tailnet")).status).toBe(403);
  });

  test("a linked machine's window is never told a secret of its thread's folder is there", async () => {
    const w = world();
    expect((await w.ask("/api/inbox/open-in/file", { thread: w.thread, message: w.message, path: "docs/deploy.pem" }, "machine")).body).toEqual({ found: false });
    // This computer's own window still opens it in an app, as before.
    expect((await w.ask("/api/inbox/open-in/file", { thread: w.thread, message: w.message, path: "docs/deploy.pem" })).body).toMatchObject({ found: true });
  });
});

describe("a guided review's Code review switch", () => {
  test("the snapshot's answer says this Inbox's switch, which is what takes or refuses a Viewed tick", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-linked-guide-")));
    const store = InboxStore.open(join(root, "data"));
    const prj = store.ensureProject({ name: "project", root });
    const sha256 = "a".repeat(64);
    const blob = inboxBlobPath(store.dir, sha256);
    mkdirSync(dirname(blob), { recursive: true });
    writeFileSync(blob, "{}");
    const guide = { sha256, input_sha256: "b".repeat(64), bytes: 2, title: "Retries", sections: 1, files: 1, additions: 1, deletions: 0, review: true as const };
    const { message } = store.sendMessage({ project_id: prj.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" }, body: "Please review.", guide });
    for (const on of [true, false]) {
      const read = await inboxGuideRoute(new Request(`http://127.0.0.1/api/inbox/messages/${message.id}/guide`), `/api/inbox/messages/${message.id}/guide`, store, "s", () => on);
      expect(((await read!.json()) as { code_review?: unknown }).code_review).toBe(on);
      const viewedPath = `/api/inbox/messages/${message.id}/guide/viewed`;
      const tick = await inboxGuideRoute(new Request(`http://127.0.0.1${viewedPath}`, { method: "POST", body: JSON.stringify({ viewed: [] }) }), viewedPath, store, "s", () => on);
      expect(tick!.status).toBe(on ? 200 : 409);
    }
  });
});

describe("search with a Tag filter", () => {
  const row = (id: string, score: number) => ({ type: "thread", id, thread_id: id, project: { id: "prj_01KAAAAAAAAAAAAAAAAAAAAAAA", name: "p" }, title: id, title_marks: [], thread_name: null, section: "needs_you", archived: false, at: "2026-11-20T10:00:00.000Z", score });
  const answer = (rows: unknown[]) => ({ serverSession: "s", q: "notes", terms: ["notes"], took_ms: 1, indexing: false, threads: rows.length, totals: { threads: rows.length, messages: 0, files: 0, projects: 0, comments: 0 }, groups: { threads: rows }, recent: null });
  const NEW = "ibx_01KNNNNNNNNNNNNNNNNNNNNNNN";
  const OLD = "ibx_01KDDDDDDDDDDDDDDDDDDDDDDD";

  async function search(query: string) {
    const asked: { machine: string; tags: string[] }[] = [];
    const url = new URL(`http://127.0.0.1/api/inbox/search?${query}&machines=1`);
    const result = await searchAcrossMachines({
      req: new Request(url),
      url,
      serverSession: "s",
      waitMs: 1_000,
      hasProject: () => true,
      answerOf: async () => answer([row("thr_here", 2)]) as never,
      machines: {
        linked: () => [
          { id: NEW, name: "MacBook", online: true, marks: ["tags", INBOX_LINKED_READS_MARK] },
          { id: OLD, name: "Mini", online: true, marks: ["tags"] },
        ],
        projectOwner: () => null,
        forward: async (req) => {
          const target = new URL(req.url);
          const machine = target.pathname.split("/")[4]!;
          asked.push({ machine, tags: target.searchParams.getAll("tag") });
          return Response.json(answer([row(`thr_${machine === NEW ? "new" : "old"}`, 1)]));
        },
      },
    });
    return { asked, ids: (result.groups?.threads ?? []).map((one) => one.id), unanswered: result.unanswered };
  }

  test("asks each machine that takes it, with every machine's id of the tag, and merges their rows", async () => {
    const tagged = await search("q=notes&tag=ini_01KAAAAAAAAAAAAAAAAAAAAAAA&tag=ini_01KBBBBBBBBBBBBBBBBBBBBBBB");
    expect(tagged.asked).toEqual([{ machine: NEW, tags: ["ini_01KAAAAAAAAAAAAAAAAAAAAAAA", "ini_01KBBBBBBBBBBBBBBBBBBBBBBB"] }]);
    expect(tagged.ids).toEqual(["thr_here", "thr_new"]);
    // An older machine is not asked and not named as unanswered: it is as before.
    expect(tagged.unanswered).toBeUndefined();
  });

  test("without a Tag filter every machine is asked, as before", async () => {
    const plain = await search("q=notes");
    expect(plain.asked.map((one) => one.machine).sort()).toEqual([NEW, OLD].sort());
    expect(plain.ids.sort()).toEqual(["thr_here", "thr_new", "thr_old"].sort());
  });
});
