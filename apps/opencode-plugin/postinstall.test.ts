import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The postinstall must copy for an installed package and stay out of the
// developer's real OpenCode config inside this monorepo. Every test works in
// temp dirs and passes XDG_CONFIG_HOME / HOME explicitly; nothing here may read
// or write the real ~/.config.
const postinstall = require("./scripts/postinstall.cjs") as {
  OVERRIDE_ENV: string;
  shouldCopy(packageDir: string, env: Record<string, string | undefined>): { copy: boolean; reason: string };
  opencodeConfigDir(env: Record<string, string | undefined>, homedir: string): string;
  run(options: {
    packageDir: string;
    env: Record<string, string | undefined>;
    homedir?: string;
  }): { decision: { copy: boolean; reason: string }; written: string[] };
};

const SCRIPT = path.join(import.meta.dir, "scripts", "postinstall.cjs");
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "plannotator-opencode-postinstall-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A package directory shaped like the published tarball, with the script in it. */
function fakePackage(packageDir: string, { withSkill = true } = {}): void {
  mkdirSync(path.join(packageDir, "commands"), { recursive: true });
  mkdirSync(path.join(packageDir, "scripts"), { recursive: true });
  writeFileSync(path.join(packageDir, "commands", "plannotator-review.md"), "review stub\n");
  writeFileSync(path.join(packageDir, "commands", "plannotator-annotate.md"), "annotate stub\n");
  writeFileSync(path.join(packageDir, "commands", "notes.txt"), "not a stub\n");
  writeFileSync(path.join(packageDir, "scripts", "postinstall.cjs"), readFileSync(SCRIPT));
  if (withSkill) {
    mkdirSync(path.join(packageDir, "skills", "plannotator"), { recursive: true });
    writeFileSync(path.join(packageDir, "skills", "plannotator", "SKILL.md"), "skill\n");
  }
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.push(path.relative(dir, path.join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

function runtime(): string {
  // npm and pnpm run the postinstall under node; fall back to bun if absent.
  return Bun.which("node") ?? process.execPath;
}

describe("postinstall decision", () => {
  test("copies for a package under node_modules, with either separator", () => {
    expect(postinstall.shouldCopy("/home/u/proj/node_modules/@plannotator/opencode", {}).copy).toBe(true);
    expect(postinstall.shouldCopy("/home/u/proj/node_modules/.pnpm/@plannotator+opencode@1.0.0/node_modules/@plannotator/opencode", {}).copy).toBe(true);
    expect(postinstall.shouldCopy("C:\\Users\\u\\proj\\node_modules\\@plannotator\\opencode", {}).copy).toBe(true);
    expect(postinstall.shouldCopy("/home/u/.cache/opencode/node_modules/@plannotator/opencode", {}).copy).toBe(true);
  });

  test("skips the workspace checkout", () => {
    expect(postinstall.shouldCopy("/home/u/plannotator/apps/opencode-plugin", {})).toEqual({ copy: false, reason: "workspace" });
    expect(postinstall.shouldCopy("C:\\src\\plannotator\\apps\\opencode-plugin", {}).copy).toBe(false);
    // A directory merely named like node_modules is not one.
    expect(postinstall.shouldCopy("/home/u/my_node_modules/apps/opencode-plugin", {}).copy).toBe(false);
    // The real package directory in this repo.
    expect(postinstall.shouldCopy(import.meta.dir, {}).copy).toBe(false);
  });

  test("the override env forces or disables the copy", () => {
    const env = (value: string) => ({ [postinstall.OVERRIDE_ENV]: value });
    expect(postinstall.shouldCopy("/src/plannotator/apps/opencode-plugin", env("1"))).toEqual({ copy: true, reason: "forced" });
    expect(postinstall.shouldCopy("/src/plannotator/apps/opencode-plugin", env("true")).copy).toBe(true);
    expect(postinstall.shouldCopy("/p/node_modules/@plannotator/opencode", env("0"))).toEqual({ copy: false, reason: "disabled" });
    // Unrecognized values fall through to the path check.
    expect(postinstall.shouldCopy("/p/node_modules/@plannotator/opencode", env("maybe")).copy).toBe(true);
    expect(postinstall.shouldCopy("/src/plannotator/apps/opencode-plugin", env("")).copy).toBe(false);
  });

  test("resolves ${XDG_CONFIG_HOME:-$HOME/.config}/opencode", () => {
    expect(postinstall.opencodeConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(path.join("/xdg", "opencode"));
    expect(postinstall.opencodeConfigDir({ XDG_CONFIG_HOME: "" }, "/home/u")).toBe(path.join("/home/u", ".config", "opencode"));
    expect(postinstall.opencodeConfigDir({}, "/home/u")).toBe(path.join("/home/u", ".config", "opencode"));
  });
});

describe("postinstall copy", () => {
  test("an installed package writes the stubs and the skill into XDG_CONFIG_HOME", () => {
    const root = tempDir();
    const packageDir = path.join(root, "proj", "node_modules", "@plannotator", "opencode");
    const xdg = path.join(root, "xdg");
    fakePackage(packageDir);

    const result = postinstall.run({ packageDir, env: { XDG_CONFIG_HOME: xdg }, homedir: path.join(root, "home") });

    expect(result.decision.reason).toBe("installed");
    expect(listFiles(path.join(xdg, "opencode"))).toEqual([
      path.join("commands", "plannotator-annotate.md"),
      path.join("commands", "plannotator-review.md"),
      path.join("skills", "plannotator", "SKILL.md"),
    ]);
    expect(existsSync(path.join(root, "home"))).toBe(false);
  });

  test("falls back to HOME/.config when XDG_CONFIG_HOME is unset", () => {
    const root = tempDir();
    const packageDir = path.join(root, "node_modules", "@plannotator", "opencode");
    const home = path.join(root, "home");
    fakePackage(packageDir);

    postinstall.run({ packageDir, env: {}, homedir: home });

    expect(listFiles(path.join(home, ".config", "opencode"))).toContain(path.join("commands", "plannotator-review.md"));
  });

  test("a workspace layout writes nothing", () => {
    const root = tempDir();
    const packageDir = path.join(root, "plannotator", "apps", "opencode-plugin");
    const xdg = path.join(root, "xdg");
    fakePackage(packageDir);

    const result = postinstall.run({ packageDir, env: { XDG_CONFIG_HOME: xdg }, homedir: path.join(root, "home") });

    expect(result.written).toEqual([]);
    expect(existsSync(xdg)).toBe(false);
    expect(existsSync(path.join(root, "home"))).toBe(false);
  });

  test("missing sources never throw; what exists is still copied", () => {
    const root = tempDir();
    const packageDir = path.join(root, "node_modules", "@plannotator", "opencode");
    const xdg = path.join(root, "xdg");
    fakePackage(packageDir, { withSkill: false });

    const result = postinstall.run({ packageDir, env: { XDG_CONFIG_HOME: xdg } });

    expect(result.written.map((file) => path.basename(file)).sort()).toEqual([
      "plannotator-annotate.md",
      "plannotator-review.md",
    ]);
  });

  test("an unwritable config dir exits 0 and writes nothing", () => {
    const root = tempDir();
    const packageDir = path.join(root, "node_modules", "@plannotator", "opencode");
    fakePackage(packageDir);
    // XDG_CONFIG_HOME is a FILE, so every mkdir under it fails.
    const blocker = path.join(root, "blocker");
    writeFileSync(blocker, "");

    const child = spawnSync(runtime(), ["scripts/postinstall.cjs"], {
      cwd: packageDir,
      env: { ...process.env, XDG_CONFIG_HOME: blocker, HOME: path.join(root, "home"), [postinstall.OVERRIDE_ENV]: "" },
      encoding: "utf-8",
    });

    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
  });

  test("the script as a process: copies under node_modules, not from this checkout", () => {
    const root = tempDir();
    const installed = path.join(root, "proj", "node_modules", "@plannotator", "opencode");
    fakePackage(installed);
    const xdg = path.join(root, "xdg");
    const home = path.join(root, "home");
    const env = { ...process.env, XDG_CONFIG_HOME: xdg, HOME: home, [postinstall.OVERRIDE_ENV]: "" };

    const fromCheckout = spawnSync(runtime(), [SCRIPT], { cwd: import.meta.dir, env, encoding: "utf-8" });
    expect(fromCheckout.status).toBe(0);
    expect(existsSync(xdg)).toBe(false);
    expect(existsSync(home)).toBe(false);

    const fromInstall = spawnSync(runtime(), ["scripts/postinstall.cjs"], { cwd: installed, env, encoding: "utf-8" });
    expect(fromInstall.status).toBe(0);
    expect(listFiles(path.join(xdg, "opencode"))).toContain(path.join("skills", "plannotator", "SKILL.md"));
  });
});
