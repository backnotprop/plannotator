/**
 * The Forgejo / Gitea PR provider against a recording fake `fetch`. The
 * response shapes follow what a live Forgejo 17 instance returns (fields
 * checked against its swagger spec and a public test repository); names and
 * text are synthetic.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  FORGEJO_LIMITS,
  checkFjAuth,
  fetchFjFileBytes,
  fetchFjFileContent,
  fetchFjPR,
  fetchFjPRContext,
  fetchFjPRList,
  fetchFjTree,
  forgejoInlineAnchor,
  getFjUser,
  latestForgejoStatuses,
  mapForgejoThreads,
  submitFjPRReview,
} from "./pr-forgejo";
import { join } from "node:path";
import { fetchPR, submitPRReview } from "./pr-provider";
import type { ForgejoPRRef, PRReviewFileComment, PRRuntime } from "./pr-types";

const ORIGIN = "https://forgejo.example.com";
const ref: ForgejoPRRef = { platform: "forgejo", host: "forgejo.example.com", owner: "acme", repo: "widgets", number: 5 };
const API = `${ORIGIN}/api/v1/repos/acme/widgets`;

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

/** A runtime whose `fetch` is answered by `handler`; every request is recorded. */
function fake(handler: Handler, tokens: Record<string, string> = {}) {
  const calls: Call[] = [];
  const runtime: PRRuntime = {
    async runCommand() {
      throw new Error("a Forgejo call must never run a CLI");
    },
    forgejoToken: (origin) => tokens[origin] ?? null,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? "GET",
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handler(call);
    }) as typeof fetch,
  };
  return { runtime, calls };
}

const ok = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
const text = (value: string) => new Response(value, { headers: { "content-type": "text/plain" } });
const status = (code: number, message?: string, headers: Record<string, string> = {}) =>
  new Response(message === undefined ? null : JSON.stringify({ message, url: "https://forgejo.example.com/api/swagger" }), { status: code, headers });

const SHA_HEAD = "8adcde01fe5788d1dfaeb82a8a823764d0626fec";
const SHA_BASE = "0123456789abcdef0123456789abcdef01234567";
const SHA_MERGE_BASE = "eaac0b3236d63db8cbcf11a6c9d667cc87dfa717";

const pullRequest = (extra: Record<string, unknown> = {}) => ({
  number: 5,
  title: "Add the thing",
  body: "Does the thing.",
  state: "open",
  merged: false,
  draft: false,
  mergeable: true,
  changed_files: 1,
  merge_base: SHA_MERGE_BASE,
  html_url: "https://forgejo.example.com/acme/widgets/pulls/5",
  user: { login: "rivka", username: "rivka", full_name: "Rivka Example", email: "r@example.invalid", avatar_url: "https://forgejo.example.com/avatars/r" },
  labels: [],
  requested_reviewers: [],
  base: { ref: "main", sha: SHA_BASE, repo: { full_name: "acme/widgets", default_branch: "main" } },
  head: { ref: "feature/x", sha: SHA_HEAD, repo: { full_name: "acme/widgets" } },
  ...extra,
});

const ONE_FILE_DIFF = "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hi\n";

describe("fetchFjPR", () => {
  const prRoutes: Handler = ({ url }) => {
    if (url === `${API}/pulls/5`) return ok(pullRequest());
    if (url === `${API}/pulls/5.diff`) return text(ONE_FILE_DIFF);
    return status(404, "not routed");
  };

  test("maps the PR to metadata and returns the raw patch", async () => {
    const { runtime, calls } = fake(prRoutes);
    const { metadata, rawPatch, patchIncomplete } = await fetchFjPR(runtime, ref);
    expect(metadata).toEqual({
      platform: "forgejo",
      host: "forgejo.example.com",
      owner: "acme",
      repo: "widgets",
      number: 5,
      title: "Add the thing",
      author: "rivka",
      baseBranch: "main",
      headBranch: "feature/x",
      defaultBranch: "main",
      baseSha: SHA_BASE,
      headSha: SHA_HEAD,
      mergeBaseSha: SHA_MERGE_BASE,
      url: "https://forgejo.example.com/acme/widgets/pulls/5",
    });
    expect(rawPatch).toBe(ONE_FILE_DIFF);
    expect(patchIncomplete).toBeUndefined();
    expect(calls.map((c) => c.url).sort()).toEqual([`${API}/pulls/5`, `${API}/pulls/5.diff`]);
  });

  test("the author is the login, never the display name or email", async () => {
    const { runtime } = fake(prRoutes);
    const { metadata } = await fetchFjPR(runtime, ref);
    expect(JSON.stringify(metadata)).not.toContain("Rivka Example");
    expect(JSON.stringify(metadata)).not.toContain("example.invalid");
  });

  test("the url comes from the URL the review was opened on, not the instance's own html_url", async () => {
    const { runtime } = fake(({ url }) =>
      url.endsWith(".diff") ? text(ONE_FILE_DIFF) : ok(pullRequest({ html_url: "https://other-root.example.net/acme/widgets/pulls/5" })),
    );
    const { metadata } = await fetchFjPR(runtime, ref);
    expect(metadata.url).toBe("https://forgejo.example.com/acme/widgets/pulls/5");
  });

  test("an http instance on a port keeps its scheme and is called over http", async () => {
    const lan: ForgejoPRRef = { ...ref, host: "forgejo.lan:3000", scheme: "http" };
    const { runtime, calls } = fake(({ url }) => (url.endsWith(".diff") ? text(ONE_FILE_DIFF) : ok(pullRequest())));
    const { metadata } = await fetchFjPR(runtime, lan);
    expect(calls.every((c) => c.url.startsWith("http://forgejo.lan:3000/api/v1/repos/acme/widgets/pulls/5"))).toBe(true);
    expect(metadata).toMatchObject({ host: "forgejo.lan:3000", scheme: "http", url: "http://forgejo.lan:3000/acme/widgets/pulls/5" });
  });

  test("sourceRepo is set only for a fork PR", async () => {
    const fork = pullRequest({ head: { ref: "patch-1", sha: SHA_HEAD, repo: { full_name: "someone/widgets" } } });
    const { runtime } = fake(({ url }) => (url.endsWith(".diff") ? text(ONE_FILE_DIFF) : ok(fork)));
    expect((await fetchFjPR(runtime, ref)).metadata).toMatchObject({ sourceRepo: "someone/widgets" });
    const same = fake(prRoutes);
    expect("sourceRepo" in (await fetchFjPR(same.runtime, ref)).metadata).toBe(false);
  });

  test("a deleted fork (head.repo null) still opens: the head is read from refs/pull/N/head", async () => {
    const orphan = pullRequest({ head: { ref: "patch-1", sha: SHA_HEAD, repo: null } });
    const { runtime } = fake(({ url }) => (url.endsWith(".diff") ? text(ONE_FILE_DIFF) : ok(orphan)));
    const { metadata } = await fetchFjPR(runtime, ref);
    expect(metadata).toMatchObject({ headSha: SHA_HEAD });
    expect("sourceRepo" in metadata).toBe(false);
  });

  test("flags a patch that has fewer files than the PR reports", async () => {
    const { runtime } = fake(({ url }) => (url.endsWith(".diff") ? text(ONE_FILE_DIFF) : ok(pullRequest({ changed_files: 3 }))));
    expect((await fetchFjPR(runtime, ref)).patchIncomplete).toBe(true);
  });

  test("a PR with no head or base commit is an error, not a half-empty review", async () => {
    const { runtime } = fake(({ url }) => (url.endsWith(".diff") ? text("") : ok(pullRequest({ head: { ref: "x", sha: "" } }))));
    await expect(fetchFjPR(runtime, ref)).rejects.toThrow("no head or base commit");
  });
});

