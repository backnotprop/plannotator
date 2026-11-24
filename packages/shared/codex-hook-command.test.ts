/**
 * The Codex PostToolUse hook's command (codex-hook-command.ts) and the installer's copy of it (scripts/install.sh):
 * the same string; its shell gate starts the binary only while a reply waits, under sh and under zsh (Codex runs a hook
 * with the person's shell, zsh on a Mac, where a glob that matches nothing is an error); and the installer's merge adds
 * it beside the Stop hook once, updates it in place, and leaves every other hook alone. Scratch folders only; the fake
 * "binary" is a script that says it ran.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { codexHookCommand, isCodexHookCommand } from "./codex-hook-command";

const installSh = readFileSync(join(import.meta.dir, "..", "..", "scripts", "install.sh"), "utf8");
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-codex-hook-cmd-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const bin = join(root, "bin", "plannotator");
  mkdirSync(join(root, "bin"));
  writeFileSync(bin, `#!/bin/sh\necho "RAN $1"\n`);
  chmodSync(bin, 0o755);
  return { root, home, bin };
}

/** The installer's string for a binary path, as bash builds it. */
function installerCommand(bin: string): string {
  const line = installSh.split("\n").find((one) => one.trim().startsWith('*) CODEX_POST_TOOL_HOOK="'));
  expect(line).toBeDefined();
  const assignment = line!.trim().replace(/^\*\) /, "").replace(/ ;;$/, "");
  const run = spawnSync("bash", ["-c", `PLANNOTATOR_BIN=${JSON.stringify(bin)}; ${assignment}; printf '%s' "$CODEX_POST_TOOL_HOOK"`], { encoding: "utf8" });
  expect(run.status).toBe(0);
  return run.stdout;
}

const runGate = (shell: string, command: string, env: Record<string, string>) =>
  spawnSync(shell, ["-c", command], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...env }, input: '{"session_id":"x"}' });

describe("the Codex PostToolUse hook command", () => {
  test("the installer writes the same command as the code", () => {
    const { bin } = scratch();
    expect(installerCommand(bin)).toBe(codexHookCommand(bin)!);
    expect(isCodexHookCommand(codexHookCommand(bin)!)).toBe(true);
    expect(isCodexHookCommand(bin)).toBe(false);
  });

  for (const shell of ["/bin/sh", "/bin/zsh"]) {
    test(`under ${shell}: nothing waiting, nothing runs and it exits 0 silently; a reply waiting, the binary runs`, () => {
      if (!existsSync(shell)) return;
      const { home, bin } = scratch();
      const command = codexHookCommand(bin)!;
      const idle = runGate(shell, command, { HOME: home });
      expect(idle.status).toBe(0);
      expect(idle.stdout).toBe("");
      expect(idle.stderr).toBe("");
      mkdirSync(join(home, ".plannotator", "inbox", "codex-hook"), { recursive: true });
      expect(runGate(shell, command, { HOME: home }).stdout).toBe("");
      writeFileSync(join(home, ".plannotator", "inbox", "codex-hook", "t.m.json"), "{}");
      expect(runGate(shell, command, { HOME: home }).stdout).toBe("RAN codex-hook\n");
      // XDG data dir, and a data dir named in the env (the binary finds it).
      const xdg = scratch();
      mkdirSync(join(xdg.root, "xdg", "plannotator", "inbox", "codex-hook"), { recursive: true });
      writeFileSync(join(xdg.root, "xdg", "plannotator", "inbox", "codex-hook", "t.m.json"), "{}");
      expect(runGate(shell, codexHookCommand(xdg.bin)!, { HOME: xdg.home, XDG_DATA_HOME: join(xdg.root, "xdg") }).stdout).toBe("RAN codex-hook\n");
      expect(runGate(shell, codexHookCommand(xdg.bin)!, { HOME: xdg.home, PLANNOTATOR_DATA_DIR: "/elsewhere" }).stdout).toBe("RAN codex-hook\n");
    });
  }

  test("a path the gate's quotes cannot carry gets no command", () => {
    expect(codexHookCommand("/Users/o'neil/bin/plannotator")).toBeNull();
  });
});

describe("the installer's hooks.json merge", () => {
  const merge = (() => {
    const start = installSh.indexOf('codex_merge_result=$(node - "$CODEX_HOOKS"');
    const open = installSh.indexOf("<<'NODE'\n", start) + "<<'NODE'\n".length;
    return installSh.slice(open, installSh.indexOf("\nNODE\n", open));
  })();
  const run = (file: string, bin: string) => {
    const result = spawnSync("node", ["-", file, bin, codexHookCommand(bin)!], { input: merge, encoding: "utf8" });
    expect(result.status).toBe(0);
    return JSON.parse(readFileSync(file, "utf8"));
  };

  test("beside an existing Stop hook: added once, updated in place, other hooks kept", () => {
    if (spawnSync("node", ["--version"]).status !== 0) return;
    const { root, bin } = scratch();
    const file = join(root, "hooks.json");
    const theirs = { hooks: [{ type: "command", command: "/usr/local/bin/lint-after", timeout: 5 }] };
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/old/plannotator", timeout: 345600 }] }], PostToolUse: [theirs] } }));
    const once = run(file, bin);
    expect(once.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: bin, timeout: 345600 }] }]);
    expect(once.hooks.PostToolUse).toEqual([theirs, { hooks: [{ type: "command", command: codexHookCommand(bin), timeout: 10 }] }]);
    const twice = run(file, bin);
    expect(twice.hooks.PostToolUse).toHaveLength(2);
    // A new binary path: the same entry, in place (its position, so the person's trust of the others holds).
    const moved = join(root, "elsewhere", "plannotator");
    const third = run(file, moved);
    expect(third.hooks.PostToolUse).toEqual([theirs, { hooks: [{ type: "command", command: codexHookCommand(moved), timeout: 10 }] }]);
  });

  test("a custom Plannotator Stop hook the installer leaves alone: no PostToolUse hook is added either", () => {
    if (spawnSync("node", ["--version"]).status !== 0) return;
    const { root, bin } = scratch();
    const file = join(root, "hooks.json");
    const before = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "PLANNOTATOR_BROWSER=/usr/bin/true plannotator", timeout: 123 }] }] } });
    writeFileSync(file, before);
    run(file, bin);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
