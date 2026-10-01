/**
 * A local fake of the Bitbucket Cloud REST API 2.0, for tests and the
 * headless UI check. It serves the recorded responses in this directory
 * (captured from api.bitbucket.org against a throwaway workspace, then
 * anonymized: workspace "ws", repo "repo", user "Ada Reviewer") and records
 * every request it receives.
 *
 * It models one repository `ws/repo` with PR #1 (`feature/smoke` → `main`):
 * the PR's `/diff` and `/diffstat` answer with the same redirect Bitbucket
 * sends, POSTed comments are appended to the comment list, and approve /
 * request-changes flip the caller's participant state, so a test can post a
 * review and read it back.
 *
 * Credentials are checked (Basic email:token, or Bearer token) but never
 * recorded: each request records only which scheme it used.
 *
 * Run standalone: `bun tests/test-fixtures/bitbucket/fake-bitbucket.ts [port]`
 * (expects `PLANNOTATOR_BITBUCKET_EMAIL` / `PLANNOTATOR_BITBUCKET_TOKEN`).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const HEAD = "c0a227ce2c516b48f1093561a903bf89f2b4282a";
const BASE = "6155635443f4e180e6eb5a4b3b9d219e3bd9cfb2";
const REPO_PREFIX = "/2.0/repositories/ws/repo";

export interface RecordedRequest {
  method: string;
  /** Path plus query, relative to the server origin. */
  path: string;
  auth: "basic" | "bearer" | "none" | "invalid";
  body?: unknown;
}

export interface FakeBitbucketOptions {
  email?: string;
  token: string;
  port?: number;
  /** Paths (inline comment `path`) whose comment POSTs fail with 400. */
  failInlinePaths?: string[];
  /** Fail every general (non-inline, non-reply) comment POST with 400. */
  failGeneralComments?: boolean;
  /** Answer POST /approve and /request-changes with this status. */
  decisionStatus?: number;
  /** Drop every file after the first N from the served diff (diffstat keeps them). */
  truncateDiffToFiles?: number;
  /** Serve at most this many comments per page, with `next` links. */
  commentsPageLen?: number;
}

export interface FakeBitbucket {
  /** API base to put in PLANNOTATOR_BITBUCKET_API_URL (ends in /2.0). */
  apiUrl: string;
  requests: RecordedRequest[];
  stop(): void;
}

