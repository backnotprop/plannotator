import { readFileSync, writeFileSync } from "node:fs";

type ZapAlert = {
  pluginid?: string;
  alertRef?: string;
  alert?: string;
  riskdesc?: string;
  instances?: unknown[];
};

type ZapSite = {
  "@name"?: string;
  "@host"?: string;
  alerts?: ZapAlert[];
};

type ZapReport = {
  site?: ZapSite[];
};

export type AlertSummary = {
  total: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
  unknown: number;
};

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

export function parseZapReport(raw: string, label: string): ZapReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${String(error)}`);
  }
  assertRecord(parsed, label);
  if (!Array.isArray(parsed.site)) {
    throw new Error(`${label} does not contain a site array.`);
  }
  for (const [index, site] of parsed.site.entries()) {
    assertRecord(site, `${label} site ${index}`);
    if (!Array.isArray(site.alerts)) {
      throw new Error(
        `${label} site ${index} does not contain an alerts array.`,
      );
    }
  }
  return parsed as ZapReport;
}

export function flattenAlerts(report: ZapReport): ZapAlert[] {
  return (report.site ?? []).flatMap((site) => site.alerts ?? []);
}

export function assertExpectedHost(
  report: ZapReport,
  expectedHost: string,
): void {
  const hosts = (report.site ?? []).map((site, index) => {
    if (site["@host"]) return site["@host"];
    if (!site["@name"]) {
      throw new Error(`ZAP report site ${index} does not identify its host.`);
    }
    try {
      return new URL(site["@name"]).hostname;
    } catch {
      throw new Error(`ZAP report site ${index} has an invalid URL.`);
    }
  });
  if (!hosts.includes(expectedHost)) {
    throw new Error(
      `ZAP report does not contain expected host ${expectedHost}.`,
    );
  }
  const unexpectedHosts = [
    ...new Set(hosts.filter((host) => host !== expectedHost)),
  ];
  if (unexpectedHosts.length > 0) {
    throw new Error(
      `ZAP report contains hosts outside the allowlist: ${unexpectedHosts.join(", ")}.`,
    );
  }
}

export function assertAlert(report: ZapReport, ruleId: string): void {
  const found = flattenAlerts(report).some(
    (alert) => alert.pluginid === ruleId || alert.alertRef === ruleId,
  );
  if (!found) {
    throw new Error(`Controlled ZAP fixture did not trigger rule ${ruleId}.`);
  }
}

export function extractCrawledUrlCount(log: string): number {
  const matches = [...log.matchAll(/Total of\s+(\d+)\s+URLs?/gi)];
  if (matches.length === 0) {
    throw new Error("ZAP log does not report how many URLs were crawled.");
  }
  const count = Math.max(...matches.map((match) => Number(match[1])));
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(
      `ZAP reported an invalid crawled URL count: ${String(count)}.`,
    );
  }
  return count;
}

export function assertMinimumCoverage(count: number, minimum: number): void {
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    throw new Error(
      `Minimum URL coverage must be a positive integer; got ${minimum}.`,
    );
  }
  if (count < minimum) {
    throw new Error(`ZAP reached ${count} URLs; expected at least ${minimum}.`);
  }
}

export function assertHealthyZapLog(log: string): void {
  const unhealthyPatterns = [
    /\bERROR\b/,
    /OutOfMemoryError/,
    /greater than the configured response body length/i,
    /failed to start zap/i,
    /no urls found/i,
    /ClientSpiderTask - Task .*failed/i,
    /Data cache size limit is reached/i,
    /No space left on device/i,
  ];
  const matched = unhealthyPatterns.find((pattern) => pattern.test(log));
  if (matched) {
    throw new Error(
      `ZAP engine log contains an unhealthy condition (${matched}).`,
    );
  }
}

export function summarizeAlerts(report: ZapReport): AlertSummary {
  const summary: AlertSummary = {
    total: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
    unknown: 0,
  };
  for (const alert of flattenAlerts(report)) {
    summary.total += 1;
    const risk = (alert.riskdesc ?? "").split(" ", 1)[0].toLowerCase();
    if (risk === "high") summary.high += 1;
    else if (risk === "medium") summary.medium += 1;
    else if (risk === "low") summary.low += 1;
    else if (risk === "informational" || risk === "info")
      summary.informational += 1;
    else summary.unknown += 1;
  }
  return summary;
}

type CliOptions = {
  report: string;
  sentinelReport: string;
  scanLog: string;
  zapLog: string;
  sentinelZapLog: string;
  minimumUrls: number;
  expectedHost: string;
  sentinelRule: string;
  summary: string;
  evidence: string;
};

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error(
        `Expected --name value arguments; received ${args.join(" ")}.`,
      );
    }
    values.set(name.slice(2), value);
  }
  const required = [
    "report",
    "sentinel-report",
    "scan-log",
    "zap-log",
    "sentinel-zap-log",
    "minimum-urls",
    "expected-host",
    "sentinel-rule",
    "summary",
    "evidence",
  ];
  for (const key of required) {
    if (!values.get(key))
      throw new Error(`Missing required argument --${key}.`);
  }
  const minimumUrls = Number(values.get("minimum-urls"));
  if (!Number.isSafeInteger(minimumUrls) || minimumUrls < 1) {
    throw new Error("--minimum-urls must be a positive integer.");
  }
  return {
    report: values.get("report")!,
    sentinelReport: values.get("sentinel-report")!,
    scanLog: values.get("scan-log")!,
    zapLog: values.get("zap-log")!,
    sentinelZapLog: values.get("sentinel-zap-log")!,
    minimumUrls,
    expectedHost: values.get("expected-host")!,
    sentinelRule: values.get("sentinel-rule")!,
    summary: values.get("summary")!,
    evidence: values.get("evidence")!,
  };
}

function markdownSummary(summary: AlertSummary, crawledUrls: number): string {
  return [
    "### OWASP ZAP passive DAST",
    `- URLs crawled: ${crawledUrls}`,
    `- Alert rules: ${summary.total}`,
    `- High: ${summary.high}`,
    `- Medium: ${summary.medium}`,
    `- Low: ${summary.low}`,
    `- Informational: ${summary.informational}`,
    `- Unclassified: ${summary.unknown}`,
    "- Enforcement: monitor mode; scanner, target, coverage, and detector-health failures block the job",
    "- Target: disposable annotate session on an internal Docker network; no production services or credentials",
    "",
  ].join("\n");
}

function main(args: string[]): void {
  const options = parseArgs(args);
  const report = parseZapReport(
    readFileSync(options.report, "utf8"),
    "application report",
  );
  const sentinel = parseZapReport(
    readFileSync(options.sentinelReport, "utf8"),
    "detector-health report",
  );
  assertExpectedHost(report, options.expectedHost);
  assertExpectedHost(sentinel, options.expectedHost);
  assertAlert(sentinel, options.sentinelRule);
  const scanLog = readFileSync(options.scanLog, "utf8");
  const crawledUrls = extractCrawledUrlCount(scanLog);
  assertMinimumCoverage(crawledUrls, options.minimumUrls);
  assertHealthyZapLog(scanLog);
  assertHealthyZapLog(readFileSync(options.zapLog, "utf8"));
  assertHealthyZapLog(readFileSync(options.sentinelZapLog, "utf8"));
  const alertSummary = summarizeAlerts(report);
  writeFileSync(options.summary, markdownSummary(alertSummary, crawledUrls));
  writeFileSync(
    options.evidence,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        commit: process.env.GITHUB_SHA ?? "local",
        workflowRun: process.env.GITHUB_RUN_ID ?? "local",
        generatedAt: new Date().toISOString(),
        scanMode: "passive-baseline",
        target: {
          kind: "disposable-annotate-session",
          host: options.expectedHost,
          outboundNetwork: "blocked-by-internal-docker-network",
          ai: "disabled",
          sharing: "disabled",
          persistence: "disabled",
        },
        scanner: {
          name: "OWASP ZAP",
          version: process.env.ZAP_VERSION ?? "unknown",
          image: process.env.ZAP_IMAGE ?? "unknown",
          responseBodyLimitBytes: 33_554_432,
          databaseCacheKiB: 131_072,
        },
        coverage: {
          crawledUrls,
          minimumRequired: options.minimumUrls,
          seededRoutes: [
            "/",
            "/api/plan",
            "/api/ai/capabilities",
            "/api/definitely-missing",
          ],
        },
        detectorHealth: { rule: options.sentinelRule, status: "detected" },
        disabledRules: [
          {
            id: "10003",
            reason:
              "Dependency CVEs are owned by Trivy/Grype; this rule cannot store evidence for the 20+ MiB single-file bundle.",
          },
          {
            id: "10109",
            reason:
              "Informational modern-app detection stores the entire single-file bundle as evidence and exceeds ZAP's alert-column limit.",
          },
        ],
        findings: alertSummary,
        enforcement: "monitor-findings-fail-closed-health",
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
