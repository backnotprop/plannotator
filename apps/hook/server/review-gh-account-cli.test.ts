/**
 * `plannotator review <GitHub PR URL>` with two signed-in gh accounts (#2157),
 * a real spawn of the CLI entry against a fake `gh` (tests/helpers/fake-gh.ts)
 * first on PATH, with a scratch HOME, gh config dir and data dir. The real gh,
 * its config and the network are never reached.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_PATCH, makeFakeGh, type FakeGh } from "../../../tests/helpers/fake-gh";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const cliEntry = join(import.meta.dir, "index.ts");
const URL = "https://github.com/acme/widgets/pull/7";
const WORK_TOKEN = "gho_workTOKENcli0002";

let fake: FakeGh | undefined;
let workDir: string | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let stubs: string[] = [];

afterEach(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill();
    await proc.exited;
  }
  proc = undefined;
  removeStubbedHtml(stubs);
  stubs = [];
  fake?.cleanup();
  fake = undefined;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

/** A local repository holding refs/pull/7/head, for the fake `gh repo clone`. Real git, no user config. */
function makeCloneSource(dir: string): string {
  const git = Bun.which("git");
  if (!git) throw new Error("git is needed for the --local test");
  const env = { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (...args: string[]) => {
    const r = Bun.spawnSync([git, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: src, env });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  const src = join(dir, "source");
  mkdirSync(src);
  run("init", "-q", "-b", "main");
  writeFileSync(join(src, "app.ts"), "new\n");
  run("add", "app.ts");
  run("commit", "-q", "-m", "pr head");
  run("update-ref", "refs/pull/7/head", "HEAD");
  return src;
}

function startReview(readers: string[], local = false): { readyFile: string; stderr: () => string } {
  stubs = stubHookDistHtml();
  workDir = mkdtempSync(join(tmpdir(), "plannotator-gh-account-cli-"));
  fake = makeFakeGh({
    accounts: [{ login: "tobey", token: "gho_personalTOKENcli0001", active: true }, { login: "tobey-work", token: WORK_TOKEN }],
    repos: { "acme/widgets": { readers, prs: [7] } },
    ...(local ? { wrapGit: true, cloneSource: makeCloneSource(workDir) } : {}),
  });
  const readyFile = join(workDir, "ready.json");
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...fake.env,
    NO_BROWSER,
    PLANNOTATOR_CWD: workDir,
    PLANNOTATOR_DATA_DIR: join(workDir, "data"),
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
    PLANNOTATOR_REMOTE: "0",
    PLANNOTATOR_AI: "disabled",
  };
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"]) delete env[k];
  proc = Bun.spawn([process.execPath, cliEntry, "review", URL, ...(local ? [] : ["--no-local"])], {
    cwd: workDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderr = "";
  (async () => {
    for await (const chunk of proc!.stderr as ReadableStream<Uint8Array>) stderr += new TextDecoder().decode(chunk);
  })();
  return { readyFile, stderr: () => stderr };
}

async function waitForReady(readyFile: string, stderr: () => string): Promise<string> {
  for (let i = 0; i < 300; i++) {
    if (existsSync(readyFile)) {
      try {
        return (JSON.parse(readFileSync(readyFile, "utf-8")) as { url: string }).url.replace(/\/$/, "");
      } catch { /* partially written */ }
    }
    if (proc?.exitCode !== null) break;
    await Bun.sleep(100);
  }
  throw new Error(`review server never became ready:\n${stderr()}`);
}

describe("plannotator review <GitHub PR> with two gh accounts", () => {
  test("no signed-in account can see the PR: exits 1 before the review opens", async () => {
    const run = startReview([]);
    const code = await Promise.race([proc!.exited, Bun.sleep(30_000).then(() => "timeout")]);
    expect(code).toBe(1);
    await Bun.sleep(50);
    expect(run.stderr()).toContain("Your active gh account tobey can't see acme/widgets (pull request #7).");
    expect(run.stderr()).toContain("Your other signed-in github.com accounts can't see it either: tobey-work.");
    expect(run.stderr()).toContain("`gh auth switch -u <user>`");
    expect(existsSync(run.readyFile)).toBe(false);
    expect(fake!.calls().some((c) => c.args[0] === "pr")).toBe(false);
  }, 40_000);

  test("the work account can: the review opens as it, says so, and never switches gh", async () => {
    const run = startReview(["tobey-work"]);
    const base = await waitForReady(run.readyFile, run.stderr);
    expect(run.stderr()).toContain(
      "Using gh account tobey-work for this review: your active account tobey can't see acme/widgets. Your gh setting is unchanged.",
    );
    const diff = (await (await fetch(`${base}/api/diff`)).json()) as Record<string, unknown>;
    expect(diff.rawPatch).toBe(FAKE_PATCH);
    expect(JSON.stringify(diff)).not.toContain(WORK_TOKEN);
    expect(run.stderr()).not.toContain(WORK_TOKEN);

    const calls = fake!.calls();
    expect(calls.some((c) => c.args[0] === "auth" && c.args[1] === "switch")).toBe(false);
    const prCalls = calls.filter((c) => c.args[0] === "pr");
    expect(prCalls.length).toBeGreaterThan(0);
    expect(prCalls.every((c) => c.as === "tobey-work")).toBe(true);

    try { await fetch(`${base}/api/exit`, { method: "POST" }); } catch { /* already gone */ }
    await Promise.race([proc!.exited, Bun.sleep(5_000)]);
  }, 40_000);

  test("--local: the clone and this PR's git fetches run as the work account, other git calls don't", async () => {
    const run = startReview(["tobey-work"], true);
    const base = await waitForReady(run.readyFile, run.stderr);
    for (let i = 0; i < 300 && !/Local checkout (ready|failed)|Warning: local checkout/i.test(run.stderr()); i++) await Bun.sleep(100);
    expect(run.stderr()).toContain("Local checkout ready at");
    expect(run.stderr()).not.toContain(WORK_TOKEN);

    const calls = fake!.calls();
    const clone = calls.filter((c) => !c.git && c.args[0] === "repo" && c.args[1] === "clone");
    expect(clone).toHaveLength(1);
    expect(clone[0].as).toBe("tobey-work");
    const fetches = calls.filter((c) => c.git && c.args.includes("fetch"));
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.every((c) => c.as === "tobey-work")).toBe(true);
    // The token is not in the CLI's own environment: its other git calls run without it.
    expect(calls.some((c) => c.git && !c.args.includes("fetch") && c.as === null)).toBe(true);

    try { await fetch(`${base}/api/exit`, { method: "POST" }); } catch { /* already gone */ }
    await Promise.race([proc!.exited, Bun.sleep(5_000)]);
  }, 60_000);
});
