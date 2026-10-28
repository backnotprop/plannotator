/**
 * Working-tree reads behind two review endpoints, dual-runtime (Bun + Pi),
 * both guarded by packages/shared/repo-file.ts.
 *
 * GET /api/code-nav/file (code-navigation preview) reads only regular files
 * whose realpath stays inside the review root, and refuses a file over the
 * 5 MB cap with `reason: "too-large"`. Before the fix both servers joined
 * `${cwd}/${path}` after a string check, so a symlink in the repo (to
 * /etc/hosts, or a directory pointing out) served the file outside it, an
 * oversized file was read whole, and a FIFO hung the request.
 *
 * GET /api/file-content (diff context expansion) checked only the final path
 * component with lstat, so a path through a symlinked directory pointing out
 * of the repo was read. The old side always comes from git, never the
 * working tree.
 *
 * Text output must not change for anyone: Bun used `Bun.file().text()` (a
 * BOM is stripped, a UTF-16LE BOM decodes as UTF-16) and Pi used
 * `readFileSync(path, "utf-8")` (a BOM stays). The guard reads from a
 * descriptor, so each runtime passes its own decoder; the BOM tests compare
 * each runtime's answer with what its old reader returns for the same file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { MAX_REPO_FILE_BYTES } from "@plannotator/shared/repo-file";
import { readDiffSideText, type ReviewGitRuntime } from "@plannotator/shared/review-core";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";
import { piCodeNavRuntime } from "../../apps/pi-extension/server/serverReview";
import { reviewRuntime as piGitRuntime } from "../../apps/pi-extension/server/vcs";
import { bunCodeNavRuntime } from "./code-nav";
import { runtime as bunGitRuntime } from "./git";
import { getVcsContext } from "./vcs";
import { buildLocalWorkspaceReview as buildBunWorkspaceReview } from "./review-workspace";
import * as piVcs from "../../apps/pi-extension/server/vcs";
import { WorkspaceReviewSession as PiWorkspaceReviewSession } from "../../apps/pi-extension/generated/review-workspace";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+export const app = 1;\n";

/** UTF-8 BOM + "hi\n", and UTF-16LE BOM + "hi". */
const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]);
const UTF16LE_BOM_BYTES = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);

/** The reader each runtime used before the guard: its output must not change. */
async function oldReader(runtime: "Bun" | "Pi", path: string): Promise<string> {
  return runtime === "Bun" ? Bun.file(path).text() : readFileSync(path, "utf-8");
}

const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}
function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function reservePiPort(): Promise<void> {
  setEnv("PLANNOTATOR_PORT", String(await freePort()));
}

/** A blocked child is killed here; the test's own timeout sits above it. */
const CHILD_TIMEOUT_MS = 15_000;
const CHILD_TEST_TIMEOUT_MS = 30_000;

/**
 * Run `source` in a child Bun process and return the JSON it prints last.
 * Pi's server shares the event loop of whatever runs it, and a FIFO read
 * with readFileSync blocks that loop for good: in this process it would hang
 * the whole `bun test` run. In a child it is killed and the test fails.
 */
function runInChild(source: string, env: Record<string, string> = {}): unknown {
  const child = spawnSync(process.execPath, ["--eval", source], {
    encoding: "utf-8",
    timeout: CHILD_TIMEOUT_MS,
    env: {
      ...process.env,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_INBOX_CONNECT: "0",
      ...env,
    },
  });
  if (child.signal || child.error) {
    throw new Error(`child did not finish (blocked on a read?): ${child.signal ?? child.error}`);
  }
  if (child.status !== 0) throw new Error(`child failed: ${child.stderr}`);
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null");
}

const BUN_SERVER_MODULE = join(import.meta.dir, "review.ts");
const PI_SERVER_MODULE = join(import.meta.dir, "../../apps/pi-extension/server.ts");

