/**
 * PR risk ranking (inbox-pull-risk.ts). What regresses: the verdict's parse going soft (a guess, or a diff's own
 * "verdict" being believed); work or cost repeating (per head, across restarts, after a failure); running when it must
 * not (off, no rules, an agent the person didn't choose); a run allowed to act; a part of a big diff not reaching the agent; a refused or failed run reading as Low;
 * a diff the forge held back not read whole from a clone on this computer, or that read changing the clone's refs or worktree.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIMessage, AIProvider, CreateSessionOptions } from "@plannotator/ai/types";
import type { InboxPull } from "@plannotator/core/inbox-types";
import { ClaudeAgentSDKProvider } from "@plannotator/ai/providers/claude-agent-sdk";
import { CodexAppServerProvider } from "@plannotator/ai/providers/codex-app-server";
import { PiSDKProvider } from "@plannotator/ai/providers/pi-sdk";
import { saveConfig } from "@plannotator/shared/config";
import { INBOX_PULL_RISK_FILE, RISK_AGENT_PAUSE_MS, RISK_CONCURRENCY, RISK_RETRY_MS, createPullRisk, installedPath, runRiskAgent, startingRiskModel, type RiskRunResult, type RiskRun, type RiskRunner } from "./inbox-pull-risk";
import { buildRiskPrompt, parseRiskAnswer } from "./inbox-pull-risk-prompt";
import { INBOX_PULL_WHOLE_DIFF_TIMEOUT_MS, createInboxPulls, createPullGitRunner, pullDiffCliRunner } from "./inbox-pulls";

const AGENTS = [{ id: "pi-sdk", label: "Pi" }];
const HIGH = '{"risk":"high","why":"It changes the billing webhook."}';

let dataDir: string;
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pull-risk-")));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const pull = (number: number, fields: Partial<InboxPull> = {}): InboxPull =>
  ({ key: `github.com/n/b#${number}`, number, title: `PR ${number}`, state: "open", head_sha: `head-${number}`, base: "main", host: "github.com", repo: "n/b", ...fields }) as InboxPull;

const settled = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** An engine with a scripted agent and a scripted diff read; every run is kept in `runs`. */
function engine(options: { answer?: RiskRunner; agents?: { id: string; label: string }[]; on?: () => boolean; now?: () => number; head?: (key: string) => string | null; patch?: string; diffFails?: boolean | string; diffGate?: Promise<void> } = {}) {
  const runs: RiskRun[] = [];
  const reads: string[] = [];
  const risk = createPullRisk({
    dataDir,
    isOn: options.on ?? (() => true),
    now: options.now,
    agents: () => options.agents ?? AGENTS,
    pulls: {
      wholeDiff: async (key) => {
        reads.push(key);
        await options.diffGate;
        if (options.diffFails) throw Object.assign(new Error("gh failed"), typeof options.diffFails === "string" ? { code: options.diffFails } : {});
        const number = key.split("#")[1];
        return { patch: options.patch ?? "diff --git a/x b/x\n", partial: false, head_sha: options.head ? options.head(key) : `head-${number}` };
      },
    },
    run: async (run) => {
      runs.push(run);
      return (options.answer ?? (async () => ({ text: HIGH })))(run);
    },
  });
  return { risk, runs, reads };
}

const setRules = (rules = "Anything in billing.", provider: string | null = "pi-sdk", model: string | null = "anthropic/claude-sonnet-5") => saveConfig({ inboxPullRisk: { rules, provider, model } });

describe("the verdict's parse", () => {
  test("takes the one object, also in a single code fence", () => {
    expect(parseRiskAnswer(HIGH)).toEqual({ level: "high", why: "It changes the billing webhook." });
    expect(parseRiskAnswer(`\`\`\`json\n${HIGH}\n\`\`\``)?.level).toBe("high");
  });
  test.each([
    ["prose around it", `Sure! ${HIGH}`],
    ["a verdict after a reasoned one", `${HIGH}\n{"risk":"low","why":"ok"}`],
    ["an unknown level", '{"risk":"critical","why":"x"}'],
    ["a level in another case", '{"risk":"HIGH","why":"x"}'],
    ["no sentence", '{"risk":"low","why":"  "}'],
    ["an extra key", '{"risk":"low","why":"x","note":"y"}'],
    ["a sentence over lines", '{"risk":"low","why":"a\\nb"}'],
    ["a sentence too long", JSON.stringify({ risk: "low", why: "x".repeat(301) })],
    ["an array", `[${HIGH}]`],
    ["no answer", ""],
    ["plain words", "high"],
  ])("refuses %s", (_name, text) => {
    expect(parseRiskAnswer(text)).toBeNull();
  });
});

