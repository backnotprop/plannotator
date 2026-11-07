/**
 * Every copy of the data-dir rule picks the same folder (#2305).
 *
 * The failure this catches: the rule lives in packages/shared/data-dir.ts and
 * is copied into the Claude Code mod (a hooks module imports only its own
 * files), the one-file Amp plugin and the three install scripts. If one copy
 * drifts, that host reads or writes a different folder than the binary, for
 * example the mod hands the Inbox a stray ~/.plannotator while the CLI uses
 * $XDG_DATA_HOME/plannotator. The shared resolver, the mod, the Amp plugin,
 * install.sh's block and (where pwsh is installed) install.ps1's block run
 * here against the same folders. install.cmd's block runs on Windows only
 * (windows.yml, scripts/check-data-dir-windows.ps1), so here only its marker
 * list is checked.
 *
 * Each scenario gets its own temp home; nothing outside it is touched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DATA_DIR_MARKERS, getDefaultPlannotatorDataDir } from "../packages/shared/data-dir";
import { DATA_DIR_MARKERS as MOD_MARKERS, resolveDataDir } from "../apps/hook/hooks/mod/launch";

const REPO = resolve(import.meta.dir, "..");
const AMP_PLUGIN = join(REPO, "apps", "amp-plugin", "plannotator.ts");
const root = mkdtempSync(join(tmpdir(), "plannotator-data-dir-mirrors-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Layout = { legacy?: string[]; xdg?: string[]; xdgVar?: "set" | "padded" | "relative" | "unset" };
type Expected = "legacy" | "xdg";

let counter = 0;
/** A fresh home holding the layout: each entry is a path inside the folder ("" makes just the folder). */
function makeHome(layout: Layout): { home: string; xdgDataHome: string | undefined; xdgBase: string } {
  const home = join(root, `h${counter++}`);
  mkdirSync(home);
  const xdgBase = join(home, "xdg-data");
  const place = (dir: string, entries: string[] | undefined) => {
    if (!entries) return;
    mkdirSync(dir, { recursive: true });
    for (const entry of entries) {
      if (!entry) continue;
      const path = join(dir, entry);
      if (entry.endsWith(".json") || entry.endsWith(".txt") || entry.endsWith(".html")) {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "{}");
      } else mkdirSync(path, { recursive: true });
    }
  };
  place(join(home, ".plannotator"), layout.legacy);
  place(join(xdgBase, "plannotator"), layout.xdg);
  const xdgVar = layout.xdgVar ?? "set";
  const xdgDataHome =
    xdgVar === "set"
      ? xdgBase
      : xdgVar === "padded"
        ? ` \t${xdgBase}  `
        : xdgVar === "relative"
          ? "relative/xdg-data"
          : undefined;
  return { home, xdgDataHome, xdgBase };
}

const STRAY = ["hooks/compound/enterplanmode-improve-hook.txt", "plans/compound-planning-report.html", "config.json"];

const SCENARIOS: Array<{ name: string; layout: Layout; expected: Expected }> = [
  { name: "nothing exists, XDG unset", layout: { xdgVar: "unset" }, expected: "legacy" },
  { name: "nothing exists, XDG set", layout: {}, expected: "xdg" },
  { name: "only ~/.plannotator", layout: { legacy: ["history"] }, expected: "legacy" },
  { name: "only the XDG folder", layout: { xdg: ["history"] }, expected: "xdg" },
  { name: "XDG_DATA_HOME padded with whitespace", layout: { xdg: ["history"], xdgVar: "padded" }, expected: "xdg" },
  { name: "empty ~/.plannotator, XDG folder with no data", layout: { legacy: [""], xdg: ["hooks"] }, expected: "legacy" },
  { name: "stray ~/.plannotator, XDG folder with data", layout: { legacy: STRAY, xdg: ["history", "plans"] }, expected: "xdg" },
  { name: "stray ~/.plannotator, XDG_DATA_HOME padded", layout: { legacy: STRAY, xdg: ["history"], xdgVar: "padded" }, expected: "xdg" },
  { name: "both hold data", layout: { legacy: ["history"], xdg: ["history"] }, expected: "legacy" },
  { name: "~/.plannotator with data, XDG folder missing", layout: { legacy: ["history"] }, expected: "legacy" },
  { name: "relative XDG_DATA_HOME", layout: { legacy: [""], xdg: ["history"], xdgVar: "relative" }, expected: "legacy" },
  // Each marker alone counts, on either side, so no copy may leave one out.
  ...DATA_DIR_MARKERS.map((marker) => ({
    name: `XDG folder holds only ${marker}, ~/.plannotator is stray`,
    layout: { legacy: STRAY, xdg: [marker] },
    expected: "xdg" as const,
  })),
  ...DATA_DIR_MARKERS.map((marker) => ({
    name: `~/.plannotator holds only ${marker}, XDG folder holds data`,
    layout: { legacy: [marker], xdg: ["sessions", "history"] },
    expected: "legacy" as const,
  })),
];