describe("authentication", () => {
  const repoOnly: Handler = () => ok({ full_name: "acme/widgets" });

  test("sends `Authorization: token` with the token configured for the origin, and runs no CLI", async () => {
    const { runtime, calls } = fake(repoOnly, { [ORIGIN]: "secret" });
    await checkFjAuth(runtime, ref);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBe("token secret");
  });

  test("a token configured for another origin is never sent", async () => {
    const { runtime, calls } = fake(repoOnly, { "https://elsewhere.example.com": "not-for-this-host" });
    await fetchFjFileContent(runtime, ref, SHA_HEAD, "a.txt");
    expect(calls.every((c) => c.authorization === null)).toBe(true);
  });

  test("without a token a public review opens: checkAuth makes no request", async () => {
    const { runtime, calls } = fake(repoOnly);
    await checkFjAuth(runtime, ref);
    expect(calls).toEqual([]);
  });

  test("with a token, checkAuth proves it on the repository, not on /user (which needs read:user)", async () => {
    const { runtime, calls } = fake(repoOnly, { [ORIGIN]: "secret" });
    await checkFjAuth(runtime, ref);
    expect(calls[0]!.url).toBe(API);
  });

  test("an expired token says so and does not echo the token", async () => {
    const { runtime } = fake(() => status(401, "user does not exist [uid: 0, name: ]"), { [ORIGIN]: "secret-value" });
    const error = await checkFjAuth(runtime, ref).then(() => null, (e: Error) => e);
    expect(error?.message).toContain("rejected the token");
    expect(error?.message).not.toContain("secret-value");
  });

  test("a redirect inside the API origin is followed with the token; one off-origin is refused before any token leaves", async () => {
    let hop = 0;
    const inside = fake(({ url }) => {
      if (url.includes("/user")) return hop++ === 0 ? new Response(null, { status: 302, headers: { location: `${ORIGIN}/api/v1/user?moved=1` } }) : ok({ login: "rivka" });
      return status(404);
    }, { [ORIGIN]: "secret" });
    expect(await getFjUser(inside.runtime, ref)).toBe("rivka");
    expect(inside.calls.map((c) => c.authorization)).toEqual(["token secret", "token secret"]);

    const off = fake(() => new Response(null, { status: 302, headers: { location: "https://storage.example.net/x" } }), { [ORIGIN]: "secret" });
    await expect(fetchFjPR(off.runtime, ref)).rejects.toThrow("off the API origin");
    expect(off.calls.map((c) => c.url)).not.toContain("https://storage.example.net/x");
  });

  test("an http link to a server that answers on https says which link to use, and is still not followed", async () => {
    const httpRef: ForgejoPRRef = { ...ref, host: "codeberg.org", scheme: "http" };
    const { runtime, calls } = fake(() => new Response(null, { status: 301, headers: { location: "https://codeberg.org/api/v1/repos/acme/widgets/pulls/5" } }));
    const error = await fetchFjPR(runtime, httpRef).then(() => null, (e: Error) => e);
    expect(error?.message).toContain("this server answers on https. Use the PR's https:// link (https://codeberg.org/…) instead.");
    expect(calls.every((c) => c.url.startsWith("http://codeberg.org/"))).toBe(true);
  });

  test("the token hint names the config file this process reads", async () => {
    const before = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = "/tmp/plannotator-forgejo-hint-test";
    try {
      const error = await fetchFjPR(fake(() => status(404, "The target couldn't be found.")).runtime, ref).then(() => null, (e: Error) => e);
      expect(error?.message).toContain(`forgejoTokens in ${join("/tmp/plannotator-forgejo-hint-test", "config.json")}`);
      expect(error?.message).not.toContain("~/.plannotator");
    } finally {
      if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = before;
    }
  });

  test("getUser is null without a token and when the token lacks read:user", async () => {
    expect(await getFjUser(fake(() => ok({ login: "rivka" })).runtime, ref)).toBeNull();
    expect(await getFjUser(fake(() => status(403, "token does not have at least one of required scope(s)"), { [ORIGIN]: "t" }).runtime, ref)).toBeNull();
  });
});

