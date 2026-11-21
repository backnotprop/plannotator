/**
 * `plannotator review <forgejo PR URL>` end to end: a real spawn of the CLI
 * entry against the local fake Forgejo API (tests/test-fixtures/forgejo). The
 * PR URL itself aims the CLI at the fake (`http://127.0.0.1:<port>/…`), so no
 * override variable is needed, and the token is given for that origin only.
 * Covers what only the whole chain proves: URL detection -> auth -> fetch ->
 * review server payload -> PR context -> attachments -> posting a review back
 * to the platform.
 *
 * The CLI imports the built single-file HTML from ../dist at module load; the
 * API routes under test never serve it, so placeholders are created when a
 * real build is absent and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTACHMENT_UUID,
  BASE_SHA,
  DIFF,
  HEAD_SHA,
  TOKEN_USER,
  startFakeForgejo,
  type FakeForgejo,
} from "../../../tests/test-fixtures/forgejo/fake-forgejo";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const cliEntry = join(import.meta.dir, "index.ts");
const TOKEN = "fake-forgejo-token-for-cli-test-0987654321";

let stubs: string[] = [];
let workDir: string;
let fake: FakeForgejo;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let stderr = "";
let base = "";

async function waitForReady(readyFile: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(readyFile)) {
      try { return (JSON.parse(readFileSync(readyFile, "utf-8")) as { url: string }).url; } catch { /* partially written */ }
    }
    await Bun.sleep(100);
  }
  throw new Error(`review server never became ready:\n${stderr}`);
}

