/**
 * A fake `gh` for tests of which signed-in account a GitHub PR review runs as
 * (#2157). `makeFakeGh` writes a `gh` into a scratch bin folder (a sh wrapper
 * that runs this file with bun); put that folder first on PATH. The real gh,
 * the real ~/.config/gh and the network are never touched.
 *
 * The fake knows a few accounts on one host. It acts as the account whose
 * token is in GH_TOKEN / GH_ENTERPRISE_TOKEN, else as the active one, and
 * answers only what that account may read. Every call is logged (args and
 * the account it acted as, never a token) to `log`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeGhAccount {
  login: string;
  token: string;
  active?: boolean;
  /** `success` by default; anything else is a broken login gh can't use. */
  state?: string;
  tokenSource?: string;
}

export interface FakeGhScenario {
  host?: string;
  accounts: FakeGhAccount[];
  /** `owner/repo` → the logins that can read it, and its PR numbers. */
  repos: Record<string, { readers: string[]; prs: number[] }>;
  /** false: answer `--json` like a gh before v2.81.0 (unknown flag). Default true. */
  jsonStatus?: boolean;
  /** true: `gh auth token --user` is refused (an old gh without --user). */
  noTokenUser?: boolean;
  /** true: every `gh api` call fails as if offline. */
  offline?: boolean;
  /** Logins whose `gh api` calls fail as if offline (no verdict). */
  offlineFor?: string[];
  /** true: refuse `gh auth status --active` (an older gh). */
  noActiveFlag?: boolean;
  /** A local git repository `gh repo clone` clones (it holds refs/pull/N/head). */
  cloneSource?: string;
  /** true: also put a `git` first on PATH that logs which account's token it got, then runs the real git. */
  wrapGit?: boolean;
  /**
   * true: a GH_TOKEN that names no account is a token GitHub rejects, and
   * `gh auth status` / `gh auth token --user` answer like the real gh then:
   * the env token listed first, active, failed, with no login; the signed-in
   * accounts after it, inactive. Every other command fails Bad credentials.
   */
  rejectEnvToken?: boolean;
  /** Set by makeFakeGh: the real git, for `repo clone` and the git wrapper. */
  realGit?: string;
}

export interface FakeGhCall {
  args: string[];
  /** gh: the account it acted as. git: the account whose token was in its env, or null. */
  as: string | null;
  /** Present on a call to the git wrapper. */
  git?: true;
}

export interface FakeGh {
  binDir: string;
  /** Env to spawn with: PATH (fake first), a scratch HOME and gh config dir. */
  env: Record<string, string>;
  calls(): FakeGhCall[];
  cleanup(): void;
}

export const FAKE_PATCH = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n";

export function makeFakeGh(scenario: FakeGhScenario): FakeGh {
  const root = mkdtempSync(join(tmpdir(), "plannotator-fake-gh-"));
  const binDir = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(binDir);
  mkdirSync(home);
  const scenarioFile = join(root, "scenario.json");
  const log = join(root, "calls.jsonl");
  const realGit = Bun.which("git");
  writeFileSync(scenarioFile, JSON.stringify({ ...scenario, ...(realGit ? { realGit } : {}) }));
  writeFileSync(log, "");
  const gh = join(binDir, "gh");
  writeFileSync(gh, `#!/bin/sh\nexec '${process.execPath}' '${import.meta.path}' "$@"\n`);
  chmodSync(gh, 0o755);
  if (scenario.wrapGit) {
    const git = join(binDir, "git");
    writeFileSync(git, `#!/bin/sh\nexec '${process.execPath}' '${import.meta.path}' --fake-git "$@"\n`);
    chmodSync(git, 0o755);
  }
  const PATH = `${binDir}:/usr/bin:/bin`;
  // The command the code under test runs as `gh` must be this fake, never the real gh.
  if (Bun.which("gh", { PATH }) !== gh) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`fake gh: ${gh} is not what PATH finds as gh`);
  }
  return {
    binDir,
    env: {
      PATH,
      HOME: home,
      GH_CONFIG_DIR: join(home, "gh-config"),
      XDG_CONFIG_HOME: join(home, "config"),
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      FAKE_GH_SCENARIO: scenarioFile,
      FAKE_GH_LOG: log,
    },
    calls: () =>
      readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeGhCall),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Run a PR runtime (`bun`: packages/server/pr.ts, `pi`: the Pi extension's)
 * in a child process whose env is only the fake's (PATH with the fake gh
 * first, scratch HOME and gh config dir): it checks auth for acme/widgets#7,
 * then reads the user and fetches the PR. Two accounts: tobey (active) and
 * tobey-work; `readers` says which can read the repo.
 */
