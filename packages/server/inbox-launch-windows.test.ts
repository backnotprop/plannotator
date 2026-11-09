/**
 * Launch on native Windows: PATH by any spelling and `;`, the `//c/` Read rule, Claude's trust key forms, PowerShell
 * commands, typed Windows folders, Hidden/System folders, and a `.cmd` CLI through cmd.exe with a tree kill.
 *
 * The pure checks run everywhere, and also prove macOS and Linux get exactly what they got before. The checks marked
 * Windows run real PowerShell, cmd.exe and file attributes in the `pi-extension-ai-runtime-windows` job of
 * `windows.yml`; they start only stub programs (cmd scripts and node), in temp folders: never an agent CLI or an Inbox.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { envPathOf, foldEnvPath, joinPathFolders, pathFoldersOf, withEnvPath } from "./env-path";
import { createAgentEnvironmentFor, windowsShimOf } from "./inbox-agents";
import { claudeAttachCommand, claudeReadRule, claudeTrustCommand } from "./inbox-launch-claude";
import { launchPermissionHooks } from "./inbox-launch-claude-permission";
import { launchPlainEnv, launchSpawnEnv } from "./inbox-launch-env";
import { listHomeFolders, resolveHomeFolder } from "./inbox-home-folders";
import {
  claudeRulePathOf,
  claudeWindowsTrustKey,
  claudeWindowsTrustKeys,
  FILE_ATTRIBUTE_HIDDEN,
  FILE_ATTRIBUTE_SYSTEM,
  hiddenByAttributes,
  powerShellCommandLine,
  powerShellInFolder,
  windowsAttributesOf,
  windowsFolderHidden,
  windowsFolderRefusal,
  windowsTypedUnderHome,
} from "./inbox-launch-windows";

const WINDOWS = process.platform === "win32";
const scratch: string[] = [];
const tempDir = (name: string) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `plannotator-win-${name}-`)));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("PATH in an environment copy", () => {
  test("Windows: Path and PATH are one variable, the last copy wins, and folders join with ;", () => {
    // `{ ...process.env, PATH: x }` on Windows: the copy holds Path (old) and PATH (new); the new one is meant.
    const copy = { Path: "C:\\old", HOME: "x", PATH: "C:\\new" };
    expect(envPathOf(copy, "win32")).toBe("C:\\new");
    expect(foldEnvPath(copy, "win32")).toEqual({ HOME: "x", PATH: "C:\\new" });
    expect(withEnvPath({ Path: "C:\\old", path: "C:\\older" }, "C:\\set", "win32")).toEqual({ PATH: "C:\\set" });
    expect(pathFoldersOf("C:\\Windows;C:\\Users\\me\\.local\\bin;;", "win32")).toEqual(["C:\\Windows", "C:\\Users\\me\\.local\\bin"]);
    expect(joinPathFolders(["C:\\Bin", "c:\\bin\\", "D:\\x"], "win32")).toBe("C:\\Bin;D:\\x");
  });

  test("macOS and Linux: only PATH is PATH, and folders join with : exactly as before", () => {
    const copy = { Path: "/not-path", PATH: "/usr/bin:/bin" };
    expect(envPathOf(copy, "darwin")).toBe("/usr/bin:/bin");
    expect(foldEnvPath(copy, "linux")).toBe(copy);
    expect(joinPathFolders(["/a", "/A", "/a"], "darwin")).toBe("/a:/A");
  });

  test("the launch's plain env: Windows' Path read, the install folders after it, one PATH key", () => {
    const own = { Path: "C:\\Windows\\System32;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps", PLANNOTATOR_PORT: "1" };
    const env = launchPlainEnv(own, ["C:\\Users\\me\\.local\\bin", "C:\\Users\\me\\.claude\\local"], "win32");
    expect(Object.keys(env).filter((name) => name.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\me\\.local\\bin;C:\\Users\\me\\.claude\\local");
    expect(env.PLANNOTATOR_PORT).toBeUndefined();
    expect(launchSpawnEnv({ Path: "C:\\a", CLAUDECODE: "1" }, "win32")).toEqual({ PATH: "C:\\a" });
  });

  test("the launch's plain env on macOS and Linux is unchanged", () => {
    expect(launchPlainEnv({ PATH: "/usr/bin:/bin", HOME: "/Users/me" }, ["/Users/me/.local/bin", "/usr/bin"], "darwin")).toEqual({
      PATH: "/usr/bin:/bin:/Users/me/.local/bin",
      HOME: "/Users/me",
    });
    expect(launchPlainEnv({}, [], "linux")).toEqual({ PATH: "" });
  });

  test("an agent environment finds a CLI through Windows' Path", () => {
    const e = createAgentEnvironmentFor({ platform: "win32", homeDir: "C:\\Users\\me", env: { Path: "C:\\nowhere" } });
    // Bun.which gets the folder from Path; it finds nothing there, and never falls back to this process's PATH.
    expect(e.which("plannotator-no-such-cli")).toBeNull();
  });
});

describe("Claude Code's paths on Windows", () => {
  test("the Read rule names the drive as Claude matches it: //c/…", () => {
    expect(claudeReadRule("C:\\Users\\me\\.plannotator\\inbox\\uploads", "win32")).toBe("Read(//c/Users/me/.plannotator/inbox/uploads/**)");
    expect(claudeReadRule("d:/data/uploads\\", "win32")).toBe("Read(//d/data/uploads/**)");
    expect(claudeRulePathOf("E:\\")).toBe("/e");
    // macOS and Linux: as before.
    expect(claudeReadRule("/Users/me/.plannotator/inbox/uploads", "darwin")).toBe("Read(//Users/me/.plannotator/inbox/uploads/**)");
  });

  test("trust: read under any form Claude has written, write the forward-slash one", () => {
    expect(claudeWindowsTrustKeys("C:\\Users\\me\\repo")).toEqual(["C:/Users/me/repo", "c:/Users/me/repo", "C:\\Users\\me\\repo"]);
    expect(claudeWindowsTrustKeys("c:/Users/me/repo")).toEqual(["C:/Users/me/repo", "c:/Users/me/repo", "c:\\Users\\me\\repo"]);
    expect(claudeWindowsTrustKey("C:\\Users\\me\\repo")).toBe("C:/Users/me/repo");
  });
});

describe("commands a person copies on Windows run in PowerShell", () => {
  test("attach and trust: Set-Location, then the command only when the folder was entered", () => {
    expect(claudeAttachCommand("C:\\Users\\me\\it's here", "4f1c9a2e", "win32")).toBe("Set-Location -LiteralPath 'C:\\Users\\me\\it''s here'; if ($?) { claude attach 4f1c9a2e }");
    // PowerShell also ends a single-quoted string at ‘ ’ ‚ ‛: each is doubled.
    expect(claudeTrustCommand("C:\\Users\\me\\Bob’s", "win32")).toBe("Set-Location -LiteralPath 'C:\\Users\\me\\Bob’’s'; if ($?) { claude }");
    // macOS and Linux: as before.
    expect(claudeAttachCommand("/Users/me/it's here", "4f1c9a2e", "darwin")).toBe("cd '/Users/me/it'\\''s here' && claude attach 4f1c9a2e");
    expect(claudeTrustCommand("/Users/me/x", "linux")).toBe("cd '/Users/me/x' && claude");
  });

  test("the permission hook names PowerShell and passes the exit code on; macOS and Linux keep the sh form", () => {
    const self = ["C:\\Users\\Jo Smith\\AppData\\Local\\plannotator\\plannotator.exe"];
    const hook = launchPermissionHooks(self, "win32").PermissionRequest[0]!.hooks[0]!;
    expect(hook).toEqual({
      type: "command",
      shell: "powershell",
      command: "& 'C:\\Users\\Jo Smith\\AppData\\Local\\plannotator\\plannotator.exe' inbox permission-hook; exit $LASTEXITCODE",
      timeout: 345_600,
    });
    expect(launchPermissionHooks(["/Users/Jo Smith/.local/bin/plannotator"], "darwin").PermissionRequest[0]!.hooks[0]).toEqual({
      type: "command",
      command: "'/Users/Jo Smith/.local/bin/plannotator' inbox permission-hook",
      timeout: 345_600,
    });
  });
});

describe("typed folders on Windows", () => {
  const home = "C:\\Users\\Me";
  test("backslashes, / and either drive or folder case all read as the same place under home", () => {
    for (const typed of ["C:\\Users\\Me\\code\\app", "c:/users/me/code/app", "C:/Users/ME\\code\\app\\", "~\\code\\app", "~/code/app"]) {
      expect(windowsTypedUnderHome(typed, home)).toBe("~/code/app");
    }
    expect(windowsTypedUnderHome("C:\\Users\\Me", home)).toBe("~");
  });

  test("another drive or another account is not under home (the any-folder rule judges those)", () => {
    for (const typed of ["D:\\code", "C:\\Users\\Other\\code", "C:\\Users", "\\\\server\\share", "code"]) expect(windowsTypedUnderHome(typed, home)).toBeNull();
  });

  test("system and hidden folders are refused; a drive root and an ordinary folder on another drive are not", () => {
    const env = { systemRoot: "C:\\WINDOWS", programFiles: ["C:\\Program Files", "C:\\Program Files (x86)"], programData: "C:\\ProgramData", home };
    const hidden = new Set(["c:\\users\\me\\appdata", "d:\\vault"]);
    const attributes = (path: string) => (hidden.has(path.toLowerCase()) ? FILE_ATTRIBUTE_HIDDEN : 0x10);
    for (const real of ["C:\\Windows\\System32", "c:\\program files\\Git", "C:\\ProgramData\\x", "D:\\$Recycle.Bin", "E:\\System Volume Information", "C:\\Users", "C:\\Users\\Public", "C:\\Users\\Other\\code"]) {
      expect(windowsFolderRefusal(real, env, attributes)).toBe("system");
    }
    for (const real of ["C:\\Users\\Me\\AppData\\Roaming", "D:\\vault\\notes", "D:\\work\\.git"]) expect(windowsFolderRefusal(real, env, attributes)).toBe("hidden");
    for (const real of ["D:\\", "D:\\footage", "C:\\Users\\Me\\code"]) expect(windowsFolderRefusal(real, env, attributes)).toBeNull();
    // Attributes that can't be read (an access-denied junction) hide a folder; no way to read them hides nothing.
    expect(windowsFolderRefusal("D:\\locked", env, () => null)).toBe("hidden");
    expect(windowsFolderRefusal("D:\\footage", env, () => undefined)).toBeNull();
  });

  test("Hidden and System attributes hide; plain folders, and no attribute reader, do not", () => {
    expect(hiddenByAttributes(FILE_ATTRIBUTE_HIDDEN | 0x10)).toBe(true);
    expect(hiddenByAttributes(FILE_ATTRIBUTE_SYSTEM | 0x10)).toBe(true);
    expect(hiddenByAttributes(0x10)).toBe(false);
    expect(hiddenByAttributes(null)).toBe(true);
    expect(hiddenByAttributes(undefined)).toBe(false);
  });
});

describe("a Windows .cmd CLI starts through cmd.exe", () => {
  const exists = (path: string) => path === "C:\\npm\\claude.cmd";
  test("claude.cmd: the agent jobs' cmd.exe line; an .exe and every other platform: the argv as it is", () => {
    const shim = windowsShimOf(["C:\\npm\\claude.cmd", "--bg", "--name", "Fix the build"], "win32", () => null, exists);
    expect(shim).not.toBeNull();
    expect("argv" in shim! && shim.argv.slice(1)).toEqual(["/d", "/s", "/c", '""C:\\npm\\claude.cmd" "--bg" "--name" "Fix the build""']);
    expect(windowsShimOf(["C:\\bin\\claude.exe", "--bg"], "win32", () => null, (path) => path === "C:\\bin\\claude.exe")).toBeNull();
    expect(windowsShimOf(["/usr/local/bin/claude", "--bg"], "darwin", () => null)).toBeNull();
  });

  test("an argument cmd.exe would misread is refused, never passed", () => {
    const shim = windowsShimOf(["C:\\npm\\claude.cmd", "--name", "100% done"], "win32", () => null, exists);
    expect(shim && "refused" in shim ? shim.refused : null).toContain("Windows command script");
  });
});

describe.skipIf(!WINDOWS)("on Windows, for real", () => {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const ps = (line: string, cwd?: string) =>
    spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", line], { encoding: "utf8", timeout: 60_000, windowsHide: true, ...(cwd ? { cwd } : {}) });

  test("the attach command enters a folder named with quotes, and runs nothing when it can't", () => {
    const dir = join(tempDir("ps"), "it's Bob’s");
    mkdirSync(dir);
    const entered = ps(powerShellInFolder(dir, "Write-Output (Get-Location).ProviderPath"));
    expect(entered.stdout.trim()).toBe(dir);
    const missing = ps(powerShellInFolder(join(dir, "nope"), "Write-Output ran"));
    expect(missing.stdout).not.toContain("ran");
  }, 120_000);

  test("the permission hook line passes every argument whole and the program's exit code on", () => {
    const node = Bun.which("node");
    if (!node) return;
    const dir = tempDir("hook");
    const script = join(dir, "echo args.js");
    writeFileSync(script, "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3))); process.exit(3)");
    const out = join(dir, "out.json");
    const args = ["inbox", "it's", "a b", "$env:PATH", "‘quoted’"];
    const run = ps(powerShellCommandLine([node, script, out, ...args]));
    expect(run.status).toBe(3);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(args);
  }, 120_000);

  test("Hidden and System folders under home are hidden; an attrib +h folder is not listed or opened", () => {
    const home = tempDir("home");
    for (const dir of ["code", "secret", "plain"]) mkdirSync(join(home, dir));
    expect(spawnSync("attrib", ["+h", join(home, "secret")]).status).toBe(0);
    expect(windowsAttributesOf(join(home, "plain"))).toBeNumber();
    expect(windowsFolderHidden(join(home, "secret"))).toBe(true);
    expect(windowsFolderHidden(join(home, "plain"))).toBe(false);
    expect(windowsFolderHidden(join(home, "missing"))).toBe(true);
    const listed = listHomeFolders(home, "~");
    expect("folders" in listed ? listed.folders : null).toEqual(["code", "plain"]);
    expect(resolveHomeFolder(home, "~\\secret")).toEqual({ ok: false, refused: "hidden" });
    // Typed with backslashes, another drive-letter case, another folder case: the same folder.
    const typed = `${home.slice(0, 1).toLowerCase()}${home.slice(1).toUpperCase()}\\code`;
    expect(resolveHomeFolder(home, typed)).toMatchObject({ ok: true, exists: true, shown: "~/code" });
    expect(resolveHomeFolder(home, "D:\\elsewhere")).toEqual({ ok: false, refused: "outside" });
    // The real profile's AppData is Hidden.
    if (process.env.USERPROFILE && existsSync(join(process.env.USERPROFILE, "AppData"))) expect(windowsFolderHidden(join(process.env.USERPROFILE, "AppData"))).toBe(true);
  });

  test("a .cmd CLI found through Path runs through cmd.exe with its arguments whole", async () => {
    const bin = tempDir("cmd");
    writeFileSync(join(bin, "fake-agent.cmd"), "@echo off\r\necho [%~1] [%~2]\r\n");
    const e = createAgentEnvironmentFor({ platform: "win32", homeDir: bin, env: withEnvPath({ ...process.env } as Record<string, string>, `${bin};${process.env.SystemRoot}\\System32`, "win32") });
    const found = e.which("fake-agent");
    expect(found?.toLowerCase()).toBe(join(bin, "fake-agent.cmd").toLowerCase());
    const result = await e.run([found!, "--name", "Fix the build"], { timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("[--name] [Fix the build]");
  }, 60_000);

  test("a .cmd CLI that runs past its limit is ended with its whole tree, not cmd.exe alone", async () => {
    const node = Bun.which("node");
    if (!node) return;
    const bin = tempDir("tree");
    const pidFile = join(bin, "pid");
    writeFileSync(join(bin, "child.js"), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`);
    writeFileSync(join(bin, "slow-agent.cmd"), `@echo off\r\n"${node}" "${join(bin, "child.js")}"\r\n`);
    const e = createAgentEnvironmentFor({ platform: "win32", homeDir: bin, env: withEnvPath({ ...process.env } as Record<string, string>, `${bin};${process.env.SystemRoot}\\System32`, "win32") });
    const started = e.run([join(bin, "slow-agent.cmd")], { timeoutMs: 4_000 });
    const result = await started;
    expect(result.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await Bun.sleep(500);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(pid);
    expect(alive).toBe(false);
  }, 60_000);
});
