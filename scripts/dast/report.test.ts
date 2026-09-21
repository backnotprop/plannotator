import { describe, expect, test } from "bun:test";
import {
  assertAlert,
  assertExpectedHost,
  assertHealthyZapLog,
  assertMinimumCoverage,
  extractCrawledUrlCount,
  parseZapReport,
  summarizeAlerts,
} from "./report";

const report = parseZapReport(
  JSON.stringify({
    site: [
      {
        "@name": "http://plannotator-dast-target:19432",
        "@host": "plannotator-dast-target",
        alerts: [
          { pluginid: "10020", riskdesc: "Low (Medium)", instances: [{}] },
          { alertRef: "10038", riskdesc: "Medium (High)", instances: [{}] },
          { pluginid: "90000", riskdesc: "Informational (Low)", instances: [] },
        ],
      },
    ],
  }),
  "fixture",
);

describe("DAST report validation", () => {
  test("validates the target host and controlled rule", () => {
    expect(() =>
      assertExpectedHost(report, "plannotator-dast-target"),
    ).not.toThrow();
    expect(() => assertAlert(report, "10020")).not.toThrow();
  });

  test("rejects an absent target or detector-health rule", () => {
    expect(() =>
      assertExpectedHost(report, "production.example.com"),
    ).toThrow();
    expect(() => assertAlert(report, "missing-rule")).toThrow();
  });

  test("rejects any report host outside the explicit allowlist", () => {
    const mixedHostReport = parseZapReport(
      JSON.stringify({
        site: [
          { "@host": "plannotator-dast-target", alerts: [] },
          { "@host": "production.example.com", alerts: [] },
        ],
      }),
      "mixed-host fixture",
    );
    expect(() =>
      assertExpectedHost(mixedHostReport, "plannotator-dast-target"),
    ).toThrow("outside the allowlist");
  });

  test("requires evidence that at least one URL was crawled", () => {
    expect(extractCrawledUrlCount("Total of 1 URL\nTotal of 4 URLs")).toBe(4);
    expect(() => extractCrawledUrlCount("scan completed")).toThrow();
    expect(() => extractCrawledUrlCount("Total of 0 URLs")).toThrow();
    expect(() => assertMinimumCoverage(9, 8)).not.toThrow();
    expect(() => assertMinimumCoverage(7, 8)).toThrow();
  });

  test("rejects scanner-engine errors even when reports exist", () => {
    expect(() => assertHealthyZapLog("INFO scan complete")).not.toThrow();
    expect(() => assertHealthyZapLog("ERROR database write failed")).toThrow();
    expect(() =>
      assertHealthyZapLog(
        "The actual Response Body length 20000000 is greater than the configured response body length 16777216",
      ),
    ).toThrow();
    expect(() =>
      assertHealthyZapLog(
        "WARN ClientSpiderTask - Task 1 failed Unable to obtain driver",
      ),
    ).toThrow();
    expect(() =>
      assertHealthyZapLog("WARN Data cache size limit is reached: 32000"),
    ).toThrow();
    expect(() =>
      assertHealthyZapLog("java.io.IOException: No space left on device"),
    ).toThrow();
  });

  test("summarizes alert rules by risk", () => {
    expect(summarizeAlerts(report)).toEqual({
      total: 3,
      high: 0,
      medium: 1,
      low: 1,
      informational: 1,
      unknown: 0,
    });
  });

  test("rejects malformed or empty reports", () => {
    expect(() => parseZapReport("not-json", "bad report")).toThrow();
    expect(() => parseZapReport("{}", "empty report")).toThrow();
    expect(() => parseZapReport('{"site":[{}]}', "bad site")).toThrow();
  });
});