export async function probeGhAccountRuntime(
  which: "bun" | "pi",
  readers: string[],
): Promise<{ fake: FakeGh; out: Record<string, unknown> }> {
  const fake = makeFakeGh({
    accounts: [{ login: "tobey", token: "gho_personal01", active: true }, { login: "tobey-work", token: "gho_work02" }],
    repos: { "acme/widgets": { readers, prs: [7] } },
  });
  const probe = join(import.meta.dir, "gh-account-runtime-probe.ts");
  const proc = Bun.spawn([process.execPath, probe, which, "acme/widgets", "7"], {
    env: { ...fake.env, NO_BROWSER: "/usr/bin/true" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    fake.cleanup();
    throw new Error(`probe exited ${code}: ${stderr}`);
  }
  return { fake, out: JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown> };
}

// --- The fake itself, when run as `gh` ---

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function runFake(args: string[]): number {
  const scenario = JSON.parse(readFileSync(process.env.FAKE_GH_SCENARIO!, "utf-8")) as FakeGhScenario;
  const host = scenario.host ?? "github.com";
  const envVar = host === "github.com" || host.endsWith(".ghe.com") ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN";
  const envToken = process.env[envVar];
  const active = scenario.accounts.find((a) => a.active) ?? null;
  const me = envToken ? scenario.accounts.find((a) => a.token === envToken) ?? null : active;
  appendFileSync(process.env.FAKE_GH_LOG!, `${JSON.stringify({ args, as: me?.login ?? null })}\n`);
  const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  const err = (s: string, code = 1) => {
    process.stderr.write(`${s}\n`);
    return code;
  };
  const [cmd, sub] = args;
  const envRejected = !!envToken && !me;
  if (envRejected && !(scenario.rejectEnvToken && cmd === "auth" && (sub === "status" || sub === "token"))) {
    return err("gh: Bad credentials (HTTP 401)");
  }

  if (cmd === "auth" && sub === "status") {
    const onlyActive = args.includes("--active");
    if (onlyActive && scenario.noActiveFlag) return err("unknown flag: --active\n\nUsage:  gh auth status [flags]");
    if (envRejected) {
      // The real gh: the rejected env token is the active source; the
      // keyring accounts are still listed, none of them active.
      const rest = onlyActive ? [] : scenario.accounts.map((a) => ({ ...a, active: false }));
      if (args.includes("--json")) {
        if (scenario.jsonStatus === false) return err('unknown flag: --json\n\nUsage:  gh auth status [flags]');
        const entries = [
          { state: "error", error: "non-200 OK status code: 401 Unauthorized", active: true, host, login: "", tokenSource: envVar, gitProtocol: "https" },
          ...rest.map((a) => ({ state: a.state ?? "success", active: false, host, login: a.login, tokenSource: a.tokenSource ?? "keyring", gitProtocol: "https" })),
        ];
        out(JSON.stringify({ hosts: { [host]: entries } }));
        return 0;
      }
      const lines = [host, `  X Failed to log in to ${host} using token (${envVar})`, "  - Active account: true", `  - The token in ${envVar} is invalid.`, ""];
      for (const a of rest) {
        lines.push(`  ✓ Logged in to ${host} account ${a.login} (${a.tokenSource ?? "keyring"})`, "  - Active account: false", "");
      }
      return err(lines.join("\n"));
    }
    const listed = onlyActive ? scenario.accounts.filter((a) => a.active) : scenario.accounts;
    if (args.includes("--json")) {
      if (scenario.jsonStatus === false) return err('unknown flag: --json\n\nUsage:  gh auth status [flags]');
      const entries = listed.map((a) => ({
        state: a.state ?? "success",
        active: !!a.active,
        host,
        login: a.login,
        tokenSource: a.tokenSource ?? "keyring",
        token: "gho_************************************",
        scopes: "repo, read:org",
        gitProtocol: "https",
      }));
      out(JSON.stringify({ hosts: { [host]: entries } }));
      return 0;
    }
    const lines = [host];
    for (const a of listed) {
      const ok = (a.state ?? "success") === "success";
      lines.push(
        ok
          ? `  ✓ Logged in to ${host} account ${a.login} (${a.tokenSource ?? "keyring"})`
          : `  X Failed to log in to ${host} account ${a.login} (${a.tokenSource ?? "keyring"})`,
        `  - Active account: ${a.active ? "true" : "false"}`,
        "  - Git operations protocol: https",
        "  - Token: gho_************************************",
        "",
      );
    }
    // Like gh: any broken account listed makes the text form exit 1, on stderr.
    if (listed.some((a) => (a.state ?? "success") !== "success")) return err(lines.join("\n"));
    out(lines.join("\n"));
    return 0;
  }
  if (cmd === "auth" && sub === "token") {
    const user = flag(args, "--user") ?? flag(args, "-u");
    if (user && scenario.noTokenUser) return err("unknown flag: --user");
    const account = user ? scenario.accounts.find((a) => a.login === user) : me;
    if (!account) return err(`no account found for ${user}`);
    out(account.token);
    return 0;
  }
  if (cmd === "auth") return err(`fake gh: unexpected auth ${sub}`);
  if (me && (me.state ?? "success") !== "success") return err("gh: Bad credentials (HTTP 401)");

  const readable = (repo: string) => !!me && (scenario.repos[repo]?.readers.includes(me.login) ?? false);
  if (cmd === "api") {
    if (scenario.offline || (me && scenario.offlineFor?.includes(me.login))) return err("error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com");
    const endpoint = sub ?? "";
    if (endpoint === "user") {
      out(me?.login ?? "");
      return 0;
    }
    let m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(endpoint);
    if (m) {
      if (!readable(m[1]) || !scenario.repos[m[1]].prs.includes(Number(m[2]))) return err("gh: Not Found (HTTP 404)");
      out(m[2]);
      return 0;
    }
    m = /^repos\/([^/]+\/[^/]+)$/.exec(endpoint);
    if (m) {
      if (!readable(m[1])) return err("gh: Not Found (HTTP 404)");
      out(m[1]);
      return 0;
    }
    m = /^repos\/([^/]+\/[^/]+)\/compare\//.exec(endpoint);
    if (m && readable(m[1])) {
      out("c".repeat(40));
      return 0;
    }
    return err("gh: Not Found (HTTP 404)");
  }
  if (cmd === "repo" && sub === "clone") {
    // gh repo clone OWNER/REPO DEST -- <git clone flags>
    const [, , target, dest, , ...gitFlags] = args;
    if (!readable(target)) return err(`GraphQL: Could not resolve to a Repository with the name '${target}'. (repository)`);
    if (!scenario.cloneSource || !scenario.realGit) return err("fake gh: no cloneSource");
    const r = spawnSync(scenario.realGit, ["clone", ...gitFlags.filter((f) => f !== "--depth=1"), scenario.cloneSource, dest], { encoding: "utf-8" });
    if (r.stderr) process.stderr.write(r.stderr);
    return r.status ?? 1;
  }
  const repo = flag(args, "--repo") ?? (cmd === "repo" ? sub : undefined);
  if (repo && !readable(repo)) return err(`GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)`);
  if (cmd === "pr" && sub === "diff") {
    process.stdout.write(FAKE_PATCH);
    return 0;
  }
  if (cmd === "pr" && sub === "view") {
    const number = Number(args[2]);
    out(JSON.stringify({
      id: "PR_fake",
      title: "Fake PR",
      author: { login: "someone" },
      baseRefName: "main",
      headRefName: "feature",
      baseRefOid: "a".repeat(40),
      headRefOid: "b".repeat(40),
      url: `https://${host}/${repo}/pull/${number}`,
      changedFiles: 1,
    }));
    return 0;
  }
  if (cmd === "repo" && sub === "view") {
    out("main");
    return 0;
  }
  return err(`fake gh: unsupported ${args.join(" ")}`);
}

/** The git wrapper: log which account's token git got (never the token), then run the real git. */
function runFakeGit(args: string[]): number {
  const scenario = JSON.parse(readFileSync(process.env.FAKE_GH_SCENARIO!, "utf-8")) as FakeGhScenario;
  const host = scenario.host ?? "github.com";
  const envToken = process.env[host === "github.com" || host.endsWith(".ghe.com") ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN"];
  const as = envToken ? scenario.accounts.find((a) => a.token === envToken)?.login ?? "unknown token" : null;
  appendFileSync(process.env.FAKE_GH_LOG!, `${JSON.stringify({ args, as, git: true })}\n`);
  const r = spawnSync(scenario.realGit!, args, { stdio: "inherit" });
  return r.status ?? 1;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  process.exit(argv[0] === "--fake-git" ? runFakeGit(argv.slice(1)) : runFake(argv));
}
