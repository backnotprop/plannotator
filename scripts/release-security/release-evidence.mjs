import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const NATIVE_SUBJECTS = [
  "plannotator-darwin-arm64",
  "plannotator-darwin-x64",
  "plannotator-linux-x64",
  "plannotator-linux-arm64",
  "plannotator-win32-x64.exe",
  "plannotator-win32-arm64.exe",
  "plannotator-paste-darwin-arm64",
  "plannotator-paste-darwin-x64",
  "plannotator-paste-linux-x64",
  "plannotator-paste-linux-arm64",
  "plannotator-paste-win32-x64.exe",
  "plannotator-paste-win32-arm64.exe",
];

export const NPM_SUBJECTS = [
  "npm-packages/plannotator-opencode.tgz",
  "npm-packages/plannotator-pi-extension.tgz",
];

export const RELEASE_WORKSPACES = [
  "",
  "apps/hook",
  "apps/opencode-plugin",
  "apps/paste-service",
  "apps/pi-extension",
  "apps/review",
  "packages/ai",
  "packages/core",
  "packages/editor",
  "packages/review-editor",
  "packages/server",
  "packages/shared",
  "packages/ui",
];

export const SBOM_SENTINELS = [
  "@anthropic-ai/claude-agent-sdk",
  "@joplin/turndown-plugin-gfm",
  "@opencode-ai/sdk",
  "@pierre/diffs",
  "@plannotator/webtui",
  "marked",
];

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      fail(`Expected --name value arguments, received: ${argv.join(" ")}`);
    }
    values.set(key.slice(2), value);
  }
  return values;
}

function requireArg(args, name) {
  const value = args.get(name);
  if (!value) fail(`Missing required --${name} argument`);
  return value;
}

function packageNameFromIdentity(identity) {
  if (typeof identity !== "string") return null;
  const separator = identity.lastIndexOf("@");
  if (separator <= 0) return null;
  return identity.slice(0, separator);
}

function packageEntriesByName(lock) {
  const entries = new Map();
  for (const value of Object.values(lock.packages ?? {})) {
    if (!Array.isArray(value)) continue;
    const name = packageNameFromIdentity(value[0]);
    if (!name) continue;
    const existing = entries.get(name) ?? [];
    existing.push(value);
    entries.set(name, existing);
  }
  return entries;
}

export function buildApplicability(lock) {
  if (!lock || typeof lock !== "object" || !lock.workspaces || !lock.packages) {
    fail("bun.lock evidence is missing workspaces or packages");
  }

  const workspaceByName = new Map();
  for (const [workspacePath, workspace] of Object.entries(lock.workspaces)) {
    if (workspace?.name) workspaceByName.set(workspace.name, { path: workspacePath, workspace });
  }

  for (const workspacePath of RELEASE_WORKSPACES) {
    if (!lock.workspaces[workspacePath]) {
      fail(`Release workspace is absent from bun.lock: ${workspacePath || "<root>"}`);
    }
  }

  const entriesByName = packageEntriesByName(lock);
  const runtimeNames = new Set();
  const visitedWorkspaces = new Set();
  const pending = [];

  const enqueueDependencies = (manifest) => {
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const name of Object.keys(manifest?.[field] ?? {})) pending.push(name);
    }
  };

  for (const workspacePath of RELEASE_WORKSPACES) {
    const workspace = lock.workspaces[workspacePath];
    visitedWorkspaces.add(workspace.name);
    enqueueDependencies(workspace);
  }

  while (pending.length > 0) {
    const name = pending.pop();
    if (!name) continue;

    const internal = workspaceByName.get(name);
    if (internal) {
      if (!visitedWorkspaces.has(name)) {
        visitedWorkspaces.add(name);
        enqueueDependencies(internal.workspace);
      }
      continue;
    }

    if (runtimeNames.has(name)) continue;
    runtimeNames.add(name);

    // Bun can lock several versions under dependent-prefixed keys. Treat every
    // locked instance of a runtime package name as runtime and walk every one
    // of their dependency sets. This is intentionally conservative: it may
    // gate a dev-only duplicate, but it will not silently label a shipped
    // instance as development-only because version resolution was ambiguous.
    for (const entry of entriesByName.get(name) ?? []) {
      enqueueDependencies(entry[2]);
    }
  }

  const allNames = new Set(entriesByName.keys());
  const developmentOnlyNames = [...allNames].filter((name) => !runtimeNames.has(name)).sort();

  return {
    schemaVersion: 1,
    classificationMethod: "conservative package-name closure over production and optional dependencies",
    confidence: "conservative-name-match",
    releaseWorkspaces: RELEASE_WORKSPACES,
    runtimePackageNames: [...runtimeNames].sort(),
    developmentOnlyPackageNames: developmentOnlyNames,
    counts: {
      runtimePackageNames: runtimeNames.size,
      developmentOnlyPackageNames: developmentOnlyNames.length,
      lockedPackageNames: allNames.size,
    },
  };
}

