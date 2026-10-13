/**
 * `GET /api/review-markdown-image` (the code-review Markdown preview's
 * images) against a real git repository, on BOTH review servers (Bun and the
 * Pi mirror), so the two cannot drift.
 *
 * Regressions guarded:
 *  - an image read from the working tree instead of the side on screen (the
 *    old side of a modified image, a deleted document's images);
 *  - a path the document does not show being readable (unreferenced files,
 *    `..` above the repository root);
 *  - the `markdownPreviewSupported` advert missing from the diff payload,
 *    or present on a static patch session.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
function png(width: number, height: number, seed: number): Uint8Array {
  const out = new Uint8Array(33 + 64);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  for (let i = 33; i < 33 + 64; i++) out[i] = (i * 37 + seed) & 0xff;
  return out;
}

interface Fixture {
  repo: string;
  files: Record<string, Uint8Array>;
}

const GUIDE_OLD = [
  "# Guide",
  "",
  "![shot](img/shot.png)",
  "",
  "![logo](/assets/logo.png)",
  "",
].join("\n");

const GUIDE_NEW = [
  "# Guide, revised",
  "",
  "![shot](img/shot.png \"The screen\")",
  "",
  "![logo](/assets/logo.png)",
  "",
  '<img src="img/b&amp;w.png" alt="raw">',
  "",
  "![escape](../../outside.png)",
  "",
].join("\n");

function buildRepo(): Fixture {
  const repo = makeTempDir("plannotator-review-md-image-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["branch", "-M", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  const files: Record<string, Uint8Array> = {
    "shot-before": png(4, 3, 1),
    "shot-after": png(8, 6, 2),
    logo: png(5, 5, 3),
    bw: png(6, 6, 4),
    old: png(2, 2, 5),
    secret: png(3, 3, 6),
  };
  mkdirSync(join(repo, "docs", "img"), { recursive: true });
  mkdirSync(join(repo, "assets"));
  writeFileSync(join(repo, "docs", "guide.md"), GUIDE_OLD);
  writeFileSync(join(repo, "docs", "img", "shot.png"), files["shot-before"]);
  writeFileSync(join(repo, "docs", "img", "b&w.png"), files.bw);
  writeFileSync(join(repo, "docs", "img", "secret.png"), files.secret);
  writeFileSync(join(repo, "assets", "logo.png"), files.logo);
  writeFileSync(join(repo, "old.md"), "# Old\n\n![old](old.png)\n");
  writeFileSync(join(repo, "old.png"), files.old);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);

  writeFileSync(join(repo, "docs", "guide.md"), GUIDE_NEW);
  writeFileSync(join(repo, "docs", "img", "shot.png"), files["shot-after"]);
  rmSync(join(repo, "old.md"));
  rmSync(join(repo, "old.png"));
  return { repo, files };
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
  describe(`/api/review-markdown-image (${runtime})`, () => {
    async function start(fixture: Fixture) {
      saveEnv("PLANNOTATOR_DATA_DIR");
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-review-md-image-data-");
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
        markdownPreviewSupported?: boolean;
      };
      const image = (doc: string, side: "old" | "new", src: string) =>
        fetch(
          `${server.url}/api/review-markdown-image?doc=${encodeURIComponent(doc)}&side=${side}&src=${encodeURIComponent(src)}&snapshot=${encodeURIComponent(payload.snapshotId)}`,
        );
      return { server, payload, image };
    }

    const bodyBytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());
    const reason = async (response: Response) => ((await response.json()) as { reason: string }).reason;

    test("serves the image each side shows, read at that side, relative to the document's folder", async () => {
      const fixture = buildRepo();
      const { server, payload, image } = await start(fixture);
      try {
        expect(payload.markdownPreviewSupported).toBe(true);

        const after = await image("docs/guide.md", "new", "img/shot.png");
        expect(after.status).toBe(200);
        expect(await bodyBytes(after)).toEqual(fixture.files["shot-after"]);
        expect(after.headers.get("content-type")).toBe("image/png");
        expect(after.headers.get("x-content-type-options")).toBe("nosniff");
        expect(after.headers.get("content-security-policy")).toContain("sandbox");
        expect(after.headers.get("cross-origin-resource-policy")).toBe("same-origin");

        // The old side reads the committed image, not the working tree's.
        const before = await image("docs/guide.md", "old", "img/shot.png");
        expect(await bodyBytes(before)).toEqual(fixture.files["shot-before"]);

        // `/` is the repository root; an <img src> value is decoded.
        expect(await bodyBytes(await image("docs/guide.md", "new", "/assets/logo.png"))).toEqual(fixture.files.logo);
        expect(await bodyBytes(await image("docs/guide.md", "new", "img/b&w.png"))).toEqual(fixture.files.bw);
      } finally {
        server.stop();
      }
    }, 20_000);

    test("a deleted document shows its images from the old side; it has no new side", async () => {
      const fixture = buildRepo();
      const { server, image } = await start(fixture);
      try {
        const old = await image("old.md", "old", "old.png");
        expect(old.status).toBe(200);
        expect(await bodyBytes(old)).toEqual(fixture.files.old);
        expect(await reason(await image("old.md", "new", "old.png"))).toBe("absent");
      } finally {
        server.stop();
      }
    }, 20_000);

    test("refuses what the document does not show and what leaves the repository", async () => {
      const fixture = buildRepo();
      const { server, image } = await start(fixture);
      try {
        const unreferenced = await image("docs/guide.md", "new", "img/secret.png");
        expect(unreferenced.status).toBe(403);
        expect(await reason(unreferenced)).toBe("not-referenced");
        // Referenced on the new side only: the old document never showed it.
        expect(await reason(await image("docs/guide.md", "old", "img/b&w.png"))).toBe("not-referenced");

        const escape = await image("docs/guide.md", "new", "../../outside.png");
        expect(escape.status).toBe(403);
        expect(await reason(escape)).toBe("outside-repo");

        expect(await reason(await image("docs/img/shot.png", "new", "img/shot.png"))).toBe("not-in-diff");
        expect(await reason(await image("docs/guide.md", "new", "https://example.com/a.png"))).toBe("bad-request");
      } finally {
        server.stop();
      }
    }, 20_000);

    test("a static patch session advertises no preview and reads nothing", async () => {
      saveEnv("PLANNOTATOR_DATA_DIR");
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-review-md-image-data-");
      if (runtime === "Pi") await reservePiPort();
      const server = await startServer({
        rawPatch: "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-![x](x.png)\n+![y](x.png)\n",
        gitRef: "reading.diff",
        diffType: "static-patch",
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: MINIMAL_HTML,
      });
      try {
        const payload = (await fetch(`${server.url}/api/diff`).then((r) => r.json())) as {
          snapshotId: string;
          markdownPreviewSupported?: boolean;
        };
        expect(payload.markdownPreviewSupported).toBe(false);
        const response = await fetch(
          `${server.url}/api/review-markdown-image?doc=a.md&side=new&src=x.png&snapshot=${encodeURIComponent(payload.snapshotId)}`,
        );
        expect(response.status).toBe(400);
      } finally {
        server.stop();
      }
    }, 20_000);
  });
}
