/**
 * The Codex PostToolUse hook's command (codex-hook-command.ts) and the installer's handling of it (scripts/install.sh):
 * the same string; its shell gate exits 0 when the binary is gone, starts it only while a reply waits for the
 * payload's own thread (and hands it the whole payload), and notes that Codex ran it; the installer writes it in a new
 * hooks.json, merges it beside the Stop hook, never adds back one the person removed, and names both hooks when it
 * cannot merge. Codex runs a hook with the person's shell (`<shell> -c <command>`), so the command runs under sh and
 * zsh. Scratch folders only; the fake "binary" is a script that says it ran and echoes what it was given.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CODEX_HOOK_INSTALLED_FILE, CODEX_HOOK_RAN_FILE, codexHookCommand as commandFor, isCodexHookCommand, parseCodexHookCommand } from "./codex-hook-command";

/** The command for a binary, written into a hooks.json at `hooks` (a path no test reads unless it says so). */
const codexHookCommand = (bin: string, hooks = "/nonexistent/.codex/hooks.json") => commandFor(bin, hooks);

const installSh = readFileSync(join(import.meta.dir, "..", "..", "scripts", "install.sh"), "utf8");
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});

const THREAD = "019a7c00-0000-7000-8000-0000000000c3";
const OTHER = "019a7c00-0000-7000-8000-0000000000e5";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-codex-hook-cmd-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const bin = join(root, "bin", "plannotator");
  mkdirSync(join(root, "bin"));
  // Says it ran, then what it was given: the gate's bytes and the rest of stdin, which together are the payload.
  writeFileSync(bin, `#!/bin/sh\nprintf 'RAN %s|' "$1"\nprintf '%s' "$PLANNOTATOR_CODEX_HOOK_HEAD"\ncat\n`);
  chmodSync(bin, 0o755);
  const inbox = join(home, ".plannotator", "inbox");
  return { root, home, bin, inbox };
}

/** A PostToolUse payload as Codex writes it (`session_id` first), with a tool output long enough to pass the gate's read. */
const payload = (thread: string) => JSON.stringify({ session_id: thread, transcript_path: `/x/rollout-1-${thread}.jsonl`, hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "line\n".repeat(400) });

const runGate = (shell: string, command: string, env: Record<string, string>, input: string) =>
  spawnSync(shell, ["-c", command], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...env }, input });

const hold = (inbox: string, thread: string) => {
  mkdirSync(join(inbox, "codex-hook"), { recursive: true });
  writeFileSync(join(inbox, "codex-hook", `${thread}.msg_1.json`), "{}");
};

/** The installer's string for a binary path, as bash builds it. */
function installerCommand(bin: string, hooks: string): string {
  const line = installSh.split("\n").find((one) => one.trim().startsWith('*) CODEX_POST_TOOL_HOOK="'));
  expect(line).toBeDefined();
  const assignment = line!.trim().replace(/^\*\) /, "").replace(/ ;;$/, "");
  const run = spawnSync("bash", ["-c", `PLANNOTATOR_BIN=${JSON.stringify(bin)}; CODEX_HOOKS=${JSON.stringify(hooks)}; ${assignment}; printf '%s' "$CODEX_POST_TOOL_HOOK"`], { encoding: "utf8" });
  expect(run.status).toBe(0);
  return run.stdout;
}

