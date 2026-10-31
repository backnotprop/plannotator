import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { t3HookCommand } from "@plannotator/shared/t3-hook-command";
import {
  formatPurgeWarning,
  runPlannotatorUninstall,
  type UninstallEnvironment,
  WINDOWS_PATH_RESTORE_SCRIPT,
  WINDOWS_PATH_SCRIPT,
  WINDOWS_SELF_DELETE_SCRIPT,
} from "./uninstall";

type CommandCall = {
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
};

type Fixture = {
  root: string;
  homeDir: string;
  dataDir: string;
  commandCalls: CommandCall[];
  scheduledDeletes: Array<{ target: string; parent: string | null }>;
  environment: UninstallEnvironment;
};

const temporaryRoots: string[] = [];
let supportsCaseVariantPaths = false;

function detectCaseVariantPathSupport(): boolean {
  const root = mkdtempSync(join(tmpdir(), "plannotator-case-probe-"));
  try {
    const exact = join(root, "case-probe");
    const variant = join(root, "CASE-PROBE");
    mkdirSync(exact);
    const exactStat = statSync(exact, { bigint: true });
    const variantStat = statSync(variant, { bigint: true });
    return exactStat.dev === variantStat.dev && exactStat.ino === variantStat.ino;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

beforeAll(() => {
  supportsCaseVariantPaths = detectCaseVariantPathSupport();
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Windows self-delete worker", () => {
  test("keeps PowerShell statements on separate lines", () => {
    expect(WINDOWS_SELF_DELETE_SCRIPT).toContain(
      "$target=$env:PLANNOTATOR_UNINSTALL_TARGET\nfor",
    );
    expect(WINDOWS_SELF_DELETE_SCRIPT).toContain("}\n$parent=");
    expect(WINDOWS_SELF_DELETE_SCRIPT).toContain("if($parent){Remove-Item");
  });
});

describe("Windows PATH scripts", () => {
  const scripts = {
    remove: WINDOWS_PATH_SCRIPT,
    restore: WINDOWS_PATH_RESTORE_SCRIPT,
  } as const;

  test("edit the registry directly and never call the blocking .NET setter", () => {
    // SetEnvironmentVariable('Path', ..., 'User') broadcasts WM_SETTINGCHANGE
    // synchronously to every window and can stall past the 15 s command
    // timeout on a machine with a hung GUI process (the CI smoke flake).
    for (const script of Object.values(scripts)) {
      expect(script).not.toContain("SetEnvironmentVariable");
      expect(script).toContain("Microsoft.Win32.Registry");
      // The broadcast that replaces it must be bounded (SMTO_ABORTIFHUNG) and
      // must not be able to reach the exit code.
      expect(script).toContain("SendMessageTimeout");
      expect(script).toMatch(/'Environment',0x2,\d+,\[ref\]\$r\)\}catch\{\}; exit 0$/);
    }
    // The value is read unexpanded and written back with its own kind so
    // %VARS% in unrelated entries survive.
    expect(scripts.remove).toContain("DoNotExpandEnvironmentNames");
    expect(scripts.remove).toContain("$k.SetValue('Path',$n,$kind)");
    // The completed-write echo must come after the write and before the
    // broadcast in BOTH scripts: it is what lets the caller trust a write
    // whose process was killed or faulted while broadcasting.
    const echoes = {
      remove: "Write-Output (ConvertTo-Json",
      restore: "Write-Output 'PLANNOTATOR_PATH_RESTORED'",
    } as const;
    for (const [name, script] of Object.entries(scripts) as Array<
      [keyof typeof scripts, string]
    >) {
      const writeIndex = script.indexOf("$k.SetValue(");
      const echoIndex = script.indexOf(echoes[name]);
      const broadcastIndex = script.indexOf("SendMessageTimeout(");
      expect(`${name}: ${writeIndex}`).not.toBe(`${name}: -1`);
      expect(echoIndex).toBeGreaterThan(writeIndex);
      expect(broadcastIndex).toBeGreaterThan(echoIndex);
    }
  });

  test("stay single-quoted so they survive -Command argv quoting", () => {
    // Both scripts travel as one argv element to powershell.exe; a literal
    // double quote would be re-escaped by the spawn layer and break parsing.
    for (const script of Object.values(scripts)) {
      expect(script).not.toContain('"');
    }
  });

  const powershell =
    Bun.which("pwsh") ||
    Bun.which("pwsh.exe") ||
    Bun.which("powershell.exe") ||
    process.env.PLANNOTATOR_TEST_POWERSHELL ||
    null;

  test.skipIf(!powershell)(
    "parse cleanly in a real PowerShell (no registry access)",
    async () => {
      // Parser.ParseInput only parses; nothing is executed, so this touches
      // neither the registry nor the environment. Runs on Windows CI and on
      // any dev box with pwsh.
      for (const [name, script] of Object.entries(scripts)) {
        const proc = Bun.spawn(
          [
            powershell!,
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:PLANNOTATOR_TEST_SCRIPT,[ref]$null,[ref]$errors); if($errors.Count -gt 0){$errors | ForEach-Object { Write-Output $_.Message }; exit 1}; exit 0",
          ],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, PLANNOTATOR_TEST_SCRIPT: script },
          },
        );
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(`${name}: ${stdout.trim()}`).toBe(`${name}: `);
        expect(exitCode).toBe(0);
      }
    },
  );
});

function createFixture(
  overrides: Partial<UninstallEnvironment> = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "plannotator-uninstall-test-"));
  temporaryRoots.push(root);
  const homeDir = join(root, "home");
  const dataDir = join(homeDir, ".plannotator");
  mkdirSync(dataDir, { recursive: true });

  const commandCalls: CommandCall[] = [];
  const scheduledDeletes: Array<{ target: string; parent: string | null }> = [];
  const environment: UninstallEnvironment = {
    platform: "linux",
    homeDir,
    tempDir: tmpdir(),
    dataDir,
    execPath: join(root, "running-plannotator"),
    env: {},
    which: () => null,
    runCommand: async (command, args, env) => {
      commandCalls.push({ command, args, env });
      return {
        exitCode: 0,
        timedOut: false,
        stdout: JSON.stringify("C:\\Tools;C:\\Users\\fixture\\AppData\\Local\\plannotator;C:\\Windows;;"),
      };
    },
    scheduleWindowsSelfDelete: async (target, parent) => {
      scheduledDeletes.push({ target, parent });
      return true;
    },
    ...overrides,
  };

  return {
    root,
    homeDir,
    dataDir,
    commandCalls,
    scheduledDeletes,
    environment,
  };
}

function writeText(filePath: string, content = "owned"): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function snapshotTree(root: string): string[] {
  const snapshot: string[] = [];
  const visit = (path: string, relativePath: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      snapshot.push(`link:${relativePath}:${readlinkSync(path)}`);
      return;
    }
    if (stat.isDirectory()) {
      snapshot.push(`dir:${relativePath}`);
      for (const entry of readdirSync(path).sort()) {
        visit(join(path, entry), join(relativePath, entry));
      }
      return;
    }
    snapshot.push(
      `file:${relativePath}:${readFileSync(path).toString("base64")}`,
    );
  };
  visit(root, ".");
  return snapshot;
}

/**
 * A stand-in for a T3 Code per-thread worker: registers itself the way the
 * real one does (`t3-code/<endpoint>/threads/<thread>/daemon.json`), answers
 * `/health` and exits on `/stop`.
 */
