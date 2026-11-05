/**
 * A referenced file's text for its hover (`GET /api/inbox/open-in/file/code`): a PR's version at its head commit where
 * the scope has a PR, this computer's otherwise. The route with a scripted forge and real files in a temp folder; no
 * Inbox is started and no real CLI runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxOpenInRoute, INBOX_OPEN_IN_CODE_PATH, type InboxOpenInLauncher } from "./inbox-open-in";
import { createInboxPulls, type InboxPullFile } from "./inbox-pulls";
import type { RefRunner } from "@plannotator/shared/ref-cards";

const HEAD = "a".repeat(40);
const REPO = "northwind/billing-svc";

/** gh, as the forge answers: one open PR on `HEAD`, and `files` at that commit. */
function forge(files: Record<string, string>) {
  const calls: string[][] = [];
  const pull = {
    number: 412,
    title: "Retry",
    url: `https://github.com/${REPO}/pull/412`,
    state: "OPEN",
    isDraft: false,
    updatedAt: "2026-11-03T10:00:00Z",
    mergedAt: null,
    baseRefName: "main",
    headRefName: "retry",
    headRefOid: HEAD,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: "REVIEW_REQUIRED",
    repository: { nameWithOwner: REPO },
    headRepository: { nameWithOwner: REPO },
    author: { login: "dana" },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    commits: { nodes: [] },
  };
  const run: RefRunner = async (cli, args) => {
    calls.push([cli, ...args]);
    if (cli === "gh" && args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }), stderr: "", exitCode: 0 };
    if (cli === "gh" && args.includes("graphql")) return { stdout: JSON.stringify({ data: { viewer: { login: "dana" }, requested: { nodes: [] }, authored: { nodes: [pull] }, merged: { nodes: [] }, others0: { issueCount: 0, nodes: [] } } }), stderr: "", exitCode: 0 };
    const endpoint = args.find((arg) => arg.includes("/contents/"));
    if (cli === "gh" && endpoint) {
      const path = decodeURIComponent(endpoint.split("/contents/")[1]!.split("?")[0]!);
      if (!endpoint.endsWith(`?ref=${HEAD}`) || !(path in files)) return { stdout: "", stderr: "HTTP 404", exitCode: 1 };
      return { stdout: `${Buffer.from(files[path]!).toString("base64")}\n`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "unexpected", exitCode: 1 };
  };
  return { run, calls, contentReads: () => calls.filter((call) => call.some((arg) => arg.includes("/contents/"))) };
}

let dir: string;
let project: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "code-hover-"));
  project = join(dir, "project");
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "a.ts"), "the file on this computer\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function route(options: { codeReview?: boolean; owner?: boolean; threadPulls?: string[]; pullFile?: (pull: string, path: string) => Promise<InboxPullFile | null> } = {}) {
  const message = { id: "msg_1", thread_id: "msg_1", project_id: "prj_1", base_path: project };
  const store = {
    dir,
    message: (id: string) => (id === "msg_1" ? message : null),
    project: () => ({ root: project }),
    thread: () => ({ project: { root: project } }),
    attachment: () => null,
  } as unknown as InboxStore;
  const handle = createInboxOpenInRoute({
    store,
    serverSession: "session",
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    localOnly: () => Response.json({ code: "local_only" }, { status: 403 }),
    launcher: { platform: "linux", apps: () => [] } as unknown as InboxOpenInLauncher,
    codeReviewOn: () => options.codeReview !== false,
    shapeRoot: () => project,
    repoRoots: () => [project],
    threadPulls: () => options.threadPulls ?? [],
    pullFile: options.pullFile ?? (async () => null),
    ownerOrLocal: (_req, via) => via === "local" || options.owner === true,
    home: join(dir, "home"),
  });
  return async (query: Record<string, string>, via: "local" | "tailnet" = "local") => {
    const url = `http://localhost${INBOX_OPEN_IN_CODE_PATH}?${new URLSearchParams(query)}`;
    const response = await handle(new Request(url), INBOX_OPEN_IN_CODE_PATH, via);
    return { status: response!.status, body: (await response!.json()) as Record<string, unknown> };
  };
}

const inPull = (path: string, contents = "the file in the PR\n"): InboxPullFile => ({ contents, label: "#412", platform: "github", url: `https://github.com/${REPO}/blob/${HEAD}/${path}` });