describe("the Codex PostToolUse hook command", () => {
  test("the installer writes the same command as the code, and both know it whatever the binary's path", () => {
    const { bin } = scratch();
    expect(installerCommand(bin, "/home/x/.codex/hooks.json")).toBe(codexHookCommand(bin, "/home/x/.codex/hooks.json")!);
    expect(isCodexHookCommand(codexHookCommand(bin)!)).toBe(true);
    expect(parseCodexHookCommand(codexHookCommand("/opt/x/plannotator")!)).toEqual({ executable: "/opt/x/plannotator" });
    expect(isCodexHookCommand(bin)).toBe(false);
    expect(isCodexHookCommand(codexHookCommand("/opt/x/not-plannotator")!)).toBe(false);
  });

  for (const shell of ["/bin/sh", "/bin/zsh"]) {
    test(`under ${shell}: the binary runs only for a reply held for this payload's thread, with the whole payload`, () => {
      if (!existsSync(shell)) return;
      const { home, bin, inbox } = scratch();
      const command = codexHookCommand(bin)!;
      const env = { HOME: home };
      // Nothing waiting: nothing runs, exit 0, nothing said.
      mkdirSync(inbox, { recursive: true });
      const idle = runGate(shell, command, env, payload(THREAD));
      expect([idle.status, idle.stdout, idle.stderr]).toEqual([0, "", ""]);
      // Held for another thread only: still nothing.
      hold(inbox, OTHER);
      expect(runGate(shell, command, env, payload(THREAD)).stdout).toBe("");
      // Held for this thread: the binary runs, and gets every byte of the payload.
      hold(inbox, THREAD);
      expect(runGate(shell, command, env, payload(THREAD)).stdout).toBe(`RAN codex-hook|${payload(THREAD)}`);
      // A payload the gate cannot read the thread from: the binary decides.
      const odd = JSON.stringify({ hook_event_name: "PostToolUse", session_id: OTHER });
      expect(runGate(shell, command, env, odd).stdout).toBe(`RAN codex-hook|${odd}`);
    });
  }

  test("the binary gone (uninstalled, the hook left behind): exit 0, nothing said, even with a reply held", () => {
    const { home, root, inbox } = scratch();
    hold(inbox, THREAD);
    const gone = runGate("/bin/sh", codexHookCommand(join(root, "removed", "plannotator"))!, { HOME: home }, payload(THREAD));
    expect([gone.status, gone.stdout, gone.stderr]).toEqual([0, "", ""]);
  });

  test("it notes that Codex ran it, again only once hooks.json changed after the note", () => {
    const { home, bin, inbox } = scratch();
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "hooks.json"), "{}");
    const command = codexHookCommand(bin, join(codexHome, "hooks.json"))!;
    mkdirSync(inbox, { recursive: true });
    const note = join(inbox, CODEX_HOOK_RAN_FILE);
    expect(existsSync(note)).toBe(false);
    runGate("/bin/sh", command, { HOME: home }, payload(THREAD));
    expect(existsSync(note)).toBe(true);
    // Newer than hooks.json: left as it is.
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(codexHome, "hooks.json"), old, old);
    const noted = new Date(Date.now() - 60_000);
    utimesSync(note, noted, noted);
    runGate("/bin/sh", command, { HOME: home }, payload(THREAD));
    expect(statSync(note).mtimeMs).toBe(noted.getTime());
    // hooks.json changed since: noted again.
    const later = new Date(Date.now() - 1_000);
    utimesSync(join(codexHome, "hooks.json"), later, later);
    runGate("/bin/sh", command, { HOME: home }, payload(THREAD));
    expect(statSync(note).mtimeMs).toBeGreaterThan(later.getTime() - 1);
  });

  test("the XDG data dir, and a data dir named in the env (the binary finds it)", () => {
    const xdg = scratch();
    const xdgInbox = join(xdg.root, "xdg", "plannotator", "inbox");
    hold(xdgInbox, THREAD);
    expect(runGate("/bin/sh", codexHookCommand(xdg.bin)!, { HOME: xdg.home, XDG_DATA_HOME: join(xdg.root, "xdg") }, payload(THREAD)).stdout).toStartWith("RAN codex-hook|");
    expect(runGate("/bin/sh", codexHookCommand(xdg.bin)!, { HOME: xdg.home, PLANNOTATOR_DATA_DIR: "/elsewhere" }, payload(THREAD)).stdout).toStartWith("RAN codex-hook|");
  });

  test("a path the gate's quotes cannot carry gets no command", () => {
    expect(codexHookCommand("/Users/o'neil/bin/plannotator")).toBeNull();
    expect(codexHookCommand('/a"b/plannotator')).toBeNull();
    expect(codexHookCommand("/a$b/plannotator")).toBeNull();
  });
});

