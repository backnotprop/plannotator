"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const OVERRIDE_ENV = "PLANNOTATOR_OPENCODE_POSTINSTALL";

function isInsideNodeModules(dir) {
  return String(dir)
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase() === "node_modules");
}

function shouldCopy(packageDir, env) {
  const value = env && typeof env[OVERRIDE_ENV] === "string" ? env[OVERRIDE_ENV].trim().toLowerCase() : "";
  if (value === "1" || value === "true" || value === "on") return { copy: true, reason: "forced" };
  if (value === "0" || value === "false" || value === "off") return { copy: false, reason: "disabled" };
  if (isInsideNodeModules(packageDir)) return { copy: true, reason: "installed" };
  return { copy: false, reason: "workspace" };
}

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
