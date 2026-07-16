/**
 * Ingestion-phase tests: a provider that exits 0 but returns empty/garbage
 * output fails the job instead of silently showing "done".
 */
import { describe, expect, test } from "bun:test";
import { parseClaudeStreamOutput, transformClaudeFindings, CLAUDE_REVIEW_SCHEMA_JSON, type ClaudeFinding } from "./claude-review";
import { transformReviewFindings, CODEX_REVIEW_SCHEMA, type CodexFinding } from "./codex-review";
import { classifyFindingPlacement } from "@plannotator/shared/external-annotation";
import {
  markJobReviewFailed,
  REVIEW_OUTPUT_FAILED,
  type AgentJobInfo,
} from "@plannotator/shared/agent-jobs";

describe("completion semantics — empty/unparseable output fails the job", () => {
  // Guards the fix: a provider that exits 0 with nothing/garbage must fail the
  // job (REVIEW_OUTPUT_FAILED), not silently leave it "done" with no findings.
  test("parseClaudeStreamOutput returns null for empty/whitespace stdout", () => {
    expect(parseClaudeStreamOutput("")).toBeNull();
    expect(parseClaudeStreamOutput("   \n  ")).toBeNull();
  });

  test("parseClaudeStreamOutput returns null for unparseable stdout", () => {
    expect(parseClaudeStreamOutput("not json\n{ broken")).toBeNull();
  });

  test("markJobReviewFailed flips the job to failed with a calm, leak-free reason", () => {
    const job = { status: "running" } as unknown as AgentJobInfo;
    markJobReviewFailed(job, REVIEW_OUTPUT_FAILED);
    expect(job.status).toBe("failed");
    expect(job.error).toBe(REVIEW_OUTPUT_FAILED);
    // No schema/CLI internals leaked in the user-facing reason.
    expect(REVIEW_OUTPUT_FAILED).not.toContain("stdout");
    expect(REVIEW_OUTPUT_FAILED).not.toContain("JSON");
  });
});

describe("placement classifier — file + line, file only, or general", () => {
  test("file and a usable line → line", () => {
    expect(classifyFindingPlacement("src/a.ts", 10, 12)).toEqual({
      scope: "line", filePath: "src/a.ts", lineStart: 10, lineEnd: 12,
    });
  });

  test("end line defaults to start when absent", () => {
    expect(classifyFindingPlacement("src/a.ts", 10, undefined)).toEqual({
      scope: "line", filePath: "src/a.ts", lineStart: 10, lineEnd: 10,
    });
  });

  test("file but no line → file (line zeroed)", () => {
    expect(classifyFindingPlacement("src/a.ts", undefined, undefined)).toEqual({
      scope: "file", filePath: "src/a.ts", lineStart: 0, lineEnd: 0,
    });
  });

  test("no file → general (path and line zeroed)", () => {
    expect(classifyFindingPlacement("", 10, 12)).toEqual({
      scope: "general", filePath: "", lineStart: 0, lineEnd: 0,
    });
  });
});

describe("Codex schema is OpenAI strict-mode compliant", () => {
  // Regression: OpenAI structured output requires every property of an object
  // with additionalProperties:false to appear in `required`. Optional fields
  // must be nullable-and-required, not omitted from `required`. Dropping a key
  // (e.g. line_range) from `required` makes codex exec fail with a 400 before
  // the review runs.
  function assertStrict(node: any, path: string): void {
    if (!node || typeof node !== "object") return;
    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    if (types.includes("object") && node.properties) {
      expect(node.additionalProperties, `${path}: additionalProperties must be false`).toBe(false);
      const props = Object.keys(node.properties);
      const required: string[] = node.required ?? [];
      for (const p of props) {
        expect(required, `${path}: property "${p}" must be in required`).toContain(p);
        assertStrict(node.properties[p], `${path}.${p}`);
      }
    }
    if (types.includes("array") && node.items) assertStrict(node.items, `${path}[]`);
  }

  test("Codex schema: every object property is required (nullable, never omitted)", () => {
    assertStrict(JSON.parse(CODEX_REVIEW_SCHEMA), "codex");
  });

  test("Claude schema: every object property is required (nullable, never omitted)", () => {
    assertStrict(JSON.parse(CLAUDE_REVIEW_SCHEMA_JSON), "claude");
  });
});

describe("transforms route every finding — nothing is dropped", () => {
  test("Claude: a finding with no file/line becomes a general comment, not a drop", () => {
    const findings: ClaudeFinding[] = [
      { severity: "important", file: "src/a.ts", line: 3, end_line: 4, description: "bug", reasoning: "r" },
      { severity: "nit", file: "src/b.ts", description: "whole file", reasoning: "r" },
      { severity: "important", description: "overall approach is off", reasoning: "r" },
    ];
    const out = transformClaudeFindings(findings, "claude");
    expect(out).toHaveLength(3);
    expect(out.map(a => a.scope)).toEqual(["line", "file", "general"]);
    expect(out[2].filePath).toBe("");
  });

  test("Codex: missing code_location becomes general, missing line_range becomes file", () => {
    const findings: CodexFinding[] = [
      { title: "[P1] x", body: "b", confidence_score: 1, priority: 1, code_location: { absolute_file_path: "/repo/src/a.ts", line_range: { start: 2, end: 5 } } },
      { title: "[P2] y", body: "b", confidence_score: 1, priority: 2, code_location: { absolute_file_path: "/repo/src/b.ts" } },
      { title: "[P2] z", body: "b", confidence_score: 1, priority: 2 },
    ];
    const out = transformReviewFindings(findings, "codex", "/repo");
    expect(out).toHaveLength(3);
    expect(out.map(a => a.scope)).toEqual(["line", "file", "general"]);
  });
});
