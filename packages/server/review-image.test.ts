/**
 * `GET /api/review-image` (#1598) against a real git repository, on BOTH
 * review servers (Bun and the Pi mirror), so the two cannot drift.
 *
 * Regressions guarded:
 *  - binary bytes corrupted on the way out (UTF-8 decode anywhere in the path);
 *  - the wrong side served (added/deleted/renamed resolve from the chunk);
 *  - anything outside the current diff being readable (text files, unknown
 *    paths, `..`, a directory swapped for a symlink after the diff was taken);
 *  - stale tabs reading a newer snapshot;
 *  - an oversized file or a decode bomb reaching the browser;
 *  - the headers that make an SVG harmless if opened directly;
 *  - static-patch sessions reading anything at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";
import { getVcsContext, runVcsDiff } from "./vcs";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(key: string) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function reservePiPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  saveEnv("PLANNOTATOR_PORT");
  process.env.PLANNOTATOR_PORT = String(port);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

/** A PNG header (real IHDR) followed by bytes a UTF-8 decode would mangle. */
function png(width: number, height: number, seed: number, extra = 0): Uint8Array {
  const out = new Uint8Array(33 + 64 + extra);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  for (let i = 33; i < 33 + 64; i++) out[i] = (i * 37 + seed) & 0xff;
  return out;
}

const SVG_OLD = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
const SVG_NEW = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><circle r="2"/></svg>';

interface Fixture {
  repo: string;
  outside: string;
  files: Record<string, Uint8Array>;
}

function buildRepo(): Fixture {
  const repo = makeTempDir("plannotator-review-image-repo-");
  const outside = makeTempDir("plannotator-review-image-outside-");
  git(repo, ["init", "-q"]);
  git(repo, ["branch", "-M", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  const files: Record<string, Uint8Array> = {
    "mod-before": png(4, 3, 1),
    "mod-after": png(8, 6, 2),
    gone: png(2, 2, 3),
    renamed: png(5, 5, 4),
    added: png(7, 7, 5),
    nested: png(3, 3, 6),
    "dots-before": png(6, 6, 10),
    "dots-after": png(6, 6, 11),
  };
  writeFileSync(join(repo, ".gitattributes"), "*.svg binary\n");
  writeFileSync(join(repo, "mod.png"), files["mod-before"]);
  writeFileSync(join(repo, "gone.png"), files.gone);
  writeFileSync(join(repo, "ren-old.png"), files.renamed);
  writeFileSync(join(repo, "logo.svg"), SVG_OLD);
  writeFileSync(join(repo, "fake.png"), new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 1, 2]));
  writeFileSync(join(repo, "notes.txt"), "one\n");
  writeFileSync(join(repo, "logo..v2.png"), files["dots-before"]);
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "nested.png"), png(3, 3, 9));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);

  writeFileSync(join(repo, "mod.png"), files["mod-after"]);
  rmSync(join(repo, "gone.png"));
  git(repo, ["mv", "ren-old.png", "ren-new.png"]);
  writeFileSync(join(repo, "added.png"), files.added);
  writeFileSync(join(repo, "logo.svg"), SVG_NEW);
  writeFileSync(join(repo, "fake.png"), new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9]));
  writeFileSync(join(repo, "notes.txt"), "two\n");
  writeFileSync(join(repo, "logo..v2.png"), files["dots-after"]);
  writeFileSync(join(repo, "sub", "nested.png"), files.nested);
  // 20000 x 20000 = 400 MP in a ~100-byte file: the decode-bomb shape.
  writeFileSync(join(repo, "bomb.png"), png(20_000, 20_000, 7));
  // Just over the 10 MB cap; the worktree side must be refused by size.
  writeFileSync(join(repo, "big.png"), png(10, 10, 8, 10 * 1024 * 1024));
  // What the symlink-swap test points the directory at.
  writeFileSync(join(outside, "nested.png"), png(1, 1, 99));
  return { repo, outside, files };
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

