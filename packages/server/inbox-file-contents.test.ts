/** The expand arrows' whole files in the Inbox, through a running Inbox's real doors with a scripted gh / glab and real git in a temp folder. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildGuideSnapshot } from "@plannotator/core/guide-format";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxPulls, gitBlobId, INBOX_PULL_FILE_MAX_BYTES, type PullFileGitReader } from "./inbox-pulls";
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

const blobId = (text: string) => gitBlobId(Buffer.from(text, "utf8")).slice(0, 10);
const idsOf = (oldText: string, newText: string) => ({ oldId: blobId(oldText), newId: blobId(newText) });
const IDS = idsOf("old\n", "new\n");
const KEY = "github.com/northwind/billing-svc#412";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const REPO = { host: "github.com", repo: "northwind/billing-svc", project_id: "prj_1" };
const PULL_NOW_JQ = "{sha: .head.sha, body: .body} | tojson";

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
  reads: string[];
  files: Map<string, string>;
  failWith: { stderr: string } | null;
  pull: Record<string, unknown>;
  mergeBase: string;
  patch: string;
  headNow: string;
}

function scripted(pull: Record<string, unknown> = ghPull()): Scripted {
  const f: Scripted = {
    reads: [],
    files: new Map(),
    failWith: null,
    pull,
    mergeBase: BASE,
    patch: "the patch\n",
    headNow: HEAD,
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
      if (args.includes(".head.sha")) return { stdout: `${f.headNow}\n`, stderr: "", exitCode: 0 };
      if (args.includes(PULL_NOW_JQ)) return { stdout: `${JSON.stringify({ sha: f.headNow, body: "" })}\n`, stderr: "", exitCode: 0 };
      if (endpoint.endsWith("/pulls/412")) return { stdout: f.patch, stderr: "", exitCode: 0 };
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
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual({ oldContent: "old\n", newContent: "new\n" });
    expect(f.reads).toEqual([fileAt("src/a.ts", HEAD), `repos/northwind/billing-svc/compare/main...${HEAD}?per_page=1`, fileAt("src/a.ts", BASE)]);
    const asked = f.reads.length;
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual({ oldContent: "old\n", newContent: "new\n" });
    expect(f.reads.length).toBe(asked);
  });

  test("the whole stack: the list's head, and where it left the stack's base", async () => {
    const f = scripted();
    f.files.set(fileAt("src/a.ts", HEAD), "new\n");
    f.files.set(fileAt("src/a.ts", BASE), "old\n");
    const pulls = await listed(f);
    expect(await pulls.fileContents(KEY, "stack", "src/a.ts", [], IDS)).toEqual({ oldContent: "old\n", newContent: "new\n" });
    expect(f.reads).toContain(`repos/northwind/billing-svc/compare/main...${HEAD}?per_page=1`);
  });

  test("a local clone with the commits answers, and the forge is not asked for the file", async () => {
    const f = scripted();
    const read: string[] = [];
    const pulls = await listed(f, async (root, sha, path) => {
      read.push(`${root} ${sha} ${path}`);
      return root === "/clone-b" ? `${sha.slice(0, 1)} text\n` : null;
    });
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", ["/clone-a", "/clone-b"], idsOf("b text\n", "a text\n"))).toEqual({ oldContent: "b text\n", newContent: "a text\n" });
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
    expect((await pulls.fileContents(KEY, "layer", "src/a.ts", [], idsOf("old\n", "the patch's\n"))).newContent).toBe("the patch's\n");
  });

  test("a text that is not the patch's own file opens nothing, even at the same length", async () => {
    const f = scripted();
    f.files.set(fileAt("src/a.ts", HEAD), "NEW\n");
    f.files.set(fileAt("src/a.ts", BASE), "old\n");
    const pulls = await listed(f);
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual({ oldContent: null, newContent: null });
    f.files.set(fileAt("src/b.ts", HEAD), "new\n");
    f.files.set(fileAt("src/b.ts", BASE), "OLD\n");
    expect(await pulls.fileContents(KEY, "layer", "src/b.ts", [], IDS)).toEqual({ oldContent: null, newContent: null });
  });

  test("a merged PR whose merge base is its head has both sides alike: nothing opens", async () => {
    const f = scripted();
    f.mergeBase = HEAD;
    f.files.set(fileAt("src/a.ts", HEAD), "new\n");
    const pulls = await listed(f);
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual({ oldContent: null, newContent: null });
  });

  test("a whole stack with the list behind a push: the list's head is not the patch's file", async () => {
    const f = scripted(ghPull({ headRefOid: "c".repeat(40) }));
    f.files.set(fileAt("src/a.ts", "c".repeat(40)), "an older head\n");
    f.files.set(fileAt("src/a.ts", BASE), "old\n");
    const pulls = await listed(f);
    expect(await pulls.fileContents(KEY, "stack", "src/a.ts", [], IDS)).toEqual({ oldContent: null, newContent: null });
  });

  test("a retarget keeps the head and asks where the diff runs from again", async () => {
    const f = scripted();
    f.files.set(fileAt("src/a.ts", HEAD), "new\n");
    f.files.set(fileAt("src/a.ts", BASE), "old\n");
    f.files.set(fileAt("src/a.ts", "d".repeat(40)), "older\n");
    let clock = 1_000_000;
    const pulls = await listed(f, async () => null, () => clock);
    expect((await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).oldContent).toBe("old\n");
    f.pull = ghPull({ baseRefName: "release" });
    f.mergeBase = "d".repeat(40);
    clock += 60 * 60_000;
    await pulls.list([REPO], { refresh: true });
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], idsOf("older\n", "new\n"))).toEqual({ oldContent: "older\n", newContent: "new\n" });
    expect(f.reads).toContain(`repos/northwind/billing-svc/compare/release...${HEAD}?per_page=1`);
  });

  test("a head that moved during the diff's read is not remembered: files read at the list's head, then at the next head that held", async () => {
    const f = scripted();
    let heads = 0;
    const sequence = ["c", "e", "d", "d", "f", "g"];
    const run: RefRunner = (cli, args) =>
      args.includes(PULL_NOW_JQ)
        ? Promise.resolve({ stdout: `${JSON.stringify({ sha: sequence[heads++]!.repeat(40), body: "" })}\n`, stderr: "", exitCode: 0 })
        : f.run(cli, args);
    let clock = 1_000_000;
    const pulls = createInboxPulls({ run, gitRead: async () => null, now: () => clock });
    await pulls.list([REPO]);
    expect((await pulls.diff(KEY, "layer")).head_sha).toBeNull();
    f.reads.length = 0;
    await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS);
    expect(f.reads.some((read) => read.endsWith(`ref=${"a".repeat(40)}`))).toBe(true);
    clock += 3_600_000;
    expect((await pulls.diff(KEY, "layer")).head_sha).toBe("d".repeat(40));
    f.reads.length = 0;
    await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS);
    expect(f.reads.some((read) => read.endsWith(`ref=${"d".repeat(40)}`))).toBe(true);
    clock += 3_600_000;
    expect((await pulls.diff(KEY, "layer")).head_sha).toBeNull();
    expect(pulls.readHead(KEY)).toBe("d".repeat(40));
  });

  test("a patch that names no blobs (GitLab's whole stack): no arrows, and nothing runs", async () => {
    const f = scripted();
    const pulls = await listed(f);
    expect(await pulls.fileContents(KEY, "stack", "src/a.ts", ["/clone"], null)).toEqual({ oldContent: null, newContent: null });
    expect(f.reads).toEqual([]);
  });

  test("the cache of texts stays within its bound: the oldest is read again", async () => {
    const f = scripted();
    // Each under the 5 MB a file may be; fourteen of them pass the 64 MB kept.
    const paths = Array.from({ length: 14 }, (_, i) => `f${i}.ts`);
    for (const path of paths) f.files.set(fileAt(path, HEAD), `${path}${"x".repeat(4_900_000)}`);
    const pulls = await listed(f);
    for (const path of paths) await pulls.fileContents(KEY, "layer", path, [], IDS);
    const asked = () => f.reads.filter((read) => read === fileAt("f0.ts", HEAD)).length;
    expect(asked()).toBe(1);
    await pulls.fileContents(KEY, "layer", "f0.ts", [], IDS);
    expect(asked()).toBe(2);
    await pulls.fileContents(KEY, "layer", "f13.ts", [], IDS);
    expect(f.reads.filter((read) => read === fileAt("f13.ts", HEAD)).length).toBe(1);
  });

  test("a fork's layer reads from the base repository, where its commits are reachable by id", async () => {
    const f = scripted(ghPull({ headRepository: { nameWithOwner: "dana/billing-svc" } }));
    f.files.set(fileAt("src/a.ts", HEAD), "new\n");
    f.files.set(fileAt("src/a.ts", BASE), "old\n");
    const pulls = await listed(f);
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual({ oldContent: "old\n", newContent: "new\n" });
    f.files.set(fileAt("src/b.ts", HEAD), "something else\n");
    f.files.set(fileAt("src/b.ts", BASE), "old\n");
    expect(await pulls.fileContents(KEY, "layer", "src/b.ts", [], IDS)).toEqual({ oldContent: null, newContent: null });
  });

  test("a renamed file's old side is read at its old path", async () => {
    const f = scripted();
    f.files.set(fileAt("src/new-name.ts", HEAD), "new\n");
    f.files.set(fileAt("src/old-name.ts", BASE), "old\n");
    const pulls = await listed(f);
    expect(await pulls.fileContents(KEY, "layer", "src/new-name.ts", [], IDS, "src/old-name.ts")).toEqual({ oldContent: "old\n", newContent: "new\n" });
  });

  test("a rename's old path that leaves the repository: nothing is read, whatever it names", async () => {
    const f = scripted();
    f.files.set(fileAt("after.ts", HEAD), "new\n");
    const pulls = await listed(f);
    f.reads.length = 0;
    for (const oldPath of ["../../../../user", "/etc/passwd", "src/../../x", "..\\..\\user"]) {
      expect(await pulls.fileContents(KEY, "layer", "after.ts", [], IDS, oldPath)).toEqual({ oldContent: null, newContent: null });
    }
    expect(f.reads).toEqual([]);
  });

  describe("an answer of nothing is not kept: the next click opens the file", () => {
    const opens = { oldContent: "old\n", newContent: "new\n" };
    const nothing = { oldContent: null, newContent: null };

    test("the head's text: a 404", async () => {
      const f = scripted();
      f.files.set(fileAt("src/a.ts", BASE), "old\n");
      const pulls = await listed(f);
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual(nothing);
      f.files.set(fileAt("src/a.ts", HEAD), "new\n");
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual(opens);
    });

    test("the head's text: an empty answer with exit 0", async () => {
      const f = scripted();
      f.files.set(fileAt("src/a.ts", HEAD), "");
      f.files.set(fileAt("src/a.ts", BASE), "old\n");
      const pulls = await listed(f);
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual(nothing);
      f.files.set(fileAt("src/a.ts", HEAD), "new\n");
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual(opens);
    });

    test("the old side's text: a 404, then an empty answer", async () => {
      const f = scripted();
      f.files.set(fileAt("src/a.ts", HEAD), "new\n");
      const pulls = await listed(f);
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual(nothing);
      f.files.set(fileAt("src/a.ts", BASE), "");
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual(nothing);
      f.files.set(fileAt("src/a.ts", BASE), "old\n");
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual(opens);
    });

    test("where the head left its base: an empty answer with exit 0", async () => {
      const f = scripted();
      f.files.set(fileAt("src/a.ts", HEAD), "new\n");
      f.files.set(fileAt("src/a.ts", BASE), "old\n");
      f.mergeBase = "";
      const pulls = await listed(f);
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual(nothing);
      f.mergeBase = BASE;
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual(opens);
    });

    test("where the head left its base: a 404", async () => {
      const f = scripted();
      f.files.set(fileAt("src/a.ts", BASE), "old\n");
      const pulls = await listed(f, async (_root, sha) => (sha === HEAD ? "new\n" : null));
      f.failWith = { stderr: "gh: Not Found (HTTP 404)" };
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", ["/clone"], IDS)).toEqual(nothing);
      f.failWith = null;
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", ["/clone"], IDS)).toEqual(opens);
    });

    test("a text that came back is still kept", async () => {
      const f = scripted();
      f.files.set(fileAt("src/a.ts", BASE), "old\n");
      const pulls = await listed(f, async (_root, sha) => (sha === HEAD ? "new\n" : null));
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", ["/clone"], IDS)).toEqual(opens);
      f.reads.length = 0;
      expect(await pulls.fileContents(KEY, "layer", "src/a.ts", ["/clone"], IDS)).toEqual(opens);
      expect(f.reads).toEqual([]);
    });
  });

  test("an unknown PR: nothing runs", async () => {
    const f = scripted();
    const pulls = await listed(f);
    await expect(pulls.fileContents("github.com/elsewhere/thing#9", "layer", "src/a.ts", [], IDS)).rejects.toMatchObject({ code: "pull_unknown" });
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
      expect(await pulls.fileContents(KEY, "layer", path, [], IDS)).toEqual({ oldContent: null, newContent: null });
    }
  });

  test("a local clone's answer that the file is too large or binary stands: the forge is not asked", async () => {
    const f = scripted();
    const pulls = await listed(f, async () => "none");
    expect(await pulls.fileContents(KEY, "layer", "huge.ts", ["/clone"], IDS)).toEqual({ oldContent: null, newContent: null });
    expect(f.reads).toEqual([]);
  });

  test("a rate limit holds the host and is not remembered as no such file", async () => {
    const f = scripted();
    f.files.set(fileAt("src/a.ts", HEAD), "new\n");
    f.files.set(fileAt("src/a.ts", BASE), "old\n");
    let clock = 1_000_000;
    const pulls = await listed(f, async () => null, () => clock);
    f.failWith = { stderr: "gh: API rate limit exceeded (HTTP 403)" };
    const failed = { oldContent: null, newContent: null, failed: true };
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual(failed);
    const asked = f.reads.length;
    expect(asked).toBeGreaterThan(0);
    expect(await pulls.fileContents(KEY, "layer", "src/b.ts", [], IDS)).toEqual(failed);
    expect(f.reads.length).toBe(asked);
    f.failWith = null;
    clock += 60 * 60_000;
    expect(await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS)).toEqual({ oldContent: "old\n", newContent: "new\n" });
  });

  test("the arrows' rate limit does not refuse the next layer's diff", async () => {
    const f = scripted();
    const pulls = await listed(f);
    f.failWith = { stderr: "gh: API rate limit exceeded (HTTP 403)" };
    await pulls.fileContents(KEY, "layer", "src/a.ts", [], IDS);
    f.failWith = null;
    expect((await pulls.diff(KEY, "layer")).patch).toBe("the patch\n");
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
      if (endpoint === `projects/northwind%2Fdata%2Fledger/repository/merge_base?refs%5B%5D=main&refs%5B%5D=${HEAD}`) return { stdout: JSON.stringify({ id: BASE }), stderr: "", exitCode: 0 };
      if (endpoint === `projects/northwind%2Fdata%2Fledger/repository/files/src%2Fa.ts/raw?ref=${HEAD}`) return { stdout: "new\n", stderr: "", exitCode: 0 };
      if (endpoint === `projects/northwind%2Fdata%2Fledger/repository/files/src%2Fa.ts/raw?ref=${BASE}`) return { stdout: "old\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "404 Not Found", exitCode: 1 };
    };
    const pulls = createInboxPulls({ run, gitRead: async () => null });
    await pulls.list([{ host: "gitlab.com", repo: "northwind/data/ledger", project_id: "prj_1" }]);
    expect(await pulls.fileContents("gitlab.com/northwind/data/ledger#61:pull", "layer", "src/a.ts", [], IDS)).toEqual({ oldContent: "old\n", newContent: "new\n" });
    expect(reads.every((r) => r.startsWith("glab "))).toBe(true);
    expect(await pulls.fileContents("gitlab.com/northwind/data/ledger#61:pull", "stack", "src/a.ts", [], IDS)).toEqual({ oldContent: "old\n", newContent: "new\n" });
    expect(reads).toContain(`glab projects/northwind%2Fdata%2Fledger/repository/merge_base?refs%5B%5D=main&refs%5B%5D=${HEAD}`);
  });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

async function world(options: { codeReview?: boolean; configCodeReview?: boolean; repoOf?: (root: string) => { host: string; display: string } }) {
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
  if (options.configCodeReview !== undefined) writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxCodeReview: options.configCodeReview }));
  const forge = scripted();
  const server = await startInboxServer({
    dataDir,
    phones: false,
    ...(options.codeReview !== undefined ? { codeReview: options.codeReview } : {}),
    refRunner: forge.run,
    readProjectRepo: async (root: string) => options.repoOf?.(root) ?? { host: "github.com", display: "northwind/billing-svc" },
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
    fetch(`${base}/api/inbox/pulls/file?key=${encodeURIComponent(key)}&scope=layer&path=${encodeURIComponent(path)}&old=${IDS.oldId}&new=${IDS.newId}`, { headers });

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
    await w.sendGuide(w.git("diff", `${baseSha}..${headSha}`), ["a.ts"]);
    w.forge.pull = ghPull({ headRefOid: headSha });
    w.forge.mergeBase = baseSha;
    w.forge.patch = w.git("diff", `${baseSha}..${headSha}`);
    w.forge.headNow = headSha;
    expect((await fetch(`${w.base}/api/inbox/pulls?refresh=1`)).status).toBe(200);
    w.forge.reads.length = 0;
    const response = await ask(w.base, "a.ts");
    expect(response.status).toBe(200);
    expect(await contentsOf(response)).toEqual({ oldContent: "old\n", newContent: "new\n" });
    expect(w.forge.reads.filter((r) => r.includes("/contents/"))).toEqual([]);
  });

  test("a renamed and edited file through the route: the old side comes from its old path", async () => {
    const w = await world({ codeReview: true });
    writeFileSync(join(w.project, "before.ts"), "a\nb\nc\nd\ne\nf\ng\nh\n");
    w.git("add", ".");
    w.git("commit", "-qm", "one");
    const baseSha = w.git("rev-parse", "HEAD").trim();
    w.git("mv", "before.ts", "after.ts");
    writeFileSync(join(w.project, "after.ts"), "a\nb\nc\nd\ne\nf\ng\nH\n");
    w.git("add", ".");
    w.git("commit", "-qm", "two");
    const headSha = w.git("rev-parse", "HEAD").trim();
    const patch = w.git("diff", "-M", `${baseSha}..${headSha}`);
    await w.sendGuide(patch, ["after.ts"]);
    w.forge.pull = ghPull({ headRefOid: headSha });
    w.forge.mergeBase = baseSha;
    w.forge.patch = patch;
    w.forge.headNow = headSha;
    expect((await fetch(`${w.base}/api/inbox/pulls?refresh=1`)).status).toBe(200);
    const [, oldId, newId] = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m.exec(patch)!;
    const response = await fetch(`${w.base}/api/inbox/pulls/file?key=${encodeURIComponent(KEY)}&scope=layer&path=after.ts&old=${oldId}&new=${newId}`);
    expect(await contentsOf(response)).toEqual({ oldContent: "a\nb\nc\nd\ne\nf\ng\nh\n", newContent: "a\nb\nc\nd\ne\nf\ng\nH\n" });
  });

  test("a file the diff does not change is not read, whatever blob id comes with it", async () => {
    const w = await world({ codeReview: true });
    w.forge.patch = `diff --git a/a.ts b/a.ts\nindex ${IDS.oldId}..${IDS.newId} 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n`;
    w.forge.files.set(fileAt(".env", HEAD), "new\n");
    w.forge.files.set(fileAt(".env", BASE), "old\n");
    w.forge.files.set(fileAt("a.ts", HEAD), "new\n");
    w.forge.files.set(fileAt("a.ts", BASE), "old\n");
    await w.sendGuide(w.forge.patch, ["a.ts"]);
    expect((await fetch(`${w.base}/api/inbox/pulls?refresh=1`)).status).toBe(200);
    expect(await contentsOf(await ask(w.base, ".env"))).toEqual(NO_CONTENTS);
    expect(w.forge.reads.filter((r) => r.includes(".env"))).toEqual([]);
    expect(await contentsOf(await ask(w.base, "a.ts"))).toEqual({ oldContent: "old\n", newContent: "new\n" });
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

  test("Code review off: the arrows still read the project's own blobs, and no forge is asked", async () => {
    const w = await world({ codeReview: false });
    const id = await w.sendGuide(await changed(w), ["a.ts"]);
    const response = await w.askGuide(id, "a.ts");
    expect(response.status).toBe(200);
    expect(await contentsOf(response)).toEqual({ oldContent: "one\ntwo\nthree\n", newContent: "one\n2\nthree\n" });
    expect(w.forge.reads).toEqual([]);
  });

  const PR_SOURCE = { kind: "pr", pr: { url: "https://github.com/northwind/billing-svc/pull/412", number: 412, title: "PR 412", platform: "github" } } as const;
  const patchOf = (path: string) => `diff --git a/${path} b/${path}\nindex ${IDS.oldId}..${IDS.newId} 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
  const prGuide = (w: Awaited<ReturnType<typeof world>>, path: string, project?: string, rawPatch = patchOf(path)) =>
    w.sendGuide("", [], {
      ...(project ? { project_path: project } : {}),
      patch: undefined,
      guide: undefined,
      snapshot: buildGuideSnapshot({
        guide: { title: "T", intent: "I", sections: [{ title: "S", overview: "O", diffs: [{ file: path, summary: "s" }] }] },
        review: { rawPatch, gitRef: "main...head", source: PR_SOURCE },
        reviewed: [],
      } as unknown as Parameters<typeof buildGuideSnapshot>[0]),
    });

  test("a guide of a PR with the blobs missing here: only Code review asks the forge, and only the patch's own file opens", async () => {
    const on = await world({ codeReview: true });
    on.forge.files.set(fileAt("a.ts", HEAD), "new\n");
    on.forge.files.set(fileAt("a.ts", BASE), "old\n");
    const id = await prGuide(on, "a.ts");
    expect((await fetch(`${on.base}/api/inbox/pulls?refresh=1`)).status).toBe(200);
    expect(await contentsOf(await on.askGuide(id, "a.ts"))).toEqual({ oldContent: "old\n", newContent: "new\n" });
    on.forge.files.set(fileAt("b.ts", HEAD), "NEW\n");
    on.forge.files.set(fileAt("b.ts", BASE), "old\n");
    expect(await contentsOf(await on.askGuide(await prGuide(on, "b.ts"), "b.ts"))).toEqual(NO_CONTENTS);

    const off = await world({ codeReview: false });
    off.forge.files.set(fileAt("a.ts", HEAD), "new\n");
    off.forge.files.set(fileAt("a.ts", BASE), "old\n");
    const response = await off.askGuide(await prGuide(off, "a.ts"), "a.ts");
    expect(response.status).toBe(200);
    expect(await contentsOf(response)).toEqual(NO_CONTENTS);
    expect(off.forge.reads).toEqual([]);
  });

  test("Code review turned off with the PR still listed: no forge read, and nothing served", async () => {
    const w = await world({ configCodeReview: true });
    w.forge.files.set(fileAt("a.ts", HEAD), "new\n");
    w.forge.files.set(fileAt("a.ts", BASE), "old\n");
    const id = await prGuide(w, "a.ts");
    expect((await fetch(`${w.base}/api/inbox/pulls?refresh=1`)).status).toBe(200);
    const turned = await fetch(`${w.base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code_review: { on: false } }) });
    expect(turned.status).toBe(200);
    w.forge.reads.length = 0;
    const response = await w.askGuide(id, "a.ts");
    expect(response.status).toBe(200);
    expect(await contentsOf(response)).toEqual(NO_CONTENTS);
    expect(w.forge.reads).toEqual([]);
  });

  test("a guide of a PR that renamed and edited a file reads the old side at its old path", async () => {
    const w = await world({ codeReview: true });
    w.forge.files.set(fileAt("after.ts", HEAD), "new\n");
    w.forge.files.set(fileAt("before.ts", BASE), "old\n");
    const patch = `diff --git a/before.ts b/after.ts\nsimilarity index 90%\nrename from before.ts\nrename to after.ts\nindex ${IDS.oldId}..${IDS.newId} 100644\n--- a/before.ts\n+++ b/after.ts\n@@ -1 +1 @@\n-old\n+new\n`;
    const id = await prGuide(w, "after.ts", undefined, patch);
    expect((await fetch(`${w.base}/api/inbox/pulls?refresh=1`)).status).toBe(200);
    expect(await contentsOf(await w.askGuide(id, "after.ts"))).toEqual({ oldContent: "old\n", newContent: "new\n" });
  });

  test("a guide whose patch renames from outside the repository sends no forge read there", async () => {
    const w = await world({ codeReview: true });
    w.forge.files.set(fileAt("after.ts", HEAD), "new\n");
    const patch = `diff --git a/before.ts b/after.ts\nsimilarity index 90%\nrename from ../../../../user\nrename to after.ts\nindex ${IDS.oldId}..${IDS.newId} 100644\n--- a/../../../../user\n+++ b/after.ts\n@@ -1 +1 @@\n-old\n+new\n`;
    const id = await prGuide(w, "after.ts", undefined, patch);
    expect((await fetch(`${w.base}/api/inbox/pulls?refresh=1`)).status).toBe(200);
    w.forge.reads.length = 0;
    expect(await contentsOf(await w.askGuide(id, "after.ts"))).toEqual({ oldContent: null, newContent: null });
    expect(w.forge.reads.filter((endpoint) => endpoint.includes(".."))).toEqual([]);
  });

  test("a guide in another project naming this PR reads nothing of it", async () => {
    const w = await world({ codeReview: true, repoOf: (root) => ({ host: "github.com", display: root.endsWith("billing-svc") ? "northwind/billing-svc" : "someone/third" }) });
    w.forge.files.set(fileAt("a.ts", HEAD), "new\n");
    w.forge.files.set(fileAt("a.ts", BASE), "old\n");
    const own = await prGuide(w, "a.ts");
    const third = join(w.project, "..", "third");
    mkdirSync(third, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: third, env: GIT_ENV });
    const cross = await prGuide(w, "a.ts", third);
    expect((await fetch(`${w.base}/api/inbox/pulls?refresh=1`)).status).toBe(200);
    expect(await contentsOf(await w.askGuide(own, "a.ts"))).toEqual({ oldContent: "old\n", newContent: "new\n" });
    w.forge.reads.length = 0;
    expect(await contentsOf(await w.askGuide(cross, "a.ts"))).toEqual(NO_CONTENTS);
    expect(w.forge.reads).toEqual([]);
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

  test("a file the patch does not change is never read; an added or deleted one has no arrows; a renamed one opens", async () => {
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
    for (const path of ["secret.env", "gone.ts", "added.ts"]) {
      expect(await contentsOf(await w.askGuide(id, path))).toEqual(NO_CONTENTS);
    }
    expect(await contentsOf(await w.askGuide(id, "renamed.ts"))).toEqual({ oldContent: "a\nb\nc\nd\ne\nf\ng\nh\n", newContent: "a\nb\nc\nd\ne\nf\ng\nH\n" });
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

  test("a comment on a line in no hunk: refused without the mark, kept with it, and the file must still be in the patch", async () => {
    const w = await world({ codeReview: true });
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const after = before.map((line, i) => (i === 30 ? "changed" : line));
    const id = await w.sendGuide(await changed(w, `${before.join("\n")}\n`, `${after.join("\n")}\n`), ["a.ts"]);
    const save = (annotation: Record<string, unknown>) =>
      fetch(`${w.base}/api/inbox/messages/${id}/guide/annotations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ annotation }) });
    const opened = { type: "comment", scope: "line", filePath: "a.ts", lineStart: 5, lineEnd: 5, side: "new", text: "Why?" };
    expect((await save({ ...opened, id: "ann-closed" })).status).toBe(422);
    const kept = await save({ ...opened, id: "ann-opened", outsideDiff: true, anchorText: "line 5" });
    expect(kept.status).toBe(200);
    expect(((await kept.json()) as { annotation: { annotation: Record<string, unknown> } }).annotation.annotation).toMatchObject({ lineStart: 5, outsideDiff: true });
    expect((await save({ ...opened, id: "ann-elsewhere", filePath: "b.ts", outsideDiff: true })).status).toBe(422);
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
