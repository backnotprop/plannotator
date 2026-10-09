import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureT3Hook, hasPlanHookOverlap } from "./install-hook";
import { parseT3HookCommand, t3HookCommand } from "@plannotator/shared/t3-hook-command";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-t3-hook-settings-"));
  roots.push(root);
  const profile = join(root, "Claude's profile");
  mkdirSync(profile);
  return { file: join(profile, "settings.json"), executable: join(root, "bin", "plannotator"), dataDir: join(root, "Review data's home") };
}

test("install updates only the T3 hook, preserving shared settings and mixed Bash hooks", () => {
  const { file, executable, dataDir } = fixture();
  const custom = { type: "command", command: "custom-check" };
  const original = { theme: "dark", permissions: { deny: ["Bash(rm *)"] }, hooks: {
    PermissionRequest: [{ matcher: "ExitPlanMode", hooks: [{ type: "command", command: "plannotator" }] }],
    PreToolUse: [{ matcher: "Bash", custom: true, hooks: [custom, { type: "command", command: "plannotator t3-hook" }] }],
  } };
  const before = JSON.stringify(original);
  writeFileSync(file, before, { mode: 0o640 });
  expect(configureT3Hook(file, executable, dataDir, true)).toBe(true);
  const settings = JSON.parse(readFileSync(file, "utf8"));
  expect(settings.permissions).toEqual(original.permissions);
  expect(settings.hooks.PermissionRequest).toEqual(original.hooks.PermissionRequest);
  expect(settings.hooks.PreToolUse[0]).toEqual({ matcher: "Bash", custom: true, hooks: [custom] });
  const command = settings.hooks.PreToolUse[1].hooks[0].command;
  expect(parseT3HookCommand(command)).toEqual({ executable });
  expect(statSync(file).mode & 0o777).toBe(0o640);
  expect(readFileSync(file + ".plannotator-t3.bak", "utf8")).toBe(before);
  expect(configureT3Hook(file, executable, dataDir, true)).toBe(false);
  expect(configureT3Hook(file, executable, dataDir, false)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse).toEqual([{ matcher: "Bash", custom: true, hooks: [custom] }]);
  expect(configureT3Hook(file, executable, dataDir, false)).toBe(false);
});

test("remove without an installed hook writes nothing and malformed settings stay intact", () => {
  const { file, executable, dataDir } = fixture();
  expect(configureT3Hook(file, executable, dataDir, false)).toBe(false);
  expect(existsSync(file)).toBe(false);
  for (const before of ["{malformed", '{"hooks":{"PreToolUse":"custom"}}', '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":null}]}}']) {
    writeFileSync(file, before);
    expect(() => configureT3Hook(file, executable, dataDir, true)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});

test("an optional T3 hook never creates a false plan-hook overlap, including compact mixed JSON", () => {
  const { file, executable, dataDir } = fixture();
  configureT3Hook(file, executable, dataDir, true);
  expect(hasPlanHookOverlap(file)).toBe(false);
  const settings = JSON.parse(readFileSync(file, "utf8"));
  settings.hooks.PermissionRequest = [{ matcher: "ExitPlanMode", hooks: [{ type: "command", command: "plannotator" }] }];
  writeFileSync(file, JSON.stringify(settings));
  expect(hasPlanHookOverlap(file)).toBe(true);
});

test("hook command quoting executes safely with spaces and apostrophes and pins its data directory", () => {
  const { executable, dataDir } = fixture();
  mkdirSync(join(executable, ".."), { recursive: true });
  writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n%s\\n" "$PLANNOTATOR_DATA_DIR" "$1"\n', { mode: 0o755 });
  const result = Bun.spawnSync(["/bin/sh", "-c", t3HookCommand(executable, dataDir)], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(dataDir + "\nt3-hook\n");
  expect(parseT3HookCommand(t3HookCommand(executable, dataDir) + " && echo unrelated")).toBeUndefined();
  expect(parseT3HookCommand("/other/custom-command t3-hook")).toBeUndefined();
});

test.skipIf(!process.env.T3_TEST_EXECUTABLE)("the compiled installer helper registers an executable hook and removes only its registration", () => {
  const { file, executable, dataDir } = fixture();
  mkdirSync(join(executable, ".."), { recursive: true });
  symlinkSync(resolve(process.env.T3_TEST_EXECUTABLE!), executable);
  const env = { HOME: join(file, ".."), PLANNOTATOR_DATA_DIR: dataDir, PATH: "/usr/bin:/bin" };
  const installed = Bun.spawnSync([executable, "t3-hook", "install", "--settings", file, "--executable", executable], { env, stdout: "pipe", stderr: "pipe" });
  expect(installed.exitCode).toBe(0);
  const command = JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse[0].hooks[0].command;
  const hooked = Bun.spawnSync(["/bin/sh", "-c", command], {
    env,
    stdin: Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_fixture", session_id: "fixture", cwd: join(file, ".."), tool_input: { command: "plannotator annotate notes.md --gate" } })),
    stdout: "pipe", stderr: "pipe",
  });
  expect(hooked.exitCode).toBe(0);
  expect(JSON.parse(hooked.stdout.toString())).toEqual({});
  const removed = Bun.spawnSync([executable, "t3-hook", "remove", "--settings", file], { env, stdout: "pipe", stderr: "pipe" });
  expect(removed.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
});
