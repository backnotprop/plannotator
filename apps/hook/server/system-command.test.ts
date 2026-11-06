/**
 * `plannotator system …` (step A7) as real processes: the repo's own CLI
 * entry against real git repos made in a temp folder, with a temp HOME and
 * PLANNOTATOR_DATA_DIR, git with no global config, and a PATH of agent stubs
 * (tests/helpers/agent-cli-guard.ts), so no real agent, gh or network runs.
 *
 * What can regress: the JSON and exit code contract a script and launchd
 * read, check naming the field that cites a missing path, the gate's wake on
 * real commits, revision storing only what loads (against the committed
 * drawing, not the disk), and schedule touching launchctl. launchctl only ever
 * runs in-process, through a recorder: never for real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SYSTEM_COMMANDS } from "@plannotator/system";
import { inboxProjectKey } from "@plannotator/shared/inbox/project-key";
import { resolveInboxProjectRoot } from "@plannotator/server/inbox-project-root";
import { stubbedAgentClis } from "../../../tests/helpers/agent-cli-guard";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { SYSTEM_COMMAND_USAGE } from "./cli";
import { runSystemCommand } from "./system-command";

const entry = resolve(import.meta.dir, "index.ts");
let stubs: string[] = [];
const roots: string[] = [];
beforeAll(() => {
  // The CLI imports the built HTML; these tests never read the pages.
  stubs = stubHookDistHtml();
});
afterAll(() => removeStubbedHtml(stubs));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// After the cleanup hooks: a stub's failure stops the hooks registered behind it.
const agents = stubbedAgentClis();

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, "-c", "user.name=Maya Chen", "-c", "user.email=maya@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf8",
  });
}

function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

const commit = (root: string, message: string) => {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
};

/** A drawing of the small ledger app, drawn at `at`, its store citing `storePath`. */
function drawing(at: string, storePath = "src/store/db.ts"): Record<string, string> {
  return {
    ".plannotator/system/system.yaml": [
      "format: 1",
      "system: Ledger",
      "root: C-001",
      "sources:",
      "  repos:",
      `    self: { repo: example.com/acme/ledger, at: "${at}" }`,
      "scopes: { root: Ledger, server: The server }",
      "parts:",
      "  owner: { name: Maya Chen, kind: people }",
      "  server: { name: Ledger server, child: server, code: { src/server/index.ts: starts it } }",
      "  routes: { in: server, name: Routes, code: { src/server/routes.ts: the routes } }",
      `  store: { in: server, name: Store, code: { ${storePath}: reads invoices } }`,
      "  mail: { in: server, name: Mail, code: { src/mail: sends email } }",
      "flows:",
      "  use: { from: owner, to: server, lands: routes, says: sends an invoice, code: { to: src/server/routes.ts } }",
      "  read: { from: routes, to: store, says: reads it }",
      "",
    ].join("\n"),
    ".plannotator/system/sheets/C-001.yaml": "sheet: C-001\nscope: root\nkind: conceptual\ntitle: Ledger\nbands:\n  - { id: all, row: [owner, server] }\nshow: [use]\n",
    ".plannotator/system/sheets/L-101.yaml": "sheet: L-101\nscope: server\nkind: logical\ntitle: The server\nbands:\n  - { id: http, row: [routes] }\n  - { id: work, row: [store, mail] }\nshow: [read]\n",
  };
}

const CODE = {
  "src/server/index.ts": "import './routes.ts';\n",
  "src/server/routes.ts": "export const route = 1;\n",
  "src/store/db.ts": "export const db = 1;\n",
  "src/mail/send.ts": "export const send = 1;\n",
  "test/routes.test.ts": "// a test\n",
};