describe("errors name the cause and the fix", () => {
  const run = (code: number, message?: string, tokens: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    fetchFjPR(fake(() => status(code, message, headers), tokens).runtime, ref).then(() => null, (e: Error & { status?: number }) => e);

  test("404 without a token: the repository may be private, and how to add a token", async () => {
    const error = await run(404, "The target couldn't be found.");
    expect(error?.status).toBe(404);
    expect(error?.message).toContain("private");
    expect(error?.message).toContain("forgejoTokens");
    expect(error?.message).toContain(ORIGIN);
  });

  test("Forgejo's message keeps its text but never doubles the sentence's full stop", async () => {
    const error = await run(404, "The target couldn't be found.");
    expect(error?.message).toContain("not found (HTTP 404): The target couldn't be found.");
    expect(error?.message).not.toContain("..");
    expect((await run(500, "boom."))?.message).toBe("Failed to fetch PR metadata: Forgejo HTTP 500: boom");
  });

  test("404 with a token does not blame a missing token, but says the account may not see the repository", async () => {
    const error = await run(404, "The target couldn't be found.", { [ORIGIN]: "t" });
    expect(error?.status).toBe(404);
    expect(error?.message).not.toContain("forgejoTokens");
    // A restricted account gets the same 404 for a public repository, so the message must say so.
    expect(error?.message).toContain("restricted account");
    expect(error?.message).toContain("not been added");
  });

  test("404 without a token keeps the private-repository hint and does not mention restricted accounts", async () => {
    const error = await run(404, "The target couldn't be found.");
    expect(error?.message).toContain("If the repository is private");
    expect(error?.message).not.toContain("restricted account");
  });

  test("403 lists the scopes the token needs, with Forgejo's own reason", async () => {
    const error = await run(403, "token does not have at least one of required scope(s): [read:repository]", { [ORIGIN]: "t" });
    expect(error?.status).toBe(403);
    expect(error?.message).toContain("read:repository");
    expect(error?.message).toContain("write:repository");
    expect(error?.message).toContain("required scope(s)");
  });

  test("403 with no token (an instance that requires sign-in) says to add a token, not to widen scopes", async () => {
    const error = await run(403, "Only signed in user is allowed to call APIs.");
    expect(error?.status).toBe(403);
    expect(error?.message).toContain("Only signed in user is allowed to call APIs");
    expect(error?.message).toContain("forgejoTokens");
    expect(error?.message).not.toContain("The token needs the scopes");
  });

  test("429 says when to retry", async () => {
    expect((await run(429, "slow down", {}, { "retry-after": "42" }))?.message).toContain("in 42s");
  });
});

describe("fetchFjPRContext", () => {
  const review = (id: number, user: string, state: string, extra: Record<string, unknown> = {}) => ({
    id, state, body: `review ${id}`, html_url: `${ORIGIN}/acme/widgets/pulls/5#issuecomment-${id}`, submitted_at: `2026-11-0${id}T10:00:00Z`,
    comments_count: 0, dismissed: false, stale: false, user: { login: user }, ...extra,
  });

  function contextRoutes(overrides: { pr?: unknown; reviews?: unknown[]; comments?: unknown[]; statuses?: unknown[]; reviewComments?: Record<number, unknown[]> } = {}): Handler {
    return ({ url }) => {
      const path = url.replace(API, "").replace(/\?.*$/, "");
      if (path === "/pulls/5") return ok(overrides.pr ?? pullRequest());
      if (path === "/issues/5/comments") return ok(overrides.comments ?? []);
      if (path === "/pulls/5/reviews") return ok(overrides.reviews ?? []);
      if (path === `/commits/${SHA_HEAD}/statuses`) return ok(overrides.statuses ?? []);
      const m = /^\/pulls\/5\/reviews\/(\d+)\/comments$/.exec(path);
      if (m) return ok(overrides.reviewComments?.[Number(m[1])] ?? []);
      return status(404, "not routed");
    };
  }

  test("state: merged beats closed beats open; draft and labels map across", async () => {
    const read = async (pr: unknown) => (await fetchFjPRContext(fake(contextRoutes({ pr })).runtime, ref));
    expect((await read(pullRequest({ state: "closed", merged: true }))).state).toBe("MERGED");
    expect((await read(pullRequest({ state: "closed", merged: false }))).state).toBe("CLOSED");
    const open = await read(pullRequest({ draft: true, labels: [{ name: "bug", color: "#ee0701" }, { name: "" }] }));
    expect(open).toMatchObject({ state: "OPEN", isDraft: true, body: "Does the thing.", labels: [{ name: "bug", color: "ee0701" }] });
  });

  test("mergeable becomes MERGEABLE, CONFLICTING or UNKNOWN", async () => {
    const read = async (mergeable: unknown) => (await fetchFjPRContext(fake(contextRoutes({ pr: pullRequest({ mergeable }) })).runtime, ref)).mergeable;
    expect([await read(true), await read(false), await read(undefined)]).toEqual(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);
  });

  test("reviews: pending and review-request entries are not reviews; states map to the GitHub-shaped names", async () => {
    const ctx = await fetchFjPRContext(fake(contextRoutes({
      reviews: [review(1, "ana", "APPROVED"), review(2, "bo", "REQUEST_CHANGES"), review(3, "cy", "COMMENT"), review(4, "di", "PENDING"), review(5, "ed", "REQUEST_REVIEW"), review(6, "fa", "APPROVED", { dismissed: true })],
    })).runtime, ref);
    expect(ctx.reviews.map((r) => [r.author, r.state])).toEqual([
      ["ana", "APPROVED"], ["bo", "CHANGES_REQUESTED"], ["cy", "COMMENTED"], ["fa", "DISMISSED"],
    ]);
  });

  test("reviewDecision follows each person's latest decision; a comment keeps it and a dismissal clears it", async () => {
    const decide = async (reviews: unknown[]) => (await fetchFjPRContext(fake(contextRoutes({ reviews })).runtime, ref)).reviewDecision;
    expect(await decide([review(1, "ana", "APPROVED")])).toBe("APPROVED");
    expect(await decide([review(1, "ana", "APPROVED"), review(2, "bo", "REQUEST_CHANGES")])).toBe("CHANGES_REQUESTED");
    // ana approved, then asked for changes: her latest counts.
    expect(await decide([review(1, "ana", "APPROVED"), review(2, "ana", "REQUEST_CHANGES")])).toBe("CHANGES_REQUESTED");
    expect(await decide([review(1, "ana", "REQUEST_CHANGES"), review(2, "ana", "APPROVED")])).toBe("APPROVED");
    expect(await decide([review(1, "ana", "APPROVED"), review(2, "ana", "COMMENT")])).toBe("APPROVED");
    expect(await decide([review(1, "ana", "REQUEST_CHANGES"), review(2, "ana", "COMMENT", { dismissed: true })])).toBe("");
    expect(await decide([])).toBe("");
  });

  test("issue comments, requested reviewers (people and teams) and commit statuses", async () => {
    const ctx = await fetchFjPRContext(fake(contextRoutes({
      pr: pullRequest({ requested_reviewers: [{ login: "ana", avatar_url: "https://forgejo.example.com/avatars/a" }], requested_reviewers_teams: [{ name: "core" }] }),
      comments: [{ id: 9, body: "Looks fine", html_url: `${ORIGIN}/acme/widgets/pulls/5#issuecomment-9`, created_at: "2026-11-03T10:00:00Z", user: { login: "bo" } }],
      statuses: [
        { context: "ci/build", status: "success", target_url: "https://ci.example.com/1" },
        { context: "ci/lint", status: "pending", target_url: "" },
        { context: "ci/test", status: "failure", target_url: "" },
        { context: "ci/e2e", status: "warning", target_url: "" },
      ],
    })).runtime, ref);
    expect(ctx.comments).toEqual([{ id: "9", author: "bo", body: "Looks fine", createdAt: "2026-11-03T10:00:00Z", url: `${ORIGIN}/acme/widgets/pulls/5#issuecomment-9` }]);
    expect(ctx.requestedReviewers).toEqual([{ login: "ana", avatarUrl: "https://forgejo.example.com/avatars/a" }, { login: "core", isTeam: true }]);
    expect(ctx.checks.map((c) => [c.name, c.status, c.conclusion])).toEqual([
      ["ci/build", "COMPLETED", "SUCCESS"], ["ci/lint", "IN_PROGRESS", null], ["ci/test", "COMPLETED", "FAILURE"], ["ci/e2e", "COMPLETED", "NEUTRAL"],
    ]);
  });

  test("inline comments are fetched for each review that has some and grouped into threads", async () => {
    const { runtime, calls } = fake(contextRoutes({
      reviews: [review(1, "ana", "COMMENT", { comments_count: 1 }), review(2, "bo", "COMMENT", { comments_count: 0 })],
      reviewComments: {
        1: [{ id: 11, body: "Why?", path: "a.txt", position: 3, original_position: 0, created_at: "2026-11-01T10:00:00Z", diff_hunk: "@@ -1 +1,3 @@\n+x", user: { login: "ana" }, pull_request_review_id: 1 }],
      },
    }));
    const ctx = await fetchFjPRContext(runtime, ref);
    expect(ctx.reviewThreads).toHaveLength(1);
    expect(ctx.reviewThreads[0]).toMatchObject({ path: "a.txt", line: 3, diffSide: "RIGHT", isResolved: false });
    // A review with no inline comments costs no request.
    expect(calls.some((c) => c.url.includes("/reviews/2/comments"))).toBe(false);
  });

  test("a list is read across pages by number, whatever page size the instance clamps to", async () => {
    const comment = (id: number) => ({ id, body: `c${id}`, html_url: "", created_at: "", user: { login: "bo" } });
    const { runtime, calls } = fake(({ url }) => {
      if (url.includes("/issues/5/comments")) {
        return url.includes("page=2")
          ? ok([comment(3)])
          : ok([comment(1), comment(2)], { link: `<${API}/issues/5/comments?limit=2&page=2>; rel="next", <${API}/issues/5/comments?limit=2&page=2>; rel="last"` });
      }
      return contextRoutes()({ method: "GET", url, authorization: null, body: undefined });
    });
    const ctx = await fetchFjPRContext(runtime, ref);
    expect(ctx.comments.map((c) => c.id)).toEqual(["1", "2", "3"]);
    expect(calls.filter((c) => c.url.includes("/issues/5/comments"))).toHaveLength(2);
  });

  test("a next link that points off the API origin is not followed", async () => {
    const { runtime, calls } = fake(({ url }) => {
      if (url.includes("/issues/5/comments")) return ok([], { link: '<https://evil.example.net/steal?page=2>; rel="next"' });
      return contextRoutes()({ method: "GET", url, authorization: null, body: undefined });
    }, { [ORIGIN]: "secret" });
    await fetchFjPRContext(runtime, ref);
    expect(calls.some((c) => c.url.startsWith("https://evil.example.net"))).toBe(false);
  });

  const comment = (id: number) => ({ id, body: `c${id}`, html_url: "", created_at: "", user: { login: "bo" } });
  /** Comments 1-3 in pages of 2, `page` read from the request; `link` writes each page's Link header. */
  const pagedComments = (link: (page: number) => Record<string, string>) => fake(({ url }) => {
    if (url.includes("/issues/5/comments")) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const items = [comment(1), comment(2), comment(3)].slice((page - 1) * 2, page * 2);
      return ok(items, page === 1 ? link(page) : {});
    }
    return contextRoutes()({ method: "GET", url, authorization: null, body: undefined });
  }, { [ORIGIN]: "secret" });

  test("an instance whose own address differs (ROOT_URL) still gives every page, read from the origin typed", async () => {
    const { runtime, calls } = pagedComments(() => ({ link: '<https://forgejo.internal:3000/api/v1/repos/acme/widgets/issues/5/comments?limit=2&page=2>; rel="next"' }));
    const ctx = await fetchFjPRContext(runtime, ref);
    expect(ctx.comments.map((c) => c.id)).toEqual(["1", "2", "3"]);
    const pages = calls.filter((c) => c.url.includes("/issues/5/comments"));
    expect(pages.map((c) => new URL(c.url).origin)).toEqual([ORIGIN, ORIGIN]);
    expect(calls.some((c) => c.url.includes("forgejo.internal"))).toBe(false);
  });

  test("a relative Link works, and X-Total-Count ends the pages", async () => {
    const relative = pagedComments(() => ({ link: '</api/v1/repos/acme/widgets/issues/5/comments?limit=2&page=2>; rel="next"' }));
    expect((await fetchFjPRContext(relative.runtime, ref)).comments.map((c) => c.id)).toEqual(["1", "2", "3"]);
    const counted = pagedComments(() => ({ "x-total-count": "3" }));
    expect((await fetchFjPRContext(counted.runtime, ref)).comments.map((c) => c.id)).toEqual(["1", "2", "3"]);
    expect(counted.calls.filter((c) => c.url.includes("/issues/5/comments"))).toHaveLength(2);
  });

  test("a check is its context's newest status, not the whole history", async () => {
    const ctx = await fetchFjPRContext(fake(contextRoutes({
      statuses: [
        // Newest first, as Forgejo lists them; the order must not matter.
        { id: 9, context: "ci/build", status: "success", created_at: "2026-11-01T10:09:00Z" },
        { id: 8, context: "ci/lint", status: "skipped", created_at: "2026-11-01T10:08:00Z" },
        { id: 7, context: "ci/test", status: "success", created_at: "2026-11-01T10:07:00Z" },
        { id: 1, context: "ci/build", status: "pending", created_at: "2026-11-01T10:01:00Z" },
        { id: 3, context: "ci/build", status: "failure", created_at: "2026-11-01T10:03:00Z" },
        { id: 2, context: "ci/test", status: "pending", created_at: "2026-11-01T10:02:00Z" },
        { id: 4, context: "ci/test", status: "pending", created_at: "2026-11-01T10:04:00Z" },
        { id: 5, context: "ci/lint", status: "pending", created_at: "2026-11-01T10:05:00Z" },
      ],
    })).runtime, ref);
    expect(ctx.checks.map((c) => [c.name, c.status, c.conclusion]).sort()).toEqual([
      ["ci/build", "COMPLETED", "SUCCESS"], ["ci/lint", "COMPLETED", "SKIPPED"], ["ci/test", "COMPLETED", "SUCCESS"],
    ]);
    // Without ids, the later time wins.
    expect(latestForgejoStatuses([
      { context: "x", status: "failure", created_at: "2026-11-01T10:00:00Z" },
      { context: "x", status: "success", created_at: "2026-11-01T11:00:00Z" },
    ]).map((s) => s.status)).toEqual(["success"]);
  });

  test("relative links (Forgejo Actions' target_url) open on the instance, never on the local server", async () => {
    const ctx = await fetchFjPRContext(fake(contextRoutes({
      pr: pullRequest({ requested_reviewers: [{ login: "ana", avatar_url: "/avatars/a" }] }),
      reviews: [review(1, "ana", "COMMENT", { comments_count: 1, html_url: "/acme/widgets/pulls/5#issuecomment-1", user: { login: "ana", avatar_url: "/avatars/a" } })],
      reviewComments: { 1: [{ id: 11, body: "x", path: "a.txt", position: 1, html_url: "/acme/widgets/pulls/5/files#issuecomment-11", user: { login: "ana", avatar_url: "/avatars/a" }, pull_request_review_id: 1 }] },
      comments: [{ id: 9, body: "hi", html_url: "/acme/widgets/pulls/5#issuecomment-9", created_at: "", user: { login: "bo", avatar_url: "/avatars/b" } }],
      statuses: [
        { id: 1, context: "actions", status: "success", target_url: "/acme/widgets/actions/runs/218645/jobs/0" },
        { id: 2, context: "external", status: "success", target_url: "https://ci.example.com/build/1" },
        { id: 3, context: "script", status: "success", target_url: "javascript:alert(1)" },
        { id: 4, context: "none", status: "success" },
      ],
    })).runtime, ref);
    expect(Object.fromEntries(ctx.checks.map((c) => [c.name, c.detailsUrl]))).toEqual({
      actions: `${ORIGIN}/acme/widgets/actions/runs/218645/jobs/0`,
      // A link on another origin stays as given: the person opens it in a new tab.
      external: "https://ci.example.com/build/1",
      script: "",
      none: "",
    });
    expect(ctx.comments[0]).toMatchObject({ url: `${ORIGIN}/acme/widgets/pulls/5#issuecomment-9`, avatarUrl: `${ORIGIN}/avatars/b` });
    expect(ctx.reviews[0]).toMatchObject({ url: `${ORIGIN}/acme/widgets/pulls/5#issuecomment-1`, avatarUrl: `${ORIGIN}/avatars/a` });
    expect(ctx.reviewThreads[0]!.comments[0]).toMatchObject({ url: `${ORIGIN}/acme/widgets/pulls/5/files#issuecomment-11`, avatarUrl: `${ORIGIN}/avatars/a` });
    expect(ctx.requestedReviewers).toEqual([{ login: "ana", avatarUrl: `${ORIGIN}/avatars/a` }]);
  });

  test("comments, reviews or statuses that fail to load do not fail the whole context", async () => {
    const { runtime } = fake(({ url }) => {
      if (url.includes("/issues/5/comments") || url.includes("/statuses")) return status(500, "boom");
      return contextRoutes()({ method: "GET", url, authorization: null, body: undefined });
    });
    expect(await fetchFjPRContext(runtime, ref)).toMatchObject({ comments: [], checks: [], state: "OPEN" });
  });
});

