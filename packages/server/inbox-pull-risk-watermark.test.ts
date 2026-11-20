import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxPullStacks, type InboxPull, type InboxPullRiskLevel } from "@plannotator/core/inbox-types";
import { createInboxPulls } from "./inbox-pulls";
import { createPullRiskAuto, type PullRiskAutoJob } from "./inbox-pull-risk-auto";
import type { RefRunner } from "./ref-cards";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const busy = `northwind/${"payments-ledger-".repeat(6)}busy`;
const quiet = `northwind/${"payments-ledger-".repeat(6)}quiet`;

const node = (repo: string, number: number) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-11-19T10:00:00Z",
  mergedAt: null,
  baseRefName: "main",
  headRefName: `branch-${number}`,
  headRefOid: String(number).padStart(40, "a"),
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  reviewDecision: "REVIEW_REQUIRED",
  repository: { nameWithOwner: repo },
  headRepository: { nameWithOwner: repo },
  author: { login: "tomas" },
  authorAssociation: "MEMBER",
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  commits: { nodes: [] },
});

const run: RefRunner = async (cli, args) => {
  if (cli === "gh" && args[0] === "auth") return { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }), stderr: "", exitCode: 0 };
  if (cli !== "gh" || !args.includes("graphql")) return { stdout: "", stderr: "not signed in", exitCode: 1 };
  const searches = args.filter((a) => /^others\d+=/.test(a));
  if (searches.length === 0) return { stdout: JSON.stringify({ data: { viewer: { login: "dana" }, requested: { nodes: [] }, authored: { nodes: [] }, assigned: { nodes: [] }, merged: { nodes: [] } } }), stderr: "", exitCode: 0 };
  const data: Record<string, unknown> = { viewer: { login: "dana" } };
  for (const search of searches) {
    const [name] = search.split("=");
    data[name!] = search.includes(`repo:${busy}`) ? { issueCount: 150, nodes: [node(busy, 7)] } : { issueCount: 1, nodes: [node(quiet, 20)] };
  }
  return { stdout: JSON.stringify({ data }), stderr: "", exitCode: 0 };
};

test("one host, one Others search cut and one whole: the whole one's repository gets its watermark and a PR opened there later starts; the cut one's wait", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pull-risk-watermark-"));
  dirs.push(dataDir);
  const pulls = createInboxPulls({ run });
  const repos = [busy, quiet].map((repo, i) => ({ host: "github.com", repo, project_id: `prj_${i}` }));
  await pulls.list(repos);
  await new Promise((done) => setTimeout(done, 0));
  const read = await pulls.list(repos);
  expect(read.pulls.map((pull) => pull.number).sort((a, b) => a - b)).toEqual([7, 20]);
  const listed = new Map(read.pulls.map((pull) => [pull.key, pull]));
  const started: PullRiskAutoJob[] = [];
  const auto = createPullRiskAuto({
    dataDir,
    settings: () => ({ level: "high", make: "guide" }),
    listed: () => [...listed.values()],
    covered: () => new Set(pulls.othersCovered(read)),
    pullOf: (key) => listed.get(key) ?? null,
    stackOf: (key) => inboxPullStacks([...listed.values()]).find((stack) => stack.layers.some((layer) => layer.key === key)) ?? null,
    levelOf: () => "high",
    hasThread: async () => false,
    settled: () => true,
    start: async (job) => (started.push(job), { thread_id: `thr_${job.key}` }),
  });
  auto.resume();
  const judged = (pull: InboxPull, level: InboxPullRiskLevel = "high") => {
    listed.set(pull.key, pull);
    auto.judged(pull, level);
  };
  for (const pull of read.pulls) judged(pull);
  const later = (from: InboxPull, number: number): InboxPull => ({ ...from, key: from.key.replace(/#\d+$/, `#${number}`), number, url: from.url.replace(/\d+$/, String(number)), head: `branch-${number}` });
  const quietOne = read.pulls.find((pull) => pull.number === 20)!;
  const busyOne = read.pulls.find((pull) => pull.number === 7)!;
  judged(later(quietOne, 21));
  judged(later(busyOne, 8));
  await auto.idle();
  expect(started.map((job) => job.key)).toEqual([later(quietOne, 21).key]);
  expect((await auto.waiting()).high.sort()).toEqual([busyOne.key, later(busyOne, 8).key, quietOne.key].sort());
});
