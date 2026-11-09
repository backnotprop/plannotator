/**
 * A scratch world on a real TypeScript project, for the Guide tab's hover
 * check (`tests/screenshots/hover-latency.ts`): a local clone of this
 * repository with `main` at a base commit and a branch at a later one (a real
 * change to the VS Code extension's TypeScript), the clone's `node_modules`
 * linked to this checkout's so the TypeScript server sees the real types, and
 * a saved guided review of that change (chapters by folder) written straight
 * into the guide store. No agent, no network.
 *
 *   PLANNOTATOR_DATA_DIR=<scratch>/pn-data bun tests/screenshots/make-ts-fixture.ts <scratch dir> [base] [head]
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildGuideSnapshot } from "@plannotator/core/guide-format";
import { buildLocalChangesPatch, getRepoInfo } from "../../src/guides/sources/git";
import { defaultRunner } from "../../src/guides/sources/runner";
import { saveFinishedGuide, snapshotSource, sourceGitRef, type ReviewSourceRecord } from "../../src/guides/store";

// `--pr`: the guide is of pull request #2124 instead of local changes; the clone stays on `main`
// and the reader reads the head from a worktree it makes in the extension's storage (outside the workspace).
const asPr = process.argv.includes("--pr");
const [scratch, baseArg, headArg] = process.argv.slice(2).filter((a) => a !== "--pr");
if (!scratch) throw new Error("usage: make-ts-fixture.ts <scratch dir> [base] [head]");
if (!process.env.PLANNOTATOR_DATA_DIR?.startsWith(resolve(scratch))) throw new Error("set PLANNOTATOR_DATA_DIR inside the scratch dir");

const source = resolve(import.meta.dir, "../../../..");
const sourceGit = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
// Default: the change that added "Ask the agent" (#2124), 65 files of the extension's TypeScript.
const head = headArg ?? sourceGit("rev-parse", "403f54e5a");
const base = baseArg ?? sourceGit("rev-parse", `${head}^1`);

const repo = join(resolve(scratch), "plannotator");
rmSync(repo, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
execFileSync("git", ["clone", "--quiet", "--no-checkout", source, repo]);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "Dana", GIT_COMMITTER_EMAIL: "dana@example.com" } }).trim();
git("config", "commit.gpgsign", "false");
git("checkout", "--quiet", "-B", "main", base);
git("checkout", "--quiet", "-B", "feat/vscode-guides-ask", head);
// A GitHub-looking origin names the repository (never fetched: the world's gh is fake).
git("remote", "set-url", "origin", "https://github.com/backnotprop/plannotator.git");
git("update-ref", "refs/remotes/origin/main", base);
git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

// The TypeScript server resolves types through node_modules: link this checkout's.
const linkModules = (rel: string) => {
  const from = join(source, rel, "node_modules");
  const to = join(repo, rel, "node_modules");
  if (existsSync(from) && !existsSync(to) && existsSync(join(repo, rel))) symlinkSync(from, to);
};
linkModules(".");
for (const group of ["apps", "packages"]) {
  for (const name of readdirSync(join(source, group))) linkModules(join(group, name));
}

const runner = defaultRunner;
const info = await getRepoInfo(runner, repo);
if (!info) throw new Error("not a repository");
const local = await buildLocalChangesPatch(runner, info, "since-base");
if (asPr) git("checkout", "--quiet", "main");

// Chapters by folder, in a reading order: the model first, then the extension, the views, tests, the rest.
const ORDER: Array<[RegExp, string, string]> = [
  [/^apps\/vscode-extension\/src\/guides\/ask\//, "The question and its answer", "The ask session (ACP), the answer tool the agent calls, and where answers are kept. `GuideAskSession` loads the guide's own session when the agent can, else starts one seeded with the guide."],
  [/^apps\/vscode-extension\/src\/guides\/vscode\//, "Asking from the editor", "The box under the selected lines is a comment thread (`AskThreads`); `GuideAsks` runs one question at a time per guide and opens the answer beside the diff."],
  [/^apps\/vscode-extension\/src\/guides\/webview\//, "The answer page", "The answer tab shows the agent's page in a sandboxed frame; messages from it are checked by `fromWebviewHost`."],
  [/^apps\/vscode-extension\/src\/guides\//, "Shared pieces", "The protocol between the webviews and the extension, the trust checks and the store."],
  [/^apps\/vscode-extension\/(tests|scripts|mocks)\//, "Tests and scripts", "The fake ACP agent learns to answer questions; the screenshot driver asks one."],
  [/^tests\//, "End to end", "The answer frame under the real CSP, in Chromium."],
  [/./, "Everything else", "Package metadata, images, docs and CI."],
];
const chapters = ORDER.map(([, title, overview]) => ({ title, overview, diffs: [] as Array<{ file: string; summary: string }> }));
for (const f of local.files) {
  const i = ORDER.findIndex(([re]) => re.test(f.path));
  chapters[i].diffs.push({ file: f.path, summary: `${f.status === "added" ? "New" : "Changed"}: ${f.path.split("/").pop()} (+${f.additions} −${f.deletions}).` });
}
const sections = chapters.filter((c) => c.diffs.length > 0);

const sourceRecord: ReviewSourceRecord = {
  kind: asPr ? "pr" : "local",
  repoRoot: info.root,
  headRoot: info.root,
  repoName: info.displayName,
  label: asPr ? "PR #2124" : "Local changes",
  ...(asPr && { pr: { number: 2124, url: "https://github.com/backnotprop/plannotator/pull/2124", title: "VS Code Guided Reviews: ask the agent" } }),
  branch: info.branch,
  headSha: info.headSha,
  baseSha: local.baseSha,
  baseLabel: local.baseLabel,
  workingTree: true,
};
const snapshot = buildGuideSnapshot({
  guide: {
    title: "Ask the agent about a guided review",
    intent: "Select code in a guide's diff and ask; the agent that wrote the guide answers with a page beside the diff.",
    overview: { text: "A question goes from the editor ([GuideAsks](symbol:GuideAsks)) to an ACP session ([GuideAskSession](symbol:GuideAskSession)); the agent answers with `show_answer`, and the page opens in a sandboxed frame ([chapter 3](chapter:3))." },
    sections,
  },
  reviewed: sections.map(() => false),
  review: { rawPatch: local.rawPatch, gitRef: sourceGitRef(sourceRecord), base: local.baseLabel, source: snapshotSource(sourceRecord) },
  generator: { engine: "claude", model: "sonnet" },
});
const id = saveFinishedGuide({
  repoKey: info.repoKey,
  snapshot,
  source: sourceRecord,
  agent: { id: "claude-code", label: "Claude Code", model: { id: "sonnet", label: "Sonnet" }, effort: { id: "low", label: "Low" } },
  focus: {},
});
console.log(JSON.stringify({ repo, repoKey: info.repoKey, guideId: id, files: local.files.length, chapters: sections.length }));
