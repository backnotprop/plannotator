/**
 * The expand arrows' whole files in the Inbox (a PR page and a thread's guided
 * review): `GET /api/inbox/pulls/file` and `GET /api/inbox/messages/:id/guide/file`,
 * through a running Inbox's real doors with a scripted gh / glab and real git in
 * a temp folder. No real CLI or forge.
 *
 * What regresses:
 *  - anything run (gh, glab, git) while Code review is off, for an unknown PR,
 *    another site, a bad path or a fork;
 *  - a file read at the wrong commits (the base branch's tip instead of where
 *    the head left it; another head than the patch on screen), or the forge
 *    asked again for what a clone or the cache already has;
 *  - a binary or too large file, or a missing side, opening the viewer's gaps;
 *  - a passing failure (a rate limit) remembered as "no such file";
 *  - a guide's file read from anything other than the blobs its patch names:
 *    a working tree that moved on, a path the patch does not change.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxPulls, INBOX_PULL_FILE_MAX_BYTES, type PullFileGitReader } from "./inbox-pulls";
import type { RefRunner } from "./ref-cards";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const KEY = "github.com/northwind/billing-svc#412";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const REPO = { host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" };

const ghPull = (fields: Record<string, unknown> = {}) => ({
  number: 412,
  title: "PR 412",
  url: "https://github.com/northwind/billing-svc/pull/412",
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-11-03T10:00:00Z",
  mergedAt: null,
  baseRefName: "main",
  headRefName: "retry/schedule",
  headRefOid: HEAD,
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  reviewDecision: "REVIEW_REQUIRED",
  repository: { nameWithOwner: "northwind/billing-svc" },
  headRepository: { nameWithOwner: "northwind/billing-svc" },
  author: { login: "dana" },
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  commits: { nodes: [] },
  ...fields,
});

interface Scripted {
  run: RefRunner;
  /** Every `gh api` / `glab api` endpoint read, in order. */
  reads: string[];
  /** Whole-file answers, by the endpoint's path and ref. */
  files: Map<string, string>;
  /** Answer each read with this instead (a rate limit, an outage). */
  failWith: { stderr: string } | null;
  /** The PR the list answers. */
  pull: Record<string, unknown>;
  /** The commit a compare says the head left its base at. */
  mergeBase: string;
}