async function sha256(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function validateSubject(subjectsRoot, relativePath) {
  const filePath = path.join(subjectsRoot, relativePath);
  const details = await stat(filePath).catch(() => null);
  if (!details?.isFile() || details.size === 0) fail(`Release subject is missing or empty: ${relativePath}`);

  const digest = await sha256(filePath);
  if (NATIVE_SUBJECTS.includes(relativePath)) {
    const sidecarPath = `${filePath}.sha256`;
    const sidecar = await readFile(sidecarPath, "utf8").catch(() => "");
    const match = sidecar.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (!match || match[1].toLowerCase() !== digest || path.basename(match[2]) !== relativePath) {
      fail(`SHA256 sidecar does not match ${relativePath}`);
    }
  }

  return { path: relativePath, sha256: digest, size: details.size };
}

export async function prepareReleaseEvidence(options) {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const subjectsRoot = path.resolve(options.subjectsRoot);
  const sbomInput = path.resolve(options.sbomInput);
  const evidenceDirectory = path.resolve(options.evidenceDirectory);
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  if (packageJson.version !== options.version) {
    fail(`Release version ${options.version} does not match package.json ${packageJson.version}`);
  }
  if (!/^[0-9a-f]{40}$/.test(options.commit)) fail("Commit must be a full 40-character SHA");
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
    fail(`Repository must be a canonical GitHub HTTPS URL: ${options.repository}`);
  }

  const subjects = [];
  for (const relativePath of [...NATIVE_SUBJECTS, ...NPM_SUBJECTS]) {
    subjects.push(await validateSubject(subjectsRoot, relativePath));
  }

  await mkdir(sbomInput, { recursive: true });
  await mkdir(evidenceDirectory, { recursive: true });
  const lockText = await readFile(path.join(repositoryRoot, "bun.lock"), "utf8");
  const lock = globalThis.Bun?.JSONC?.parse(lockText);
  if (!lock) fail("This command must run with Bun so bun.lock JSONC can be parsed safely");

  await writeFile(path.join(sbomInput, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(path.join(sbomInput, "bun.lock"), lockText);

  const applicability = buildApplicability(lock);
  await writeFile(
    path.join(evidenceDirectory, "release-applicability.json"),
    `${JSON.stringify(applicability, null, 2)}\n`,
  );

  const subjectEvidence = {
    schemaVersion: 1,
    repository: options.repository,
    commit: options.commit,
    version: options.version,
    subjects,
  };
  await writeFile(
    path.join(evidenceDirectory, "release-subjects.json"),
    `${JSON.stringify(subjectEvidence, null, 2)}\n`,
  );
  await writeFile(
    path.join(evidenceDirectory, "subject-checksums.sha256"),
    `${subjects.map((subject) => `${subject.sha256}  ${subject.path}`).join("\n")}\n`,
  );

  return { applicability, subjectEvidence };
}

export async function verifyReleaseSubjects(options) {
  const evidence = requireObject(JSON.parse(await readFile(options.subjectsPath, "utf8")), "subject evidence");
  if (
    evidence.version !== options.version ||
    evidence.repository !== options.repository ||
    evidence.commit !== options.commit
  ) {
    fail("Validated subject evidence does not match this release invocation");
  }
  const expectedPaths = [...NATIVE_SUBJECTS, ...NPM_SUBJECTS];
  if (!Array.isArray(evidence.subjects) || evidence.subjects.length !== expectedPaths.length) {
    fail(`Subject evidence must contain exactly ${expectedPaths.length} release subjects`);
  }
  const byPath = new Map(evidence.subjects.map((subject) => [subject?.path, subject]));
  if (byPath.size !== expectedPaths.length) fail("Subject evidence contains duplicate paths");
  for (const relativePath of expectedPaths) {
    const expected = byPath.get(relativePath);
    if (!expected) fail(`Subject evidence is missing ${relativePath}`);
    const actual = await validateSubject(path.resolve(options.subjectsRoot), relativePath);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      fail(`Release subject changed after the security gate: ${relativePath}`);
    }
  }
  return evidence.subjects.length;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

export async function finalizeSbom(options) {
  const cyclonedxFile = await stat(options.cyclonedxPath).catch(() => null);
  if (!cyclonedxFile?.isFile() || cyclonedxFile.size === 0) fail("CycloneDX SBOM is missing or empty");
  if (cyclonedxFile.size > 16 * 1024 * 1024) {
    fail("CycloneDX SBOM exceeds the 16 MiB GitHub attestation predicate limit");
  }
  const cyclonedx = requireObject(JSON.parse(await readFile(options.cyclonedxPath, "utf8")), "CycloneDX SBOM");
  const syft = requireObject(JSON.parse(await readFile(options.syftPath, "utf8")), "Syft SBOM");
  const subjects = requireObject(JSON.parse(await readFile(options.subjectsPath, "utf8")), "subject evidence");

  if (cyclonedx.bomFormat !== "CycloneDX" || cyclonedx.specVersion !== "1.6" || cyclonedx.version !== 1) {
    fail("Public SBOM must be CycloneDX JSON 1.6 with document version 1");
  }
  if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(cyclonedx.serialNumber ?? "")) fail("CycloneDX serialNumber is invalid");
  if (!Array.isArray(cyclonedx.components) || cyclonedx.components.length === 0) {
    fail("CycloneDX SBOM contains zero components");
  }
  if (!Array.isArray(syft.artifacts) || syft.artifacts.length === 0) fail("Syft scan contains zero packages");
  if (subjects.version !== options.version || subjects.repository !== options.repository || subjects.commit !== options.commit) {
    fail("SBOM metadata does not match the validated release subjects");
  }

  const componentNames = new Set(cyclonedx.components.map((component) => component?.name));
  const syftNames = new Set(syft.artifacts.map((artifact) => artifact?.name));
  for (const sentinel of SBOM_SENTINELS) {
    if (!componentNames.has(sentinel) || !syftNames.has(sentinel)) {
      fail(`SBOM is missing release dependency sentinel: ${sentinel}`);
    }
  }

  const metadata = requireObject(cyclonedx.metadata, "CycloneDX metadata");
  if (Number.isNaN(Date.parse(metadata.timestamp ?? ""))) fail("CycloneDX generation timestamp is invalid");
  const tools = metadata.tools?.components;
  const syftTool = Array.isArray(tools) ? tools.find((tool) => tool?.name === "syft") : null;
  if (!syftTool?.version || syftTool.version !== options.syftVersion) {
    fail(`CycloneDX metadata must identify Syft ${options.syftVersion}`);
  }

  metadata.component = {
    "bom-ref": `pkg:generic/plannotator-release@${options.version}`,
    type: "application",
    group: "backnotprop",
    name: "plannotator-release",
    version: options.version,
    externalReferences: [{ type: "vcs", url: options.repository }],
    properties: [
      { name: "plannotator:source:commit", value: options.commit },
      { name: "plannotator:source:repository", value: options.repository },
      {
        name: "plannotator:sbom:scope",
        value: "release-wide Syft-detected monorepo locked build-input and dependency inventory",
      },
      {
        name: "plannotator:sbom:limitations",
        value:
          "Not an exact per-binary runtime inventory: Bun standalone executables hide JavaScript package metadata from Syft; host-provided peers and dependencies Syft cannot parse may be absent.",
      },
      { name: "plannotator:sbom:subject-count", value: String(subjects.subjects?.length ?? 0) },
    ],
  };

  // Syft models the lockfile itself as a component and records its source
  // directory in that component name. Keep the evidence while removing the
  // runner-specific prefix from the public document.
  for (const component of cyclonedx.components) {
    if (component?.type === "file" && path.basename(component.name ?? "") === "bun.lock") {
      component.name = "/bun.lock";
    }
  }

  const serialized = `${JSON.stringify(cyclonedx, null, 2)}\n`;
  for (const forbidden of ["DO_NOT_COMMIT", "/Users/", "/home/runner/", "/private/var/"]) {
    if (serialized.includes(forbidden)) fail(`Public SBOM contains forbidden runner or private path marker: ${forbidden}`);
  }
  await writeFile(options.cyclonedxPath, serialized);

  return {
    components: cyclonedx.components.length,
    packages: syft.artifacts.length,
    sentinels: SBOM_SENTINELS,
  };
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  if (command === "prepare") {
    const result = await prepareReleaseEvidence({
      repositoryRoot: requireArg(args, "repository-root"),
      subjectsRoot: requireArg(args, "subjects-root"),
      sbomInput: requireArg(args, "sbom-input"),
      evidenceDirectory: requireArg(args, "evidence-directory"),
      version: requireArg(args, "version"),
      repository: requireArg(args, "repository"),
      commit: requireArg(args, "commit"),
    });
    console.log(
      `Validated ${result.subjectEvidence.subjects.length} release subjects; classified ${result.applicability.counts.runtimePackageNames} runtime package names.`,
    );
    return;
  }
  if (command === "finalize-sbom") {
    const result = await finalizeSbom({
      cyclonedxPath: requireArg(args, "cyclonedx"),
      syftPath: requireArg(args, "syft"),
      subjectsPath: requireArg(args, "subjects"),
      version: requireArg(args, "version"),
      repository: requireArg(args, "repository"),
      commit: requireArg(args, "commit"),
      syftVersion: requireArg(args, "syft-version"),
    });
    console.log(
      `Validated CycloneDX 1.6 SBOM with ${result.components} components and sentinels: ${result.sentinels.join(", ")}`,
    );
    return;
  }
  if (command === "verify-subjects") {
    const count = await verifyReleaseSubjects({
      subjectsRoot: requireArg(args, "subjects-root"),
      subjectsPath: requireArg(args, "subjects"),
      version: requireArg(args, "version"),
      repository: requireArg(args, "repository"),
      commit: requireArg(args, "commit"),
    });
    console.log(`Revalidated ${count} release subjects against the security gate evidence.`);
    return;
  }
  fail(`Unknown command: ${command ?? "<missing>"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`release evidence error: ${error.message}`);
    process.exitCode = 1;
  });
}