async function startFakeT3Worker(dataDir: string) {
  const directory = join(dataDir, "t3-code", "e".repeat(64), "threads", "t".repeat(64));
  mkdirSync(directory, { recursive: true });
  const script = `
    const token = "x".repeat(40);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      if (req.headers.get("authorization") !== "Bearer " + token) return new Response("no", { status: 403 });
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ running: true, endpoint: "http://127.0.0.1:3773/mcp", thread: "thread-a", pid: process.pid });
      if (path === "/stop") { setTimeout(() => process.exit(0), 20); return Response.json({ stopped: true }); }
      return new Response("no", { status: 404 });
    } });
    await Bun.write(${JSON.stringify(join(directory, "daemon.json"))}, JSON.stringify({ endpoint: "http://127.0.0.1:3773/mcp", thread: "thread-a", pid: process.pid, port: server.port, token }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" });
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(directory, "daemon.json")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return child;
}

describe("a leftover usage-counts/ folder (the removed usage counts)", () => {
  function seed(dataDir: string): string {
    const dir = join(dataDir, "usage-counts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "counts.json"), JSON.stringify({ v: 1, days: { "2026-10-23": { decisionMode: { rev: 1, events: { opened: 2 } } } } }));
    writeFileSync(join(dir, "facts.json"), JSON.stringify({ v: 1, features: { decisionMode: { used: true } } }));
    return dir;
  }

  test("a plain uninstall removes it and leaves config.json as it was", async () => {
    const fixture = createFixture();
    const dir = seed(fixture.dataDir);
    writeFileSync(join(fixture.dataDir, "config.json"), JSON.stringify({ usageCounts: false }));
    const planned = await runPlannotatorUninstall({ purge: false, dryRun: true }, fixture.environment);
    expect(planned.planned.filter((line) => line === dir)).toHaveLength(1);
    expect(existsSync(dir)).toBe(true);
    await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(existsSync(dir)).toBe(false);
    expect(JSON.parse(readFileSync(join(fixture.dataDir, "config.json"), "utf-8")).usageCounts).toBe(false);
  });

  test("purge removes it, listed once in a dry run", async () => {
    const fixture = createFixture();
    const dir = seed(fixture.dataDir);
    const planned = await runPlannotatorUninstall({ purge: true, dryRun: true }, fixture.environment);
    expect(planned.planned.filter((line) => line === dir)).toHaveLength(1);
    await runPlannotatorUninstall({ purge: true, dryRun: false }, fixture.environment);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("the optional T3 Code connection", () => {
  test("uninstall stops its running workers, and purge removes t3-code/", async () => {
    const fixture = createFixture();
    const child = await startFakeT3Worker(fixture.dataDir);
    try {
      const planned = await runPlannotatorUninstall({ purge: true, dryRun: true }, fixture.environment);
      expect(planned.planned.some((line) => line.includes(`Stop the T3 Code companion for thread thread-a (pid ${child.pid})`))).toBe(true);
      expect(child.exitCode).toBeNull();
      const result = await runPlannotatorUninstall({ purge: true, dryRun: false }, fixture.environment);
      expect(result.removed.some((line) => line.includes(`Stopped the T3 Code companion for thread thread-a (pid ${child.pid})`))).toBe(true);
      expect(await child.exited).toBe(0);
      expect(existsSync(join(fixture.dataDir, "t3-code"))).toBe(false);
    } finally {
      child.kill(); // inbox-guard: own child
    }
  });

  test("without a T3 connection, uninstall reports nothing about it", async () => {
    const fixture = createFixture();
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect([...result.removed, ...result.planned, ...result.warnings, ...result.errors].some((line) => line.includes("T3"))).toBe(false);
  });
});

describe("default uninstall", () => {
  test("removes the optional T3 hook only for the installed binary, preserving other Bash hooks", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    writeText(binary);
    const settings = join(fixture.homeDir, ".claude", "settings.json");
    const customHooks = [
      { type: "command", command: "my-custom-hook" },
      { type: "command", command: t3HookCommand("/custom/plannotator", fixture.dataDir) },
    ];
    writeJson(settings, {
      theme: "dark",
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [
        { type: "command", command: t3HookCommand(binary, fixture.dataDir), timeout: 10 },
        ...customHooks,
      ] }] },
    });
    // The backup `t3-hook install` keeps of settings before its first change.
    const backup = `${settings}.plannotator-t3.bak`;
    writeText(backup);
    const planned = await runPlannotatorUninstall({ purge: false, dryRun: true }, fixture.environment);
    expect(planned.planned).toContain(backup);
    expect(existsSync(backup)).toBe(true);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.ok).toBe(true);
    expect(readJson(settings)).toEqual({
      theme: "dark", hooks: { PreToolUse: [{ matcher: "Bash", hooks: customHooks }] },
    });
    expect(existsSync(backup)).toBe(false);
    expect(result.removed).toContain(backup);
  });

  test("removes recognized installer components and preserves local data", async () => {
    const fixture = createFixture();
    const { homeDir, dataDir } = fixture;
    const alternateConfig = join(fixture.root, "xdg-config");
    fixture.environment = {
      ...fixture.environment,
      env: { XDG_CONFIG_HOME: alternateConfig },
    };

    const binary = join(homeDir, ".local", "bin", "plannotator");
    writeText(binary);
    writeText(join(dataDir, "plans", "approved.md"), "# plan");
    writeJson(join(dataDir, "config.json"), { theme: "dark" });
    writeText(join(dataDir, "vendor", "sem", "v0.7.0", "sem"));
    writeText(
      join(dataDir, "vendor", "agent-terminal", "webtui-0.0.9", "server.js"),
    );
    writeText(
      join(dataDir, "vendor", "call-flow", "calldiff-0.6.0", "package.json"),
    );
    writeText(join(dataDir, "vendor", "other-tool", "keep.txt"));
    writeText(join(dataDir, "install-prefs"), "full\n");
    writeText(join(dataDir, "migrations", "legacy"));

    for (const skill of [
      "plannotator-review",
      "plannotator-annotate",
      "plannotator-last",
      "plannotator-inbox",
      // The knowledge-layer CLI reference skill, installed to the same scopes.
      "plannotator",
    ]) {
      writeText(join(homeDir, ".claude", "skills", skill, "SKILL.md"));
      writeText(join(homeDir, ".agents", "skills", skill, "SKILL.md"));
    }
    writeText(
      join(homeDir, ".agents", "skills", "plannotator-compound", "SKILL.md"),
      "user-managed extra skill",
    );
    writeText(
      join(homeDir, ".agents", "skills", "plannotator-archive", "SKILL.md"),
    );
    writeText(
      join(homeDir, ".claude", "skills", "core", "plannotator-review", "SKILL.md"),
    );
    const customStaleLayoutEntry = join(
      homeDir,
      ".claude",
      "skills",
      "core",
      "my-custom-skill",
      "SKILL.md",
    );
    writeText(customStaleLayoutEntry, "custom");
    writeText(
      join(homeDir, ".codex", "skills", "plannotator-archive", "SKILL.md"),
    );
    writeText(
      join(homeDir, ".kiro", "skills", "plannotator-setup-goal", "SKILL.md"),
    );

    // Vibe: a hooks.toml holding both a user hook and the installer's
    // managed block, plus installed skills. The managed block must be
    // stripped and the user hook preserved.
    const vibeHooks = join(homeDir, ".vibe", "hooks.toml");
    writeText(
      vibeHooks,
      [
        '[[hooks]]',
        'name = "my-own-hook"',
        'type = "pre_tool"',
        'match = "write_file"',
        'command = "/usr/local/bin/notify"',
        "",
        "# >>> plannotator-managed-vibe-hooks (managed; do not edit) >>>",
        "[[hooks]]",
        'name = "plannotator-exit-plan-mode"',
        'type = "pre_tool"',
        'match = "exit_plan_mode"',
        `command = ${JSON.stringify(join(homeDir, ".local", "bin", "plannotator"))}`,
        "timeout = 345600",
        'description = "Plannotator plan review (managed)"',
        "# <<< plannotator-managed-vibe-hooks <<<",
      ].join("\n"),
    );
    writeText(
      join(homeDir, ".vibe", "skills", "plannotator-review", "SKILL.md"),
    );
    writeText(
      join(homeDir, ".vibe", "skills", "my-custom-skill", "SKILL.md"),
      "user's own",
    );
    const openCodePackageCache = join(
      homeDir,
      ".cache",
      "opencode",
      "node_modules",
      "@plannotator",
      "opencode",
      "package.json",
    );
    const unrelatedScopedCache = join(
      homeDir,
      ".cache",
      "opencode",
      "node_modules",
      "@plannotator",
      "ui",
      "package.json",
    );
    const unrelatedBunCache = join(
      homeDir,
      ".bun",
      "install",
      "cache",
      "@plannotator",
      "ui",
      "package.json",
    );
    const bunOpenCodeVersionCache = join(
      homeDir,
      ".bun",
      "install",
      "cache",
      "@plannotator",
      "opencode@0.25.1@@@1",
      "package.json",
    );
    const bunOpenCodeAliasCache = join(
      homeDir,
      ".bun",
      "install",
      "cache",
      "@plannotator",
      "opencode",
      "0.25.1@@@1",
    );
    // OpenCode 2 caches npm plugins at <cache>/opencode/npm/<name>@<spec>/<generation>/.
    const openCode2PluginCache = join(
      homeDir,
      ".cache",
      "opencode",
      "npm",
      "@plannotator",
      "opencode@latest",
      "1790000000000",
      "package.json",
    );
    const openCode2UnrelatedCache = join(
      homeDir,
      ".cache",
      "opencode",
      "npm",
      "@plannotator",
      "pi-extension@latest",
      "1790000000000",
      "package.json",
    );
    writeText(openCodePackageCache);
    writeText(openCode2PluginCache);
    writeText(openCode2UnrelatedCache);
    writeText(unrelatedScopedCache);
    writeText(unrelatedBunCache);
    writeText(bunOpenCodeVersionCache);
    writeText(bunOpenCodeAliasCache);

    const claudeSettings = join(homeDir, ".claude", "settings.json");
    writeJson(claudeSettings, {
      theme: "dark",
      hooks: {
        PermissionRequest: [
          {
            matcher: "ExitPlanMode",
            hooks: [
              { type: "command", command: binary, timeout: 345600 },
              { type: "command", command: "custom-review-hook" },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: "EnterPlanMode",
            hooks: [
              {
                type: "command",
                command: `${binary} improve-context`,
                timeout: 10,
              },
            ],
          },
        ],
      },
    });

    const codexHooks = join(homeDir, ".codex", "hooks.json");
    writeJson(codexHooks, {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: binary, timeout: 345600 },
              { type: "command", command: "custom-stop-hook" },
            ],
          },
        ],
      },
    });
    const codexConfig = join(homeDir, ".codex", "config.toml");
    writeText(codexConfig, "[features]\nhooks = true\n\nmodel = \"custom\"\n");

    const geminiSettings = join(homeDir, ".gemini", "settings.json");
    writeJson(geminiSettings, {
      theme: "custom",
      hooks: {
        BeforeTool: [
          {
            matcher: "exit_plan_mode",
            hooks: [
              { type: "command", command: "plannotator", timeout: 345600 },
              { type: "command", command: "custom-gemini-hook" },
            ],
          },
        ],
      },
    });
    writeText(join(homeDir, ".gemini", "policies", "plannotator.toml"));
    writeText(
      join(homeDir, ".gemini", "commands", "plannotator-review.toml"),
    );
    // /plannotator-inbox: Gemini command, OpenCode stub, Kiro and Vibe skills.
    writeText(join(homeDir, ".gemini", "commands", "plannotator-inbox.toml"));
    writeText(join(alternateConfig, "opencode", "commands", "plannotator-inbox.md"));
    writeText(join(homeDir, ".kiro", "skills", "plannotator-inbox", "SKILL.md"));
    writeText(join(homeDir, ".vibe", "skills", "plannotator-inbox", "SKILL.md"));
    // The installer never wrote a Claude command of that name: one there is the person's.
    const ownInboxCommand = join(homeDir, ".claude", "commands", "plannotator-inbox.md");
    writeText(ownInboxCommand, "my own command");

    const conventionalOpenCode = join(
      homeDir,
      ".config",
      "opencode",
      "opencode.json",
    );
    writeJson(conventionalOpenCode, {
      plugin: ["@plannotator/opencode@latest", "keep-plugin"],
      theme: "keep",
    });
    writeText(
      join(
        alternateConfig,
        "opencode",
        "commands",
        "plannotator-annotate.md",
      ),
    );

    const recognizableAmp = [
      'const CATEGORY = "Plannotator";',
      "export default function plannotatorAmpPlugin() {}",
      'const origin = "PLANNOTATOR_ORIGIN";',
    ].join("\n");
    writeText(
      join(homeDir, ".config", "amp", "plugins", "plannotator.ts"),
      recognizableAmp,
    );
    const customKiroAgent = join(
      homeDir,
      ".kiro",
      "agents",
      "plannotator.json",
    );
    writeJson(customKiroAgent, {
      name: "plannotator",
      description: "my custom agent",
      prompt: "custom",
    });

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );

    expect(result.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(existsSync(join(homeDir, ".claude", "skills", "plannotator-review"))).toBe(false);
    expect(existsSync(join(homeDir, ".claude", "skills", "plannotator"))).toBe(false);
    expect(existsSync(join(homeDir, ".agents", "skills", "plannotator"))).toBe(false);
    expect(existsSync(join(homeDir, ".agents", "skills", "plannotator-compound"))).toBe(true);
    expect(existsSync(join(homeDir, ".agents", "skills", "plannotator-archive"))).toBe(false);
    expect(existsSync(join(homeDir, ".kiro", "skills", "plannotator-setup-goal"))).toBe(false);
    expect(existsSync(join(homeDir, ".vibe", "skills", "plannotator-review"))).toBe(false);
    expect(existsSync(join(homeDir, ".vibe", "skills", "my-custom-skill"))).toBe(true);
    for (const installed of [
      join(homeDir, ".claude", "skills", "plannotator-inbox"),
      join(homeDir, ".agents", "skills", "plannotator-inbox"),
      join(homeDir, ".kiro", "skills", "plannotator-inbox"),
      join(homeDir, ".vibe", "skills", "plannotator-inbox"),
      join(homeDir, ".gemini", "commands", "plannotator-inbox.toml"),
      join(alternateConfig, "opencode", "commands", "plannotator-inbox.md"),
    ]) {
      expect(existsSync(installed)).toBe(false);
    }
    expect(readFileSync(ownInboxCommand, "utf8")).toBe("my own command");
    const vibeHooksAfter = readFileSync(vibeHooks, "utf8");
    expect(vibeHooksAfter).toContain("my-own-hook");
    expect(vibeHooksAfter).not.toContain("plannotator-managed-vibe-hooks");
    expect(vibeHooksAfter).not.toContain("exit_plan_mode");
    expect(existsSync(customStaleLayoutEntry)).toBe(true);
    expect(existsSync(openCodePackageCache)).toBe(false);
    expect(existsSync(join(homeDir, ".cache", "opencode", "npm", "@plannotator", "opencode@latest"))).toBe(false);
    expect(existsSync(openCode2UnrelatedCache)).toBe(true);
    expect(existsSync(unrelatedScopedCache)).toBe(true);
    expect(existsSync(unrelatedBunCache)).toBe(true);
    expect(existsSync(bunOpenCodeVersionCache)).toBe(false);
    expect(existsSync(bunOpenCodeAliasCache)).toBe(false);

    expect(existsSync(join(dataDir, "plans", "approved.md"))).toBe(true);
    expect(readJson(join(dataDir, "config.json"))).toEqual({ theme: "dark" });
    expect(existsSync(join(dataDir, "vendor", "sem"))).toBe(false);
    expect(existsSync(join(dataDir, "vendor", "agent-terminal"))).toBe(false);
    expect(existsSync(join(dataDir, "vendor", "call-flow"))).toBe(false);
    expect(existsSync(join(dataDir, "vendor", "other-tool", "keep.txt"))).toBe(true);
    expect(existsSync(join(dataDir, "install-prefs"))).toBe(true);
    expect(existsSync(join(dataDir, "migrations"))).toBe(true);

    expect(readJson(claudeSettings)).toEqual({
      theme: "dark",
      hooks: {
        PermissionRequest: [
          {
            matcher: "ExitPlanMode",
            hooks: [{ type: "command", command: "custom-review-hook" }],
          },
        ],
      },
    });
    expect(readJson(codexHooks)).toEqual({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "custom-stop-hook" },
            ],
          },
        ],
      },
    });
    expect(readFileSync(codexConfig, "utf8")).toContain('model = "custom"');
    expect(readJson(geminiSettings)).toEqual({
      theme: "custom",
      hooks: {
        BeforeTool: [
          {
            matcher: "exit_plan_mode",
            hooks: [
              { type: "command", command: "custom-gemini-hook" },
            ],
          },
        ],
      },
    });
    expect(readJson(conventionalOpenCode)).toEqual({
      plugin: ["keep-plugin"],
      theme: "keep",
    });
    expect(
      existsSync(
        join(
          alternateConfig,
          "opencode",
          "commands",
          "plannotator-annotate.md",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(homeDir, ".config", "amp", "plugins", "plannotator.ts"),
      ),
    ).toBe(false);
    expect(existsSync(customKiroAgent)).toBe(true);
    expect(result.preserved).toContain(
      `${customKiroAgent} (custom or unrecognized Kiro agent)`,
    );
    expect(fixture.commandCalls).toEqual([]);
  });

  test("removes the knowledge skill from every scope that installs it, and only those", async () => {
    // The knowledge skill is named `plannotator` — the same bare name as a
    // legacy slash command and as anything else a user might name after the
    // product. That is exactly why KNOWLEDGE_SKILLS is a separate list from
    // CORE_SKILLS: folding it into CORE_SKILLS would put `plannotator` into
    // LEGACY_COMMAND_NAMES and STALE_CODEX_SKILLS, and uninstall would start
    // deleting a user's own commands/plannotator.md. This test is the wall.
    const fixture = createFixture();
    const { homeDir } = fixture;
    const alternateConfig = join(fixture.root, "xdg-config");
    fixture.environment = {
      ...fixture.environment,
      env: { XDG_CONFIG_HOME: alternateConfig },
    };

    // Scopes an install actually writes the knowledge skill to.
    const installedScopes = [
      join(homeDir, ".claude", "skills", "plannotator"),
      join(homeDir, ".agents", "skills", "plannotator"),
      join(homeDir, ".kiro", "skills", "plannotator"),
      join(alternateConfig, "opencode", "skills", "plannotator"),
      // Pre-0.27 Claude layout; cleanupStaleSkillLayout must know the
      // knowledge skill too, or an upgrader keeps a dead copy forever.
      join(homeDir, ".claude", "skills", "core", "plannotator"),
    ];
    for (const scope of installedScopes) {
      writeText(join(scope, "SKILL.md"), "# Plannotator CLI Reference");
    }

    // Paths that merely share the name and are NOT ours to delete.
    const userOwned = [
      join(homeDir, ".claude", "commands", "plannotator.md"),
      join(alternateConfig, "opencode", "commands", "plannotator.md"),
      join(homeDir, ".codex", "skills", "plannotator", "SKILL.md"),
    ];
    for (const path of userOwned) {
      writeText(path, "the user's own file");
    }

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );

    expect(result.ok).toBe(true);
    for (const scope of installedScopes) {
      expect(existsSync(scope), `${scope} should have been removed`).toBe(false);
    }
    for (const path of userOwned) {
      expect(existsSync(path), `${path} must survive uninstall`).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("the user's own file");
    }
  });

  test("dry-run reports work without mutating files or invoking hosts", async () => {
    const fixture = createFixture();
    const binary = join(
      fixture.homeDir,
      ".local",
      "bin",
      "plannotator",
    );
    writeText(binary);
    writeJson(join(fixture.homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "plannotator@plannotator": true },
    });
    // Vibe: a user hook beside the managed block, so the real run would
    // REWRITE the file rather than delete it (the dry-run must not).
    const vibeHooks = join(fixture.homeDir, ".vibe", "hooks.toml");
    writeText(
      vibeHooks,
      [
        "[[hooks]]",
        'name = "my-own-hook"',
        'type = "pre_tool"',
        'match = "write_file"',
        'command = "/usr/local/bin/notify"',
        "",
        "# >>> plannotator-managed-vibe-hooks (managed; do not edit) >>>",
        "[[hooks]]",
        'name = "plannotator-exit-plan-mode"',
        // A TOML string: a Windows path's backslashes are escapes there.
        `command = ${JSON.stringify(binary)}`,
        "# <<< plannotator-managed-vibe-hooks <<<",
        "",
      ].join("\n"),
    );
    const before = snapshotTree(fixture.root);

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: true },
      {
        ...fixture.environment,
        which: () => "/fake/claude",
      },
    );

    expect(result.ok).toBe(true);
    expect(result.planned).toContain(binary);
    expect(result.planned).toContain(
      "Claude Code plugin plannotator@plannotator",
    );
    expect(result.planned).toContain(
      `Plannotator Vibe plan-review hook in ${vibeHooks}`,
    );
    expect(existsSync(binary)).toBe(true);
    expect(fixture.commandCalls).toEqual([]);
    expect(snapshotTree(fixture.root)).toEqual(before);
  });

  test("strips the managed Vibe block, reports it, and keeps CRLF line endings", async () => {
    const fixture = createFixture();
    const vibeHooks = join(fixture.homeDir, ".vibe", "hooks.toml");
    writeText(
      vibeHooks,
      [
        "[[hooks]]",
        'name = "my-own-hook"',
        'command = "/usr/local/bin/notify"',
        "",
        "# >>> plannotator-managed-vibe-hooks (managed; do not edit) >>>",
        "[[hooks]]",
        'name = "plannotator-exit-plan-mode"',
        "# <<< plannotator-managed-vibe-hooks <<<",
        "",
      ].join("\r\n"),
    );

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );

    expect(result.errors).toEqual([]);
    expect(result.removed).toContain(
      `Plannotator Vibe plan-review hook in ${vibeHooks}`,
    );
    expect(readFileSync(vibeHooks, "utf8")).toBe(
      '[[hooks]]\r\nname = "my-own-hook"\r\ncommand = "/usr/local/bin/notify"\r\n',
    );
  });

  test("removes OpenCode from JSONC while preserving comments and unrelated plugins", async () => {
    const fixture = createFixture();
    const configPath = join(
      fixture.homeDir,
      ".config",
      "opencode",
      "opencode.jsonc",
    );
    const contents = [
      "{",
      "  // custom JSONC",
      '  "plugin": [',
      '    "@plannotator/opencode", // managed',
      "    // keep this plugin because it configures the user's workflow",
      '    "keep-plugin",',
      '    ["@plannotator/opencode@0.25.1", { "enabled": true }],',
      "  ],",
      '  "theme": "keep",',
      "}",
      "",
    ].join("\n");
    writeText(configPath, contents);

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );

    const updated = readFileSync(configPath, "utf8");
    expect(updated).toContain("// custom JSONC");
    expect(updated).toContain(
      "// keep this plugin because it configures the user's workflow",
    );
    expect(updated).toContain('"keep-plugin"');
    expect(updated).toContain('"theme": "keep"');
    expect(updated).not.toContain("@plannotator/opencode");
    expect(result.errors).toEqual([]);
  });

  test("keeps the binary until malformed OpenCode config is cleaned manually", async () => {
    const fixture = createFixture();
    const binary = join(
      fixture.homeDir,
      ".local",
      "bin",
      "plannotator",
    );
    writeText(binary);
    const configPath = join(
      fixture.homeDir,
      ".config",
      "opencode",
      "opencode.jsonc",
    );
    const contents = '{ "plugin": ["@plannotator/opencode", } broken';
    writeText(configPath, contents);

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );

    expect(readFileSync(configPath, "utf8")).toBe(contents);
    expect(existsSync(binary)).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain(
      `Preserved ${configPath}: it is not valid JSON or JSONC, so @plannotator/opencode plugin entries cannot be classified safely.`,
    );
    expect(result.errors[0]).toContain(
      "Remove every plugin array entry for @plannotator/opencode, including versioned entries and tuple entries",
    );
    expect(result.errors[0]).toContain(
      "Then rerun `plannotator uninstall`.",
    );

    writeJson(configPath, { plugin: ["keep-plugin"] });
    const retry = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );
    expect(retry.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(readJson(configPath)).toEqual({ plugin: ["keep-plugin"] });
  });

  test("preserves a custom Gemini hook sharing the managed matcher", async () => {
    const fixture = createFixture();
    const settingsPath = join(
      fixture.homeDir,
      ".gemini",
      "settings.json",
    );
    writeJson(settingsPath, {
      hooks: {
        BeforeTool: [
          {
            matcher: "exit_plan_mode",
            hooks: [
              { type: "command", command: "plannotator", timeout: 345600 },
              { type: "command", command: "my-custom-plan-hook" },
            ],
          },
        ],
      },
      experimental: { plan: true },
    });

    await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );

    expect(readJson(settingsPath)).toEqual({
      hooks: {
        BeforeTool: [
          {
            matcher: "exit_plan_mode",
            hooks: [
              { type: "command", command: "my-custom-plan-hook" },
            ],
          },
        ],
      },
      experimental: { plan: true },
    });
  });

  test("preserves strict JSON indentation, line endings, and trailing newline", async () => {
    const fixture = createFixture();
    const settingsPath = join(
      fixture.homeDir,
      ".gemini",
      "settings.json",
    );
    const contents = [
      "{",
      '    "theme": "custom",',
      '    "hooks": {',
      '        "BeforeTool": [',
      "            {",
      '                "matcher": "exit_plan_mode",',
      '                "hooks": [{ "type": "command", "command": "plannotator" }]',
      "            }",
      "        ]",
      "    }",
      "}",
      "",
    ].join("\r\n");
    writeText(settingsPath, contents);

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toBe(
      ['{', '    "theme": "custom"', '}', ''].join("\r\n"),
    );
  });

  test.skipIf(process.platform === "win32")(
    "keeps the binary and hook when Gemini settings cannot be edited",
    async () => {
      const fixture = createFixture();
      const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
      const settingsPath = join(
        fixture.homeDir,
        ".gemini",
        "settings.json",
      );
      writeText(binary);
      writeJson(settingsPath, {
        theme: "custom",
        hooks: {
          BeforeTool: [
            {
              matcher: "exit_plan_mode",
              hooks: [{ type: "command", command: "plannotator" }],
            },
          ],
        },
      });
      chmodSync(settingsPath, 0o400);

      const blocked = await runPlannotatorUninstall(
        { purge: false, dryRun: false },
        fixture.environment,
      );

      expect(blocked.ok).toBe(false);
      expect(existsSync(binary)).toBe(true);
      expect(readFileSync(settingsPath, "utf8")).toContain("plannotator");
      expect(blocked.errors[0]).toContain(
        `Could not update ${settingsPath}`,
      );
      expect(blocked.errors[0]).toContain(
        'Remove only Plannotator command hooks from hooks.BeforeTool entries whose matcher is "exit_plan_mode"',
      );
      expect(blocked.errors[0]).toContain(
        "Then rerun `plannotator uninstall`.",
      );

      chmodSync(settingsPath, 0o600);
      writeJson(settingsPath, { theme: "custom" });
      const retry = await runPlannotatorUninstall(
        { purge: false, dryRun: false },
        fixture.environment,
      );
      expect(retry.ok).toBe(true);
      expect(existsSync(binary)).toBe(false);
      expect(readJson(settingsPath)).toEqual({ theme: "custom" });
    },
  );

  test("removes a relocated Codex hook adopted by the installer", async () => {
    const fixture = createFixture();
    const hooksPath = join(fixture.homeDir, ".codex", "hooks.json");
    writeJson(hooksPath, {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: join(fixture.root, "relocated", "plannotator"),
              },
              {
                type: "command",
                command: join(fixture.root, "relocated", "plannotator-helper"),
              },
            ],
          },
        ],
      },
    });

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );

    expect(result.ok).toBe(true);
    expect(readJson(hooksPath)).toEqual({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: join(fixture.root, "relocated", "plannotator-helper"),
              },
            ],
          },
        ],
      },
    });
  });

  test("requires manual repair for unrelated malformed Gemini settings", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const settingsPath = join(
      fixture.homeDir,
      ".gemini",
      "settings.json",
    );
    const contents = '{ "theme": "custom" // comments are not strict JSON\n}';
    writeText(binary);
    writeText(settingsPath, contents);

    const blocked = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );

    expect(blocked.ok).toBe(false);
    expect(existsSync(binary)).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toBe(contents);
    expect(blocked.errors[0]).toContain(
      `Preserved ${settingsPath}: it is not strict JSON, so managed Gemini hooks cannot be classified safely.`,
    );
    expect(blocked.errors[0]).toContain(
      'Remove only Plannotator command hooks from hooks.BeforeTool entries whose matcher is "exit_plan_mode"',
    );
    expect(blocked.errors[0]).toContain(
      "Then rerun `plannotator uninstall`.",
    );

    writeJson(settingsPath, { theme: "custom" });
    const retry = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );
    expect(retry.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(readJson(settingsPath)).toEqual({ theme: "custom" });
  });

  test("fails safe for escaped managed spellings in malformed host config", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const settingsPath = join(
      fixture.homeDir,
      ".gemini",
      "settings.json",
    );
    const kiroAgentPath = join(
      fixture.homeDir,
      ".kiro",
      "agents",
      "plannotator.json",
    );
    const contents = '{ "command": "pl\\u0061nnotator" // malformed managed hook\n}';
    const kiroContents = '{ "name": "plannotator" // malformed agent\n}';
    writeText(binary);
    writeText(settingsPath, contents);
    writeText(kiroAgentPath, kiroContents);

    const blocked = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );

    expect(blocked.ok).toBe(false);
    expect(existsSync(binary)).toBe(true);
    expect(contents.toLowerCase()).not.toContain("plannotator");
    expect(blocked.errors).toHaveLength(2);
    expect(blocked.errors[0]).toContain(
      "managed Gemini hooks cannot be classified safely",
    );
    expect(blocked.errors[1]).toContain(
      "the Plannotator Kiro agent cannot be classified safely",
    );
    expect(
      blocked.errors.every((error) =>
        error.includes("Then rerun `plannotator uninstall`.")
      ),
    ).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toBe(contents);
    expect(readFileSync(kiroAgentPath, "utf8")).toBe(kiroContents);
  });

  test("skips data-contained runtimes when the configured data root is broad", async () => {
    const fixture = createFixture();
    const binary = join(
      fixture.homeDir,
      ".local",
      "bin",
      "plannotator",
    );
    const unrelatedVendorFile = join(
      fixture.homeDir,
      "vendor",
      "sem",
      "keep.txt",
    );
    writeText(binary);
    writeText(unrelatedVendorFile, "unrelated");

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        dataDir: fixture.homeDir,
      },
    );

    expect(result.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(existsSync(unrelatedVendorFile)).toBe(true);
    expect(result.warnings[0]).toContain(
      "Preserved managed runtime paths",
    );
  });
});

describe("purge uninstall", () => {
  test("dry-run does not report a managed-only vendor directory as custom", async () => {
    const fixture = createFixture();
    writeText(join(fixture.dataDir, "vendor", "sem", "v0.8.0", "sem"));

    const result = await runPlannotatorUninstall(
      { purge: true, dryRun: true },
      fixture.environment,
    );

    expect(result.planned).toContain(join(fixture.dataDir, "vendor"));
    expect(result.preserved).not.toContain(
      `${join(fixture.dataDir, "vendor")} (unrecognized custom entry)`,
    );
  });

  test("preserves an empty vendor directory when no managed sidecar existed", async () => {
    const fixture = createFixture();
    const vendorDirectory = join(fixture.dataDir, "vendor");
    mkdirSync(vendorDirectory, { recursive: true });

    const preview = await runPlannotatorUninstall(
      { purge: true, dryRun: true },
      fixture.environment,
    );
    expect(preview.preserved).toContain(
      `${vendorDirectory} (unrecognized custom entry)`,
    );

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );

    expect(result.ok).toBe(true);
    expect(existsSync(vendorDirectory)).toBe(true);
  });

  test("removes known local data while preserving unknown top-level entries", async () => {
    const fixture = createFixture();
    writeText(join(fixture.dataDir, "plans", "approved.md"));
    writeText(join(fixture.dataDir, "history", "repo", "001.md"));
    // The feedback archive is Plannotator-authored data: purge must remove it,
    // and it must not be reported as an unrecognized custom entry.
    writeText(join(fixture.dataDir, "feedback", "repo", "index.jsonl"));
    writeJson(join(fixture.dataDir, "config.json"), { theme: "dark" });
    writeText(join(fixture.dataDir, "vendor", "sem", "v0.8.0", "sem"));
    const customVendorPath = join(
      fixture.dataDir,
      "vendor",
      "other-tool",
      "keep.txt",
    );
    writeText(customVendorPath, "not installer-owned");
    const customPath = join(fixture.dataDir, "my-notes", "keep.md");
    writeText(customPath, "not installer-owned");

    const result = await runPlannotatorUninstall(
      { purge: true, dryRun: false },
      fixture.environment,
    );

    expect(result.ok).toBe(true);
    expect(existsSync(join(fixture.dataDir, "plans"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "history"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "feedback"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "config.json"))).toBe(false);
    expect(result.preserved).not.toContain(
      `${join(fixture.dataDir, "feedback")} (unrecognized custom entry)`,
    );
    expect(existsSync(join(fixture.dataDir, "vendor", "sem"))).toBe(false);
    expect(existsSync(customVendorPath)).toBe(true);
    expect(existsSync(customPath)).toBe(true);
    expect(result.preserved).toContain(
      `${join(fixture.dataDir, "my-notes")} (unrecognized custom entry)`,
    );
  });

  test("removes the data directory when no custom entries remain", async () => {
    const fixture = createFixture();
    writeText(join(fixture.dataDir, "drafts", "draft.json"));
    writeText(join(fixture.dataDir, "active", "session", "plan.md"));
    writeText(join(fixture.dataDir, "vendor", "sem", "v0.8.0", "sem"));

    const result = await runPlannotatorUninstall(
      { purge: true, dryRun: false },
      fixture.environment,
    );

    expect(result.ok).toBe(true);
    expect(existsSync(fixture.dataDir)).toBe(false);
  });

  test("states that purged data is local-only and unrecoverable", () => {
    const warning = formatPurgeWarning("/tmp/example-data");
    expect(warning).toContain("permanently delete");
    expect(warning).toContain("local-only");
    expect(warning).toContain("not stored on a Plannotator server");
    expect(warning).toContain("cannot be recovered");
  });

  test("refuses a broad purge before removing any component", async () => {
    const fixture = createFixture();
    const binary = join(
      fixture.homeDir,
      ".local",
      "bin",
      "plannotator",
    );
    writeText(binary);

    const result = await runPlannotatorUninstall(
      { purge: true, dryRun: false },
      {
        ...fixture.environment,
        dataDir: fixture.homeDir,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Refusing to purge");
    expect(result.errors[0]).toContain("home directory");
    expect(existsSync(binary)).toBe(true);
  });

  test("refuses a data-directory swap after awaited host cleanup", async () => {
    const fixture = createFixture();
    const validatedDirectory = join(fixture.root, "validated-data");
    const replacementTarget = join(fixture.root, "replacement-target");
    const originalPlan = join(fixture.dataDir, "plans", "original.md");
    const replacementPlan = join(replacementTarget, "plans", "must-survive.md");
    const binary = join(
      fixture.homeDir,
      ".local",
      "bin",
      "plannotator",
    );
    writeText(originalPlan, "original data");
    writeText(replacementPlan, "unrelated replacement data");
    writeText(binary);
    writeJson(join(fixture.homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "plannotator@plannotator": true },
    });

    const result = await runPlannotatorUninstall(
      { purge: true, dryRun: false },
      {
        ...fixture.environment,
        which: (command) => command === "claude" ? "/fake/claude" : null,
        runCommand: async () => {
          renameSync(fixture.dataDir, validatedDirectory);
          symlinkSync(replacementTarget, fixture.dataDir, "dir");
          return { exitCode: 0, timedOut: false };
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `Refusing to remove managed paths under ${fixture.dataDir}: the data directory changed after initial validation (the data directory is a symlink; set PLANNOTATOR_DATA_DIR to its resolved target and retry).`,
    );
    expect(readFileSync(join(validatedDirectory, "plans", "original.md"), "utf8"))
      .toBe("original data");
    expect(readFileSync(replacementPlan, "utf8")).toBe(
      "unrelated replacement data",
    );
    expect(existsSync(binary)).toBe(true);
  });

  test(
    "refuses a case-variant data-dir spelling that resolves to HOME",
    async () => {
      if (!supportsCaseVariantPaths) return;
      const fixture = createFixture();
      const caseVariantHome = join(dirname(fixture.homeDir), "HOME");
      const plan = join(fixture.homeDir, "plans", "must-survive.md");
      const binary = join(
        fixture.homeDir,
        ".local",
        "bin",
        "plannotator",
      );
      writeText(plan, "local-only data");
      writeText(binary);

      const result = await runPlannotatorUninstall(
        { purge: true, dryRun: false },
        {
          ...fixture.environment,
          dataDir: caseVariantHome,
        },
      );

      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("home directory");
      expect(readFileSync(plan, "utf8")).toBe("local-only data");
      expect(existsSync(binary)).toBe(true);
    },
  );

  test("refuses filesystem-root, home-ancestor, and shared-temp targets", async () => {
    const cases = [
      {
        name: "filesystem root",
        configure: (fixture: Fixture) => ({
          dataDir: parse(fixture.homeDir).root,
        }),
        expected: "filesystem root",
      },
      {
        name: "home ancestor",
        configure: (fixture: Fixture) => ({ dataDir: fixture.root }),
        expected: "contains the home directory",
      },
      {
        name: "shared temp",
        configure: (fixture: Fixture) => {
          const sharedTemp = join(fixture.root, "shared-temp");
          mkdirSync(sharedTemp);
          return { dataDir: sharedTemp, tempDir: sharedTemp };
        },
        expected: "shared temporary directory",
      },
    ] as const;

    for (const safetyCase of cases) {
      const fixture = createFixture();
      const binary = join(
        fixture.homeDir,
        ".local",
        "bin",
        "plannotator",
      );
      writeText(binary);

      const result = await runPlannotatorUninstall(
        { purge: true, dryRun: false },
        {
          ...fixture.environment,
          ...safetyCase.configure(fixture),
        },
      );

      expect(result.ok, safetyCase.name).toBe(false);
      expect(result.errors[0], safetyCase.name).toContain(safetyCase.expected);
      expect(existsSync(binary), safetyCase.name).toBe(true);
    }
  });

  test("unlinks owned symlinks and hardlinks without touching their targets", async () => {
    const fixture = createFixture();
    const externalDirectory = join(fixture.root, "external-directory");
    const externalDirectoryFile = join(externalDirectory, "keep.md");
    const externalFile = join(fixture.root, "external-config.json");
    writeText(externalDirectoryFile, "keep directory target");
    writeText(externalFile, "keep hardlink target");
    symlinkSync(externalDirectory, join(fixture.dataDir, "plans"), "dir");
    linkSync(externalFile, join(fixture.dataDir, "config.json"));

    const result = await runPlannotatorUninstall(
      { purge: true, dryRun: false },
      fixture.environment,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(externalDirectoryFile, "utf8")).toBe(
      "keep directory target",
    );
    expect(readFileSync(externalFile, "utf8")).toBe("keep hardlink target");
  });

  test("refuses a symlinked purge target before removing any component", async () => {
    const fixture = createFixture();
    const target = join(fixture.root, "real-data");
    const symlink = join(fixture.root, "linked-data");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, symlink, "dir");
    const binary = join(
      fixture.homeDir,
      ".local",
      "bin",
      "plannotator",
    );
    writeText(binary);

    const result = await runPlannotatorUninstall(
      { purge: true, dryRun: false },
      {
        ...fixture.environment,
        dataDir: symlink,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Refusing to purge");
    expect(result.errors[0]).toContain("data directory is a symlink");
    expect(existsSync(binary)).toBe(true);
  });

  test("refuses a data path that is a file before removing any component", async () => {
    const fixture = createFixture();
    const dataFile = join(fixture.root, "not-a-directory");
    writeText(dataFile);
    const binary = join(
      fixture.homeDir,
      ".local",
      "bin",
      "plannotator",
    );
    writeText(binary);

    const result = await runPlannotatorUninstall(
      { purge: true, dryRun: false },
      {
        ...fixture.environment,
        dataDir: dataFile,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("data path is not a directory");
    expect(existsSync(binary)).toBe(true);
  });
});

describe("host and platform integrations", () => {
  test.each([
    [".claude", "settings.json", "PermissionRequest", "ExitPlanMode"],
    [".codex", "hooks.json", "Stop", ""],
    [".gemini", "settings.json", "BeforeTool", "exit_plan_mode"],
  ])("cleans customized %s hooks in dry-run and real uninstall", async (directory, file, event, matcher) => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const settings = join(fixture.homeDir, directory, file);
    const custom = { type: "command", command: "my-custom-hook" };
    writeText(binary);
    writeJson(settings, { hooks: { [event]: [{ matcher, hooks: [
      { type: "command", command: "plannotator --browser Safari" }, custom,
    ] }] } });
    const before = snapshotTree(fixture.homeDir);
    const dryRun = await runPlannotatorUninstall(
      { purge: false, dryRun: true }, fixture.environment,
    );
    expect(dryRun.ok).toBe(true);
    expect(dryRun.planned.join("\n")).toContain(settings);
    expect(snapshotTree(fixture.homeDir)).toEqual(before);

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false }, fixture.environment,
    );
    expect(result.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(readJson(settings)).toEqual({ hooks: { [event]: [{ matcher, hooks: [custom] }] } });
  });

  test("cleans browser overrides on improve-context and Windows executable paths", async () => {
    const fixture = createFixture({
      platform: "win32",
      which: (command) => command === "powershell.exe" ? "C:\\Windows\\powershell.exe" : null,
    });
    const binary = join(fixture.homeDir, "AppData", "Local", "plannotator", "plannotator.exe");
    const settings = join(fixture.homeDir, ".claude", "settings.json");
    writeText(binary);
    writeJson(settings, { theme: "dark", hooks: { PreToolUse: [{
      matcher: "EnterPlanMode", hooks: [
        { type: "command", command: `"${binary.replaceAll("/", "\\")}" improve-context --browser "Google Chrome"` },
        { type: "command", command: "plannotator --browser Safari improve-context" },
      ],
    }] } });
    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false }, fixture.environment,
    );
    expect(result.ok).toBe(true);
    expect(readJson(settings)).toEqual({ theme: "dark" });
    expect(existsSync(binary)).toBe(false);
  });

  test.each([
    "plannotator --custom-option",
    "plannotator --browser Safari && my-custom-hook",
    "plannotator&&my-custom-hook",
    "plannotator review",
  ])("preserves and blocks on unsupported or composite hook %s", async (command) => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const settings = join(fixture.homeDir, ".claude", "settings.json");
    writeText(binary);
    const config = { hooks: { PermissionRequest: [{ matcher: "ExitPlanMode", hooks: [
      { type: "command", command },
    ] }] } };
    writeJson(settings, config);
    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false }, fixture.environment,
    );
    expect(result.ok).toBe(false);
    expect(existsSync(binary)).toBe(true);
    expect(readJson(settings)).toEqual(config);
    expect(result.errors.join("\n")).toContain("hooks.PermissionRequest[0].hooks[0].command");
  });

  test("blocks on a Vibe command outside the managed block without deleting custom hooks", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const settings = join(fixture.homeDir, ".vibe", "hooks.toml");
    const content = '[[hooks]]\nname = "custom-plan"\ncommand = "plannotator --browser Safari"\n';
    writeText(binary);
    writeText(settings, content);
    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false }, fixture.environment,
    );
    expect(result.ok).toBe(false);
    expect(existsSync(binary)).toBe(true);
    expect(readFileSync(settings, "utf8")).toBe(content);
    expect(result.errors.join("\n")).toContain(settings);
    expect(result.errors.join("\n")).toContain("hooks[0].command");
  });

  test("does not trust a host manager's success while its configuration survives", async () => {
    const fixture = createFixture({ which: () => "/fake/droid" });
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const settings = join(fixture.homeDir, ".factory", "settings.json");
    writeText(binary);
    writeJson(settings, { enabledPlugins: { "plannotator@plannotator": true, "user-plugin": true } });
    const blocked = await runPlannotatorUninstall(
      { purge: false, dryRun: false }, fixture.environment,
    );
    expect(blocked.ok).toBe(false);
    expect(existsSync(binary)).toBe(true);
    expect(blocked.errors.join("\n")).toContain('enabledPlugins["plannotator@plannotator"]');
    expect(blocked.errors.join("\n")).toContain(settings);
    const retry = await runPlannotatorUninstall(
      { purge: false, dryRun: false }, {
        ...fixture.environment,
        runCommand: async () => {
          writeJson(settings, { enabledPlugins: { "user-plugin": true } });
          return { exitCode: 0, timedOut: false };
        },
      },
    );
    expect(retry.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(readJson(settings)).toEqual({ enabledPlugins: { "user-plugin": true } });
  });

  test("removes browser-customized hooks but preserves unrelated commands", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const settings = join(fixture.homeDir, ".claude", "settings.json");
    const custom = [
      { type: "command", command: "my-custom-hook" },
      { type: "command", command: "echo plannotator --browser Safari" },
      { type: "command", command: "plannotator-helper --browser Safari" },
    ];
    writeText(binary);
    writeJson(settings, { theme: "dark", hooks: { PermissionRequest: [{
      matcher: "ExitPlanMode", hooks: [
        { type: "command", command: "plannotator --browser Safari" },
        { type: "command", command: `"${binary}" --browser "Google Chrome"` },
        ...custom,
      ],
    }] } });

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false }, fixture.environment,
    );

    expect(result.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(readJson(settings)).toEqual({ theme: "dark", hooks: {
      PermissionRequest: [{ matcher: "ExitPlanMode", hooks: custom }],
    } });
  });

  test("blocks binary removal for a surviving recognized command until manual cleanup", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const settings = join(fixture.homeDir, ".claude", "settings.json");
    const hooks = [{ matcher: "custom-tool", hooks: [
      { type: "command", command: "plannotator --browser Safari" },
      { type: "command", command: "my-custom-hook" },
    ] }];
    writeText(binary);
    writeJson(settings, { hooks: { PreToolUse: hooks } });

    const blocked = await runPlannotatorUninstall(
      { purge: false, dryRun: false }, fixture.environment,
    );
    expect(blocked.ok).toBe(false);
    expect(existsSync(binary)).toBe(true);
    expect(readJson(settings)).toEqual({ hooks: { PreToolUse: hooks } });
    expect(blocked.errors.join("\n")).toContain(settings);
    expect(blocked.errors.join("\n")).toContain("hooks.PreToolUse[0].hooks[0].command");
    expect(blocked.errors.join("\n")).toContain("plannotator uninstall");

    writeJson(settings, { hooks: { PreToolUse: [{ matcher: "custom-tool", hooks: [
      { type: "command", command: "my-custom-hook" },
    ] }] } });
    const retry = await runPlannotatorUninstall(
      { purge: false, dryRun: false }, fixture.environment,
    );
    expect(retry.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
  });

  test("keeps the binary and reports the exact command when a host is unavailable", async () => {
    const fixture = createFixture();
    const binary = join(
      fixture.homeDir,
      ".local",
      "bin",
      "plannotator",
    );
    writeText(binary);
    writeJson(join(fixture.homeDir, ".factory", "settings.json"), {
      enabledPlugins: { "plannotator@plannotator": true },
    });

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain(
      "Droid plugin plannotator@plannotator",
    );
    expect(result.errors[0]).toContain("droid is unavailable");
    expect(result.errors[0]).toContain(
      "restore droid on PATH and run `droid plugin uninstall plannotator@plannotator --scope user`",
    );
    expect(result.errors[0]).toContain(
      "After it succeeds, rerun `plannotator uninstall`.",
    );
    expect(result.errors[0]).toContain(join(fixture.homeDir, ".factory", "settings.json"));
    expect(result.errors[0]).toContain('enabledPlugins["plannotator@plannotator"]');
    expect(existsSync(binary)).toBe(true);
    expect(result.warnings).toContain(
      "Preserved the Plannotator CLI and its Windows PATH entry so you can resolve the errors and retry uninstall.",
    );

    writeJson(join(fixture.homeDir, ".factory", "settings.json"), {
      enabledPlugins: {},
    });
    const retry = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      fixture.environment,
    );
    expect(retry.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
  });

  test("keeps the binary and reports the exact command when a host manager fails", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    writeText(binary);
    writeJson(join(fixture.homeDir, ".pi", "agent", "settings.json"), {
      packages: [{ source: "npm:@plannotator/pi-extension@0.25.1" }],
    });

    const result = await runPlannotatorUninstall(
      { purge: true, dryRun: false },
      {
        ...fixture.environment,
        which: (command) => command === "pi" ? "/fake/pi" : null,
        runCommand: async (command, args, env) => {
          fixture.commandCalls.push({ command, args, env });
          return { exitCode: 23, timedOut: false };
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(existsSync(binary)).toBe(true);
    expect(result.errors[0]).toContain(
      "Pi extension npm:@plannotator/pi-extension was not removed automatically (exit 23)",
    );
    expect(result.errors[0]).toContain(
      "run `pi remove npm:@plannotator/pi-extension` directly",
    );
    expect(result.errors[0]).toContain(
      "Then rerun `plannotator uninstall --purge`.",
    );
  });

  test("detects disabled Claude and Droid plugins from installation metadata", async () => {
    const fixture = createFixture();
    writeJson(
      join(fixture.homeDir, ".claude", "plugins", "installed_plugins.json"),
      {
        plugins: {
          "plannotator@plannotator": [
            { installPath: "/fake/claude/plannotator" },
          ],
        },
      },
    );
    writeJson(
      join(fixture.homeDir, ".factory", "plugins", "installed_plugins.json"),
      {
        plugins: {
          "plannotator@plannotator": [
            { installPath: "/fake/droid/plannotator" },
          ],
        },
      },
    );

    await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        which: (command) => `/fake/${command}`,
      },
    );

    expect(fixture.commandCalls.map((call) => call.args)).toEqual([
      [
        "plugin",
        "uninstall",
        "plannotator@plannotator",
        "--scope",
        "user",
        "--keep-data",
        "--yes",
      ],
      [
        "plugin",
        "uninstall",
        "plannotator@plannotator",
        "--scope",
        "user",
      ],
    ]);
  });

  test("uses host plugin managers and preserves Claude plugin data by default", async () => {
    const fixture = createFixture();
    writeJson(join(fixture.homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "plannotator@plannotator": true },
    });
    writeJson(join(fixture.homeDir, ".copilot", "settings.json"), {
      enabledPlugins: { "plannotator-copilot@plannotator": true },
    });
    writeJson(join(fixture.homeDir, ".factory", "settings.json"), {
      enabledPlugins: { "plannotator@plannotator": true },
    });
    writeJson(join(fixture.homeDir, ".pi", "agent", "settings.json"), {
      packages: [{ source: "npm:@plannotator/pi-extension@0.25.1" }],
    });
    writeText(
      join(
        fixture.homeDir,
        ".vscode",
        "extensions",
        "backnotprop.plannotator-webview-0.25.1",
        "package.json",
      ),
    );

    await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        which: (command) => `/fake/${command}`,
      },
    );

    expect(fixture.commandCalls.map((call) => call.args)).toEqual([
      [
        "plugin",
        "uninstall",
        "plannotator@plannotator",
        "--scope",
        "user",
        "--keep-data",
        "--yes",
      ],
      ["plugin", "uninstall", "plannotator-copilot@plannotator"],
      [
        "plugin",
        "uninstall",
        "plannotator@plannotator",
        "--scope",
        "user",
      ],
      ["remove", "npm:@plannotator/pi-extension"],
      ["--uninstall-extension", "backnotprop.plannotator-webview"],
    ]);
  });

  test("allows Claude to remove its plugin data during purge", async () => {
    const fixture = createFixture();
    writeJson(join(fixture.homeDir, ".claude", "settings.json"), {
      enabledPlugins: { "plannotator@plannotator": true },
    });

    await runPlannotatorUninstall(
      { purge: true, dryRun: false },
      {
        ...fixture.environment,
        which: (command) => `/fake/${command}`,
      },
    );

    expect(fixture.commandCalls).toHaveLength(1);
    expect(fixture.commandCalls[0]?.args).not.toContain("--keep-data");
  });

  test("removes Windows PATH registration and schedules the running exe", async () => {
    const fixture = createFixture();
    const localAppData = join(fixture.homeDir, "AppData", "Local");
    const currentExe = join(localAppData, "plannotator", "plannotator.exe");
    const legacyExe = join(
      fixture.homeDir,
      ".local",
      "bin",
      "plannotator.exe",
    );
    writeText(currentExe);
    writeText(legacyExe);

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        platform: "win32",
        execPath: currentExe.toUpperCase(),
        env: { LOCALAPPDATA: localAppData },
        which: (command) =>
          command === "powershell.exe" ? "C:\\Windows\\powershell.exe" : null,
      },
    );

    expect(result.ok).toBe(true);
    expect(existsSync(legacyExe)).toBe(false);
    expect(existsSync(currentExe)).toBe(true);
    expect(fixture.scheduledDeletes).toEqual([
      {
        target: currentExe,
        parent: dirname(currentExe),
      },
    ]);
    expect(fixture.commandCalls).toHaveLength(1);
    expect(fixture.commandCalls[0]?.env).toEqual({
      PLANNOTATOR_UNINSTALL_PATH: dirname(currentExe),
    });
  });

  test("never schedules removal of a shared parent for a legacy Windows exe", async () => {
    const fixture = createFixture();
    const localAppData = join(fixture.homeDir, "AppData", "Local");
    const sharedBin = join(fixture.homeDir, ".local", "bin");
    const currentExe = join(sharedBin, "plannotator.exe");
    const unrelatedFile = join(sharedBin, "unrelated-tool.exe");
    writeText(currentExe);
    writeText(unrelatedFile);

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        platform: "win32",
        execPath: currentExe,
        env: { LOCALAPPDATA: localAppData },
        which: (command) =>
          command === "powershell.exe" ? "C:\\Windows\\powershell.exe" : null,
      },
    );

    expect(result.ok).toBe(true);
    expect(fixture.scheduledDeletes).toEqual([
      { target: currentExe, parent: null },
    ]);
    expect(existsSync(unrelatedFile)).toBe(true);
  });

  test("keeps the running Windows CLI when PATH cleanup fails", async () => {
    const fixture = createFixture();
    const localAppData = join(fixture.homeDir, "AppData", "Local");
    const currentExe = join(localAppData, "plannotator", "plannotator.exe");
    writeText(currentExe);

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        platform: "win32",
        execPath: currentExe,
        env: { LOCALAPPDATA: localAppData },
        which: () => "C:\\Windows\\powershell.exe",
        runCommand: async () => ({ exitCode: 1, timedOut: false }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `Could not remove ${dirname(currentExe)} from the Windows user PATH (exit 1).`,
    );
    expect(existsSync(currentExe)).toBe(true);
    expect(fixture.scheduledDeletes).toEqual([]);
  });

  test("proceeds without a PATH error when the entry is not present (exit 3)", async () => {
    const fixture = createFixture();
    const localAppData = join(fixture.homeDir, "AppData", "Local");
    const currentExe = join(localAppData, "plannotator", "plannotator.exe");
    writeText(currentExe);

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        platform: "win32",
        execPath: currentExe,
        env: { LOCALAPPDATA: localAppData },
        which: () => "C:\\Windows\\powershell.exe",
        runCommand: async () => ({ exitCode: 3, timedOut: false }),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.removed).not.toContain(
      `Windows user PATH entry ${dirname(currentExe)}`,
    );
    expect(fixture.scheduledDeletes).toEqual([
      { target: currentExe, parent: dirname(currentExe) },
    ]);
  });

  test("reports a timed-out PATH edit as a timeout and keeps the CLI", async () => {
    const fixture = createFixture();
    const localAppData = join(fixture.homeDir, "AppData", "Local");
    const currentExe = join(localAppData, "plannotator", "plannotator.exe");
    writeText(currentExe);

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        platform: "win32",
        execPath: currentExe,
        env: { LOCALAPPDATA: localAppData },
        which: () => "C:\\Windows\\powershell.exe",
        // Killed before the script echoed anything: the edit is unproven.
        runCommand: async () => ({ exitCode: 124, timedOut: true, stdout: "" }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `Could not remove ${dirname(currentExe)} from the Windows user PATH (command timed out).`,
    );
    expect(existsSync(currentExe)).toBe(true);
    expect(fixture.scheduledDeletes).toEqual([]);
  });

  test("treats a timeout after the rollback echo as a completed PATH edit", async () => {
    const fixture = createFixture();
    const localAppData = join(fixture.homeDir, "AppData", "Local");
    const currentExe = join(localAppData, "plannotator", "plannotator.exe");
    writeText(currentExe);
    const originalPath = `C:\\Before;${dirname(currentExe)};C:\\After;;`;

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        platform: "win32",
        execPath: currentExe,
        env: { LOCALAPPDATA: localAppData },
        which: () => "C:\\Windows\\powershell.exe",
        // The script echoes the original PATH only after the registry write,
        // so an echo followed by a kill means only the broadcast stalled.
        runCommand: async () => ({
          exitCode: 124,
          timedOut: true,
          stdout: `${JSON.stringify(originalPath)}\n`,
        }),
      },
    );

    const pathLabel = `Windows user PATH entry ${dirname(currentExe)}`;
    expect(result.ok).toBe(true);
    expect(result.removed).toContain(pathLabel);
    expect(result.warnings.some((w) => w.includes("timed out"))).toBe(true);
    expect(fixture.scheduledDeletes).toEqual([
      { target: currentExe, parent: dirname(currentExe) },
    ]);
  });

  test("treats a non-zero exit after the rollback echo as a completed PATH edit", async () => {
    const fixture = createFixture();
    const localAppData = join(fixture.homeDir, "AppData", "Local");
    const currentExe = join(localAppData, "plannotator", "plannotator.exe");
    writeText(currentExe);
    const originalPath = `C:\\Before;${dirname(currentExe)};C:\\After;;`;

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        platform: "win32",
        execPath: currentExe,
        env: { LOCALAPPDATA: localAppData },
        which: () => "C:\\Windows\\powershell.exe",
        // A native fault inside Add-Type / SendMessageTimeout is not
        // catchable and ends the process with an NTSTATUS code; the echo
        // already on stdout still proves the write completed.
        runCommand: async () => ({
          exitCode: -1073741819,
          timedOut: false,
          stdout: `${JSON.stringify(originalPath)}\n`,
        }),
      },
    );

    const pathLabel = `Windows user PATH entry ${dirname(currentExe)}`;
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.removed).toContain(pathLabel);
    expect(result.warnings.some((w) => w.includes("exit -1073741819"))).toBe(true);
    expect(fixture.scheduledDeletes).toEqual([
      { target: currentExe, parent: dirname(currentExe) },
    ]);
  });

  test("treats a restore that printed its sentinel as completed however the process ended", async () => {
    for (const ending of [
      { exitCode: 124, timedOut: true, needle: "timed out" },
      { exitCode: -1073741819, timedOut: false, needle: "exit -1073741819" },
    ]) {
      const fixture = createFixture();
      const localAppData = join(fixture.homeDir, "AppData", "Local");
      const currentExe = join(localAppData, "plannotator", "plannotator.exe");
      writeText(currentExe);
      let commandCount = 0;

      const result = await runPlannotatorUninstall(
        { purge: false, dryRun: false },
        {
          ...fixture.environment,
          platform: "win32",
          execPath: currentExe,
          env: { LOCALAPPDATA: localAppData },
          which: () => "C:\\Windows\\powershell.exe",
          runCommand: async () => {
            commandCount += 1;
            if (commandCount === 1) {
              return {
                exitCode: 0,
                timedOut: false,
                stdout: JSON.stringify(
                  `C:\\Before;${dirname(currentExe)};C:\\After;;`,
                ),
              };
            }
            return {
              exitCode: ending.exitCode,
              timedOut: ending.timedOut,
              stdout: "PLANNOTATOR_PATH_RESTORED\r\n",
            };
          },
          scheduleWindowsSelfDelete: async () => false,
        },
      );

      const pathLabel = `Windows user PATH entry ${dirname(currentExe)}`;
      expect(result.ok).toBe(false);
      expect(existsSync(currentExe)).toBe(true);
      expect(result.errors.some((e) => e.includes("Could not restore"))).toBe(false);
      expect(result.removed).not.toContain(pathLabel);
      expect(result.preserved).toContain(`${pathLabel} (restored for retry)`);
      expect(
        result.warnings.some(
          (w) => w.startsWith("Restored ") && w.includes(ending.needle),
        ),
      ).toBe(true);
    }
  });

  test("reports a restore that never printed its sentinel as failed", async () => {
    const fixture = createFixture();
    const localAppData = join(fixture.homeDir, "AppData", "Local");
    const currentExe = join(localAppData, "plannotator", "plannotator.exe");
    writeText(currentExe);
    let commandCount = 0;

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        platform: "win32",
        execPath: currentExe,
        env: { LOCALAPPDATA: localAppData },
        which: () => "C:\\Windows\\powershell.exe",
        runCommand: async () => {
          commandCount += 1;
          if (commandCount === 1) {
            return {
              exitCode: 0,
              timedOut: false,
              stdout: JSON.stringify(
                `C:\\Before;${dirname(currentExe)};C:\\After;;`,
              ),
            };
          }
          return { exitCode: 124, timedOut: true, stdout: "" };
        },
        scheduleWindowsSelfDelete: async () => false,
      },
    );

    const pathLabel = `Windows user PATH entry ${dirname(currentExe)}`;
    expect(result.ok).toBe(false);
    expect(result.removed).toContain(pathLabel);
    expect(result.errors).toContain(
      `Could not restore ${dirname(currentExe)} to the Windows user PATH after self-delete scheduling failed (command timed out).`,
    );
  });

  test("restores Windows PATH when scheduling self-delete fails", async () => {
    const fixture = createFixture();
    const localAppData = join(fixture.homeDir, "AppData", "Local");
    const currentExe = join(localAppData, "plannotator", "plannotator.exe");
    writeText(currentExe);

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        platform: "win32",
        execPath: currentExe,
        env: { LOCALAPPDATA: localAppData },
        which: () => "C:\\Windows\\powershell.exe",
        scheduleWindowsSelfDelete: async () => false,
      },
    );

    const pathLabel = `Windows user PATH entry ${dirname(currentExe)}`;
    expect(result.ok).toBe(false);
    expect(existsSync(currentExe)).toBe(true);
    expect(result.removed).not.toContain(pathLabel);
    expect(result.preserved).toContain(`${pathLabel} (restored for retry)`);
    expect(fixture.commandCalls).toHaveLength(2);
    expect(fixture.commandCalls[1]?.env).toEqual({
      PLANNOTATOR_UNINSTALL_ORIGINAL_PATH:
        "C:\\Tools;C:\\Users\\fixture\\AppData\\Local\\plannotator;C:\\Windows;;",
    });
  });

  test("reports the full CLI path when Windows PATH restoration also fails", async () => {
    const fixture = createFixture();
    const localAppData = join(fixture.homeDir, "AppData", "Local");
    const currentExe = join(localAppData, "plannotator", "plannotator.exe");
    writeText(currentExe);
    let commandCount = 0;

    const result = await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      {
        ...fixture.environment,
        platform: "win32",
        execPath: currentExe,
        env: { LOCALAPPDATA: localAppData },
        which: () => "C:\\Windows\\powershell.exe",
        runCommand: async (command, args, env) => {
          fixture.commandCalls.push({ command, args, env });
          commandCount += 1;
          return {
            exitCode: commandCount === 1 ? 0 : 1,
            timedOut: false,
            stdout:
              commandCount === 1
                ? JSON.stringify(
                    `C:\\Before;${dirname(currentExe)};C:\\After;;`,
                  )
                : undefined,
          };
        },
        scheduleWindowsSelfDelete: async () => false,
      },
    );

    const pathLabel = `Windows user PATH entry ${dirname(currentExe)}`;
    expect(result.ok).toBe(false);
    expect(existsSync(currentExe)).toBe(true);
    expect(result.removed).toContain(pathLabel);
    expect(result.errors).toContain(
      `Could not restore ${dirname(currentExe)} to the Windows user PATH after self-delete scheduling failed (exit 1).`,
    );
    expect(result.warnings).toContain(
      `The Plannotator CLI remains at ${currentExe}, but its Windows PATH entry could not be restored. Run that full path to retry, then restore PATH manually if needed.`,
    );
    expect(result.warnings).not.toContain(
      "Preserved the Plannotator CLI and its Windows PATH entry so you can resolve the errors and retry uninstall.",
    );
    expect(fixture.commandCalls[1]?.env).toEqual({
      PLANNOTATOR_UNINSTALL_ORIGINAL_PATH:
        `C:\\Before;${dirname(currentExe)};C:\\After;;`,
    });
  });
});

describe("the Inbox's agent connections (inbox-agents.ts)", () => {
  const cursorFile = (fixture: Fixture) => join(fixture.homeDir, ".cursor", "mcp.json");
  const ours = { command: "/old/bin/plannotator", args: ["inbox", "mcp"] };

  function seed(fixture: Fixture): void {
    writeJson(cursorFile(fixture), { mcpServers: { mine: { command: "x" }, "plannotator-inbox": ours } });
    writeJson(join(fixture.dataDir, "inbox", "agents.json"), {
      v: 1,
      agents: { cursor: { state: "added", reach: "mcp", path: cursorFile(fixture), command: ["/old/bin/plannotator", "inbox", "mcp"], at: "2026-10-12T00:00:00.000Z" } },
    });
  }

  test("--dry-run lists the entry and changes nothing", async () => {
    const fixture = createFixture();
    seed(fixture);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: true }, fixture.environment);
    expect(result.planned).toContain(`MCP server plannotator-inbox from Cursor (${join("~", ".cursor", "mcp.json")}, that entry only)`);
    expect((readJson(cursorFile(fixture)).mcpServers as Record<string, unknown>)["plannotator-inbox"]).toEqual(ours);
  });

  test("a plain uninstall removes the entry, keeps the person's others, and forgets the record", async () => {
    const fixture = createFixture();
    seed(fixture);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.removed).toContain(`MCP server plannotator-inbox from Cursor (${join("~", ".cursor", "mcp.json")}, that entry only)`);
    expect(readJson(cursorFile(fixture)).mcpServers).toEqual({ mine: { command: "x" } });
    expect((readJson(join(fixture.dataDir, "inbox", "agents.json")).agents as Record<string, unknown>).cursor).toBeUndefined();
  });

  test("Plannotator's trusted-sender token in Qwen Code is revoked through qwen before the data goes (also with --purge); --dry-run only lists it", async () => {
    const fixture = createFixture();
    const trust = join(fixture.dataDir, "inbox", "qwen-trust.json");
    writeJson(trust, { v: 1, home: join(fixture.homeDir, ".qwen"), id: "c_0a1b2c3d", token: `qpc_${"ab".repeat(32)}`, created_at: "2026-10-27T00:00:00.000Z" });
    const describe = "Plannotator's trusted-sender token in Qwen Code (qwen sessions controllers remove c_0a1b2c3d)";
    const environment = { ...fixture.environment, which: (command: string) => (command === "qwen" ? "/fake/qwen" : null) };

    const dry = await runPlannotatorUninstall({ purge: false, dryRun: true }, environment);
    expect(dry.planned).toContain(describe);
    expect(fixture.commandCalls.filter((call) => call.command === "/fake/qwen")).toEqual([]);
    expect(existsSync(trust)).toBe(true);

    const result = await runPlannotatorUninstall({ purge: true, dryRun: false }, environment);
    expect(result.removed).toContain(describe);
    expect(fixture.commandCalls.filter((call) => call.command === "/fake/qwen").map((call) => call.args)).toEqual([["sessions", "controllers", "remove", "c_0a1b2c3d"]]);
  });

  test.skipIf(process.getuid?.() === 0)("a grant Qwen will not revoke while the data folder can't be written: the uninstall still removes the binary, and says so", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    writeText(binary);
    const inbox = join(fixture.dataDir, "inbox");
    writeJson(join(inbox, "qwen-trust.json"), { v: 1, home: join(fixture.homeDir, ".qwen"), id: "c_0a1b2c3d", token: `qpc_${"ab".repeat(32)}`, created_at: "2026-10-27T00:00:00.000Z" });
    const environment = {
      ...fixture.environment,
      which: (command: string) => (command === "qwen" ? "/fake/qwen" : null),
      runCommand: async (command: string, args: string[], env?: Record<string, string>) => {
        fixture.commandCalls.push({ command, args, env });
        return command === "/fake/qwen" ? { exitCode: 1, timedOut: false, stdout: "", stderr: "Error: could not write" } : { exitCode: 0, timedOut: false, stdout: "" };
      },
    };
    chmodSync(inbox, 0o500);
    try {
      const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, environment);
      expect(result.warnings.join("\n")).toContain("qwen sessions controllers remove c_0a1b2c3d");
      expect(existsSync(binary)).toBe(false);
    } finally {
      chmodSync(inbox, 0o700);
    }
  });

  test("an agent with one entry left (of two a move left) keeps its whole record, so the next uninstall tries again", async () => {
    const fixture = createFixture();
    const stray = join(fixture.homeDir, "elsewhere", "mcp.json");
    writeJson(stray, { mcpServers: { "plannotator-inbox": ours } });
    // Its own entry cannot go: the key is there twice, which Plannotator never cuts around (on every platform,
    // unlike a read-only folder, which Windows ignores). The other one can.
    const twice = `{\n  "mcpServers": {\n    "plannotator-inbox": ${JSON.stringify(ours)},\n    "plannotator-inbox": ${JSON.stringify(ours)}\n  }\n}\n`;
    writeText(cursorFile(fixture), twice);
    const record = {
      state: "added",
      reach: "mcp",
      path: cursorFile(fixture),
      command: ["/old/bin/plannotator", "inbox", "mcp"],
      strays: [{ path: stray, command: ["/old/bin/plannotator", "inbox", "mcp"] }],
      at: "2026-10-12T00:00:00.000Z",
    };
    writeJson(join(fixture.dataDir, "inbox", "agents.json"), { v: 1, agents: { cursor: record } });
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(readJson(stray).mcpServers).toEqual({});
    expect(readFileSync(cursorFile(fixture), "utf8")).toBe(twice);
    expect(result.warnings.some((warning) => warning.startsWith("Could not remove MCP server plannotator-inbox from Cursor"))).toBe(true);
    expect((readJson(join(fixture.dataDir, "inbox", "agents.json")).agents as Record<string, unknown>).cursor).toEqual(record);
  });

  test("the notes: only the marked section, from a file the record no longer names too", async () => {
    const fixture = createFixture();
    const note = [
      "<!-- plannotator-inbox:start v1 · added by Plannotator. Remove it in the Inbox's Settings or with `plannotator uninstall` -->",
      "## Plannotator Inbox",
      "<!-- plannotator-inbox:end -->",
    ].join("\n");
    writeText(join(fixture.homeDir, ".codex", "AGENTS.md"), `Mine.\n\n${note}\n`);
    const dry = await runPlannotatorUninstall({ purge: false, dryRun: true }, fixture.environment);
    expect(dry.planned).toContain(`Note for Codex (${join("~", ".codex", "AGENTS.md")}, marked section only; you edited it)`);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.removed).toContain(`Note for Codex (${join("~", ".codex", "AGENTS.md")}, marked section only; you edited it)`);
    expect(readFileSync(join(fixture.homeDir, ".codex", "AGENTS.md"), "utf8")).toBe("Mine.\n");
  });

  test("with no record (agents.json lost), an entry that runs this binary is named once and left, never removed, and the binary still goes", async () => {
    // A real install runs from the path it is uninstalling.
    const fixture = createFixture();
    const installed = join(fixture.homeDir, ".local", "bin", "plannotator");
    writeText(installed);
    const entry = { command: installed, args: ["inbox", "mcp"] };
    writeJson(cursorFile(fixture), { mcpServers: { "plannotator-inbox": entry } });
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, { ...fixture.environment, execPath: installed });
    expect(result.ok).toBe(true);
    expect(result.warnings.filter((warning) => warning.includes("plannotator-inbox"))).toEqual([
      `Skipped: Cursor's "plannotator-inbox" in ${join("~", ".cursor", "mcp.json")} runs this Plannotator, but no record says Plannotator added it, so it may be yours (to remove it, delete that entry by hand).`,
    ]);
    expect(readJson(cursorFile(fixture)).mcpServers).toEqual({ "plannotator-inbox": entry });
    expect(existsSync(installed)).toBe(false);
  });

  test("an entry that runs something else now is named and left", async () => {
    const fixture = createFixture();
    seed(fixture);
    writeJson(cursorFile(fixture), { mcpServers: { "plannotator-inbox": { command: "theirs" } } });
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.warnings).toContain(`Skipped: Cursor's "plannotator-inbox" now runs something else (changed by hand), so it is yours.`);
    expect(readJson(cursorFile(fixture)).mcpServers).toEqual({ "plannotator-inbox": { command: "theirs" } });
  });
});

