/**
 * Install Script Validation Tests
 *
 * Validates that install scripts produce correct JSON and command structures
 * without actually running the installers.
 *
 * Run: bun test scripts/install.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const scriptsDir = import.meta.dir;

describe("install.sh", () => {
  const script = readFileSync(join(scriptsDir, "install.sh"), "utf-8");

  test("hooks.json heredoc is valid JSON", () => {
    // Extract the JSON between the HOOKS_EOF heredoc markers
    const match = script.match(/cat > "\$PLUGIN_HOOKS" << 'HOOKS_EOF'\n([\s\S]*?)\nHOOKS_EOF/);
    expect(match).toBeTruthy();
    const json = JSON.parse(match![1]);
    expect(json.hooks.PermissionRequest).toBeArray();
    expect(json.hooks.PermissionRequest[0].matcher).toBe("ExitPlanMode");
    expect(json.hooks.PermissionRequest[0].hooks[0].type).toBe("command");
    expect(json.hooks.PermissionRequest[0].hooks[0].command).toBe("plannotator");
    expect(json.hooks.PermissionRequest[0].hooks[0].timeout).toBe(345600);
  });

  test("installs to ~/.local/bin", () => {
    expect(script).toContain('INSTALL_DIR="$HOME/.local/bin"');
  });

  test("verifies checksums", () => {
    expect(script).toContain("shasum -a 256");
    expect(script).toContain("sha256sum");
  });

  test("detects supported platforms", () => {
    expect(script).toContain('Darwin) os="darwin"');
    expect(script).toContain('Linux)  os="linux"');
  });

  test("detects supported architectures", () => {
    expect(script).toContain('x86_64|amd64)   arch="x64"');
    expect(script).toContain('arm64|aarch64)  arch="arm64"');
  });

  test("warns about duplicate hooks", () => {
    expect(script).toContain("DUPLICATE HOOK DETECTED");
    expect(script).toContain('"command".*plannotator');
  });

  test("installs skills via git sparse-checkout", () => {
    expect(script).toContain("git clone --depth 1 --filter=blob:none --sparse");
    expect(script).toContain("git sparse-checkout set apps/skills");
    expect(script).toContain("CLAUDE_SKILLS_DIR");
    expect(script).toContain("AGENTS_SKILLS_DIR");
    expect(script).toContain('Skipping skills install (git not found)');
  });

  test("installs slash commands for Claude Code and OpenCode", () => {
    expect(script).toContain("plannotator-review.md");
    expect(script).toContain("plannotator-annotate.md");
    expect(script).toContain("plannotator-last.md");
    expect(script).toContain("CLAUDE_COMMANDS_DIR");
    expect(script).toContain("OPENCODE_COMMANDS_DIR");
  });
});

describe("install.ps1", () => {
  const script = readFileSync(join(scriptsDir, "install.ps1"), "utf-8");

  test("hooks.json has valid structure", () => {
    // PS1 uses @"..."@ (interpolated) with $exePathJson for full exe path.
    // Verify structural keys since the command value is a dynamic variable.
    expect(script).toContain('"PermissionRequest"');
    expect(script).toContain('"matcher": "ExitPlanMode"');
    expect(script).toContain('"type": "command"');
    expect(script).toContain('"timeout": 345600');
    expect(script).toContain('"command":');
  });

  test("uses full exe path in hooks.json", () => {
    expect(script).toContain("$exePathJson");
    expect(script).toContain(".Replace('\\', '/')");
  });

  test("handles both PS 5.1 and PS 7+ checksum response types", () => {
    expect(script).toContain("[byte[]]");
    expect(script).toContain("UTF8.GetString");
  });

  test("detects ARM64 architecture", () => {
    expect(script).toContain('"ARM64"');
  });

  test("adds to PATH via environment variable", () => {
    expect(script).toContain('SetEnvironmentVariable("Path"');
    expect(script).toContain('"User"');
  });

  test("warns about duplicate hooks", () => {
    expect(script).toContain("DUPLICATE HOOK DETECTED");
  });

  test("installs skills via git sparse-checkout", () => {
    expect(script).toContain("git clone --depth 1 --filter=blob:none --sparse");
    expect(script).toContain("git sparse-checkout set apps/skills");
    expect(script).toContain("claudeSkillsDir");
    expect(script).toContain("agentsSkillsDir");
    expect(script).toContain('Skipping skills install (git not found)');
  });

  test("installs slash commands", () => {
    expect(script).toContain("plannotator-review.md");
    expect(script).toContain("plannotator-annotate.md");
    expect(script).toContain("plannotator-last.md");
  });
});

describe("install.cmd", () => {
  const script = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");

  test("hooks.json echo block produces valid JSON structure", () => {
    // The .cmd file uses echo statements to produce JSON.
    expect(script).toContain('echo   "hooks": {');
    expect(script).toContain('echo     "PermissionRequest": [');
    expect(script).toContain('echo         "matcher": "ExitPlanMode",');
    expect(script).toContain('echo             "type": "command",');
    expect(script).toContain('echo             "command":');
    expect(script).toContain('echo             "timeout": 345600');
  });

  test("uses full exe path in hooks.json", () => {
    expect(script).toContain("EXE_PATH");
    expect(script).toContain('!INSTALL_PATH:\\=/!');
  });

  test("verifies checksums with certutil", () => {
    expect(script).toContain("certutil -hashfile");
    expect(script).toContain("SHA256");
  });

  test("checks for 64-bit Windows", () => {
    expect(script).toContain("AMD64");
    expect(script).toContain("ARM64");
    expect(script).toContain("PROCESSOR_ARCHITEW6432"); // WoW64 detection
  });

  test("warns about duplicate hooks", () => {
    expect(script).toContain("DUPLICATE HOOK DETECTED");
  });

  test("installs skills via git sparse-checkout", () => {
    expect(script).toContain("git clone --depth 1 --filter=blob:none --sparse");
    expect(script).toContain("git sparse-checkout set apps/skills");
    expect(script).toContain("CLAUDE_SKILLS_DIR");
    expect(script).toContain("AGENTS_SKILLS_DIR");
    expect(script).toContain("Skipping skills install");
  });

  test("installs slash commands", () => {
    expect(script).toContain("plannotator-review.md");
    expect(script).toContain("plannotator-annotate.md");
    expect(script).toContain("plannotator-last.md");
  });

  test("Gemini settings merge uses || idiom (issue #506 regression)", () => {
    // cmd's delayed expansion parser eats `!` operators in `node -e "..."`
    // blocks, turning `if(!s.hooks)` into a broken variable expansion and
    // crashing node. The merge script must use `x = x || {}` instead, which
    // contains no `!` chars. See backnotprop/plannotator#506.
    expect(script).toContain("s.hooks=s.hooks||{}");
    expect(script).toContain("s.hooks.BeforeTool=s.hooks.BeforeTool||[]");
    expect(script).not.toContain("if(!s.hooks)");
    expect(script).not.toContain("if(!s.hooks.BeforeTool)");
  });

  test("attestation verification is off by default with three-layer opt-in", () => {
    // Layer 3: config file read (verifyAttestation appears inside a
    // findstr pattern with escaped quotes; assert the key + findstr
    // separately rather than the quoted form)
    expect(script).toContain("%USERPROFILE%\\.plannotator\\config.json");
    expect(script).toContain("verifyAttestation");
    expect(script).toContain("findstr");
    // Layer 2: env var
    expect(script).toContain("PLANNOTATOR_VERIFY_ATTESTATION");
    // Layer 1: CLI flags
    expect(script).toContain("--verify-attestation");
    expect(script).toContain("--skip-attestation");
    // Enforcement: hard-fail when opted in but gh missing
    expect(script).toContain("gh CLI was not found");
  });
});

describe("install shared behavior", () => {
  const sh = readFileSync(join(scriptsDir, "install.sh"), "utf-8");
  const ps = readFileSync(join(scriptsDir, "install.ps1"), "utf-8");

  test("install.sh has three-layer opt-in resolution", () => {
    // Layer 3: config file via grep against the flat JSON boolean
    expect(sh).toContain("$HOME/.plannotator/config.json");
    expect(sh).toContain('"verifyAttestation"');
    // Layer 2: env var parsing
    expect(sh).toContain("PLANNOTATOR_VERIFY_ATTESTATION");
    // Layer 1: CLI flags with sentinel
    expect(sh).toContain("--verify-attestation");
    expect(sh).toContain("--skip-attestation");
    expect(sh).toContain("VERIFY_ATTESTATION_FLAG");
    // Enforcement
    expect(sh).toContain("gh CLI was not found");
  });

  test("install.ps1 has three-layer opt-in resolution", () => {
    // Layer 3: config file via ConvertFrom-Json
    expect(ps).toContain("$env:USERPROFILE\\.plannotator\\config.json");
    expect(ps).toContain("ConvertFrom-Json");
    expect(ps).toContain("$cfg.verifyAttestation");
    // Layer 2: env var
    expect(ps).toContain("PLANNOTATOR_VERIFY_ATTESTATION");
    // Layer 1: CLI flags
    expect(ps).toContain("[switch]$VerifyAttestation");
    expect(ps).toContain("[switch]$SkipAttestation");
    // Enforcement
    expect(ps).toContain("gh CLI was not found");
  });

  test("install.sh gates gh verification behind verify_attestation guard", () => {
    // When the opt-in is off, the installer must print the SHA256-only info
    // line and must not invoke gh.
    expect(sh).toContain('if [ "$verify_attestation" -eq 1 ]; then');
    expect(sh).toContain("SHA256 verified");
    // The executable `gh attestation verify "$tmp_file"` call (not the
    // mention in the --help usage block) must live inside the guarded branch.
    const guardIdx = sh.indexOf('if [ "$verify_attestation" -eq 1 ]');
    const execIdx = sh.indexOf('gh attestation verify "$tmp_file"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(guardIdx);
  });
});

describe("PlannotatorConfig schema", () => {
  test("exports verifyAttestation field", () => {
    const configTs = readFileSync(
      join(scriptsDir, "..", "packages", "shared", "config.ts"),
      "utf-8",
    );
    expect(configTs).toContain("verifyAttestation?: boolean");
    // Confirm it's part of the PlannotatorConfig interface, not unrelated code.
    const match = configTs.match(
      /export interface PlannotatorConfig \{([\s\S]*?)\n\}/
    );
    expect(match).toBeTruthy();
    expect(match![1]).toContain("verifyAttestation?: boolean");
  });
});
