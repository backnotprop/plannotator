/**
 * Install Script Validation Tests
 *
 * Validates that install scripts produce correct JSON and command structures
 * without actually running the installers.
 *
 * Run: bun test scripts/install.test.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const scriptsDir = import.meta.dir;

// The three always-installed core skills (apps/skills/core/*). Single list so
// the copy assertions, sidecar checks, and frontmatter checks can't drift.
const CORE_SKILLS = [
  "plannotator-review",
  "plannotator-annotate",
  "plannotator-last",
];

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

  test("installs core skills via git sparse-checkout to claude + agents", () => {
    expect(script).toContain("git clone --depth 1 --filter=blob:none --sparse");
    // Sparse set extended to also fetch the command stubs from the checkout.
    expect(script).toContain(
      "git sparse-checkout set apps/skills apps/kiro-cli apps/opencode-plugin/commands apps/gemini/commands",
    );
    expect(script).toContain("CLAUDE_SKILLS_DIR");
    expect(script).toContain("AGENTS_SKILLS_DIR");
    expect(script).toContain("$HOME/.agents/skills");
    expect(script).toContain("copy_skill_if_present");
    // Claude Code reads the injection-form skills from apps/skills/claude;
    // the OpenAI shared-agent (Codex) path reads the prose skills from
    // apps/skills/core. Sourced separately because `!`…`` injection is a
    // Claude-Code-only extension.
    for (const skill of CORE_SKILLS) {
      expect(script).toContain(`copy_skill_if_present apps/skills/claude/${skill} "$CLAUDE_SKILLS_DIR"`);
      expect(script).toContain(`copy_skill_if_present apps/skills/core/${skill} "$AGENTS_SKILLS_DIR"`);
    }
    // Codex no longer receives a skills install (core skills live in ~/.agents/skills).
    expect(script).not.toContain('copy_skill_if_present apps/skills/core/plannotator-review "$CODEX_SKILLS_DIR"');
    // Extras are not default-installed anywhere except Kiro.
    expect(script).not.toContain("copy_skill_if_present apps/skills/extra/plannotator-compound");
    expect(script).not.toContain('cp -r apps/skills/* "$CLAUDE_SKILLS_DIR/"');
    // Missing git is a hard failure with an actionable message, not a silent
    // skip — the legacy commands are gone, so a no-skill install is broken.
    expect(script).toContain("Error: git is required to install Plannotator's skills and slash commands.");
    expect(script).toContain("Install git, then run this installer again.");
  });

  test("legacy Claude command cleanup is guarded on the replacement skill", () => {
    // A command file may only be removed once its same-name skill exists on
    // disk, and the cleanup must run AFTER the skill install — so a failed
    // fetch or an old pinned tag never deletes commands without replacement.
    expect(script).toContain('if [ -d "$CLAUDE_SKILLS_DIR/$cmd" ] && [ -f "$CLAUDE_COMMANDS_DIR/$cmd.md" ]');
    const cleanupIndex = script.indexOf('Removed legacy Claude command');
    const installIndex = script.indexOf('copy_skill_if_present apps/skills/claude/plannotator-review');
    expect(installIndex).toBeGreaterThan(0);
    expect(cleanupIndex).toBeGreaterThan(installIndex);
  });

  test("extras cleanup runs once via the migrations ledger", () => {
    // The npx-installed extras are byte-identical to our old default installs;
    // only the ledger can tell them apart. The cleanup must be gated on the
    // migration marker and honor PLANNOTATOR_DATA_DIR (via _config_dir).
    expect(script).toContain('MIGRATIONS_DIR="$_config_dir/migrations"');
    expect(script).toContain("2026-06-extras-default-install-removed");
    expect(script).toContain('if [ ! -f "$EXTRAS_MIGRATION" ]');
  });

  test("guided install: flags, tty gating, prefs persistence, flip pass", () => {
    // Wizard flags exist.
    for (const flag of ["--extras", "--no-extras", "--model-invocable", "--non-interactive", "--reconfigure"]) {
      expect(script).toContain(flag);
    }
    // Prompts require a real terminal: all wizard I/O runs on /dev/tty so
    // piped installs (curl | bash) can still prompt and CI never does.
    expect(script).toContain("{ : < /dev/tty; } 2>/dev/null");
    expect(script).toContain("ask_yes_no");
    expect(script).toContain("select_skills_checkbox");
    // Answers persist to the data dir and silent re-runs reuse them.
    expect(script).toContain('PREFS_FILE="$_config_dir/install-prefs"');
    // Extras install is delegated to the skills CLI with the terminal attached.
    expect(script).toContain("npx skills add backnotprop/plannotator/apps/skills/extra < /dev/tty");
    // Flip pass unlocks INSTALLED copies only (repo sources always stay
    // locked) and flips the Codex sidecar to match.
    expect(script).toContain("grep -v '^disable-model-invocation: true$'");
    expect(script).toContain("allow_implicit_invocation: true");
  });

  test("old pinned tags soft-skip core skills without aborting command installs", () => {
    // Regression guard: a --version tag that predates apps/skills/core must
    // skip the core-skill copy with an accurate message — NOT abort the whole
    // sparse-checkout subshell, which would also skip the OpenCode/Gemini
    // command installs that follow it (and ps1/cmd would diverge).
    expect(script).toContain("predates the core/extra skill layout");
    expect(script).not.toMatch(/^\s*\[ -d "apps\/skills\/core" \]\s*$/m);
    // Subshell failure (clone/network) gets its own honest message rather
    // than falsely claiming git is missing.
    expect(script).toContain("network or git error");
  });

  test("installs OpenCode and Gemini commands from the checkout, not heredocs", () => {
    // Command stubs/TOMLs are copied verbatim from the sparse checkout.
    expect(script).toContain("copy_commands_if_present");
    expect(script).toContain('copy_commands_if_present apps/opencode-plugin/commands "$OPENCODE_COMMANDS_DIR"');
    expect(script).toContain('copy_commands_if_present apps/gemini/commands "$GEMINI_COMMANDS_DIR"');
    // Gemini commands only when ~/.gemini exists.
    expect(script).toContain('if [ -d "$HOME/.gemini" ]; then');
    // The old command heredocs must be gone entirely.
    expect(script).not.toContain("COMMAND_EOF");
    expect(script).not.toContain("GEMINI_CMD_EOF");
  });

  test("auto-installs Kiro skills when ~/.kiro is detected (no flag)", () => {
    // Auto-detected like Codex/Gemini — never gated behind a bespoke flag.
    expect(script).toContain("kiro_available=0");
    expect(script).toContain('[ -d "$HOME/.kiro" ]');
    expect(script).toContain("KIRO_SKILLS_DIR");
    expect(script).toContain("$HOME/.kiro/skills");
    expect(script).toContain('if [ "$kiro_available" -eq 1 ]');
    // Kiro-specific skills (origin baked in) come from apps/kiro-cli/skills.
    expect(script).toContain('copy_skill_if_present apps/kiro-cli/skills/plannotator-review "$KIRO_SKILLS_DIR"');
    expect(script).toContain('copy_skill_if_present apps/kiro-cli/skills/plannotator-annotate "$KIRO_SKILLS_DIR"');
    // The two extras Kiro keeps receiving come from apps/skills/extra.
    expect(script).toContain('copy_skill_if_present apps/skills/extra/plannotator-setup-goal "$KIRO_SKILLS_DIR"');
    expect(script).toContain('copy_skill_if_present apps/skills/extra/plannotator-visual-explainer "$KIRO_SKILLS_DIR"');
    // sparse-checkout fetches apps/kiro-cli (skills + agent example).
    expect(script).toContain("git sparse-checkout set apps/skills apps/kiro-cli");
    // The installer also writes the example custom agent to ~/.kiro/agents.
    expect(script).toContain('cp apps/kiro-cli/agents/plannotator.json "$HOME/.kiro/agents/plannotator.json"');
    // Parity: no bespoke flag, like every other agent.
    expect(script).not.toContain("--kiro");
    expect(script).not.toContain("INSTALL_KIRO");
  });

  test("aggressively cleans up deprecated commands and stale skills on upgrade", () => {
    // Claude Code commands are deprecated in favor of skills — remove the files.
    expect(script).toContain("CLAUDE_COMMANDS_DIR");
    expect(script).toContain(
      "for cmd in plannotator-review plannotator-annotate plannotator-last; do",
    );
    // The legacy ~/.agents cleanup block (review/annotate/last) is GONE —
    // core skills now intentionally live in ~/.agents/skills.
    expect(script).not.toContain("LEGACY_AGENTS_SKILLS_DIR");
    // Codex cleanup now also removes the per-command skills, plus the
    // previously-stale compound/setup-goal.
    expect(script).toContain("STALE_CODEX_SKILLS_DIR");
    expect(script).toContain(
      "for skill in plannotator-review plannotator-annotate plannotator-last plannotator-compound plannotator-setup-goal; do",
    );
    // Extras stop being managed in the Claude and shared-agent scopes.
    expect(script).toContain("plannotator-compound plannotator-setup-goal plannotator-visual-explainer");
    // plannotator-archive no longer ships as a skill — a stale installed copy
    // is removed unconditionally from every skill scope.
    expect(script).toContain(
      'for scope in "$CLAUDE_SKILLS_DIR" "$AGENTS_SKILLS_DIR" "$KIRO_SKILLS_DIR"; do',
    );
    expect(script).toContain('rm -rf "$scope/plannotator-archive"');
  });

  test("suggests installing extras via npx skills add", () => {
    expect(script).toContain("Optional skills (compound planning, setup-goal, visual explainer):");
    expect(script).toContain("npx skills add backnotprop/plannotator/apps/skills/extra");
  });

  test("no longer installs core skills to ~/.codex/skills", () => {
    // Codex skills install removed; ~/.codex/skills only appears in cleanup.
    expect(script).not.toContain('mkdir -p "$CODEX_SKILLS_DIR"');
    expect(script).not.toContain('copy_skill_if_present apps/skills/core/plannotator-review "$CODEX_SKILLS_DIR"');
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

  test("Pi extension update keeps no settings.json package-skills filter", () => {
    // Pi no longer bundles skills, so the settings.json filter machinery is gone.
    expect(script).toContain("update_pi_extension_if_present");
    expect(script).toContain("npm:@plannotator/pi-extension");
    expect(script).not.toContain("configure_pi_plannotator_package_filter");
    expect(script).not.toContain("plannotator_shared_agent_skills_available");
    expect(script).not.toContain("PI_CODING_AGENT_DIR");
    expect(script).not.toContain("return { source: entry, skills: [] };");

    // Pi update still runs after the git-gated skills/commands install.
    const skillsInstallIndex = script.indexOf(
      "# Install skills and slash commands from a sparse checkout",
    );
    const piUpdateCallIndex = script.lastIndexOf("update_pi_extension_if_present");
    expect(skillsInstallIndex).toBeGreaterThan(0);
    expect(piUpdateCallIndex).toBeGreaterThan(skillsInstallIndex);
  });

  test("hook/config writing happens before the git hard-fail", () => {
    // Missing git hard-fails the install, but the hook/config writes that
    // don't need git (plugin hooks, Codex hook config) must already have run
    // by then so a re-run after installing git completes the rest.
    const gitGateIndex = script.indexOf("if ! command -v git &>/dev/null; then");
    expect(gitGateIndex).toBeGreaterThan(0);
    const pluginHooksIndex = script.indexOf('cat > "$PLUGIN_HOOKS"');
    const codexHooksIndex = script.indexOf('enable_codex_hooks_config || true');
    expect(pluginHooksIndex).toBeGreaterThan(0);
    expect(pluginHooksIndex).toBeLessThan(gitGateIndex);
    expect(codexHooksIndex).toBeGreaterThan(0);
    expect(codexHooksIndex).toBeLessThan(gitGateIndex);
    // Gemini policy/settings config heredocs are still present (after the
    // skills section, unaffected by the git requirement once git exists).
    expect(script).toContain('GEMINI_POLICY_EOF');
    expect(script).toContain('GEMINI_SETTINGS_EOF');
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

  test("installs core skills via git sparse-checkout to claude + agents", () => {
    expect(script).toContain("git clone --depth 1 --filter=blob:none --sparse");
    expect(script).toContain(
      "git sparse-checkout set apps/skills apps/kiro-cli apps/opencode-plugin/commands apps/gemini/commands",
    );
    expect(script).toContain("claudeSkillsDir");
    expect(script).toContain("agentsSkillsDir");
    expect(script).toContain("$env:USERPROFILE\\.agents\\skills");
    expect(script).toContain("Copy-SkillIfPresent");
    // Claude Code reads injection-form skills (apps\skills\claude); the
    // shared-agent (Codex) scope reads the prose skills (apps\skills\core).
    // Per-skill via Copy-SkillIfPresent so re-runs replace rather than nest
    // (PowerShell's Copy-Item -Recurse into an existing dir nests).
    expect(script).toContain('Copy-SkillIfPresent "apps\\skills\\claude\\$skill" $claudeSkillsDir');
    expect(script).toContain('Copy-SkillIfPresent "apps\\skills\\core\\$skill" $agentsSkillsDir');
    expect(script).toContain('"plannotator-review", "plannotator-annotate", "plannotator-last"');
    // Copy-SkillIfPresent pre-removes the destination to avoid nesting on upgrade.
    expect(script).toContain("if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }");
    // No Codex skills install.
    expect(script).not.toContain('Copy-SkillIfPresent "apps\\skills\\plannotator-review" $codexSkillsDir');
    // Missing git is a hard failure with an actionable message (parity with sh).
    expect(script).toContain("Error: git is required to install Plannotator's skills and slash commands.");
    expect(script).toContain("Install git, then run this installer again.");
    expect(script).toContain("checkoutFailed");
  });

  test("installs OpenCode and Gemini commands from the checkout", () => {
    expect(script).toContain('Copy-Item -Force "apps\\opencode-plugin\\commands\\*.md" $opencodeCommandsDir');
    expect(script).toContain('Copy-Item -Force "apps\\gemini\\commands\\*.toml" $geminiCommandsDir');
    // No Gemini command heredocs remain.
    expect(script).not.toContain("GEMINI_CMD_EOF");
  });

  test("aggressively cleans up deprecated commands and stale skills on upgrade", () => {
    expect(script).toContain("claudeCommandsDir");
    // Command cleanup is guarded on the replacement skill existing and runs
    // after the skill install (parity with install.sh).
    expect(script).toContain("(Test-Path $skillPath) -and (Test-Path $cmdPath)");
    // Legacy ~/.agents review/annotate/last cleanup is gone.
    expect(script).not.toContain("legacyAgentsSkillsDir");
    // Codex cleanup includes the per-command skills now.
    expect(script).toContain("staleCodexSkillsDir");
    expect(script).toContain('"plannotator-review", "plannotator-annotate", "plannotator-last", "plannotator-compound", "plannotator-setup-goal"');
    // Extras removed from Claude + shared-agent scopes, once, via the ledger.
    expect(script).toContain('"plannotator-compound", "plannotator-setup-goal", "plannotator-visual-explainer"');
    expect(script).toContain("2026-06-extras-default-install-removed");
    expect(script).toContain("if (-not (Test-Path $extrasMigration))");
    // plannotator-archive no longer ships as a skill — a stale installed copy
    // is removed unconditionally from every skill scope.
    expect(script).toContain(
      'foreach ($scope in @($claudeSkillsDir, $agentsSkillsDir, "$env:USERPROFILE\\.kiro\\skills"))',
    );
    expect(script).toContain('Join-Path $scope "plannotator-archive"');
  });

  test("does not treat a skills-only Codex home as configured", () => {
    expect(script).toContain("codexHomeHasUserConfig");
    expect(script).toContain('$_.Name -ne "skills"');
    expect(script).toContain("$codexAvailable");
  });

  test("suggests installing extras via npx skills add", () => {
    expect(script).toContain("Optional skills (compound planning, setup-goal, visual explainer):");
    expect(script).toContain("npx skills add backnotprop/plannotator/apps/skills/extra");
  });

  test("Pi extension update keeps no settings.json package-skills filter", () => {
    expect(script).toContain("Update-PiExtensionIfPresent");
    expect(script).toContain("npm:@plannotator/pi-extension");
    expect(script).not.toContain("Configure-PiPlannotatorPackageFilter");
    expect(script).not.toContain("Test-PlannotatorSharedAgentSkillsAvailable");
    expect(script).not.toContain("PI_CODING_AGENT_DIR");
    expect(script).not.toContain("skills = @()");

    const skillsInstallIndex = script.indexOf("# Install skills and command stubs (requires git)");
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

  test("installs core skills via git sparse-checkout to claude + agents", () => {
    expect(script).toContain("git clone --depth 1 --filter=blob:none --sparse");
    expect(script).toContain(
      "git sparse-checkout set apps/skills apps/kiro-cli apps/opencode-plugin/commands apps/gemini/commands",
    );
    expect(script).toContain("CLAUDE_SKILLS_DIR");
    expect(script).toContain("AGENTS_SKILLS_DIR");
    expect(script).toContain("%USERPROFILE%\\.agents\\skills");
    // Claude Code reads injection-form skills (apps\skills\claude); the shared
    // agent (Codex) scope reads the prose skills (apps\skills\core).
    expect(script).toContain('xcopy /s /i /y /q "apps\\skills\\claude\\%%S" "!CLAUDE_SKILLS_DIR!\\%%S\\"');
    expect(script).toContain('xcopy /s /i /y /q "apps\\skills\\core\\%%S" "!AGENTS_SKILLS_DIR!\\%%S\\"');
    expect(script).toContain("for %%S in (plannotator-review plannotator-annotate plannotator-last) do");
    // No Codex skills install — only the cleanup loop references CODEX skills.
    expect(script).not.toContain('xcopy /s /i /y /q "apps\\skills\\core\\%%S" "!CODEX_SKILLS_DIR!\\%%S\\"');
    // Missing git is a hard failure with an actionable message (parity with sh/ps1).
    expect(script).toContain("Error: git is required to install Plannotator's skills and slash commands.");
    expect(script).toContain("Install git, then run this installer again.");
    expect(script).toContain("CHECKOUT_FAILED");
  });

  test("installs OpenCode and Gemini commands from the checkout", () => {
    expect(script).toContain('xcopy /y /q "apps\\opencode-plugin\\commands\\*.md" "!OPENCODE_COMMANDS_DIR!\\"');
    expect(script).toContain('xcopy /y /q "apps\\gemini\\commands\\*.toml" "!GEMINI_COMMANDS_DIR!\\"');
  });

  test("aggressively cleans up deprecated commands and stale skills on upgrade", () => {
    expect(script).toContain("CLAUDE_COMMANDS_DIR");
    // Command cleanup is guarded on the replacement skill existing and runs
    // after the skill install (parity with install.sh / install.ps1).
    expect(script).toContain('if exist "!CLAUDE_SKILLS_DIR!\\%%C" if exist "!CLAUDE_COMMANDS_DIR!\\%%C.md"');
    // Legacy ~/.agents review/annotate/last cleanup is gone.
    expect(script).not.toContain("LEGACY_AGENTS_SKILLS_DIR");
    // Codex cleanup includes the per-command skills now.
    expect(script).toContain("STALE_CODEX_SKILLS_DIR");
    expect(script).toContain("for %%S in (plannotator-review plannotator-annotate plannotator-last plannotator-compound plannotator-setup-goal) do");
    // Extras removed from Claude + shared-agent scopes, once, via the ledger.
    expect(script).toContain("for %%S in (plannotator-compound plannotator-setup-goal plannotator-visual-explainer) do");
    expect(script).toContain("2026-06-extras-default-install-removed");
    expect(script).toContain('if not exist "!EXTRAS_MIGRATION!"');
    // plannotator-archive no longer ships as a skill — a stale installed copy
    // is removed unconditionally from every skill scope.
    expect(script).toContain(
      'for %%D in ("!CLAUDE_SKILLS_DIR!" "!AGENTS_SKILLS_DIR!" "!KIRO_SKILLS_DIR!") do',
    );
    expect(script).toContain('rmdir /s /q "%%~D\\plannotator-archive"');
  });

  test("does not treat a skills-only Codex home as configured", () => {
    expect(script).toContain("CODEX_AVAILABLE");
    expect(script).toContain('if /i not "%%C"=="skills"');
  });

  test("suggests installing extras via npx skills add", () => {
    expect(script).toContain("Optional skills");
    expect(script).toContain("npx skills add backnotprop/plannotator/apps/skills/extra");
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

  test("Pi extension update keeps no settings.json package-skills filter", () => {
    expect(script).toContain("npm:@plannotator/pi-extension");
    // The settings.json package-skills filter machinery is fully removed.
    expect(script).not.toContain("PI_CODING_AGENT_DIR");
    expect(script).not.toContain("PI_SETTINGS_PATH");
    expect(script).not.toContain("skills=@()");
    expect(script).not.toContain("PI_SHARED_SKILLS_AVAILABLE");

    const skillsInstallIndex = script.indexOf("REM Skills + command stubs install (requires git)");
    const piUpdateIndex = script.lastIndexOf("REM Update Pi extension if pi is installed.");
    expect(skillsInstallIndex).toBeGreaterThan(0);
    expect(piUpdateIndex).toBeGreaterThan(skillsInstallIndex);
  });

  test("attestation verification is off by default with three-layer opt-in", () => {
    // Layer 3: config file read (verifyAttestation appears inside a
    // findstr pattern with escaped quotes; assert the key + findstr
    // separately rather than the quoted form)
    expect(script).toContain("PLANNOTATOR_DATA_DIR");
    expect(script).toContain('if /i "!_CONFIG_DIR!"=="~" set "_CONFIG_DIR=%USERPROFILE%"');
    expect(script).toContain('if "!_CONFIG_DIR:~0,2!"=="~\\" set "_CONFIG_DIR=%USERPROFILE%\\!_CONFIG_DIR:~2!"');
    expect(script).toContain('if "!_CONFIG_DIR:~0,2!"=="~/" set "_CONFIG_DIR=%USERPROFILE%\\!_CONFIG_DIR:~2!"');
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

describe("Core Plannotator skills", () => {
  test("every core skill includes an OpenAI agent config sidecar", () => {
    for (const skill of CORE_SKILLS) {
      const configPath = join(
        scriptsDir,
        "..",
        "apps",
        "skills",
        "core",
        skill,
        "agents",
        "openai.yaml",
      );
      expect(existsSync(configPath)).toBe(true);
    }
  });

  test("every skill in the repo sets disable-model-invocation: true", () => {
    // Maintainer rule: ALL Plannotator skills are user-invoked, never
    // model-auto-invoked. Load-bearing for #842: Pi natively discovers
    // ~/.agents/skills, and this frontmatter line is the only thing keeping
    // skills out of Pi's system prompt (<available_skills>). Scans every
    // SKILL.md dynamically so newly added skills are covered automatically.
    const skillRoots = [
      join(scriptsDir, "..", "apps", "skills", "core"),
      join(scriptsDir, "..", "apps", "skills", "extra"),
      join(scriptsDir, "..", "apps", "kiro-cli", "skills"),
    ];
    let checked = 0;
    for (const root of skillRoots) {
      for (const dir of readdirSync(root)) {
        const skillMd = join(root, dir, "SKILL.md");
        if (!existsSync(skillMd)) continue;
        const frontmatter = readFileSync(skillMd, "utf-8").split("---")[1] ?? "";
        expect(frontmatter).toContain("disable-model-invocation: true");
        checked++;
      }
    }
    // 3 core + 3 extra + 2 kiro — bump when adding skills, never below.
    expect(checked).toBeGreaterThanOrEqual(8);
  });
});

describe("install shared behavior", () => {
  const sh = readFileSync(join(scriptsDir, "install.sh"), "utf-8");
  const ps = readFileSync(join(scriptsDir, "install.ps1"), "utf-8");

  test("install.cmd contains no unix redirect bash-isms", () => {
    // Tripwire: during PR #850 development, three freshly written `>nul`
    // redirects in install.cmd were found rewritten to `>/dev/null` by an
    // unidentified external tool. In batch, >/dev/null redirects to a literal
    // .\dev\null file. If this trips, something between editor and disk is
    // rewriting cmd syntax.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    expect(cmdScript).not.toContain("/dev/null");
  });

  test("guided install exists in all three installers with safe automation behavior", () => {
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    // Shared prefs file (same format across platforms) in the data dir.
    expect(sh).toContain('PREFS_FILE="$_config_dir/install-prefs"');
    expect(ps).toContain('Join-Path $configDir "install-prefs"');
    expect(cmdScript).toContain('set "PREFS_FILE=!_CONFIG_DIR!\\install-prefs"');
    // Non-interactive escape hatch everywhere.
    expect(sh).toContain("--non-interactive");
    expect(ps).toContain("[switch]$NonInteractive");
    expect(cmdScript).toContain('"%~1"=="--non-interactive"');
    // The wizard only runs with a real terminal/console attached.
    expect(sh).toContain("{ : < /dev/tty; } 2>/dev/null");
    expect(ps).toContain("[Console]::IsInputRedirected");
    // cmd probes for a real console via `timeout /t 0` (errors when stdin is
    // redirected) so CI/redirected runs never see the wizard — and never run
    // the wizard-only installs (npx extras, Glimpse). set /p's empty-at-EOF
    // behavior remains as a second line of defense against hangs.
    expect(cmdScript).toContain("timeout /t 0");
    expect(cmdScript).toContain('if "!CAN_PROMPT!"=="1"');
    expect(cmdScript).toContain("set /p");
    // Silent re-runs must not clobber saved answers with defaults, and a wizard
    // that timed out to synthetic fallbacks (unattended /dev/tty) must not be
    // persisted — ask_yes_no returns non-zero on timeout/EOF, each prompt ORs
    // that into wizard_timed_out, and the prefs write is gated on it.
    expect(sh).toContain('if [ "$wizard_timed_out" -eq 0 ] && { [ "$run_wizard" -eq 1 ] || [ -n "$EXTRAS_FLAG" ] || [ -n "$MODEL_INVOCABLE_FLAG" ] || [ -n "$GLIMPSE_FLAG" ]; }');
    expect(sh).toContain("wizard_timed_out=0");
    expect(sh).toContain("|| wizard_timed_out=1");
    expect(sh).toMatch(/echo "no"\s+return 1/);
    // The bounded read stays in a tested context (`|| rc=$?`) so `set -e` never
    // aborts ask_yes_no on a timeout/EOF, regardless of how it's called.
    expect(sh).toContain('< /dev/tty || rc=$?');
    expect(ps).toContain("if ($runWizard -or $Extras -or $NoExtras -or $ModelInvocable -or $Glimpse -or $NoGlimpse)");
    expect(cmdScript).toContain('if "!DO_PERSIST!"=="1"');
    // Glimpse question: detect-on-PATH skip + global npm install in all three.
    for (const s of [sh, ps, cmdScript]) {
      expect(s).toContain("glimpseui");
      expect(s).toContain("npm install -g glimpseui");
    }
    expect(sh).toContain("--no-glimpse");
    expect(ps).toContain("[switch]$NoGlimpse");
    expect(cmdScript).toContain('"%~1"=="--no-glimpse"');
    // Flip pass in all three: SKILL.md line removal + Codex sidecar flip.
    expect(ps).toContain('Where-Object { $_ -ne "disable-model-invocation: true" }');
    expect(cmdScript).toContain('findstr /v /c:"disable-model-invocation: true"');
    for (const s of [sh, ps, cmdScript]) {
      expect(s).toContain("allow_implicit_invocation: true");
    }
  });

  test("all installers respect CODEX_HOME for the Codex home directory", () => {
    // Codex stores config and state under $CODEX_HOME when set, falling back
    // to ~/.codex (developers.openai.com/codex/config-advanced). #852
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    expect(sh).toContain('CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"');
    expect(ps).toContain('if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$env:USERPROFILE\\.codex" }');
    expect(cmdScript).toContain('if defined CODEX_HOME set "CODEX_DIR=%CODEX_HOME%"');
    // The fallback definition must be the ONLY hardcoded ~/.codex path left.
    expect((sh.match(/\$HOME\/\.codex/g) ?? []).length).toBe(1);
  });

  test("all installers explain the old-tag core-skill soft-skip", () => {
    // A --version tag predating apps/skills/core must be diagnosed in every
    // installer, not just bash — a silent skip leaves Windows users with no
    // skills and no explanation.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    expect(sh).toContain("predates the core/extra skill layout");
    expect(ps).toContain("predates the core/extra skill layout");
    expect(cmdScript).toContain("predates the core/extra skill layout");
    // ps1's clone-failure branch must not blame git when git is present.
    expect(ps).toContain("network or git error");
  });

  test("install.sh has three-layer opt-in resolution", () => {
    // Layer 3: config file via grep, respecting PLANNOTATOR_DATA_DIR
    expect(sh).toContain("PLANNOTATOR_DATA_DIR");
    expect(sh).toContain("_config_dir");
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
    // Layer 3: config file via ConvertFrom-Json, respecting PLANNOTATOR_DATA_DIR
    expect(ps).toContain("PLANNOTATOR_DATA_DIR");
    expect(ps).toContain('$configDir -eq "~"');
    expect(ps).toContain('$configDir.StartsWith("~/")');
    expect(ps).toContain("$configDir.StartsWith('~\\')");
    expect(ps).toContain("Join-Path $env:USERPROFILE ($configDir.Substring(2))");
    expect(ps).toContain('Join-Path $configDir "config.json"');
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

  test("no installer generates slash command files via heredoc/echo", () => {
    // Commands are now copied verbatim from the sparse checkout
    // (apps/opencode-plugin/commands, apps/gemini/commands) instead of being
    // emitted by heredocs/echoes. This retires the old `^^!` cmd-escaping
    // regression entirely — the fragile echo lines no longer exist.
    const cmdScript = readFileSync(join(scriptsDir, "install.cmd"), "utf-8");
    // install.cmd no longer echoes plannotator command bodies.
    expect(cmdScript).not.toContain("echo ^^!`plannotator");
    expect(cmdScript).not.toContain("echo ^^!{plannotator");
    expect(cmdScript).not.toMatch(/^echo \^!`plannotator/m);
    expect(cmdScript).not.toMatch(/^echo \^!{plannotator/m);
    // install.sh / install.ps1 no longer carry command heredocs.
    expect(sh).not.toContain("COMMAND_EOF");
    expect(sh).not.toContain("GEMINI_CMD_EOF");
    expect(ps).not.toContain("GEMINI_CMD_EOF");
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
