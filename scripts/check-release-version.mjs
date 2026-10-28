#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const JSON_VERSION_PATHS = [
  "package.json",
  "apps/opencode-plugin/package.json",
  "apps/pi-extension/package.json",
  "apps/hook/.claude-plugin/plugin.json",
  "apps/copilot/plugin.json",
  "packages/server/package.json",
];
// Copilot CLI reads .github/plugin/marketplace.json before .claude-plugin/. Its
// plugin reference marks an entry's `version` optional but doesn't say how
// `/plugin` decides a newer version is available upstream, so the field stays
// and must match the release (it sat at 0.17.0 from 0.17.0 to 0.28.32).
const MARKETPLACE_ENTRIES = [
  { relativePath: ".github/plugin/marketplace.json", plugin: "plannotator-copilot" },
];
// Exempt: apps/droid-plugin/.factory-plugin/plugin.json. Droid tracks a
// relative-path plugin in a git marketplace by the marketplace commit hash and
// treats the manifest `version` as metadata only, so its value can neither hold
// back nor trigger an update (https://docs.factory.com/cli/configuration/plugins).
const OPENPACKAGE_PATH = "openpackage.yml";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function parseArguments(argv) {
  let root = process.cwd();
  let tag;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];

    if (argument === "--root" && value) {
      root = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--tag" && value) {
      tag = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }

  return { root, tag };
}

function readJsonVersion(root, relativePath) {
  const parsed = JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${relativePath} must contain a JSON object`);
  }

  const version = Object.getOwnPropertyDescriptor(parsed, "version")?.value;
  if (typeof version !== "string") {
    throw new Error(`${relativePath} must contain a string version field`);
  }
  return version;
}

function readMarketplaceVersion(root, { relativePath, plugin }) {
  const parsed = JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
  const entries = Array.isArray(parsed?.plugins)
    ? parsed.plugins.filter((entry) => entry?.name === plugin)
    : [];
  if (entries.length !== 1) {
    throw new Error(`${relativePath} must list plugin ${plugin} exactly once`);
  }
  const version = Object.getOwnPropertyDescriptor(entries[0], "version")?.value;
  if (typeof version !== "string") {
    throw new Error(`${relativePath} must contain a string version for plugin ${plugin}`);
  }
  return version;
}

function readOpenpackageVersion(root) {
  const contents = readFileSync(resolve(root, OPENPACKAGE_PATH), "utf8");
  const matches = [...contents.matchAll(/^version:\s*([^\s#]+)\s*(?:#.*)?$/gm)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error(`${OPENPACKAGE_PATH} must contain exactly one top-level version field`);
  }
  return matches[0][1];
}

function checkReleaseVersion({ root, tag }) {
  const versions = [
    ...JSON_VERSION_PATHS.map((relativePath) => ({
      relativePath,
      version: readJsonVersion(root, relativePath),
    })),
    ...MARKETPLACE_ENTRIES.map((entry) => ({
      relativePath: entry.relativePath,
      version: readMarketplaceVersion(root, entry),
    })),
    {
      relativePath: OPENPACKAGE_PATH,
      version: readOpenpackageVersion(root),
    },
  ];
  const expectedVersion = versions[0].version;

  if (!VERSION_PATTERN.test(expectedVersion)) {
    throw new Error(`Invalid release version in package.json: ${expectedVersion}`);
  }

  const mismatches = versions.filter(({ version }) => version !== expectedVersion);
  if (mismatches.length > 0) {
    const details = versions
      .map(({ relativePath, version }) => `  ${relativePath}: ${version}`)
      .join("\n");
    throw new Error(`Release-coupled versions do not match:\n${details}`);
  }

  if (tag !== undefined && tag !== `v${expectedVersion}`) {
    throw new Error(`Release tag ${tag} does not match manifest version v${expectedVersion}`);
  }

  return expectedVersion;
}

try {
  const version = checkReleaseVersion(parseArguments(process.argv.slice(2)));
  console.log(`Release version is consistent: v${version}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