describe("hooks that still run Plannotator keep the CLI", () => {
  test.each([
    "plannotator\nimprove-context",
    "plannotator\rimprove-context",
    "PLANNOTATOR_BROWSER=Safari plannotator",
    "PLANNOTATOR_BROWSER=\"Google Chrome\" plannotator",
    "echo preflight && plannotator --browser Safari",
    "echo preflight;plannotator",
  ])("preserves composite hook and blocks removal: %s", async (command) => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".claude", "settings.json");
    writeText(binary);
    const config = { hooks: { PreToolUse: [{ matcher: "EnterPlanMode", hooks: [{ type: "command", command }] }] } };
    writeJson(file, config);
    for (const dryRun of [true, false]) {
      const result = await runPlannotatorUninstall({ purge: false, dryRun }, fixture.environment);
      expect(result.ok).toBe(false);
      expect(existsSync(binary)).toBe(true);
      expect(readJson(file)).toEqual(config);
      expect(result.errors.join("\n")).toContain(file);
      expect(result.errors.join("\n")).toContain("hooks.PreToolUse[0].hooks[0].command");
      expect(result.planned).not.toContain(binary);
    }
  });

  test.each([
    "echo plannotator",
    "echo 'preflight && plannotator'",
    'echo "preflight; plannotator"',
    "echo preflight # plannotator; plannotator",
  ])("does not claim a command that only mentions Plannotator: %s", async (command) => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".claude", "settings.json");
    writeText(binary);
    const config = { hooks: { PermissionRequest: [{ matcher: "ExitPlanMode", hooks: [{ type: "command", command }] }] } };
    writeJson(file, config);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(readJson(file)).toEqual(config);
  });

  test.each(["plannotator review", "plannotator --custom-option"])("dry-run reports preserved hook blocker: %s", async (command) => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".gemini", "settings.json");
    writeText(binary);
    writeJson(file, { hooks: { BeforeTool: [{ matcher: "exit_plan_mode", hooks: [
      { type: "command", command: "plannotator --browser Safari" },
      { type: "command", command },
    ] }] } });
    const before = snapshotTree(fixture.homeDir);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: true }, fixture.environment);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(file);
    expect(result.errors.join("\n")).toContain("hooks.BeforeTool[0].hooks[1].command");
    expect(result.planned).not.toContain(binary);
    expect(snapshotTree(fixture.homeDir)).toEqual(before);
  });

  test("dry-run reports original entry indices after other matcher entries are removed", async () => {
    const fixture = createFixture();
    const file = join(fixture.homeDir, ".claude", "settings.json");
    const config = { hooks: { PreToolUse: [
      { matcher: "EnterPlanMode", hooks: [{ type: "command", command: "plannotator improve-context" }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "plannotator review" }] },
    ] } };
    writeJson(file, config);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: true }, fixture.environment);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("hooks.PreToolUse[1].hooks[0].command");
    expect(readJson(file)).toEqual(config);
  });

  test("Vibe dry-run reports original index of a surviving hook beside the managed block", async () => {
    const fixture = createFixture();
    const file = join(fixture.homeDir, ".vibe", "hooks.toml");
    const content = '# >>> plannotator-managed-vibe-hooks\n[[hooks]]\ncommand = "plannotator"\n# <<< plannotator-managed-vibe-hooks\n[[hooks]]\ncommand = "plannotator review"\n';
    writeText(file, content);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: true }, fixture.environment);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("hooks[1].command");
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  test("two surviving hooks in one file are one error naming both", async () => {
    const fixture = createFixture();
    const file = join(fixture.homeDir, ".claude", "settings.json");
    writeJson(file, { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [
      { type: "command", command: "plannotator review" },
      { type: "command", command: "plannotator annotate" },
    ] }] } });
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    const about = result.errors.filter((error) => error.includes(file));
    expect(about).toHaveLength(1);
    expect(about[0]).toContain("hooks.PreToolUse[0].hooks[0].command, hooks.PreToolUse[0].hooks[1].command");
  });

  // install.sh writes the Codex hook as `"command": "${PLANNOTATOR_BIN}"`: unquoted, spaces and all.
  test("an unquoted install path with spaces is still Plannotator's own hook", async () => {
    const fixture = createFixture();
    const homeDir = join(fixture.root, "my home");
    const binary = join(homeDir, ".local", "bin", "plannotator");
    const file = join(homeDir, ".codex", "hooks.json");
    writeText(binary);
    writeJson(file, { hooks: { Stop: [{ hooks: [{ type: "command", command: binary }] }] } });
    const environment = { ...fixture.environment, homeDir };

    const dry = await runPlannotatorUninstall({ purge: false, dryRun: true }, environment);
    expect(dry.ok).toBe(true);
    expect(dry.planned).toContain(`managed Codex Stop hook in ${file}`);

    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, environment);
    expect(result.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(binary)).toBe(false);
  });

  // One run names every blocker, so fixing one never uncovers the next.
  test("a real run names a surviving hook beside another blocker, in the same run", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const cursor = join(fixture.homeDir, ".cursor", "mcp.json");
    const settings = join(fixture.homeDir, ".claude", "settings.json");
    writeText(binary);
    writeText(cursor, "{broken");
    writeJson(settings, { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "plannotator annotate-last" }] }] } });
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.ok).toBe(false);
    expect(existsSync(binary)).toBe(true);
    expect(result.errors).toEqual([
      `Could not read Cursor's ${cursor}: it is not plain JSON. Plannotator did not change it. To continue, fix that (or put back a working copy of the file), then run \`plannotator uninstall\` again.`,
      `Claude Code's ${settings} still runs Plannotator at hooks.PreToolUse[0].hooks[0].command. Plannotator removes only the hooks it installs exactly as it wrote them, so it did not change this one. To continue, remove only that hook (keep the rest of the file), then run \`plannotator uninstall\` again.`,
    ]);
  });

  // The failed write is the error; the check after it does not also call that hook one Plannotator did not install.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a settings.json uninstall could not rewrite is one error, not also a surviving-hook one", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const settings = join(fixture.homeDir, ".claude", "settings.json");
    writeText(binary);
    writeJson(settings, { hooks: { PermissionRequest: [{ matcher: "ExitPlanMode", hooks: [{ type: "command", command: "plannotator" }] }] } });
    chmodSync(settings, 0o444);
    try {
      const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
      expect(result.ok).toBe(false);
      expect(existsSync(binary)).toBe(true);
      const about = result.errors.filter((error) => error.includes(settings));
      expect(about).toHaveLength(1);
      expect(about[0]).toStartWith(`Could not update ${settings}:`);
    } finally { chmodSync(settings, 0o644); }
  });
});

