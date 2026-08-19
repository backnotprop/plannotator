import { readFile, writeFile } from "node:fs/promises";

export const MAX_DATABASE_AGE_HOURS = 120;
export const SUPPORTED_DATABASE_SCHEMA = 6;
export const OPENVEX_CONTEXT = "https://openvex.dev/ns/v0.2.0";

const VALID_JUSTIFICATIONS = new Set([
  "component_not_present",
  "vulnerable_code_not_present",
  "vulnerable_code_not_in_execute_path",
  "vulnerable_code_cannot_be_controlled_by_adversary",
  "inline_mitigations_already_exist",
]);

function fail(message) {
  throw new Error(message);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value;
}

function parseTimestamp(value, label) {
  requireString(value, label);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} must be an ISO-8601 timestamp`);
  return milliseconds;
}

function parseDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${label} must be an ISO date (YYYY-MM-DD)`);
  }
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(milliseconds)) fail(`${label} is not a valid date`);
  return milliseconds;
}

function databaseChecksumFromUrl(value) {
  const url = new URL(requireString(value, "database status.from"));
  if (url.protocol !== "https:" || url.hostname !== "grype.anchore.io" || !url.pathname.startsWith("/databases/v6/")) {
    fail("database status.from must use the official Grype v6 HTTPS endpoint");
  }
  const checksum = url.searchParams.get("checksum");
  if (!/^sha256:[0-9a-f]{64}$/.test(checksum ?? "")) {
    fail("database status.from must contain a SHA256 checksum");
  }
  return checksum;
}

export function validateDatabaseEvidence({ status, listing, check, now = new Date() }) {
  requireObject(status, "database status");
  if (status.valid !== true) fail("Grype database status is not valid");
  const schema = requireString(status.schemaVersion, "database schemaVersion");
  if (!new RegExp(`^v${SUPPORTED_DATABASE_SCHEMA}\\.`).test(schema)) {
    fail(`Grype database schema ${schema} is incompatible; expected v${SUPPORTED_DATABASE_SCHEMA}.x`);
  }

  const builtMilliseconds = parseTimestamp(status.built, "database built time");
  const nowMilliseconds = now.getTime();
  const ageHours = (nowMilliseconds - builtMilliseconds) / 3_600_000;
  if (ageHours < -1) fail("Grype database build time is unreasonably far in the future");
  if (ageHours > MAX_DATABASE_AGE_HOURS) {
    fail(`Grype database is stale (${ageHours.toFixed(1)}h old; maximum ${MAX_DATABASE_AGE_HOURS}h)`);
  }

  if (!Array.isArray(listing) || listing.length === 0) fail("Grype database listing is missing or empty");
  const active = listing.filter((entry) => entry?.status === "active");
  if (active.length !== 1) fail(`Expected exactly one active Grype database listing, found ${active.length}`);
  const activeEntry = requireObject(active[0], "active database listing");
  if (activeEntry.schemaVersion !== schema || activeEntry.built !== status.built) {
    fail("Grype database status and active listing disagree on schema or build time");
  }

  const sourceChecksum = databaseChecksumFromUrl(status.from);
  if (activeEntry.checksum !== sourceChecksum) fail("Grype database source and listing checksums do not match");

  requireObject(check, "database update check");
  const current = requireObject(check.currentDB, "database update check currentDB");
  if (current.schemaVersion !== schema || current.built !== status.built) {
    fail("Grype database status and update check disagree on the current database");
  }
  if (check.candidateDB !== null || check.updateAvailable !== false) {
    fail("A newer Grype database is available or database update status is ambiguous");
  }

  return {
    schemaVersion: schema,
    built: status.built,
    ageHours: Number(ageHours.toFixed(2)),
    source: status.from,
    checksum: sourceChecksum,
    valid: true,
    updateAvailable: false,
  };
}