describe("mapForgejoThreads", () => {
  const c = (id: number, extra: Record<string, unknown>) => ({
    id, body: `c${id}`, path: "a.txt", position: 4, original_position: 0, created_at: `2026-11-01T10:0${id}:00Z`,
    pull_request_review_id: 1, user: { login: "ana" }, ...extra,
  });

  test("comments on the same path, side and line are one thread, oldest first", () => {
    const threads = mapForgejoThreads([c(2, {}), c(1, {}), c(3, { position: 9 })]);
    expect(threads.map((t) => [t.line, t.comments.map((x) => x.id)])).toEqual([[4, ["1", "2"]], [9, ["3"]]]);
  });

  test("position is the new-file line, original_position the old-file line", () => {
    const [right, left] = mapForgejoThreads([c(1, { position: 7, original_position: 0 }), c(2, { position: 0, original_position: 7, path: "b.txt" })]);
    expect(right).toMatchObject({ line: 7, diffSide: "RIGHT" });
    expect(left).toMatchObject({ line: 7, diffSide: "LEFT", path: "b.txt" });
    // The same number on the two sides is two threads.
    expect(mapForgejoThreads([c(1, { position: 7 }), c(2, { position: 0, original_position: 7 })])).toHaveLength(2);
  });

  test("a range anchored on its first line with extra_lines_count more", () => {
    const [thread] = mapForgejoThreads([c(1, { position: 4, extra_lines_count: 2 })]);
    expect(thread).toMatchObject({ startLine: 4, line: 6 });
  });

  test("resolved when any comment has a resolver; outdated when its review is stale", () => {
    const [resolved] = mapForgejoThreads([c(1, {}), c(2, { resolver: { login: "bo" } })]);
    expect(resolved!.isResolved).toBe(true);
    const [outdated] = mapForgejoThreads([c(1, {})], new Set([1]));
    expect(outdated!.isOutdated).toBe(true);
    expect(mapForgejoThreads([c(1, {})])[0]!.isOutdated).toBe(false);
  });

  test("a comment with no path or no line is skipped, not shown at line 0", () => {
    expect(mapForgejoThreads([c(1, { path: "" }), c(2, { position: 0, original_position: 0 })])).toEqual([]);
  });

  test("the diff hunk, author and url travel with each comment", () => {
    const [thread] = mapForgejoThreads([c(1, { diff_hunk: "@@ -1 +1 @@\n+x", html_url: "https://f/x#1", user: { login: "ana", avatar_url: "https://f/a" } })]);
    expect(thread!.comments[0]).toEqual({
      id: "1", author: "ana", avatarUrl: "https://f/a", body: "c1", createdAt: "2026-11-01T10:01:00Z", url: "https://f/x#1", diffHunk: "@@ -1 +1 @@\n+x",
    });
  });
});