describe("host plugin managers", () => {
  // Copilot CLI 1.0.68 refuses `copilot plugins remove … --plugin`.
  test("without copilot on PATH, the command to run is one Copilot CLI accepts", async () => {
    const fixture = createFixture();
    writeJson(join(fixture.homeDir, ".copilot", "settings.json"), { enabledPlugins: { "plannotator-copilot@plannotator": true } });
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("run `copilot plugin uninstall plannotator-copilot@plannotator`");
  });

  test("rejects a successful host cleanup whose formerly detected config is now malformed", async () => {
    const fixture = createFixture({ which: () => "/fake/droid" });
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".factory", "settings.json");
    writeText(binary);
    writeJson(file, { enabledPlugins: { "plannotator@plannotator": true } });
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, {
      ...fixture.environment,
      runCommand: async () => {
        writeText(file, "{broken");
        return { exitCode: 0, timedOut: false };
      },
    });
    expect(result.ok).toBe(false);
    expect(existsSync(binary)).toBe(true);
    expect(result.errors).toEqual([
      `Could not read Droid's ${file}: it is not valid JSON. Plannotator did not change it. To continue, fix that (or put back a working copy of the file), then run \`plannotator uninstall\` again.`,
    ]);
    expect(readFileSync(file, "utf8")).toBe("{broken");
  });

  test("accepts VS Code removal when registration is gone but directory remains", async () => {
    const fixture = createFixture({ which: (name) => name === "code" ? "/fake/code" : null });
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const directory = join(fixture.homeDir, ".vscode", "extensions", "backnotprop.plannotator-webview-0.1.0");
    const registry = join(fixture.homeDir, ".vscode", "extensions", "extensions.json");
    writeText(binary);
    writeText(join(directory, "package.json"));
    writeJson(registry, [{ identifier: { id: "backnotprop.plannotator-webview" }, version: "0.1.0" }]);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, {
      ...fixture.environment,
      runCommand: async () => {
        writeJson(registry, []);
        return { exitCode: 0, timedOut: false };
      },
    });
    expect(result.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(existsSync(directory)).toBe(true);
    const remainingRegistry: unknown = JSON.parse(readFileSync(registry, "utf8"));
    expect(remainingRegistry).toEqual([]);
  });

  test.each(["registry", "obsolete"])("does not invoke VS Code for unregistered leftovers: %s", async (kind) => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const parent = join(fixture.homeDir, ".vscode", "extensions");
    const name = "backnotprop.plannotator-webview-0.1.0";
    writeText(binary);
    writeText(join(parent, name, "package.json"));
    if (kind === "registry") writeJson(join(parent, "extensions.json"), []);
    else writeJson(join(parent, ".obsolete"), { [name]: true });
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.ok).toBe(true);
    expect(fixture.commandCalls).toEqual([]);
    expect(existsSync(binary)).toBe(false);
    expect(existsSync(join(parent, name))).toBe(true);
  });

  test("dry-run reports missing Droid CLI with exact recovery entries", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".factory", "settings.json");
    writeText(binary); writeJson(file, { enabledPlugins: { "plannotator@plannotator": true } });
    const before = snapshotTree(fixture.homeDir);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: true }, fixture.environment);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("restore droid on PATH");
    expect(result.errors.join("\n")).toContain(file);
    expect(result.errors.join("\n")).toContain('enabledPlugins["plannotator@plannotator"]');
    expect(result.planned).not.toContain(binary);
    expect(snapshotTree(fixture.homeDir)).toEqual(before);
  });

  // `--scope user` removes only the user's install; a project's stays in installed_plugins.json.
  test.each([
    { host: "claude", dir: ".claude" },
    { host: "droid", dir: ".factory" },
  ])("$host: a project-scope install that survives the user-scope uninstall is named, and the CLI still goes", async ({ host, dir }) => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const record = join(fixture.homeDir, dir, "plugins", "installed_plugins.json");
    const project = { scope: "project", projectPath: "/work/app", installPath: "/cache/plannotator" };
    writeText(binary);
    writeJson(record, { version: 2, plugins: { "plannotator@plannotator": [{ scope: "user", installPath: "/cache/plannotator" }, project] } });
    const environment = {
      ...fixture.environment,
      which: (command: string) => (command === host ? `/fake/${host}` : null),
      runCommand: async (command: string, args: string[]) => {
        fixture.commandCalls.push({ command, args });
        // As the host does: only the user-scope entry goes.
        writeJson(record, { version: 2, plugins: { "plannotator@plannotator": [project] } });
        return { exitCode: 0, timedOut: false };
      },
    };

    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, environment);
    expect(result.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(fixture.commandCalls).toHaveLength(1);
    const named = result.warnings.filter((warning) => warning.includes("project scope"));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain(`\`${host} plugin uninstall plannotator@plannotator --scope project\` in /work/app`);

    // A retry with only the project's install left never asks the host to remove a user install that is gone.
    writeText(binary);
    const retry = await runPlannotatorUninstall({ purge: false, dryRun: false }, environment);
    expect(retry.ok).toBe(true);
    expect(fixture.commandCalls).toHaveLength(1);
    expect(existsSync(binary)).toBe(false);
  });

  // Claude Code installs (or rescopes) the plugin for the user from that key at its next start, so it keeps the CLI.
  test("a user enabledPlugins key the host refuses to uninstall keeps the CLI, and names the key to remove by hand", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const settings = join(fixture.homeDir, ".claude", "settings.json");
    writeText(binary);
    writeJson(settings, { enabledPlugins: { "plannotator@plannotator": true } });
    writeJson(join(fixture.homeDir, ".claude", "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { "plannotator@plannotator": [{ scope: "project", projectPath: "/work/app", installPath: "/cache/plannotator" }] },
    });
    const environment = {
      ...fixture.environment,
      which: (command: string) => (command === "claude" ? "/fake/claude" : null),
      runCommand: async (command: string, args: string[]) => {
        fixture.commandCalls.push({ command, args });
        return { exitCode: 1, timedOut: false };
      },
    };
    const blocked = await runPlannotatorUninstall({ purge: false, dryRun: false }, environment);
    expect(blocked.ok).toBe(false);
    expect(fixture.commandCalls).toHaveLength(1);
    expect(existsSync(binary)).toBe(true);
    expect(blocked.errors.join("\n")).toContain(`remove only these Plannotator entries by hand: ${settings}, enabledPlugins["plannotator@plannotator"]`);

    writeJson(settings, { enabledPlugins: {} });
    const retry = await runPlannotatorUninstall({ purge: false, dryRun: false }, environment);
    expect(retry.ok).toBe(true);
    expect(fixture.commandCalls).toHaveLength(1);
    expect(existsSync(binary)).toBe(false);
  });

  test("a user-scope entry still there after the host reported success keeps the CLI, and says what to remove", async () => {
    const fixture = createFixture({ which: (command) => (command === "claude" ? "/fake/claude" : null) });
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const record = join(fixture.homeDir, ".claude", "plugins", "installed_plugins.json");
    writeText(binary);
    writeJson(record, { version: 2, plugins: { "plannotator@plannotator": [{ scope: "user", installPath: "/cache/plannotator" }] } });
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.ok).toBe(false);
    expect(existsSync(binary)).toBe(true);
    expect(result.errors.join("\n")).toContain(`${record}, plugins["plannotator@plannotator"][0]`);
  });
});

