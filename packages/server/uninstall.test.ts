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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
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

describe("default uninstall", () => {
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
      join(dataDir, "vendor", "call-flow", "calldiff-0.4.1", "package.json"),
    );
    writeText(join(dataDir, "vendor", "other-tool", "keep.txt"));
    writeText(join(dataDir, "install-prefs"), "full\n");
    writeText(join(dataDir, "migrations", "legacy"));

    for (const skill of [
      "plannotator-review",
      "plannotator-annotate",
      "plannotator-last",
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
    writeText(openCodePackageCache);
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
    expect(existsSync(customStaleLayoutEntry)).toBe(true);
    expect(existsSync(openCodePackageCache)).toBe(false);
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
    expect(existsSync(binary)).toBe(true);
    expect(fixture.commandCalls).toEqual([]);
    expect(snapshotTree(fixture.root)).toEqual(before);
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
      [
        "plugins",
        "remove",
        "plannotator-copilot@plannotator",
        "--plugin",
      ],
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
