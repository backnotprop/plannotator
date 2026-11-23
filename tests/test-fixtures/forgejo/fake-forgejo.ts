/**
 * A local fake of the Forgejo / Gitea REST API (`/api/v1`) for tests, and of the
 * one web route its attachments use. It records every request it receives.
 *
 * It models one private repository `acme/widgets` with PR #1 (`feature/smoke`
 * -> `main`, three files). Response shapes follow what a real Forgejo returns
 * (fields checked against its swagger spec and live reads of a public
 * instance); the names and text are synthetic. It is a model of what we have
 * observed, not a recording: scripts/forgejo-live-smoke.sh is the check against
 * a real instance.
 *
 * What it enforces, as Forgejo does:
 *  - every call needs a token (`Authorization: token <t>` or `Bearer <t>`);
 *    with `requireSignIn` an anonymous API call is a 403 "Only signed in user is
 *    allowed to call APIs", as on an instance that requires sign-in, otherwise
 *    the private repository is a 404; a wrong token is a 401;
 *  - posting a review: the event must be APPROVED, REQUEST_CHANGES or COMMENT
 *    (anything else saves a PENDING review that is not submitted); approving or
 *    requesting changes on your own PR is a 422; REQUEST_CHANGES needs a body;
 *    COMMENT needs a body or a line comment. Validation runs before anything is
 *    written.
 *
 * The token is checked but never recorded: a request records only which scheme
 * it used.
 */

export const HEAD_SHA = "c0a227ce2c516b48f1093561a903bf89f2b4282a";
export const BASE_SHA = "6155635443f4e180e6eb5a4b3b9d219e3bd9cfb2";
/** The attachment a PR description embeds, written relative as Forgejo's editor writes it. */
export const ATTACHMENT_UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
export const TOKEN_USER = "ada";

const MATH_BASE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_HEAD = `${MATH_BASE}\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n`;
const GREET = "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n";

/** What `GET /pulls/1.diff` answers. New line 9 of src/math.ts is `export function mul`. */
export const DIFF = [
  "diff --git a/src/math.ts b/src/math.ts",
  "index 1111111..2222222 100644",
  "--- a/src/math.ts",
  "+++ b/src/math.ts",
  "@@ -5,3 +5,7 @@ export function add(a: number, b: number): number {",
  " export function sub(a: number, b: number): number {",
  "   return a - b;",
  " }",
  "+",
  "+export function mul(a: number, b: number): number {",
  "+  return a * b;",
  "+}",
  "diff --git a/src/greet.ts b/src/greet.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/greet.ts",
  "@@ -0,0 +1,3 @@",
  "+export function greet(name: string): string {",
  "+  return `Hello, ${name}!`;",
  "+}",
  "diff --git a/notes.txt b/notes.txt",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/notes.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-old notes",
  "",
].join("\n");

const FILES: Record<string, Record<string, string>> = {
  [HEAD_SHA]: { "src/math.ts": MATH_HEAD, "src/greet.ts": GREET },
  [BASE_SHA]: { "src/math.ts": MATH_BASE, "notes.txt": "old notes\n" },
};

/** A 1x1 PNG. */
export const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

export interface RecordedRequest {
  method: string;
  /** Path plus query, relative to the server origin. */
  path: string;
  auth: "token" | "bearer" | "none" | "invalid";
  body?: unknown;
}

export interface FakeForgejoOptions {
  /** The access token the fake accepts. */
  token: string;
  port?: number;
  /** Anonymous API calls are 403 (an instance that requires sign-in) instead of a 404 for the private repo. Default true. */
  requireSignIn?: boolean;
}

export interface FakeForgejo {
  /** The instance's origin: what goes in the PR URL and PLANNOTATOR_FORGEJO_URL. */
  origin: string;
  requests: RecordedRequest[];
  /** Who authored PR #1 (default "grace"); set it to TOKEN_USER to review your own PR. */
  setAuthor(login: string): void;
  stop(): void;
}