describe("plannotator-inbox entries no record says Plannotator added", () => {
  test.each([true, false])("one that runs the installed CLI is named with how to remove it, and never keeps the CLI, dryRun=%s", async (dryRun) => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".cursor", "mcp.json");
    const entry = { command: binary, args: ["inbox", "mcp"] };
    const config = { mcpServers: { "plannotator-inbox": entry, mine: { command: "user-server" } } };
    writeText(binary);
    writeJson(file, config);
    const result = await runPlannotatorUninstall({ purge: false, dryRun }, fixture.environment);
    expect(result.ok).toBe(true);
    expect(result.warnings.filter((warning) => warning.includes("plannotator-inbox"))).toEqual([
      `Skipped: Cursor's "plannotator-inbox" in ${join("~", ".cursor", "mcp.json")} runs Plannotator and will fail to start once it is gone, but uninstall could not tell that Plannotator added it, so it is left (to remove it, delete that entry by hand).`,
    ]);
    expect(existsSync(binary)).toBe(dryRun);
    expect(readJson(file)).toEqual(config);
  });

  test.each([false, true])("Claude Code's in ~/.claude.json points to `claude mcp remove`, config override=%s", async (override) => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const directory = override ? join(fixture.root, "claude-custom") : fixture.homeDir;
    const file = join(directory, ".claude.json");
    const config = { mcpServers: { "plannotator-inbox": { command: binary, args: ["inbox", "mcp"] } }, projects: { mine: {} } };
    writeText(binary); writeJson(file, config);
    const environment = { ...fixture.environment, env: override ? { CLAUDE_CONFIG_DIR: directory } : {} };
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, environment);
    expect(result.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    const named = result.warnings.filter((warning) => warning.includes("plannotator-inbox"));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("Claude Code's");
    expect(named[0]).toContain("run `claude mcp remove plannotator-inbox -s user`");
    expect(readJson(file)).toEqual(config);
  });

  test("source-run uninstall does not claim a user-owned Bun MCP entry", async () => {
    const fixture = createFixture({ execPath: process.execPath });
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".cursor", "mcp.json");
    const config = { mcpServers: { "plannotator-inbox": { command: process.execPath, args: ["unrelated-server.ts"] } } };
    writeText(binary); writeJson(file, config);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.ok).toBe(true); expect(existsSync(binary)).toBe(false);
    expect(result.warnings.filter((warning) => warning.includes("plannotator-inbox"))).toEqual([]);
    expect(readJson(file)).toEqual(config);
  });

  // Cursor writes strict JSON, but a person may add a comment or leave a trailing comma; this check only reads.
  test.each([false, true])("a Cursor mcp.json with a comment and a trailing comma never keeps the CLI, with the entry=%s", async (withEntry) => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".cursor", "mcp.json");
    const entry = withEntry ? `\n    "plannotator-inbox": { "command": ${JSON.stringify(binary)}, "args": ["inbox", "mcp"] },` : "";
    const content = `{\n  // mine\n  "mcpServers": {${entry}\n    "mine": { "command": "user-server" },\n  },\n}\n`;
    writeText(binary);
    writeText(file, content);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(result.warnings.filter((warning) => warning.includes("plannotator-inbox"))).toEqual(withEntry ? [
      `Skipped: Cursor's "plannotator-inbox" in ${join("~", ".cursor", "mcp.json")} runs Plannotator and will fail to start once it is gone, but uninstall could not tell that Plannotator added it, so it is left (to remove it, delete that entry by hand).`,
    ] : []);
    expect(readFileSync(file, "utf8")).toBe(content);
  });
});

