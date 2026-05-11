/**
 * Install Script Validation Tests
 *
 * Validates that install scripts produce correct JSON and command structures
 * without actually running the installers.
 *
 * Run: bun test scripts/install.test.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
    // EnterPlanMode hook drives the compound-skill improvement-hook injection.
    // It must be re-emitted on every install — see apps/hook/hooks/hooks.json.
    expect(json.hooks.PreToolUse).toBeArray();
    expect(json.hooks.PreToolUse[0].matcher).toBe("EnterPlanMode");
    expect(json.hooks.PreToolUse[0].hooks[0].type).toBe("command");
    expect(json.hooks.PreToolUse[0].hooks[0].command).toBe("plannotator improve-context");
    expect(json.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
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
    expect(script).toContain("CODEX_SKILLS_DIR");
    expect(script).toContain("AGENTS_SKILLS_DIR");
    expect(script).toContain("$HOME/.codex/skills");
    expect(script).toContain("$HOME/.agents/skills");
    expect(script).toContain("copy_skill_if_present");
    expect(script).toContain('copy_skill_if_present apps/skills/plannotator-review "$CODEX_SKILLS_DIR"');
    expect(script).toContain('copy_skill_if_present apps/skills/plannotator-annotate "$CODEX_SKILLS_DIR"');
    expect(script).toContain('copy_skill_if_present apps/skills/plannotator-last "$CODEX_SKILLS_DIR"');
    expect(script).toContain('copy_skill_if_present apps/skills/plannotator-compound "$AGENTS_SKILLS_DIR"');
    expect(script).toContain('copy_skill_if_present apps/skills/plannotator-setup-goal "$AGENTS_SKILLS_DIR"');
    expect(script).toContain('if [ "$codex_available" -eq 1 ]; then');
    expect(script).not.toContain('cp -r apps/skills/* "$CODEX_SKILLS_DIR/"');
    expect(script).not.toContain('cp -r apps/skills/* "$AGENTS_SKILLS_DIR/"');
    expect(script).not.toContain('cp -r apps/skills/plannotator-review "$CODEX_SKILLS_DIR/"');
    expect(script).toContain('Skipping skills install (git not found)');
  });

  test("cleans only legacy command-overlap agent skills", () => {
    expect(script).toContain("LEGACY_AGENTS_SKILLS_DIR");
    expect(script).toContain("plannotator-review plannotator-annotate plannotator-last");
    expect(script).not.toContain("plannotator-review plannotator-annotate plannotator-last plannotator-compound");
    expect(script).not.toContain("plannotator-review plannotator-annotate plannotator-last plannotator-setup-goal");
  });

  test("removes shared-agent Plannotator skills from Codex scope", () => {
    expect(script).toContain("STALE_CODEX_SKILLS_DIR");
    expect(script).toContain("plannotator-compound plannotator-setup-goal");
  });

  test("installs slash commands for Claude Code and OpenCode", () => {
    expect(script).toContain("plannotator-review.md");
    expect(script).toContain("plannotator-annotate.md");
    expect(script).toContain("plannotator-last.md");
    expect(script).toContain("CLAUDE_COMMANDS_DIR");
    expect(script).toContain("OPENCODE_COMMANDS_DIR");
  });

  test("enables Codex hooks only after Stop hook setup succeeds", () => {
    const hookSetupIndex = script.indexOf('if [ ! -f "$CODEX_HOOKS" ]; then');
    const enableConfigIndex = script.indexOf('enable_codex_hooks_config || true');
    expect(hookSetupIndex).toBeGreaterThan(0);
    expect(enableConfigIndex).toBeGreaterThan(hookSetupIndex);
    expect(script).toContain('codex_hook_configured=1');
    expect(script).toContain('if [ "$codex_hook_configured" -eq 1 ]; then');
    expect(script).toContain("Leaving Codex hook support unchanged");
  });

  test("does not treat a skills-only Codex home as configured", () => {
    expect(script).toContain("codex_home_has_user_config");
    expect(script).toContain("! -name skills");
    expect(script).toContain("codex_available=1");
    expect(script).not.toContain('if command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]; then');
  });

  test("does not rewrite inline Codex features config", () => {
    expect(script).toContain("Codex config uses inline features");
    expect(script).toContain('grep -Eq \'^[[:space:]]*features[[:space:]]*=\' "$CODEX_CONFIG"');
  });

  test("preserves custom Codex Plannotator hook wrappers", () => {
    expect(script).toContain("isManagedPlannotatorCommand");
    expect(script).toContain("foundCustomPlannotatorHook");
    expect(script).toContain("Existing custom Codex Plannotator hook found");
    expect(script).not.toContain('hook.command.includes("plannotator")) {\n      hook.command = command;');
  });

  test("configures Pi to skip bundled skills only after shared skills exist", () => {
    expect(script).toContain("configure_pi_plannotator_package_filter");
    expect(script).toContain("plannotator_shared_agent_skills_available");
    expect(script).toContain("PI_CODING_AGENT_DIR");
    expect(script).toContain("npm:@plannotator/pi-extension");
    expect(script).toContain("return { source: entry, skills: [] };");
    expect(script).toContain("Leaving Pi bundled skills enabled (global Plannotator agent skills not found).");
    expect(script).toContain("Configured Pi to use global Plannotator skills and skip bundled package skills.");
    expect(script).toContain("if plannotator_shared_agent_skills_available; then\n            configure_pi_plannotator_package_filter");

    const skillsInstallIndex = script.indexOf("# Install skills (requires git)");
    const piUpdateCallIndex = script.lastIndexOf("update_pi_extension_if_present");
    expect(skillsInstallIndex).toBeGreaterThan(0);
    expect(piUpdateCallIndex).toBeGreaterThan(skillsInstallIndex);
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
    // EnterPlanMode hook drives the compound-skill improvement-hook injection.
    expect(script).toContain('"PreToolUse"');
    expect(script).toContain('"matcher": "EnterPlanMode"');
    expect(script).toContain('"command": "$exePathJson improve-context"');
    expect(script).toContain('"timeout": 5');
  });

  test("uses full exe path in hooks.json", () => {
    expect(script).toContain("$exePathJson");
    expect(script).toContain(".Replace('\\', '/')");
  });

  test("handles both PS 5.1 and PS 7+ checksum response types", () => {
    expect(script).toContain("[byte[]]");
    expect(script).toContain("UTF8.GetString");
  });

  test("install.ps1 selects native arm64 binary on ARM64 Windows", () => {
    // release.yml now builds bun-windows-arm64 (stable since Bun v1.3.10),
    // so ARM64 hosts get a native binary instead of running the x64 build
    // via Windows emulation. install.ps1 must detect host architecture
    // and set $arch accordingly so the downloaded binary matches the host.
    //
    // Must check BOTH PROCESSOR_ARCHITECTURE and PROCESSOR_ARCHITEW6432 —
    // the latter is set only in 32-bit processes via WoW64 and reflects
    // the host architecture. A 32-bit PowerShell on ARM64 Windows should
    // still get the native arm64 binary. Matches install.cmd's detection.
    expect(script).toContain("PROCESSOR_ARCHITECTURE");
    expect(script).toContain("PROCESSOR_ARCHITEW6432");
    expect(script).toContain('"ARM64"');
    expect(script).toContain('$arch = "arm64"');
    expect(script).toContain('$arch = "x64"');
    // The emulation-fallback workaround from earlier cycles must be gone
    // now that native ARM64 binaries ship.
    expect(script).not.toContain("runs via Windows emulation");
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
    expect(script).toContain("codexSkillsDir");
    expect(script).toContain("agentsSkillsDir");
    expect(script).toContain("$env:USERPROFILE\\.codex\\skills");
    expect(script).toContain("$env:USERPROFILE\\.agents\\skills");
    expect(script).toContain("Copy-SkillIfPresent");
    expect(script).toContain('Copy-SkillIfPresent "apps\\skills\\plannotator-review" $codexSkillsDir');
    expect(script).toContain('Copy-SkillIfPresent "apps\\skills\\plannotator-annotate" $codexSkillsDir');
    expect(script).toContain('Copy-SkillIfPresent "apps\\skills\\plannotator-last" $codexSkillsDir');
    expect(script).toContain('Copy-SkillIfPresent "apps\\skills\\plannotator-compound" $agentsSkillsDir');
    expect(script).toContain('Copy-SkillIfPresent "apps\\skills\\plannotator-setup-goal" $agentsSkillsDir');
    expect(script).toContain("if ($codexAvailable)");
    expect(script).not.toContain('Copy-Item -Recurse -Force "apps\\skills\\*" $codexSkillsDir');
    expect(script).not.toContain('Copy-Item -Recurse -Force "apps\\skills\\*" $agentsSkillsDir');
    expect(script).not.toContain('Copy-Item -Recurse -Force "apps\\skills\\plannotator-review" $codexSkillsDir');
    expect(script).toContain('Skipping skills install (git not found)');
  });

  test("cleans only legacy command-overlap agent skills", () => {
    expect(script).toContain("legacyAgentsSkillsDir");
    expect(script).toContain('"plannotator-review", "plannotator-annotate", "plannotator-last"');
    expect(script).not.toContain('"plannotator-review", "plannotator-annotate", "plannotator-last", "plannotator-compound"');
    expect(script).not.toContain('"plannotator-review", "plannotator-annotate", "plannotator-last", "plannotator-setup-goal"');
  });

  test("removes shared-agent Plannotator skills from Codex scope", () => {
    expect(script).toContain("staleCodexSkillsDir");
    expect(script).toContain('"plannotator-compound", "plannotator-setup-goal"');
  });

  test("does not treat a skills-only Codex home as configured", () => {
    expect(script).toContain("codexHomeHasUserConfig");
    expect(script).toContain('$_.Name -ne "skills"');
    expect(script).toContain("$codexAvailable");
  });

  test("installs slash commands", () => {
    expect(script).toContain("plannotator-review.md");
    expect(script).toContain("plannotator-annotate.md");
    expect(script).toContain("plannotator-last.md");
  });

  test("configures Pi to skip bundled skills only after shared skills exist", () => {
    expect(script).toContain("Configure-PiPlannotatorPackageFilter");
    expect(script).toContain("Test-PlannotatorSharedAgentSkillsAvailable");
    expect(script).toContain("PI_CODING_AGENT_DIR");
    expect(script).toContain("npm:@plannotator/pi-extension");
    expect(script).toContain("skills = @()");
    expect(script).toContain("New-Object System.Text.UTF8Encoding -ArgumentList $false");
    expect(script).toContain("[System.IO.File]::WriteAllText($tmpPath, $json, $utf8NoBom)");
    expect(script).not.toContain("$settings | ConvertTo-Json -Depth 20 | Set-Content -Path $tmpPath -Encoding UTF8");
    expect(script).toContain("Leaving Pi bundled skills enabled (global Plannotator agent skills not found).");
    expect(script).toContain("Configured Pi to use global Plannotator skills and skip bundled package skills.");
    expect(script).toContain("if (Test-PlannotatorSharedAgentSkillsAvailable) {\n            Configure-PiPlannotatorPackageFilter");

    const skillsInstallIndex = script.indexOf("# Install skills (requires git)");
    const piUpdateCallIndex = script.lastIndexOf("Update-PiExtensionIfPresent");
    expect(skillsInstallIndex).toBeGreaterThan(0);
    expect(piUpdateCallIndex).toBeGreaterThan(skillsInstallIndex);
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
    // EnterPlanMode hook drives the compound-skill improvement-hook injection.
    expect(script).toContain('echo     "PreToolUse": [');
    expect(script).toContain('echo         "matcher": "EnterPlanMode",');
    expect(script).toContain('echo             "command": "!EXE_PATH! improve-context",');
    expect(script).toContain('echo             "timeout": 5');
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

  test("install.cmd selects platform based on PROCESSOR_ARCHITECTURE", () => {
    // Earlier revisions hardcoded `set "PLATFORM=win32-x64"` regardless
    // of host architecture, so ARM64 Windows machines silently received
    // the x64 binary (working via emulation, but slower). Now that
    // release.yml ships a native bun-windows-arm64 build, the script
    // must branch on PROCESSOR_ARCHITECTURE / PROCESSOR_ARCHITEW6432
    // and set PLATFORM to win32-arm64 when appropriate.
    expect(script).toContain('set "PLATFORM=win32-x64"');
    expect(script).toContain('set "PLATFORM=win32-arm64"');
    // The old unconditional hardcode must be gone.
    expect(script).not.toMatch(/^set "PLATFORM=win32-x64"$/m);
  });

  test("warns about duplicate hooks", () => {
    expect(script).toContain("DUPLICATE HOOK DETECTED");
  });

  test("installs skills via git sparse-checkout", () => {
    expect(script).toContain("git clone --depth 1 --filter=blob:none --sparse");
    expect(script).toContain("git sparse-checkout set apps/skills");
    expect(script).toContain("CLAUDE_SKILLS_DIR");
    expect(script).toContain("CODEX_SKILLS_DIR");
    expect(script).toContain("AGENTS_SKILLS_DIR");
    expect(script).toContain("%USERPROFILE%\\.codex\\skills");
    expect(script).toContain("%USERPROFILE%\\.agents\\skills");
    expect(script).toContain('if "!CODEX_AVAILABLE!"=="1"');
    expect(script).toContain('if exist "apps\\skills\\plannotator-review" xcopy /s /i /y /q "apps\\skills\\plannotator-review" "!CODEX_SKILLS_DIR!\\plannotator-review\\"');
    expect(script).toContain('if exist "apps\\skills\\plannotator-annotate" xcopy /s /i /y /q "apps\\skills\\plannotator-annotate" "!CODEX_SKILLS_DIR!\\plannotator-annotate\\"');
    expect(script).toContain('if exist "apps\\skills\\plannotator-last" xcopy /s /i /y /q "apps\\skills\\plannotator-last" "!CODEX_SKILLS_DIR!\\plannotator-last\\"');
    expect(script).toContain('if exist "apps\\skills\\plannotator-compound" xcopy /s /i /y /q "apps\\skills\\plannotator-compound" "!AGENTS_SKILLS_DIR!\\plannotator-compound\\"');
    expect(script).toContain('if exist "apps\\skills\\plannotator-setup-goal" xcopy /s /i /y /q "apps\\skills\\plannotator-setup-goal" "!AGENTS_SKILLS_DIR!\\plannotator-setup-goal\\"');
    expect(script).not.toContain('xcopy /s /y /q "apps\\skills\\*" "!CODEX_SKILLS_DIR!\\"');
    expect(script).not.toContain('xcopy /s /y /q "apps\\skills\\*" "!AGENTS_SKILLS_DIR!\\"');
    expect(script).toContain("Skipping skills install");
  });

  test("cleans only legacy command-overlap agent skills", () => {
    expect(script).toContain("LEGACY_AGENTS_SKILLS_DIR");
    expect(script).toContain("plannotator-review plannotator-annotate plannotator-last");
    expect(script).not.toContain("plannotator-review plannotator-annotate plannotator-last plannotator-compound");
    expect(script).not.toContain("plannotator-review plannotator-annotate plannotator-last plannotator-setup-goal");
  });

  test("removes shared-agent Plannotator skills from Codex scope", () => {
    expect(script).toContain("STALE_CODEX_SKILLS_DIR");
    expect(script).toContain("plannotator-compound plannotator-setup-goal");
  });

  test("does not treat a skills-only Codex home as configured", () => {
    expect(script).toContain("CODEX_AVAILABLE");
    expect(script).toContain('if /i not "%%C"=="skills"');
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

  test("configures Pi to skip bundled skills only after shared skills exist", () => {
    expect(script).toContain("PI_CODING_AGENT_DIR");
    expect(script).toContain("PI_SETTINGS_PATH");
    expect(script).toContain("$env:PI_SETTINGS_PATH");
    expect(script).toContain("npm:@plannotator/pi-extension");
    expect(script).toContain("skills=@()");
    expect(script).toContain("New-Object System.Text.UTF8Encoding -ArgumentList $false");
    expect(script).toContain("[System.IO.File]::WriteAllText($tmp,$json,$utf8NoBom)");
    expect(script).not.toContain("Set-Content -Path $tmp -Encoding UTF8");
    expect(script).toContain("Leaving Pi bundled skills enabled ^(global Plannotator agent skills not found^).");
    expect(script).toContain("Configured Pi to use global Plannotator skills and skip bundled package skills.");
    expect(script).toContain('set "PI_SHARED_SKILLS_AVAILABLE=0"');
    expect(script).toContain('if exist "!PI_SHARED_SKILLS_DIR!\\plannotator-compound\\SKILL.md" if exist "!PI_SHARED_SKILLS_DIR!\\plannotator-setup-goal\\SKILL.md" set "PI_SHARED_SKILLS_AVAILABLE=1"');
    expect(script).toContain('if "!PI_SHARED_SKILLS_AVAILABLE!"=="1"');

    const skillsInstallIndex = script.indexOf("REM Install skills (requires git)");
    const piUpdateIndex = script.lastIndexOf("REM Update Pi extension if pi is installed.");
    expect(skillsInstallIndex).toBeGreaterThan(0);
    expect(piUpdateIndex).toBeGreaterThan(skillsInstallIndex);
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

describe("Codex Plannotator skills", () => {
  test("command-overlap skills include OpenAI agent config", () => {
    for (const skill of ["plannotator-review", "plannotator-annotate", "plannotator-last"]) {
      const configPath = join(scriptsDir, "..", "apps", "skills", skill, "agents", "openai.yaml");
      expect(existsSync(configPath)).toBe(true);
    }
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

  test("all installers resolve verification + pre-flight BEFORE downloading the binary", () => {
    // Regression guard: earlier revisions of install.ps1 and install.cmd
    // resolved the three-layer verification opt-in and ran the
    // MIN_ATTESTED_VERSION pre-flight AFTER the curl download, meaning
    // users hit the failure only after wasting a full binary download.
    // install.sh always pre-flighted correctly; the other two drifted.
    //
    // This test uses indexOf to assert the resolution block appears
    // textually BEFORE the download line in each installer.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");

    // install.sh: resolution before curl -o
    const shResolve = sh.indexOf("verify_attestation=0");
    const shDownload = sh.indexOf('curl -fsSL -o "$tmp_file"');
    expect(shResolve).toBeGreaterThan(-1);
    expect(shDownload).toBeGreaterThan(-1);
    expect(shResolve).toBeLessThan(shDownload);

    // install.ps1: resolution before Invoke-WebRequest -OutFile $tmpFile
    const psResolve = ps.indexOf("$verifyAttestationResolved = $false");
    const psDownload = ps.indexOf("Invoke-WebRequest -Uri $binaryUrl -OutFile $tmpFile");
    expect(psResolve).toBeGreaterThan(-1);
    expect(psDownload).toBeGreaterThan(-1);
    expect(psResolve).toBeLessThan(psDownload);

    // install.cmd: resolution before curl -o "!TEMP_FILE!"
    const cmdResolve = cmdScript.indexOf('set "VERIFY_ATTESTATION=0"');
    const cmdDownload = cmdScript.indexOf('curl -fsSL "!BINARY_URL!" -o "!TEMP_FILE!"');
    expect(cmdResolve).toBeGreaterThan(-1);
    expect(cmdDownload).toBeGreaterThan(-1);
    expect(cmdResolve).toBeLessThan(cmdDownload);
  });

  test("install.cmd version pre-flight uses $env: vars, not interpolated cmd vars", () => {
    // Regression guard for PowerShell command injection via --version.
    // Earlier revision interpolated `!TAG_NUM!` and `!MIN_NUM!` directly
    // into a PowerShell -Command string between single quotes. A crafted
    // --version like "0.18.0'; calc; '0.18.0" would break out of the
    // literal and execute arbitrary PowerShell. Fix: pass the values via
    // environment variables ($env:TAG_NUM, $env:MIN_NUM). PowerShell
    // reads env var values as raw strings and never parses them as code;
    // the [version] cast throws on invalid input and catch swallows it.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    expect(cmdScript).toContain("$env:TAG_NUM");
    expect(cmdScript).toContain("$env:MIN_NUM");
    // The vulnerable interpolation form must be gone.
    expect(cmdScript).not.toContain("[version]'!TAG_NUM!'");
    expect(cmdScript).not.toContain("[version]'!MIN_NUM!'");
  });

  test("install.cmd strips leading v via substring, not global substitution", () => {
    // Regression guard: cmd's `!VAR:str=repl!` is GLOBAL, not anchored,
    // so `!TAG:v=!` removes every `v` in the tag — for hypothetical
    // tags with internal v's (e.g. v1.0.0-rev2 → 1.0.0-re2) this
    // produces an invalid version string. Use `!TAG:~1!` (substring
    // from index 1) instead, which is equivalent to stripping the
    // leading `v` because TAG is guaranteed to start with `v` by the
    // upstream normalization.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    expect(cmdScript).toContain('set "TAG_NUM=!TAG:~1!"');
    expect(cmdScript).toContain('set "MIN_NUM=!MIN_ATTESTED_VERSION:~1!"');
    // The global-substitution form must be gone from the pre-flight block.
    expect(cmdScript).not.toContain('set "TAG_NUM=!TAG:v=!"');
    expect(cmdScript).not.toContain('set "MIN_NUM=!MIN_ATTESTED_VERSION:v=!"');
  });

  test("both Windows installers reject pre-release tags with a dedicated error", () => {
    // Regression guard: [System.Version] (used by both Windows installers
    // for the pre-flight comparison) throws on semver prerelease suffixes
    // like v0.18.0-rc1. Earlier revisions let the throw be swallowed by
    // catch blocks and surfaced misleading diagnoses:
    //   install.cmd: "predates attestation support" (wrong — it's unparseable)
    //   install.ps1: "Could not parse version tags" (accurate but cryptic)
    // Both now detect the `-` in the tag BEFORE attempting the cast and
    // emit a dedicated "pre-release tags aren't currently supported"
    // error that points users at --skip-attestation or a stable tag.
    // install.sh handles these correctly via `sort -V` and doesn't need
    // the pre-check.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    expect(cmdScript).toContain("Pre-release tags");
    expect(cmdScript).toContain('if not "!TAG_NUM!"=="!TAG_NUM:-=!"');
    expect(ps).toContain("Pre-release tags");
    expect(ps).toMatch(/\$latestTag -match '-'/);
  });

  test("all three installers hardcode the SAME MIN_ATTESTED_VERSION value", () => {
    // Cross-file consistency guard: the constant is triplicated across
    // install.sh, install.ps1, install.cmd with no shared source of
    // truth. A future bump that updates only one or two of the three
    // files would silently ship divergent behavior — each installer
    // would enforce a different floor. The per-file tests below check
    // that each file contains the literal "v0.17.2" individually, but
    // that doesn't catch drift where all three are internally consistent
    // with themselves but differ from each other (e.g., sh says v0.17.3,
    // ps says v0.17.2, cmd says v0.17.3).
    //
    // This test extracts the value from each file via a regex anchored
    // on the assignment form (not just any mention of the string) and
    // asserts all three match.
    // Line-anchored regexes (/m) so a future comment that happens to
    // contain the assignment form doesn't false-match and shadow the
    // real declaration. All three current assignments are flush-left
    // at the top of their respective files.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    const shMatch = sh.match(/^MIN_ATTESTED_VERSION="(v\d+\.\d+\.\d+)"/m);
    const psMatch = ps.match(/^\$minAttestedVersion\s*=\s*"(v\d+\.\d+\.\d+)"/m);
    const cmdMatch = cmdScript.match(/^set "MIN_ATTESTED_VERSION=(v\d+\.\d+\.\d+)"/m);
    expect(shMatch, "install.sh missing MIN_ATTESTED_VERSION assignment").toBeTruthy();
    expect(psMatch, "install.ps1 missing $minAttestedVersion assignment").toBeTruthy();
    expect(cmdMatch, "install.cmd missing MIN_ATTESTED_VERSION assignment").toBeTruthy();
    const values = new Set([shMatch![1], psMatch![1], cmdMatch![1]]);
    if (values.size !== 1) {
      throw new Error(
        `MIN_ATTESTED_VERSION drift across installers: sh=${shMatch![1]}, ps=${psMatch![1]}, cmd=${cmdMatch![1]}. All three must match.`
      );
    }
  });

  test("all installers hardcode MIN_ATTESTED_VERSION and guard verification against older tags", () => {
    // Releases cut before this PR added `actions/attest-build-provenance`
    // to release.yml have no attestations. Running `gh attestation verify`
    // against them fails with "no attestations found" — a cryptic error
    // that doesn't explain the user's actual problem (old version, no
    // provenance support). Each installer now hardcodes a
    // MIN_ATTESTED_VERSION constant and rejects verification requests
    // for older tags BEFORE downloading the binary, with a clean error
    // telling the user how to recover.
    //
    // The constant is bumped once by the release skill at the first
    // attested release and then left alone as a permanent floor.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");

    // install.sh
    expect(sh).toContain('MIN_ATTESTED_VERSION="v0.17.2"');
    expect(sh).toContain("version_ge");
    expect(sh).toContain("predates");
    // install.ps1
    expect(ps).toContain('$minAttestedVersion = "v0.17.2"');
    expect(ps).toContain("[version]");
    expect(ps).toContain("predates");
    // install.cmd
    expect(cmdScript).toContain('set "MIN_ATTESTED_VERSION=v0.17.2"');
    expect(cmdScript).toContain("powershell -NoProfile -Command");
    expect(cmdScript).toContain("predates");
  });

  test("install.sh and help text use vX.Y.Z placeholder not v0.17.1", () => {
    // Regression guard: the docs and --help text previously used v0.17.1
    // as a concrete pinned-version example. That tag predates provenance
    // support, so any user copy-pasting the example and enabling
    // verification would hit a hard failure. Replaced with a generic
    // vX.Y.Z placeholder across all user-facing docs.
    expect(sh).not.toContain("--version v0.17.1");
    expect(sh).not.toContain("bash install.sh v0.17.1");
  });

  test("install.cmd double-escapes ! in Claude Code and Gemini slash command echoes", () => {
    // Regression guard: under setlocal enabledelayedexpansion, preserving a
    // literal `!` through both cmd parser phases requires `^^!`, not `^!`.
    // Phase 1 consumes one caret (`^^` → `^`), Phase 2 consumes the second
    // (`^!` → `!`). A single `^!` gets converted to `!` by Phase 1 and then
    // stripped by Phase 2 because it's an unmatched delayed-expansion
    // reference — yielding a written file with no `!` at all. This was
    // caught by the Windows CI integration step reading back the generated
    // command files, after an earlier "fix" with single-caret escape
    // silently continued to drop the prefix.
    //
    // Also covers the Gemini section, which used the same incorrect
    // single-caret escape and was equally broken (but had no CI coverage).
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    // Claude Code slash commands (three files)
    expect(cmdScript).toContain("echo ^^!`plannotator review $ARGUMENTS`");
    expect(cmdScript).toContain("echo ^^!`plannotator annotate $ARGUMENTS`");
    expect(cmdScript).toContain("echo ^^!`plannotator annotate-last`");
    // Gemini slash commands (two files)
    expect(cmdScript).toContain("echo ^^!{plannotator review {{args}}}");
    expect(cmdScript).toContain("echo ^^!{plannotator annotate {{args}}}");
    // And the single-caret and unescaped forms must be gone
    expect(cmdScript).not.toMatch(/^echo !`plannotator/m);
    expect(cmdScript).not.toMatch(/^echo \^!`plannotator/m);
    expect(cmdScript).not.toMatch(/^echo \^!{plannotator/m);
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