/** A sandbox: a temp HOME and data dir, and a git repo with the code committed and the drawing committed on top. */
function sandbox(o: { storePath?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-system-cli-")));
  roots.push(root);
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const repo = join(root, "ledger");
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  write(repo, CODE);
  const drawnAt = commit(repo, "the code");
  write(repo, drawing(drawnAt, o.storePath));
  const drawn = commit(repo, "System: first drawing of ledger");
  const env: Record<string, string> = {
    ...agents.env,
    ...GIT_ENV,
    HOME: home,
    TMPDIR: tmpdir(),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_UPDATE_CHECK: "0",
  };
  return { root, home, dataDir, repo, drawnAt, drawn, env };
}
type Box = ReturnType<typeof sandbox>;

async function cli(box: Box, args: string[], o: { cwd?: string; stdin?: string } = {}) {
  const proc = Bun.spawn([process.execPath, "run", entry, "system", ...args], {
    cwd: o.cwd ?? box.repo,
    env: box.env,
    stdin: o.stdin === undefined ? "ignore" : new TextEncoder().encode(o.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe("plannotator system --help", () => {
  test("prints every usage line the recipes name, with exit 0 and nothing run", async () => {
    const box = sandbox();
    for (const args of [["--help"], [], ["gate", "--help"]]) {
      const r = await cli(box, args);
      expect(r.code).toBe(0);
      expect(r.stdout.trimEnd()).toBe(SYSTEM_COMMAND_USAGE);
      for (const line of Object.values(SYSTEM_COMMANDS)) expect(r.stdout).toContain(line);
    }
  }, 30_000);
});

describe("plannotator system check", () => {
  test("a cited path the commit does not have: exit 1, the line names the field that cites it; fixed, it is clean", async () => {
    const box = sandbox({ storePath: "src/store/database.ts" });
    const bad = await cli(box, ["check"], { cwd: join(box.repo, "src") });
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe(`missing: src/store/database.ts (cited by parts.store.code; not in the repo at ${box.drawnAt.slice(0, 12)})\n`);
    expect(bad.stderr).toBe("not_clean: 0 errors, 0 warnings, 1 missing path\n");

    const json = await cli(box, ["check", "--json"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ ok: false, errors: [], warnings: [], missing: ["src/store/database.ts"], cited_by: { "src/store/database.ts": ["parts.store.code"] } });

    // the drawing is read from disk: the edit counts with no commit
    const yaml = join(box.repo, ".plannotator/system/system.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace("src/store/database.ts", "src/store/db.ts"));
    const fixed = await cli(box, ["check"]);
    expect(fixed).toEqual({ code: 0, stdout: "clean: .plannotator/system\n", stderr: "" });
  }, 30_000);

  test("a line's missing end is named by its end; a path cited twice names both fields", async () => {
    const box = sandbox({ storePath: "src/store/gone.ts" });
    const yaml = join(box.repo, ".plannotator/system/system.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8")
      .replace("code: { to: src/server/routes.ts }", "code: { from: src/server/old.ts, to: src/server/routes.ts }")
      .replace("says: reads it }", "says: reads it, code: { from: src/server/old.ts, to: src/store/gone.ts } }"));
    const r = await cli(box, ["check"]);
    expect(r.code).toBe(1);
    const at = box.drawnAt.slice(0, 12);
    expect(r.stdout).toBe([
      `missing: src/store/gone.ts (cited by parts.store.code, flows.read.code.to; not in the repo at ${at})`,
      `missing: src/server/old.ts (cited by flows.use.code.from, flows.read.code.from; not in the repo at ${at})`,
      "",
    ].join("\n"));
    expect(r.stderr).toBe("not_clean: 0 errors, 0 warnings, 2 missing paths\n");
    expect(JSON.parse((await cli(box, ["check", "--json"])).stdout).cited_by).toEqual({
      "src/store/gone.ts": ["parts.store.code", "flows.read.code.to"],
      "src/server/old.ts": ["flows.use.code.from", "flows.read.code.from"],
    });
  }, 30_000);

  test("a file only on disk does not count at the drawn commit; --at a commit that has it does", async () => {
    const box = sandbox();
    const yaml = join(box.repo, ".plannotator/system/system.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace("src/store/db.ts: reads invoices", "src/store/cache.ts: keeps invoices"));
    write(box.repo, { "src/store/cache.ts": "export const cache = 1;\n" });
    expect((await cli(box, ["check"])).stdout).toContain("missing: src/store/cache.ts");
    const later = commit(box.repo, "a cache");
    expect((await cli(box, ["check", "--at", later])).code).toBe(0);
    expect((await cli(box, ["check", "--at", "HEAD", "--json"])).stdout).toBe('{"ok":true,"errors":[],"warnings":[],"missing":[],"cited_by":{}}\n');
  }, 30_000);

  test("a loader error names its file and field; another repo's paths are checked only with --repo", async () => {
    const box = sandbox();
    const sheet = join(box.repo, ".plannotator/system/sheets/L-101.yaml");
    writeFileSync(sheet, readFileSync(sheet, "utf8").replace("{ id: http, row: [routes] }", "{ id: http, x: 4, row: [routes] }"));
    const coords = await cli(box, ["check"]);
    expect(coords.code).toBe(1);
    expect(coords.stdout).toMatch(/^error: sheets\/L-101\.yaml bands\[0\]\.x: /m);
    writeFileSync(sheet, readFileSync(sheet, "utf8").replace("x: 4, ", ""));

    const yaml = join(box.repo, ".plannotator/system/system.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8")
      .replace("    self:", "    pay: { repo: example.com/acme/pay, at: 0a1b2c3 }\n    self:")
      .replace("src/mail: sends email", "src/mail: sends email, pay:lib/charge.ts: charges the card"));
    const unchecked = await cli(box, ["check"]);
    expect(unchecked.code).toBe(1);
    expect(unchecked.stdout).toContain('warning: system.yaml sources.repos.pay: paths in repo "pay" were not checked');
    const pay = join(box.root, "pay");
    write(pay, { "lib/charge.ts": "export {};\n" });
    expect((await cli(box, ["check", "--repo", `pay=${pay}`])).code).toBe(0);
  }, 30_000);

  test("bad usage exits 2 and no drawing exits 1, each with nothing on stdout", async () => {
    const box = sandbox();
    for (const args of [["check", "--color"], ["check", "--repo", "pay"], ["check", "--at"], ["check", "extra"], ["nope"]]) {
      const r = await cli(box, args);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toStartWith("usage: ");
    }
    const none = await cli(box, ["check"], { cwd: box.home });
    expect(none.code).toBe(1);
    expect(none.stdout).toBe("");
    expect(none.stderr).toStartWith("no_drawing: ");
  }, 60_000);
});

describe("plannotator system gate", () => {
  test("on real commits: an added file wakes it; edits to cited files only touch; tests are ignored", async () => {
    const box = sandbox();
    git(box.repo, "checkout", "-q", "-b", "receipts");
    write(box.repo, { "src/mail/receipt.ts": "export {};\n", "src/server/routes.ts": "export const route = 2;\n", "test/routes.test.ts": "// more\n" });
    commit(box.repo, "receipts");
    const added = await cli(box, ["gate", "--from", "main", "--to", "receipts"]);
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout)).toEqual({
      touched: { parts: ["mail", "routes"], flows: ["use"] },
      wake: true,
      why: [{ path: "src/mail/receipt.ts", reason: "added" }],
      ignored: ["test/routes.test.ts"],
    });

    git(box.repo, "checkout", "-q", "main");
    write(box.repo, { "src/store/db.ts": "export const db = 2;\n" });
    const edit = commit(box.repo, "an edit");
    const edited = await cli(box, ["gate", "--project", box.repo, "--from", box.drawn, "--to", edit], { cwd: box.home });
    expect(JSON.parse(edited.stdout)).toEqual({ touched: { parts: ["store"], flows: [] }, wake: false, why: [], ignored: [] });
  }, 30_000);

  test("diffs exactly the refs given, with no merge base; reads the drawing of whatever is checked out", async () => {
    const box = sandbox();
    git(box.repo, "checkout", "-q", "-b", "receipts");
    write(box.repo, { "src/mail/receipt.ts": "export {};\n" });
    const yaml = join(box.repo, ".plannotator/system/system.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace("  mail:", "  receipt: { in: server, name: Receipt, code: { src/mail/receipt.ts: the receipt } }\n  mail:"));
    const sheet = join(box.repo, ".plannotator/system/sheets/L-101.yaml");
    writeFileSync(sheet, readFileSync(sheet, "utf8").replace("row: [store, mail]", "row: [store, mail, receipt]"));
    commit(box.repo, "receipts, drawn");
    git(box.repo, "checkout", "-q", "main");
    write(box.repo, { "src/store/cache.ts": "export const cache = new Map<string, number>();\n" });
    commit(box.repo, "main moves on");
    const base = git(box.repo, "merge-base", "main", "receipts").trim();

    // main checked out: main's drawing, which has no receipt part
    const onMain = JSON.parse((await cli(box, ["gate", "--from", base, "--to", "receipts"])).stdout);
    expect(onMain.touched.parts).toEqual(["mail"]);
    expect(onMain.why).toEqual([{ path: "src/mail/receipt.ts", reason: "added" }]);
    // --from main is main's tip, not the merge base: main's new file reads as deleted
    const tip = JSON.parse((await cli(box, ["gate", "--from", "main", "--to", "receipts"])).stdout);
    expect(tip.why).toContainEqual({ path: "src/store/cache.ts", reason: "deleted" });
    // the branch checked out: its own drawing, which has the receipt part
    git(box.repo, "checkout", "-q", "receipts");
    const onBranch = JSON.parse((await cli(box, ["gate", "--from", base, "--to", "receipts"])).stdout);
    expect(onBranch.touched.parts).toEqual(["mail", "receipt"]);
  }, 30_000);

  test("a ref git does not know fails with git's first line; a missing --to is bad usage", async () => {
    const box = sandbox();
    const r = await cli(box, ["gate", "--from", "main", "--to", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^git_failed: git diff: .*nope.*\n$/);
    expect((await cli(box, ["gate", "--from", "main"])).code).toBe(2);
    expect((await cli(box, ["gate", "--from", "--to", "main"])).code).toBe(2);
  }, 30_000);
});

const REVISION = [
  "revision: PR-12",
  "scope: server",
  "title: A send answers with its receipt",
  "pr: 12",
  "repo: example.com/acme/ledger",
  'date: "2026-11-06"',
  "add:",
  "  parts:",
  "    receipt: { in: server, name: Receipt, code: { src/mail/receipt.ts: writes the receipt } }",
  "  place:",
  "    L-101: { receipt: { band: work, after: mail } }",
  "change:",
  "  routes: Answers a send with the receipt.",
  "",
].join("\n");

describe("plannotator system revision", () => {
  test("stores a revision that loads, under the project's key, as it was sent", async () => {
    const box = sandbox();
    const head = "a5cb1c9f9e58e2a08fbab7ec005d6b31e786c2a5";
    const r = await cli(box, ["revision", "--project", ".", "--pr", "example.com/acme/ledger#12", "--head", head, "-"], { stdin: REVISION });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const project = await resolveInboxProjectRoot(box.repo);
    const key = inboxProjectKey(project.name, project.root);
    const path = join(box.dataDir, "system", key, "reviews", "example.com", "acme", "ledger", "12@a5cb1c9.yaml");
    expect(JSON.parse(r.stdout)).toEqual({ stored: path, revision: "PR-12", pr: "example.com/acme/ledger#12", head, key });
    expect(readFileSync(path, "utf8")).toBe(REVISION);
  }, 30_000);

  test("refuses a revision that does not load, or names another pull request, naming the field; stores nothing", async () => {
    const box = sandbox();
    const args = ["revision", "--project", box.repo, "--pr", "example.com/acme/ledger#12", "--head", "a5cb1c9", "-"];
    const band = await cli(box, args, { stdin: REVISION.replace("band: work", "band: nowhere") });
    expect(band.code).toBe(1);
    expect(band.stdout).toBe("");
    expect(band.stderr).toBe('revision_refused: revision add.place.L-101.receipt.band: sheet L-101 has no band "nowhere"\n');
    const other = await cli(box, args, { stdin: REVISION.replace("pr: 12", "pr: 13") });
    expect(other.code).toBe(1);
    expect(other.stderr).toBe("revision_refused: revision pr: is 13; --pr says 12\n");
    expect(existsSync(join(box.dataDir, "system"))).toBe(false);
  }, 30_000);

  test("loads against the committed drawing, not an edit on disk", async () => {
    const box = sandbox();
    const sheet = join(box.repo, ".plannotator/system/sheets/L-101.yaml");
    writeFileSync(sheet, readFileSync(sheet, "utf8").replace("  - { id: work,", "  - { id: later, row: [] }\n  - { id: work,"));
    const r = await cli(box, ["revision", "--project", box.repo, "--pr", "example.com/acme/ledger#12", "--head", "a5cb1c9", "-"], { stdin: REVISION.replace("band: work", "band: later") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('has no band "later"');
  }, 30_000);

  test("bad usage: no -, a malformed --pr or --head", async () => {
    const box = sandbox();
    const base = ["revision", "--project", box.repo, "--head", "a5cb1c9"];
    for (const args of [[...base, "--pr", "example.com/acme/ledger#12"], [...base, "--pr", "acme/ledger#12", "-"], ["revision", "--project", box.repo, "--pr", "example.com/acme/ledger#12", "--head", "main", "-"]]) {
      const r = await cli(box, args, { stdin: REVISION });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
    }
  }, 30_000);
});

describe("plannotator system tick", () => {
  test("not set up: nothing; set up and main moved by an edit: gated, state.json at the tip; no origin: exit 1", async () => {
    const box = sandbox();
    const origin = join(box.root, "origin.git");
    git(box.root, "init", "-q", "--bare", origin);
    git(box.repo, "remote", "add", "origin", origin);
    git(box.repo, "push", "-q", "origin", "main");
    const PROJECT = "ledger";
    const nothing = await cli(box, ["tick", "--project", box.repo, "--key", PROJECT]);
    expect(nothing.code).toBe(0);
    expect(JSON.parse(nothing.stdout)).toMatchObject({ ran: "nothing", gated: "" });

    const dir = join(box.dataDir, "system", PROJECT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "setup.json"), JSON.stringify({ v: 1, repos: [], docs: [], agent: "claude", model: null, thread_message: null }));
    // a teammate edits a cited file on main: the gate does not wake, so no agent runs
    const team = join(box.root, "team");
    git(box.root, "clone", "-q", origin, team);
    write(team, { "src/server/routes.ts": "export const route = 3;\n" });
    const tip = commit(team, "an edit");
    git(team, "push", "-q", "origin", "main");
    const gated = await cli(box, ["tick", "--project", box.repo, "--key", PROJECT]);
    expect(gated.stderr).toBe("");
    expect(JSON.parse(gated.stdout)).toEqual({ ran: "gated", gated: tip });
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))).toMatchObject({ v: 1, gated: tip, last_error: null });

    git(box.repo, "remote", "remove", "origin");
    const failed = await cli(box, ["tick", "--project", box.repo, "--key", PROJECT]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toStartWith("tick_failed: ");
    expect((await cli(box, ["tick", "--project", box.repo, "--key", "../x"])).code).toBe(2);
    expect((await cli(box, ["tick", "--key", PROJECT])).code).toBe(2);
  }, 60_000);
});

describe("plannotator system schedule", () => {
  test("list reads the temp HOME's LaunchAgents; install from a source checkout is refused before launchctl", async () => {
    const box = sandbox();
    const agentsDir = join(box.home, "Library", "LaunchAgents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "ai.plannotator.system.ledger.plist"), "<plist/>");
    writeFileSync(join(agentsDir, "com.example.other.plist"), "<plist/>");
    const list = await cli(box, ["schedule", "list"]);
    expect(list).toEqual({ code: 0, stdout: '["ledger"]\n', stderr: "" });
    const install = await cli(box, ["schedule", "install", "--project", box.repo, "--key", "ledger"]);
    expect(install.code).toBe(1);
    expect(install.stderr).toStartWith("not_installed: ");
    expect((await cli(box, ["schedule", "start"])).code).toBe(2);
  }, 30_000);

  test("install and remove (in process, launchctl recorded): the plist runs this binary's tick; remove deletes it", async () => {
    const box = sandbox();
    const agentsDir = join(box.root, "agents");
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };
    const outs: string[] = [];
    const deps = {
      cwd: box.repo,
      dataDir: box.dataDir,
      env: { PATH: "/usr/bin:/bin", HOME: box.home },
      self: ["/opt/plannotator/bin/plannotator"],
      stdout: async (text: string) => void outs.push(text),
      stderr: () => {},
      schedule: { run, agentsDir, uid: 501 },
    };
    expect(await runSystemCommand(["schedule", "install", "--project", ".", "--key", "ledger"], deps)).toBe(0);
    const plistPath = join(agentsDir, "ai.plannotator.system.ledger.plist");
    expect(JSON.parse(outs[0]!)).toEqual({ installed: "ledger", label: "ai.plannotator.system.ledger", plist: plistPath, interval: 900 });
    const plist = readFileSync(plistPath, "utf8");
    for (const word of ["/opt/plannotator/bin/plannotator", "<string>tick</string>", `<string>${box.repo}</string>`, `<string>${box.dataDir}</string>`, "<string>/usr/bin:/bin</string>"]) {
      expect(plist).toContain(word);
    }
    expect(calls).toEqual([
      ["launchctl", "bootout", "gui/501/ai.plannotator.system.ledger"],
      ["launchctl", "bootstrap", "gui/501", plistPath],
    ]);

    calls.length = 0;
    expect(await runSystemCommand(["schedule", "remove", "--key", "ledger"], deps)).toBe(0);
    expect(existsSync(plistPath)).toBe(false);
    expect(calls).toEqual([["launchctl", "bootout", "gui/501/ai.plannotator.system.ledger"]]);

    // a bootstrap launchctl refuses is a failure with its words, never a success
    const errs: string[] = [];
    const refusing = { ...deps, stderr: (t: string) => void errs.push(t), schedule: { agentsDir, uid: 501, run: async (argv: string[]) => (argv[1] === "bootstrap" ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : { code: 0, stdout: "", stderr: "" }) } };
    expect(await runSystemCommand(["schedule", "install", "--project", ".", "--key", "ledger"], refusing)).toBe(1);
    expect(errs).toEqual(["launchctl_failed: launchctl bootstrap: Bootstrap failed: 5: Input/output error"]);
  }, 30_000);
});