describe("files", () => {
  test("fetchFjFileContent reads the raw file at the commit, with the path and ref encoded", async () => {
    const { runtime, calls } = fake(() => text("hello"));
    expect(await fetchFjFileContent(runtime, ref, SHA_HEAD, "docs/my file#1.md")).toBe("hello");
    expect(calls[0]!.url).toBe(`${API}/raw/docs/my%20file%231.md?ref=${SHA_HEAD}`);
  });

  test("a missing file or a failure is null, not an exception", async () => {
    expect(await fetchFjFileContent(fake(() => status(404)).runtime, ref, SHA_HEAD, "x")).toBeNull();
    expect(await fetchFjFileContent(fake(() => { throw new Error("network"); }).runtime, ref, SHA_HEAD, "x")).toBeNull();
  });

  test("fetchFjFileBytes: ok, missing, and an error that is neither", async () => {
    expect(await fetchFjFileBytes(fake(() => new Response(new Uint8Array([1, 2, 3]))).runtime, ref, SHA_HEAD, "i.png", 100))
      .toEqual({ kind: "ok", bytes: new Uint8Array([1, 2, 3]) });
    expect(await fetchFjFileBytes(fake(() => status(404)).runtime, ref, SHA_HEAD, "i.png", 100)).toEqual({ kind: "missing" });
    await expect(fetchFjFileBytes(fake(() => status(500, "boom")).runtime, ref, SHA_HEAD, "i.png", 100)).rejects.toThrow("HTTP 500");
  });

  test("a file larger than the cap is refused from its declared size and its body dropped", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const res = new Response(body, { headers: { "content-length": "5000" } });
    expect(await fetchFjFileBytes(fake(() => res).runtime, ref, SHA_HEAD, "big.bin", 100)).toEqual({ kind: "too-large", size: 5000 });
    // The body is dropped unread, not downloaded to find out how big it is.
    expect(cancelled).toBe(true);
  });

  test("with no declared size, the read stops once it passes the cap", async () => {
    let chunks = 0;
    const body = new ReadableStream({ pull(controller) { chunks++; controller.enqueue(new Uint8Array(60)); if (chunks > 50) controller.close(); } });
    const result = await fetchFjFileBytes(fake(() => new Response(body)).runtime, ref, SHA_HEAD, "big.bin", 100);
    expect(result.kind).toBe("too-large");
    expect(chunks).toBeLessThan(10);
  });
});

