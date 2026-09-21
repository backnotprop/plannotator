import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluatePolicy, OPENVEX_CONTEXT } from "./grype-policy.mjs";

const NOW = new Date("2026-08-13T00:00:00Z");
const CHECKSUM = "a".repeat(64);

function databaseEvidence(overrides = {}) {
  const status = {
    schemaVersion: "v6.1.9",
    from: `https://grype.anchore.io/databases/v6/example.tar.zst?checksum=sha256%3A${CHECKSUM}`,
    built: "2026-08-12T12:00:00Z",
    path: "/tmp/grype/6/vulnerability.db",
    valid: true,
    ...overrides,
  };
  return {
    status,
    listing: [
      {
        status: "active",
        schemaVersion: status.schemaVersion,
        built: status.built,
        path: "example.tar.zst",
        checksum: `sha256:${CHECKSUM}`,
      },
    ],
    check: {
      currentDB: { schemaVersion: status.schemaVersion, built: status.built },
      candidateDB: null,
      updateAvailable: false,
    },
  };
}

function vulnerabilityMatch({
  id = "GHSA-critical",
  severity = "Critical",
  name = "runtime-package",
  version = "1.0.0",
  fixState = "fixed",
  fixVersions = ["1.0.1"],
  knownExploited = [],
} = {}) {
  return {
    vulnerability: {
      id,
      dataSource: `https://example.test/${id}`,
      severity,
      urls: [],
      cvss: [],
      knownExploited,
      fix: { state: fixState, versions: fixVersions },
    },
    relatedVulnerabilities: [],
    matchDetails: [],
    artifact: {
      id: `${name}-${version}`,
      name,
      version,
      type: "npm",
      locations: [{ path: "/bun.lock" }],
      language: "javascript",
      licenses: [],
      purl: `pkg:npm/${name}@${version}`,
    },
  };
}

function scan(matches = []) {
  const { status } = databaseEvidence();
  return {
    matches,
    ignoredMatches: [],
    source: { type: "directory", target: "release-sbom-input" },
    descriptor: {
      name: "grype",
      version: "0.117.0",
      db: { status },
    },
  };
}

function applicability() {
  return {
    schemaVersion: 1,
    runtimePackageNames: ["runtime-package"],
    developmentOnlyPackageNames: ["dev-package"],
  };
}

function evaluate(overrides = {}) {
  const database = databaseEvidence();
  return evaluatePolicy({
    scan: scan(),
    ...database,
    applicability: applicability(),
    vex: null,
    now: NOW,
    grypeVersion: "0.117.0",
    ...overrides,
  });
}

function vexStatement(overrides = {}) {
  return {
    vulnerability: {
      "@id": "https://github.com/advisories/GHSA-critical",
      name: "GHSA-critical",
    },
    products: [{ "@id": "pkg:npm/runtime-package@1.0.0" }],
    status: "not_affected",
    justification: "vulnerable_code_not_in_execute_path",
    impact_statement: "The vulnerable entry point is not included in the shipped bundle.",
    timestamp: "2026-08-01T00:00:00Z",
    status_notes: [
      "plannotator-owner: security-maintainers",
      "plannotator-evidence: https://github.com/backnotprop/plannotator/issues/1234",
      "plannotator-expires: 2026-09-01",
    ].join("\n"),
    ...overrides,
  };
}

function vex(statements = [vexStatement()]) {
  return {
    "@context": OPENVEX_CONTEXT,
    "@id": "https://github.com/backnotprop/plannotator/security/vex/test",
    author: "Plannotator maintainers",
    timestamp: "2026-08-01T00:00:00Z",
    version: 1,
    statements,
  };
}

test("accepts clean, fresh, schema-compatible evidence", () => {
  const result = evaluate();
  assert.equal(result.decision, "accept");
  assert.equal(result.counts.total, 0);
  assert.equal(result.database.schemaVersion, "v6.1.9");
});

test("rejects an applicable fixable Critical finding", () => {
  const result = evaluate({ scan: scan([vulnerabilityMatch()]) });
  assert.equal(result.decision, "reject");
  assert.deepEqual(result.findings[0].blockReasons, ["applicable-fixable-critical"]);
});

test("rejects an applicable CISA KEV finding at any severity", () => {
  const result = evaluate({
    scan: scan([
      vulnerabilityMatch({
        id: "CVE-2026-1234",
        severity: "Medium",
        fixState: "not-fixed",
        fixVersions: [],
        knownExploited: [{ cve: "CVE-2026-1234", dateAdded: "2026-08-01" }],
      }),
    ]),
  });
  assert.equal(result.decision, "reject");
  assert.deepEqual(result.findings[0].blockReasons, ["applicable-cisa-kev"]);
});