describe("configs uninstall cannot read keep the CLI", () => {
  test("a malformed Claude Code settings.json is reported once, with what to do", async () => {
    const fixture = createFixture({ which: () => "/fake/claude" });
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".claude", "settings.json");
    writeText(binary);
    writeText(file, '{ "enabledPlugins": ');
    for (const dryRun of [true, false]) {
      const result = await runPlannotatorUninstall({ purge: false, dryRun }, fixture.environment);
      expect(result.ok).toBe(false);
      expect(result.errors.filter((error) => error.includes(file))).toEqual([
        `Could not read Claude Code's ${file}: it is not valid JSON. Plannotator did not change it. To continue, fix that (or put back a working copy of the file), then run \`plannotator uninstall\` again.`,
      ]);
      expect(fixture.commandCalls).toEqual([]);
      expect(existsSync(binary)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe('{ "enabledPlugins": ');
    }
  });

  test("an agent's MCP config that cannot be read is named with its tool, and a fixed one lets the CLI go", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".cursor", "mcp.json");
    writeText(binary);
    writeText(file, "{ mcpServers: {} }");
    const blocked = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(blocked.ok).toBe(false);
    expect(existsSync(binary)).toBe(true);
    expect(blocked.errors).toEqual([
      `Could not read Cursor's ${file}: it is not plain JSON. Plannotator did not change it. To continue, fix that (or put back a working copy of the file), then run \`plannotator uninstall\` again.`,
    ]);
    writeJson(file, { mcpServers: {} });
    const retry = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(retry.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
  });

  // The Inbox reads at most 32 MiB of it; uninstall searches it first, then parses one that has the name, so its size never blocks.
  test("~/.claude.json over the Inbox's size cap is still checked, and never keeps the CLI for its size", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".claude.json");
    writeText(binary);
    const history = "x".repeat(33 * 1024 * 1024);
    writeText(file, JSON.stringify({ projects: { "/work": { history } } }));
    const none = await runPlannotatorUninstall({ purge: false, dryRun: true }, fixture.environment);
    expect(none.ok).toBe(true);
    expect(none.errors).toEqual([]);

    writeText(file, JSON.stringify({ mcpServers: { "plannotator-inbox": { command: binary, args: ["inbox", "mcp"] } }, projects: { "/work": { history } } }));
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(result.warnings.filter((warning) => warning.includes("plannotator-inbox"))).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain("run `claude mcp remove plannotator-inbox -s user`");
  });

  test("another agent's file over the Inbox's 1 MiB cap is read and checked like any other", async () => {
    const fixture = createFixture();
    const file = join(fixture.homeDir, ".cursor", "mcp.json");
    writeText(file, JSON.stringify({ mcpServers: { "plannotator-inbox": { command: "plannotator", args: ["inbox", "mcp"] } }, pad: "x".repeat(1024 * 1024) }));
    const result = await runPlannotatorUninstall({ purge: false, dryRun: true }, fixture.environment);
    expect(result.ok).toBe(true);
    expect(result.warnings.filter((warning) => warning.includes("plannotator-inbox"))).toEqual([
      `Skipped: Cursor's "plannotator-inbox" in ${join("~", ".cursor", "mcp.json")} runs Plannotator and will fail to start once it is gone, but uninstall could not tell that Plannotator added it, so it is left (to remove it, delete that entry by hand).`,
    ]);
  });

  // Over 1 MiB, the raw bytes are searched first: a file without the name is never decoded or parsed.
  test("a big agent file without \"plannotator-inbox\" is not parsed, so it never keeps the CLI", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    writeText(binary);
    const claude = join(fixture.homeDir, ".claude.json");
    const cursor = join(fixture.homeDir, ".cursor", "mcp.json");
    mkdirSync(dirname(cursor), { recursive: true });
    writeFileSync(claude, Buffer.alloc(2 * 1024 * 1024, 0xff));
    writeFileSync(cursor, `{ "pad": "${"x".repeat(2 * 1024 * 1024)}", broken`);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
  });

  // The search reads a chunk at a time; a name split across two chunks is still found.
  test("a big file whose entry straddles the search's 1 MiB chunks is still named", async () => {
    const fixture = createFixture();
    const file = join(fixture.homeDir, ".cursor", "mcp.json");
    const head = '{"pad":"';
    const middle = '","mcpServers":{"';
    const pad = "x".repeat(1024 * 1024 + 8 - head.length - middle.length);
    writeText(file, `${head}${pad}${middle}plannotator-inbox":{"command":"plannotator","args":["inbox","mcp"]}}}`);
    expect(readFileSync(file, "utf8").indexOf("plannotator-inbox")).toBe(1024 * 1024 + 8);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: true }, fixture.environment);
    expect(result.ok).toBe(true);
    expect(result.warnings.filter((warning) => warning.includes("plannotator-inbox"))).toHaveLength(1);
  });

  test("an agent file over 64 MiB that has \"plannotator-inbox\" is not read, is named, and never keeps the CLI", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".claude.json");
    writeText(binary);
    writeText(file, '{"mcpServers":{"plannotator-inbox":{"command":"plannotator","args":["inbox","mcp"]}}}');
    truncateSync(file, 65 * 1024 * 1024);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(existsSync(binary)).toBe(false);
    expect(result.warnings.filter((warning) => warning.includes("plannotator-inbox"))).toEqual([
      `Skipped: Claude Code's ${join("~", ".claude.json")} has the text "plannotator-inbox" but is larger than 64 MiB, so uninstall did not read it. If it has a "plannotator-inbox" entry that runs Plannotator, that entry will fail to start once Plannotator is gone (to remove it, run \`claude mcp remove plannotator-inbox -s user\`).`,
    ]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([
    ["Codex", [".codex", "config.toml"], "[features]\nhooks = true\n"],
    ["Codex", [".codex", "hooks.json"], "{}"],
    ["OpenCode", [".config", "opencode", "opencode.json"], "{}"],
    ["Gemini CLI", [".gemini", "settings.json"], "{}"],
  ] as const)("%s's %j it cannot read names the file, the tool and what to do", async (owner, parts, content) => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ...parts);
    writeText(binary);
    writeText(file, content);
    chmodSync(file, 0o000);
    try {
      for (const dryRun of [true, false]) {
        const result = await runPlannotatorUninstall({ purge: false, dryRun }, fixture.environment);
        expect(result.ok).toBe(false);
        expect(existsSync(binary)).toBe(true);
        expect(result.errors).toEqual([
          `Could not read ${owner}'s ${file}: permission denied. Plannotator did not change it. To continue, fix that (or put back a working copy of the file), then run \`plannotator uninstall\` again.`,
        ]);
      }
    } finally { chmodSync(file, 0o644); }
  });

  test("a real run leaves a Vibe hooks.toml it cannot parse exactly as it was, managed block included", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const file = join(fixture.homeDir, ".vibe", "hooks.toml");
    const content = '[[hooks]]\nname = "mine"\ncommand = "unterminated\n# >>> plannotator-managed-vibe-hooks\n[[hooks]]\ncommand = "plannotator"\n# <<< plannotator-managed-vibe-hooks\n';
    writeText(binary);
    writeText(file, content);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);
    expect(result.ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(result.removed.some((item) => item.includes(file))).toBe(false);
    expect(result.errors.filter((error) => error.includes(file))).toHaveLength(1);
    expect(existsSync(binary)).toBe(true);
  });

  test("a Vibe hooks.toml that is not valid TOML says what is wrong", async () => {
    const fixture = createFixture();
    const file = join(fixture.homeDir, ".vibe", "hooks.toml");
    const content = '[[hooks]]\nname = "mine"\ncommand = "unterminated\n';
    writeText(file, content);
    const result = await runPlannotatorUninstall({ purge: false, dryRun: true }, fixture.environment);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toStartWith(`Could not read Mistral Vibe's ${file}: it is not valid TOML (Unterminated string`);
    expect(result.errors[0]).toContain("Plannotator did not change it. To continue, fix that");
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("inaccessible hook target blocks removal instead of appearing missing", async () => {
    const fixture = createFixture();
    const binary = join(fixture.homeDir, ".local", "bin", "plannotator");
    const targetDirectory = join(fixture.root, "inaccessible");
    const target = join(targetDirectory, "hooks.toml");
    const file = join(fixture.homeDir, ".vibe", "hooks.toml");
    writeText(binary); writeText(target, '[[hooks]]\ncommand = "plannotator"\n');
    mkdirSync(dirname(file), { recursive: true }); symlinkSync(target, file);
    chmodSync(targetDirectory, 0o000);
    try {
      expect(existsSync(file)).toBe(false);
      for (const dryRun of [true, false]) {
        const result = await runPlannotatorUninstall({ purge: false, dryRun }, fixture.environment);
        expect(result.ok).toBe(false);
        expect(existsSync(binary)).toBe(true);
        expect(result.errors).toEqual([
          `Could not read Mistral Vibe's ${file}: permission denied. Plannotator did not change it. To continue, fix that (or put back a working copy of the file), then run \`plannotator uninstall\` again.`,
        ]);
        expect(result.planned).not.toContain(binary);
      }
    } finally { chmodSync(targetDirectory, 0o755); }
  });
});

