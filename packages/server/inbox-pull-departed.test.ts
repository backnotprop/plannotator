/**
 * What is open stays open, on the server's side (the owner, 2026-11-23): a PR the window has open keeps answering its
 * reads when the list stops naming it, and a host whose sign-in check fails for a moment keeps its PRs. In process,
 * with a scripted gh (`run`): no real CLI, no forge, no Inbox.
 *
 * What regresses:
 *  - a PR that left the list (someone else merged it) answering its diff or details with `404 pull_unknown`, so the
 *    open page loses what it reads next;
 *  - that PR coming back into the list, or still served once hidden, once its host is really signed out, past its
 *    age or past the count;
 *  - a `gh auth status` that fails for a moment (its token not checked: the Mac just woke) dropping the host's PRs
 *    and the open page's reads; a real sign-out (no login left for the host) not dropping them at once, or a host
 *    kept through failed checks for ever.
 */
import { expect, test } from "bun:test";
import { createInboxPulls, INBOX_PULLS_FRESH_MS, InboxPullsError } from "./inbox-pulls";
import { INBOX_PULLS_DEPARTED_MAX, INBOX_PULLS_DEPARTED_MS } from "./inbox-pull-departed";
import { INBOX_PULLS_SIGNED_KEEP_MS } from "./inbox-pull-signed-keep";
import type { RefRunner } from "./ref-cards";

const REPO = "northwind/billing-svc";
const repos = [{ host: "github.com", repo: REPO, project_id: "prj_1" }];
const keyOf = (n: number) => `github.com/${REPO}#${n}`;

const ghPull = (number: number) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/${REPO}/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-11-03T10:00:00Z",
  mergedAt: null,
  baseRefName: "main",
  headRefName: `branch-${number}`,
  headRefOid: String(number).padStart(40, "a"),
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  reviewDecision: "REVIEW_REQUIRED",
  repository: { nameWithOwner: REPO },
  headRepository: { nameWithOwner: REPO },
  author: { login: "tomas" },
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
});

const SIGNED_IN = JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } });
/** The login is there; its token could not be checked (no network yet). */
const CHECK_FAILED = JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "timeout" }] } });
/** `gh auth logout`: no login left for the host. */
const SIGNED_OUT = JSON.stringify({ hosts: {} });

