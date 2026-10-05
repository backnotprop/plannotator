/**
 * Git LFS images through `GET /api/review-image` (#1665) against a real git
 * repository, on BOTH review servers (Bun and the Pi mirror).
 *
 * The repository holds LFS pointer files committed by hand and the objects in
 * `.git/lfs/objects`, which is exactly what git-lfs leaves behind, so the test
 * needs no git-lfs install.
 *
 * Regressions guarded:
 *  - a pointer side not resolved from the repository's LFS object cache;
 *  - a smudged working-tree file (the real image) not used for its side;
 *  - a corrupt cache entry served as the image (it must fail the oid check);
 *  - a pointer over the size cap read anyway;
 *  - the two runtimes drifting (advert, resolution, error mapping).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function png(seed: number): Uint8Array {
  const out = new Uint8Array(33 + 64);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, 6);
  view.setUint32(20, 4);
  for (let i = 33; i < out.length; i++) out[i] = (i * 37 + seed) & 0xff;
  return out;
}

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const pointer = (oid: string, size: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

function cacheObject(repo: string, oid: string, data: Uint8Array) {
  const path = join(repo, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

interface Fixture {
  repo: string;
  before: Uint8Array;
  after: Uint8Array;
}

/**
 * `shot.png`: committed pointer (object in the cache), then a staged pointer
 * for a new image whose object is NOT cached, with the real image in the
 * working tree (what git-lfs's smudge leaves). `bad.png`: a staged pointer
 * whose cache entry holds other bytes. `big.png`: a pointer over the cap.
 */
function buildRepo(): Fixture {
  const repo = makeTempDir("plannotator-review-lfs-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["branch", "-M", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  const before = png(1);
  const after = png(2);
  writeFileSync(join(repo, "shot.png"), pointer(sha(before), before.byteLength));
  cacheObject(repo, sha(before), before);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);

  writeFileSync(join(repo, "shot.png"), pointer(sha(after), after.byteLength));
  const bad = png(3);
  writeFileSync(join(repo, "bad.png"), pointer(sha(bad), bad.byteLength));
  cacheObject(repo, sha(bad), png(4).subarray(0, bad.byteLength));
  writeFileSync(join(repo, "big.png"), pointer("e".repeat(64), 11 * 1024 * 1024));
  git(repo, ["add", "-A"]);
  // The smudged working copy: the real image, not the staged pointer.
  writeFileSync(join(repo, "shot.png"), after);
  return { repo, before, after };
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
  describe(`/api/review-image with Git LFS pointers (${runtime})`, () => {
    test("resolves each side from the LFS cache or the smudged working tree, verified against the oid", async () => {
      const fixture = buildRepo();
      saveEnv("PLANNOTATOR_DATA_DIR");
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-review-lfs-data-");
      if (runtime === "Pi") await reservePiPort();
      const gitContext = await getVcsContext(fixture.repo, "git");
      const diff = await runVcsDiff("staged", "main", fixture.repo);
      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        diffType: "staged",
        gitContext,
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: MINIMAL_HTML,
      });
      try {
        const payload = (await fetch(`${server.url}/api/diff`).then((r) => r.json())) as {
          snapshotId: string;
          lfsImagePreviewSupported?: boolean;
        };
        expect(payload.lfsImagePreviewSupported).toBe(true);
        const image = (path: string, side: "old" | "new") =>
          fetch(`${server.url}/api/review-image?path=${path}&side=${side}&snapshot=${encodeURIComponent(payload.snapshotId)}`);
        const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());

        // Old side: HEAD's pointer, resolved from .git/lfs/objects.
        const before = await image("shot.png", "old");
        expect(before.status).toBe(200);
        expect(await bytes(before)).toEqual(fixture.before);
        // New side: the staged pointer's object is not cached; the working
        // tree file hashes to its oid.
        const after = await image("shot.png", "new");
        expect(after.status).toBe(200);
        expect(await bytes(after)).toEqual(fixture.after);
        expect(after.headers.get("content-type")).toBe("image/png");

        // A cache entry with the wrong bytes is never shown.
        const bad = await image("bad.png", "new");
        expect(bad.status).toBe(415);
        expect(((await bad.json()) as { reason: string }).reason).toBe("lfs-pointer");

        const big = await image("big.png", "new");
        expect(big.status).toBe(413);
        expect(((await big.json()) as { bytes: number }).bytes).toBe(11 * 1024 * 1024);
      } finally {
        server.stop();
      }
    }, 20_000);
  });
}
