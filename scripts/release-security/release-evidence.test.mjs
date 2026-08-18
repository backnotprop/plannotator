import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildApplicability, finalizeSbom, RELEASE_WORKSPACES, SBOM_SENTINELS } from "./release-evidence.mjs";

function workspaceLock() {
  const workspaces = Object.fromEntries(
    RELEASE_WORKSPACES.map((workspacePath, index) => [
      workspacePath,
      { name: index === 0 ? "plannotator" : `workspace-${index}`, dependencies: {} },
    ]),
  );
  workspaces[""].dependencies = { runtime: "1.0.0", "workspace-1": "workspace:*" };
  workspaces[""].devDependencies = { development: "1.0.0" };
  workspaces[RELEASE_WORKSPACES[1]].dependencies = { nested: "1.0.0" };
  return {
    workspaces,
    packages: {
      runtime: ["runtime@1.0.0", "", { dependencies: { transitive: "1.0.0" } }],
      nested: ["nested@1.0.0", "", {}],
      transitive: ["transitive@1.0.0", "", {}],
      development: ["development@1.0.0", "", {}],
    },
  };
}

test("classifies release production dependency closure conservatively", () => {
  const result = buildApplicability(workspaceLock());
  assert.deepEqual(result.runtimePackageNames, ["nested", "runtime", "transitive"]);
  assert.deepEqual(result.developmentOnlyPackageNames, ["development"]);
});

test("rejects a lock missing a release workspace", () => {
  const lock = workspaceLock();
  delete lock.workspaces[RELEASE_WORKSPACES.at(-1)];
  assert.throws(() => buildApplicability(lock), /Release workspace is absent/);
});

async function sbomFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "plannotator-sbom-test-"));
  const cyclonedxPath = path.join(directory, "release.cdx.json");
  const syftPath = path.join(directory, "release.syft.json");
  const subjectsPath = path.join(directory, "subjects.json");
  const components = SBOM_SENTINELS.map((name) => ({ type: "library", name, version: "1.0.0" }));
  await writeFile(
    cyclonedxPath,
    JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      serialNumber: "urn:uuid:11111111-1111-4111-8111-111111111111",
      version: 1,
      metadata: {
        timestamp: "2026-08-13T00:00:00Z",
        tools: { components: [{ name: "syft", version: "1.51.0" }] },
      },
      components,
    }),
  );
  await writeFile(syftPath, JSON.stringify({ artifacts: components }));
  await writeFile(
    subjectsPath,
    JSON.stringify({
      version: "0.27.1",
      repository: "https://github.com/backnotprop/plannotator",
      commit: "a".repeat(40),
      subjects: [{ path: "plannotator-linux-x64" }],
    }),
  );
  return { directory, cyclonedxPath, syftPath, subjectsPath };
}

test("finalizes required release metadata and sentinel assertions", async () => {
  const fixture = await sbomFixture();
  const result = await finalizeSbom({
    ...fixture,
    version: "0.27.1",
    repository: "https://github.com/backnotprop/plannotator",
    commit: "a".repeat(40),
    syftVersion: "1.51.0",
  });
  assert.equal(result.components, SBOM_SENTINELS.length);
  const output = JSON.parse(await readFile(fixture.cyclonedxPath, "utf8"));
  assert.equal(output.metadata.component.name, "plannotator-release");
  assert.equal(
    output.metadata.component.properties.find((property) => property.name === "plannotator:source:commit").value,
    "a".repeat(40),
  );
});

test("rejects empty and sentinel-incomplete SBOMs", async () => {
  const empty = await sbomFixture();
  const emptyDocument = JSON.parse(await readFile(empty.cyclonedxPath, "utf8"));
  emptyDocument.components = [];
  await writeFile(empty.cyclonedxPath, JSON.stringify(emptyDocument));
  await assert.rejects(
    finalizeSbom({
      ...empty,
      version: "0.27.1",
      repository: "https://github.com/backnotprop/plannotator",
      commit: "a".repeat(40),
      syftVersion: "1.51.0",
    }),
    /zero components/,
  );

  const incomplete = await sbomFixture();
  const incompleteDocument = JSON.parse(await readFile(incomplete.cyclonedxPath, "utf8"));
  incompleteDocument.components.pop();
  await writeFile(incomplete.cyclonedxPath, JSON.stringify(incompleteDocument));
  await assert.rejects(
    finalizeSbom({
      ...incomplete,
      version: "0.27.1",
      repository: "https://github.com/backnotprop/plannotator",
      commit: "a".repeat(40),
      syftVersion: "1.51.0",
    }),
    /missing release dependency sentinel/,
  );
});