describe("the installer's Codex hooks", () => {
  /** The installer's whole Codex hooks step (new file, merge, fallbacks, the note), run by bash in a scratch home. */
  const step = (() => {
    const start = installSh.indexOf('    CODEX_POST_TOOL_HOOK=""');
    const end = installSh.indexOf('    if [ "$codex_hook_configured" -eq 1 ]; then', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return installSh.slice(start, end);
  })();
  const nodePath = spawnSync("/bin/sh", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim();

  /** `steer`: PLANNOTATOR_EXPERIMENTAL for the run (default "codex-steer", the switch on); null: not set. */
  function install(root: string, bin: string, options: { node?: boolean; steer?: string | null } = {}) {
    const codexDir = join(root, "codex");
    const dataDir = join(root, "data");
    const script = `set -e\nPLANNOTATOR_BIN=${JSON.stringify(bin)}\n_config_dir=${JSON.stringify(dataDir)}\nCODEX_DIR=${JSON.stringify(codexDir)}\nCODEX_HOOKS="$CODEX_DIR/hooks.json"\ncodex_hook_configured=0\n${step}\n`;
    // Without node: a PATH that has what the step uses and no node.
    const tools = join(root, "tools");
    if (!existsSync(tools)) {
      mkdirSync(tools);
      for (const tool of ["sed", "mkdir", "cat", "mktemp", "awk", "mv", "grep", "tr", "rm"]) {
        const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
        if (found) symlinkSync(found, join(tools, tool));
      }
      if (nodePath) symlinkSync(nodePath, join(tools, "node-real"));
    }
    const withNode = join(root, "with-node");
    if (!existsSync(withNode)) {
      mkdirSync(withNode);
      if (nodePath) symlinkSync(nodePath, join(withNode, "node"));
    }
    const PATH = options.node === false ? tools : `${withNode}:${tools}`;
    const steer = options.steer === undefined ? "codex-steer" : options.steer;
    const run = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", env: { PATH, HOME: root, ...(steer === null ? {} : { PLANNOTATOR_EXPERIMENTAL: steer }) } });
    return { run, file: join(codexDir, "hooks.json"), note: join(dataDir, CODEX_HOOK_INSTALLED_FILE) };
  }
  const postTool = (file: string) => (JSON.parse(readFileSync(file, "utf8")).hooks.PostToolUse ?? []) as { hooks: { command: string; timeout: number }[] }[];

  test("a new hooks.json: both hooks, valid JSON, the command exactly the code's; it says to review the hook, and notes it", () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-codex-install-"));
    const bin = join(root, "bin dir", "plannotator");
    const { run, file, note } = install(root, bin, { node: false });
    expect(run.status).toBe(0);
    const hooks = JSON.parse(readFileSync(file, "utf8")).hooks;
    expect(hooks.Stop[0].hooks[0].command).toBe(bin);
    expect(hooks.PostToolUse).toEqual([{ hooks: [{ type: "command", command: codexHookCommand(bin, file), timeout: 10 }] }]);
    expect(run.stdout).toContain("Settings > Hooks");
    expect(existsSync(note)).toBe(true);
  });

  test("beside an existing Stop hook: added once, updated in place, other hooks kept; a removal is respected", () => {
    if (!nodePath) return;
    const root = mkdtempSync(join(tmpdir(), "plannotator-codex-install-"));
    const bin = join(root, "bin", "plannotator");
    const file = join(root, "codex", "hooks.json");
    mkdirSync(join(root, "codex"), { recursive: true });
    const theirs = { hooks: [{ type: "command", command: "/usr/local/bin/lint-after", timeout: 5 }] };
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/old/plannotator", timeout: 345600 }] }], PostToolUse: [theirs] } }));
    const once = install(root, bin);
    expect(once.run.status).toBe(0);
    expect(postTool(file)).toEqual([theirs, { hooks: [{ type: "command", command: codexHookCommand(bin, file)!, timeout: 10 }] } as never]);
    expect(once.run.stdout).toContain("Settings > Hooks");
    const twice = install(root, bin);
    expect(postTool(file)).toHaveLength(2);
    expect(twice.run.stdout).not.toContain("Settings > Hooks");
    // A new binary path: the same entry, in place (its position, so the person's trust of the others holds).
    const moved = join(root, "elsewhere", "plannotator");
    install(root, moved);
    expect(postTool(file)).toEqual([theirs, { hooks: [{ type: "command", command: codexHookCommand(moved, file)!, timeout: 10 }] } as never]);
    // The person takes it out: an update leaves it out and says so; the Stop hook is kept.
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: moved, timeout: 345600 }] }], PostToolUse: [theirs] } }));
    const after = install(root, moved);
    expect(after.run.status).toBe(0);
    expect(postTool(file)).toEqual([theirs as never]);
    expect(after.run.stdout).toContain("left out");
  });

  test("a custom Plannotator Stop hook the installer leaves alone: no PostToolUse hook is added either", () => {
    if (!nodePath) return;
    const root = mkdtempSync(join(tmpdir(), "plannotator-codex-install-"));
    const file = join(root, "codex", "hooks.json");
    mkdirSync(join(root, "codex"), { recursive: true });
    const before = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "PLANNOTATOR_BROWSER=/usr/bin/true plannotator", timeout: 123 }] }] } });
    writeFileSync(file, before);
    install(root, join(root, "bin", "plannotator"));
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("the switch off (the default): a new hooks.json has the Stop hook only, nothing said, nothing noted", () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-codex-install-"));
    const bin = join(root, "bin", "plannotator");
    const { run, file, note } = install(root, bin, { node: false, steer: null });
    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: bin, timeout: 345600 }] }] } });
    expect(run.stdout).not.toContain("Hooks");
    expect(run.stdout).not.toContain("PostToolUse");
    expect(existsSync(note)).toBe(false);
  });

  test("the switch: config.json turns it on, PLANNOTATOR_EXPERIMENTAL decides over it; off again takes only ours out", () => {
    if (!nodePath) return;
    const root = mkdtempSync(join(tmpdir(), "plannotator-codex-install-"));
    const bin = join(root, "bin", "plannotator");
    const file = join(root, "codex", "hooks.json");
    mkdirSync(join(root, "codex"), { recursive: true });
    mkdirSync(join(root, "data"), { recursive: true });
    const theirs = { hooks: [{ type: "command", command: "/usr/local/bin/lint-after", timeout: 5 }] };
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: bin, timeout: 345600 }] }], PostToolUse: [theirs] } }));
    // Off by default: their hook only, and nothing said.
    const off = install(root, bin, { steer: null });
    expect(postTool(file)).toEqual([theirs as never]);
    expect(off.run.stdout).not.toContain("PostToolUse");
    // config.json on, the variable silent: ours added beside theirs.
    writeFileSync(join(root, "data", "config.json"), JSON.stringify({ experimental: { decisionMode: false, codexSteer: true } }));
    const on = install(root, bin, { steer: null });
    expect(postTool(file)).toEqual([theirs, { hooks: [{ type: "command", command: codexHookCommand(bin, file)!, timeout: 10 }] } as never]);
    expect(existsSync(on.note)).toBe(true);
    // The variable turns it off over config.json (the last mention wins): ours out, theirs kept, the note gone.
    const out = install(root, bin, { steer: "Codex-Steer, -codex-steer" });
    expect(out.run.status).toBe(0);
    expect(postTool(file)).toEqual([theirs as never]);
    expect(out.run.stdout).toContain("took Plannotator's PostToolUse hook out");
    expect(existsSync(out.note)).toBe(false);
    // On again by the variable alone (config.json off): added again, not read as the person's removal.
    writeFileSync(join(root, "data", "config.json"), JSON.stringify({ experimental: { codexSteer: false } }));
    install(root, bin, { steer: " codex-steer " });
    expect(postTool(file)).toHaveLength(2);
    // Off with ours the only PostToolUse hook: the key goes, the Stop hook stays.
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: bin, timeout: 345600 }] }], PostToolUse: [{ hooks: [{ type: "command", command: codexHookCommand(bin, file)!, timeout: 10 }] }] } }));
    install(root, bin, { steer: null });
    expect(JSON.parse(readFileSync(file, "utf8")).hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: bin, timeout: 345600 }] }] });
  });

  test("no node to merge an existing file: unchanged, and the lines to add by hand name both hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-codex-install-"));
    const bin = join(root, "bin", "plannotator");
    const file = join(root, "codex", "hooks.json");
    mkdirSync(join(root, "codex"), { recursive: true });
    writeFileSync(file, "{}");
    const { run } = install(root, bin, { node: false });
    expect(run.status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(run.stdout).toContain(`Stop:        command: ${bin}`);
    expect(run.stdout).toContain(`PostToolUse: command: ${codexHookCommand(bin, file)}`);
  });
});
