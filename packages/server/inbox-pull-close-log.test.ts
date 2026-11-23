/**
 * The board's Close and its Undo each leave one line (approval "inbox-pr-board-close-safe", so a past close can be
 * confirmed later): always in `inbox/pull-closes.jsonl`, and as `pull_close` in the debug log while it is on, with
 * what (`act`), how it ended and how the press came (the kept line also with the PR's key; the debug line, which may be
 * pasted in public, without it); the request lines name the routes as themselves. What regresses: a close or a reopen
 * with no line, a refused reopen with no line, no line with the debug log off, the PR's title in a line, which PR in the
 * debug log, or the routes logged as `/api/inbox/*\/*`.
 *
 * Starts an Inbox (one, on loopback, under a temp data dir, its gh a script): CI runs it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefRunner } from "@plannotator/shared/ref-cards";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer } from "./inbox";
import { flushInboxDebugLogs } from "./inbox-debug-log";
import { PULL_CLOSES_FILE } from "./inbox-pull-closes";
import { waitFor } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;
const REPO = "northwind/web-app";
const TITLE = "Retry sync when the token expires";
const KEY = `github.com/${REPO}#2039`;

/** A scripted gh: one open PR of the person's, its state for the route's read, and its writes. */
function fakeGh() {
  let state = "open";
  const node = {
    number: 2039, title: TITLE, url: `https://github.com/${REPO}/pull/2039`, state: "OPEN", isDraft: false, updatedAt: "2026-11-14T10:00:00Z", mergedAt: null,
    baseRefName: "main", headRefName: "b2039", headRefOid: "a".repeat(40), additions: 1, deletions: 1, changedFiles: 1, reviewDecision: null, mergeable: "MERGEABLE",
    repository: { nameWithOwner: REPO }, baseRepository: { defaultBranchRef: { name: "main" } }, headRepository: { nameWithOwner: REPO }, author: { login: "dana", avatarUrl: "" },
    reviewRequests: { nodes: [] }, latestReviews: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  };
  const run: RefRunner = async (cli, args) => {
    if (cli !== "gh") return { stdout: "", stderr: "not found", exitCode: 127 };
    if (args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }), stderr: "", exitCode: 0 };
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    if (query.includes("InboxPullsOthers")) return { stdout: JSON.stringify({ data: { viewer: { login: "dana" }, others0: { issueCount: 0, nodes: [] } } }), stderr: "", exitCode: 0 };
    if (args.includes("graphql")) {
      const open = state === "open" ? [node] : [];
      const none = { issueCount: 0, nodes: [] };
      const data = { viewer: { login: "dana" }, rateLimit: { cost: 1, remaining: 4000, resetAt: "2026-11-14T11:00:00Z" }, requested: none, assigned: none, authored: { issueCount: open.length, nodes: open }, merged: { nodes: [] }, everyRequested: none, everyAssigned: none, everyAuthored: { issueCount: open.length, nodes: open }, everyMerged: { nodes: [] } };
      return { stdout: JSON.stringify({ data }), stderr: "", exitCode: 0 };
    }
    const path = args.find((a) => /^repos\/.+\/pulls\/\d+$/.test(a));
    if (args[0] === "api" && path) {
      if (args.includes("PATCH")) {
        state = args.find((a) => a.startsWith("state="))!.slice("state=".length);
        return { stdout: "{}", stderr: "", exitCode: 0 };
      }
      return { stdout: JSON.stringify({ state, merged: false, merged_at: null, draft: false, head: { sha: "a".repeat(40) } }), stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "HTTP 404", exitCode: 1 };
  };
  return run;
}

