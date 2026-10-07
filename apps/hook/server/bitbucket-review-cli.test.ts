/**
 * `plannotator review <bitbucket PR URL>` end to end: a real spawn of the CLI
 * entry against the local fake Bitbucket API (tests/test-fixtures/bitbucket),
 * wired through PLANNOTATOR_BITBUCKET_API_URL. Covers what only the whole
 * chain proves: URL detection → auth → fetch → review server payload →
 * PR context → posting a review back to the platform.
 *
 * The CLI imports the built single-file HTML from ../dist at module load; the
 * API routes under test never serve it, so placeholders are created when a
 * real build is absent and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBitbucket, type FakeBitbucket } from "../../../tests/test-fixtures/bitbucket/fake-bitbucket";

const serverDir = import.meta.dir;
const cliEntry = join(serverDir, "index.ts");
const distDir = join(serverDir, "..", "dist");
const fixtures = join(serverDir, "../../../tests/test-fixtures/bitbucket");
const TOKEN = "fake-token-for-cli-test-0987654321";
const EMAIL = "ada@example.invalid";

const createdDist: string[] = [];
let createdDistDir = false;
let workDir: string;
let fake: FakeBitbucket;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let stderr = "";
let base = "";

async function waitForReady(readyFile: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(readyFile)) {
      const text = readFileSync(readyFile, "utf-8");
      try { return (JSON.parse(text) as { url: string }).url; } catch { /* partially written */ }
    }
    await Bun.sleep(100);
  }
  throw new Error(`review server never became ready:\n${stderr}`);
}

beforeAll(async () => {
  if (!existsSync(distDir)) { mkdirSync(distDir, { recursive: true }); createdDistDir = true; }
  for (const file of ["index.html", "review.html", "inbox.html"]) {
    const p = join(distDir, file);
    if (!existsSync(p)) { writeFileSync(p, "<!-- test placeholder -->"); createdDist.push(p); }
  }
  workDir = mkdtempSync(join(tmpdir(), "plannotator-bb-cli-"));
  fake = startFakeBitbucket({ email: EMAIL, token: TOKEN });
  const readyFile = join(workDir, "ready.json");

  proc = Bun.spawn(
    [process.execPath, cliEntry, "review", "https://bitbucket.org/ws/repo/pull-requests/1", "--no-local"],
    {
      cwd: workDir,
      env: {
        ...process.env,
        PLANNOTATOR_CWD: workDir,
        PLANNOTATOR_DATA_DIR: join(workDir, "data"),
        PLANNOTATOR_READY_FILE: readyFile,
        PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
        PLANNOTATOR_REMOTE: "0",
        PLANNOTATOR_AI: "disabled",
        PLANNOTATOR_BITBUCKET_API_URL: fake.apiUrl,
        PLANNOTATOR_BITBUCKET_EMAIL: EMAIL,
        PLANNOTATOR_BITBUCKET_TOKEN: TOKEN,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  (async () => {
    for await (const chunk of proc!.stderr as ReadableStream<Uint8Array>) stderr += new TextDecoder().decode(chunk);
  })();
  base = (await waitForReady(readyFile)).replace(/\/$/, "");
}, 30_000);

afterAll(async () => {
  if (proc) {
    try { await fetch(`${base}/api/exit`, { method: "POST" }); } catch { /* already gone */ }
    const exited = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => null)]);
    if (exited === null) proc.kill();
  }
  fake?.stop();
  for (const p of createdDist) rmSync(p, { force: true });
  if (createdDistDir) rmSync(distDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("plannotator review <bitbucket PR>", () => {
  test("serves the Bitbucket diff and PR metadata", async () => {
    const diff = await (await fetch(`${base}/api/diff`)).json() as Record<string, any>;
    expect(diff.rawPatch).toBe(readFileSync(join(fixtures, "diff.txt"), "utf-8"));
    expect(diff.gitRef).toBe("PR #1");
    expect(diff.prMetadata).toMatchObject({
      platform: "bitbucket", workspace: "ws", repo: "repo", number: 1,
      headSha: "c0a227ce2c516b48f1093561a903bf89f2b4282a",
    });
    expect(diff.platformUser).toBe("Ada Reviewer");
    // The token must never reach the browser or the terminal.
    expect(JSON.stringify(diff)).not.toContain(TOKEN);
    expect(stderr).not.toContain(TOKEN);
  });

  test("serves existing comments as the read-only PR context", async () => {
    const ctx = await (await fetch(`${base}/api/pr-context`)).json() as Record<string, any>;
    expect(ctx.comments.map((c: any) => c.body)).toContain("General note from the API explorer.");
    const thread = ctx.reviewThreads.find((t: any) => t.id === "873432728");
    expect(thread.comments.map((c: any) => c.body)).toEqual(["Inline on new line 9.", "Reply in thread."]);
  });

  test("expands context from file contents at the merge base and head", async () => {
    const res = await (await fetch(`${base}/api/file-content?path=src/math.ts`)).json() as Record<string, any>;
    expect(res.oldContent).not.toContain("mul");
    expect(res.newContent).toContain("export function mul");
  });

  test("posts inline comments + approve, then request changes, to Bitbucket", async () => {
    const post = (body: unknown) => fetch(`${base}/api/pr-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const approve = await post({
      action: "approve",
      body: "LGTM with one nit.",
      fileComments: [{ path: "src/math.ts", line: 9, side: "RIGHT", body: "nit: `product`?" }],
    });
    expect(approve.status).toBe(200);
    expect((await approve.json() as any).submission).toEqual({ status: "complete" });

    const changes = await post({ action: "request_changes", body: "Please add tests.", fileComments: [] });
    expect(changes.status).toBe(200);

    const posted = fake.requests
      .filter((r) => r.method === "POST")
      .map((r) => [r.path.replace("/2.0/repositories/ws/repo/pullrequests/1", ""), r.body]);
    // Inline comments before the general comment (#1583: newest-first feed).
    expect(posted).toEqual([
      ["/comments", { content: { raw: "nit: `product`?" }, inline: { path: "src/math.ts", to: 9 } }],
      ["/comments", { content: { raw: "LGTM with one nit." } }],
      ["/approve", undefined],
      ["/comments", { content: { raw: "Please add tests." } }],
      ["/request-changes", undefined],
    ]);
    expect(fake.requests.every((r) => r.auth === "basic")).toBe(true);
  });
});
