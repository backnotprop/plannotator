"use strict";
// Postinstall for @plannotator/opencode.
//
// When a user installs the package with a package manager that runs its
// scripts, copy the slash-command stubs into
// ${XDG_CONFIG_HOME:-~/.config}/opencode/commands and the knowledge skill into
// .../opencode/skills/plannotator, where OpenCode looks for them. npm and
// yarn 1 run it; pnpm 10 and bun block it unless builds are allowed (--trust).
// OpenCode's own plugin installer does NOT run it: OpenCode 1.18.x and 2.0.x
// install plugins with npm's internal installer and ignoreScripts: true, and
// older OpenCode used `bun add`, which blocks untrusted scripts. Those users
// get the stubs from the install scripts and the plugin's native commands.
//
// The same script also runs on every `bun install` inside the Plannotator
// monorepo, where apps/opencode-plugin is a workspace package. It must not
// write there: that would overwrite the developer's real OpenCode stubs and
// skill with whatever branch is checked out. An installed package always sits
// under a node_modules directory and a workspace checkout never does, so that
// is the test. `npm install <path>` and `npm link` run it from the source
// directory, so they skip the copy too. PLANNOTATOR_OPENCODE_POSTINSTALL=1
// forces the copy and =0 skips it.
//
// This is plain Node (no shell syntax) so it runs the same under npm, pnpm and
// bun on macOS, Linux and Windows. A shell `case ... esac` guard once broke
// `bun install` on Windows, whose script shell does not support it. Like the
// old `|| true`, it never fails the install: every error is ignored.

const fs = require("fs");
const os = require("os");
const path = require("path");

const OVERRIDE_ENV = "PLANNOTATOR_OPENCODE_POSTINSTALL";

/** True when a path has a `node_modules` segment (either separator). */
function isInsideNodeModules(dir) {
  return String(dir)
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase() === "node_modules");
}

/**
 * Decide whether to copy. Returns { copy, reason }.
 * The override env wins; otherwise copy only for an installed package.
 */
function shouldCopy(packageDir, env) {
  const value = env && typeof env[OVERRIDE_ENV] === "string" ? env[OVERRIDE_ENV].trim().toLowerCase() : "";
  if (value === "1" || value === "true" || value === "on") return { copy: true, reason: "forced" };
  if (value === "0" || value === "false" || value === "off") return { copy: false, reason: "disabled" };
  if (isInsideNodeModules(packageDir)) return { copy: true, reason: "installed" };
  return { copy: false, reason: "workspace" };
}

/**
 * ${XDG_CONFIG_HOME:-$HOME/.config}/opencode, as the old shell script and
 * OpenCode itself resolve it (an empty XDG_CONFIG_HOME counts as unset).
 */
function opencodeConfigDir(env, homedir) {
  const xdg = env && env.XDG_CONFIG_HOME;
  const base = xdg ? xdg : path.join(homedir, ".config");
  return path.join(base, "opencode");
}

function attempt(fn) {
  try {
    fn();
    return true;
  } catch (_error) {
    return false;
  }
}

/** Copy the stubs and the skill. Never throws. Returns the files written. */
function copyAssets(packageDir, configDir) {
  const written = [];

  const commandsSrc = path.join(packageDir, "commands");
  const commandsDest = path.join(configDir, "commands");
  if (attempt(() => fs.mkdirSync(commandsDest, { recursive: true }))) {
    let entries = [];
    attempt(() => {
      entries = fs.readdirSync(commandsSrc).filter((name) => name.endsWith(".md"));
    });
    for (const name of entries) {
      const dest = path.join(commandsDest, name);
      if (attempt(() => fs.copyFileSync(path.join(commandsSrc, name), dest))) written.push(dest);
    }
  }

  const skillSrc = path.join(packageDir, "skills", "plannotator", "SKILL.md");
  const skillDestDir = path.join(configDir, "skills", "plannotator");
  if (attempt(() => fs.mkdirSync(skillDestDir, { recursive: true }))) {
    const dest = path.join(skillDestDir, "SKILL.md");
    if (attempt(() => fs.copyFileSync(skillSrc, dest))) written.push(dest);
  }

  return written;
}

/** Options are for tests: packageDir, env, homedir. Never throws. */
function run(options) {
  const opts = options || {};
  const packageDir = opts.packageDir || path.resolve(__dirname, "..");
  const env = opts.env || process.env;
  const decision = shouldCopy(packageDir, env);
  if (!decision.copy) return { decision, written: [] };
  let homedir = opts.homedir || "";
  if (!homedir) attempt(() => { homedir = os.homedir(); });
  if (!homedir && !env.XDG_CONFIG_HOME) return { decision, written: [] };
  return { decision, written: copyAssets(packageDir, opencodeConfigDir(env, homedir)) };
}

module.exports = { OVERRIDE_ENV, isInsideNodeModules, shouldCopy, opencodeConfigDir, copyAssets, run };

if (require.main === module) {
  attempt(() => run());
  process.exitCode = 0;
}
