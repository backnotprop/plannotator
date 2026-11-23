/**
 * Code review's image preview in the Inbox (review parity B2): one side of a
 * changed image, for the PR page (`pullReviewImage`, over `InboxPulls.fileBytes`)
 * and for a guided review (`guideReviewImage`, over the blobs its patch names),
 * both through the shared handler. Real git in a temp folder; a scripted gh. No
 * Inbox is started and no real CLI or forge runs.
 *
 * What regresses:
 *  - a path the patch does not change, or one that leaves the repository, read
 *    at all;
 *  - a side that does not exist (an added file's before, a deleted file's after)
 *    read instead of refused;
 *  - a renamed file's before read at its new path;
 *  - the byte cap not holding;
 *  - a stale snapshot (another head, another message) answered;
 *  - a guide's side served from anything other than the blob its patch names
 *    (a working tree or a PR that moved on), or, for a pure rename that names
 *    none, from anything but the guide's own commit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES } from "@plannotator/core/diff-paths";
import type { FileBytesRead } from "@plannotator/shared/review-core";
import { createInboxPulls, gitBlobId, type InboxPulls } from "./inbox-pulls";
import { guideReviewImage, pullReviewImage } from "./inbox-review-image";
import { guidePatchOf, guideReviewOf } from "./inbox-guides";
import { buildGuideSnapshot } from "@plannotator/core/guide-format";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { RefRunner } from "./ref-cards";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
/** Another picture: the same PNG with bytes after its end (still a PNG to every reader). */
const png = (tag: string) => Buffer.concat([PNG, Buffer.from(tag, "latin1")]);
/** Long and unlike each other, so git never pairs the added and the deleted picture as a rename. */
const GONE = randomBytes(600).toString("latin1");
const NEW = randomBytes(600).toString("latin1");
const RENAMED = `renamed before ${"r".repeat(400)}`;

const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
let scratch = "";
let repo = "";
let patch = "";

function git(...args: string[]): string {
  const run = Bun.spawnSync(["git", "-c", "user.name=Ada Novak", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "inbox-review-image-")));
  process.env.PLANNOTATOR_DATA_DIR = join(scratch, "data");
  repo = join(scratch, "repo");
  mkdirSync(join(repo, "img"), { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "img/modified.png"), png("before"));
  writeFileSync(join(repo, "img/deleted.png"), png(GONE));
  writeFileSync(join(repo, "img/old-name.png"), png(RENAMED));
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  writeFileSync(join(repo, "img/modified.png"), png("after"));
  writeFileSync(join(repo, "img/added.png"), png(NEW));
  unlinkSync(join(repo, "img/deleted.png"));
  renameSync(join(repo, "img/old-name.png"), join(repo, "img/new-name.png"));
  writeFileSync(join(repo, "img/new-name.png"), png(`${RENAMED}, edited`));
  // Past the byte cap: refused as too large, never read whole.
  writeFileSync(join(repo, "img/huge.png"), Buffer.concat([PNG, Buffer.alloc(MAX_REVIEW_IMAGE_PREVIEW_BYTES + 1)]));
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  // The rename has an edit too small to break it: git still pairs the two.
  patch = git("diff", "-M", "--full-index", "HEAD~1", "HEAD");
});

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  rmSync(scratch, { recursive: true, force: true });
});

const ask = (path: string, side: "old" | "new", snapshot: string) => new URLSearchParams({ path, side, snapshot });
const bytesOf = (body: unknown) => Buffer.from(body as Uint8Array);
const reasonOf = (body: unknown) => (JSON.parse(String(body)) as { reason: string }).reason;

