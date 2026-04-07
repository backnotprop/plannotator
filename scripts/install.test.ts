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

  test("install.sh/cmd reject dash-prefixed --version values and positional overwrites", () => {
    // Regression guard for PR #512 review cycle 4 findings:
    //   - `install.sh --version --verify-attestation` used to set VERSION
    //     to the flag name and then 404 on download
    //   - `install.sh --version v1.0.0 stray` used to silently overwrite
    //     VERSION with "stray"
    // Same pair of bugs existed in install.cmd. Both scripts now track
    // VERSION_EXPLICIT and dash-check the value after --version.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");

    // install.sh
    expect(sh).toContain("VERSION_EXPLICIT=0");
    expect(sh).toContain('echo "--version requires a tag value, got flag:');
    expect(sh).toContain('echo "Unexpected positional argument:');

    // install.cmd
    expect(cmdScript).toContain('set "VERSION_EXPLICIT=0"');
    expect(cmdScript).toContain("--version requires a tag value, got flag:");
    expect(cmdScript).toContain("Unexpected positional argument:");
  });

  test("install.ps1 writes gh error output to stderr via Out-String", () => {
    // Regression guard 1: Write-Host goes to PowerShell's Information
    // stream and is silently dropped when CI pipelines capture stderr.
    // Use the native stderr handle instead. See install.sh:177 and
    // install.cmd for the equivalent stderr writes.
    //
    // Regression guard 2: `& gh ... 2>&1` captures multi-line output as
    // an object[] array. Passing the array directly to
    // [Console]::Error.WriteLine binds to the WriteLine(object) overload,
    // calls ToString() on the array, and yields the literal
    // "System.Object[]" instead of the actual gh diagnostic — silently
    // hiding exactly the error message this code path is supposed to
    // surface. Must be normalized via Out-String first.
    // Tighter assertion: the Out-String must be wired specifically on
    // the $verifyOutput path, not just present somewhere in the file.
    expect(ps).toMatch(/\$verifyOutput\s*\|\s*Out-String/);
    expect(ps).toContain("[Console]::Error.WriteLine");
    expect(ps).not.toContain("Write-Host $verifyOutput");
  });

  test("all installers reject --verify-attestation + --skip-attestation together", () => {
    // Regression guard: passing both flags used to behave inconsistently
    // across the three installers (bash/cmd took last-wins by command-
    // line order; ps1 took a fixed SkipAttestation-always-wins). No sane
    // user passes both, so the right behavior is to reject the ambiguous
    // combination upfront with a clean "mutually exclusive" error.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");

    // install.sh — guards in both --verify-attestation and --skip-attestation arms
    expect(sh).toContain("mutually exclusive");
    // install.cmd — same guard in both arms
    expect(cmdScript).toContain("mutually exclusive");
    // install.ps1 — one guard right after param block
    expect(ps).toContain("mutually exclusive");
    expect(ps).toMatch(/\$VerifyAttestation -and \$SkipAttestation/);
  });

  test("install.cmd uses randomized temp paths for all curl downloads", () => {
    // Regression guard: fixed temp filenames collide between concurrent
    // invocations and allow same-user symlink pre-placement to redirect
    // curl's output. Every `-o` target in install.cmd must use %RANDOM%.
    // Covers release.json, the binary itself, the checksum sidecar, and
    // the gh attestation output capture.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    expect(cmdScript).toContain("plannotator-release-%RANDOM%.json");
    expect(cmdScript).toContain("plannotator-%RANDOM%.exe");
    expect(cmdScript).toContain("plannotator-checksum-%RANDOM%.txt");
    expect(cmdScript).toContain("plannotator-gh-%RANDOM%.txt");
    // And every fixed-path variant must be gone
    expect(cmdScript).not.toContain("%TEMP%\\release.json");
    expect(cmdScript).not.toContain("%TEMP%\\checksum.txt");
    expect(cmdScript).not.toMatch(/%TEMP%\\plannotator-!TAG!\.exe/);
  });

  test("install.cmd escapes ! in Claude Code slash command echoes", () => {
    // Regression guard: under setlocal enabledelayedexpansion, an unmatched
    // `!` in an echo line is silently stripped from the written file. The
    // Claude Code slash command format requires a `!` prefix before the
    // backtick-delimited shell invocation — without it, the command file
    // is a functional no-op. install.sh and install.ps1 write the `!`
    // correctly via their respective literal-string idioms; install.cmd
    // must use `^!` to escape it from delayed expansion. The Gemini
    // section of install.cmd already does this correctly — the Claude
    // Code section didn't until this fix.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    expect(cmdScript).toContain("echo ^!`plannotator review $ARGUMENTS`");
    expect(cmdScript).toContain("echo ^!`plannotator annotate $ARGUMENTS`");
    expect(cmdScript).toContain("echo ^!`plannotator annotate-last`");
    // And the unescaped forms must be gone
    expect(cmdScript).not.toMatch(/^echo !`plannotator/m);
  });

  test("install.cmd uses substring test (not echo|findstr) for v-prefix normalization", () => {
    // Regression guard: `echo !TAG! | findstr /b "v"` pipes an unquoted
    // expanded variable, re-exposing cmd metacharacters (& | > <) in
    // the value before the pipe parses. Must use the safe substring
    // test pattern used elsewhere in the script.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    expect(cmdScript).toContain('if not "!TAG:~0,1!"=="v"');
    expect(cmdScript).not.toContain("echo !TAG! | findstr");
  });

  test("all installers constrain attestation verify to tag + signer workflow", () => {
    // Every `gh attestation verify` call must pass --source-ref and
    // --signer-workflow, not just --repo. Without --source-ref a
    // misattached asset from a different release would pass; without
    // --signer-workflow an attestation from an unrelated workflow in
    // the same repo would pass. GitHub's own docs recommend both.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");

    for (const [name, script] of [["install.sh", sh], ["install.ps1", ps], ["install.cmd", cmdScript]] as const) {
      if (!script.includes("--source-ref")) {
        throw new Error(`${name} missing --source-ref constraint on gh attestation verify`);
      }
      if (!script.includes("refs/tags/")) {
        throw new Error(`${name} --source-ref does not reference refs/tags/`);
      }
      if (!script.includes("--signer-workflow")) {
        throw new Error(`${name} missing --signer-workflow constraint on gh attestation verify`);
      }
      if (!script.includes(".github/workflows/release.yml")) {
        throw new Error(`${name} --signer-workflow does not reference release.yml`);
      }
    }
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