function validateApplicability(value) {
  const applicability = requireObject(value, "applicability evidence");
  if (applicability.schemaVersion !== 1) fail("Unsupported applicability evidence schemaVersion");
  for (const field of ["runtimePackageNames", "developmentOnlyPackageNames"]) {
    if (!Array.isArray(applicability[field]) || applicability[field].some((item) => typeof item !== "string")) {
      fail(`Applicability evidence ${field} must be a string array`);
    }
  }
  const runtime = new Set(applicability.runtimePackageNames);
  const development = new Set(applicability.developmentOnlyPackageNames);
  for (const name of runtime) {
    if (development.has(name)) fail(`Package is both runtime and development-only: ${name}`);
  }
  return { applicability, runtime, development };
}

function findingIdentity(match) {
  const artifact = requireObject(match.artifact, "Grype match artifact");
  const vulnerability = requireObject(match.vulnerability, "Grype match vulnerability");
  const id = requireString(vulnerability.id, "vulnerability id");
  const name = requireString(artifact.name, `artifact name for ${id}`);
  const version = requireString(artifact.version, `artifact version for ${id}`);
  const purl = requireString(artifact.purl, `artifact purl for ${id}`);
  const severity = requireString(vulnerability.severity, `severity for ${id}`);
  if (!Array.isArray(vulnerability.fix?.versions)) fail(`fix versions for ${id} must be an array`);
  if (!Array.isArray(vulnerability.knownExploited ?? [])) fail(`knownExploited for ${id} must be an array`);
  if (!Array.isArray(match.relatedVulnerabilities ?? [])) fail(`relatedVulnerabilities for ${id} must be an array`);
  return { artifact, vulnerability, id, name, version, purl, severity };
}

function validateOpenVex(document, now) {
  if (document === null || document === undefined) return [];
  const vex = requireObject(document, "OpenVEX document");
  if (vex["@context"] !== OPENVEX_CONTEXT) fail(`OpenVEX @context must be ${OPENVEX_CONTEXT}`);
  requireString(vex["@id"], "OpenVEX @id");
  requireString(vex.author, "OpenVEX author");
  parseTimestamp(vex.timestamp, "OpenVEX timestamp");
  if (!Number.isInteger(vex.version) || vex.version < 1) fail("OpenVEX version must be a positive integer");
  if (!Array.isArray(vex.statements) || vex.statements.length === 0) {
    fail("An OpenVEX exception document must contain at least one statement");
  }

  return vex.statements.map((value, index) => {
    const label = `OpenVEX statement ${index + 1}`;
    const statement = requireObject(value, label);
    const vulnerability = requireObject(statement.vulnerability, `${label} vulnerability`);
    const vulnerabilityId = requireString(vulnerability.name, `${label} vulnerability name`);
    if (vulnerability["@id"] !== undefined) requireString(vulnerability["@id"], `${label} vulnerability @id`);
    if (!Array.isArray(statement.products) || statement.products.length !== 1) {
      fail(`${label} must name exactly one product; broad exceptions are forbidden`);
    }
    const product = requireObject(statement.products[0], `${label} product`);
    const productId = requireString(product["@id"], `${label} product @id`);
    if (!productId.startsWith("pkg:")) fail(`${label} product must be an exact package URL`);
    if (statement.status !== "not_affected") fail(`${label} status must be not_affected`);
    if (!VALID_JUSTIFICATIONS.has(statement.justification)) {
      fail(`${label} justification is missing or is not an OpenVEX not_affected justification`);
    }
    requireString(statement.impact_statement, `${label} impact_statement`);
    const created = parseTimestamp(statement.timestamp, `${label} timestamp`);
    const statusNotes = requireString(statement.status_notes, `${label} status_notes`);
    const metadata = new Map();
    for (const line of statusNotes.split("\n")) {
      const match = line.match(/^plannotator-(owner|evidence|expires): (.+)$/);
      if (!match || metadata.has(match[1])) {
        fail(`${label} status_notes must contain exactly one owner, evidence, and expires line`);
      }
      metadata.set(match[1], match[2]);
    }
    if (metadata.size !== 3) fail(`${label} status_notes is missing owner, evidence, or expires metadata`);
    const owner = requireString(metadata.get("owner"), `${label} owner`);
    const evidence = requireString(metadata.get("evidence"), `${label} evidence`);
    const evidenceUrl = new URL(evidence);
    if (evidenceUrl.protocol !== "https:") fail(`${label} evidence must be an HTTPS URL`);
    const expiresText = metadata.get("expires");
    const expires = parseDate(expiresText, `${label} expires`);
    if (created > now.getTime()) fail(`${label} created date is in the future`);
    if (expires < now.getTime()) fail(`${label} expired on ${expiresText}`);
    if (expires <= created) fail(`${label} expires must be after created`);

    return { vulnerabilityId, productId, owner, evidence, created: statement.timestamp, expires: expiresText };
  });
}