const post = (body: unknown) => fetch(`${base}/api/pr-action`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const reviewPosts = () => fake.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/repos/acme/widgets/pulls/1/reviews");

beforeAll(async () => {
  stubs = stubHookDistHtml();
  workDir = mkdtempSync(join(tmpdir(), "plannotator-fj-cli-"));
  fake = startFakeForgejo({ token: TOKEN });
  const readyFile = join(workDir, "ready.json");

  proc = Bun.spawn(
    [process.execPath, cliEntry, "review", `${fake.origin}/acme/widgets/pulls/1`, "--no-local"],
    {
      cwd: workDir,
      env: {
        ...process.env,
        PLANNOTATOR_CWD: workDir,
        PLANNOTATOR_DATA_DIR: join(workDir, "data"),
        PLANNOTATOR_READY_FILE: readyFile,
        PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
        PLANNOTATOR_BROWSER: NO_BROWSER,
        PLANNOTATOR_REMOTE: "0",
        PLANNOTATOR_AI: "disabled",
        PLANNOTATOR_FORGEJO_URL: fake.origin,
        PLANNOTATOR_FORGEJO_TOKEN: TOKEN,
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
  // Only the stubs this file wrote; never the dist folder (a build may be writing into it).
  removeStubbedHtml(stubs);
  rmSync(workDir, { recursive: true, force: true });
});

describe("plannotator review <forgejo PR>", () => {
  test("serves the Forgejo diff and PR metadata, and never the token", async () => {
    const diff = await (await fetch(`${base}/api/diff`)).json() as Record<string, any>;
    expect(diff.rawPatch).toBe(DIFF);
    expect(diff.gitRef).toBe("PR #1");
    expect(diff.prMetadata).toMatchObject({
      platform: "forgejo", host: new URL(fake.origin).host, scheme: "http", owner: "acme", repo: "widgets", number: 1,
      author: "grace", baseBranch: "main", headBranch: "feature/smoke", headSha: HEAD_SHA, baseSha: BASE_SHA, mergeBaseSha: BASE_SHA,
      url: `${fake.origin}/acme/widgets/pulls/1`,
    });
    expect(diff.platformUser).toBe(TOKEN_USER);
    // The token must never reach the browser or the terminal.
    expect(JSON.stringify(diff)).not.toContain(TOKEN);
    expect(stderr).not.toContain(TOKEN);
  });

  test("serves existing comments, a reply thread and the commit status as the read-only PR context", async () => {
    const ctx = await (await fetch(`${base}/api/pr-context`)).json() as Record<string, any>;
    expect(ctx.state).toBe("OPEN");
    expect(ctx.comments.map((c: any) => c.body)).toContain("General note from the fake.");
    // Two review comments on one line are one thread, oldest first.
    expect(ctx.reviewThreads).toHaveLength(1);
    expect(ctx.reviewThreads[0]).toMatchObject({ path: "src/math.ts", line: 9, diffSide: "RIGHT" });
    expect(ctx.reviewThreads[0].comments.map((c: any) => c.body)).toEqual(["Inline on new line 9.", "Reply in thread."]);
    expect(ctx.checks.map((c: any) => [c.name, c.conclusion])).toEqual([["ci/build", "SUCCESS"]]);
  });

  test("expands context from file contents at the merge base and head", async () => {
    const res = await (await fetch(`${base}/api/file-content?path=src/math.ts`)).json() as Record<string, any>;
    expect(res.oldContent).not.toContain("mul");
    expect(res.newContent).toContain("export function mul");
  });

  test("loads the attachment a description embeds, with the token, and fetches nothing else it links", async () => {
    const attachment = `${fake.origin}/attachments/${ATTACHMENT_UUID}`;
    const res = await fetch(`${base}/api/pr-artifact-content?url=${encodeURIComponent(attachment)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    // The same description also links the API; that is not an attachment, so it is refused before any request.
    const api = await fetch(`${base}/api/pr-artifact-content?url=${encodeURIComponent(`${fake.origin}/api/v1/user`)}`);
    expect(api.status).toBeGreaterThanOrEqual(400);
    expect(fake.requests.filter((r) => r.path === "/api/v1/user" && r.method === "GET").length).toBe(1);
  });

  test("posts inline comments + approve, then request changes, to Forgejo", async () => {
    const approve = await post({
      action: "approve",
      body: "LGTM with one nit.",
      fileComments: [{ path: "src/math.ts", line: 9, side: "RIGHT", body: "nit: `product`?" }],
    });
    expect(approve.status).toBe(200);
    expect((await approve.json() as any).submission).toEqual({ status: "complete" });

    const changes = await post({ action: "request_changes", body: "Please add tests.", fileComments: [] });
    expect(changes.status).toBe(200);

    // One request per review, carrying the event, the body, the commit and every line comment.
    expect(reviewPosts().map((r) => r.body)).toEqual([
      {
        event: "APPROVED", body: "LGTM with one nit.", commit_id: HEAD_SHA,
        comments: [{ path: "src/math.ts", body: "nit: `product`?", new_position: 9, old_position: 0, extra_lines_count: 0 }],
      },
      { event: "REQUEST_CHANGES", body: "Please add tests.", commit_id: HEAD_SHA, comments: [] },
    ]);
    // The token goes out as `Authorization: token`, on every request, and only the right one is accepted.
    expect(fake.requests.every((r) => r.auth === "token")).toBe(true);
  });

  test("on your own PR Forgejo's refusal reaches the caller, and a plain comment still posts", async () => {
    fake.setAuthor(TOKEN_USER);
    try {
      const before = reviewPosts().length;
      const approve = await post({ action: "approve", body: "", fileComments: [] });
      expect(approve.status).not.toBe(200);
      expect(JSON.stringify(await approve.json())).toContain("approve your own pull is not allowed");
      const reject = await post({ action: "request_changes", body: "Please add tests.", fileComments: [] });
      expect(reject.status).not.toBe(200);
      expect(JSON.stringify(await reject.json())).toContain("reject your own pull is not allowed");
      // Both were sent and refused, not swallowed.
      expect(reviewPosts().length).toBe(before + 2);

      const comment = await post({ action: "comment", body: "A note on my own PR.", fileComments: [] });
      expect(comment.status).toBe(200);
      expect((await comment.json() as any).submission).toEqual({ status: "complete" });
    } finally {
      fake.setAuthor("grace");
    }
  });
});
