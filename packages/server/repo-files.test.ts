/**
 * All files (`GET /api/repo-files`, `/api/repo-file`, `/api/repo-files/stream`)
 * against real repositories, on BOTH review servers (Bun and the Pi mirror),
 * so the two cannot drift.
 *
 * Regressions guarded:
 *  - the tree listing files the diff's new side does not read (the working
 *    tree for a committed diff, ignored files, files deleted on disk);
 *  - `/api/repo-file` reading a path outside the listing (an ignored `.env`,
 *    `..`), or the working tree when the diff reads a commit;
 *  - a working-tree read skipping the repo-file guard (repo-file.ts): a FIFO
 *    that would block the server, a file over the 5 MB cap read into memory
 *    (links are followed like VS Code, the owner's ruling on #2261);
 *  - the `repoFilesSupported` advert missing, or present on a static patch;
 *  - big listings sent whole instead of one folder at a time;
 *  - files changed on disk after the diff was taken not reported, and the
 *    live stream not telling the page to list again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";
import { getVcsContext, runVcsDiff } from "./vcs";
import { MAX_REPO_FILE_BYTES } from "@plannotator/shared/repo-files";

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

function write(repo: string, path: string, content: string | Uint8Array) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/**
 * src/app.ts (changed), src/util.ts and README.md (unchanged), docs/old.md
 * (deleted on disk), notes/new.md (untracked), .env and dist/out.js (ignored).
 */
