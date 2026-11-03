/**
 * Scratch folders (launch PR 3), on a real launch module over a temp data dir and a temp home. What each
 * test guards: Settings → Agents' "Scratch folders" saves only a full path (`~/` is the home; empty is the
 * default) outside any git repository, never from the tailnet; the trust-once row reads Claude Code's own
 * trust record, where a trusted folder above the root counts and the root's own untrusted entry does not, and
 * a rewrite of that record is read again; and `claude purge` runs only on a folder whose purge reaches nothing
 * else: never below a repository's root or in a linked worktree (Claude's purge maps both to a repository and
 * drops that repository's own entry, as run on 2.1.314), and only after a dry run whose plan names that folder
 * alone (tested through the host's `purge`, with a stub `claude`).
 * Making, naming and removing the folders runs end to end in tests/e2e/inbox-launch-scratch.spec.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLaunch } from "./inbox-launch";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { claudePurgeRefusal, claudeRepositoryAbove, claudeTrustsFolder, createClaudeHost } from "./inbox-launch-claude";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function setEnv(name: string, value: string) {
  const before = process.env[name];
  process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-launch-scratch-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, fullPermissions: false } }));
  const store = InboxStore.open(dataDir);
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: "darwin",
    loginEnv: async () => ({ HOME: home, PATH: "" }),
    ownEnv: () => ({ HOME: home }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    selfCommand: ["plannotator"],
  });
  restore.push(() => launch.stop());
  // A refusal the route throws (InboxError) is answered by the Inbox's error table; here its code is enough.
  const post = async (body: Record<string, unknown>, via = "local") => {
    const response = await launch.route(
      new Request("http://127.0.0.1:4000/api/inbox/launch/settings", { method: "POST", headers: { host: "127.0.0.1:4000", "content-type": "application/json" }, body: JSON.stringify({ serverSession: "srv", ...body }) }),
      "/api/inbox/launch/settings",
      via,
    ).catch((error: { code?: string }) => Response.json({ code: error.code }, { status: 422 }));
    return { status: response!.status, body: (await response!.json()) as { launch?: Record<string, unknown>; code?: string } };
  };
  const saved = () => (JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as { inboxLaunch: Record<string, unknown> }).inboxLaunch;
  return { post, saved, dataDir, home };
}

describe("Settings → Agents: Scratch folders", () => {
  test("a full path or ~/ is saved and used; empty goes back to the default; the switch beside it is kept", async () => {
    const { post, saved, dataDir, home } = setup();
    expect((await post({ scratch_dir: "~/work/scratch" })).body.launch).toMatchObject({ scratch_dir: join(home, "work", "scratch") });
    expect(saved()).toEqual({ enabled: true, fullPermissions: false, scratchDir: join(home, "work", "scratch") });
    expect((await post({ scratch_dir: "  " })).body.launch).toMatchObject({ scratch_dir: join(dataDir, "scratch") });
    expect(saved()).toEqual({ enabled: true, fullPermissions: false });
  });

  test("a relative path, / or a non-string is refused and nothing changes; never from the tailnet", async () => {
    const { post, saved } = setup();
    for (const scratch_dir of ["scratch", "/", 7]) expect(await post({ scratch_dir })).toMatchObject({ status: 422, body: { code: "validation_error" } });
    expect(await post({ scratch_dir: "/tmp/x" }, "tailnet")).toMatchObject({ status: 403, body: { code: "owner_only" } });
    expect(saved()).toEqual({ enabled: true, fullPermissions: false });
  });

  test("a folder in a git repository, or not made yet below one, is refused: its scratch folders would join that repository's project", async () => {
    const { post, saved, home } = setup();
    mkdirSync(join(home, "code", "app", ".git"), { recursive: true });
    for (const scratch_dir of ["~/code/app", "~/code/app/scratch/new"]) expect(await post({ scratch_dir })).toMatchObject({ status: 422, body: { code: "validation_error" } });
    expect(saved()).toEqual({ enabled: true, fullPermissions: false });
    // Through a link into the repository too: the real path decides.
    symlinkSync(join(home, "code", "app"), join(home, "app-link"));
    expect(await post({ scratch_dir: "~/app-link/scratch" })).toMatchObject({ status: 422, body: { code: "validation_error" } });
    expect(saved()).toEqual({ enabled: true, fullPermissions: false });
    expect((await post({ scratch_dir: "~/code/scratch" })).status).toBe(200);
  });
});

/** A stub `claude` that logs its argv and prints `plan` for `purge --dry-run`. */
function stubClaude(plan: (folder: string) => string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-purge-host-")));
  restore.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  const plans = join(dir, "plans");
  mkdirSync(plans);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$2" = "--dry-run" ]; then cat "${plans}/$(printf '%s' "$3" | tr -c 'A-Za-z0-9' '-')"; fi\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const host = createClaudeHost({
    environment: async () => createAgentEnvironmentFor({ platform: "darwin", homeDir: dir, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir } }),
    files: () => createAgentEnvironmentFor({ platform: "darwin", homeDir: dir, env: {} }),
  });
  const folder = (path: string) => {
    mkdirSync(join(dir, path), { recursive: true });
    const full = join(dir, path);
    writeFileSync(join(plans, full.replace(/[^A-Za-z0-9]/g, "-")), plan(full));
    return full;
  };
  const calls = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { dir, host, folder, calls };
}

/** A dry-run plan as 2.1.314 prints it, for these `projects[...]` keys. */
const planOf = (folder: string, keys: string[]) =>
  [`Purge plan for ${folder}:`, ``, `  dir:    /h/.claude/projects/${folder.replace(/[^A-Za-z0-9]/g, "-")}`, `           project transcripts (.jsonl) and memory/`, ...keys.flatMap((k) => [`  config: projects["${k}"]`, `           project entry in ~/.claude.json (trust, history, MCP servers)`]), ``, `Dry run: ${keys.length + 1} item(s) would be deleted.`].join("\n");