describe("Qwen Code", () => {
  function writeQwenInstall(qwenDir: string): void {
    writeJson(join(qwenDir, "extensions", "plannotator", "qwen-extension.json"), { name: "plannotator", version: "1.0.0" });
    for (const skill of ["plannotator-review", "plannotator-annotate", "plannotator-last"]) {
      writeText(join(qwenDir, "skills", skill, "SKILL.md"));
    }
    writeText(join(qwenDir, "skills", "my-own-skill", "SKILL.md"));
  }

  /** qwen on PATH; like the real `qwen extensions uninstall`, it removes the extension's folder. */
  function withQwen(fixture: Fixture, qwenDir: string): UninstallEnvironment {
    return {
      ...fixture.environment,
      which: (command) => (command === "qwen" ? "/fake/qwen" : null),
      runCommand: async (command, args, env) => {
        fixture.commandCalls.push({ command, args, env });
        if (command === "/fake/qwen") rmSync(join(qwenDir, "extensions", "plannotator"), { recursive: true, force: true });
        return { exitCode: 0, timedOut: false };
      },
    };
  }

  test("removes the extension with qwen and the installed skills, and keeps the person's own skill", async () => {
    const fixture = createFixture();
    const qwenDir = join(fixture.homeDir, ".qwen");
    writeQwenInstall(qwenDir);

    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, withQwen(fixture, qwenDir));

    expect(fixture.commandCalls.map((call) => [call.command, ...call.args])).toEqual([
      ["/fake/qwen", "extensions", "uninstall", "plannotator"],
    ]);
    expect(result.removed).toContain("Qwen Code extension plannotator");
    for (const skill of ["plannotator-review", "plannotator-annotate", "plannotator-last"]) {
      expect(existsSync(join(qwenDir, "skills", skill))).toBe(false);
    }
    expect(existsSync(join(qwenDir, "skills", "my-own-skill", "SKILL.md"))).toBe(true);
  });

  test("removes the extension source the installers keep in the data folder", async () => {
    const fixture = createFixture();
    writeQwenInstall(join(fixture.homeDir, ".qwen"));
    writeJson(join(fixture.dataDir, "qwen-code", "extension", "qwen-extension.json"), { name: "plannotator", version: "1.0.0" });
    writeText(join(fixture.dataDir, "config.json"));

    await runPlannotatorUninstall({ purge: false, dryRun: false }, withQwen(fixture, join(fixture.homeDir, ".qwen")));

    expect(existsSync(join(fixture.dataDir, "qwen-code"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "config.json"))).toBe(true);
  });

  test("QWEN_HOME with a leading ~ is the Qwen folder", async () => {
    const fixture = createFixture();
    const qwenDir = join(fixture.homeDir, "qwen-home");
    writeQwenInstall(qwenDir);

    await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      { ...withQwen(fixture, qwenDir), env: { QWEN_HOME: "~/qwen-home" } },
    );

    expect(fixture.commandCalls.map((call) => call.args)).toEqual([["extensions", "uninstall", "plannotator"]]);
    expect(existsSync(join(qwenDir, "skills", "plannotator-last"))).toBe(false);
  });

  test("without the qwen command, the extension is reported with the command to run", async () => {
    const fixture = createFixture();
    writeQwenInstall(join(fixture.homeDir, ".qwen"));

    const result = await runPlannotatorUninstall({ purge: false, dryRun: false }, fixture.environment);

    expect(fixture.commandCalls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("run `qwen extensions uninstall plannotator`");
  });

  test("no extension installed: qwen is never run", async () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.homeDir, ".qwen"), { recursive: true });

    await runPlannotatorUninstall(
      { purge: false, dryRun: false },
      { ...fixture.environment, which: (command) => `/fake/${command}` },
    );

    expect(fixture.commandCalls.filter((call) => call.command === "/fake/qwen")).toEqual([]);
  });
});
