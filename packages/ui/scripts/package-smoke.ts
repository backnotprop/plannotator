import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PNPM_VERSION = "10.34.3";
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const uiDir = resolve(scriptsDir, "..");
const repoDir = resolve(uiDir, "../..");
const coreDir = resolve(repoDir, "packages/core");
const sourceManifestPath = join(uiDir, "package.json");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type PackageManifest = {
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, string>>;
};

function parseStringRecord(input: unknown, label: string): Record<string, string> {
  assert(typeof input === "object" && input !== null, `${label} must be an object`);
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    assert(typeof value === "string", `${label}.${key} must be a string`);
    parsed[key] = value;
  }
  return parsed;
}

function parseManifest(text: string, label: string): PackageManifest {
  const input: unknown = JSON.parse(text);
  assert(typeof input === "object" && input !== null, `${label} must be an object`);
  assert("version" in input && typeof input.version === "string", `${label} needs a version`);
  assert("dependencies" in input, `${label} needs dependencies`);
  assert("exports" in input, `${label} needs exports`);
  return {
    version: input.version,
    dependencies: parseStringRecord(input.dependencies, `${label} dependencies`),
    exports: parseStringRecord(input.exports, `${label} exports`),
  };
}

const sourceManifest = parseManifest(
  readFileSync(sourceManifestPath, "utf8"),
  "source manifest",
);

function run(command: string, args: string[], cwd = repoDir): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function assertManifest(
  manifest: PackageManifest,
  expectedUiVersion: string,
  expectedCoreVersion: string,
  label: string,
): void {
  assert(
    manifest.version === expectedUiVersion,
    `${label} version must be ${expectedUiVersion}; got ${String(manifest.version)}`,
  );
  assert(
    manifest.dependencies["@plannotator/core"] === expectedCoreVersion,
    `${label} must depend on @plannotator/core ${expectedCoreVersion}; got ${String(manifest.dependencies["@plannotator/core"])}`,
  );
  assert(
    !JSON.stringify(manifest.dependencies).includes("workspace:"),
    `${label} must not expose a workspace: dependency`,
  );
}

const expectedUiVersion = sourceManifest.version;
const expectedCoreVersion = sourceManifest.dependencies["@plannotator/core"];
assert(
  EXACT_SEMVER.test(expectedUiVersion),
  `source manifest version must be an exact semver; got ${expectedUiVersion}`,
);
assert(
  typeof expectedCoreVersion === "string" && EXACT_SEMVER.test(expectedCoreVersion),
  `source manifest @plannotator/core must be an exact semver; got ${String(expectedCoreVersion)}`,
);
assertManifest(sourceManifest, expectedUiVersion, expectedCoreVersion, "source manifest");

const installedCore = join(uiDir, "node_modules/@plannotator/core");
assert(existsSync(installedCore), "run bun install before the package smoke");
assert(
  realpathSync(installedCore) === realpathSync(coreDir),
  "Bun must keep the exact-version @plannotator/core dependency linked to the local workspace",
);

const workDir = mkdtempSync(join(tmpdir(), "plannotator-ui-package-smoke-"));
try {
  const tarballName = "plannotator-ui.tgz";
  const tarballPath = join(workDir, tarballName);
  run("bun", ["pm", "pack", "--filename", tarballPath], uiDir);

  const packedManifest = parseManifest(
    run("tar", ["-xOf", tarballPath, "package/package.json"]),
    "packed manifest",
  );
  assertManifest(packedManifest, expectedUiVersion, expectedCoreVersion, "packed manifest");

  const entries = new Set(
    run("tar", ["-tzf", tarballPath])
      .split("\n")
      .filter(Boolean)
      .map((entry) => entry.replace(/^package\//, "")),
  );
  const requiredEntries = [
    "components/AnnotationToolstrip.tsx",
    "components/StickyHeaderLane.tsx",
    "components/html-viewer/bridge-script.asset.js",
    "components/html-viewer/bridge-script.lite.ts",
    "configure.ts",
    "HANDOFF.md",
    "styles.css",
    "types.ts",
  ];
  for (const entry of requiredEntries) {
    assert(entries.has(entry), `packed tarball is missing ${entry}`);
  }
  for (const [subpath, target] of Object.entries(packedManifest.exports)) {
    const packedTarget = target.replace(/^\.\//, "");
    if (!packedTarget.includes("*")) {
      assert(entries.has(packedTarget), `${subpath} points to missing ${packedTarget}`);
      continue;
    }
    const targetPattern = new RegExp(
      `^${packedTarget
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*/g, ".+")}$`,
    );
    assert(
      [...entries].some((entry) => targetPattern.test(entry)),
      `${subpath} has no packed file matching ${packedTarget}`,
    );
  }

  const consumerDir = join(workDir, "external-consumer");
  mkdirSync(consumerDir);
  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "plannotator-ui-external-consumer-smoke",
        private: true,
        dependencies: {
          "@plannotator/ui": `file:${tarballPath}`,
          react: "19.2.3",
          "react-dom": "19.2.3",
          tailwindcss: "4.1.18",
        },
      },
      null,
      2,
    )}\n`,
  );

  // bunx pins the pnpm CLI without requiring a second package manager setup
  // action. The consumer lives under the OS temp directory, outside this repo,
  // and therefore cannot satisfy @plannotator/core from the Bun workspace.
  run(
    "bunx",
    [
      `pnpm@${PNPM_VERSION}`,
      "install",
      "--ignore-scripts",
      "--store-dir",
      join(workDir, "pnpm-store"),
    ],
    consumerDir,
  );

  const installedUiManifest = parseManifest(
    readFileSync(join(consumerDir, "node_modules/@plannotator/ui/package.json"), "utf8"),
    "externally installed manifest",
  );
  assertManifest(
    installedUiManifest,
    expectedUiVersion,
    expectedCoreVersion,
    "externally installed manifest",
  );

  const pnpmVirtualStore = join(consumerDir, "node_modules/.pnpm");
  const installedCoreEntry = readdirSync(pnpmVirtualStore).find((entry) =>
    entry.startsWith(`@plannotator+core@${expectedCoreVersion}`),
  );
  assert(installedCoreEntry, "external pnpm consumer did not install @plannotator/core");
  const installedCoreManifest: unknown = JSON.parse(
    readFileSync(
      join(
        pnpmVirtualStore,
        installedCoreEntry,
        "node_modules/@plannotator/core/package.json",
      ),
      "utf8",
    ),
  );
  assert(
    typeof installedCoreManifest === "object" &&
      installedCoreManifest !== null &&
      "version" in installedCoreManifest &&
      typeof installedCoreManifest.version === "string",
    "external pnpm consumer installed an invalid @plannotator/core manifest",
  );
  assert(
    installedCoreManifest.version === expectedCoreVersion,
    `external pnpm consumer installed @plannotator/core ${String(installedCoreManifest.version)}, expected ${expectedCoreVersion}`,
  );

  console.log(
    `Verified @plannotator/ui@${expectedUiVersion} packs and installs externally with @plannotator/core@${expectedCoreVersion}.`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