function scripted(pull: Record<string, unknown> = ghPull()): Scripted {
  const f: Scripted = {
    reads: [],
    files: new Map(),
    failWith: null,
    pull,
    mergeBase: BASE,
    run: async (cli, args) => {
      if (args[0] === "auth") {
        return cli === "gh"
          ? { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success", tokenSource: "keyring" }] } }), stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "not logged in", exitCode: 1 };
      }
      if (args.includes("graphql")) {
        return { stdout: JSON.stringify({ data: { viewer: { login: "dana" }, requested: { nodes: [] }, authored: { nodes: [f.pull] }, merged: { nodes: [] } } }), stderr: "", exitCode: 0 };
      }
      const endpoint = args[3]!;
      f.reads.push(endpoint);
      if (f.failWith) return { stdout: "", stderr: f.failWith.stderr, exitCode: 1 };
      if (args.includes(".merge_base_commit.sha")) return { stdout: `${f.mergeBase}\n`, stderr: "", exitCode: 0 };
      if (args.includes(".head.sha")) return { stdout: `${HEAD}\n`, stderr: "", exitCode: 0 };
      if (endpoint.endsWith("/pulls/412")) return { stdout: "the patch\n", stderr: "", exitCode: 0 };
      const file = f.files.get(endpoint);
      return file !== undefined ? { stdout: file, stderr: "", exitCode: 0 } : { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
    },
  };
  return f;
}

const fileAt = (path: string, sha: string) => `repos/northwind/billing-svc/contents/${path}?ref=${sha}`;

describe("a PR's file", () => {
  async function listed(f: Scripted, gitRead: PullFileGitReader = async () => null, now?: () => number) {
    const pulls = createInboxPulls({ run: f.run, gitRead, ...(now ? { now } : {}) });
    await pulls.list([REPO]);
    return pulls;
  }

  test("reads the head and where the head left its base (never the branch's tip), once", async () => {
    const f = scripted();
    f.files.set(fileAt("src/a.ts", HEAD), "new\n");
    f.files.set(fileAt("src/a.ts", BASE), "old\n");
    const pulls = await listed(f);
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [])).toEqual({ oldContent: "old\n", newContent: "new\n" });
    expect(f.reads).toEqual([fileAt("src/a.ts", HEAD), `repos/northwind/billing-svc/compare/main...${HEAD}?per_page=1`, fileAt("src/a.ts", BASE)]);
    // The same file again, and the page reopened: nothing more is asked of the forge.
    const asked = f.reads.length;
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [])).toEqual({ oldContent: "old\n", newContent: "new\n" });
    expect(f.reads.length).toBe(asked);
  });

  test("a local clone with the commits answers, and the forge is not asked for the file", async () => {
    const f = scripted();
    const read: string[] = [];
    const pulls = await listed(f, async (root, sha, path) => {
      read.push(`${root} ${sha} ${path}`);
      return root === "/clone-b" ? `${sha.slice(0, 1)} text\n` : null;
    });
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", ["/clone-a", "/clone-b"])).toEqual({ oldContent: "b text\n", newContent: "a text\n" });
    expect(read).toContain(`/clone-a ${HEAD} src/a.ts`);
    expect(read).toContain(`/clone-b ${BASE} src/a.ts`);
    expect(f.reads.filter((r) => r.includes("/contents/"))).toEqual([]);
  });

  test("the commit of the patch on screen, when the list is behind it", async () => {
    const f = scripted(ghPull({ headRefOid: "c".repeat(40) }));
    f.files.set(fileAt("src/a.ts", HEAD), "the patch's\n");
    f.files.set(fileAt("src/a.ts", "c".repeat(40)), "the list's\n");
    f.files.set(fileAt("src/a.ts", BASE), "old\n");
    const pulls = await listed(f);
    await pulls.diff(KEY, "layer");
    expect(pulls.readHead(KEY)).toBe(HEAD);
    expect((await pulls.fileContents(KEY, "layer", "src/a.ts", [])).newContent).toBe("the patch's\n");
  });

  test("a fork's layer, an unknown PR: nothing runs", async () => {
    const f = scripted(ghPull({ headRepository: { nameWithOwner: "dana/billing-svc" } }));
    const pulls = await listed(f);
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", ["/clone"])).toEqual({ oldContent: null, newContent: null });
    expect(f.reads).toEqual([]);
    await expect(pulls.fileContents("github.com/elsewhere/thing#9", "layer", "src/a.ts", [])).rejects.toMatchObject({ code: "pull_unknown" });
    expect(f.reads).toEqual([]);
  });

  test("no arrows when a side is gone (added, deleted, renamed), binary, or past the cap", async () => {
    const f = scripted();
    f.files.set(fileAt("added.ts", HEAD), "new\n");
    f.files.set(fileAt("deleted.ts", BASE), "old\n");
    f.files.set(fileAt("logo.png", HEAD), "PNG\u0000data");
    f.files.set(fileAt("logo.png", BASE), "PNG\u0000older");
    f.files.set(fileAt("huge.ts", HEAD), "x".repeat(INBOX_PULL_FILE_MAX_BYTES + 1));
    f.files.set(fileAt("huge.ts", BASE), "old\n");
    const pulls = await listed(f);
    for (const path of ["added.ts", "deleted.ts", "logo.png", "huge.ts"]) {
      expect(await pulls.fileContents(KEY, "layer", path, [])).toEqual({ oldContent: null, newContent: null });
    }
  });

  test("a local clone's answer that the file is too large or binary stands: the forge is not asked", async () => {
    const f = scripted();
    const pulls = await listed(f, async () => "none");
    expect(await pulls.fileContents(KEY, "layer", "huge.ts", ["/clone"])).toEqual({ oldContent: null, newContent: null });
    expect(f.reads).toEqual([]);
  });

  test("a rate limit holds the host and is not remembered as no such file", async () => {
    const f = scripted();
    f.files.set(fileAt("src/a.ts", HEAD), "new\n");
    f.files.set(fileAt("src/a.ts", BASE), "old\n");
    let clock = 1_000_000;
    const pulls = await listed(f, async () => null, () => clock);
    f.failWith = { stderr: "gh: API rate limit exceeded (HTTP 403)" };
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [])).toEqual({ oldContent: null, newContent: null });
    const asked = f.reads.length;
    expect(asked).toBeGreaterThan(0);
    // Held: asks nothing, for any file.
    expect(await pulls.fileContents(KEY, "layer", "src/b.ts", [])).toEqual({ oldContent: null, newContent: null });
    expect(f.reads.length).toBe(asked);
    // Over: the same file reads.
    f.failWith = null;
    clock += 60 * 60_000;
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [])).toEqual({ oldContent: "old\n", newContent: "new\n" });
  });

  test("GitLab: the merge request's own base commit, the raw file route", async () => {
    const mr = {
      iid: "61", title: "MR 61", webUrl: "https://gitlab.com/northwind/data/ledger/-/merge_requests/61", state: "opened", draft: false, updatedAt: "2026-11-03T10:00:00Z", mergedAt: null,
      sourceBranch: "b61", targetBranch: "main", diffHeadSha: HEAD, approved: false, detailedMergeStatus: "NOT_APPROVED", diffStatsSummary: { additions: 3, deletions: 1, fileCount: 2 },
      headPipeline: null, project: { fullPath: "northwind/data/ledger" }, sourceProject: { fullPath: "northwind/data/ledger" }, author: { username: "jun" }, approvedBy: { nodes: [] }, reviewers: { nodes: [] },
    };
    const reads: string[] = [];
    const run: RefRunner = async (cli, args) => {
      if (args[0] === "auth") return cli === "glab" ? { stdout: "gitlab.com\n  ✓ Logged in to gitlab.com as dana (keyring)\n", stderr: "", exitCode: 0 } : { stdout: "", stderr: "not logged in", exitCode: 1 };
      if (args.includes("graphql")) return { stdout: JSON.stringify({ data: { currentUser: { username: "dana", requested: { nodes: [] }, authored: { nodes: [mr] }, merged: { nodes: [] } } } }), stderr: "", exitCode: 0 };
      const endpoint = args[3]!;
      reads.push(`${cli} ${endpoint}`);
      if (endpoint === "projects/northwind%2Fdata%2Fledger/merge_requests/61") return { stdout: JSON.stringify({ diff_refs: { base_sha: BASE, head_sha: HEAD } }), stderr: "", exitCode: 0 };
      if (endpoint === `projects/northwind%2Fdata%2Fledger/repository/files/src%2Fa.ts/raw?ref=${HEAD}`) return { stdout: "new\n", stderr: "", exitCode: 0 };
      if (endpoint === `projects/northwind%2Fdata%2Fledger/repository/files/src%2Fa.ts/raw?ref=${BASE}`) return { stdout: "old\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "404 Not Found", exitCode: 1 };
    };
    const pulls = createInboxPulls({ run, gitRead: async () => null });
    await pulls.list([{ host: "gitlab.com", repo: "northwind/data/ledger", project_id: "prj_1" }]);
    expect(await pulls.fileContents("gitlab.com/northwind/data/ledger#61:pull", "layer", "src/a.ts", [])).toEqual({ oldContent: "old\n", newContent: "new\n" });
    expect(reads.every((r) => r.startsWith("glab "))).toBe(true);
  });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

async function world(options: { codeReview: boolean }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-file-contents-")));
  roots.push(root);
  const project = join(root, "billing-svc");
  mkdirSync(project, { recursive: true });
  const git = (...args: string[]) => {
    const done = Bun.spawnSync(["git", ...args], { cwd: project, env: GIT_ENV });
    if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
    return done.stdout.toString();
  };
  git("init", "-q");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const forge = scripted();
  const server = await startInboxServer({
    dataDir,
    phones: false,
    codeReview: options.codeReview,
    refRunner: forge.run,
    readProjectRepo: async () => ({ host: "github.com", display: "northwind/billing-svc" }),
  } as Parameters<typeof startInboxServer>[0]);
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const client = new Client({ name: "inbox-file-contents-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(client);
  const sendGuide = async (patch: string, files: string[], extra: Record<string, unknown> = {}) => {
    const result = (await client.callTool({
      name: "submit_guide",
      arguments: {
        project_path: project,
        patch,
        guide: { title: "T", intent: "I", sections: [{ title: "S", overview: "O", diffs: files.map((file) => ({ file, summary: "s" })) }] },
        agent_session: "ses_review",
        agent_name: "Pi",
        agent_host: "pi",
        ...extra,
      },
    })) as { isError?: boolean; content: { text: string }[]; structuredContent: { message_id: string } };
    if (result.isError) throw new Error(result.content[0]!.text);
    return result.structuredContent.message_id;
  };
  const askGuide = (id: string, path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/inbox/messages/${id}/guide/file?path=${encodeURIComponent(path)}`, { headers });
  return { project, base, forge, git, sendGuide, askGuide };
}

const NO_CONTENTS = { oldContent: null, newContent: null };
const contentsOf = async (response: Response) => {
  const { oldContent, newContent } = (await response.json()) as { oldContent: string | null; newContent: string | null };
  return { oldContent, newContent };
};

describe("the PR route", () => {
  const ask = (base: string, path: string, headers: Record<string, string> = {}, key = KEY) =>
    fetch(`${base}/api/inbox/pulls/file?key=${encodeURIComponent(key)}&scope=layer&path=${encodeURIComponent(path)}`, { headers });

  test("Code review off: 409, and nothing runs", async () => {
    const w = await world({ codeReview: false });
    const response = await ask(w.base, "src/a.ts");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("code_review_off");
    expect(w.forge.reads).toEqual([]);
  });

  test("another site, a bad path, an unknown PR, a POST: refused, and nothing is read", async () => {
    const w = await world({ codeReview: true });
    expect((await fetch(`${w.base}/api/inbox/pulls`)).status).toBe(200);
    expect((await ask(w.base, "src/a.ts", { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    for (const bad of ["../secret", "/etc/passwd", "src/../../secret", "", "a\nb"]) expect((await ask(w.base, bad)).status).toBe(422);
    expect((await ask(w.base, "src/a.ts", {}, "github.com/elsewhere/thing#9")).status).toBe(404);
    expect((await fetch(`${w.base}/api/inbox/pulls/file?key=${encodeURIComponent(KEY)}&path=a.ts`, { method: "POST" })).status).toBe(405);
    expect(w.forge.reads).toEqual([]);
  });

  test("reads through the route, from the project's clone when it has the commits", async () => {
    const w = await world({ codeReview: true });
    writeFileSync(join(w.project, "a.ts"), "old\n");
    w.git("add", ".");
    w.git("commit", "-qm", "one");
    const baseSha = w.git("rev-parse", "HEAD").trim();
    writeFileSync(join(w.project, "a.ts"), "new\n");
    w.git("commit", "-qam", "two");
    const headSha = w.git("rev-parse", "HEAD").trim();
    // The Inbox learns of the project from an agent's message, and of the PR from the list.
    await w.sendGuide(w.git("diff", `${baseSha}..${headSha}`), ["a.ts"]);
    w.forge.pull = ghPull({ headRefOid: headSha });
    w.forge.mergeBase = baseSha;
    expect((await fetch(`${w.base}/api/inbox/pulls?refresh=1`)).status).toBe(200);
    w.forge.reads.length = 0;
    const response = await ask(w.base, "a.ts");
    expect(response.status).toBe(200);
    expect(await contentsOf(response)).toEqual({ oldContent: "old\n", newContent: "new\n" });
    expect(w.forge.reads.filter((r) => r.includes("/contents/"))).toEqual([]);
  });
});

describe("a guide's file", () => {
  async function changed(w: Awaited<ReturnType<typeof world>>, before = "one\ntwo\nthree\n", after = "one\n2\nthree\n") {
    writeFileSync(join(w.project, "a.ts"), before);
    w.git("add", ".");
    w.git("commit", "-qm", "one");
    writeFileSync(join(w.project, "a.ts"), after);
    return w.git("diff");
  }

  test("Code review off: 409, and git is not asked", async () => {
    const w = await world({ codeReview: false });
    const id = await w.sendGuide(await changed(w), ["a.ts"]);
    const response = await w.askGuide(id, "a.ts");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("code_review_off");
  });

  test("another site, a bad path, no such message: refused", async () => {
    const w = await world({ codeReview: true });
    const id = await w.sendGuide(await changed(w), ["a.ts"]);
    expect((await w.askGuide(id, "a.ts", { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await w.askGuide(id, "../secret")).status).toBe(422);
    expect((await w.askGuide("msg_nothing", "a.ts")).status).toBe(404);
  });

  test("uncommitted edits: the old side from git, the new from the tree while it is the file the patch names", async () => {
    const w = await world({ codeReview: true });
    const id = await w.sendGuide(await changed(w), ["a.ts"]);
    expect(await contentsOf(await w.askGuide(id, "a.ts"))).toEqual({ oldContent: "one\ntwo\nthree\n", newContent: "one\n2\nthree\n" });
    // The tree moved on since the diff: the guide keeps the diff as sent, with no arrows rather than the wrong lines.
    writeFileSync(join(w.project, "a.ts"), "one\n2\nthree\nand a fourth\n");
    expect(await contentsOf(await w.askGuide(id, "a.ts"))).toEqual(NO_CONTENTS);
  });

  test("committed since: both sides still read by the patch's own blobs", async () => {
    const w = await world({ codeReview: true });
    const patch = await changed(w);
    w.git("add", ".");
    const id = await w.sendGuide(patch, ["a.ts"]);
    w.git("commit", "-qm", "two");
    writeFileSync(join(w.project, "a.ts"), "something else entirely\n");
    expect(await contentsOf(await w.askGuide(id, "a.ts"))).toEqual({ oldContent: "one\ntwo\nthree\n", newContent: "one\n2\nthree\n" });
  });

  test("a file the patch does not change is never read; an added, deleted or renamed one has no arrows", async () => {
    const w = await world({ codeReview: true });
    writeFileSync(join(w.project, "secret.env"), "TOKEN=1\n");
    writeFileSync(join(w.project, "gone.ts"), "gone\n");
    writeFileSync(join(w.project, "moved.ts"), "a\nb\nc\nd\ne\nf\ng\nh\n");
    const patch = await changed(w);
    w.git("rm", "-q", "gone.ts");
    w.git("mv", "moved.ts", "renamed.ts");
    writeFileSync(join(w.project, "renamed.ts"), "a\nb\nc\nd\ne\nf\ng\nH\n");
    writeFileSync(join(w.project, "added.ts"), "new\n");
    w.git("add", ".");
    const staged = w.git("diff", "--cached", "-M");
    const id = await w.sendGuide(staged, ["a.ts", "gone.ts", "renamed.ts", "added.ts"]);
    expect(patch).toContain("a.ts");
    for (const path of ["secret.env", "gone.ts", "renamed.ts", "added.ts"]) {
      expect(await contentsOf(await w.askGuide(id, path))).toEqual(NO_CONTENTS);
    }
    expect((await contentsOf(await w.askGuide(id, "a.ts"))).newContent).toBe("one\n2\nthree\n");
  });

  test("a comment on an opened line keeps what posts it in a review's main comment", async () => {
    const w = await world({ codeReview: true });
    const id = await w.sendGuide(await changed(w), ["a.ts"]);
    const annotation = { id: "ann-1", type: "comment", scope: "line", filePath: "a.ts", lineStart: 2, lineEnd: 2, side: "new", text: "Why?", outsideDiff: true, anchorText: "2", createdAt: 1 };
    const saved = await fetch(`${w.base}/api/inbox/messages/${id}/guide/annotations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ annotation }) });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { annotation: { annotation: Record<string, unknown> } }).annotation.annotation).toMatchObject({ outsideDiff: true, anchorText: "2" });
  });

  test("a binary file past the patch's own check has no arrows", async () => {
    const w = await world({ codeReview: true });
    writeFileSync(join(w.project, "a.ts"), "text\u0000one\n");
    w.git("add", ".");
    w.git("commit", "-qm", "one");
    writeFileSync(join(w.project, "a.ts"), "text\u0000two\n");
    // A text-looking patch of a file git treats as binary, as an agent could send with --text.
    const id = await w.sendGuide(w.git("diff", "--text"), ["a.ts"]);
    expect(await contentsOf(await w.askGuide(id, "a.ts"))).toEqual(NO_CONTENTS);
  });
});