function aliasesFor(match) {
  const aliases = new Set([match.vulnerability.id]);
  for (const related of match.relatedVulnerabilities ?? []) {
    if (typeof related?.id === "string") aliases.add(related.id);
  }
  for (const exploited of match.vulnerability.knownExploited ?? []) {
    if (typeof exploited?.cve === "string") aliases.add(exploited.cve);
  }
  return aliases;
}

function isKev(match) {
  if ((match.vulnerability.knownExploited ?? []).length > 0) return true;
  return (match.relatedVulnerabilities ?? []).some((related) => (related?.knownExploited ?? []).length > 0);
}

function exceptionFor(match, exceptions) {
  const aliases = aliasesFor(match);
  return exceptions.find(
    (exception) => aliases.has(exception.vulnerabilityId) && exception.productId === match.artifact.purl,
  );
}

export function evaluatePolicy({ scan, status, listing, check, applicability, vex = null, now = new Date(), grypeVersion }) {
  const database = validateDatabaseEvidence({ status, listing, check, now });
  const { runtime, development } = validateApplicability(applicability);
  const document = requireObject(scan, "Grype scan evidence");
  if (
    !Array.isArray(document.matches) ||
    (document.ignoredMatches !== undefined && !Array.isArray(document.ignoredMatches))
  ) {
    fail("Grype scan evidence must contain matches and, when present, an ignoredMatches array");
  }
  if ((document.ignoredMatches ?? []).length > 0) {
    fail(`Grype scan suppressed ${document.ignoredMatches.length} match(es); scanner-side ignores are forbidden`);
  }
  const descriptor = requireObject(document.descriptor, "Grype scan descriptor");
  if (descriptor.name !== "grype" || descriptor.version !== grypeVersion) {
    fail(`Grype scan descriptor must identify grype ${grypeVersion}`);
  }
  const scanDatabase = requireObject(descriptor.db?.status, "Grype scan database status");
  if (
    scanDatabase.valid !== true ||
    scanDatabase.schemaVersion !== database.schemaVersion ||
    scanDatabase.built !== database.built ||
    scanDatabase.from !== database.source
  ) {
    fail("Grype scan did not use the separately validated database evidence");
  }

  const exceptions = validateOpenVex(vex, now);
  const matchedExceptions = new Set();
  const findings = document.matches.map((match) => {
    const identity = findingIdentity(match);
    const applicabilityClass = runtime.has(identity.name)
      ? "runtime"
      : development.has(identity.name)
        ? "development-only"
        : "unknown";
    const confidence = applicabilityClass === "unknown" ? "unknown" : "conservative-name-match";
    const kev = isKev(match);
    const fixable = identity.vulnerability.fix.state === "fixed" && identity.vulnerability.fix.versions.length > 0;
    const exception = exceptionFor(match, exceptions);
    if (exception) matchedExceptions.add(exception);

    const blockReasons = [];
    const conservativelyApplicable = applicabilityClass !== "development-only";
    if (conservativelyApplicable && kev) blockReasons.push("applicable-cisa-kev");
    if (conservativelyApplicable && identity.severity === "Critical" && fixable) {
      blockReasons.push("applicable-fixable-critical");
    }

    return {
      vulnerability: identity.id,
      aliases: [...aliasesFor(match)].sort(),
      severity: identity.severity,
      package: { name: identity.name, version: identity.version, purl: identity.purl },
      applicability: applicabilityClass,
      confidence,
      fix: { state: identity.vulnerability.fix.state, versions: identity.vulnerability.fix.versions },
      cisaKev: kev,
      decision: blockReasons.length > 0 && !exception ? "block" : exception ? "suppressed" : "report",
      blockReasons,
      exception: exception
        ? { owner: exception.owner, evidence: exception.evidence, created: exception.created, expires: exception.expires }
        : null,
    };
  });

  for (const exception of exceptions) {
    if (!matchedExceptions.has(exception)) {
      fail(`OpenVEX exception does not match any finding: ${exception.vulnerabilityId} / ${exception.productId}`);
    }
  }

  const counts = {
    total: findings.length,
    blocked: findings.filter((finding) => finding.decision === "block").length,
    suppressed: findings.filter((finding) => finding.decision === "suppressed").length,
    reportOnly: findings.filter((finding) => finding.decision === "report").length,
    runtime: findings.filter((finding) => finding.applicability === "runtime").length,
    developmentOnly: findings.filter((finding) => finding.applicability === "development-only").length,
    unknown: findings.filter((finding) => finding.applicability === "unknown").length,
    critical: findings.filter((finding) => finding.severity === "Critical").length,
    high: findings.filter((finding) => finding.severity === "High").length,
    cisaKev: findings.filter((finding) => finding.cisaKev).length,
  };

  return {
    schemaVersion: 1,
    decision: counts.blocked === 0 ? "accept" : "reject",
    policy: {
      block: ["runtime-or-unknown CISA KEV", "runtime-or-unknown fixable Critical"],
      report: ["High", "development-only", "no-fix Critical"],
      maximumDatabaseAgeHours: MAX_DATABASE_AGE_HOURS,
    },
    scanner: { name: "grype", version: grypeVersion },
    database,
    counts,
    findings,
    ignoredMatches: document.ignoredMatches ?? [],
  };
}