describe("claude purge, through the host (a stub claude)", () => {
  test("a plain folder: a dry run, then the purge", async () => {
    const { host, folder, calls } = stubClaude((f) => planOf(f, [f]));
    const plain = folder("scratch/notes");
    expect((await host.purge(plain)).skipped).toBeUndefined();
    expect(calls()).toEqual([`purge --dry-run ${plain}`, `purge --yes ${plain}`]);
  });

  test("a linked worktree (a .git file) is never purged, not even a dry run; nor a folder below a repository's root", async () => {
    const { dir, host, folder, calls } = stubClaude((f) => planOf(f, [f]));
    const worktree = folder("scratch/worktree-notes");
    writeFileSync(join(worktree, ".git"), `gitdir: ${dir}/code/app/.git/worktrees/worktree-notes\n`);
    expect((await host.purge(worktree)).skipped).toContain("not a folder");
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    const below = folder("repo/scratch/notes");
    expect((await host.purge(below)).skipped).toContain(`inside the repository ${join(dir, "repo")}`);
    expect(calls()).toEqual([]);
  });

  test("a dry run that lists another project's entry or transcripts, or nothing it can read, or that fails: no purge", async () => {
    const plans: Record<string, (f: string) => string> = {
      other: (f) => planOf(f, ["/Users/me/code/app", f]),
      dirs: (f) => `${planOf(f, [f])}\n  dir:    /h/.claude/projects/-Users-me-code-app`,
      unreadable: () => "Something else entirely.",
    };
    const { host, folder, calls } = stubClaude((f) => plans[f.split("/").pop()!]!(f));
    for (const name of Object.keys(plans)) {
      const f = folder(`scratch/${name}`);
      expect((await host.purge(f)).skipped).toBeTruthy();
    }
    expect(calls().filter((c) => c.startsWith("purge --yes"))).toEqual([]);
    expect(calls()).toHaveLength(3);
  });

  test("its own repository (a .git folder) maps to itself: purged when the plan says so", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-purge-own-")));
    restore.push(() => rmSync(home, { recursive: true, force: true }));
    const own = join(home, "scratch", "own-repo");
    mkdirSync(join(own, ".git"), { recursive: true });
    expect(claudePurgeRefusal(own, null)).toBeNull();
    expect(claudePurgeRefusal(own, planOf(own, [own]))).toBeNull();
  });
});

describe("claudeRepositoryAbove (purge guard)", () => {
  test("a folder below a repository's root names it; a repository's own root, or a plain folder, names none", () => {
    const home = mkdtempSync(join(tmpdir(), "plannotator-purge-guard-"));
    restore.push(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, "repo", ".git"), { recursive: true });
    mkdirSync(join(home, "repo", "scratch", "notes"), { recursive: true });
    mkdirSync(join(home, "plain", "made", ".git"), { recursive: true });
    expect(claudeRepositoryAbove(join(home, "repo", "scratch", "notes"))).toBe(join(home, "repo"));
    expect(claudeRepositoryAbove(join(home, "plain", "made"))).toBeNull();
    expect(claudeRepositoryAbove(join(home, "plain"))).toBeNull();
  });
});

describe("claudeTrustsFolder", () => {
  const env = (home: string) => createAgentEnvironmentFor({ platform: "darwin", homeDir: home, env: {} });

  test("a trusted folder above counts, an untrusted entry of the folder itself does not, and an unreadable file is not trust", () => {
    const home = mkdtempSync(join(tmpdir(), "plannotator-trust-"));
    restore.push(() => rmSync(home, { recursive: true, force: true }));
    expect(claudeTrustsFolder(env(home), "/work/scratch")).toBe(false);
    writeFileSync(join(home, ".claude.json"), "{ not json");
    expect(claudeTrustsFolder(env(home), "/work/scratch")).toBe(false);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { "/work/scratch": { hasTrustDialogAccepted: false }, "/elsewhere": { hasTrustDialogAccepted: true } } }));
    expect(claudeTrustsFolder(env(home), "/work/scratch")).toBe(false);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { "/work/scratch": { hasTrustDialogAccepted: false }, "/work": { hasTrustDialogAccepted: true } } }));
    expect(claudeTrustsFolder(env(home), "/work/scratch")).toBe(true);
    expect(claudeTrustsFolder(env(home), "/workshop")).toBe(false);
    // Read once and kept while the file stays; a rewrite of the same size (Claude replaces the file) is read again.
    writeFileSync(join(home, "next.json"), JSON.stringify({ projects: { "/work/scratch": { hasTrustDialogAccepted: false }, "/wor": { hasTrustDialogAccepted: true } } }) + " ");
    renameSync(join(home, "next.json"), join(home, ".claude.json"));
    expect(claudeTrustsFolder(env(home), "/work/scratch")).toBe(false);
  });

  test("a git repository under a trusted folder is not covered: only its own entry counts (a scratch folder the agent made a repository)", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-trust-repo-")));
    restore.push(() => rmSync(home, { recursive: true, force: true }));
    const root = join(home, "scratch");
    const repo = join(root, "notes");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(root, "plain"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }));
    expect(claudeTrustsFolder(env(home), join(root, "plain"))).toBe(true);
    expect(claudeTrustsFolder(env(home), repo)).toBe(false);
    expect(claudeTrustsFolder(env(home), join(repo, "src"))).toBe(false);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true }, [repo]: { hasTrustDialogAccepted: true } } }));
    expect(claudeTrustsFolder(env(home), join(repo, "src"))).toBe(true);
  });
});