// Symlinks and FIFOs: POSIX only.
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("GET /api/code-nav/file guards", () => {
  let base = "";
  let repo = "";

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "pn-code-nav-file-")));
    repo = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
    symlinkSync("/etc/hosts", join(repo, "hosts"));
    symlinkSync(outside, join(repo, "escape-dir"));
    writeFileSync(join(repo, "big.txt"), Buffer.alloc(MAX_REPO_FILE_BYTES + 1, 0x61));
    writeFileSync(join(repo, "bom.txt"), UTF8_BOM_BYTES);
    writeFileSync(join(repo, "utf16.txt"), UTF16LE_BOM_BYTES);
    expect(spawnSync("mkfifo", [join(repo, "pipe")]).status).toBe(0);
  });

  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  for (const [runtime, startServer] of [
    ["Bun", startBunReviewServer],
    ["Pi", startPiReviewServer],
  ] as const) {
    describe(runtime, () => {
      let server: { url: string; stop: () => void } | null = null;

      beforeAll(async () => {
        setEnv("PLANNOTATOR_DATA_DIR", join(base, `data-${runtime}`));
        setEnv("PLANNOTATOR_BROWSER", NO_BROWSER);
        setEnv("PLANNOTATOR_UPDATE_CHECK", "0");
        setEnv("PLANNOTATOR_INBOX_CONNECT", "0");
        if (runtime === "Pi") await reservePiPort();
        server = await startServer({
          rawPatch: PATCH,
          gitRef: "HEAD",
          agentCwd: repo,
          origin: runtime === "Pi" ? "pi" : "claude-code",
          htmlContent: MINIMAL_HTML,
        });
      });

      afterAll(() => {
        server?.stop();
        server = null;
        restoreEnv();
      });

      const get = async (path: string) => {
        const res = await fetch(`${server!.url}/api/code-nav/file?path=${encodeURIComponent(path)}`, {
          signal: AbortSignal.timeout(5000),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };

      test("serves a file inside the repo", async () => {
        const ok = await get("src/app.ts");
        expect(ok.status).toBe(200);
        expect(ok.body.content).toBe("export const app = 1;\n");
      });

      test("refuses a symlink to /etc/hosts", async () => {
        const hosts = await get("hosts");
        expect(hosts.status).toBe(403);
        expect(hosts.body.reason).toBe("outside-root");
        expect(hosts.body.content).toBeUndefined();
      });

      test("refuses a path through a symlinked directory that leaves the repo", async () => {
        const escapeDir = await get("escape-dir/secret.txt");
        expect(escapeDir.status).toBe(403);
        expect(JSON.stringify(escapeDir.body)).not.toContain("TOP SECRET");
      });

      test("refuses .. traversal and absolute paths", async () => {
        for (const path of ["../outside/secret.txt", "/etc/hosts"]) {
          const refused = await get(path);
          expect(refused.status).toBe(400);
          expect(refused.body.reason).toBe("invalid-path");
        }
      });

      test("refuses a file over the cap with reason too-large", async () => {
        const big = await get("big.txt");
        expect(big.status).toBe(413);
        expect(big.body.reason).toBe("too-large");
        expect(big.body.size).toBe(MAX_REPO_FILE_BYTES + 1);
        expect(big.body.maxBytes).toBe(MAX_REPO_FILE_BYTES);
      });

      test("decodes a BOM file exactly as this runtime's old reader did (preview and hover)", async () => {
        const codeNav = runtime === "Bun" ? bunCodeNavRuntime : piCodeNavRuntime;
        for (const name of ["bom.txt", "utf16.txt"]) {
          const expected = await oldReader(runtime, join(repo, name));
          const preview = await get(name);
          expect(preview.status).toBe(200);
          expect(preview.body.content).toBe(expected);
          // The hover reads the definition file through the same guard.
          expect(await codeNav.readFile!(name, { cwd: repo })).toBe(expected);
        }
        // Bun strips the BOM, Pi keeps it: the two runtimes differ on purpose.
        const bomPreview = (await get("bom.txt")).body.content as string;
        expect(bomPreview.charCodeAt(0)).toBe(runtime === "Bun" ? 0x68 : 0xfeff);
      });
    });
  }

  for (const runtime of ["Bun", "Pi"] as const) {
    test(`${runtime}: refuses a FIFO instead of hanging on it`, async () => {
      // Before the fix the server opened the FIFO and waited for a writer. On
      // Pi that blocks the event loop, so the server runs in a child process:
      // a regression fails here instead of hanging the test run.
      const port = runtime === "Pi" ? await freePort() : 0;
      const result = runInChild(
        `
        const { startReviewServer } = await import(${JSON.stringify(runtime === "Pi" ? PI_SERVER_MODULE : BUN_SERVER_MODULE)});
        const server = await startReviewServer({
          rawPatch: ${JSON.stringify(PATCH)},
          gitRef: "HEAD",
          agentCwd: ${JSON.stringify(repo)},
          origin: ${JSON.stringify(runtime === "Pi" ? "pi" : "claude-code")},
          htmlContent: "<html></html>",
        });
        const res = await fetch(server.url + "/api/code-nav/file?path=pipe");
        console.log(JSON.stringify({ status: res.status, body: await res.json() }));
        server.stop();
        process.exit(0);
        `,
        {
          PLANNOTATOR_DATA_DIR: join(base, `data-fifo-${runtime}`),
          ...(runtime === "Pi" && { PLANNOTATOR_PORT: String(port) }),
        },
      );
      expect(result).toMatchObject({ status: 400, body: { reason: "not-a-file" } });
    }, CHILD_TEST_TIMEOUT_MS);
  }
});

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