describe("fetchFjTree", () => {
  const entry = (path: string, type = "blob") => ({ path, type, mode: "100644", size: 1, sha: "abc" });

  test("lists blobs only, following pages while Forgejo says truncated", async () => {
    const { runtime, calls } = fake(({ url }) =>
      url.includes("page=2")
        ? ok({ tree: [entry("c.txt")], truncated: false, page: 2 })
        : ok({ tree: [entry("a.txt"), entry("dir", "tree"), entry("b.txt")], truncated: true, page: 1 }),
    );
    expect(await fetchFjTree(runtime, ref, SHA_HEAD)).toEqual({ paths: ["a.txt", "b.txt", "c.txt"], truncated: false });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain(`/git/trees/${SHA_HEAD}?recursive=true&per_page=1000&page=1`);
  });

  test("a listing that never ends is reported as truncated after a page budget", async () => {
    const { runtime, calls } = fake(() => ok({ tree: [entry("a.txt")], truncated: true }));
    const result = await fetchFjTree(runtime, ref, SHA_HEAD);
    expect(result?.truncated).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(101);
  });

  test("a failure is null", async () => {
    expect(await fetchFjTree(fake(() => status(404)).runtime, ref, SHA_HEAD)).toBeNull();
  });
});

describe("forgejoInlineAnchor", () => {
  const base: PRReviewFileComment = { path: "a.txt", line: 12, side: "RIGHT", body: "note" };

  test("a line of the new file is new_position, of the old file old_position; the other is 0", () => {
    expect(forgejoInlineAnchor(base)).toEqual({ path: "a.txt", body: "note", new_position: 12, old_position: 0, extra_lines_count: 0 });
    expect(forgejoInlineAnchor({ ...base, side: "LEFT" })).toEqual({ path: "a.txt", body: "note", new_position: 0, old_position: 12, extra_lines_count: 0 });
  });

  test("a range anchors on its first line with extra_lines_count more, whichever order it was drawn in", () => {
    expect(forgejoInlineAnchor({ ...base, start_line: 10 })).toMatchObject({ new_position: 10, extra_lines_count: 2 });
    expect(forgejoInlineAnchor({ ...base, line: 10, start_line: 12 })).toMatchObject({ new_position: 10, extra_lines_count: 2 });
    expect(forgejoInlineAnchor({ ...base, side: "LEFT", start_line: 9 })).toMatchObject({ old_position: 9, new_position: 0, extra_lines_count: 3 });
  });

  test("a range that starts on the other side is posted on its last line alone", () => {
    expect(forgejoInlineAnchor({ ...base, start_line: 3, start_side: "LEFT" })).toMatchObject({ new_position: 12, extra_lines_count: 0 });
    expect(forgejoInlineAnchor({ ...base, start_line: 12 })).toMatchObject({ extra_lines_count: 0 });
  });
});