function buildRepo(): string {
  const repo = makeTempDir("plannotator-repo-files-");
  git(repo, ["init", "-q"]);
  git(repo, ["branch", "-M", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  write(repo, ".gitignore", ".env\ndist/\n");
  write(repo, "README.md", "# Repo\n");
  write(repo, "src/app.ts", "export const app = 1;\n");
  write(repo, "src/util.ts", "export const util = 'committed';\n");
  write(repo, "docs/old.md", "old\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  write(repo, "src/app.ts", "export const app = 2;\n");
  write(repo, "src/util.ts", "export const util = 'working tree';\n");
  git(repo, ["add", "src/util.ts"]);
  git(repo, ["commit", "-q", "-m", "util"]);
  write(repo, "src/util.ts", "export const util = 'edited after the commit';\n");
  rmSync(join(repo, "docs/old.md"));
  write(repo, "notes/new.md", "# New\n");
  write(repo, ".env", "SECRET=1\n");
  write(repo, "dist/out.js", "built\n");
  write(repo, "assets/logo.bin", new Uint8Array([0x89, 0x50, 0x00, 0x01, 0x02]));
  git(repo, ["add", "assets/logo.bin"]);
  return repo;
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FilesBody {
  available: boolean;
  reason?: string;
  revision?: { kind: string; label: string };
  total?: number;
  live?: boolean;
  paths?: string[];
  lazy?: boolean;
  dir?: string;
  entries?: Array<{ name: string; path: string; type: string; files?: number }>;
  onDisk?: Record<string, string>;
}

for (const [runtime, startServer] of [
  ["Bun", startBunReviewServer],
  ["Pi", startPiReviewServer],
] as const) {
  describe(`All files (${runtime})`, () => {
    async function start(repo: string, diffType: string, extra: Record<string, unknown> = {}) {
      saveEnv("PLANNOTATOR_DATA_DIR");
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-repo-files-data-");
      if (runtime === "Pi") await reservePiPort();
      const gitContext = await getVcsContext(repo, "git");
      const diff = await runVcsDiff(diffType as never, "main", repo);
      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        diffType: diffType as never,
        gitContext,
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: MINIMAL_HTML,
        ...extra,
      });
      const payload = (await fetch(`${server.url}/api/diff`).then((r) => r.json())) as {
        snapshotId: string;
        repoFilesSupported?: boolean;
      };
      const snap = encodeURIComponent(payload.snapshotId);
      const files = async (query = "") => {
        const response = await fetch(`${server.url}/api/repo-files?snapshot=${snap}${query}`);
        return { status: response.status, body: (await response.json()) as FilesBody };
      };
      const file = async (path: string) => {
        const response = await fetch(`${server.url}/api/repo-file?snapshot=${snap}&path=${encodeURIComponent(path)}`);
        return { status: response.status, body: (await response.json()) as { content: string | null; reason?: string; revision?: { kind: string } } };
      };
      return { server, payload, files, file };
    }

    test("uncommitted: the working tree, .gitignore respected, deleted files gone, untracked files in", async () => {
      const repo = buildRepo();
      const { server, payload, files } = await start(repo, "uncommitted");
      try {
        expect(payload.repoFilesSupported).toBe(true);
        const { status, body } = await files();
        expect(status).toBe(200);
        expect(body.available).toBe(true);
        expect(body.revision).toEqual({ kind: "worktree", label: "working tree" });
        expect(body.live).toBe(true);
        expect(body.paths).toEqual([".gitignore", "README.md", "assets/logo.bin", "notes/new.md", "src/app.ts", "src/util.ts"]);
        expect(body.total).toBe(6);
      } finally {
        server.stop();
      }
    }, 30_000);

    test("reads any listed file as text and nothing the listing does not hold", async () => {
      const repo = buildRepo();
      const { server, file } = await start(repo, "uncommitted");
      try {
        const readme = await file("README.md");
        expect(readme.status).toBe(200);
        expect(readme.body.content).toBe("# Repo\n");
        expect(readme.body.revision?.kind).toBe("worktree");
        expect((await file("src/util.ts")).body.content).toBe("export const util = 'edited after the commit';\n");

        const binary = await file("assets/logo.bin");
        expect(binary.body).toMatchObject({ content: null, reason: "binary" });

        // Ignored and absent paths are never read.
        for (const path of [".env", "dist/out.js", "docs/old.md", "nope.ts"]) {
          const refused = await file(path);
          expect(refused.status).toBe(404);
          expect(refused.body.reason).toBe("not-listed");
        }
        for (const path of ["../outside.txt", "src/../.env", "/etc/hosts", "src//app.ts"]) {
          expect((await file(path)).status).toBe(400);
        }
      } finally {
        server.stop();
      }
    }, 30_000);

    test.skipIf(process.platform === "win32")("working-tree reads go through the repo-file guard: links followed, no FIFO hang, the cap", async () => {
      const repo = buildRepo();
      const outside = makeTempDir("plannotator-repo-files-outside-");
      writeFileSync(join(outside, "secret.txt"), "outside secret\n");
      const { server, files, file } = await start(repo, "uncommitted");
      try {
        // Untracked, so listed by `ls-files --others`: one link out, one in.
        symlinkSync(join(outside, "secret.txt"), join(repo, "src/leak.txt"));
        symlinkSync(join(repo, "README.md"), join(repo, "src/readme-link.md"));
        write(repo, "big.txt", "x".repeat(MAX_REPO_FILE_BYTES + 1));
        const listed = await files();
        expect(listed.body.paths).toEqual(expect.arrayContaining(["src/leak.txt", "src/readme-link.md", "big.txt", "src/util.ts"]));
        // A listed file swapped for a FIFO after the listing: reading it must not hang.
        rmSync(join(repo, "src/util.ts"));
        const fifo = spawnSync("mkfifo", [join(repo, "src/util.ts")]);
        expect(fifo.status).toBe(0);

        // Links are followed wherever they point, like VS Code (#2272).
        const followed = await file("src/leak.txt");
        expect(followed.status).toBe(200);
        expect(followed.body.content).toBe("outside secret\n");
        expect((await file("src/readme-link.md")).body.content).toBe("# Repo\n");
        expect((await file("src/util.ts")).body).toMatchObject({ content: null, reason: "unavailable" });
        expect((await file("big.txt")).body).toMatchObject({ content: null, reason: "too-large", size: MAX_REPO_FILE_BYTES + 1 });
      } finally {
        server.stop();
      }
    }, 30_000);

    test("a committed diff lists and reads that commit, never the working tree", async () => {
      const repo = buildRepo();
      const { server, files, file } = await start(repo, "last-commit");
      try {
        const { body } = await files();
        expect(body.revision?.kind).toBe("commit");
        expect(body.revision?.label).toBe(git(repo, ["rev-parse", "--short", "HEAD"]).trim());
        expect(body.live).toBe(false);
        // The commit still holds docs/old.md; it never held notes/new.md.
        expect(body.paths).toEqual([".gitignore", "README.md", "docs/old.md", "src/app.ts", "src/util.ts"]);
        expect((await file("src/util.ts")).body.content).toBe("export const util = 'working tree';\n");
        expect((await file("notes/new.md")).status).toBe(404);
      } finally {
        server.stop();
      }
    }, 30_000);

    test("a staged diff lists the index", async () => {
      const repo = buildRepo();
      const { server, files, file } = await start(repo, "staged");
      try {
        const { body } = await files();
        expect(body.revision).toEqual({ kind: "index", label: "index" });
        expect(body.paths).toContain("assets/logo.bin");
        expect(body.paths).not.toContain("notes/new.md");
        expect((await file("src/util.ts")).body.content).toBe("export const util = 'working tree';\n");
      } finally {
        server.stop();
      }
    }, 30_000);

    test("past the threshold the list is served one folder at a time", async () => {
      const repo = buildRepo();
      const { server, files } = await start(repo, "uncommitted", { repoFilesLazyThreshold: 3 });
      try {
        const root = await files();
        expect(root.body.lazy).toBe(true);
        expect(root.body.paths).toBeUndefined();
        expect(root.body.total).toBe(6);
        expect(root.body.entries).toEqual([
          { name: "assets", path: "assets", type: "dir", files: 1 },
          { name: "notes", path: "notes", type: "dir", files: 1 },
          { name: "src", path: "src", type: "dir", files: 2 },
          { name: ".gitignore", path: ".gitignore", type: "file" },
          { name: "README.md", path: "README.md", type: "file" },
        ]);
        const src = await files("&dir=src");
        expect(src.body.dir).toBe("src");
        expect(src.body.entries?.map((entry) => entry.path)).toEqual(["src/app.ts", "src/util.ts"]);
        expect((await files("&dir=../x")).status).toBe(400);
      } finally {
        server.stop();
      }
    }, 30_000);

    test("Go to File searches the listing on the server: listed paths only, best first", async () => {
      const repo = buildRepo();
      const { server, payload } = await start(repo, "uncommitted", { repoFilesLazyThreshold: 3 });
      try {
        const snap = encodeURIComponent(payload.snapshotId);
        const search = async (q: string, extra = "") => {
          const response = await fetch(`${server.url}/api/repo-files/search?snapshot=${snap}&q=${encodeURIComponent(q)}${extra}`);
          return { status: response.status, body: (await response.json()) as { total: number; matches: Array<{ path: string; positions: number[] }> } };
        };
        const util = await search("utl");
        expect(util.status).toBe(200);
        expect(util.body.total).toBe(6);
        expect(util.body.matches[0]?.path).toBe("src/util.ts");
        expect(util.body.matches[0]?.positions).toEqual([4, 5, 7]);
        // Ignored (.env, dist/) and deleted (docs/old.md) files are not in the listing, so never found.
        expect((await search("env")).body.matches).toEqual([]);
        expect((await search("out")).body.matches).toEqual([]);
        expect((await search("md")).body.matches.map((m) => m.path).sort()).toEqual(["README.md", "notes/new.md"]);
        expect((await search("s", "&limit=1")).body.matches).toHaveLength(1);
        expect((await fetch(`${server.url}/api/repo-files/search?q=a`)).status).toBe(400);
        expect((await fetch(`${server.url}/api/repo-files/search?snapshot=old&q=a`)).status).toBe(409);
      } finally {
        server.stop();
      }
    }, 30_000);

    test("refuses a stale or missing snapshot", async () => {
      const repo = buildRepo();
      const { server } = await start(repo, "uncommitted");
      try {
        expect((await fetch(`${server.url}/api/repo-files`)).status).toBe(400);
        expect((await fetch(`${server.url}/api/repo-files?snapshot=old`)).status).toBe(409);
        expect((await fetch(`${server.url}/api/repo-file?snapshot=old&path=README.md`)).status).toBe(409);
      } finally {
        server.stop();
      }
    }, 30_000);

    async function openStream(server: { url: string }, snapshotId: string) {
      const stream = await fetch(`${server.url}/api/repo-files/stream?snapshot=${encodeURIComponent(snapshotId)}`);
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      const pump = (async () => {
        for (;;) {
          const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
          if (chunk.done) return;
          seen += decoder.decode(chunk.value);
        }
      })();
      const waitFor = async (needle: string, ms: number) => {
        const deadline = Date.now() + ms;
        while (!seen.includes(needle)) {
          if (Date.now() > deadline) throw new Error(`no ${needle} event; got ${seen}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      const count = (needle: string) => seen.split(needle).length - 1;
      const close = async () => {
        await reader.cancel().catch(() => {});
        await pump;
      };
      return { waitFor, count, close };
    }

    test("files changed on disk after the diff was taken are reported; the live stream says when", async () => {
      const repo = buildRepo();
      const { server, files, payload } = await start(repo, "uncommitted");
      try {
        expect((await files()).body.onDisk).toBeUndefined();
        const live = await openStream(server, payload.snapshotId);
        await live.waitFor('"type":"ready"', 5_000);
        // Let the deferred watcher start before writing.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        write(repo, "src/app.ts", "export const app = 3;\n");
        write(repo, "src/fresh.ts", "export const fresh = true;\n");
        await live.waitFor('"type":"changed"', 15_000);
        await live.close();

        const after = await files();
        expect(after.body.paths).toContain("src/fresh.ts");
        expect(after.body.onDisk).toEqual({ "src/app.ts": "M", "src/fresh.ts": "A" });
      } finally {
        server.stop();
      }
    }, 40_000);

    // A page's EventSource.close() closes the connection; destroying a node
    // request does the same (cancelling a fetch body does not, on either server).
    function openPageStream(server: { url: string }, snapshotId: string) {
      return new Promise<() => void>((resolve, reject) => {
        const req = request(`${server.url}/api/repo-files/stream?snapshot=${encodeURIComponent(snapshotId)}`, (res) => {
          if (res.statusCode !== 200) return reject(new Error(`stream answered ${res.statusCode}`));
          res.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes('"type":"ready"')) resolve(() => req.destroy());
          });
        });
        req.on("error", () => {});
        req.end();
      });
    }

    test("a tree shown again lists what changed while no page watched", async () => {
      const repo = buildRepo();
      const { server, files, payload } = await start(repo, "uncommitted");
      try {
        expect((await files()).body.paths).not.toContain("later.md");
        // The tree is shown (a stream opens), then hidden (it closes).
        const close = await openPageStream(server, payload.snapshotId);
        close();
        // Let the server see the page go before anything changes.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        write(repo, "later.md", "# later\n");
        // Shown again: nothing watched the disk meanwhile, yet the list is current.
        expect((await files()).body.paths).toContain("later.md");
      } finally {
        server.stop();
      }
    }, 30_000);

    test("a build writing gitignored output never tells the page to list again", async () => {
      const repo = buildRepo();
      // target/ is ignored but does not exist yet when watching begins: the
      // watcher sees it, the change gate does not count it.
      write(repo, ".git/info/exclude", "target/\n");
      const { server, payload } = await start(repo, "uncommitted");
      try {
        const live = await openStream(server, payload.snapshotId);
        await live.waitFor('"type":"ready"', 5_000);
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        for (let i = 0; i < 5; i += 1) write(repo, `dist/out-${i}.js`, `built ${i}\n`);
        for (let i = 0; i < 5; i += 1) write(repo, `target/debug/obj-${i}.o`, `obj ${i}\n`);
        write(repo, ".env", "SECRET=2\n");
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(live.count('"type":"changed"')).toBe(0);
        // A real change still arrives.
        write(repo, "src/real.ts", "export const real = 1;\n");
        await live.waitFor('"type":"changed"', 15_000);
        await live.close();
      } finally {
        server.stop();
      }
    }, 40_000);

    test("past the large-repo threshold the listing is polled, not watched", async () => {
      const repo = buildRepo();
      const { server, payload, files } = await start(repo, "uncommitted", { repoFilesLazyThreshold: 3, repoLivePollMs: 300 });
      try {
        const live = await openStream(server, payload.snapshotId);
        await live.waitFor('"type":"ready"', 5_000);
        await new Promise((resolve) => setTimeout(resolve, 700));
        write(repo, "notes/polled.md", "# Polled\n");
        await live.waitFor('"type":"changed"', 10_000);
        await live.close();
        const root = await files();
        expect(root.body.total).toBe(7);
      } finally {
        server.stop();
      }
    }, 40_000);

    test("on-disk marks ride only the root request; the stream needs the current snapshot", async () => {
      const repo = buildRepo();
      const { server, files, payload } = await start(repo, "uncommitted", { repoFilesLazyThreshold: 3 });
      try {
        write(repo, "src/app.ts", "export const app = 9;\n");
        // The listing (and so the on-disk marks) is per snapshot generation:
        // force a new one through the stream's change path is not needed here,
        // the first listing already sees the edit after the snapshot.
        const root = await files();
        expect(root.body.onDisk).toEqual({ "src/app.ts": "M" });
        const folder = await files("&dir=src");
        expect(folder.body.onDisk).toBeUndefined();
        expect((await fetch(`${server.url}/api/repo-files/stream`)).status).toBe(400);
        expect((await fetch(`${server.url}/api/repo-files/stream?snapshot=old`)).status).toBe(409);
        void payload;
      } finally {
        server.stop();
      }
    }, 30_000);

    test("a committed listing has no live stream", async () => {
      const repo = buildRepo();
      const { server, payload } = await start(repo, "last-commit");
      try {
        const response = await fetch(`${server.url}/api/repo-files/stream?snapshot=${encodeURIComponent(payload.snapshotId)}`);
        expect(response.status).toBe(400);
        expect(((await response.json()) as { reason: string }).reason).toBe("not-live");
      } finally {
        server.stop();
      }
    }, 30_000);

    test("a static patch session advertises no All files and lists nothing", async () => {
      saveEnv("PLANNOTATOR_DATA_DIR");
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-repo-files-data-");
      if (runtime === "Pi") await reservePiPort();
      const server = await startServer({
        rawPatch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
        gitRef: "reading.diff",
        diffType: "static-patch",
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: MINIMAL_HTML,
      });
      try {
        const payload = (await fetch(`${server.url}/api/diff`).then((r) => r.json())) as {
          snapshotId: string;
          repoFilesSupported?: boolean;
        };
        expect(payload.repoFilesSupported).toBe(false);
        const listed = (await fetch(`${server.url}/api/repo-files?snapshot=${encodeURIComponent(payload.snapshotId)}`).then((r) => r.json())) as FilesBody;
        expect(listed).toMatchObject({ available: false, reason: "static-patch" });
        expect((await fetch(`${server.url}/api/repo-file?snapshot=${encodeURIComponent(payload.snapshotId)}&path=a.ts`)).status).toBe(400);
      } finally {
        server.stop();
      }
    }, 30_000);
  });
}

// jj lists the new side's revision through `jj file list` (the same shared
// provider code both runtimes vendor), so one runtime is enough here.
describe("All files in a jj workspace", () => {
  const hasJj = Bun.which("jj") !== null;
  test.skipIf(!hasJj)("jj-current lists @, jj-last lists @-", async () => {
    const { listVcsFiles } = await import("./vcs");
    const repo = makeTempDir("plannotator-repo-files-jj-");
    const jj = (args: string[]) => {
      const result = spawnSync("jj", args, { cwd: repo, encoding: "utf-8", env: { ...process.env, JJ_CONFIG: "" } });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    };
    jj(["git", "init"]);
    jj(["config", "set", "--repo", "user.name", "Test"]);
    jj(["config", "set", "--repo", "user.email", "test@example.com"]);
    write(repo, "a.ts", "a\n");
    write(repo, "dir/b c.ts", "b\n");
    jj(["commit", "-m", "first"]);
    write(repo, "later.ts", "later\n");
    const current = await listVcsFiles("jj-current", "", repo);
    expect(current?.paths).toEqual(["a.ts", "dir/b c.ts", "later.ts"]);
    expect(current?.live).toBe(false);
    const last = await listVcsFiles("jj-last", "", repo);
    expect(last?.paths).toEqual(["a.ts", "dir/b c.ts"]);
  }, 30_000);
});