/** gh answering the list with `listed`, each PR's head and patch, and `auth` for the sign-in check. */
function forge() {
  const f = {
    listed: [880, 881] as number[],
    auth: { stdout: SIGNED_IN, stderr: "", exitCode: 0 },
    authChecks: 0,
    calls: [] as string[][],
    run: (async (cli, args) => {
      f.calls.push([cli, ...args]);
      if (cli === "glab") return { stdout: "", stderr: "No hosts logged in", exitCode: 1 };
      if (args[0] === "auth") {
        f.authChecks += 1;
        return f.auth;
      }
      if (args.includes("graphql")) {
        if (args.some((a) => a.startsWith("query=query InboxPullsOthers"))) return { stdout: JSON.stringify({ data: { viewer: { login: "dana" }, others0: { issueCount: 0, nodes: [] } } }), stderr: "", exitCode: 0 };
        return { stdout: JSON.stringify({ data: { viewer: { login: "dana" }, requested: { nodes: f.listed.map(ghPull) }, authored: { nodes: [] }, merged: { nodes: [] } } }), stderr: "", exitCode: 0 };
      }
      if (args.includes("--jq")) {
        const number = String(args[3]!.split("/").at(-1));
        return { stdout: `${JSON.stringify({ sha: number.padStart(40, "a"), body: null })}\n`, stderr: "", exitCode: 0 };
      }
      if (args[0] === "api") return { stdout: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+${args[3]}\n`, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    }) as RefRunner,
  };
  return f;
}

/** What a read for `key` answers: "read" when it reached the forge's answer, else the error's code. */
async function diffOf(pulls: ReturnType<typeof createInboxPulls>, key: string): Promise<string> {
  try {
    const answer = await pulls.diff(key, "layer");
    return answer.patch.length > 0 ? "read" : "empty";
  } catch (cause) {
    return cause instanceof InboxPullsError ? cause.code : String(cause);
  }
}
async function detailsOf(pulls: ReturnType<typeof createInboxPulls>, key: string): Promise<string> {
  try {
    await pulls.details(key);
    return "read";
  } catch (cause) {
    // A read that went to the forge and failed there is not "unknown": the page still reads it.
    return cause instanceof InboxPullsError ? (cause.code === "pull_unknown" ? "pull_unknown" : "asked") : String(cause);
  }
}

test("a PR that left the list still answers its diff and details, and is never listed again", async () => {
  let now = 1_000_000;
  const f = forge();
  const pulls = createInboxPulls({ run: f.run, now: () => now });
  expect((await pulls.list(repos)).pulls.map((p) => p.number)).toEqual([880, 881]);
  // Someone else merged #881: the next read no longer names it.
  f.listed = [880];
  now += INBOX_PULLS_FRESH_MS;
  const next = await pulls.list(repos, { refresh: true });
  expect(next.pulls.map((p) => p.number)).toEqual([880]);
  expect(await diffOf(pulls, keyOf(881))).toBe("read");
  expect(await detailsOf(pulls, keyOf(881))).not.toBe("pull_unknown");
  // Not a PR the list knows for anything else.
  expect(pulls.find(keyOf(881))).toBeNull();
  // A PR the list never named is still unknown.
  expect(await diffOf(pulls, keyOf(999))).toBe("pull_unknown");
  // Listed again, then gone again: it is the list's while listed.
  f.listed = [880, 881];
  now += INBOX_PULLS_FRESH_MS;
  expect((await pulls.list(repos, { refresh: true })).pulls.map((p) => p.number)).toEqual([880, 881]);
});

test("never once hidden, once its project is removed, past its age, or past the count", async () => {
  let now = 1_000_000;
  const hidden = new Set<string>();
  const f = forge();
  f.listed = Array.from({ length: INBOX_PULLS_DEPARTED_MAX + 2 }, (_, i) => 100 + i);
  const pulls = createInboxPulls({ run: f.run, now: () => now, hidden: (key) => hidden.has(key) });
  await pulls.list(repos);
  f.listed = [];
  now += INBOX_PULLS_FRESH_MS;
  await pulls.list(repos, { refresh: true });
  // The oldest go past the count: the first two of this read are not kept.
  expect(await diffOf(pulls, keyOf(100))).toBe("pull_unknown");
  expect(await diffOf(pulls, keyOf(101))).toBe("pull_unknown");
  expect(await diffOf(pulls, keyOf(102))).toBe("read");
  hidden.add(keyOf(103));
  expect(await diffOf(pulls, keyOf(103))).toBe("pull_unknown");
  now += INBOX_PULLS_DEPARTED_MS + 1;
  expect(await diffOf(pulls, keyOf(104))).toBe("pull_unknown");
});

test("never once its project is removed, though its host is still read", async () => {
  let now = 1_000_000;
  const f = forge();
  const pulls = createInboxPulls({ run: f.run, now: () => now });
  const web = { host: "github.com", repo: "northwind/web-app", project_id: "prj_2" };
  await pulls.list([...repos, web]);
  // billing-svc's project removed: the next read is of web-app only, on the same host.
  now += INBOX_PULLS_FRESH_MS;
  expect((await pulls.list([web], { refresh: true })).pulls).toEqual([]);
  expect(await diffOf(pulls, keyOf(880))).toBe("pull_unknown");
});

test("a failed sign-in check keeps the host's PRs; a real sign-out drops them at once", async () => {
  let now = 1_000_000;
  const f = forge();
  const pulls = createInboxPulls({ run: f.run, now: () => now });
  expect((await pulls.list(repos)).pulls).toHaveLength(2);
  // The Mac just woke: gh has the login but could not check its token. The next check, after the auth cache.
  f.auth = { stdout: CHECK_FAILED, stderr: "", exitCode: 1 };
  now += 6 * 60_000;
  const woke = await pulls.list(repos, { refresh: true });
  expect(woke.pulls.map((p) => p.number)).toEqual([880, 881]);
  expect(woke.unsigned).toEqual([]);
  expect(await diffOf(pulls, keyOf(880))).toBe("read");
  // gh itself failing with nothing to read counts the same.
  f.auth = { stdout: "", stderr: "context deadline exceeded", exitCode: 1 };
  now += 60_000;
  expect((await pulls.list(repos, { refresh: true })).pulls).toHaveLength(2);
  // Checked again on the short clock while kept.
  const checks = f.authChecks;
  now += 31_000;
  await pulls.list(repos);
  expect(f.authChecks).toBeGreaterThan(checks);
  // Failing for longer than the keep: gone.
  now += INBOX_PULLS_SIGNED_KEEP_MS;
  const long = await pulls.list(repos, { refresh: true });
  expect(long.pulls).toEqual([]);
  expect(long.unsigned).toEqual(["github.com"]);

  // Signed in again, then signed out for real: gone on the next check.
  f.auth = { stdout: SIGNED_IN, stderr: "", exitCode: 0 };
  now += 6 * 60_000;
  expect((await pulls.list(repos, { refresh: true })).pulls).toHaveLength(2);
  f.auth = { stdout: SIGNED_OUT, stderr: "", exitCode: 0 };
  now += 6 * 60_000;
  const out = await pulls.list(repos, { refresh: true });
  expect(out.pulls).toEqual([]);
  expect(out.unsigned).toEqual(["github.com"]);
  // And its PRs are not read for an open page either: the host is not asked any more.
  expect(await diffOf(pulls, keyOf(880))).toBe("pull_unknown");
});