describe("submitFjPRReview", () => {
  const created = () => ok({ id: 77, state: "APPROVED" });
  const authed = (handler: Handler = created) => fake(handler, { [ORIGIN]: "secret" });
  const inline: PRReviewFileComment[] = [{ path: "a.txt", line: 2, side: "RIGHT", body: "fix" }];

  test("each decision posts one review with the exact event Forgejo expects", async () => {
    for (const [action, event] of [["approve", "APPROVED"], ["comment", "COMMENT"], ["request_changes", "REQUEST_CHANGES"]] as const) {
      const { runtime, calls } = authed();
      expect(await submitFjPRReview(runtime, ref, SHA_HEAD, action, "Summary", [])).toEqual({ status: "complete" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: "POST", url: `${API}/pulls/5/reviews`, authorization: "token secret" });
      expect(calls[0]!.body).toEqual({ event, body: "Summary", commit_id: SHA_HEAD, comments: [] });
    }
  });

  test("inline comments ride in the same request, anchored for Forgejo", async () => {
    const { runtime, calls } = authed();
    await submitFjPRReview(runtime, ref, SHA_HEAD, "comment", "Two notes", [
      ...inline,
      { path: "b.txt", line: 7, side: "LEFT", body: "old", start_line: 5 },
    ]);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { comments: unknown[] }).comments).toEqual([
      { path: "a.txt", body: "fix", new_position: 2, old_position: 0, extra_lines_count: 0 },
      { path: "b.txt", body: "old", new_position: 0, old_position: 5, extra_lines_count: 2 },
    ]);
  });

  test("request-changes with inline comments and no summary uses the placeholder Forgejo's body rule needs", async () => {
    const { runtime, calls } = authed();
    await submitFjPRReview(runtime, ref, SHA_HEAD, "request_changes", "  ", inline);
    expect((calls[0]!.body as { body: string }).body).toBe("See inline comments.");
  });

  test("a comment review with inline comments and no summary also gets it; approve stays empty", async () => {
    const comment = authed();
    await submitFjPRReview(comment.runtime, ref, SHA_HEAD, "comment", "", inline);
    expect((comment.calls[0]!.body as { body: string }).body).toBe("See inline comments.");
    const approve = authed();
    await submitFjPRReview(approve.runtime, ref, SHA_HEAD, "approve", "", []);
    expect((approve.calls[0]!.body as { body: string }).body).toBe("");
  });

  test("request-changes with nothing to say is refused locally, before any request", async () => {
    const { runtime, calls } = authed();
    await expect(submitFjPRReview(runtime, ref, SHA_HEAD, "request_changes", "", [])).rejects.toThrow("needs a comment to request changes");
    expect(calls).toEqual([]);
  });

  test("posting without a token says how to add one and sends nothing", async () => {
    const { runtime, calls } = fake(created);
    const error = await submitFjPRReview(runtime, ref, SHA_HEAD, "approve", "", []).then(() => null, (e: Error) => e);
    expect(error?.message).toContain("forgejoTokens");
    expect(calls).toEqual([]);
  });

  test("Forgejo's own refusal reaches the caller, and the review is not reported as posted", async () => {
    const { runtime } = authed(() => status(422, "approve your own pull is not allowed"));
    const error = await submitFjPRReview(runtime, ref, SHA_HEAD, "approve", "", []).then(() => null, (e: Error & { status?: number }) => e);
    expect(error?.status).toBe(422);
    expect(error?.message).toContain("approve your own pull is not allowed");
    expect(error?.message).toContain("approve the PR");
  });

  test("a 403 for a token without write scope names write:repository", async () => {
    const { runtime } = authed(() => status(403, "token does not have at least one of required scope(s): [write:repository]"));
    const error = await submitFjPRReview(runtime, ref, SHA_HEAD, "comment", "hi", []).then(() => null, (e: Error) => e);
    expect(error?.message).toContain("write:repository");
  });
});