describe("what the agent reads", () => {
  test("the whole diff, however large, lockfiles and generated files too", async () => {
    setRules();
    const file = (path: string, lines: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,${lines} @@\n${"+a changed line of a file\n".repeat(lines)}`;
    const patch = `${file("bun.lock", 200_000)}${file("src/generated/client.ts", 200_000)}${file("src/billing.ts", 3)}`;
    const { risk, runs } = engine({ patch });
    risk.assess([pull(1)]);
    await settled();
    expect(patch.length).toBeGreaterThan(8_000_000);
    expect(runs[0]!.prompt).toContain(patch);
    expect(runs[0]!.prompt).not.toMatch(/not shown|trimmed/);
  });

  test("a diff can't close the data fence, and the rules stay outside it", () => {
    const prompt = buildRiskPrompt({ rules: "Billing.", title: "t", diff: "+DATA-guess\n", fence: "DATA-real" });
    expect(prompt.indexOf("Billing.")).toBeLessThan(prompt.indexOf("DATA-real\nTitle:"));
    expect(prompt.split("\n").filter((line) => line === "DATA-real")).toHaveLength(2);
  });
});

describe("reading the whole diff, through the reader and a scripted forge", () => {
  const ghNode = {
    number: 880, title: "PR 880", url: "https://github.com/n/b/pull/880", state: "OPEN", isDraft: false, updatedAt: "2026-11-03T10:00:00Z", mergedAt: null,
    baseRefName: "main", headRefName: "topic", headRefOid: "a".repeat(40), additions: 1, deletions: 1, changedFiles: 1, reviewDecision: "REVIEW_REQUIRED",
    repository: { nameWithOwner: "n/b" }, headRepository: { nameWithOwner: "n/b" }, author: { login: "tomas" }, reviewRequests: { nodes: [] }, latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  };
  const glNode = {
    iid: "61", title: "MR 61", webUrl: "https://gitlab.com/n/l/-/merge_requests/61", state: "opened", draft: false, updatedAt: "2026-11-03T10:00:00Z", mergedAt: null,
    sourceBranch: "topic", targetBranch: "main", diffHeadSha: "b".repeat(40), approved: false, detailedMergeStatus: "NOT_APPROVED", diffStatsSummary: { additions: 1, deletions: 1, fileCount: 1 },
    headPipeline: { status: "SUCCESS" }, project: { fullPath: "n/l" }, sourceProject: { fullPath: "n/l" }, author: { username: "jun" }, approvedBy: { nodes: [] }, reviewers: { nodes: [{ username: "dana" }] },
  };
  type Answer = { stdout?: string; stderr?: string; exitCode?: number };
  const answered = (a: Answer) => ({ stdout: a.stdout ?? "", stderr: a.stderr ?? "", exitCode: a.exitCode ?? 0 });
  /** The real reader and queue. `whole` answers the one-document read, `paged` the per-file read; the rest of the forge just works. */
  async function reading(platform: "github" | "gitlab", script: { whole: Answer; paged?: Answer }, options: { now?: () => number; answer?: string; respond?: (run: RiskRun, n: number) => RiskRunResult; files?: number; head?: string; clones?: string[]; gitEnv?: Record<string, string> } = {}) {
    const github = platform === "github";
    const node = { ...ghNode, headRefOid: options.head ?? ghNode.headRefOid };
    const endpoints: string[] = [];
    const run = async (cli: string, args: string[]) => {
      if (args[0] === "auth") {
        if (github) return answered(cli === "gh" ? { stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }) } : { stderr: "No hosts logged in", exitCode: 1 });
        return answered(cli === "glab" ? { stdout: "gitlab.com\n  \u2713 Logged in to gitlab.com as dana (keyring)\n" } : { stderr: "not logged in", exitCode: 1 });
      }
      if (args.includes("graphql")) {
        if (args.some((a) => a.startsWith("query=query InboxPullsOthers"))) return answered({ stdout: JSON.stringify({ data: github ? { viewer: { login: "dana" } } : { currentUser: { username: "dana" } } }) });
        return answered({ stdout: JSON.stringify(github
          ? { data: { viewer: { login: "dana" }, requested: { nodes: [{ ...node, changedFiles: options.files ?? node.changedFiles }] }, authored: { nodes: [] }, merged: { nodes: [] } } }
          : { data: { currentUser: { username: "dana", requested: { nodes: [{ ...glNode, diffStatsSummary: { ...glNode.diffStatsSummary, fileCount: options.files ?? 1 } }] }, authored: { nodes: [] }, merged: { nodes: [] } } } }) });
      }
      const endpoint = args[3]!;
      endpoints.push(endpoint);
      if (/\/files\?|\/diffs\?/.test(endpoint)) return answered(script.paged ?? { stderr: "no paged read scripted", exitCode: 1 });
      if (endpoint.endsWith("/raw_diffs") || args.includes("Accept: application/vnd.github.v3.diff")) return answered(script.whole);
      return answered({ stdout: github ? `${node.headRefOid}\n` : JSON.stringify({ sha: glNode.diffHeadSha }) });
    };
    const pulls = createInboxPulls({ run, now: options.now, ...(options.gitEnv ? { gitRun: createPullGitRunner(() => ({ ...process.env, ...options.gitEnv })) } : {}) });
    const listed = await pulls.list([github ? { host: "github.com", repo: "n/b", project_id: "p" } : { host: "gitlab.com", repo: "n/l", project_id: "p" }]);
    expect(listed.pulls).toHaveLength(1);
    const runs: RiskRun[] = [];
    const risk = createPullRisk({
      dataDir,
      isOn: () => true,
      now: options.now,
      agents: () => AGENTS,
      pulls,
      ...(options.clones ? { roots: async () => options.clones! } : {}),
      run: async (one) => {
        runs.push(one);
        return options.respond ? options.respond(one, runs.length) : { text: options.answer ?? HIGH };
      },
    });
    const judge = async () => {
      risk.assess(listed.pulls);
      for (let i = 0; i < 500 && risk.answer().pending > 0; i++) await Bun.sleep(2);
    };
    return { pulls, risk, runs, judge, endpoints, key: listed.pulls[0]!.key };
  }

  test("9 MB reaches the agent whole, while the review page's own read keeps its limit", async () => {
    setRules();
    const patch = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,400000 @@\n${"+export const line = 1;\n".repeat(400_000)}`;
    expect(patch.length).toBeGreaterThan(9_000_000);
    const { pulls, risk, runs, judge, key } = await reading("github", { whole: { stdout: patch } });
    await judge();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.prompt).toContain(patch);
    expect(risk.answer().judgments[key]?.level).toBe("high");
    await expect(pulls.diff(key, "layer")).rejects.toMatchObject({ code: "pull_diff_too_large" });
  });

  const FILES_PAGE_1 = JSON.stringify([{ filename: "src/pay.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+charge twice\n" }]);
  const FILES_PAGE_2 = JSON.stringify([{ filename: "vendor/huge.bin", status: "modified" }, { filename: "src/new.ts", status: "added", patch: "@@ -0,0 +1 @@\n+fresh\n" }]);

  test.each([
    ["GitHub's line limit", "gh: Sorry, the diff exceeded the maximum number of lines (20000). (HTTP 406)"],
    ["GitHub's file limit", "gh: Sorry, the diff exceeded the maximum number of files (300). (HTTP 422)"],
    ["a slow render", "gh: diff is taking too long to generate (HTTP 500)"],
    ["a refusal in words nobody has seen yet", "gh: this is too much for one document (HTTP 413)"],
  ])("%s: the agent gets the forge's per-file read, every page, a held-back file by name", async (_name, stderr) => {
    setRules();
    const { risk, runs, judge, key } = await reading("github", { whole: { stderr, exitCode: 1 }, paged: { stdout: `${FILES_PAGE_1}${FILES_PAGE_2}` } });
    await judge();
    expect(runs).toHaveLength(1);
    const { prompt } = runs[0]!;
    expect(prompt).toContain("+charge twice");
    expect(prompt).toContain("+fresh");
    expect(prompt).toContain("diff --git a/vendor/huge.bin b/vendor/huge.bin");
    expect(prompt).not.toMatch(/too large/i);
    expect(risk.answer().judgments[key]?.level).toBe("high");
    expect(risk.answer().failed).toEqual({});
  });

  describe("an answer of Low from a read known to be incomplete", () => {
    const LOW = '{"risk":"low","why":"Only the README wording changes."}';
    const MEDIUM = '{"risk":"medium","why":"It may touch billing."}';
    const refused = { stderr: "gh: (HTTP 406)", exitCode: 1 };
    const full = (n: number) => ({ filename: `src/f${n}.ts`, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b\n" });
    const glFile = (fields: Record<string, unknown>) => ({ diff: "", old_path: "l.ts", new_path: "l.ts", new_file: false, deleted_file: false, renamed_file: false, ...fields });
    const levelOf = async (platform: "github" | "gitlab", script: { whole: Answer; paged?: Answer }, answer: string, files?: number) => {
      setRules();
      const { risk, judge, key } = await reading(platform, script, { answer, files });
      await judge();
      return { level: risk.answer().judgments[key]?.level, why: risk.answer().judgments[key]?.why, failed: risk.answer().failed };
    };

    test.each([
      ["a file held back, as a bare header", { stdout: JSON.stringify([full(1), { filename: "vendor/huge.bin", status: "modified" }]) }, undefined],
      ["a page that failed", { stdout: JSON.stringify([full(1)]), stderr: "gh: Bad Gateway (HTTP 502)", exitCode: 1 }, undefined],
      ["GitHub's 3000-file stop", { stdout: JSON.stringify(Array.from({ length: 3000 }, (_, n) => full(n))) }, undefined],
      ["fewer files than the PR says it has", { stdout: JSON.stringify([full(1), full(2)]) }, 40],
    ])("%s: shows Medium, with the agent's own sentence", async (_name, paged, files) => {
      const { level, why, failed } = await levelOf("github", { whole: refused, paged }, LOW, files);
      expect(level).toBe("medium");
      expect(why).toBe("Only the README wording changes.");
      expect(failed).toEqual({});
    });

    test.each([
      ["too_large", glFile({ too_large: true })],
      ["collapsed", glFile({ collapsed: true })],
    ])("GitLab holding a file back (%s): shows Medium", async (_name, file) => {
      const { level } = await levelOf("gitlab", { whole: { stdout: "" }, paged: { stdout: JSON.stringify([glFile({ diff: "@@ -1 +1 @@\n+x\n" }), file]) } }, LOW);
      expect(level).toBe("medium");
    });

    test.each([
      ["an added file", { new_file: true }],
      ["a deleted file", { deleted_file: true }],
    ])("an older GitLab, no flags, %s with an empty diff: it may be held back, so Medium", async (_name, fields) => {
      const { level } = await levelOf("gitlab", { whole: { stdout: "" }, paged: { stdout: JSON.stringify([glFile({ diff: "@@ -1 +1 @@\n+x\n" }), glFile(fields)]) } }, LOW);
      expect(level).toBe("medium");
    });

    test.each([
      ["an empty new file on a GitLab that says it held nothing back", { new_file: true, too_large: false, collapsed: false }],
      ["an older GitLab's pure rename", { renamed_file: true }],
      ["an older GitLab's new file with its content", { new_file: true, diff: "@@ -0,0 +1 @@\n+fresh\n" }],
    ])("GitLab keeps Low: %s", async (_name, fields) => {
      const { level } = await levelOf("gitlab", { whole: { stdout: "" }, paged: { stdout: JSON.stringify([glFile(fields)]) } }, LOW);
      expect(level).toBe("low");
    });

    test.each([
      ["High", HIGH, "high"],
      ["Medium", MEDIUM, "medium"],
    ])("%s stays as it is", async (_name, answer, expected) => {
      const paged = { stdout: JSON.stringify([full(1), { filename: "vendor/huge.bin", status: "modified" }]) };
      expect((await levelOf("github", { whole: refused, paged }, answer)).level).toBe(expected);
    });

    test.each([
      ["the whole document", { whole: { stdout: "diff --git a/x b/x\n" } }],
      ["every file by pages", { whole: refused, paged: { stdout: `${JSON.stringify([full(1)])}${JSON.stringify([full(2)])}` } }],
      ["a pure rename, which has no patch to hold back", { whole: refused, paged: { stdout: JSON.stringify([{ filename: "b.ts", previous_filename: "a.ts", status: "renamed" }]) } }],
    ])("a complete read keeps Low: %s", async (_name, script) => {
      expect((await levelOf("github", script, LOW)).level).toBe("low");
    });
  });

  describe("a clone of the PR's repository on this computer", () => {
    const LOW = '{"risk":"low","why":"Only the README wording changes."}';
    const refused = { stderr: "gh: (HTTP 406)", exitCode: 1 };
    // The forge sends src/pay.ts and holds vendor/huge.bin back.
    const heldBack = { stdout: JSON.stringify([{ filename: "src/pay.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+charge twice\n" }, { filename: "vendor/huge.bin", status: "modified" }]) };
    let scratch: string;
    let gitEnv: Record<string, string>;
    beforeEach(() => {
      scratch = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pull-risk-clone-")));
      mkdirSync(join(scratch, "home"));
      // git never reads the person's own config, here or in the Inbox's reads.
      gitEnv = { HOME: join(scratch, "home"), XDG_CONFIG_HOME: join(scratch, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    });
    afterEach(() => rmSync(scratch, { recursive: true, force: true }));
    const git = (cwd: string, ...args: string[]) => {
      const done = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...gitEnv }, stdin: "ignore" });
      if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
      return done.stdout.toString().trim();
    };
    /**
     * The forge's repository, and the person's clone of it made before the PR: the PR's head is only at
     * refs/pull/880/head, and main moved on after the clone, so both have to be fetched.
     */
    const repositories = () => {
      const upstream = join(scratch, "upstream");
      mkdirSync(upstream);
      git(upstream, "init", "-q", "-b", "main");
      mkdirSync(join(upstream, "src"));
      mkdirSync(join(upstream, "vendor"));
      writeFileSync(join(upstream, "src", "pay.ts"), "old\n");
      writeFileSync(join(upstream, "vendor", "huge.bin"), "v1\n");
      writeFileSync(join(upstream, "README.md"), "teh\n");
      git(upstream, "add", ".");
      git(upstream, "commit", "-q", "-m", "base");
      const clone = join(scratch, "clone");
      git(scratch, "clone", "-q", upstream, clone);
      git(upstream, "checkout", "-q", "-b", "topic");
      writeFileSync(join(upstream, "src", "pay.ts"), "charge twice\n");
      writeFileSync(join(upstream, "vendor", "huge.bin"), "v2 sends the card number home\n");
      git(upstream, "commit", "-q", "-am", "the PR");
      const head = git(upstream, "rev-parse", "HEAD");
      git(upstream, "update-ref", "refs/pull/880/head", head);
      git(upstream, "checkout", "-q", "main");
      git(upstream, "branch", "-q", "-D", "topic");
      // main moves on after the PR left it: none of this is the PR's.
      writeFileSync(join(upstream, "README.md"), "the\n");
      git(upstream, "commit", "-q", "-am", "main moves on");
      // The person's own work in the clone: a branch, a change in the worktree, one staged, one stashed.
      git(clone, "checkout", "-q", "-b", "mine");
      writeFileSync(join(clone, "README.md"), "stashed\n");
      git(clone, "stash", "-q");
      writeFileSync(join(clone, "README.md"), "staged\n");
      git(clone, "add", "README.md");
      writeFileSync(join(clone, "src", "pay.ts"), "editing\n");
      return { upstream, clone, head };
    };
    const stateOf = (clone: string) => ({
      refs: git(clone, "for-each-ref", "--format=%(refname) %(objectname)"),
      head: git(clone, "symbolic-ref", "HEAD"),
      status: git(clone, "status", "--porcelain"),
      stash: git(clone, "stash", "list"),
      fetchHead: existsSync(join(clone, ".git", "FETCH_HEAD")),
    });

    test("the forge held a file back: git reads the whole diff there, so a Low stays Low, and nothing of the person's moves", async () => {
      setRules();
      const { clone, head } = repositories();
      const before = stateOf(clone);
      const { risk, runs, judge, key } = await reading("github", { whole: refused, paged: heldBack }, { answer: LOW, head, clones: [clone], gitEnv });
      await judge();
      expect(runs).toHaveLength(1);
      const { prompt } = runs[0]!;
      // The held-back file's own lines, and the rest of the PR, from where it left main.
      expect(prompt).toContain("+v2 sends the card number home");
      expect(prompt).toContain("+charge twice");
      expect(prompt).not.toContain("README");
      expect(risk.answer().judgments[key]?.level).toBe("low");
      // Objects only: every ref, the branch, the worktree, the index and the stash as they were, and no FETCH_HEAD.
      expect(stateOf(clone)).toEqual(before);
    }, 30_000);

    const TOO_LONG = "prompt is too long: 900000 tokens > 200000 maximum";
    test("too long whole for the model: tried once more as the forge gave it, its held-back files as headers, and a Low from that is Medium", async () => {
      setRules();
      const { clone, head } = repositories();
      const { risk, runs, judge, key } = await reading("github", { whole: refused, paged: heldBack }, { head, clones: [clone], gitEnv, respond: (_run, n) => (n === 1 ? { failed: TOO_LONG } : { text: LOW }) });
      await judge();
      expect(runs).toHaveLength(2);
      expect(runs[0]!.prompt).toContain("+v2 sends the card number home");
      expect(runs[1]!.prompt).not.toContain("+v2 sends the card number home");
      expect(runs[1]!.prompt).toContain("diff --git a/vendor/huge.bin b/vendor/huge.bin");
      expect(runs[1]!.prompt).toContain("+charge twice");
      expect(risk.answer().judgments[key]?.level).toBe("medium");
      expect(risk.answer().failed).toEqual({});
    }, 30_000);

    test("too long both ways: the PR says why, and that one try is all", async () => {
      setRules();
      const { clone, head } = repositories();
      const { risk, runs, judge, key } = await reading("github", { whole: refused, paged: heldBack }, { head, clones: [clone], gitEnv, respond: () => ({ text: "Prompt is too long" }) });
      await judge();
      expect(runs).toHaveLength(2);
      expect(risk.answer().judgments[key]).toBeUndefined();
      expect(risk.answer().failed[key]).toContain("Prompt is too long");
    }, 30_000);

    test.skipIf(process.platform === "win32").each([
      ["the timeout", undefined],
      ["the queue's stop", "abort"],
    ])("%s stops what git started too: its ssh doesn't outlive it", async (_name, how) => {
      const pidFile = join(scratch, "ssh.pid");
      const ssh = join(scratch, "fake-ssh");
      writeFileSync(ssh, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`);
      chmodSync(ssh, 0o755);
      const runner = createPullGitRunner(() => ({ ...process.env, ...gitEnv, GIT_SSH_COMMAND: ssh }));
      const stop = new AbortController();
      const started = Date.now();
      const running = runner(scratch, ["ls-remote", "ssh://git@example.invalid/n/b.git"], { timeoutMs: how ? 20_000 : 1_000, signal: stop.signal });
      // The ssh is up: git is waiting on it.
      for (let i = 0; i < 200 && !existsSync(pidFile); i++) await Bun.sleep(25);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(0);
      if (how) stop.abort();
      const result = await running;
      expect(result.exitCode).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(10_000);
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 80 && alive(); i++) await Bun.sleep(25);
      expect(alive()).toBe(false);
    }, 30_000);

    test("no clone, or one git can't fetch the head into: the forge's read stands, and Low shows Medium", async () => {
      setRules();
      const { clone } = repositories();
      for (const clones of [[], [clone]]) {
        // A head the forge's repository doesn't have: the fetch brings nothing.
        const { risk, judge, key } = await reading("github", { whole: refused, paged: heldBack }, { answer: LOW, head: "c".repeat(40), clones, gitEnv });
        await judge();
        expect(risk.answer().judgments[key]?.level).toBe("medium");
      }
    }, 30_000);
  });

  test("a page failing partway: the agent decides from the pages before it", async () => {
    setRules();
    const { runs, judge } = await reading("github", { whole: { stderr: "gh: (HTTP 406)", exitCode: 1 }, paged: { stdout: FILES_PAGE_1, stderr: "gh: Bad Gateway (HTTP 502)", exitCode: 1 } });
    await judge();
    expect(runs[0]!.prompt).toContain("+charge twice");
  });

  test.each([
    ["refused", { stderr: "glab: 406 Not Acceptable", exitCode: 1 }],
    ["answering nothing, as raw_diffs does past its limit", { stdout: "" }],
    ["missing on an older GitLab", { stderr: "glab: 404 Not Found", exitCode: 1 }],
  ])("GitLab's raw_diffs %s: its paged diffs instead", async (_name, whole) => {
    setRules();
    const paged = JSON.stringify([{ diff: "@@ -1 +1 @@\n-old\n+ledger change\n", old_path: "l.ts", new_path: "l.ts", new_file: false, deleted_file: false, renamed_file: false }]);
    const { runs, judge, endpoints } = await reading("gitlab", { whole, paged: { stdout: paged } });
    await judge();
    expect(runs[0]!.prompt).toContain("+ledger change");
    expect(endpoints).toContain("projects/n%2Fl/merge_requests/61/diffs?per_page=100");
  });

  test.each([
    ["an empty per-file read", { stdout: "[]" }, "The forge returned no diff for this pull request."],
    ["a per-file read that fails too", { stderr: "gh: Bad Gateway (HTTP 502)", exitCode: 1 }, "gh could not read this diff. Try again, or open it on the forge."],
    ["a per-file read that makes no sense", { stdout: "<html>" }, "The forge returned no diff for this pull request."],
  ])("%s: no agent runs, the reason shows, never 'too large', and it is read again later", async (_name, paged, reason) => {
    setRules();
    let now = 1_000_000;
    const { risk, runs, judge, endpoints, key } = await reading("github", { whole: { stderr: "gh: the diff exceeded the maximum number of lines (HTTP 406)", exitCode: 1 }, paged }, { now: () => now });
    await judge();
    expect(runs).toEqual([]);
    expect(risk.answer().failed[key]).toBe(reason);
    expect(risk.answer().failed[key]).not.toMatch(/too large/i);
    const before = endpoints.length;
    now += RISK_RETRY_MS;
    await judge();
    expect(endpoints.length).toBeGreaterThan(before);
  });

  describe("a read that dies partway, with a diff that happens to say an error's words", () => {
    const died = (line: string) => ({ stdout: `diff --git a/x.ts b/x.ts\n${line}\n`, exitCode: 143 });
    const notHeld = async (pulls: { wholeDiff(key: string): Promise<unknown> }, key: string) => {
      const again = await pulls.wholeDiff(key).then(() => "", (cause: Error) => cause.message);
      expect(again).not.toContain("slow down");
    };

    test.each([
      ["429", "+// handle a 429 here"],
      ["rate limit", "+// the API rate limit exceeded path"],
      ["sign-in", "+// run gh auth login first"],
      ["not logged in", "+// not logged in"],
    ])("%s in the diff: the per-file read still runs, and the host isn't held", async (_name, line) => {
      setRules();
      const { pulls, risk, runs, judge, endpoints, key } = await reading("github", { whole: died(line), paged: { stdout: FILES_PAGE_1 } });
      await judge();
      expect(endpoints.some((e) => e.includes("/files"))).toBe(true);
      expect(runs).toHaveLength(1);
      expect(risk.answer().judgments[key]?.level).toBe("high");
      await notHeld(pulls, key);
    });

    test("the per-file read dying the same way holds nothing either", async () => {
      setRules();
      const paged = { stdout: '[{"filename":"a.ts","patch":"+// handle a 429 here', exitCode: 143 };
      const { pulls, risk, runs, judge, key } = await reading("github", { whole: { stderr: "gh: (HTTP 406)", exitCode: 1 }, paged });
      await judge();
      expect(runs).toEqual([]);
      expect(risk.answer().failed[key]).toBe("gh could not read this diff. Try again, or open it on the forge.");
      await notHeld(pulls, key);
    });
  });

  test.each([
    ["signed out", "gh: not logged in. Run gh auth login", "gh is not signed in to github.com."],
    ["rate limited", "gh: API rate limit exceeded (HTTP 429)", "gh could not read this diff. Try again, or open it on the forge."],
  ])("%s: asking per file wouldn't help, so it doesn't", async (_name, stderr, reason) => {
    setRules();
    const { risk, runs, judge, endpoints, key } = await reading("github", { whole: { stderr, exitCode: 1 }, paged: { stdout: FILES_PAGE_1 } });
    await judge();
    expect(runs).toEqual([]);
    expect(risk.answer().failed[key]).toBe(reason);
    expect(endpoints.some((e) => e.includes("/files"))).toBe(false);
  });

  test("each read has the agent's 5 minutes and no byte limit; the review page's read keeps its own", async () => {
    setRules();
    const seen: { endpoint: string; maxBytes: number; timeoutMs?: number }[] = [];
    const run = async (_cli: string, args: string[]) => {
      if (args[0] === "auth") return answered({ stdout: JSON.stringify({ hosts: { "github.com": [{ login: "dana", active: true, state: "success" }] } }) });
      if (args.includes("graphql")) return answered({ stdout: JSON.stringify({ data: { viewer: { login: "dana" }, requested: { nodes: [ghNode] }, authored: { nodes: [] }, merged: { nodes: [] } } }) });
      return answered({ stdout: `${ghNode.headRefOid}\n` });
    };
    const pulls = createInboxPulls({
      run,
      diffRun: async (_cli, args, maxBytes, read) => {
        seen.push({ endpoint: args[3]!, maxBytes, timeoutMs: read?.timeoutMs });
        return args[3]!.includes("/files") ? answered({ stdout: FILES_PAGE_1 }) : answered(seen.length > 1 ? { stdout: "diff --git a/x b/x\n" } : { stderr: "gh: (HTTP 406)", exitCode: 1 });
      },
    });
    const { pulls: [one] } = await pulls.list([{ host: "github.com", repo: "n/b", project_id: "p" }]);
    await pulls.wholeDiff(one!.key);
    expect(seen).toHaveLength(2);
    for (const read of seen) {
      expect(read.maxBytes).toBe(Number.POSITIVE_INFINITY);
      expect(read.timeoutMs).toBe(INBOX_PULL_WHOLE_DIFF_TIMEOUT_MS);
    }
    expect(INBOX_PULL_WHOLE_DIFF_TIMEOUT_MS).toBe(5 * 60_000);
    seen.length = 0;
    await pulls.diff(one!.key, "layer").catch(() => {});
    expect(seen[0]!.maxBytes).toBe(8 * 1024 * 1024);
    expect(seen[0]!.timeoutMs).toBeUndefined();
  });

  test.if(process.platform !== "win32")("the Inbox stopping stops a read in progress", async () => {
    const fake = join(dataDir, "fake-bin");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "gh"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(fake, "gh"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fake}:${savedPath}`;
    try {
      const stop = new AbortController();
      const started = Date.now();
      const read = pullDiffCliRunner("gh", ["api"], Number.POSITIVE_INFINITY, { timeoutMs: 60_000, signal: stop.signal });
      await Bun.sleep(50);
      stop.abort();
      expect((await read).exitCode).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("when it runs", () => {
  test("no rules, Code review off, no chosen agent, or an agent no longer installed: no run", async () => {
    const off = engine({ on: () => false });
    setRules();
    off.risk.assess([pull(1)]);
    await settled();
    expect(off.runs).toEqual([]);

    setRules("");
    const none = engine();
    none.risk.assess([pull(1)]);
    await settled();
    expect(none.runs).toEqual([]);

    setRules("Billing.", null);
    const unchosen = engine();
    unchosen.risk.assess([pull(1)]);
    await settled();
    expect(unchosen.runs).toEqual([]);

    // Claude Code is here, but the person chose Pi: a diff never goes to another provider.
    setRules("Billing.", "pi-sdk");
    const gone = engine({ agents: [{ id: "claude-agent-sdk", label: "Claude Code" }] });
    gone.risk.assess([pull(1)]);
    await settled();
    expect(gone.runs).toEqual([]);
  });

  test("a PR judged while open shows no judgment once merged, at the same head", async () => {
    setRules();
    const { risk } = engine();
    risk.assess([pull(1)]);
    await settled();
    expect(risk.answer().judgments["github.com/n/b#1"]?.level).toBe("high");
    risk.assess([pull(1, { state: "merged" })]);
    expect(risk.answer().judgments["github.com/n/b#1"]).toBeUndefined();
  });

  test("merged and closed PRs, and a PR whose head isn't known, are not judged", async () => {
    setRules();
    const { risk, runs } = engine();
    risk.assess([pull(1, { state: "merged" }), pull(2, { state: "closed" }), pull(3, { head_sha: null }), pull(4, { state: "draft" })]);
    await settled();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.prompt).toContain("Title: PR 4");
  });

  test("a few at a time, and the list never waits", async () => {
    setRules();
    let live = 0;
    let most = 0;
    const release: (() => void)[] = [];
    const { risk, runs } = engine({
      answer: async () => {
        most = Math.max(most, ++live);
        await new Promise<void>((resolve) => release.push(resolve));
        live--;
        return { text: HIGH };
      },
    });
    const pulls = Array.from({ length: 8 }, (_, i) => pull(i + 1));
    risk.assess(pulls);
    await settled();
    expect(risk.answer().pending).toBe(8);
    expect(most).toBe(RISK_CONCURRENCY);
    // A second list read while they run starts nothing twice.
    risk.assess(pulls);
    while (runs.length < 8 || release.length) {
      release.shift()?.();
      await settled();
    }
    expect(runs).toHaveLength(8);
    expect(risk.answer().pending).toBe(0);
    expect(Object.keys(risk.answer().judgments)).toHaveLength(8);
  });

  test("the agent gets the chosen model, an empty folder of its own, the rules and the diff", async () => {
    setRules("Anything in billing.");
    const { risk, runs } = engine({ patch: "diff --git a/pay.ts b/pay.ts\n+charge\n" });
    risk.assess([pull(1)]);
    await settled();
    expect(runs[0]).toMatchObject({ provider: "pi-sdk", model: "anthropic/claude-sonnet-5" });
    expect(runs[0]!.cwd).toBe(join(dataDir, "inbox", "pull-risk-agent"));
    expect(runs[0]!.prompt).toContain("Anything in billing.");
    expect(runs[0]!.prompt).toContain("+charge");
  });
});

describe("no cost repeats", () => {
  test("one judgment per head: kept across a restart; a new head means a new one, and the old one is not shown for it", async () => {
    setRules();
    const first = engine();
    first.risk.assess([pull(1)]);
    await settled();
    first.risk.assess([pull(1)]);
    await settled();
    expect(first.runs).toHaveLength(1);
    expect(first.risk.answer().judgments["github.com/n/b#1"]).toEqual({ level: "high", why: "It changes the billing webhook." });

    const restarted = engine();
    restarted.risk.assess([pull(1)]);
    await settled();
    expect(restarted.runs).toEqual([]);
    expect(restarted.risk.answer().judgments["github.com/n/b#1"]?.level).toBe("high");

    let release = () => {};
    const pushed = engine({ answer: () => new Promise((resolve) => (release = () => resolve({ text: '{"risk":"low","why":"Docs only."}' }))), head: () => "head-new" });
    pushed.risk.assess([pull(1, { head_sha: "head-new" })]);
    await settled();
    expect(pushed.risk.answer().judgments["github.com/n/b#1"]).toBeUndefined();
    release();
    await settled();
    expect(pushed.risk.answer().judgments["github.com/n/b#1"]?.level).toBe("low");
  });

  test("new rules mean a new judgment; a new model alone does not", async () => {
    setRules("Billing.");
    const { risk, runs } = engine();
    risk.assess([pull(1)]);
    await settled();
    setRules("Billing.", "pi-sdk", "anthropic/claude-haiku");
    risk.assess([pull(1)]);
    await settled();
    expect(runs).toHaveLength(1);
    setRules("Auth.");
    expect(risk.answer().judgments).toEqual({});
    risk.assess([pull(1)]);
    await settled();
    expect(runs).toHaveLength(2);
    expect(risk.answer().judgments["github.com/n/b#1"]).toBeDefined();
  });

  test("a failed run shows nothing, and that PR waits the same time before each try", async () => {
    setRules();
    let now = 1_000_000;
    let text = "I think this is low risk.";
    const { risk, runs } = engine({ now: () => now, answer: async () => ({ text }) });
    const go = async () => {
      risk.assess([pull(1)]);
      await settled();
    };
    await go();
    expect(runs).toHaveLength(1);
    expect(risk.answer().judgments).toEqual({});
    expect(risk.answer().last_failure).toBeTruthy();
    await go();
    now += RISK_RETRY_MS - 1;
    await go();
    expect(runs).toHaveLength(1);
    now += 1;
    await go();
    expect(runs).toHaveLength(2);
    now += RISK_RETRY_MS;
    text = HIGH;
    await go();
    expect(runs).toHaveLength(3);
    expect(risk.answer().judgments["github.com/n/b#1"]?.level).toBe("high");
    expect(risk.answer().last_failure).toBeNull();
  });

  const many = Array.from({ length: 30 }, (_, i) => pull(i + 1));

  test("a broken agent stops everything for a while: a few runs, not one per PR, and the window stops waiting", async () => {
    setRules();
    let now = 1_000_000;
    const { risk, runs, reads } = engine({ now: () => now, answer: async () => ({ failed: "Not signed in." }) });
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    expect(reads).toHaveLength(RISK_CONCURRENCY);
    expect(risk.answer().pending).toBe(0);
    expect(risk.answer().last_failure).toBeTruthy();

    now += RISK_AGENT_PAUSE_MS - 1;
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);

    // After the pause, the next few, not the same ones.
    now += 1;
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY * 2);
    expect(new Set(runs.map((r) => r.prompt)).size).toBe(RISK_CONCURRENCY * 2);
  });

  test("diffs too long for the model are each PR's own: they never pause the others", async () => {
    setRules();
    const { risk, runs } = engine({ answer: async () => ({ failed: "prompt is too long: 2500000 tokens > 200000 maximum" }) });
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(many.length);
    expect(Object.keys(risk.answer().failed)).toHaveLength(many.length);
  });

  test("one PR that keeps failing can't stop the others", async () => {
    setRules();
    const { risk, runs } = engine({ answer: async (run) => (run.prompt.includes("Title: PR 1\n") ? { text: "not json" } : { text: HIGH }) });
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(many.length);
    expect(Object.keys(risk.answer().judgments)).toHaveLength(many.length - 1);
  });

  test("saving starts over at once: the person just looked at it", async () => {
    setRules();
    let answer: RiskRunResult = { failed: "Not signed in." };
    const { risk, runs } = engine({ answer: async () => answer });
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    answer = { text: HIGH };
    risk.save({ rules: "Anything in billing.", provider: "pi-sdk", model: null });
    expect(risk.answer().last_failure).toBeNull();
    risk.assess(many);
    await settled();
    expect(Object.keys(risk.answer().judgments)).toHaveLength(many.length);
  });

  test("a failed read is read again, later", async () => {
    setRules();
    let now = 1_000_000;
    const flaky = engine({ now: () => now, diffFails: true });
    flaky.risk.assess([pull(2)]);
    await settled();
    now += RISK_RETRY_MS;
    flaky.risk.assess([pull(2)]);
    await settled();
    expect(flaky.reads).toHaveLength(2);
  });

  test("a PR retargeted to another base: its old mark goes, and it is judged again at the same head", async () => {
    setRules();
    const { risk, runs } = engine();
    risk.assess([pull(1)]);
    await settled();
    expect(risk.answer().judgments["github.com/n/b#1"]?.level).toBe("high");
    risk.assess([pull(1, { base: "release" })]);
    expect(risk.answer().judgments).toEqual({});
    await settled();
    expect(runs).toHaveLength(2);
    expect(risk.answer().judgments["github.com/n/b#1"]?.level).toBe("high");
    // And that judgment stands across a restart, for that base.
    const restarted = engine();
    restarted.risk.assess([pull(1, { base: "release" })]);
    await settled();
    expect(restarted.runs).toEqual([]);
  });

  test("a failure on the old base isn't shown for the new one", async () => {
    setRules();
    const { risk } = engine({ diffFails: true });
    risk.assess([pull(1)]);
    await settled();
    expect(Object.keys(risk.answer().failed)).toEqual(["github.com/n/b#1"]);
    risk.assess([pull(1, { base: "release" })]);
    expect(risk.answer().failed).toEqual({});
  });

  describe("a diff too big for the model, the CLI or the forge", () => {
    const key = "github.com/n/b#1";
    test.each([
      ["a CLI's error", { failed: "Input exceeds the maximum length of 1048576 characters." }, "Input exceeds the maximum length of 1048576 characters."],
      ["a refusal that comes back as an ordinary answer", { text: "Prompt is too long" }, "The agent didn\u2019t answer with a ranking: Prompt is too long"],
      ["a refusal over lines, with reordering characters", { failed: "too\nbig\u202E" }, "too big"],
      ["no words at all", { failed: "  " }, "The agent gave no answer."],
    ] as [string, RiskRunResult, string][])("%s: failed to rank, with the reason, and no level", async (_name, result, reason) => {
      setRules();
      const { risk } = engine({ answer: async () => result });
      risk.assess([pull(1)]);
      await settled();
      const answer = risk.answer();
      expect(answer.judgments).toEqual({});
      expect(answer.failed).toEqual({ [key]: reason });
      expect(answer.last_failure).toBe(reason);
    });

    test("a runner that throws is a reason too", async () => {
      setRules();
      const { risk } = engine({
        answer: async () => {
          throw new Error("opencode: spawn failed");
        },
      });
      risk.assess([pull(1)]);
      await settled();
      expect(risk.answer().failed).toEqual({ [key]: "opencode: spawn failed" });
    });

    test("no diff to read: the reason shows, no agent runs, and nothing waits on it", async () => {
      setRules();
      const { risk, runs } = engine({ diffFails: "pull_diff_failed" });
      risk.assess([pull(1)]);
      await settled();
      expect(runs).toEqual([]);
      expect(risk.answer().judgments).toEqual({});
      expect(risk.answer().failed).toEqual({ [key]: "gh failed" });
      expect(risk.answer().pending).toBe(0);
    });

    test("an error without a forge's code is no sentence for a person", async () => {
      setRules();
      const { risk } = engine({ diffFails: true });
      risk.assess([pull(1)]);
      await settled();
      expect(risk.answer().failed).toEqual({ [key]: "The diff could not be read." });
    });

    test("one PR refused doesn't touch the others' judgments", async () => {
      setRules();
      const { risk } = engine({ answer: async (run) => (run.prompt.includes("Title: PR 1\n") ? { failed: "Too big." } : { text: HIGH }) });
      risk.assess([pull(1), pull(2)]);
      await settled();
      expect(risk.answer().failed).toEqual({ [key]: "Too big." });
      expect(Object.keys(risk.answer().judgments)).toEqual(["github.com/n/b#2"]);
    });

    test("the reason belongs to its head; a later judgment and a save clear it", async () => {
      setRules();
      let now = 1_000_000;
      let answer: RiskRunResult = { failed: "Too big." };
      const { risk } = engine({ now: () => now, answer: async () => answer });
      risk.assess([pull(1)]);
      await settled();
      expect(risk.answer().failed[key]).toBe("Too big.");

      // Listed at a new head that hasn't run: that reason isn't this head's.
      risk.assess([pull(1, { head_sha: "another" })]);
      await settled();
      expect(risk.answer().failed).toEqual({});

      answer = { text: HIGH };
      now += RISK_RETRY_MS;
      risk.assess([pull(1)]);
      await settled();
      expect(risk.answer().failed).toEqual({});
      expect(risk.answer().judgments[key]?.level).toBe("high");

      answer = { failed: "Too big." };
      risk.assess([pull(2)]);
      await settled();
      expect(risk.answer().failed).toEqual({ "github.com/n/b#2": "Too big." });
      risk.save({ rules: "Anything in billing.", provider: "pi-sdk", model: null });
      expect(risk.answer().failed).toEqual({});
    });

    test("a head that moved during the read is no failure: the next list has the new head", async () => {
      setRules();
      const { risk } = engine({ head: () => "head-moved" });
      risk.assess([pull(1)]);
      await settled();
      expect(risk.answer().failed).toEqual({});
    });
  });

  /** The first runs hold the line, so the rest wait in the queue; `release` lets them go. */
  const held = (on: () => boolean = () => true) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const made = engine({
      on,
      answer: async () => {
        await gate;
        return { text: HIGH };
      },
    });
    return { ...made, release };
  };

  test("the switch going off while PRs wait: those run nothing", async () => {
    setRules();
    let on = true;
    const { risk, runs, release } = held(() => on);
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    on = false;
    release();
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    expect(risk.answer().pending).toBe(0);
  });

  test("the rules changing while PRs wait: those run nothing against the old ones", async () => {
    setRules();
    const { risk, runs, release } = held();
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    setRules("Something else.");
    release();
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
  });

  test("the Inbox stopping during a diff read: no agent starts", async () => {
    setRules();
    let release = () => {};
    const { risk, runs, reads } = engine({ diffGate: new Promise<void>((resolve) => (release = resolve)) });
    risk.assess([pull(1)]);
    await settled();
    expect(reads).toHaveLength(1);
    risk.stop();
    release();
    await settled();
    expect(runs).toEqual([]);
  });

  test("the Inbox stopping: nothing more runs, nothing is written, and a later list starts nothing", async () => {
    setRules();
    const { risk, runs, release } = held();
    risk.assess(many);
    await settled();
    risk.stop();
    release();
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    expect(existsSync(join(dataDir, "inbox", INBOX_PULL_RISK_FILE))).toBe(false);
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    expect(risk.answer().pending).toBe(0);
  });

  test("a diff that can't be read, or whose head moved, costs no agent run", async () => {
    setRules();
    const unread = engine({ diffFails: true });
    unread.risk.assess([pull(1)]);
    await settled();
    expect(unread.runs).toEqual([]);
    const moved = engine({ head: () => "head-moved" });
    moved.risk.assess([pull(1)]);
    await settled();
    expect(moved.runs).toEqual([]);
    expect(moved.risk.answer().judgments).toEqual({});
  });
});

describe("the sentence", () => {
  test("characters that reorder text on screen are taken out, from an answer and from what was kept", async () => {
    const tricky = "It changes \u202Eetirw\u202C the \u2066billing\u2069 webhook\u200F.";
    expect(parseRiskAnswer(JSON.stringify({ risk: "high", why: tricky }))).toEqual({ level: "high", why: "It changes etirw the billing webhook." });
    expect(parseRiskAnswer(JSON.stringify({ risk: "high", why: "\u202E\u2066" }))).toBeNull();

    setRules();
    const { risk } = engine();
    risk.assess([pull(1)]);
    await settled();
    const file = join(dataDir, "inbox", INBOX_PULL_RISK_FILE);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.judgments["github.com/n/b#1"].why = tricky;
    writeFileSync(file, JSON.stringify(stored));
    const restarted = engine();
    restarted.risk.assess([pull(1)]);
    expect(restarted.risk.answer().judgments["github.com/n/b#1"]?.why).toBe("It changes etirw the billing webhook.");
  });
});

describe("the person's rules", () => {
  test("stay out of the judgments' file", async () => {
    setRules("Anything about the secret merger.");
    const { risk } = engine();
    risk.assess([pull(1)]);
    await settled();
    const file = join(dataDir, "inbox", INBOX_PULL_RISK_FILE);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("merger");
  });

  test("long rules are the person's to write: a paste isn't cut", () => {
    const { risk } = engine();
    const long = "Anything in billing. ".repeat(2_000).trim();
    risk.save({ rules: long, provider: "pi-sdk", model: null });
    expect(risk.answer().rules).toBe(long);
  });

  test("save takes the dialog's three fields and refuses anything else", () => {
    const { risk } = engine();
    risk.save({ rules: "  Billing.  ", provider: "pi-sdk", model: "a/b" });
    expect(risk.answer()).toMatchObject({ rules: "Billing.", provider: "pi-sdk", model: "a/b" });
    for (const bad of [{ rules: 1, provider: null, model: null }, { rules: "x", provider: "rm -rf", model: null }, { rules: "x", provider: null, model: 3 }]) {
      expect(() => risk.save(bad)).toThrow();
    }
    expect(risk.answer().rules).toBe("Billing.");
  });
});

describe("one run on a provider", () => {
  const provider = (messages: AIMessage[] | (() => AsyncIterable<AIMessage>), seen: { options?: CreateSessionOptions; aborted?: boolean } = {}): AIProvider =>
    ({
      name: "stub",
      models: [{ id: "big" }, { id: "claude-sonnet-5", reasoningEfforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] }, { id: "claude-haiku-4-5" }],
      createSession: async (options: CreateSessionOptions) => {
        seen.options = options;
        return {
          abort: () => (seen.aborted = true),
          query: typeof messages === "function" ? messages : async function* () { yield* messages; },
        };
      },
    }) as unknown as AIProvider;
  const run = { model: null, system: "SYSTEM", prompt: "PROMPT", cwd: "/empty" };

  test("no tools, one turn, the empty folder, the chosen model at its lowest effort", async () => {
    const seen: { options?: CreateSessionOptions } = {};
    const answer = await runRiskAgent(provider([{ type: "result", sessionId: "s", success: true, result: HIGH }], seen), { ...run, model: "claude-sonnet-5" });
    expect(answer).toEqual({ text: HIGH });
    expect(seen.options).toMatchObject({ cwd: "/empty", model: "claude-sonnet-5", reasoningEffort: "low", maxTurns: 1, oneShot: { systemPrompt: "SYSTEM" } });
  });

  test("no model saved: Pi and OpenCode run on the person's own default, and no flag names one", async () => {
    for (const name of ["pi-sdk", "opencode-sdk"]) {
      const seen: { options?: CreateSessionOptions } = {};
      const stub = Object.assign(provider([], seen), { name });
      await runRiskAgent(stub, run);
      expect(seen.options!.model).toBeUndefined();
    }
  });

  test("a model that takes no effort gets none", async () => {
    const seen: { options?: CreateSessionOptions } = {};
    await runRiskAgent(provider([], seen), { ...run, model: "claude-haiku-4-5" });
    expect(seen.options!.reasoningEffort).toBeUndefined();
  });

  test.each([
    ["uses a tool", { type: "tool_use", toolName: "Bash", toolInput: {}, toolUseId: "t" }, "The agent tried to use a tool, so its answer was dropped."],
    ["asks permission", { type: "permission_request", requestId: "r", toolName: "Bash", toolInput: {}, toolUseId: "t" }, "The agent tried to use a tool, so its answer was dropped."],
    ["errors", { type: "error", error: "prompt is too long" }, "prompt is too long"],
    ["ends in a failed result", { type: "result", sessionId: "s", success: false, result: "context_length_exceeded" }, "context_length_exceeded"],
    ["ends in a failed result with no words", { type: "result", sessionId: "s", success: false }, "The agent stopped with an error."],
  ] as [string, AIMessage, string][])("an agent that %s ends the run, with its reason and no answer even after a verdict", async (_name, message, reason) => {
    const seen: { aborted?: boolean } = {};
    const answer = await runRiskAgent(provider([{ type: "text", text: HIGH }, message, { type: "result", sessionId: "s", success: true, result: HIGH }], seen), run);
    expect(answer).toEqual({ failed: reason });
    expect(seen.aborted).toBe(true);
  });

  test("an agent that says nothing has no answer", async () => {
    expect(await runRiskAgent(provider([{ type: "result", sessionId: "s", success: true }]), run)).toEqual({ failed: "The agent gave no answer." });
  });

  test("an agent that never answers ends at the timeout", async () => {
    const hung = provider(async function* () {
      await new Promise(() => {});
    });
    expect(await runRiskAgent(hung, run, 5)).toHaveProperty("failed");
  });

  test("a stop ends a running agent at once, and closes it", async () => {
    const seen: { aborted?: boolean } = {};
    const hung = provider(async function* () {
      await new Promise(() => {});
    }, seen);
    const stopping = new AbortController();
    const answer = runRiskAgent(hung, run, 60_000, stopping.signal);
    await Bun.sleep(5);
    stopping.abort();
    expect(await answer).toHaveProperty("failed");
    expect(seen.aborted).toBe(true);
  });

  test("an agent that never opens its session ends at the timeout too, and the session is closed if it comes late", async () => {
    let open = (_: unknown) => {};
    let closed = 0;
    const hung = {
      name: "stub",
      models: [],
      createSession: () => new Promise((resolve) => (open = resolve)),
    } as unknown as AIProvider;
    expect(await runRiskAgent(hung, run, 5)).toHaveProperty("failed");
    open({ abort: () => closed++, dispose: () => closed++, query: async function* () {} });
    await Bun.sleep(5);
    expect(closed).toBe(2);
  });

});

describe("a very large diff through the real providers, with fake CLIs", () => {
  // Codex's provider reads $CODEX_HOME/config.toml: a scratch one, never the person's.
  const savedCodexHome = process.env.CODEX_HOME;
  beforeEach(() => {
    process.env.CODEX_HOME = join(dataDir, "codex-home");
  });
  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
  });

  // Past Linux's 128 KB for one argument and macOS's 1 MB for all of them, and past the reader's own 8 MB.
  const diff = "+a changed line of a file\n".repeat(360_000);
  const key = "github.com/n/b#1";

  /** A CLI in Bun's own runner: it keeps its argv in `<log>.argv`, and `script` answers each line of its stdin. */
  const fakeCli = (name: string, script: string) => {
    const log = join(dataDir, `${name}.log`);
    const path = join(dataDir, name);
    writeFileSync(
      path,
      `#!/bin/sh
exec ${JSON.stringify(process.execPath)} -e '
const fs=require("fs");const log=${JSON.stringify(log)};
fs.writeFileSync(log+".argv",process.argv.slice(1).join("\\n"));
const out=(m)=>process.stdout.write(JSON.stringify(m)+"\\n");
require("readline").createInterface({input:process.stdin}).on("line",(l)=>{const m=JSON.parse(l);${script}});
' -- "$@"
`,
    );
    chmodSync(path, 0o755);
    return { path, argv: () => readFileSync(`${log}.argv`, "utf8"), arrived: () => readFileSync(log, "utf8") };
  };
  /** The whole path a refusal takes: this provider, one run, and what the window is told. */
  const refusedBy = async (provider: AIProvider, model: string) => {
    setRules("Billing.", "pi-sdk", model);
    const risk = createPullRisk({
      dataDir,
      isOn: () => true,
      agents: () => AGENTS,
      pulls: { wholeDiff: async () => ({ patch: diff, partial: false, head_sha: "head-1" }) },
      run: (run) => runRiskAgent(provider, run),
    });
    risk.assess([pull(1)]);
    for (let i = 0; i < 2000 && risk.answer().pending > 0; i++) await Bun.sleep(10);
    provider.dispose();
    const answer = risk.answer();
    expect(answer.judgments).toEqual({});
    return answer.failed[key];
  };
  const posix = process.platform !== "win32";

  test.if(posix)("Claude Code: on stdin, whole; its \"Prompt is too long\" is a reason, not a ranking", async () => {
    const cli = fakeCli(
      "claude",
      `if(m.type==="control_request")return out({type:"control_response",response:{subtype:"success",request_id:m.request_id,response:{}}});
       if(m.type==="user"){const c=m.message.content;fs.writeFileSync(log,typeof c==="string"?c:c.map((x)=>x.text).join(""));out({type:"result",subtype:"success",is_error:true,result:"Prompt is too long",session_id:"s",num_turns:0});}`,
    );
    const provider = new ClaudeAgentSDKProvider({ type: "claude-agent-sdk", cwd: dataDir, claudeExecutablePath: cli.path, allowedTools: [] });
    const reason = await refusedBy(provider, "sonnet");
    expect(reason).toBe("The agent didn\u2019t answer with a ranking: Prompt is too long");
    expect(cli.arrived()).toContain(diff);
    expect(cli.argv().length).toBeLessThan(10_000);
  });

  test.if(posix)("Pi: on stdin, whole, its echo on stdout no trouble; its refusal is the reason", async () => {
    const cli = fakeCli(
      "pi",
      `if(m.id!==undefined&&m.type!=="prompt")return out({type:"response",id:m.id,command:m.type,success:true,data:{}});
       if(m.type==="prompt"){fs.writeFileSync(log,m.message);out({type:"response",id:m.id,command:m.type,success:true,data:{}});out({type:"message_start",message:{role:"user",content:m.message}});out({type:"message_end",message:{role:"assistant",stopReason:"error",errorMessage:"prompt is too long: 2500000 tokens > 200000 maximum"}});out({type:"agent_end"});}`,
    );
    const provider = new PiSDKProvider({ type: "pi-sdk", cwd: dataDir, piExecutablePath: cli.path });
    expect(await refusedBy(provider, "anthropic/claude-sonnet-5")).toBe("prompt is too long: 2500000 tokens > 200000 maximum");
    expect(cli.arrived()).toContain(diff);
    expect(cli.argv().length).toBeLessThan(10_000);
  });

  const fakeCodex = (turn: string) =>
    fakeCli(
      "codex",
      `if(m.id===undefined||m.method===undefined)return;
       if(m.method==="thread/start")return out({id:m.id,result:{thread:{id:"th"}}});
       if(m.method==="turn/start"){const text=m.params.input.map((x)=>x.text).join("");fs.writeFileSync(log,text);${turn}return;}
       out({id:m.id,result:{}});`,
    );

  test.if(posix)("Codex: on stdin, whole, its echo on stdout no trouble; a failed turn's words are the reason", async () => {
    const cli = fakeCodex(
      `out({id:m.id,result:{turn:{id:"tu"}}});out({method:"item/started",params:{item:{type:"userMessage",id:"u",content:[{type:"text",text}]}}});out({method:"turn/completed",params:{turn:{id:"tu",status:"failed",error:{message:"Your input exceeds the context window of this model."}}}});`,
    );
    const provider = new CodexAppServerProvider({ type: "codex-sdk", cwd: dataDir, codexExecutablePath: cli.path });
    expect(await refusedBy(provider, "gpt-6-luna")).toBe("Your input exceeds the context window of this model.");
    expect(cli.arrived()).toContain(diff);
    expect(cli.argv().length).toBeLessThan(10_000);
  });

  test.if(posix)("Codex refusing the turn outright: the reason shows", async () => {
    const cli = fakeCodex(`out({id:m.id,error:{code:-32602,message:"Input exceeds the maximum length of 1048576 characters."}});`);
    const provider = new CodexAppServerProvider({ type: "codex-sdk", cwd: dataDir, codexExecutablePath: cli.path });
    expect(await refusedBy(provider, "gpt-6-luna")).toBe("Codex rejected the turn: Input exceeds the maximum length of 1048576 characters.");
  });

});

describe("the model it starts on", () => {
  const ids = (...list: string[]) => list.map((id) => ({ id, label: id }));
  test("Claude: Sonnet", () => {
    expect(startingRiskModel("claude-agent-sdk", [{ ...ids("opus")[0]!, default: true }, ...ids("sonnet", "haiku")])).toBe("sonnet");
    // A list with no alias still lands on its Sonnet family, or the list's own default.
    expect(startingRiskModel("claude-agent-sdk", [{ ...ids("opus")[0]!, default: true }])).toBe("opus");
  });
  test("Codex: the newest Luna, whatever the order", () => {
    expect(startingRiskModel("codex-sdk", ids("gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra"))).toBe("gpt-6-luna");
    expect(startingRiskModel("codex-sdk", ids("gpt-6-luna", "gpt-6.10-luna", "gpt-6.9-luna"))).toBe("gpt-6.10-luna");
  });
  test("Codex without a Luna: its own default, or nothing", () => {
    expect(startingRiskModel("codex-sdk", [...ids("gpt-6-astra"), { ...ids("gpt-6-sol")[0]!, default: true }])).toBe("gpt-6-sol");
    expect(startingRiskModel("codex-sdk", [])).toBeNull();
  });
  test("what the dialog is told to start on is the same pick, from the agent's list", async () => {
    const risk = createPullRisk({ dataDir, isOn: () => true, pulls: { wholeDiff: async () => ({ patch: "", partial: false, head_sha: null }) }, listModels: async () => [{ id: "gpt-6-sol", label: "Sol", default: true }, { id: "gpt-6-luna", label: "Luna" }] });
    expect(await risk.models("codex-sdk")).toEqual({ models: [{ id: "gpt-6-sol", label: "Sol" }, { id: "gpt-6-luna", label: "Luna" }], default_model: "gpt-6-luna" });
    expect((await risk.models("pi-sdk")).default_model).toBeNull();
  });
  test("Pi and OpenCode: the person's own default, even with a cheap model listed", () => {
    expect(startingRiskModel("pi-sdk", ids("anthropic/claude-sonnet-5", "openai/gpt-6-luna"))).toBeNull();
    expect(startingRiskModel("opencode-sdk", ids("anthropic/claude-sonnet-5"))).toBeNull();
  });
});

describe("finding the agent", () => {
  const savedPath = process.env.PATH;
  const savedSandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedSandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
    else process.env.PLANNOTATOR_TEST_SANDBOX = savedSandbox;
  });

  test("a test Inbox finds its fake in a temp folder, and never a CLI outside one", () => {
    const fake = join(dataDir, "fake-agent");
    writeFileSync(fake, "#!/bin/sh\n");
    chmodSync(fake, 0o755);
    process.env.PATH = `${dataDir}:/bin:/usr/bin`;
    process.env.PLANNOTATOR_TEST_SANDBOX = "1";
    expect(installedPath("fake-agent")).toBe(fake);
    expect(installedPath("sh")).toBeNull();
    delete process.env.PLANNOTATOR_TEST_SANDBOX;
    expect(installedPath("sh")).not.toBeNull();
  });
});