export function formatSummary(result) {
  const lines = [
    "## Release vulnerability policy",
    "",
    `**Decision:** ${result.decision === "accept" ? "ACCEPT" : "REJECT"}`,
    "",
    `Grype ${result.scanner.version}; database ${result.database.schemaVersion}, built ${result.database.built} (${result.database.ageHours}h old).`,
    "",
    `Findings: ${result.counts.total} total; ${result.counts.blocked} blocked; ${result.counts.suppressed} suppressed; ${result.counts.high} High; ${result.counts.critical} Critical; ${result.counts.cisaKev} CISA KEV.`,
    "",
    `Applicability: ${result.counts.runtime} runtime; ${result.counts.developmentOnly} development-only; ${result.counts.unknown} unknown.`,
    "",
    "The gate blocks runtime or unknown-applicability CISA KEV and fixable Critical findings. High, development-only, and no-fix Critical findings remain visible but report-only.",
  ];
  if (result.counts.blocked > 0) {
    lines.push("", "### Blocking findings", "");
    for (const finding of result.findings.filter((item) => item.decision === "block")) {
      lines.push(
        `- ${finding.vulnerability}: ${finding.package.name}@${finding.package.version} (${finding.blockReasons.join(", ")})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) fail(`Expected --name value arguments, received: ${argv.join(" ")}`);
    values.set(key.slice(2), value);
  }
  return values;
}

async function readJson(filePath, label) {
  if (!filePath) fail(`Missing ${label} path`);
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is missing or malformed: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const vexPath = args.get("vex");
  const result = evaluatePolicy({
    scan: await readJson(args.get("scan"), "Grype scan evidence"),
    status: await readJson(args.get("db-status"), "database status evidence"),
    listing: await readJson(args.get("db-list"), "database listing evidence"),
    check: await readJson(args.get("db-check"), "database update evidence"),
    applicability: await readJson(args.get("applicability"), "applicability evidence"),
    vex: vexPath ? await readJson(vexPath, "OpenVEX exceptions") : null,
    grypeVersion: args.get("grype-version"),
  });
  if (!args.get("output") || !args.get("summary")) fail("Missing --output or --summary path");
  await writeFile(args.get("output"), `${JSON.stringify(result, null, 2)}\n`);
  const summary = formatSummary(result);
  await writeFile(args.get("summary"), summary);
  console.log(summary);
  if (result.decision !== "accept") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Grype policy evidence error: ${error.message}`);
    process.exitCode = 1;
  });
}
