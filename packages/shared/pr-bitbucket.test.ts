/**
 * Bitbucket Cloud provider against a local fake of the REST API that serves
 * recorded (anonymized) api.bitbucket.org responses — see
 * tests/test-fixtures/bitbucket/fake-bitbucket.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startFakeBitbucket,
  type FakeBitbucket,
  type FakeBitbucketOptions,
} from "../../tests/test-fixtures/bitbucket/fake-bitbucket";
import {
  checkBbAuth,
  fetchBbFileBytes,
  fetchBbFileContent,
  fetchBbPR,
  fetchBbPRContext,
  fetchBbPRList,
  getBbUser,
  submitBbPRReview,
} from "./pr-bitbucket";
import { resolveBitbucketApiUrl, resolveBitbucketCredentials } from "./config";
import type { BitbucketPRRef, PRReviewFileComment, PRRuntime } from "./pr-types";

const FIXTURES = join(import.meta.dir, "../../tests/test-fixtures/bitbucket");
const HEAD = "c0a227ce2c516b48f1093561a903bf89f2b4282a";
const BASE = "6155635443f4e180e6eb5a4b3b9d219e3bd9cfb2";
const EMAIL = "ada@example.invalid";
const TOKEN = "fake-token-never-real-1234567890";
const REF: BitbucketPRRef = { platform: "bitbucket", host: "bitbucket.org", workspace: "ws", repo: "repo", number: 1 };
const runtime: PRRuntime = {
  async runCommand() {
    throw new Error("Bitbucket must not shell out to a CLI");
  },
};

const ENV_KEYS = [
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_BITBUCKET_API_URL",
  "PLANNOTATOR_BITBUCKET_EMAIL",
  "PLANNOTATOR_BITBUCKET_TOKEN",
] as const;
let savedEnv: Record<string, string | undefined>;
let dataDir: string;
let fake: FakeBitbucket | undefined;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-bb-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});

afterEach(() => {
  fake?.stop();
  fake = undefined;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function useFake(options: Partial<FakeBitbucketOptions> = {}, creds: { email?: string | null; token?: string } = {}): FakeBitbucket {
  fake = startFakeBitbucket({ email: EMAIL, token: TOKEN, ...options });
  process.env.PLANNOTATOR_BITBUCKET_API_URL = fake.apiUrl;
  process.env.PLANNOTATOR_BITBUCKET_TOKEN = creds.token ?? TOKEN;
  if (creds.email === null) delete process.env.PLANNOTATOR_BITBUCKET_EMAIL;
  else process.env.PLANNOTATOR_BITBUCKET_EMAIL = creds.email ?? EMAIL;
  return fake;
}

describe("fetchBbPR", () => {
  test("maps the PR, follows the diff redirect, and resolves full SHAs", async () => {
    const f = useFake();
    const { metadata, rawPatch, patchIncomplete } = await fetchBbPR(runtime, REF);

    expect(rawPatch).toBe(readFileSync(join(FIXTURES, "diff.txt"), "utf-8"));
    expect(patchIncomplete).toBeUndefined();
    expect(metadata).toEqual({
      platform: "bitbucket",
      host: "bitbucket.org",
      workspace: "ws",
      repo: "repo",
      number: 1,
      title: "Add mul and greet",
      author: "Ada Reviewer",
      baseBranch: "main",
      headBranch: "feature/smoke",
      defaultBranch: "main",
      // The PR object carries 12-char hashes; the local checkout validates
      // full SHAs, so both must be resolved.
      baseSha: BASE,
      headSha: HEAD,
      mergeBaseSha: BASE,
      url: "https://bitbucket.org/ws/repo/pull-requests/1",
    });
    // Every request authenticated with basic auth; the redirect target was fetched too.
    expect(f.requests.every((r) => r.auth === "basic")).toBe(true);
    expect(f.requests.some((r) => r.path.startsWith("/2.0/repositories/ws/repo/diff/ws/repo:"))).toBe(true);
  });

  test("flags a diff that is missing files the diffstat lists", async () => {
    useFake({ truncateDiffToFiles: 2 });
    const { patchIncomplete, rawPatch } = await fetchBbPR(runtime, REF);
    expect(patchIncomplete).toBe(true);
    expect((rawPatch.match(/^diff --git /gm) ?? []).length).toBe(2);
  });

  test("sends a Bearer token when no email is configured", async () => {
    const f = useFake({}, { email: null });
    await fetchBbPR(runtime, REF);
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.requests.every((r) => r.auth === "bearer")).toBe(true);
  });
});

describe("auth errors", () => {
  test("a missing token names the env vars and scopes, and nothing is requested", async () => {
    const f = useFake();
    delete process.env.PLANNOTATOR_BITBUCKET_TOKEN;
    const err = await checkBbAuth(runtime).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("PLANNOTATOR_BITBUCKET_TOKEN");
    expect(message).toContain("PLANNOTATOR_BITBUCKET_EMAIL");
    expect(message).toContain("write:pullrequest:bitbucket");
    expect(f.requests).toHaveLength(0);
  });

  test("a rejected token is an actionable error that never echoes the token", async () => {
    useFake({}, { token: "wrong-token-value-abc" });
    const err = await checkBbAuth(runtime).catch((e: Error) => e);
    const message = (err as Error).message;
    expect(message).toContain("HTTP 401");
    expect(message).toContain("PLANNOTATOR_BITBUCKET_EMAIL");
    expect(message).not.toContain("wrong-token-value-abc");
    expect(message).not.toContain(TOKEN);
  });

  test("a rate limit (HTTP 429) says to retry, with the Retry-After wait", async () => {
    process.env.PLANNOTATOR_BITBUCKET_TOKEN = TOKEN;
    const limited: PRRuntime = {
      ...runtime,
      fetch: (async () => new Response("", { status: 429, headers: { "retry-after": "42" } })) as unknown as typeof fetch,
    };
    const message = ((await checkBbAuth(limited).catch((e: Error) => e)) as Error).message;
    expect(message).toContain("HTTP 429");
    expect(message).toContain("42s");
  });

  test("getBbUser returns the account nickname", async () => {
    useFake();
    expect(await getBbUser(runtime)).toBe("Ada Reviewer");
  });
});

describe("fetchBbPRContext", () => {
  test("maps comments, inline threads, participants and build statuses", async () => {
    useFake({ commentsPageLen: 3 }); // exercises `next` pagination
    const ctx = await fetchBbPRContext(runtime, REF);

    expect(ctx.state).toBe("OPEN");
    expect(ctx.isDraft).toBe(false);
    expect(ctx.body).toBe("Smoke-test PR for **Plannotator** Bitbucket review.");
    expect(ctx.comments.map((c) => c.body)).toEqual(["General note from the API explorer."]);

    const byId = new Map(ctx.reviewThreads.map((t) => [t.id, t]));
    // Root + reply form one thread on the new side.
    expect(byId.get("873432728")).toMatchObject({
      path: "src/math.ts", line: 9, startLine: null, diffSide: "RIGHT", isResolved: false,
    });
    expect(byId.get("873432728")!.comments.map((c) => c.body)).toEqual(["Inline on new line 9.", "Reply in thread."]);
    // Old-side comment on a deleted file, resolved on Bitbucket.
    expect(byId.get("873432736")).toMatchObject({ path: "notes.txt", line: 1, diffSide: "LEFT", isResolved: true });
    // Multi-line range.
    expect(byId.get("873432749")).toMatchObject({ line: 11, startLine: 9, diffSide: "RIGHT" });
    // File-level comment: a thread with no line.
    expect(byId.get("873432757")).toMatchObject({ path: "src/greet.ts", line: null, diffSide: null });
    // Code context cut from the PR diff, in GitHub's diff_hunk shape.
    expect(byId.get("873432728")!.comments[0].diffHunk).toBe(
      "@@ -5,3 +5,7 @@ export function add(a: number, b: number): number {\n export function sub(a: number, b: number): number {\n   return a - b;\n }\n+\n+export function mul(a: number, b: number): number {",
    );
    expect(byId.get("873432736")!.comments[0].diffHunk).toBe("@@ -1 +0,0 @@\n-old notes");
    expect(byId.get("873432728")!.comments[1].diffHunk).toBeUndefined();
    expect(byId.get("873432728")!.comments[0].url).toBe(
      "https://bitbucket.org/ws/repo/pull-requests/1/_/diff#comment-873432728",
    );

    expect(ctx.reviews).toEqual([expect.objectContaining({ author: "Ada Reviewer", state: "CHANGES_REQUESTED" })]);
    expect(ctx.reviewDecision).toBe("CHANGES_REQUESTED");
    expect(ctx.checks).toEqual([
      expect.objectContaining({ name: "Unit tests", status: "COMPLETED", conclusion: "SUCCESS" }),
      expect.objectContaining({ name: "Lint", status: "IN_PROGRESS", conclusion: null }),
    ]);
  });
});

describe("file content", () => {
  test("reads text and image bytes at a commit; 404 reads as missing", async () => {
    useFake();
    expect(await fetchBbFileContent(runtime, REF, HEAD, "src/greet.ts")).toContain("export function greet");
    expect(await fetchBbFileContent(runtime, REF, HEAD, "nope.txt")).toBeNull();

    const png = await fetchBbFileBytes(runtime, REF, HEAD, "dot.png", 1024);
    expect(png.kind).toBe("ok");
    if (png.kind === "ok") expect(Array.from(png.bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]); // "PNG"
    expect(await fetchBbFileBytes(runtime, REF, HEAD, "dot.png", 10)).toEqual({ kind: "too-large", size: 70 });
    expect(await fetchBbFileBytes(runtime, REF, HEAD, "missing.png", 1024)).toEqual({ kind: "missing" });
  });
});

describe("fetchBbPRList", () => {
  test("maps the PR list", async () => {
    useFake();
    expect(await fetchBbPRList(runtime, REF)).toEqual([{
      id: "1", number: 1, title: "Add mul and greet", author: "Ada Reviewer",
      url: "https://bitbucket.org/ws/repo/pull-requests/1", baseBranch: "main", state: "open",
    }]);
  });
});

describe("submitBbPRReview", () => {
  const inline: PRReviewFileComment[] = [
    { path: "src/math.ts", line: 9, side: "RIGHT", body: "Name this `product`?" },
    { path: "notes.txt", line: 1, side: "LEFT", body: "Why drop this?" },
    { path: "src/math.ts", line: 11, side: "RIGHT", start_line: 9, start_side: "RIGHT", body: "Whole function." },
  ];

  function posts(f: FakeBitbucket) {
    return f.requests.filter((r) => r.method === "POST").map((r) => ({ path: r.path.replace("/2.0/repositories/ws/repo/pullrequests/1", ""), body: r.body }));
  }

  test("approve: general comment, inline anchors, then /approve", async () => {
    const f = useFake();
    const result = await submitBbPRReview(runtime, REF, HEAD, "approve", "Looks good overall.", inline);
    expect(result).toEqual({ status: "complete" });
    expect(posts(f)).toEqual([
      { path: "/comments", body: { content: { raw: "Looks good overall." } } },
      { path: "/comments", body: { content: { raw: "Name this `product`?" }, inline: { path: "src/math.ts", to: 9 } } },
      { path: "/comments", body: { content: { raw: "Why drop this?" }, inline: { path: "notes.txt", from: 1 } } },
      { path: "/comments", body: { content: { raw: "Whole function." }, inline: { path: "src/math.ts", to: 11, start_to: 9 } } },
      { path: "/approve", body: undefined },
    ]);
  });

  test("request_changes posts to /request-changes; comment posts no decision", async () => {
    const f = useFake();
    await submitBbPRReview(runtime, REF, HEAD, "request_changes", "", inline.slice(0, 1));
    expect(posts(f).map((p) => p.path)).toEqual(["/comments", "/request-changes"]);

    f.requests.length = 0;
    await submitBbPRReview(runtime, REF, HEAD, "comment", "Just a note.", []);
    expect(posts(f).map((p) => p.path)).toEqual(["/comments"]);
  });

  test("a partial inline failure returns the exact safe retry and keeps the decision", async () => {
    useFake({ failInlinePaths: ["notes.txt"] });
    const result = await submitBbPRReview(runtime, REF, HEAD, "request_changes", "Body.", inline);
    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.postedFileCommentCount).toBe(2);
    expect(result.reviewBodyPosted).toBe(true);
    expect(result.approval).toBe("succeeded");
    expect(result.retry).toEqual({ action: "comment", fileComments: [inline[1]] });
    expect(result.recoveryFile).toStartWith(join(dataDir, "failed-comments"));
  });

  test("nothing posted: every inline comment failing throws so a replay is safe", async () => {
    const f = useFake({ failInlinePaths: ["src/math.ts", "notes.txt"] });
    await expect(submitBbPRReview(runtime, REF, HEAD, "approve", "", inline)).rejects.toThrow("Failed to post inline comments");
    expect(posts(f).some((p) => p.path === "/approve")).toBe(false);
  });

  test("a failed decision after comments posted retries that decision", async () => {
    useFake({ decisionStatus: 400 });
    const result = await submitBbPRReview(runtime, REF, HEAD, "request_changes", "Body.", []);
    expect(result).toMatchObject({
      status: "partial",
      approval: "failed",
      reviewBodyPosted: true,
      retry: { action: "request_changes", fileComments: [] },
    });
  });
});

describe("config", () => {
  test("API URL override accepts https and loopback http only", () => {
    expect(resolveBitbucketApiUrl({ PLANNOTATOR_BITBUCKET_API_URL: "http://127.0.0.1:4000/2.0/" })).toBe("http://127.0.0.1:4000/2.0");
    expect(resolveBitbucketApiUrl({ PLANNOTATOR_BITBUCKET_API_URL: "https://bb-proxy.example.com/2.0" })).toBe("https://bb-proxy.example.com/2.0");
    // Credentials would travel in cleartext to a remote host: refused.
    expect(resolveBitbucketApiUrl({ PLANNOTATOR_BITBUCKET_API_URL: "http://bb.example.com/2.0" })).toBe("https://api.bitbucket.org/2.0");
    expect(resolveBitbucketApiUrl({})).toBe("https://api.bitbucket.org/2.0");
  });

  test("credentials come from one source: env beats config, never mixed", () => {
    const config = { bitbucketToken: "cfg-token", bitbucketEmail: "cfg@example.invalid" };
    expect(resolveBitbucketCredentials(config, { PLANNOTATOR_BITBUCKET_TOKEN: "env-token" })).toEqual({ token: "env-token" });
    expect(resolveBitbucketCredentials(config, {})).toEqual({ token: "cfg-token", email: "cfg@example.invalid" });
    expect(resolveBitbucketCredentials({}, { PLANNOTATOR_BITBUCKET_TOKEN: " " })).toBeNull();
  });
});