describe("fetchFjPRList", () => {
  test("lists recent PRs with merged, closed and open states", async () => {
    const { runtime, calls } = fake(() =>
      ok([
        pullRequest({ number: 7, title: "Merged one", state: "closed", merged: true }),
        pullRequest({ number: 6, title: "Closed one", state: "closed", merged: false }),
        pullRequest({ number: 5, title: "Open one" }),
      ]),
    );
    const list = await fetchFjPRList(runtime, ref);
    expect(list.map((p) => [p.number, p.state, p.author, p.baseBranch])).toEqual([[7, "merged", "rivka", "main"], [6, "closed", "rivka", "main"], [5, "open", "rivka", "main"]]);
    expect(list[0]!.url).toBe("https://forgejo.example.com/acme/widgets/pulls/7");
    expect(calls[0]!.url).toContain("/pulls?state=all&sort=recentupdate");
  });

  test("a failure is an empty list", async () => {
    expect(await fetchFjPRList(fake(() => status(500, "boom")).runtime, ref)).toEqual([]);
  });
});

describe("registered as the forgejo provider", () => {
  test("the dispatch functions reach it for a forgejo ref", async () => {
    const { runtime } = fake(({ url }) => (url.endsWith(".diff") ? text(ONE_FILE_DIFF) : ok(pullRequest())));
    const { metadata } = await fetchPR(runtime, ref);
    expect(metadata.platform).toBe("forgejo");
  });

  test("file-level comments fold into the review body, which Forgejo's review post cannot anchor", async () => {
    const { runtime, calls } = fake(() => ok({ id: 1 }), { [ORIGIN]: "secret" });
    await submitPRReview(runtime, ref, SHA_HEAD, "comment", "Overall fine", [], [{ path: "a.txt", body: "rename this file" }]);
    expect((calls[0]!.body as { body: string }).body).toBe("Overall fine\n\n**a.txt:** rename this file");
  });
});

describe("every request has a deadline and a size cap", () => {
  const saved = { ...FORGEJO_LIMITS };
  afterEach(() => Object.assign(FORGEJO_LIMITS, saved));

  test("the caps are 30 s, 10 MB for API JSON and 50 MB for the diff and raw files", () => {
    expect(saved).toEqual({ timeoutMs: 30_000, jsonMaxBytes: 10 * 1024 * 1024, diffMaxBytes: 50 * 1024 * 1024 });
  });

  test("a server that never answers is given up on, in plain words", async () => {
    FORGEJO_LIMITS.timeoutMs = 30;
    const { runtime } = fake(() => new Promise<Response>(() => {}));
    await expect(fetchFjPR(runtime, ref)).rejects.toThrow("The Forgejo server took too long to answer.");
  });

  test("a body that starts and never ends is given up on too", async () => {
    FORGEJO_LIMITS.timeoutMs = 30;
    const { runtime } = fake(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("[")); } })));
    await expect(fetchFjPRList(runtime, ref)).resolves.toEqual([]);
    await expect(checkFjAuth(fake(() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1)); } })), { [ORIGIN]: "t" }).runtime, ref))
      .rejects.toThrow("took too long");
  });

  test("an API answer past its cap is refused once the read passes it, not downloaded whole", async () => {
    FORGEJO_LIMITS.jsonMaxBytes = 1000;
    let chunks = 0;
    const endless = () => new Response(new ReadableStream({ pull(controller) { chunks++; controller.enqueue(new Uint8Array(400).fill(32)); } }));
    await expect(checkFjAuth(fake(endless, { [ORIGIN]: "t" }).runtime, ref)).rejects.toThrow("The Forgejo server sent more than 1000 bytes.");
    expect(chunks).toBeLessThan(10);
    const declared = () => new Response("{}", { headers: { "content-length": "5000" } });
    await expect(checkFjAuth(fake(declared, { [ORIGIN]: "t" }).runtime, ref)).rejects.toThrow("sent more than 1000 bytes");
  });

  test("the diff has its own larger cap", async () => {
    FORGEJO_LIMITS.jsonMaxBytes = 2000;
    FORGEJO_LIMITS.diffMaxBytes = 4000;
    const bigDiff = ONE_FILE_DIFF + "+x\n".repeat(900);
    const routes = (diff: string): Handler => ({ url }) => (url.endsWith(".diff") ? text(diff) : ok(pullRequest()));
    // Past the JSON cap but within the diff's: read.
    expect((await fetchFjPR(fake(routes(bigDiff)).runtime, ref)).rawPatch).toBe(bigDiff);
    await expect(fetchFjPR(fake(routes(bigDiff + "+x\n".repeat(600))).runtime, ref)).rejects.toThrow("sent more than 4000 bytes");
  });

  test("a refusal's long body is cut for its message, not refused as too large", async () => {
    FORGEJO_LIMITS.jsonMaxBytes = 100;
    const error = await fetchFjPR(fake(() => status(500, "x".repeat(5000))).runtime, ref).then(() => null, (e: Error) => e);
    expect(error?.message).toStartWith("Failed to fetch PR metadata: Forgejo HTTP 500");
  });
});

describe("a 303 after a post", () => {
  test("continues as a GET without the body, on the same origin only", async () => {
    const { runtime, calls } = fake(({ method }) =>
      method === "POST" ? new Response(null, { status: 303, headers: { location: `${ORIGIN}/api/v1/repos/acme/widgets/pulls/5/reviews/77` } }) : ok({ id: 77 }),
    { [ORIGIN]: "secret" });
    expect(await submitFjPRReview(runtime, ref, SHA_HEAD, "comment", "hi", [])).toEqual({ status: "complete" });
    expect(calls.map((c) => [c.method, c.body === undefined])).toEqual([["POST", false], ["GET", true]]);
    const off = fake(() => new Response(null, { status: 303, headers: { location: "https://elsewhere.example.net/x" } }), { [ORIGIN]: "secret" });
    await expect(submitFjPRReview(off.runtime, ref, SHA_HEAD, "comment", "hi", [])).rejects.toThrow("off the API origin");
    expect(off.calls).toHaveLength(1);
  });
});