describe("this computer's file", () => {
  test("its text, under the project's path rule", async () => {
    const ask = route();
    expect((await ask({ thread: "msg_1", path: "src/a.ts" })).body).toEqual({ found: true, contents: "the file on this computer\n" });
    expect((await ask({ thread: "msg_1", path: "src/gone.ts" })).body).toEqual({ found: false });
    expect((await ask({ thread: "msg_1", path: "../outside.ts" })).body).toEqual({ found: false });
  });

  test("never a dotenv file, a link out of the project, or what is not text", async () => {
    writeFileSync(join(project, ".env"), "SECRET=1\n");
    writeFileSync(join(dir, "outside.ts"), "outside\n");
    symlinkSync(join(dir, "outside.ts"), join(project, "src", "link.ts"));
    writeFileSync(join(project, "src", "blob.ts"), Buffer.from([0x61, 0, 0x62]));
    // Text at its start, and a NUL past what a kind is judged on.
    writeFileSync(join(project, "src", "late.ts"), `${"a".repeat(1_000_000)}\0`);
    writeFileSync(join(project, "src", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const ask = route();
    for (const path of [".env", "src/link.ts", "src/blob.ts", "src/late.ts", "src/logo.png"]) expect((await ask({ thread: "msg_1", path })).body).toEqual({ found: false });
  });
});

describe("a pull request's file", () => {
  test("a thread that owns a PR shows the PR's version, and says so, even with a copy on this computer", async () => {
    const ask = route({ threadPulls: ["key"], pullFile: async (_pull, path) => inPull(path) });
    const { body } = await ask({ thread: "msg_1", path: "src/a.ts" });
    expect(body.contents).toBe("the file in the PR\n");
    expect(body.pull).toEqual({ label: "#412", platform: "github", url: `https://github.com/${REPO}/blob/${HEAD}/src/a.ts` });
  });

  test("a file the PR does not have is this computer's", async () => {
    const ask = route({ threadPulls: ["key"], pullFile: async () => null });
    expect((await ask({ thread: "msg_1", path: "src/a.ts" })).body).toEqual({ found: true, contents: "the file on this computer\n" });
  });

  test("a PR page names its PR; a thread with no PR never asks the forge", async () => {
    const asked: string[] = [];
    const pullFile = async (pull: string, path: string) => {
      asked.push(`${pull} ${path}`);
      return inPull(path);
    };
    expect((await route({ pullFile })({ repo: REPO, pull: "the-pr", path: "src/not-here.ts" })).body.found).toBe(true);
    expect(asked).toEqual(["the-pr src/not-here.ts"]);
    await route({ pullFile })({ thread: "msg_1", path: "src/a.ts" });
    expect(asked).toHaveLength(1);
  });

  test("the forge is never asked for a path out of the project or a dotenv file", async () => {
    const asked: string[] = [];
    const ask = route({
      threadPulls: ["key"],
      pullFile: async (_pull, path) => {
        asked.push(path);
        return inPull(path);
      },
    });
    for (const path of ["../other/secrets.ts", ".env", "src/.env.local", "/etc/passwd"]) expect((await ask({ thread: "msg_1", path })).body).toEqual({ found: false });
    expect(asked).toEqual([]);
  });
});

describe("who may read", () => {
  test("off with Code review", async () => {
    const { status, body } = await route({ codeReview: false })({ thread: "msg_1", path: "src/a.ts" });
    expect(status).toBe(409);
    expect(body.code).toBe("code_review_off");
  });

  test("the owner's phone through the tailnet reads; a guest is refused", async () => {
    expect((await route({ owner: true })({ thread: "msg_1", path: "src/a.ts" }, "tailnet")).body.found).toBe(true);
    const guest = await route({ owner: false })({ thread: "msg_1", path: "src/a.ts" }, "tailnet");
    expect(guest.status).toBe(403);
    expect(guest.body.code).toBe("local_only");
  });

  test("another site's page is refused", async () => {
    const url = `http://localhost${INBOX_OPEN_IN_CODE_PATH}?thread=msg_1&path=src/a.ts`;
    const refused = await createInboxOpenInRoute({
      store: {} as InboxStore,
      serverSession: "s",
      readBody: async () => ({}),
      json: (body, status = 200) => Response.json(body, { status }),
      localOnly: () => Response.json({}, { status: 403 }),
      launcher: { platform: "linux", apps: () => [] } as unknown as InboxOpenInLauncher,
      codeReviewOn: () => true,
      shapeRoot: () => null,
      repoRoots: () => [],
      threadPulls: () => [],
      pullFile: async () => null,
      ownerOrLocal: () => true,
    })(new Request(url, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), INBOX_OPEN_IN_CODE_PATH, "local");
    expect(refused!.status).toBe(403);
  });
});

describe("InboxPulls.file: the PR's head commit, from the forge", () => {
  const repos = [{ host: "github.com", repo: REPO, project_id: "prj_1" }];
  const KEY = `github.com/${REPO}#412`;

  test("reads at the head commit with the host named, keeps it, and gives its address", async () => {
    const f = forge({ "src/a b.ts": "in the PR\n" });
    const pulls = createInboxPulls({ run: f.run });
    await pulls.list(repos);
    const file = await pulls.file(KEY, "src/a b.ts");
    expect(file).toEqual({ contents: "in the PR\n", label: "#412", platform: "github", url: `https://github.com/${REPO}/blob/${HEAD}/src/a%20b.ts` });
    expect(f.contentReads()[0]).toContain("--hostname");
    await pulls.file(KEY, "src/a b.ts");
    expect(f.contentReads()).toHaveLength(1);
  });

  test("no such file, what is not text, and a PR the list does not name: null, and the miss is kept", async () => {
    const f = forge({ "bin/tool": "a\0b" });
    const pulls = createInboxPulls({ run: f.run });
    expect(await pulls.file(KEY, "src/a.ts")).toBeNull();
    expect(f.contentReads()).toHaveLength(0);
    await pulls.list(repos);
    expect(await pulls.file(KEY, "src/a.ts")).toBeNull();
    expect(await pulls.file(KEY, "src/a.ts")).toBeNull();
    expect(f.contentReads()).toHaveLength(1);
    expect(await pulls.file(KEY, "bin/tool")).toBeNull();
  });
});