describePosix("GET /api/file-content guards", () => {
  let base = "";
  let repo = "";

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "pn-file-content-")));
    repo = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "lib"));
    mkdirSync(join(repo, "sub"));
    mkdirSync(outside);
    writeFileSync(join(repo, "src", "app.ts"), "v1\n");
    writeFileSync(join(repo, "lib", "util.ts"), "committed util\n");
    writeFileSync(join(repo, "bom.txt"), "old\n");
    writeFileSync(join(repo, "utf16.txt"), "old\n");
    writeFileSync(join(repo, "sub", "f.txt"), "committed f\n");
    runGit(repo, ["init", "-q"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "Test"]);
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-q", "-m", "initial"]);

    writeFileSync(join(repo, "src", "app.ts"), "v2\n");
    writeFileSync(join(repo, "bom.txt"), UTF8_BOM_BYTES);
    writeFileSync(join(repo, "utf16.txt"), UTF16LE_BOM_BYTES);
    // lib/ becomes a symlink to a directory outside the repo that holds a
    // same-named file.
    writeFileSync(join(outside, "util.ts"), "TOP SECRET\n");
    writeFileSync(join(outside, "f.txt"), "TOP SECRET\n");
    rmSync(join(repo, "lib"), { recursive: true });
    symlinkSync(outside, join(repo, "lib"));
    // evil -> outside: swapped in for sub/ during a read below.
    symlinkSync(outside, join(repo, "evil"));
    expect(spawnSync("mkfifo", [join(repo, "pipe")]).status).toBe(0);
  });

  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  for (const [runtime, startServer] of [
    ["Bun", startBunReviewServer],
    ["Pi", startPiReviewServer],
  ] as const) {
    describe(runtime, () => {
      let server: { url: string; stop: () => void } | null = null;

      beforeAll(async () => {
        setEnv("PLANNOTATOR_DATA_DIR", join(base, `data-${runtime}`));
        setEnv("PLANNOTATOR_BROWSER", NO_BROWSER);
        setEnv("PLANNOTATOR_UPDATE_CHECK", "0");
        setEnv("PLANNOTATOR_INBOX_CONNECT", "0");
        if (runtime === "Pi") await reservePiPort();
        const gitContext = await getVcsContext(repo, "git");
        server = await startServer({
          rawPatch: PATCH,
          gitRef: "Working tree",
          diffType: "uncommitted",
          gitContext,
          origin: runtime === "Pi" ? "pi" : "claude-code",
          htmlContent: MINIMAL_HTML,
        });
      });

      afterAll(() => {
        server?.stop();
        server = null;
        restoreEnv();
      });

      const get = async (path: string) => {
        const res = await fetch(`${server!.url}/api/file-content?path=${encodeURIComponent(path)}`, {
          signal: AbortSignal.timeout(5000),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };

      test("expands a modified file: old side from git, new side from the working tree", async () => {
        const result = await get("src/app.ts");
        expect(result.status).toBe(200);
        expect(result.body).toEqual({ oldContent: "v1\n", newContent: "v2\n" });
      });

      test("refuses the working-tree side through a symlinked directory, and still serves the old side from git", async () => {
        const result = await get("lib/util.ts");
        expect(result.status).toBe(200);
        // The old side is `git show HEAD:lib/util.ts`, which never touches
        // the filesystem, so the symlinked lib/ cannot change it.
        expect(result.body.oldContent).toBe("committed util\n");
        expect(result.body.newContent).toBeNull();
        expect(JSON.stringify(result.body)).not.toContain("TOP SECRET");
      });

      test("answers for a FIFO without reading it", async () => {
        const result = await get("pipe");
        expect(result.status).toBe(200);
        expect(result.body).toEqual({ oldContent: null, newContent: null });
      });

      test("decodes a BOM file exactly as this runtime's old reader did", async () => {
        for (const name of ["bom.txt", "utf16.txt"]) {
          const result = await get(name);
          expect(result.status).toBe(200);
          expect(result.body.newContent).toBe(await oldReader(runtime, join(repo, name)));
        }
      });
    });
  }

  // The swaps below must land between the check and the read, which HTTP
  // cannot time, so they call readDiffSideText (what /api/file-content runs)
  // with each server's own runtime and the read's test hooks.
  for (const [runtime, gitRuntime, module] of [
    ["Bun", bunGitRuntime, join(import.meta.dir, "git.ts")],
    ["Pi", piGitRuntime, join(import.meta.dir, "../../apps/pi-extension/server/vcs.ts")],
  ] as const) {
    test(`${runtime}: a directory swapped for an outside symlink during the read is refused`, async () => {
      let swapped = false;
      const swapBack = () => {
        if (!swapped) return;
        renameSync(join(repo, "sub"), join(repo, "evil"));
        renameSync(join(repo, "sub-real"), join(repo, "sub"));
        swapped = false;
      };
      const hooked: ReviewGitRuntime = {
        ...gitRuntime,
        readWorkingTreeEntry: (root, path, options) =>
          gitRuntime.readWorkingTreeEntry!(root, path, {
            ...options,
            hooks: {
              // Swapped after the realpath check, before the directory stamps
              // and the open: an open by path would follow `sub` outside.
              afterCheck() {
                renameSync(join(repo, "sub"), join(repo, "sub-real"));
                renameSync(join(repo, "evil"), join(repo, "sub"));
                swapped = true;
              },
              // Undone right after the open, so a path check after it sees
              // the inside tree again; the directory stamps or the kernel's
              // path for the descriptor must still refuse.
              afterOpen: swapBack,
            },
          }),
      };
      try {
        expect(await readDiffSideText(hooked, { kind: "worktree", path: "sub/f.txt" }, repo)).toBeNull();
      } finally {
        swapBack();
      }
      // Unhooked, the same read succeeds.
      expect(await readDiffSideText(gitRuntime, { kind: "worktree", path: "sub/f.txt" }, repo)).toBe("committed f\n");
    });

    test(`${runtime}: a FIFO swapped in after the check is refused without blocking`, () => {
      // Reopening the checked path (the reader before this fix) waits for a
      // FIFO writer forever, and on Pi it blocks the event loop: run it in a
      // child so a regression fails instead of hanging the test run.
      const swapped = join(repo, `becomes-fifo-${runtime}.txt`);
      writeFileSync(swapped, "regular\n");
      try {
        const result = runInChild(`
          const { rmSync } = await import("node:fs");
          const { spawnSync } = await import("node:child_process");
          const { readDiffSideText } = await import(${JSON.stringify(join(import.meta.dir, "../shared/review-core.ts"))});
          const mod = await import(${JSON.stringify(module)});
          const runtime = mod.runtime ?? mod.reviewRuntime;
          let swaps = 0;
          const hooked = {
            ...runtime,
            readWorkingTreeEntry: (root, path, options) => runtime.readWorkingTreeEntry(root, path, {
              ...options,
              hooks: { beforeOpen() { rmSync(${JSON.stringify(swapped)}); spawnSync("mkfifo", [${JSON.stringify(swapped)}]); swaps++; } },
            }),
          };
          const text = await readDiffSideText(hooked, { kind: "worktree", path: ${JSON.stringify(`becomes-fifo-${runtime}.txt`)} }, ${JSON.stringify(repo)});
          console.log(JSON.stringify({ swaps, text }));
          process.exit(0);
        `);
        expect(result).toEqual({ swaps: 1, text: null });
      } finally {
        rmSync(swapped, { force: true });
      }
    }, CHILD_TEST_TIMEOUT_MS);
  }
});

