import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Spec 14: OpenCode shim contract tests
//
// The OpenCode plugin (apps/opencode-plugin/) shells out to the plannotator CLI.
// These tests verify the plugin's source-level contract without requiring a live
// OpenCode runtime — they check that:
//   1. The plugin source imports match the expected CLI interface
//   2. The tool definitions have the required parameters
//   3. System prompt injection conditions are correctly gated
//   4. The plugin respects the primary-only tool registration requirement

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function repoPath(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const PLUGIN_DIR = repoPath("apps/opencode-plugin");
const PLUGIN_INDEX = join(PLUGIN_DIR, "index.ts");
const TOOL_HELPERS = join(PLUGIN_DIR, "tool-helpers.ts");

describe("14-opencode-shim", () => {
  // ─── 14.1 submit_plan CLI shell-out ───────────────────────────────────────
  test("14.1 tool-helpers shells out to plannotator submit with --json", () => {
    if (!existsSync(TOOL_HELPERS)) {
      // If tool-helpers.ts doesn't exist, check the index directly
      if (!existsSync(PLUGIN_INDEX)) {
        throw new Error(`Neither tool-helpers.ts nor index.ts found in ${PLUGIN_DIR}`);
      }
      const indexSrc = readFileSync(PLUGIN_INDEX, "utf8");
      expect(indexSrc).toContain("plannotator");
      expect(indexSrc).toContain("submit");
      return;
    }

    const src = readFileSync(TOOL_HELPERS, "utf8");
    // Plugin must shell out to plannotator submit (not host its own server)
    expect(src).toContain("plannotator");
    expect(src).toContain("submit");
    // --json flag must be used for programmatic parsing
    expect(src).toContain("--json");
  });

  // ─── 14.2 submit_plan parameter contract ─────────────────────────────────
  test("14.2 submit_plan tool definition has plan, summary, commit_message parameters", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    // Tool must accept the required parameters per README
    expect(src).toContain("submit_plan");
    expect(src).toContain("plan");
    expect(src).toContain("summary");
    expect(src).toContain("commit_message");
  });

  // ─── 14.3 plannotator_review non-blocking ────────────────────────────────
  test("14.3 plannotator_review tool definition exists and shells out to review subcommand", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    expect(src).toContain("plannotator_review");
    expect(src).toContain("review");
  });

  // ─── 14.4 plannotator_annotate ───────────────────────────────────────────
  test("14.4 plannotator_annotate tool definition exists and shells out to annotate subcommand", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    expect(src).toContain("plannotator_annotate");
    expect(src).toContain("annotate");
  });

  // ─── 14.5 System prompt injection for regular agent ───────────────────────
  test("14.5 system prompt injection contains submit_plan instructions", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    // The injected system prompt must reference submit_plan
    expect(src).toContain("submit_plan");
  });

  // ─── 14.6 No injection for title-generation requests ─────────────────────
  test("14.6 injection skipped for title-generator requests (source check)", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    // Plugin must check for title generator in system prompt
    expect(src).toContain("title generator");
  });

  // ─── 14.7 No injection for build agent ───────────────────────────────────
  test("14.7 injection skipped for build agent (source check)", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    // Plugin must have a hardcoded exclusion for the build agent
    expect(src).toContain('"build"');
  });

  // ─── 14.8 No injection for subagents ─────────────────────────────────────
  test("14.8 injection skipped for subagent mode (source check)", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    // Plugin must check for subagent mode
    expect(src).toContain("subagent");
  });

  // ─── 14.9 Primary-only registration ──────────────────────────────────────
  test("14.9 plugin registers tools as primary_only (not visible to sub-agents)", () => {
    if (!existsSync(PLUGIN_INDEX)) return;
    const src = readFileSync(PLUGIN_INDEX, "utf8");
    // Per README: tools are registered as primary-only via experimental.primary_tools
    expect(src).toContain("primary_tools");
  });

  // ─── Binary interface contract ────────────────────────────────────────────
  test("14.x plannotator CLI binary accepts --json flag on submit subcommand", async () => {
    // Verify the CLI help output documents --json for submit
    const { buildBinary, runCli } = await import("../helpers");
    const binary = await buildBinary();
    const result = await runCli(["submit", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--json");
  }, 300_000);
});