function fixture(name: string): string {
  return readFileSync(join(DIR, name), "utf-8");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(message: string, status: number): Response {
  return json({ type: "error", error: { message } }, status);
}

function truncatePatch(patch: string, files: number): string {
  const parts = patch.split(/(?=^diff --git )/m);
  return parts.slice(0, files).join("");
}

export function startFakeBitbucket(options: FakeBitbucketOptions): FakeBitbucket {
  const requests: RecordedRequest[] = [];
  const pr = JSON.parse(fixture("pullrequest.json"));
  const comments: any[] = JSON.parse(fixture("comments.json")).values;
  const createdTemplate = JSON.parse(fixture("comment-created-inline.json"));
  const participantTemplate = JSON.parse(fixture("approve-participant.json"));
  const user = JSON.parse(fixture("user.json"));
  let nextCommentId = 900000001;

  const expectedBasic = options.email
    ? `Basic ${btoa(`${options.email}:${options.token}`)}`
    : null;

  function authOf(req: Request): RecordedRequest["auth"] {
    const header = req.headers.get("authorization");
    if (!header) return "none";
    if (expectedBasic && header === expectedBasic) return "basic";
    if (header === `Bearer ${options.token}`) return "bearer";
    return "invalid";
  }

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const auth = authOf(req);
      let body: unknown;
      if (req.method === "POST") {
        const text = await req.text();
        try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
      }
      requests.push({ method: req.method, path: `${path}${url.search}`, auth, ...(body !== undefined ? { body } : {}) });

      if (auth === "none" || auth === "invalid") {
        return new Response("", { status: 401, headers: { "www-authenticate": 'Basic realm="Bitbucket.org HTTP"' } });
      }

      const origin = url.origin;
      if (req.method === "GET" && path === "/2.0/user") return json(user);
      if (!path.startsWith(REPO_PREFIX)) return error("Resource not found", 404);
      const rest = path.slice(REPO_PREFIX.length);

      if (req.method === "GET" && rest === "") return json(JSON.parse(fixture("repository.json")));
      if (req.method === "GET" && rest === "/pullrequests") return json(JSON.parse(fixture("pullrequests.json")));
      if (req.method === "GET" && rest === "/pullrequests/1") return json(pr);

      // Same redirect shape Bitbucket answers with for a PR's diff and diffstat.
      const spec = `ws/repo:${HEAD.slice(0, 12)}%0D${BASE.slice(0, 12)}?from_pullrequest_id=1&topic=true`;
      if (req.method === "GET" && rest === "/pullrequests/1/diff") {
        return new Response("", { status: 302, headers: { location: `${origin}${REPO_PREFIX}/diff/${spec}` } });
      }
      if (req.method === "GET" && rest === "/pullrequests/1/diffstat") {
        return new Response("", { status: 302, headers: { location: `${origin}${REPO_PREFIX}/diffstat/${spec}` } });
      }
      if (req.method === "GET" && rest.startsWith("/diff/")) {
        const patch = fixture("diff.txt");
        return new Response(
          options.truncateDiffToFiles !== undefined ? truncatePatch(patch, options.truncateDiffToFiles) : patch,
          { headers: { "content-type": "text/plain" } },
        );
      }
      if (req.method === "GET" && rest.startsWith("/diffstat/")) return json(JSON.parse(fixture("diffstat.json")));

      const commitMatch = rest.match(/^\/commit\/([0-9a-f]+)$/);
      if (req.method === "GET" && commitMatch) {
        if (HEAD.startsWith(commitMatch[1])) return json(JSON.parse(fixture("commit-head.json")));
        if (BASE.startsWith(commitMatch[1])) return json(JSON.parse(fixture("commit-base.json")));
        return error(`Commit not found`, 404);
      }
      if (req.method === "GET" && rest.startsWith("/merge-base/")) return json(JSON.parse(fixture("merge-base.json")));

      const srcMatch = rest.match(/^\/src\/([0-9a-f]{40})\/(.+)$/);
      if (req.method === "GET" && srcMatch) {
        const [, sha, rawPath] = srcMatch;
        const filePath = decodeURIComponent(rawPath);
        const local = join(DIR, "src", sha, filePath);
        if (filePath.includes("..") || !existsSync(local) || !statSync(local).isFile()) {
          return error(`No such file or directory: ${filePath}`, 404);
        }
        if (url.searchParams.get("format") === "meta") {
          const meta = JSON.parse(fixture("src-meta-dot-png.json"));
          return json({ ...meta, path: filePath, escaped_path: filePath, size: statSync(local).size });
        }
        return new Response(readFileSync(local), { headers: { "content-type": "application/octet-stream" } });
      }

      if (req.method === "GET" && rest === "/pullrequests/1/comments") {
        const pagelen = options.commentsPageLen ?? Number(url.searchParams.get("pagelen") ?? 10);
        const page = Number(url.searchParams.get("page") ?? 1);
        const values = comments.slice((page - 1) * pagelen, page * pagelen);
        const hasNext = page * pagelen < comments.length;
        return json({
          values,
          pagelen,
          size: comments.length,
          page,
          ...(hasNext ? { next: `${origin}${REPO_PREFIX}/pullrequests/1/comments?pagelen=${pagelen}&page=${page + 1}` } : {}),
        });
      }
      if (req.method === "POST" && rest === "/pullrequests/1/comments") {
        const b = body as { content?: { raw?: string }; inline?: Record<string, unknown>; parent?: { id: number } } | undefined;
        if (!b?.content?.raw) return error("content: This field is required.", 400);
        if (b.inline && options.failInlinePaths?.includes(String(b.inline.path))) {
          return error("Invalid inline comment anchor", 400);
        }
        if (!b.inline && !b.parent && options.failGeneralComments) {
          return error("Comment rejected", 400);
        }
        const id = nextCommentId++;
        const created = {
          ...createdTemplate,
          id,
          content: { ...createdTemplate.content, raw: b.content.raw, html: `<p>${b.content.raw}</p>` },
          inline: b.inline
            ? { from: null, to: null, start_from: null, start_to: null, ...b.inline }
            : undefined,
          parent: b.parent ? { id: b.parent.id } : undefined,
          links: {
            ...createdTemplate.links,
            html: { href: `https://bitbucket.org/ws/repo/pull-requests/1/_/diff#comment-${id}` },
          },
        };
        if (!b.inline) delete created.inline;
        if (!b.parent) delete created.parent;
        comments.push(created);
        return json(created, 201);
      }

      if (req.method === "GET" && rest === "/pullrequests/1/statuses") return json(JSON.parse(fixture("statuses.json")));

      if (req.method === "POST" && (rest === "/pullrequests/1/approve" || rest === "/pullrequests/1/request-changes")) {
        if (options.decisionStatus && options.decisionStatus >= 400) {
          return error("Pull request changes cannot be requested because the pull request has already been merged.", options.decisionStatus);
        }
        const approved = rest.endsWith("/approve");
        const participant = {
          ...participantTemplate,
          approved,
          state: approved ? "approved" : "changes_requested",
          participated_on: new Date().toISOString(),
        };
        pr.participants = [participant];
        return json(participant);
      }

      return error("Resource not found", 404);
    },
  });

  return {
    apiUrl: `http://127.0.0.1:${server.port}/2.0`,
    requests,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const token = process.env.PLANNOTATOR_BITBUCKET_TOKEN;
  if (!token) {
    console.error("Set PLANNOTATOR_BITBUCKET_TOKEN (and optionally PLANNOTATOR_BITBUCKET_EMAIL) to the fake credentials.");
    process.exit(2);
  }
  const fake = startFakeBitbucket({
    token,
    email: process.env.PLANNOTATOR_BITBUCKET_EMAIL,
    port: Number(process.argv[2] ?? 0),
  });
  console.log(fake.apiUrl);
  process.on("SIGINT", () => {
    console.error(JSON.stringify(fake.requests.filter((r) => r.method === "POST"), null, 2));
    fake.stop();
    process.exit(0);
  });
}