describe("a guided review's image", () => {
  const MESSAGE = "msg_1";
  const read = (path: string, side: "old" | "new", options: { snapshot?: string; patch?: string; forge?: Parameters<typeof guideReviewImage>[0]["forge"] } = {}) =>
    guideReviewImage({ patch: options.patch ?? patch, messageId: MESSAGE, root: repo, params: ask(path, side, options.snapshot ?? MESSAGE), ...(options.forge ? { forge: options.forge } : {}) });

  test("a modified image: each side is the blob the patch names", async () => {
    const before = await read("img/modified.png", "old");
    expect(before.status).toBe(200);
    expect(before.headers["Content-Type"]).toBe("image/png");
    expect(bytesOf(before.body).equals(png("before"))).toBe(true);
    const after = await read("img/modified.png", "new");
    expect(bytesOf(after.body).equals(png("after"))).toBe(true);
  });

  test("an added image has no before and a deleted one no after: refused, the other side served", async () => {
    const none = await read("img/added.png", "old");
    expect([none.status, reasonOf(none.body)]).toEqual([404, "absent"]);
    expect(bytesOf((await read("img/added.png", "new")).body).equals(png(NEW))).toBe(true);
    const gone = await read("img/deleted.png", "new");
    expect([gone.status, reasonOf(gone.body)]).toEqual([404, "absent"]);
    expect(bytesOf((await read("img/deleted.png", "old")).body).equals(png(GONE))).toBe(true);
  });

  test("a renamed image: its before is the old name's blob", async () => {
    expect(patch).toContain("rename from img/old-name.png");
    expect(bytesOf((await read("img/new-name.png", "old")).body).equals(png(RENAMED))).toBe(true);
    expect(bytesOf((await read("img/new-name.png", "new")).body).equals(png(`${RENAMED}, edited`))).toBe(true);
  });

  test("past the byte cap: 413, too large", async () => {
    const big = await read("img/huge.png", "new");
    expect([big.status, reasonOf(big.body)]).toEqual([413, "too-large"]);
  });

  test("a path the patch does not change, or one out of the repository, reads nothing", async () => {
    const asked: string[] = [];
    const forge = async (_side: "old" | "new", filePath: string): Promise<FileBytesRead> => {
      asked.push(filePath);
      return { kind: "ok", bytes: png("forge") };
    };
    expect((await read("img/unchanged.png", "new", { forge })).status).toBe(404);
    const outside = "diff --git a/../outside.png b/../outside.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/../outside.png differ\n";
    const refused = await read("../outside.png", "new", { patch: outside, forge });
    expect([refused.status, reasonOf(refused.body)]).toEqual([404, "not-in-diff"]);
    expect(asked).toEqual([]);
  });

  test("another message's snapshot is stale", async () => {
    expect((await read("img/modified.png", "new", { snapshot: "msg_2" })).status).toBe(409);
  });

  test("uncommitted edits: the working tree's file while it is the blob the patch names, and not once it moves on", async () => {
    const id = gitBlobId(png("draft"));
    const draft = `diff --git a/img/modified.png b/img/modified.png\nindex ${gitBlobId(png("after"))}..${id} 100644\nBinary files a/img/modified.png and b/img/modified.png differ\n`;
    writeFileSync(join(repo, "img/modified.png"), png("draft"));
    expect(bytesOf((await read("img/modified.png", "new", { patch: draft })).body).equals(png("draft"))).toBe(true);
    writeFileSync(join(repo, "img/modified.png"), png("later"));
    expect((await read("img/modified.png", "new", { patch: draft })).status).toBe(404);
    writeFileSync(join(repo, "img/modified.png"), png("after"));
  });

  test("a working-tree file past the cap at a path the patch names: missing, its size never told", async () => {
    const id = gitBlobId(png("never stored"));
    const draft = `diff --git a/img/modified.png b/img/modified.png\nindex ${gitBlobId(png("after"))}..${id} 100644\nBinary files a/img/modified.png and b/img/modified.png differ\n`;
    writeFileSync(join(repo, "img/modified.png"), Buffer.concat([PNG, Buffer.alloc(MAX_REVIEW_IMAGE_PREVIEW_BYTES + 1)]));
    try {
      const answer = await read("img/modified.png", "new", { patch: draft });
      expect([answer.status, reasonOf(answer.body)]).toEqual([404, "missing"]);
      expect(String(answer.body)).not.toContain(String(MAX_REVIEW_IMAGE_PREVIEW_BYTES));
    } finally {
      writeFileSync(join(repo, "img/modified.png"), png("after"));
    }
  });

  test("a guide of a PR whose blobs are not here: the forge's side only while it is the patch's blob", async () => {
    const id = gitBlobId(png("far"));
    const far = `diff --git a/img/far.png b/img/far.png\nindex ${gitBlobId(png("near"))}..${id} 100644\nBinary files a/img/far.png and b/img/far.png differ\n`;
    let answer = png("far");
    const forge = async (): Promise<FileBytesRead> => ({ kind: "ok", bytes: answer });
    expect(bytesOf((await read("img/far.png", "new", { patch: far, forge })).body).equals(png("far"))).toBe(true);
    answer = png("pushed since");
    expect((await read("img/far.png", "new", { patch: far, forge })).status).toBe(404);
  });

  test("a pure rename names no blob: both sides are the file at the guide's commit, under either name; nothing without one", async () => {
    const dir = join(scratch, "renames");
    mkdirSync(join(dir, "assets"), { recursive: true });
    const inDir = (...args: string[]) => {
      const run = Bun.spawnSync(["git", "-c", "user.name=Ada Novak", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
      if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
      return run.stdout.toString();
    };
    inDir("init", "-q", "-b", "main");
    writeFileSync(join(dir, "assets/logo.png"), png("logo"));
    inDir("add", "-A");
    inDir("commit", "-q", "-m", "logo");
    inDir("mv", "assets/logo.png", "assets/brand-logo.png");
    inDir("commit", "-q", "-m", "rename");
    const head = inDir("rev-parse", "HEAD").trim();
    const committed = inDir("diff", "-M", "HEAD~1", "HEAD");
    expect(committed).toContain("similarity index 100%");
    expect(committed).not.toMatch(/^index /m);
    const at = (path: string, side: "old" | "new", rename: string, pinned: string | null) =>
      guideReviewImage({ patch: rename, messageId: MESSAGE, root: dir, revision: pinned, params: ask(path, side, MESSAGE) });
    for (const side of ["old", "new"] as const) {
      const answer = await at("assets/brand-logo.png", side, committed, head);
      expect(answer.status).toBe(200);
      expect(bytesOf(answer.body).equals(png("logo"))).toBe(true);
      // No commit recorded, or one that is not a commit id: nothing is read.
      expect([(await at("assets/brand-logo.png", side, committed, null)).status, (await at("assets/brand-logo.png", side, committed, "HEAD")).status]).toEqual([404, 404]);
    }
    // A rename not committed yet: the guide's commit has the old name only, and both sides read it.
    inDir("mv", "assets/brand-logo.png", "assets/mark.png");
    const staged = inDir("diff", "-M", "--cached", "HEAD");
    expect(staged).toContain("similarity index 100%");
    for (const side of ["old", "new"] as const) expect(bytesOf((await at("assets/mark.png", side, staged, head)).body).equals(png("logo"))).toBe(true);
    // A rename that changed the picture, in a patch rebuilt without its `index` line: not taken for a pure one.
    const edited = staged.replace("similarity index 100%", "similarity index 90%");
    expect((await at("assets/mark.png", "new", edited, head)).status).toBe(404);
  });
});

describe("a pull request's image", () => {
  const HEAD = "a".repeat(40);
  const fake = (answerHead: string | null = HEAD) => {
    const reads: { side: string; path: string; oldPath: string | undefined; head: string | undefined }[] = [];
    const pulls: Pick<InboxPulls, "diff" | "fileBytes"> = {
      diff: async () => ({ patch, partial: false, head_sha: answerHead }),
      fileBytes: async (_key, _scope, side, path, oldPath, _roots, _max, _from, head) => {
        reads.push({ side, path, oldPath, head });
        return { kind: "ok", bytes: png(`${side} ${side === "old" ? (oldPath ?? path) : path}`) };
      },
    };
    return { pulls, reads };
  };
  const read = (pulls: Pick<InboxPulls, "diff" | "fileBytes">, path: string, side: "old" | "new", snapshot = HEAD) =>
    pullReviewImage({ pulls, key: "github.com/northwind/billing-svc#412", scope: "layer", params: ask(path, side, snapshot), roots: async () => [] });

  test("each side read at the head on screen; a rename's before at its old name", async () => {
    const { pulls, reads } = fake();
    expect(bytesOf((await read(pulls, "img/new-name.png", "old")).body).equals(png("old img/old-name.png"))).toBe(true);
    expect((await read(pulls, "img/modified.png", "new")).status).toBe(200);
    expect(reads).toEqual([
      { side: "old", path: "img/new-name.png", oldPath: "img/old-name.png", head: HEAD },
      { side: "new", path: "img/modified.png", oldPath: "img/modified.png", head: HEAD },
    ]);
  });

  test("an added image's before and a deleted image's after: refused, nothing read", async () => {
    const { pulls, reads } = fake();
    expect(reasonOf((await read(pulls, "img/added.png", "old")).body)).toBe("absent");
    expect(reasonOf((await read(pulls, "img/deleted.png", "new")).body)).toBe("absent");
    expect(reads).toEqual([]);
  });

  test("another head than the diff's, or none, is stale; a path the diff does not change is not read", async () => {
    const { pulls, reads } = fake();
    expect((await read(pulls, "img/modified.png", "new", "b".repeat(40))).status).toBe(409);
    expect((await read(pulls, "img/modified.png", "new", "inbox:pull:x")).status).toBe(409);
    expect((await read(fake(null).pulls, "img/modified.png", "new")).status).toBe(409);
    expect((await read(pulls, "../img/modified.png", "new")).status).toBe(404);
    expect(reads).toEqual([]);
  });

  test("a bad path or side reads neither the diff nor the forge", async () => {
    let diffs = 0;
    let files = 0;
    const pulls: Pick<InboxPulls, "diff" | "fileBytes"> = {
      diff: async () => {
        diffs += 1;
        return { patch, partial: false, head_sha: HEAD };
      },
      fileBytes: async () => {
        files += 1;
        return { kind: "ok", bytes: png("x") };
      },
    };
    const climbs = await read(pulls, "../../etc/passwd", "new");
    expect([climbs.status, reasonOf(climbs.body)]).toEqual([404, "not-in-diff"]);
    expect((await read(pulls, "/etc/passwd", "new")).status).toBe(404);
    const noSide = await pullReviewImage({ pulls, key: "github.com/northwind/billing-svc#412", scope: "layer", params: new URLSearchParams({ path: "img/modified.png", side: "both", snapshot: HEAD }), roots: async () => [] });
    expect([noSide.status, reasonOf(noSide.body)]).toEqual([400, "bad-request"]);
    expect([diffs, files]).toEqual([0, 0]);
  });

  test("a side past the cap: 413", async () => {
    const { pulls } = fake();
    pulls.fileBytes = async () => ({ kind: "too-large", size: MAX_REVIEW_IMAGE_PREVIEW_BYTES + 1 });
    expect((await read(pulls, "img/huge.png", "new")).status).toBe(413);
  });
});

describe("InboxPulls.fileBytes", () => {
  const HEAD = "a".repeat(40);
  const BASE = "b".repeat(40);
  const KEY = "github.com/northwind/billing-svc#412";
  const pull = {
    number: 412, title: "PR 412", url: "https://github.com/northwind/billing-svc/pull/412", state: "OPEN", isDraft: false,
    updatedAt: "2026-11-03T10:00:00Z", mergedAt: null, baseRefName: "main", headRefName: "pictures", headRefOid: HEAD,
    additions: 0, deletions: 0, changedFiles: 1, reviewDecision: "REVIEW_REQUIRED",
    repository: { nameWithOwner: "northwind/billing-svc" }, headRepository: { nameWithOwner: "northwind/billing-svc" },
    author: { login: "charlie" }, reviewRequests: { nodes: [] }, latestReviews: { nodes: [] }, commits: { nodes: [] },
  };
  async function listed(files: Map<string, Buffer>, local: (root: string, spec: string) => FileBytesRead | null) {
    const asked: string[] = [];
    const run: RefRunner = async (_cli, args) => {
      if (args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "charlie", active: true, state: "success", tokenSource: "keyring" }] } }), stderr: "", exitCode: 0 };
      if (args.includes("graphql")) return { stdout: JSON.stringify({ data: { viewer: { login: "charlie" }, requested: { nodes: [] }, authored: { nodes: [pull] }, merged: { nodes: [] } } }), stderr: "", exitCode: 0 };
      const endpoint = args.find((a) => a.startsWith("repos/")) ?? "";
      asked.push(endpoint);
      if (args.includes(".merge_base_commit.sha")) return { stdout: `${BASE}\n`, stderr: "", exitCode: 0 };
      const bytes = files.get(endpoint);
      if (!bytes) return { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
      return { stdout: JSON.stringify({ type: "file", sha: "c".repeat(40), size: bytes.length, encoding: "base64", content: bytes.toString("base64") }), stderr: "", exitCode: 0 };
    };
    const pulls = createInboxPulls({ run, gitBytes: async (root, spec) => local(root, spec) ?? { kind: "missing" } });
    await pulls.list([{ host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" }]);
    return { pulls, asked };
  }
  const contents = (path: string, sha: string) => `repos/northwind/billing-svc/contents/${encodeURIComponent(path)}?ref=${sha}`;

  test("a clone with the commits answers first; the forge is not asked for the file", async () => {
    const specs: string[] = [];
    const { pulls, asked } = await listed(new Map(), (root, spec) => {
      specs.push(`${root} ${spec}`);
      return root === "/clone-b" ? { kind: "ok", bytes: png(spec) } : null;
    });
    const after = await pulls.fileBytes(KEY, "layer", "new", "img/a.png", undefined, ["/clone-a", "/clone-b"], 1000);
    expect(after.kind === "ok" && Buffer.from(after.bytes).equals(png(`${HEAD}:img/a.png`))).toBe(true);
    expect(specs).toEqual([`/clone-a ${HEAD}:img/a.png`, `/clone-b ${HEAD}:img/a.png`]);
    expect(asked.filter((e) => e.includes("/contents/"))).toEqual([]);
  });

  test("the forge: the after at the head asked for, a rename's before at its old name where the head left its base", async () => {
    const files = new Map([[contents("img/b.png", "d".repeat(40)), png("after")], [contents("img/a.png", BASE), png("before")]]);
    const { pulls } = await listed(files, () => null);
    const after = await pulls.fileBytes(KEY, "layer", "new", "img/b.png", "img/a.png", [], 1000, undefined, "d".repeat(40));
    expect(after.kind === "ok" && Buffer.from(after.bytes).equals(png("after"))).toBe(true);
    const before = await pulls.fileBytes(KEY, "layer", "old", "img/b.png", "img/a.png", [], 1000, undefined, HEAD);
    expect(before.kind === "ok" && Buffer.from(before.bytes).equals(png("before"))).toBe(true);
  });

  test("a path out of the repository reads nothing; an unknown PR throws", async () => {
    const { pulls, asked } = await listed(new Map(), () => {
      throw new Error("read");
    });
    expect(await pulls.fileBytes(KEY, "layer", "old", "img/b.png", "../outside.png", ["/clone"], 1000)).toEqual({ kind: "missing" });
    expect(asked).toEqual([]);
    await expect(pulls.fileBytes("github.com/northwind/billing-svc#999", "layer", "new", "img/b.png", undefined, [], 1000)).rejects.toThrow();
  });

  test("past the cap on the forge: too large, never decoded", async () => {
    const { pulls } = await listed(new Map([[contents("img/a.png", HEAD), png("x".repeat(2000))]]), () => null);
    expect((await pulls.fileBytes(KEY, "layer", "new", "img/a.png", undefined, [], 1000)).kind).toBe("too-large");
  });
});

describe("a guide's patch for its previews", () => {
  test("a read that fails is not remembered: once the snapshot can be read, its patch is served", () => {
    const dir = join(scratch, "store");
    const sha = "e".repeat(64);
    const store = { dir } as unknown as InboxStore;
    expect(guidePatchOf(store, sha)).toBeNull();
    const snapshot = buildGuideSnapshot({
      guide: { title: "T", intent: "I", sections: [{ title: "S", overview: "O", diffs: [{ file: "img/modified.png", summary: "s" }] }] },
      reviewed: [false],
      review: { rawPatch: patch, gitRef: "main...HEAD", source: { kind: "local" } },
      exportedAt: "2026-11-23T10:00:00.000Z",
    });
    const blob = inboxBlobPath(dir, sha);
    mkdirSync(join(blob, ".."), { recursive: true });
    writeFileSync(blob, JSON.stringify(snapshot));
    expect(guidePatchOf(store, sha)).toBe(patch);
  });

  test("the commit a guide pins: a commit guide's commit, else the head it was made at; never a ref or none", () => {
    const dir = join(scratch, "store-pins");
    const store = { dir } as unknown as InboxStore;
    const head = "1".repeat(40);
    const commit = "2".repeat(40);
    const pinOf = (sha: string, source: Record<string, unknown>) => {
      const snapshot = buildGuideSnapshot({
        guide: { title: "T", intent: "I", sections: [{ title: "S", overview: "O", diffs: [{ file: "img/modified.png", summary: "s" }] }] },
        reviewed: [false],
        review: { rawPatch: patch, gitRef: "main...HEAD", source: source as { kind: "local" } },
        exportedAt: "2026-11-23T10:00:00.000Z",
      });
      const blob = inboxBlobPath(dir, sha);
      mkdirSync(join(blob, ".."), { recursive: true });
      writeFileSync(blob, JSON.stringify(snapshot));
      return guideReviewOf(store, sha)?.revision;
    };
    expect(pinOf("a".repeat(64), { kind: "local", headSha: head })).toBe(head);
    expect(pinOf("b".repeat(64), { kind: "commit", headSha: head, commitSha: commit })).toBe(commit);
    expect(pinOf("c".repeat(64), { kind: "local" })).toBeNull();
    expect(pinOf("d".repeat(64), { kind: "local", headSha: "main~1" })).toBeNull();
  });
});