function expectedPath(home: string, xdgBase: string, expected: Expected): string {
  return expected === "legacy" ? join(home, ".plannotator") : join(xdgBase, "plannotator");
}

function withXdg<T>(xdgDataHome: string | undefined, fn: () => T): T {
  const saved = process.env.XDG_DATA_HOME;
  try {
    if (xdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = xdgDataHome;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
  }
}

function childEnv(home: string, xdgDataHome: string | undefined): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    ...(xdgDataHome === undefined ? {} : { XDG_DATA_HOME: xdgDataHome }),
  };
}

function resolverBlock(path: string): string {
  const script = readFileSync(path, "utf8");
  const match = script.match(/# BEGIN data-dir resolution[^\n]*\n([\s\S]*?)# END data-dir resolution/);
  if (!match) throw new Error(`${path} lost its data-dir resolution markers`);
  return match[1];
}
const installShBlock = resolverBlock(join(REPO, "scripts", "install.sh"));
const installPs1Block = resolverBlock(join(REPO, "scripts", "install.ps1"));

// install.ps1's block runs under pwsh where it is installed (CI's Linux
// runners have it). The Windows workflow runs it, and install.cmd's block, on
// Windows as well (scripts/check-data-dir-windows.ps1).
const PWSH = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0;

describe("every copy of the data-dir rule picks the same folder", () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      const { home, xdgDataHome, xdgBase } = makeHome(scenario.layout);
      const want = expectedPath(home, xdgBase, scenario.expected);

      expect(withXdg(xdgDataHome, () => getDefaultPlannotatorDataDir(home))).toBe(want);

      const mod = await resolveDataDir({ home, xdgDataHome }, async (path) => existsSync(path));
      expect(mod).toBe(want);

      const amp = Bun.spawnSync({
        cmd: [process.execPath, "-e", `const m = await import(${JSON.stringify(AMP_PLUGIN)}); console.log(m.getPlannotatorDataDir());`],
        env: childEnv(home, xdgDataHome),
      });
      expect(amp.stderr.toString()).toBe("");
      expect(amp.stdout.toString().trim()).toBe(want);

      const sh = Bun.spawnSync({
        cmd: ["/bin/sh", "-c", `${installShBlock}\nprintf '%s' "$_config_dir"`],
        env: childEnv(home, xdgDataHome),
      });
      expect(sh.stdout.toString()).toBe(want);

      if (PWSH) {
        const ps1 = Bun.spawnSync({
          cmd: ["pwsh", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = "Stop"\n${installPs1Block}\nWrite-Output $configDir`],
          env: childEnv(home, xdgDataHome),
        });
        expect(ps1.stderr.toString()).toBe("");
        expect(ps1.stdout.toString().trim()).toBe(want);
      }
    }, 20_000);
  }

  // The Windows workflow's checker only runs on a ci:full PR; a syntax error
  // in it would first show there. Parsing it where pwsh exists finds it now.
  test.skipIf(!PWSH)("scripts/check-data-dir-windows.ps1 parses in PowerShell", () => {
    const script = join(REPO, "scripts", "check-data-dir-windows.ps1");
    const parsed = Bun.spawnSync({
      cmd: [
        "pwsh", "-NoProfile", "-NonInteractive", "-Command",
        `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e | ForEach-Object { $_.ToString() }; exit $e.Count`,
      ],
    });
    expect(parsed.stdout.toString()).toBe("");
    expect(parsed.exitCode).toBe(0);
  });

  test("install.cmd, which cannot run here, names the same markers", () => {
    expect([...MOD_MARKERS]).toEqual([...DATA_DIR_MARKERS]);
    const ps1List = installPs1Block.match(/\$dataDirMarkers = @\(([^)]*)\)/)?.[1];
    expect(ps1List?.split(",").map((s) => s.trim().replace(/"/g, ""))).toEqual([...DATA_DIR_MARKERS]);
    const cmd = readFileSync(join(REPO, "scripts", "install.cmd"), "utf8");
    expect(cmd).toContain("REM BEGIN data-dir resolution");
    expect(cmd).toContain("REM END data-dir resolution");
    const cmdList = cmd.match(/for %%M in \(([^)]*)\) do/)?.[1];
    expect(cmdList?.trim().split(/\s+/)).toEqual([...DATA_DIR_MARKERS]);
  });
});
