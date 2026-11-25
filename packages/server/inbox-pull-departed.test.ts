/**
 * What is open stays open, on the server's side (the owner, 2026-11-23): a PR the window has open keeps answering its
 * reads when the list stops naming it, and a host whose sign-in check fails for a moment keeps its PRs. In process,
 * with a scripted gh (`run`): no real CLI, no forge, no Inbox.
 *
 * What regresses:
 *  - a PR that left the list (someone else merged it) answering its diff or details with `404 pull_unknown`, so the
 *    open page loses what it reads next;
 *  - that PR coming back into the list, or still served once hidden, past its age or past the count;
 *  - a `gh auth status` that fails for a moment (its token not checked: the Mac just woke) dropping the host's PRs
 *    and the open page's reads; a real sign-out (no login left for the host) not taking them off the list at once,
 *    or a host kept through failed checks for ever;
 *  - a restart while offline, or a forge down for longer than the sign-in keep, erasing the saved PRs (the open page
 *    says "gone"); a forge that did not answer read as "not yours" (`pull`), or a failed read held as an answer;
 *  - a restarted Inbox asked for a kept PR before its first list read answering none (no repository known yet), so
 *    the page open on it said "no longer in the list" once the forge was back; a forge 404 answered as a current copy;
 *  - a reload or a restart of this Inbox losing a PR that left the list (the page it had open says "no longer in the
 *    list"), or a PR no list keeps any more not read from the forge by number; the forge's merged or closed state not
 *    reaching the page; an action on a PR that left the list answered "not in the list".
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxPulls, INBOX_PULLS_FRESH_MS, InboxPullsError } from "./inbox-pulls";
import { INBOX_PULLS_DEPARTED_MAX, INBOX_PULLS_DEPARTED_MS } from "./inbox-pull-departed";
import { pullMissingAnswer } from "./inbox-pull-missing";
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
    /** PRs the forge says are merged. */
    merged: new Set<number>(),
    auth: { stdout: SIGNED_IN, stderr: "", exitCode: 0 },
    authChecks: 0,
    /** The forge does not answer (offline): every read fails, the sign-in check too. */
    down: false,
    /** PRs the forge says it has no such of (`HTTP 404`). */
    missing: new Set<number>(),
    calls: [] as string[][],
    run: (async (cli, args) => {
      f.calls.push([cli, ...args]);
      if (cli === "glab") return { stdout: "", stderr: "No hosts logged in", exitCode: 1 };
      if (args[0] === "auth") {
        f.authChecks += 1;
        return f.down ? { stdout: "", stderr: "error connecting to api.github.com", exitCode: 1 } : f.auth;
      }
      if (f.down) return { stdout: "", stderr: "error connecting to api.github.com\ncheck your internet connection", exitCode: 1 };
      if (args.includes("--jq") && f.missing.has(Number(args[3]!.split("/").at(-1)))) return { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
      if (args.includes("graphql")) {
        if (args.some((a) => a.startsWith("query=query InboxPullsOthers"))) return { stdout: JSON.stringify({ data: { viewer: { login: "dana" }, others0: { issueCount: 0, nodes: [] } } }), stderr: "", exitCode: 0 };
        return { stdout: JSON.stringify({ data: { viewer: { login: "dana" }, requested: { nodes: f.listed.map(ghPull) }, authored: { nodes: [] }, merged: { nodes: [] } } }), stderr: "", exitCode: 0 };
      }
      if (args.includes("--jq")) {
        const number = String(args[3]!.split("/").at(-1));
        const sha = number.padStart(40, "a");
        // The PR as the forge has it now: one answer for the diff's head read and for a read of the PR itself.
        const merged = f.merged.has(Number(number));
        const state = { state: merged ? "closed" : "open", merged, merged_at: merged ? "2026-11-03T12:00:00Z" : null, draft: false };
        const whole = { number: Number(number), html_url: `https://github.com/${REPO}/pull/${number}`, title: `PR ${number}`, user: { login: "tomas" }, base: { ref: "main" }, head: { ref: `branch-${number}`, sha, repo: { full_name: REPO } }, additions: 1, deletions: 1, changed_files: 1, updated_at: "2026-11-03T12:00:00Z", requested_reviewers: [] };
        return { stdout: `${JSON.stringify({ sha, body: null, ...state, ...whole })}\n`, stderr: "", exitCode: 0 };
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

test("a failed sign-in check keeps the host's PRs listed; a real sign-out takes them off the list at once", async () => {
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
  // A page open on one of them keeps it (only its age drops it): a read for it goes on, never "not in the list".
  expect(pulls.held(keyOf(880))?.number).toBe(880);
  expect(await diffOf(pulls, keyOf(880))).not.toBe("pull_unknown");
});

/** The PR numbers saved on disk as kept since they left. */
const savedNumbers = (dir: string): number[] => (JSON.parse(readFileSync(join(dir, "pull-departed.json"), "utf8")) as { pulls: { pull: { number: number } }[] }).pulls.map((e) => e.pull.number).sort();

test("a restart while offline, or a forge down past the sign-in keep, keeps every saved PR; only the age drops one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-pull-departed-"));
  try {
    let now = 1_000_000;
    const f = forge();
    const first = createInboxPulls({ run: f.run, now: () => now, dir });
    await first.list(repos);
    f.listed = [880];
    now += INBOX_PULLS_FRESH_MS;
    await first.list(repos, { refresh: true });
    expect(savedNumbers(dir)).toEqual([881]);

    // Restarted offline: the first sign-in check fails, with no good check on record. The host is not asked.
    f.down = true;
    const offline = createInboxPulls({ run: f.run, now: () => now, dir });
    expect((await offline.list(repos)).unsigned).toEqual(["github.com"]);
    expect(savedNumbers(dir)).toEqual([881]);
    expect(offline.held(keyOf(881))?.number).toBe(881);

    // Back online, both listed; then the forge is down for longer than the sign-in keep.
    f.down = false;
    f.listed = [880, 881];
    const online = createInboxPulls({ run: f.run, now: () => now, dir });
    expect((await online.list(repos)).pulls).toHaveLength(2);
    f.down = true;
    now += INBOX_PULLS_SIGNED_KEEP_MS + 6 * 60_000;
    expect((await online.list(repos, { refresh: true })).unsigned).toEqual(["github.com"]);
    expect(online.held(keyOf(880))?.number).toBe(880);
    expect(online.held(keyOf(881))?.number).toBe(881);
    expect(savedNumbers(dir)).toEqual([880, 881]);
    // Another restart, still offline: still kept.
    const again = createInboxPulls({ run: f.run, now: () => now, dir });
    await again.list(repos);
    expect(again.held(keyOf(880))?.number).toBe(880);
    // Past their age: gone.
    now += INBOX_PULLS_DEPARTED_MS + 1;
    expect(again.held(keyOf(880))).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pull() tells a forge that did not answer from a PR that is not yours or not there", async () => {
  let now = 1_000_000;
  const f = forge();
  const pulls = createInboxPulls({ run: f.run, now: () => now });
  await pulls.list(repos);
  f.listed = [880];
  now += INBOX_PULLS_FRESH_MS;
  await pulls.list(repos, { refresh: true });
  // The forge goes quiet: #881 (kept since it left) answers its kept copy, flagged; #777 (never kept) answers none, flagged.
  f.down = true;
  expect(await pulls.pull(keyOf(881))).toMatchObject({ pull: { number: 881 }, unreadable: true });
  expect(await pulls.pull(keyOf(777))).toEqual({ pull: null, unreadable: true });
  // Not yours (a repository no list shows) is never "unreadable", and never asked of the forge.
  const asked = f.calls.length;
  expect(await pulls.pull("github.com/elsewhere/other#5")).toEqual({ pull: null });
  expect(f.calls.length).toBe(asked);
  // A failed read is not held: the next ask goes to the forge again, and reads it once it answers.
  f.down = false;
  f.merged.add(777);
  expect(await pulls.pull(keyOf(777))).toMatchObject({ pull: { number: 777, state: "merged" } });
  expect((await pulls.pull(keyOf(777))).unreadable).toBeUndefined();
  // The forge answering that it has no such PR is not "unreadable": it is `missing`.
  f.missing.add(778);
  expect(await pulls.pull(keyOf(778))).toEqual({ pull: null, missing: true });
});

test("a restart keeps a PR that left the list readable, and one no list kept is read from the forge, merged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-pull-departed-"));
  try {
    let now = 1_000_000;
    const f = forge();
    const before = createInboxPulls({ run: f.run, now: () => now, dir });
    await before.list(repos);
    f.listed = [880];
    f.merged.add(881);
    now += INBOX_PULLS_FRESH_MS;
    await before.list(repos, { refresh: true });
    expect(statSync(join(dir, "pull-departed.json")).mode & 0o777).toBe(0o600);
    // This Inbox restarts; the window reloads on #881's page.
    const after = createInboxPulls({ run: f.run, now: () => now, dir });
    await after.list(repos);
    expect(await diffOf(after, keyOf(881))).toBe("read");
    // An action on it: no longer open (`pull_closed`), never "not in the list".
    expect(after.held(keyOf(881))?.number).toBe(881);
    expect(after.find(keyOf(881))).toBeNull();
    // The page asks for it: the forge's answer, merged.
    expect((await after.pull(keyOf(881))).pull?.state).toBe("merged");
    // A PR of a project's repository that no list ever named (merged before this Inbox read it): read by number.
    f.merged.add(777);
    const read = await after.pull(keyOf(777));
    expect(read.pull).toMatchObject({ number: 777, state: "merged", checks: null });
    expect(await diffOf(after, keyOf(777))).toBe("read");
    expect((await after.list(repos)).pulls.map((p) => p.number)).toEqual([880]);
    // Never one of a repository no list shows.
    expect((await after.pull("github.com/elsewhere/other#5")).pull).toBeNull();
    expect(f.calls.some((c) => c.join(" ").includes("elsewhere/other"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one list stops naming a PR while the other's older read still does: pull() asks the forge, merged, not the older open copy", async () => {
  let now = 1_000_000;
  const f = forge();
  // One read answers both lists: the everywhere searches (`everyRequested`) name what Reviews' do.
  const run: RefRunner = async (cli, args) => {
    const out = await f.run(cli, args);
    if (!args.includes("graphql") || args.some((a) => a.startsWith("query=query InboxPullsOthers")) || out.exitCode !== 0) return out;
    const answer = JSON.parse(out.stdout) as { data: Record<string, unknown> };
    answer.data.everyRequested = { nodes: f.listed.map(ghPull) };
    return { ...out, stdout: JSON.stringify(answer) };
  };
  const pulls = createInboxPulls({ run, now: () => now });
  // Reviews' list and the Pull requests page's (everywhere) both name #880 and #881.
  await pulls.list(repos);
  expect((await pulls.list(repos, { everywhere: true })).pulls.map((p) => p.number).sort()).toEqual([880, 881]);
  // #881's author merges it. Reviews' list reads again and no longer names it; the everywhere list has not read since.
  f.listed = [880];
  f.merged.add(881);
  now += INBOX_PULLS_FRESH_MS;
  await pulls.list(repos, { refresh: true });
  expect(pulls.find(keyOf(881))?.state).toBe("open");
  // The page open on it asks for it: the forge's answer.
  expect((await pulls.pull(keyOf(881))).pull?.state).toBe("merged");
  // A PR both lists still name is the list's copy, no forge read.
  const asked = f.calls.length;
  expect((await pulls.pull(keyOf(880))).pull?.state).toBe("open");
  expect(f.calls.length).toBe(asked);
});

test("restarted, the page asks before any list read: the PR kept from before answers, offline and back online, never none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-pull-departed-"));
  try {
    let now = 1_000_000;
    const f = forge();
    const first = createInboxPulls({ run: f.run, now: () => now, dir });
    await first.list(repos);
    // A teammate merges #880: no list names it; the page open on it reads it from the forge.
    f.listed = [881];
    f.merged.add(880);
    now += INBOX_PULLS_FRESH_MS;
    await first.list(repos, { refresh: true });
    expect((await first.pull(keyOf(880), repos)).pull?.state).toBe("merged");
    // The Inbox restarts while offline; the open page asks again (a focus) before the window's list is read.
    now += 21_000;
    f.down = true;
    const offline = createInboxPulls({ run: f.run, now: () => now, dir });
    expect(await offline.pull(keyOf(880), repos)).toMatchObject({ pull: { number: 880, state: "merged" }, unreadable: true });
    // Back online: the next ask reads it from the forge.
    f.down = false;
    expect(await offline.pull(keyOf(880), repos)).toEqual({ pull: expect.objectContaining({ number: 880, state: "merged" }) });
    // Restarted online, asked first: the same.
    const online = createInboxPulls({ run: f.run, now: () => now, dir });
    expect(await online.pull(keyOf(880), repos)).toEqual({ pull: expect.objectContaining({ number: 880, state: "merged" }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the forge saying it has no such PR any more: missing, with the copy kept as its last read", async () => {
  let now = 1_000_000;
  const f = forge();
  const pulls = createInboxPulls({ run: f.run, now: () => now });
  await pulls.list(repos);
  f.listed = [880];
  now += INBOX_PULLS_FRESH_MS;
  await pulls.list(repos, { refresh: true });
  // #881's repository was deleted, or the person lost access: GitHub answers 404.
  f.missing.add(881);
  expect(await pulls.pull(keyOf(881), repos)).toEqual({ pull: expect.objectContaining({ number: 881 }), missing: true });
  // Never "unreadable" (the forge did answer), and held like any answer: no second read within the hold.
  const asked = f.calls.length;
  expect((await pulls.pull(keyOf(881), repos)).missing).toBe(true);
  expect(f.calls.length).toBe(asked);
});

test("an action on a PR that left the list answers 409 pull_closed; one never listed, 404 pull_unknown", async () => {
  let now = 1_000_000;
  const f = forge();
  const pulls = createInboxPulls({ run: f.run, now: () => now });
  await pulls.list(repos);
  f.listed = [880];
  now += INBOX_PULLS_FRESH_MS;
  await pulls.list(repos, { refresh: true });
  const [closed, closedStatus] = pullMissingAnswer(pulls, keyOf(881));
  expect([closed.code, closedStatus]).toEqual(["pull_closed", 409]);
  const [unknown, unknownStatus] = pullMissingAnswer(pulls, keyOf(999));
  expect([unknown.code, unknownStatus]).toEqual(["pull_unknown", 404]);
});

test("a diff read says the PR's state as the forge has it now", async () => {
  let now = 1_000_000;
  const f = forge();
  const pulls = createInboxPulls({ run: f.run, now: () => now });
  await pulls.list(repos);
  expect((await pulls.diff(keyOf(880), "layer")).state).toBe("open");
  // A teammate merges it elsewhere; the list has not read again yet.
  f.merged.add(881);
  expect((await pulls.diff(keyOf(881), "layer")).state).toBe("merged");
});
