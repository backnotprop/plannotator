/**
 * Working-tree reads behind the code-nav preview and diff expansion, on both
 * servers (Bun + Pi), through packages/shared/repo-file.ts.
 *
 * Like VS Code, links are followed wherever they point (owner's ruling on
 * #2261). What must not regress: a file over the 5 MB cap is refused with
 * its size instead of read whole, and a FIFO is refused instead of hanging
 * the request (on Pi, readFileSync on a FIFO froze the whole process).
 * Each runtime keeps its old text output (Bun strips a BOM, Pi keeps it).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { MAX_REPO_FILE_BYTES } from "@plannotator/shared/repo-file";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";

const PATCH = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+export const app = 1;\n";
const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]);
const BUN_SERVER_MODULE = join(import.meta.dir, "review.ts");
const PI_SERVER_MODULE = join(import.meta.dir, "../../apps/pi-extension/server.ts");
const RUNTIME_MODULES = {
  Bun: join(import.meta.dir, "git.ts"),
  Pi: join(import.meta.dir, "../../apps/pi-extension/server/vcs.ts"),
};
const CHILD_TIMEOUT_MS = 15_000;

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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Run `source` in a child Bun and return the JSON it prints last. A read
 * that blocks on a FIFO would freeze this process (Pi's server shares the
 * event loop), so FIFO checks run in a child that is killed on timeout.
 */
function runInChild(source: string, env: Record<string, string>): unknown {
  const child = spawnSync(process.execPath, ["--eval", source], {
    encoding: "utf-8",
    timeout: CHILD_TIMEOUT_MS,
    env: { ...process.env, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_UPDATE_CHECK: "0", PLANNOTATOR_INBOX_CONNECT: "0", ...env },
  });
  if (child.signal || child.error) throw new Error(`child did not finish (blocked on a FIFO?): ${child.signal ?? child.error}`);
  if (child.status !== 0) throw new Error(`child failed: ${child.stderr}`);
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null");
}

// Symlinks and FIFOs: POSIX only.
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("working-tree reads for the code-nav preview and diff expansion", () => {
  let base = "";
  let repo = "";

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "pn-repo-file-")));
    repo = join(base, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(base, "elsewhere"));
    writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(base, "elsewhere", "linked.ts"), "linked from outside\n");
    symlinkSync(join(base, "elsewhere", "linked.ts"), join(repo, "linked.ts"));
    writeFileSync(join(repo, "big.txt"), Buffer.alloc(MAX_REPO_FILE_BYTES + 1, 0x61));
    writeFileSync(join(repo, "bom.txt"), BOM_BYTES);
    expect(spawnSync("mkfifo", [join(repo, "pipe")]).status).toBe(0);
  });

  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  for (const [runtime, startServer] of [
    ["Bun", startBunReviewServer],
    ["Pi", startPiReviewServer],
  ] as const) {
    describe(`${runtime}: GET /api/code-nav/file`, () => {
      let server: { url: string; stop: () => void } | null = null;

      beforeAll(async () => {
        setEnv("PLANNOTATOR_DATA_DIR", join(base, `data-${runtime}`));
        setEnv("PLANNOTATOR_BROWSER", NO_BROWSER);
        setEnv("PLANNOTATOR_UPDATE_CHECK", "0");
        setEnv("PLANNOTATOR_INBOX_CONNECT", "0");
        if (runtime === "Pi") setEnv("PLANNOTATOR_PORT", String(await freePort()));
        server = await startServer({
          rawPatch: PATCH,
          gitRef: "HEAD",
          agentCwd: repo,
          origin: runtime === "Pi" ? "pi" : "claude-code",
          htmlContent: "<html></html>",
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

      test("follows a link wherever it points, like an editor", async () => {
        const linked = await get("linked.ts");
        expect(linked.status).toBe(200);
        expect(linked.body.content).toBe("linked from outside\n");
      });

      test("refuses a file over the cap with its size, instead of reading it", async () => {
        const big = await get("big.txt");
        expect(big.status).toBe(413);
        expect(big.body).toMatchObject({ reason: "too-large", size: MAX_REPO_FILE_BYTES + 1, maxBytes: MAX_REPO_FILE_BYTES });
      });

      test("keeps the path string checks and says plainly what is missing", async () => {
        for (const path of ["../repo/src/app.ts", "/etc/hosts", "src/app.ts\0"]) {
          const refused = await get(path);
          expect(refused.status).toBe(400);
          expect(refused.body.reason).toBe("invalid-path");
        }
        expect(await get("missing.ts")).toMatchObject({ status: 404, body: { reason: "not-found" } });
        expect(await get("src")).toMatchObject({ status: 400, body: { reason: "not-a-file" } });
      });

      test("decodes like this runtime's old reader (Bun strips a BOM, Pi keeps it)", async () => {
        const old = runtime === "Bun"
          ? await Bun.file(join(repo, "bom.txt")).text()
          : readFileSync(join(repo, "bom.txt"), "utf-8");
        expect((await get("bom.txt")).body.content).toBe(old);
      });
    });

    test(`${runtime}: a FIFO is refused at once instead of hanging the server`, async () => {
      const port = await freePort();
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
          PLANNOTATOR_PORT: String(port),
        },
      );
      expect(result).toMatchObject({ status: 400, body: { reason: "not-a-file" } });
    }, CHILD_TIMEOUT_MS * 2);

    test(`${runtime}: diff expansion does not hang on a file swapped for a FIFO after its stat`, () => {
      const swapped = join(repo, `becomes-fifo-${runtime}.txt`);
      writeFileSync(swapped, "regular\n");
      try {
        // The working-tree side lstats the path, then reads it: swap the file
        // for a FIFO in between. The read must answer null, not block.
        const result = runInChild(
          `
          const { rmSync } = await import("node:fs");
          const { spawnSync } = await import("node:child_process");
          const { readDiffSideText } = await import(${JSON.stringify(join(import.meta.dir, "../shared/review-core.ts"))});
          const mod = await import(${JSON.stringify(RUNTIME_MODULES[runtime])});
          const runtime = mod.runtime ?? mod.reviewRuntime;
          const swapping = {
            ...runtime,
            async getFileInfo(base, path) {
              const info = await runtime.getFileInfo(base, path);
              rmSync(${JSON.stringify(swapped)});
              spawnSync("mkfifo", [${JSON.stringify(swapped)}]);
              return info;
            },
          };
          const text = await readDiffSideText(swapping, { kind: "worktree", path: ${JSON.stringify(`becomes-fifo-${runtime}.txt`)} }, ${JSON.stringify(repo)});
          const big = await runtime.readTextFile(${JSON.stringify(join(repo, "big.txt"))});
          console.log(JSON.stringify({ text, big }));
          process.exit(0);
          `,
          { PLANNOTATOR_DATA_DIR: join(base, `data-swap-${runtime}`) },
        );
        // And the runtime's reader never returns a file over the cap.
        expect(result).toEqual({ text: null, big: null });
      } finally {
        rmSync(swapped, { force: true });
      }
    }, CHILD_TIMEOUT_MS * 2);
  }
});
