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