const user = (login: string) => ({ login, username: login, full_name: `${login} (synthetic)`, avatar_url: `http://127.0.0.1/avatars/${login}` });

export function startFakeForgejo(options: FakeForgejoOptions): FakeForgejo {
  const requests: RecordedRequest[] = [];
  const requireSignIn = options.requireSignIn ?? true;
  let author = "grace";
  let nextId = 100;

  interface Review { id: number; state: string; body: string; user: string; submitted_at: string; commit_id: string; comments: any[] }
  const reviews: Review[] = [];
  const addReview = (state: string, body: string, login: string, comments: Array<{ path: string; body: string; position: number; original_position: number; extra_lines_count: number }>) => {
    const id = nextId++;
    const review: Review = { id, state, body, user: login, submitted_at: new Date(Date.UTC(2026, 10, 1, 10, id % 60)).toISOString(), commit_id: HEAD_SHA, comments: [] };
    review.comments = comments.map((c) => ({
      id: nextId++, ...c, diff_hunk: "@@ -5,3 +5,7 @@\n+", html_url: `http://127.0.0.1/acme/widgets/pulls/1#issuecomment-${id}`,
      created_at: review.submitted_at, pull_request_review_id: id, resolver: null, user: user(login),
    }));
    reviews.push(review);
    return review;
  };
  // Two comment reviews on the same line: Forgejo's way of a reply in a thread.
  addReview("COMMENT", "", "grace", [{ path: "src/math.ts", body: "Inline on new line 9.", position: 9, original_position: 0, extra_lines_count: 0 }]);
  addReview("COMMENT", "", "linus", [{ path: "src/math.ts", body: "Reply in thread.", position: 9, original_position: 0, extra_lines_count: 0 }]);

  const issueComments = [{ id: 7, body: "General note from the fake.", html_url: "http://127.0.0.1/acme/widgets/pulls/1#issuecomment-7", created_at: "2026-11-01T09:00:00Z", user: user("linus") }];

  const reviewJson = (r: Review) => ({
    id: r.id, state: r.state, body: r.body, html_url: `http://127.0.0.1/acme/widgets/pulls/1#pullrequestreview-${r.id}`,
    submitted_at: r.submitted_at, comments_count: r.comments.length, dismissed: false, stale: false, official: false, commit_id: r.commit_id, user: user(r.user),
  });

  const prJson = (origin: string) => ({
    number: 1, title: "Add mul and greet", state: "open", merged: false, draft: false, mergeable: true, changed_files: 3, merge_base: BASE_SHA,
    body: `Does the thing.\n\n![shot](/attachments/${ATTACHMENT_UUID})\n\n[not an attachment](/api/v1/user)`,
    html_url: `${origin}/acme/widgets/pulls/1`, user: user(author), labels: [], requested_reviewers: [], requested_reviewers_teams: [],
    base: { ref: "main", sha: BASE_SHA, repo: { full_name: "acme/widgets", default_branch: "main" } },
    head: { ref: "feature/smoke", sha: HEAD_SHA, repo: { full_name: "acme/widgets" } },
  });

  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json;charset=utf-8" } });
  const error = (message: string, status: number) => json({ message, url: "http://127.0.0.1/api/swagger" }, status);

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const header = req.headers.get("authorization");
      const auth: RecordedRequest["auth"] = !header
        ? "none"
        : header === `token ${options.token}` ? "token" : header === `Bearer ${options.token}` ? "bearer" : "invalid";
      let body: unknown;
      if (req.method === "POST") {
        const text = await req.text();
        try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
      }
      requests.push({ method: req.method, path: `${path}${url.search}`, auth, ...(body !== undefined ? { body } : {}) });

      if (auth === "invalid") return error("user does not exist [uid: 0, name: ]", 401);
      const signedIn = auth !== "none";
      const origin = url.origin;

      // The attachment web route: a private repository's upload needs the token.
      if (req.method === "GET" && path === `/attachments/${ATTACHMENT_UUID}`) {
        if (!signedIn) return new Response("not found", { status: 404 });
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      }

      if (!path.startsWith("/api/v1/")) return new Response("not found", { status: 404 });
      if (!signedIn) return requireSignIn ? error("Only signed in user is allowed to call APIs.", 403) : error("The target couldn't be found.", 404);
      const rest = path.slice("/api/v1".length);
      const repo = "/repos/acme/widgets";

      if (req.method === "GET" && rest === "/user") return json(user(TOKEN_USER));
      if (!rest.startsWith(repo)) return error("The target couldn't be found.", 404);
      const sub = rest.slice(repo.length);

      if (req.method === "GET" && sub === "") return json({ full_name: "acme/widgets", private: true, default_branch: "main", empty: false, permissions: { admin: false, push: true, pull: true } });
      if (req.method === "GET" && sub === "/pulls") return json([prJson(origin)]);
      if (req.method === "GET" && sub === "/pulls/1") return json(prJson(origin));
      if (req.method === "GET" && sub === "/pulls/1.diff") return new Response(DIFF, { headers: { "content-type": "text/plain; charset=utf-8" } });
      if (req.method === "GET" && sub === "/issues/1/comments") return json(issueComments);
      if (req.method === "GET" && sub === "/pulls/1/reviews") return json(reviews.map(reviewJson));
      const reviewComments = sub.match(/^\/pulls\/1\/reviews\/(\d+)\/comments$/);
      if (req.method === "GET" && reviewComments) return json(reviews.find((r) => r.id === Number(reviewComments[1]))?.comments ?? []);
      if (req.method === "GET" && sub === `/commits/${HEAD_SHA}/statuses`) return json([{ context: "ci/build", status: "success", target_url: "http://127.0.0.1/ci/1" }]);

      const raw = sub.match(/^\/raw\/(.+)$/);
      if (req.method === "GET" && raw) {
        const file = FILES[url.searchParams.get("ref") ?? ""]?.[decodeURIComponent(raw[1]!)];
        return file === undefined ? error("The target couldn't be found.", 404) : new Response(file, { headers: { "content-type": "text/plain" } });
      }
      const tree = sub.match(/^\/git\/trees\/([0-9a-f]{40})$/);
      if (req.method === "GET" && tree) {
        const names = Object.keys(FILES[tree[1]!] ?? {});
        return json({ sha: tree[1], tree: names.map((path) => ({ path, type: "blob", mode: "100644", size: 1 })), truncated: false, page: 1, total_count: names.length });
      }

      if (req.method === "POST" && sub === "/pulls/1/reviews") {
        const b = (body ?? {}) as { event?: string; body?: string; commit_id?: string; comments?: Array<Record<string, any>> };
        const text = (b.body ?? "").trim();
        const comments = b.comments ?? [];
        const own = author === TOKEN_USER;
        // Validation first: a refusal writes nothing.
        if (b.event === "APPROVED" && own) return error("approve your own pull is not allowed", 422);
        if (b.event === "REQUEST_CHANGES") {
          if (own) return error("reject your own pull is not allowed", 422);
          if (!text) return error("review event REQUEST_CHANGES requires a body", 422);
        }
        if (b.event === "COMMENT" && !text && comments.length === 0) return error("review event COMMENT requires a body or a comment", 422);
        const known = b.event === "APPROVED" || b.event === "REQUEST_CHANGES" || b.event === "COMMENT";
        const review = addReview(
          known ? b.event! : "PENDING", text, TOKEN_USER,
          comments.map((c) => ({ path: String(c.path), body: String(c.body), position: Number(c.new_position ?? 0), original_position: Number(c.old_position ?? 0), extra_lines_count: Number(c.extra_lines_count ?? 0) })),
        );
        return json(reviewJson(review));
      }

      return error("The target couldn't be found.", 404);
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    setAuthor: (login) => { author = login; },
    stop: () => server.stop(true),
  };
}