/**
 * A reviewed folder replaced while the review runs. Someone who can write the
 * folder's parent (a worktree under `.claude/worktrees`, a repo in /tmp)
 * renames the repo away and puts something else at its path. Each server
 * pins its folders when it starts (repo-root-pins.ts). Before the pins, every
 * read resolved the path again and served the replacement's files; before
 * the command gate, git ran in the replacement and served its history
 * (`git show HEAD:path` for the old side, the raw patch on a diff switch).
 */
describePosix("a reviewed folder replaced during the review", () => {
  const APP_PATCH =
    "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-v1\n+v2 inside\n";
  const RUNTIMES = [
    ["Bun", startBunReviewServer],
    ["Pi", startPiReviewServer],
  ] as const;
  type Server = { url: string; stop: () => void };

  function initRepo(dir: string): void {
    runGit(dir, ["init", "-q"]);
    runGit(dir, ["config", "user.email", "test@example.com"]);
    runGit(dir, ["config", "user.name", "Test"]);
    runGit(dir, ["add", "."]);
    runGit(dir, ["commit", "-q", "-m", "initial"]);
  }

  /** A repo whose HEAD has `committed` in src/app.ts and whose working tree has `working`. */
  function makeRepo(dir: string, committed: string, working: string): void {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), committed);
    initRepo(dir);
    writeFileSync(join(dir, "src", "app.ts"), working);
  }

  /** Another repo: secrets in its history, its working tree and an untracked file. */
  function makeSecretRepo(dir: string): void {
    makeRepo(dir, "TOP SECRET committed\n", "TOP SECRET working\n");
    writeFileSync(join(dir, "src", "untracked.ts"), "export const SECRET_SYMBOL = \"TOP SECRET untracked\";\n");
  }

  async function sandbox(runtime: "Bun" | "Pi", base: string): Promise<void> {
    setEnv("PLANNOTATOR_DATA_DIR", join(base, "data"));
    setEnv("PLANNOTATOR_BROWSER", NO_BROWSER);
    setEnv("PLANNOTATOR_UPDATE_CHECK", "0");
    setEnv("PLANNOTATOR_INBOX_CONNECT", "0");
    if (runtime === "Pi") await reservePiPort();
  }

  async function startOn(
    runtime: "Bun" | "Pi",
    startServer: (typeof RUNTIMES)[number][1],
    repo: string,
  ): Promise<Server> {
    if (runtime === "Pi") await reservePiPort();
    return startServer({
      rawPatch: APP_PATCH,
      gitRef: "Working tree",
      diffType: "uncommitted",
      gitContext: await getVcsContext(repo, "git"),
      agentCwd: repo,
      origin: runtime === "Pi" ? "pi" : "claude-code",
      htmlContent: MINIMAL_HTML,
    });
  }

  const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(10_000) });

  async function probe(url: string, path: string) {
    const nav = await get(`${url}/api/code-nav/file?path=${encodeURIComponent(path)}`);
    const content = await get(`${url}/api/file-content?path=${encodeURIComponent(path)}`);
    return {
      navStatus: nav.status,
      nav: await nav.text(),
      content: (await content.json()) as { oldContent: string | null; newContent: string | null },
    };
  }

  async function switchDiff(url: string, diffType: string): Promise<string> {
    const response = await fetch(`${url}/api/diff/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diffType }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.text();
  }

  const replacements = [
    [
      "for a symlink to another repository",
      (base: string, repo: string) => {
        renameSync(repo, join(base, "repo.moved"));
        symlinkSync(join(base, "other"), repo);
      },
    ],
    [
      "by another repository moved into its place",
      (base: string, repo: string) => {
        renameSync(repo, join(base, "repo.moved"));
        renameSync(join(base, "other"), repo);
      },
    ],
  ] as const;

  for (const [runtime, startServer] of RUNTIMES) {
    for (const [how, replace] of replacements) {
      test(`${runtime}: a root swapped ${how} is refused by the readers and by git`, async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "pn-root-swap-")));
        const repo = join(base, "repo");
        makeRepo(repo, "v1\n", "v2 inside\n");
        makeSecretRepo(join(base, "other"));
        let server: Server | null = null;
        try {
          await sandbox(runtime, base);
          server = await startOn(runtime, startServer, repo);

          const before = await probe(server.url, "src/app.ts");
          expect(before.navStatus).toBe(200);
          expect(before.nav).toContain("v2 inside");
          expect(before.content).toMatchObject({ oldContent: "v1\n", newContent: "v2 inside\n" });

          replace(base, repo);
          // The replacement really is what the root path now holds.
          expect(readFileSync(join(repo, "src", "app.ts"), "utf-8")).toBe("TOP SECRET working\n");

          const after = await probe(server.url, "src/app.ts");
          expect(after.navStatus).toBe(409);
          expect(JSON.parse(after.nav)).toMatchObject({ reason: "root-replaced" });
          // Old side from git, new side from the working tree: neither reads the replacement.
          expect(after.content).toMatchObject({ oldContent: null, newContent: null });
          // Nor does a code-navigation search (rg or git grep in the root).
          const search = await fetch(`${server.url}/api/code-nav/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbol: "SECRET_SYMBOL", filePath: "src/app.ts", side: "new" }),
            signal: AbortSignal.timeout(10_000),
          });
          const found = await search.text();
          expect(found).not.toContain("TOP SECRET");
          expect(found).not.toContain("untracked.ts");
          const switched = await switchDiff(server.url, "uncommitted");
          expect(switched).not.toContain("TOP SECRET");
          expect(JSON.stringify(after)).not.toContain("TOP SECRET");
        } finally {
          server?.stop();
          restoreEnv();
          rmSync(base, { recursive: true, force: true });
        }
      });
    }

    test(`${runtime}: a git repository above the reviewed one is never read, even when the reviewed repo loses its .git`, async () => {
      // The reviewed repo sits inside another repo (like .claude/worktrees/x
      // inside the main checkout). With its .git gone, git run in it finds
      // the repo above; rev-parse then names that repo as the toplevel.
      const base = realpathSync(mkdtempSync(join(tmpdir(), "pn-root-above-")));
      const parent = join(base, "P");
      const repo = join(parent, "wt", "x");
      mkdirSync(parent, { recursive: true });
      writeFileSync(join(parent, "secret.txt"), "TOP SECRET committed\n");
      writeFileSync(join(parent, ".gitignore"), "wt/\n");
      initRepo(parent);
      writeFileSync(join(parent, "secret.txt"), "TOP SECRET working\n");
      makeRepo(repo, "v1\n", "v2 inside\n");
      let server: Server | null = null;
      try {
        await sandbox(runtime, base);
        server = await startOn(runtime, startServer, repo);
        expect((await probe(server.url, "src/app.ts")).content.newContent).toBe("v2 inside\n");

        renameSync(join(repo, ".git"), join(base, "x.git.moved"));
        const after = await probe(server.url, "secret.txt");
        expect(JSON.stringify(after)).not.toContain("TOP SECRET");
        expect(await switchDiff(server.url, "uncommitted")).not.toContain("TOP SECRET");
      } finally {
        server?.stop();
        restoreEnv();
        rmSync(base, { recursive: true, force: true });
      }
    });

    test(`${runtime}: each review keeps its own pins: a new review of a recreated folder reads it, the old one refuses`, async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "pn-root-sessions-")));
      const repo = join(base, "repo");
      makeRepo(repo, "v1\n", "v2 inside\n");
      makeRepo(join(base, "other"), "v1\n", "v3 recreated\n");
      let first: Server | null = null;
      let second: Server | null = null;
      try {
        await sandbox(runtime, base);
        first = await startOn(runtime, startServer, repo);
        renameSync(repo, join(base, "repo.moved"));
        renameSync(join(base, "other"), repo);
        second = await startOn(runtime, startServer, repo);

        const fresh = await probe(second.url, "src/app.ts");
        expect(fresh.navStatus).toBe(200);
        expect(fresh.content.newContent).toBe("v3 recreated\n");
        const stale = await probe(first.url, "src/app.ts");
        expect(stale.navStatus).toBe(409);
        expect(stale.content.newContent).toBeNull();
        // Stopping the old review leaves the new one's pins alone.
        first.stop();
        first = null;
        expect((await probe(second.url, "src/app.ts")).navStatus).toBe(200);
      } finally {
        first?.stop();
        second?.stop();
        restoreEnv();
        rmSync(base, { recursive: true, force: true });
      }
    });

    test(`${runtime}: every workspace member is pinned when the review starts, before any read`, async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "pn-root-workspace-")));
      const root = join(base, "ws");
      makeRepo(join(root, "api"), "v1\n", "v2 api\n");
      makeRepo(join(root, "web"), "v1\n", "v2 web\n");
      makeSecretRepo(join(base, "other"));
      let server: Server | null = null;
      try {
        await sandbox(runtime, base);
        const workspace = runtime === "Bun"
          ? await buildBunWorkspaceReview(root)
          : await PiWorkspaceReviewSession.create({
            getVcsContext: piVcs.getVcsContext,
            runVcsDiff: piVcs.runVcsDiff,
            getVcsFileContentsForDiff: piVcs.getVcsFileContentsForDiff,
            getVcsFileBytesForDiff: piVcs.getVcsFileBytesForDiff,
            getVcsDiffFingerprint: piVcs.getVcsDiffFingerprint,
            canStageFiles: piVcs.canStageFiles,
            stageFile: piVcs.stageFile,
            unstageFile: piVcs.unstageFile,
          }, root);
        server = await (startServer as (options: Record<string, unknown>) => Promise<Server>)({
          rawPatch: workspace.rawPatch,
          gitRef: workspace.gitRef,
          origin: runtime === "Pi" ? "pi" : "claude-code",
          workspace,
          agentCwd: workspace.root,
          htmlContent: MINIMAL_HTML,
        });
        // The routes serve members (only `web` is read before the swap).
        expect((await probe(server.url, "web/src/app.ts")).content).toMatchObject({ newContent: "v2 web\n" });

        renameSync(join(root, "api"), join(base, "api.moved"));
        renameSync(join(base, "other"), join(root, "api"));
        // The member's own reads and git (diff expansion, the diff itself)
        // refuse the replacement. Code navigation reads from the workspace
        // root, and a directory moved into the root is inside it like any
        // file written there, so it is not checked here.
        const after = await probe(server.url, "api/src/app.ts");
        expect(after.content).toMatchObject({ oldContent: null, newContent: null });
        expect(await switchDiff(server.url, "workspace-current")).not.toContain("TOP SECRET");
      } finally {
        server?.stop();
        restoreEnv();
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
});