const tailscale: TailscaleRunner = (args) => ({ status: 0, stdout: args[1] === "status" ? "{}" : "", stderr: "" });
let dataDir = "";
const sandboxWas = process.env.PLANNOTATOR_TEST_SANDBOX;
beforeAll(() => {
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pull-close-log-")));
  writeFileSync(join(dataDir, "config.json"), "{}");
});
afterAll(() => {
  if (sandboxWas === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
  else process.env.PLANNOTATOR_TEST_SANDBOX = sandboxWas;
  rmSync(dataDir, { recursive: true, force: true });
});

test("a close, its reopen and a refused reopen each write one pull_close line with the key and how it ended, never the title", async () => {
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale, codeReview: true, debug: true, refRunner: fakeGh(), readProjectRepo: async () => null });
  try {
    const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;
    const session = ((await (await fetch(at("/api/inbox/health"))).json()) as Json).serverSession as string;
    let n = 0;
    // A press in the window: its own Origin and page session.
    const press = (path: string) =>
      fetch(at(path), { method: "POST", headers: { "Content-Type": "application/json", Origin: at("") }, body: JSON.stringify({ serverSession: session, idempotency_key: `log-${++n}`, key: KEY }) });
    await waitFor("the PR on the board", async () => (((await (await fetch(at("/api/inbox/pulls?everywhere=1"))).json()) as Json).pulls as Json[]).some((p) => p.key === KEY));

    expect((await press("/api/inbox/pulls/close")).status).toBe(200);
    expect((await press("/api/inbox/pulls/reopen")).status).toBe(200);
    // Reopened already: the server takes no second reopen, and says so in the log too.
    expect((await press("/api/inbox/pulls/reopen")).status).toBe(409);

    await flushInboxDebugLogs();
    const text = readFileSync(join(dataDir, "inbox", "debug.log"), "utf8");
    // The debug log may be pasted in public: no title, and not which PR either.
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain(REPO);
    const all = text.trim().split("\n").map((line) => JSON.parse(line) as Json);
    const closes = all.filter((line) => line.ev === "pull_close");
    expect(closes.map(({ act, key, ok, status, code, via, by }) => ({ act, key, ok, status, code, via, by }))).toEqual([
      { act: "close", key: undefined, ok: true, status: 200, code: undefined, via: "local", by: "window" },
      { act: "reopen", key: undefined, ok: true, status: 200, code: undefined, via: "local", by: "window" },
      { act: "reopen", key: undefined, ok: false, status: 409, code: "reopen_not_closed_here", via: "local", by: "window" },
    ]);
    for (const line of closes) expect(typeof line.t).toBe("number");
    // The same three, kept in their own file, with which PR.
    const kept = keptLines(dataDir);
    expect(kept.map(({ act, key, ok, code }) => ({ act, key, ok, code }))).toEqual(closes.map(({ act, ok, code }) => ({ act, key: KEY, ok, code })));
    for (const line of kept) expect(typeof line.t).toBe("number");
    const routes = all.filter((line) => line.ev === "req_start").map((line) => line.route);
    expect(routes).toContain("/api/inbox/pulls/close");
    expect(routes).toContain("/api/inbox/pulls/reopen");
  } finally {
    server.stop();
  }
});

test("with the debug log off, a close still keeps its line in pull-closes.jsonl, and no debug log is written", async () => {
  const dir = join(dataDir, "off");
  mkdirSync(dir);
  writeFileSync(join(dir, "config.json"), "{}");
  const server = await startInboxServer({ dataDir: dir, binaryPath: null, phones: false, tailscale, codeReview: true, debug: false, refRunner: fakeGh(), readProjectRepo: async () => null });
  try {
    const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;
    const session = ((await (await fetch(at("/api/inbox/health"))).json()) as Json).serverSession as string;
    await waitFor("the PR on the board", async () => (((await (await fetch(at("/api/inbox/pulls?everywhere=1"))).json()) as Json).pulls as Json[]).some((p) => p.key === KEY));
    const res = await fetch(at("/api/inbox/pulls/close"), { method: "POST", headers: { "Content-Type": "application/json", Origin: at("") }, body: JSON.stringify({ serverSession: session, idempotency_key: "off-1", key: KEY }) });
    expect(res.status).toBe(200);
    expect(keptLines(dir).map(({ act, key, ok }) => ({ act, key, ok }))).toEqual([{ act: "close", key: KEY, ok: true }]);
    expect(readFileSync(join(dir, "inbox", PULL_CLOSES_FILE), "utf8")).not.toContain(TITLE);
    expect(existsSync(join(dir, "inbox", "debug.log"))).toBe(false);
  } finally {
    server.stop();
  }
});

function keptLines(dir: string): Json[] {
  return readFileSync(join(dir, "inbox", PULL_CLOSES_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Json);
}