for (const [runtime, startServer] of [
  ["Bun", startBunReviewServer],
  ["Pi", startPiReviewServer],
] as const) {
  describe(`/api/review-image (${runtime})`, () => {
    async function start(fixture: Fixture) {
      saveEnv("PLANNOTATOR_DATA_DIR");
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-review-image-data-");
      if (runtime === "Pi") await reservePiPort();
      const gitContext = await getVcsContext(fixture.repo, "git");
      const diff = await runVcsDiff("uncommitted", "main", fixture.repo);
      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        diffType: "uncommitted",
        gitContext,
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: MINIMAL_HTML,
      });
      const payload = (await fetch(`${server.url}/api/diff`).then((r) => r.json())) as {
        snapshotId: string;
        imagePreviewSupported?: boolean;
      };
      const image = (path: string, side: "old" | "new", init?: RequestInit) =>
        fetch(
          `${server.url}/api/review-image?path=${encodeURIComponent(path)}&side=${side}&snapshot=${encodeURIComponent(payload.snapshotId)}`,
          init,
        );
      return { server, payload, image };
    }

    const bodyBytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());
    const reason = async (response: Response) => ((await response.json()) as { reason: string }).reason;

    test("serves both sides byte-for-byte, resolved from the chunk", async () => {
      const fixture = buildRepo();
      const { server, payload, image } = await start(fixture);
      try {
        expect(payload.imagePreviewSupported).toBe(true);

        const before = await image("mod.png", "old");
        expect(before.status).toBe(200);
        expect(await bodyBytes(before)).toEqual(fixture.files["mod-before"]);
        const after = await image("mod.png", "new");
        expect(await bodyBytes(after)).toEqual(fixture.files["mod-after"]);
        expect(after.headers.get("content-type")).toBe("image/png");
        expect(after.headers.get("x-image-width")).toBe("8");
        expect(after.headers.get("x-image-height")).toBe("6");

        // Added: only the new side exists. Deleted: only the old side.
        expect(await bodyBytes(await image("added.png", "new"))).toEqual(fixture.files.added);
        expect(await reason(await image("added.png", "old"))).toBe("absent");
        expect(await bodyBytes(await image("gone.png", "old"))).toEqual(fixture.files.gone);
        expect(await reason(await image("gone.png", "new"))).toBe("absent");

        // Rename: the old side is read at its OLD path, which the client never sends.
        const renamedOld = await image("ren-new.png", "old");
        expect(renamedOld.status).toBe(200);
        expect(await bodyBytes(renamedOld)).toEqual(fixture.files.renamed);
      } finally {
        server.stop();
      }
    }, 20_000);

    test("every image response carries nosniff, the sandbox CSP and CORP; SVG is sniffed from its bytes", async () => {
      const fixture = buildRepo();
      const { server, image } = await start(fixture);
      try {
        for (const response of [await image("logo.svg", "new"), await image("mod.png", "new")]) {
          expect(response.status).toBe(200);
          expect(response.headers.get("x-content-type-options")).toBe("nosniff");
          expect(response.headers.get("content-security-policy")).toContain("sandbox");
          expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
        }
        const svg = await image("logo.svg", "new");
        expect(svg.headers.get("content-type")).toBe("image/svg+xml");
        expect(await svg.text()).toBe(SVG_NEW);
      } finally {
        server.stop();
      }
    }, 20_000);

    test("refuses everything that is not a previewable image in this diff", async () => {
      const fixture = buildRepo();
      const { server, image } = await start(fixture);
      try {
        expect(await reason(await image("notes.txt", "new"))).toBe("not-in-diff");
        expect(await reason(await image("README.png", "new"))).toBe("not-in-diff");
        expect(await reason(await image("../mod.png", "new"))).toBe("not-in-diff");
        const fake = await image("fake.png", "new");
        expect(fake.status).toBe(415);
        expect(await reason(fake)).toBe("not-image");
      } finally {
        server.stop();
      }
    }, 20_000);

    test("a `..` inside a file name previews; `..` segments stay refused, here and in /api/file-content", async () => {
      const fixture = buildRepo();
      const { server, image } = await start(fixture);
      try {
        expect(await bodyBytes(await image("logo..v2.png", "old"))).toEqual(fixture.files["dots-before"]);
        expect(await bodyBytes(await image("logo..v2.png", "new"))).toEqual(fixture.files["dots-after"]);
        // The validator is shared with hunk expansion: loosening it for
        // dotted names must not open traversal there.
        const traversal = await fetch(`${server.url}/api/file-content?path=${encodeURIComponent("sub/../../outside.txt")}`);
        expect(traversal.status).toBe(400);
        const dotted = await fetch(`${server.url}/api/file-content?path=${encodeURIComponent("notes.txt")}`);
        expect(((await dotted.json()) as { newContent: string }).newContent).toBe("two\n");
      } finally {
        server.stop();
      }
    }, 20_000);

    test("a directory swapped for a symlink out of the repo after the diff is refused", async () => {
      const fixture = buildRepo();
      const { server, image } = await start(fixture);
      try {
        renameSync(join(fixture.repo, "sub"), join(fixture.repo, "sub-moved"));
        symlinkSync(fixture.outside, join(fixture.repo, "sub"));
        const response = await image("sub/nested.png", "new");
        expect(response.status).toBe(404);
        expect(await reason(response)).toBe("missing");
      } finally {
        server.stop();
      }
    }, 20_000);

    test("a stale snapshot is 409 and never reads", async () => {
      const fixture = buildRepo();
      const { server } = await start(fixture);
      try {
        const response = await fetch(`${server.url}/api/review-image?path=mod.png&side=new&snapshot=stale`);
        expect(response.status).toBe(409);
      } finally {
        server.stop();
      }
    }, 20_000);

    test("an over-cap file and a decode bomb are 413 with the numbers the notice shows", async () => {
      const fixture = buildRepo();
      const { server, image } = await start(fixture);
      try {
        const big = await image("big.png", "new");
        expect(big.status).toBe(413);
        expect(((await big.json()) as { bytes?: number }).bytes).toBeGreaterThan(10 * 1024 * 1024);
        const bomb = await image("bomb.png", "new");
        expect(bomb.status).toBe(413);
        expect(await bomb.json()).toMatchObject({ reason: "too-large", width: 20_000, height: 20_000 });
      } finally {
        server.stop();
      }
    }, 20_000);

    test("revalidation: a matching If-None-Match is a bodyless 304", async () => {
      const fixture = buildRepo();
      const { server, image } = await start(fixture);
      try {
        const first = await image("mod.png", "old");
        const etag = first.headers.get("etag");
        expect(etag).toBeTruthy();
        const second = await image("mod.png", "old", { headers: { "If-None-Match": etag! } });
        expect(second.status).toBe(304);
      } finally {
        server.stop();
      }
    }, 20_000);

    test("committed sides of a commit:<sha> diff round-trip after a switch", async () => {
      const fixture = buildRepo();
      git(fixture.repo, ["add", "-A"]);
      git(fixture.repo, ["commit", "-q", "-m", "second"]);
      const sha = git(fixture.repo, ["rev-parse", "HEAD"]).trim();
      const { server } = await start(fixture);
      try {
        const switched = (await fetch(`${server.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: `commit:${sha}` }),
        }).then((r) => r.json())) as { snapshotId: string; imagePreviewSupported?: boolean };
        expect(switched.imagePreviewSupported).toBe(true);
        const url = (side: string) =>
          `${server.url}/api/review-image?path=mod.png&side=${side}&snapshot=${encodeURIComponent(switched.snapshotId)}`;
        expect(new Uint8Array(await (await fetch(url("old"))).arrayBuffer())).toEqual(fixture.files["mod-before"]);
        expect(new Uint8Array(await (await fetch(url("new"))).arrayBuffer())).toEqual(fixture.files["mod-after"]);
      } finally {
        server.stop();
      }
    }, 20_000);

    test("a static patch session advertises nothing and reads nothing", async () => {
      saveEnv("PLANNOTATOR_DATA_DIR");
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-review-image-data-");
      if (runtime === "Pi") await reservePiPort();
      const server = await startServer({
        rawPatch: "diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n",
        gitRef: "reading.diff",
        diffType: "static-patch",
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: MINIMAL_HTML,
      });
      try {
        const payload = (await fetch(`${server.url}/api/diff`).then((r) => r.json())) as {
          snapshotId: string;
          imagePreviewSupported?: boolean;
        };
        expect(payload.imagePreviewSupported).toBe(false);
        const response = await fetch(
          `${server.url}/api/review-image?path=a.png&side=new&snapshot=${encodeURIComponent(payload.snapshotId)}`,
        );
        expect(response.status).toBe(400);
      } finally {
        server.stop();
      }
    }, 20_000);
  });
}
