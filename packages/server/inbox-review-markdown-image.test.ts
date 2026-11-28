/**
 * The pictures of a rendered Markdown file in the Inbox (review parity B3): one
 * image a changed `.md` file shows, for the PR page (`pullReviewMarkdownImage`)
 * and a guided review (`guideReviewMarkdownImage`), both through the shared
 * handler. Real git in a temp folder; a scripted PR reader. No Inbox is started
 * and no real CLI or forge runs.
 *
 * What regresses (untrusted Markdown must not reach a local file):
 *  - a picture outside the repository (`../`, an absolute path, a symlink that
 *    points out), or a file that is no picture, read and served;
 *  - a picture the document does not show, or a document the diff does not
 *    change, read at all;
 *  - a picture the patch does not change read from the working tree (it is read
 *    as committed) or a changed one read from anything but its patch's blob;
 *  - the byte cap not holding; a stale snapshot answered;
 *  - a bad request reading the diff (or the forge) before it is refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES } from "@plannotator/core/diff-paths";
import type { InboxPulls } from "./inbox-pulls";
import { guideReviewMarkdownImage, pullReviewMarkdownImage } from "./inbox-review-markdown-image";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const png = (tag: string) => Buffer.concat([PNG, Buffer.from(tag, "latin1")]);

const README_BEFORE = "# Ledger\n\n![chart](img/chart.png)\n";
const README_AFTER = [
  "# Ledger",
  "",
  "![chart](img/chart.png)",
  "![logo](/img/logo.png)",
  "![out](../outside.png)",
  "![link](img/link.png)",
  "![big](img/big.png)",
  "![draft](img/draft.png)",
  "![secret](img/secret.txt)",
  "",
  "`![code](img/in-code.png)`",
  "",
].join("\n");

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
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "inbox-review-markdown-image-")));
  process.env.PLANNOTATOR_DATA_DIR = join(scratch, "data");
  repo = join(scratch, "repo");
  mkdirSync(join(repo, "img"), { recursive: true });
  writeFileSync(join(scratch, "outside.png"), png("outside"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), README_BEFORE);
  writeFileSync(join(repo, "notes.txt"), "![chart](img/chart.png)\n");
  writeFileSync(join(repo, "img/chart.png"), png("chart before"));
  writeFileSync(join(repo, "img/logo.png"), png("logo"));
  writeFileSync(join(repo, "img/secret.txt"), "TOKEN=1\n");
  // A picture past the byte cap, committed: refused as too large.
  writeFileSync(join(repo, "img/big.png"), Buffer.concat([PNG, Buffer.alloc(MAX_REVIEW_IMAGE_PREVIEW_BYTES + 1)]));
  // A committed symlink named like a picture, pointing out of the repository.
  symlinkSync(join(scratch, "outside.png"), join(repo, "img/link.png"));
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  writeFileSync(join(repo, "README.md"), README_AFTER);
  writeFileSync(join(repo, "notes.txt"), "![chart](img/chart.png)\nmore\n");
  writeFileSync(join(repo, "img/chart.png"), png("chart after"));
  // Uncommitted edits: the README and the chart change; a picture only in the working tree is not committed.
  writeFileSync(join(repo, "img/draft.png"), png("draft, never committed"));
  patch = git("diff", "--", "README.md", "notes.txt", "img/chart.png");
});

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  rmSync(scratch, { recursive: true, force: true });
});

const ask = (src: string, side: "old" | "new", snapshot: string, doc = "README.md") => new URLSearchParams({ doc, side, src, snapshot });
const bytesOf = (body: unknown) => Buffer.from(body as Uint8Array);
const reasonOf = (body: unknown) => (JSON.parse(String(body)) as { reason: string }).reason;

describe("a guided review's Markdown picture", () => {
  const MESSAGE = "msg_1";
  const read = (src: string, side: "old" | "new" = "new", options: { snapshot?: string; doc?: string } = {}) =>
    guideReviewMarkdownImage({ patch, messageId: MESSAGE, root: repo, params: ask(src, side, options.snapshot ?? MESSAGE, options.doc) });

  test("a picture the patch changes: each side is the blob the patch names", async () => {
    const before = await read("img/chart.png", "old");
    expect(before.status).toBe(200);
    expect(before.headers["Content-Type"]).toBe("image/png");
    expect(bytesOf(before.body).equals(png("chart before"))).toBe(true);
    expect(bytesOf((await read("img/chart.png", "new")).body).equals(png("chart after"))).toBe(true);
  });

  test("a picture the patch does not change: as committed, from the repository's root for a leading slash", async () => {
    const logo = await read("/img/logo.png");
    expect(logo.status).toBe(200);
    expect(bytesOf(logo.body).equals(png("logo"))).toBe(true);
  });

  test("a picture the patch does not change, for a guide that pins its commit: read there, not at the project's HEAD now", async () => {
    const pinned = git("rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "img/logo.png"), png("logo, later"));
    git("commit", "-q", "-m", "later logo", "--", "img/logo.png");
    try {
      const at = (revision?: string) =>
        guideReviewMarkdownImage({ patch, messageId: MESSAGE, root: repo, ...(revision ? { revision } : {}), params: ask("/img/logo.png", "new", MESSAGE) });
      expect(bytesOf((await at(pinned)).body).equals(png("logo"))).toBe(true);
      // A guide that records none: the project's HEAD.
      expect(bytesOf((await at()).body).equals(png("logo, later"))).toBe(true);
    } finally {
      writeFileSync(join(repo, "img/logo.png"), png("logo"));
      git("commit", "-q", "-m", "logo back", "--", "img/logo.png");
    }
  });

  test("never the working tree for a picture the patch does not change", async () => {
    const draft = await read("img/draft.png");
    expect([draft.status, reasonOf(draft.body)]).toEqual([404, "missing"]);
  });

  test("outside the repository, through a symlink, or no picture: refused", async () => {
    expect([(await read("../outside.png")).status, reasonOf((await read("../outside.png")).body)]).toEqual([403, "outside-repo"]);
    const link = await read("img/link.png");
    expect(link.status).not.toBe(200);
    expect(String(link.body)).not.toContain("outside");
    expect([(await read("img/secret.txt")).status, reasonOf((await read("img/secret.txt")).body)]).toEqual([415, "not-image"]);
    expect((await read("/etc/hosts")).status).toBe(415);
    expect((await read("https://example.com/a.png")).status).toBe(400);
  });

  test("a picture the document does not show, even in a code span, is not read", async () => {
    const unshown = await read("img/unknown.png");
    expect([unshown.status, reasonOf(unshown.body)]).toEqual([403, "not-referenced"]);
    expect(reasonOf((await read("img/in-code.png")).body)).toBe("not-referenced");
    // The old README never showed the logo.
    expect(reasonOf((await read("/img/logo.png", "old")).body)).toBe("not-referenced");
  });

  test("past the byte cap: 413", async () => {
    const big = await read("img/big.png");
    expect([big.status, reasonOf(big.body)]).toEqual([413, "too-large"]);
  });

  test("a document the diff does not change, or one that is no Markdown file, reads nothing", async () => {
    expect([(await read("img/chart.png", "new", { doc: "docs/other.md" })).status, reasonOf((await read("img/chart.png", "new", { doc: "docs/other.md" })).body)]).toEqual([404, "not-in-diff"]);
    expect((await read("img/chart.png", "new", { doc: "notes.txt" })).status).toBe(404);
    expect((await read("img/chart.png", "new", { doc: "../outside.md" })).status).toBe(404);
  });

  test("another message's snapshot is stale", async () => {
    expect((await read("img/chart.png", "new", { snapshot: "msg_2" })).status).toBe(409);
  });
});

describe("a pull request's Markdown picture", () => {
  const HEAD = "a".repeat(40);
  const fake = () => {
    const reads: { side: string; path: string; head: string | undefined }[] = [];
    let diffs = 0;
    const pulls: Pick<InboxPulls, "diff" | "fileBytes"> = {
      diff: async () => {
        diffs += 1;
        return { patch, partial: false, head_sha: HEAD };
      },
      fileBytes: async (_key, _scope, side, path, oldPath, _roots, _max, _from, head) => {
        const at = side === "old" ? (oldPath ?? path) : path;
        reads.push({ side, path: at, head });
        if (at === "README.md") return { kind: "ok", bytes: Buffer.from(side === "old" ? README_BEFORE : README_AFTER) };
        return { kind: "ok", bytes: png(`${side} ${at}`) };
      },
    };
    return { pulls, reads, diffs: () => diffs };
  };
  const read = (pulls: Pick<InboxPulls, "diff" | "fileBytes">, src: string, side: "old" | "new" = "new", snapshot = HEAD, doc = "README.md") =>
    pullReviewMarkdownImage({ pulls, key: "github.com/northwind/billing-svc#412", scope: "layer", params: ask(src, side, snapshot, doc), roots: async () => [] });

  test("the document and its picture read at the head on screen", async () => {
    const { pulls, reads } = fake();
    const logo = await read(pulls, "/img/logo.png");
    expect(logo.status).toBe(200);
    expect(bytesOf(logo.body).equals(png("new img/logo.png"))).toBe(true);
    expect(reads).toEqual([
      { side: "new", path: "README.md", head: HEAD },
      { side: "new", path: "img/logo.png", head: HEAD },
    ]);
  });

  test("a picture the document does not show: only the document is read", async () => {
    const { pulls, reads } = fake();
    expect(reasonOf((await read(pulls, "img/unknown.png")).body)).toBe("not-referenced");
    expect(reads.map((r) => r.path)).toEqual(["README.md"]);
  });

  test("a bad document, side or source reads neither the diff nor the forge", async () => {
    const { pulls, reads, diffs } = fake();
    expect((await read(pulls, "img/chart.png", "new", HEAD, "../../etc/passwd.md")).status).toBe(404);
    expect((await read(pulls, "img/chart.png", "new", HEAD, "/etc/README.md")).status).toBe(404);
    expect((await pullReviewMarkdownImage({ pulls, key: "k", scope: "layer", params: new URLSearchParams({ doc: "README.md", side: "both", src: "a.png", snapshot: HEAD }), roots: async () => [] })).status).toBe(400);
    expect((await read(pulls, "", "new")).status).toBe(400);
    expect([diffs(), reads.length]).toEqual([0, 0]);
  });

  test("another head than the diff's is stale; outside the repository is refused before a read", async () => {
    const { pulls, reads } = fake();
    expect((await read(pulls, "img/chart.png", "new", "b".repeat(40))).status).toBe(409);
    expect((await read(pulls, "../outside.png")).status).toBe(403);
    expect(reads).toEqual([]);
  });
});
