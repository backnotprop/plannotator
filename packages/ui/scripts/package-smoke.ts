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
const coreManifestPath = join(coreDir, "package.json");

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
const coreSourceManifest = parseManifest(
  readFileSync(coreManifestPath, "utf8"),
  "core source manifest",
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

function assertExportTargets(
  manifest: PackageManifest,
  entries: ReadonlySet<string>,
  label: string,
): void {
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const packedTarget = target.replace(/^\.\//, "");
    if (!packedTarget.includes("*")) {
      assert(entries.has(packedTarget), `${label} ${subpath} points to missing ${packedTarget}`);
      continue;
    }
    const targetPattern = new RegExp(
      `^${packedTarget
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*/g, ".+")}$`,
    );
    assert(
      [...entries].some((entry) => targetPattern.test(entry)),
      `${label} ${subpath} has no packed file matching ${packedTarget}`,
    );
  }
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
assert(
  coreSourceManifest.version === expectedCoreVersion,
  `UI expects @plannotator/core ${expectedCoreVersion}, but the local core workspace is ${coreSourceManifest.version}`,
);
assert(
  coreSourceManifest.exports["./annotation-threads"] === "./annotation-threads.ts",
  "core source manifest must export ./annotation-threads",
);

const installedCore = join(uiDir, "node_modules/@plannotator/core");
assert(existsSync(installedCore), "run bun install before the package smoke");
assert(
  realpathSync(installedCore) === realpathSync(coreDir),
  "Bun must keep the exact-version @plannotator/core dependency linked to the local workspace",
);

const workDir = mkdtempSync(join(tmpdir(), "plannotator-ui-package-smoke-"));
try {
  const coreTarballPath = join(workDir, "plannotator-core.tgz");
  const tarballPath = join(workDir, "plannotator-ui.tgz");
  run("bun", ["pm", "pack", "--filename", coreTarballPath], coreDir);
  run("bun", ["pm", "pack", "--filename", tarballPath], uiDir);

  const packedCoreManifest = parseManifest(
    run("tar", ["-xOf", coreTarballPath, "package/package.json"]),
    "packed core manifest",
  );
  assert(
    packedCoreManifest.version === expectedCoreVersion,
    `packed core version must be ${expectedCoreVersion}; got ${packedCoreManifest.version}`,
  );
  assert(
    packedCoreManifest.exports["./annotation-threads"] === "./annotation-threads.ts",
    "packed core manifest must export ./annotation-threads",
  );
  const coreEntries = new Set(
    run("tar", ["-tzf", coreTarballPath])
      .split("\n")
      .filter(Boolean)
      .map((entry) => entry.replace(/^package\//, "")),
  );
  assertExportTargets(packedCoreManifest, coreEntries, "packed core manifest");

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
  assertExportTargets(packedManifest, entries, "packed UI manifest");

  const consumerDir = join(workDir, "external-consumer");
  mkdirSync(consumerDir);
  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "plannotator-ui-external-consumer-smoke",
        private: true,
        type: "module",
        dependencies: {
          "@plannotator/ui": `file:${tarballPath}`,
          react: "19.2.3",
          "react-dom": "19.2.3",
          tailwindcss: "4.1.18",
        },
        devDependencies: {
          "@types/react": "19.2.0",
          "@types/react-dom": "19.2.0",
          typescript: "5.8.3",
          vite: "6.4.3",
        },
        pnpm: {
          overrides: {
            "@plannotator/core": `file:${coreTarballPath}`,
          },
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

  writeFileSync(
    join(consumerDir, "consumer.tsx"),
    [
      'import { AnnotationPanel } from "@plannotator/ui/components/AnnotationPanel";',
      'import { StickyHeaderLane, type StickyHeaderLaneProps } from "@plannotator/ui/components/StickyHeaderLane";',
      'import { Viewer, type ViewerAnnotationHeaderConfig } from "@plannotator/ui/components/Viewer";',
      'import * as parser from "@plannotator/ui/utils/parser";',
      "",
      'const laneProps: Pick<StickyHeaderLaneProps, "visibility" | "sticky"> = { visibility: "always", sticky: false };',
      'const annotationHeader: ViewerAnnotationHeaderConfig = { onInputMethodChange: () => {}, onModeChange: () => {}, hideQuickLabel: true };',
      "void StickyHeaderLane;",
      "void laneProps;",
      "void Viewer;",
      "void annotationHeader;",
      "void AnnotationPanel;",
      "void parser;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(consumerDir, "index.html"),
    '<script type="module" src="/consumer.tsx"></script>\n',
  );
  writeFileSync(
    join(consumerDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["consumer.tsx"],
      },
      null,
      2,
    )}\n`,
  );
  run(join(consumerDir, "node_modules/.bin/vite"), ["build"], consumerDir);
  run(join(consumerDir, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumerDir);

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
    existsSync(join(pnpmVirtualStore, entry, "node_modules/@plannotator/core/package.json")),
  );
  assert(installedCoreEntry, "external pnpm consumer did not install @plannotator/core");
  const installedCoreManifest = parseManifest(
    readFileSync(
      join(
        pnpmVirtualStore,
        installedCoreEntry,
        "node_modules/@plannotator/core/package.json",
      ),
      "utf8",
    ),
    "externally installed core manifest",
  );
  assert(
    installedCoreManifest.version === expectedCoreVersion,
    `external pnpm consumer installed @plannotator/core ${String(installedCoreManifest.version)}, expected ${expectedCoreVersion}`,
  );
  assert(
    installedCoreManifest.exports["./annotation-threads"] === "./annotation-threads.ts",
    "external pnpm consumer core is missing the ./annotation-threads export",
  );

  console.log(
    `Verified @plannotator/ui@${expectedUiVersion} packs, resolves AnnotationPanel/Viewer/StickyHeaderLane/parser, and installs externally with @plannotator/core@${expectedCoreVersion}.`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