test("reports High, development-only, unknown non-gated, and no-fix Critical findings", () => {
  const matches = [
    vulnerabilityMatch({ id: "GHSA-high", severity: "High" }),
    vulnerabilityMatch({ id: "GHSA-dev", name: "dev-package" }),
    vulnerabilityMatch({ id: "GHSA-unknown", name: "unclassified-package", severity: "High" }),
    vulnerabilityMatch({ id: "GHSA-nofix", fixState: "not-fixed", fixVersions: [] }),
  ];
  const result = evaluate({ scan: scan(matches) });
  assert.equal(result.decision, "accept");
  assert.ok(result.findings.every((finding) => finding.decision === "report"));
  assert.equal(result.counts.developmentOnly, 1);
  assert.equal(result.counts.unknown, 1);
});

test("treats unknown applicability as runtime for KEV and fixable Critical findings", () => {
  const unknownCritical = evaluate({
    scan: scan([vulnerabilityMatch({ name: "unclassified-package" })]),
  });
  assert.equal(unknownCritical.decision, "reject");
  assert.equal(unknownCritical.findings[0].applicability, "unknown");
  assert.deepEqual(unknownCritical.findings[0].blockReasons, ["applicable-fixable-critical"]);

  const unknownKev = evaluate({
    scan: scan([
      vulnerabilityMatch({
        id: "CVE-2026-5678",
        name: "unclassified-package",
        severity: "Medium",
        fixState: "not-fixed",
        fixVersions: [],
        knownExploited: [{ cve: "CVE-2026-5678", dateAdded: "2026-08-01" }],
      }),
    ]),
  });
  assert.equal(unknownKev.decision, "reject");
  assert.deepEqual(unknownKev.findings[0].blockReasons, ["applicable-cisa-kev"]);
});

test("rejects stale, missing, incompatible, and unavailable database evidence", () => {
  const stale = databaseEvidence({ built: "2026-08-01T00:00:00Z" });
  assert.throws(() => evaluate({ ...stale }), /stale/);
  assert.throws(() => evaluate({ status: null }), /must be an object/);

  const incompatible = databaseEvidence({ schemaVersion: "v5.0.0" });
  assert.throws(() => evaluate({ ...incompatible }), /incompatible/);

  const invalid = databaseEvidence({ valid: false });
  assert.throws(() => evaluate({ ...invalid }), /not valid/);
});

test("rejects malformed scan evidence", () => {
  assert.throws(() => evaluate({ scan: { descriptor: {} } }), /must contain matches/);
  assert.throws(() => evaluate({ scan: { ...scan(), ignoredMatches: null } }), /ignoredMatches array/);
  assert.throws(
    () => evaluate({ scan: { ...scan(), descriptor: { name: "grype", version: "unexpected" } } }),
    /must identify grype/,
  );
});

test("rejects every scanner-side ignored match", () => {
  assert.throws(
    () =>
      evaluate({
        scan: {
          ...scan(),
          ignoredMatches: [{ match: vulnerabilityMatch(), appliedIgnoreRules: [{ vulnerability: "*" }] }],
        },
      }),
    /scanner-side ignores are forbidden/,
  );
});

test("accepts a valid exact OpenVEX exception and preserves the finding", () => {
  const result = evaluate({ scan: scan([vulnerabilityMatch()]), vex: vex() });
  assert.equal(result.decision, "accept");
  assert.equal(result.counts.suppressed, 1);
  assert.equal(result.findings[0].decision, "suppressed");
  assert.deepEqual(result.findings[0].blockReasons, ["applicable-fixable-critical"]);
});

test("rejects expired, malformed, broad, and nonmatching OpenVEX exceptions", () => {
  const criticalScan = scan([vulnerabilityMatch()]);
  assert.throws(
    () =>
      evaluate({
        scan: criticalScan,
        vex: vex([
          vexStatement({
            status_notes: vexStatement().status_notes.replace("2026-09-01", "2026-08-12"),
          }),
        ]),
      }),
    /expired/,
  );
  assert.throws(
    () => evaluate({ scan: criticalScan, vex: vex([vexStatement({ status_notes: "missing metadata" })]) }),
    /status_notes must contain exactly one/,
  );
  assert.throws(
    () =>
      evaluate({
        scan: criticalScan,
        vex: vex([
          vexStatement({
            products: [
              { "@id": "pkg:npm/runtime-package@1.0.0" },
              { "@id": "pkg:npm/other@1.0.0" },
            ],
          }),
        ]),
      }),
    /exactly one product/,
  );
  assert.throws(
    () =>
      evaluate({
        scan: criticalScan,
        vex: vex([vexStatement({ products: [{ "@id": "pkg:npm/other@1.0.0" }] })]),
      }),
    /does not match any finding/,
  );
});
