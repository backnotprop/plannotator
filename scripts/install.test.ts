/**
 * Install Script Validation Tests
 *
 * Validates that install scripts produce correct JSON and command structures
 * without actually running the installers.
 *
 * Run: bun test scripts/install.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptsDir = import.meta.dir;

function readScript(name: string): string {
  return readFileSync(join(scriptsDir, name), "utf-8").replace(/\r\n?/g, "\n");
}

// The three always-installed core skills (apps/skills/core/*). Single list so
// the copy assertions, sidecar checks, and frontmatter checks can't drift.
const CORE_SKILLS = [
  "plannotator-review",
  "plannotator-annotate",
  "plannotator-last",
];

describe("install.sh", () => {
  const script = readScript("install.sh");

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
    expect(script).toContain("npx skills add backnotprop/plannotator/apps/skills/extra --global < /dev/tty");
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
    // The removed /plannotator-archive OpenCode command stub is swept too.
    expect(script).toContain('rm -f "$OPENCODE_COMMANDS_DIR/plannotator-archive.md"');
  });

  test("suggests installing extras via npx skills add", () => {
    expect(script).toContain("Optional skills (compound planning, setup-goal, visual explainer):");
    expect(script).toContain("npx skills add backnotprop/plannotator/apps/skills/extra --global");
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
    // The gate is now conditional: git is a hard requirement only when the
    // skills checkout actually runs (see the --skip-skills test below), but
    // the ordering invariant this test guards is unchanged.
    const gitGateIndex = script.indexOf(
      'if [ "$skip_skills" -eq 0 ] && ! command -v git &>/dev/null; then',
    );
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

  test("--minimal flag and PLANNOTATOR_MINIMAL env var are documented", () => {
    // Usage text advertises the flag and the env-var opt-in for curl | bash.
    expect(script).toContain("--minimal");
    expect(script).toContain("PLANNOTATOR_MINIMAL");
    // Accepts both --minimal and the --binary-only alias, plus the opt-out.
    expect(script).toContain("--minimal|--binary-only)");
    expect(script).toContain("--no-minimal)");
  });

  test("minimal mode is resolved from flag with env-var fallback", () => {
    // A flag (--minimal or --no-minimal) wins over the env var, which wins over
    // the default (off). MINIMAL_FLAG stays -1 until a flag sets 0 or 1.
    expect(script).toContain("MINIMAL_FLAG=-1");
    expect(script).toContain('case "${PLANNOTATOR_MINIMAL:-}" in');
    expect(script).toContain('if [ "$MINIMAL_FLAG" -ne -1 ]; then');
    // --minimal and --no-minimal are mutually exclusive.
    expect(script).toContain("--minimal and --no-minimal are mutually exclusive");
  });

  test("minimal mode exits after the binary install, before any extras", () => {
    // The early exit must come AFTER the binary is moved into place but BEFORE
    // the sidecar downloads, agent integrations, skill checkout, and config
    // writes — that ordering is the whole point of #977.
    const binaryInstalled = script.indexOf(
      'mv "$tmp_file" "$INSTALL_DIR/plannotator"',
    );
    const minimalExit = script.indexOf('if [ "$minimal" -eq 1 ]; then');
    const semInstall = script.indexOf("install_sem_sidecar\n");
    const agentTerminal = script.indexOf("install_agent_terminal_runtime\n");
    const callFlow = script.indexOf("install_call_flow_runtime\n");
    const codexBlock = script.indexOf(
      "# --- Codex CLI / Desktop app support",
    );
    const skillsCheckout = script.indexOf(
      "git clone --depth 1 --filter=blob:none --sparse",
    );

    expect(binaryInstalled).toBeGreaterThan(0);
    expect(minimalExit).toBeGreaterThan(binaryInstalled);
    // Everything the reporter called "trash" runs strictly after the exit gate.
    expect(semInstall).toBeGreaterThan(minimalExit);
    expect(agentTerminal).toBeGreaterThan(minimalExit);
    expect(callFlow).toBeGreaterThan(minimalExit);
    expect(codexBlock).toBeGreaterThan(minimalExit);
    expect(skillsCheckout).toBeGreaterThan(minimalExit);
    // The gate really exits rather than falling through.
    const gateBody = script.slice(minimalExit, minimalExit + 400);
    expect(gateBody).toContain("exit 0");
  });

  test("PATH advice is a reusable function shared by both paths", () => {
    // Extracted so the minimal early exit and the normal flow both print it.
    expect(script).toContain("print_path_advice() {");
    // Called exactly once inside the minimal gate and once in the normal flow.
    const calls = script.match(/^\s*print_path_advice$/gm) ?? [];
    expect(calls.length).toBe(2);
  });

  test("per-agent skip opt-outs: flags, env vars, config keys, precedence (#1178)", () => {
    // Flags exist for Codex plus the two integrations where the mechanism
    // generalizes identically (detect -> write): Gemini and Kiro. OpenCode
    // gets a plain do-not-write switch (no detection leg).
    for (const flag of ["--skip-codex)", "--skip-gemini)", "--skip-kiro)", "--skip-opencode)"]) {
      expect(script).toContain(flag);
    }
    // Env vars follow the existing PLANNOTATOR_SKIP_*_INSTALL naming.
    expect(script).toContain("PLANNOTATOR_SKIP_CODEX_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_GEMINI_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_KIRO_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_OPENCODE_INSTALL");
    // Config layer (M2): the skipInstall OBJECT is extracted first (awk,
    // character-indexed so single-line JSON works too) and per-agent keys
    // are matched only inside it - a "codex": true under some OTHER key can
    // never opt anyone out, and an explicit false inside skipInstall is a
    // veto rather than being ignored.
    expect(script).toContain('index(substr(buf, pos), "\\"skipInstall\\"")');
    // Token check: a string VALUE containing "skipInstall" cannot anchor the
    // extraction - the key must be followed by optional whitespace, a colon,
    // and the object brace.
    expect(script).toContain("match(rest, /^[ \\t\\r\\n]*:[ \\t\\r\\n]*\\{/)");
    expect(script).toContain("_skip_install_block");
    expect(script).toContain('"\\"$_agent\\"[[:space:]]*:[[:space:]]*true"');
    expect(script).toContain('"\\"$_agent\\"[[:space:]]*:[[:space:]]*false"');
    expect(script).toContain("continue # explicit false is a veto, never a skip");
    // skills rides the same loop: not an agent, but the same three layers
    // and the same skipInstall key region.
    expect(script).toContain("for _agent in codex gemini kiro opencode skills; do");
    // The old whole-file grep form is gone.
    expect(script).not.toContain('grep -q \'"codex"[[:space:]]*:[[:space:]]*true\' "$_config_dir/config.json"');
    // Precedence by textual layering (later assignment wins): config grep,
    // then env-var case, then flag check — mirroring verifyAttestation.
    const configIdx = script.indexOf('skip_codex_source="config skipInstall.codex"');
    const envIdx = script.indexOf('skip_codex_source="PLANNOTATOR_SKIP_CODEX_INSTALL"');
    const flagIdx = script.indexOf('skip_codex_source="--skip-codex"');
    expect(configIdx).toBeGreaterThan(0);
    expect(envIdx).toBeGreaterThan(configIdx);
    expect(flagIdx).toBeGreaterThan(envIdx);
    // The env var can also force-disable a config-enabled skip (env > config).
    expect(script).toContain('case "${PLANNOTATOR_SKIP_CODEX_INSTALL:-}" in');
  });

  test("skip states are reported honestly and never remove existing integrations (#1178)", () => {
    // Three distinct Codex states, never conflated: detected-skipped vs not
    // detected vs installed.
    expect(script).toContain('Codex: detected, skipped (${skip_codex_source}).');
    expect(script).toContain("Codex was not detected.");
    expect(script).toContain("Codex was detected, but the integration was skipped");
    // When a previous install wired Codex, the skip run says it left the
    // existing integration alone.
    expect(script).toContain("An existing Codex integration at ${CODEX_DIR}/hooks.json was left untouched.");
    // Same honest reporting for the mirrored opt-outs.
    expect(script).toContain('Gemini: detected, skipped (${skip_gemini_source}).');
    expect(script).toContain("Kiro was detected, but the integration was skipped");
    // Skip means do-not-write, never remove: even plannotator's own
    // stale-skill cleanup in the skipped agent's home is suspended.
    // (A skills opt-out suspends the same sweep, hence the || arm.)
    expect(script).toContain(
      'if [ "$skip_codex" -eq 1 ] || [ "$skip_skills" -eq 1 ]; then\n        continue',
    );
    expect(script).toContain('[ "$scope" = "$KIRO_SKILLS_DIR" ] && [ "$skip_kiro" -eq 1 ]');
    // The skip branch must not gain any removal command.
    const skipBlock = script.slice(
      script.indexOf('if [ "$codex_available" -eq 1 ] && [ "$skip_codex" -eq 1 ]; then'),
      script.indexOf('elif [ "$codex_available" -eq 1 ]; then'),
    );
    expect(skipBlock.length).toBeGreaterThan(0);
    expect(skipBlock).not.toContain("rm ");
    expect(skipBlock).not.toContain("mkdir");
    expect(skipBlock).not.toContain("cat >");
  });

  test("--skip-skills: flag, env var, config key, precedence (#1201)", () => {
    // Same three-layer shape as the per-agent family, but scoped to the
    // skills/slash-command checkout rather than one agent's home.
    expect(script).toContain("--skip-skills)");
    expect(script).toContain("SKIP_SKILLS_FLAG=0");
    // Env var follows the existing PLANNOTATOR_SKIP_*_INSTALL naming.
    expect(script).toContain('case "${PLANNOTATOR_SKIP_SKILLS_INSTALL:-}" in');
    // Config layer rides the shared skipInstall object walk, so the same
    // token check and explicit-false veto apply to skipInstall.skills.
    expect(script).toContain('skip_skills_source="config skipInstall.skills"');
    // Precedence by textual layering (later assignment wins): config, then
    // env var, then flag - matching skip_codex.
    const configIdx = script.indexOf('skip_skills_source="config skipInstall.skills"');
    const envIdx = script.indexOf('skip_skills_source="PLANNOTATOR_SKIP_SKILLS_INSTALL"');
    const flagIdx = script.indexOf('skip_skills_source="--skip-skills"');
    expect(configIdx).toBeGreaterThan(0);
    expect(envIdx).toBeGreaterThan(configIdx);
    expect(flagIdx).toBeGreaterThan(envIdx);
    // Advertised in the usage text alongside the per-agent opt-outs.
    expect(script).toContain("[--skip-kiro] [--skip-opencode] [--skip-skills]");
    expect(script).toContain("PLANNOTATOR_SKIP_SKILLS_INSTALL; config key:");
  });

  test("--skip-skills bails before the clone without tripping the guard (#1201)", () => {
    // The bail sits INSIDE the checkout subshell but BEFORE the clone, and
    // exits 0 - an opt-out is not a fetch failure, so checkout_failed stays 0.
    const subshellIdx = script.indexOf("checkout_failed=0");
    const skipExit = script.indexOf('    if [ "$skip_skills" -eq 1 ]; then\n        exit 0');
    const cloneIdx = script.indexOf("git clone --depth 1 --filter=blob:none --sparse");
    expect(subshellIdx).toBeGreaterThan(0);
    expect(skipExit).toBeGreaterThan(subshellIdx);
    expect(cloneIdx).toBeGreaterThan(skipExit);
    // #1201's guard is untouched: a REAL fetch failure still exits 1 with the
    // fetch error, which is the whole point of the commit this rides on.
    expect(script).toContain('if [ "${checkout_failed:-0}" -eq 1 ]; then');
    expect(script).toContain(
      "Error: unable to fetch ${REPO} at ${latest_tag} (network or git error).",
    );
    // git stops being a hard requirement when nothing is fetched, and the
    // hard-fail names the escape hatch.
    expect(script).toContain("To install without them, re-run with --skip-skills.");
  });

  test("--skip-skills reports honestly and never claims the commands are ready (#1201)", () => {
    expect(script).toContain('echo "Skills: skipped (${skip_skills_source})."');
    // A false "YOU'RE ALL SET!" over an empty skills dir is exactly what the
    // checkout guard exists to prevent, so the header changes too.
    expect(script).toContain('echo "  CLAUDE CODE USERS: BINARY INSTALLED"');
    // The "commands are ready" line is now the else arm of a skip check, so
    // it cannot print when nothing was installed.
    const readyIdx = script.indexOf(
      "The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready to use after you restart Claude Code!",
    );
    const bannerGateIdx = script.lastIndexOf(
      'if [ "$skip_skills" -eq 1 ]; then',
      readyIdx,
    );
    expect(readyIdx).toBeGreaterThan(0);
    expect(bannerGateIdx).toBeGreaterThan(0);
    expect(
      script.slice(bannerGateIdx, readyIdx),
    ).toContain("commands are NOT installed");
    // The extras ARE skills, so a saved extras=yes cannot smuggle an install
    // past the opt-out.
    expect(script).toContain(
      'if [ "$skip_skills" -eq 0 ] && [ "$extras_choice" = "yes" ] && [ "$extras_present" -eq 0 ]; then',
    );
    // Skip means do-not-write: the model-invocation rewrite and the
    // skill-scope sweeps are all suspended, never partially applied.
    expect(script).toContain(
      'if [ "$skip_skills" -eq 0 ] && [ -n "$invocable_choice" ] && [ "$invocable_choice" != "none" ]; then',
    );
    expect(script).toContain(
      'if [ "$skip_opencode" -eq 0 ] && [ "$skip_skills" -eq 0 ] && [ -f "$OPENCODE_COMMANDS_DIR/plannotator-archive.md" ]; then',
    );
  });
});

describe("install.ps1", () => {
  const script = readScript("install.ps1");

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
    // The exe path is JSON-escaped-quoted so hooks survive a space in the
    // install path (e.g. C:\Users\John Smith\...). Unquoted paths word-split
    // when the hook shell runs them and the hook silently never fires.
    expect(script).toContain('"command": "\\"$exePathJson\\" improve-context"');
    expect(script).toContain('"command": "\\"$exePathJson\\""');
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

  test("uses only ASCII text so Windows PowerShell can parse UTF-8 without a BOM", () => {
    expect(script).toContain('Write-Host "Verified build provenance (SLSA)"');
    expect(script).toMatch(/^[\x00-\x7F]*$/);
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
    // The removed /plannotator-archive OpenCode command stub is swept too.
    expect(script).toContain('Removing stale plannotator-archive command');
  });

  test("does not treat a skills-only Codex home as configured", () => {
    expect(script).toContain("codexHomeHasUserConfig");
    expect(script).toContain('$_.Name -ne "skills"');
    expect(script).toContain("$codexAvailable");
  });

  test("suggests installing extras via npx skills add", () => {
    expect(script).toContain("Optional skills (compound planning, setup-goal, visual explainer):");
    expect(script).toContain("npx skills add backnotprop/plannotator/apps/skills/extra --global");
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

  test("supports -Minimal / -BinaryOnly binary-only mode with env-var fallback", () => {
    // Switch + alias in the param block, plus the PLANNOTATOR_MINIMAL env fallback.
    expect(script).toContain('[Alias("BinaryOnly")]');
    expect(script).toContain("[switch]$Minimal");
    expect(script).toContain("[switch]$NoMinimal");
    expect(script).toContain("$env:PLANNOTATOR_MINIMAL");
    // -Minimal / -NoMinimal are mutually exclusive (parity with sh/cmd).
    expect(script).toContain("-Minimal and -NoMinimal are mutually exclusive");
  });

  test("minimal mode exits after the binary install, before any extras", () => {
    // Same ordering guarantee as install.sh: binary placed, then the early exit,
    // then (only in the full install) the sidecar + integration work.
    const binaryInstalled = script.indexOf(
      'Move-Item -Force $tmpFile "$installDir\\plannotator.exe"',
    );
    const minimalExit = script.indexOf("if ($minimal) {");
    const semInstall = script.indexOf("Install-SemSidecar\n");
    const callFlow = script.indexOf("Install-CallFlowRuntime\n");
    const pathAdvice = script.indexOf("function Show-PathAdvice");

    expect(binaryInstalled).toBeGreaterThan(0);
    expect(pathAdvice).toBeGreaterThan(binaryInstalled);
    expect(minimalExit).toBeGreaterThan(binaryInstalled);
    expect(semInstall).toBeGreaterThan(minimalExit);
    expect(callFlow).toBeGreaterThan(minimalExit);
    // The gate exits rather than falling through.
    const gateBody = script.slice(minimalExit, minimalExit + 400);
    expect(gateBody).toContain("exit 0");
  });

  test("per-agent skip opt-outs: switches, env vars, config keys, precedence (#1178)", () => {
    expect(script).toContain("[switch]$SkipCodex");
    expect(script).toContain("[switch]$SkipGemini");
    expect(script).toContain("[switch]$SkipKiro");
    expect(script).toContain("[switch]$SkipOpencode");
    expect(script).toContain("PLANNOTATOR_SKIP_CODEX_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_GEMINI_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_KIRO_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_OPENCODE_INSTALL");
    // Config layer parses the real nested JSON (strict boolean check, like
    // verifyAttestation).
    expect(script).toContain("$cfg.skipInstall.codex -is [bool]");
    expect(script).toContain("$cfg.skipInstall.gemini -is [bool]");
    expect(script).toContain("$cfg.skipInstall.kiro -is [bool]");
    expect(script).toContain("$cfg.skipInstall.opencode -is [bool]");
    // Precedence by textual layering (later assignment wins): config, then
    // env var, then switch.
    const configIdx = script.indexOf('$skipCodexSource = "config skipInstall.codex"');
    const envIdx = script.indexOf('$skipCodexSource = "PLANNOTATOR_SKIP_CODEX_INSTALL"');
    const flagIdx = script.indexOf('$skipCodexSource = "-SkipCodex"');
    expect(configIdx).toBeGreaterThan(0);
    expect(envIdx).toBeGreaterThan(configIdx);
    expect(flagIdx).toBeGreaterThan(envIdx);
  });

  test("skip states are reported honestly and never remove existing integrations (#1178)", () => {
    // Three distinct Codex states (ps1 never writes the Codex home; the
    // installed state prints manual instructions instead, and the skip
    // wording says exactly that - M4).
    expect(script).toContain('Codex: detected, skipped ($skipCodexSource)."');
    expect(script).toContain('Write-Host "Codex detected."');
    expect(script).toContain("The Windows installer only prints manual Codex setup instructions");
    // M4: the existing-hook note requires plannotator CONTENT in hooks.json,
    // never mere file existence (the file may hold only the user's own
    // hooks), and its wording matches what this platform actually does.
    expect(script).toContain('$codexHooksContent -match "plannotator"');
    expect(script).toContain("Your existing Codex Stop hook at $codexDir\\hooks.json is unaffected.");
    expect(script).not.toContain("An existing Codex integration at $codexDir\\hooks.json was left untouched.");
    expect(script).toContain('Gemini: detected, skipped ($skipGeminiSource)."');
    expect(script).toContain("Kiro was detected, but the integration was skipped");
    // Skip suspends even plannotator's own cleanup inside the skipped
    // agent's home (do-not-write, never remove).
    // (A skills opt-out suspends the same sweep, hence the -or arm.)
    expect(script).toContain("if ($skipCodexResolved -or $skipSkillsResolved) { continue }");
    expect(script).toContain('if ($skipKiroResolved -and ($scope -eq "$env:USERPROFILE\\.kiro\\skills")) { continue }');
    // Gated install sites for the mirrored opt-outs.
    expect(script).toContain("-not $skipKiroResolved");
    expect(script).toContain("-not $skipGeminiResolved");
  });

  test("-SkipSkills: switch, env var, config key, precedence (#1201)", () => {
    expect(script).toContain("[switch]$SkipSkills");
    expect(script).toContain("PLANNOTATOR_SKIP_SKILLS_INSTALL");
    expect(script).toContain("$cfg.skipInstall.skills -is [bool]");
    // Precedence by textual layering (later assignment wins): config, then
    // env var, then switch - matching skipCodex.
    const configIdx = script.indexOf('$skipSkillsSource = "config skipInstall.skills"');
    const envIdx = script.indexOf('$skipSkillsSource = "PLANNOTATOR_SKIP_SKILLS_INSTALL"');
    const flagIdx = script.indexOf('$skipSkillsSource = "-SkipSkills"');
    expect(configIdx).toBeGreaterThan(0);
    expect(envIdx).toBeGreaterThan(configIdx);
    expect(flagIdx).toBeGreaterThan(envIdx);
  });

  test("-SkipSkills skips the clone without tripping the guard (#1201)", () => {
    // No clone is attempted, and the skip arm precedes the Test-Path leg so
    // $checkoutFailed stays $false: an opt-out is not a fetch failure.
    expect(script).toContain("if (-not $skipSkillsResolved) {");
    const skipArm = script.indexOf('if ($skipSkillsResolved) {\n        # Opt-out: no clone was attempted');
    const elseIfTestPath = script.indexOf('} elseif (Test-Path "$skillsTmp\\repo") {');
    expect(skipArm).toBeGreaterThan(0);
    expect(elseIfTestPath).toBeGreaterThan(skipArm);
    // The fetch-failure guard is untouched.
    expect(script).toContain("if ($checkoutFailed) {");
    expect(script).toContain("Error: unable to fetch $repo at $latestTag (network or git error).");
    // git stops being a hard requirement, and the hard-fail names the flag.
    expect(script).toContain("} elseif (-not (Get-Command git -ErrorAction SilentlyContinue)) {");
    expect(script).toContain("To install without them, re-run with -SkipSkills.");
  });

  test("-SkipSkills reports honestly and suspends every skill write (#1201)", () => {
    expect(script).toContain('Write-Host "Skills: skipped ($skipSkillsSource)."');
    expect(script).toContain('Write-Host "  CLAUDE CODE USERS: BINARY INSTALLED"');
    // Extras are skills too, so the opt-out covers them.
    expect(script).toContain(
      'if ((-not $skipSkillsResolved) -and ($extrasChoice -eq "yes") -and (-not $extrasPresent)) {',
    );
    // Do-not-write: model-invocation rewrite and the stale-stub sweep are
    // both suspended rather than partially applied.
    expect(script).toContain(
      '(-not $skipSkillsResolved) -and $invocableChoice -and ($invocableChoice -ne "none")',
    );
    expect(script).toContain(
      "(-not $skipOpencodeResolved) -and (-not $skipSkillsResolved) -and (Test-Path $staleOpencodeArchive)",
    );
  });
});

describe("install.cmd", () => {
  const script = readScript("install.cmd");

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
    // Quoted for space-in-path installs — same invariant as install.ps1.
    expect(script).toContain('echo             "command": "\\"!EXE_PATH!\\" improve-context",');
    expect(script).toContain('echo             "command": "\\"!EXE_PATH!\\"",');
    expect(script).toContain('echo             "timeout": 5');
  });

  test("uses full exe path in hooks.json", () => {
    expect(script).toContain("EXE_PATH");
    expect(script).toContain('!INSTALL_PATH:\\=/!');
  });

  test("uses only ASCII text so cmd.exe consoles render output on any codepage", () => {
    // Mirrors install.ps1's ASCII guarantee (#1021): cmd.exe's default active
    // code page is not UTF-8, so em-dashes/ellipses in echoed strings render
    // as mojibake for most Windows users.
    expect(script).toMatch(/^[\x00-\x7F]*$/);
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
    // The removed /plannotator-archive OpenCode command stub is swept too.
    expect(script).toContain('del /q "!OPENCODE_COMMANDS_DIR!\\plannotator-archive.md"');
  });

  test("does not treat a skills-only Codex home as configured", () => {
    expect(script).toContain("CODEX_AVAILABLE");
    expect(script).toContain('if /i not "%%C"=="skills"');
  });

  test("suggests installing extras via npx skills add", () => {
    expect(script).toContain("Optional skills");
    expect(script).toContain("npx skills add backnotprop/plannotator/apps/skills/extra --global");
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

  test("supports --minimal / --binary-only binary-only mode with env-var fallback", () => {
    expect(script).toContain('if /i "%~1"=="--minimal"');
    expect(script).toContain('if /i "%~1"=="--binary-only"');
    expect(script).toContain('if /i "%~1"=="--no-minimal"');
    expect(script).toContain("PLANNOTATOR_MINIMAL");
    // Usage string advertises the flag.
    expect(script).toContain("[--minimal ^| --no-minimal]");
    // --minimal / --no-minimal are mutually exclusive (parity with sh/ps1).
    expect(script).toContain("--minimal and --no-minimal are mutually exclusive");
  });

  test("minimal mode exits after the binary install, before any extras", () => {
    const binaryInstalled = script.indexOf(
      'move /y "!TEMP_FILE!" "!INSTALL_PATH!"',
    );
    const minimalExit = script.indexOf('if "!MINIMAL!"=="1" (');
    const semInstall = script.indexOf("call :InstallSemSidecar");
    const callFlow = script.indexOf("call :InstallCallFlowRuntime");
    const printPathAdvice = script.indexOf(":PrintPathAdvice");

    expect(binaryInstalled).toBeGreaterThan(0);
    expect(minimalExit).toBeGreaterThan(binaryInstalled);
    expect(semInstall).toBeGreaterThan(minimalExit);
    expect(callFlow).toBeGreaterThan(minimalExit);
    // The gate exits rather than falling through, and reuses :PrintPathAdvice.
    const gateBody = script.slice(minimalExit, minimalExit + 400);
    expect(gateBody).toContain("call :PrintPathAdvice");
    expect(gateBody).toContain("exit /b 0");
    // :PrintPathAdvice is defined as a subroutine.
    expect(printPathAdvice).toBeGreaterThan(0);
  });

  test("per-agent skip opt-outs: flags, env vars, config keys, precedence (#1178)", () => {
    expect(script).toContain('if /i "%~1"=="--skip-codex"');
    expect(script).toContain('if /i "%~1"=="--skip-gemini"');
    expect(script).toContain('if /i "%~1"=="--skip-kiro"');
    expect(script).toContain('if /i "%~1"=="--skip-opencode"');
    expect(script).toContain("PLANNOTATOR_SKIP_CODEX_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_GEMINI_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_KIRO_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_OPENCODE_INSTALL");
    // Config layer (M2): the REAL JSON is parsed by PowerShell (strict
    // boolean check, matching install.ps1) instead of a line-oblivious
    // findstr - so a "codex": true under some OTHER key can never opt
    // anyone out and an explicit false inside skipInstall is honored.
    expect(script).toContain("$c.skipInstall.$k");
    expect(script).toContain("@('codex','gemini','kiro','opencode','skills')");
    expect(script).toContain("$v -is [bool] -and $v");
    expect(script).toContain("PLN_CONFIG_JSON");
    expect(script).toContain("skipInstall.codex");
    expect(script).toContain("skipInstall.gemini");
    expect(script).toContain("skipInstall.kiro");
    expect(script).toContain("skipInstall.opencode");
    // The old whole-file findstr form is gone.
    expect(script).not.toContain('findstr /r /c:"\\"codex\\"');
    // Precedence by textual layering (later assignment wins): config, then
    // env var, then flag.
    const configIdx = script.indexOf('set "SKIP_CODEX_SOURCE=config skipInstall.codex"');
    const envIdx = script.indexOf('set "SKIP_CODEX_SOURCE=PLANNOTATOR_SKIP_CODEX_INSTALL"');
    const flagIdx = script.indexOf('set "SKIP_CODEX_SOURCE=--skip-codex"');
    expect(configIdx).toBeGreaterThan(0);
    expect(envIdx).toBeGreaterThan(configIdx);
    expect(flagIdx).toBeGreaterThan(envIdx);
  });

  test("skip states are reported honestly and never remove existing integrations (#1178)", () => {
    // Three distinct Codex states (cmd never writes the Codex home; the
    // installed state prints manual instructions instead, and the skip
    // wording says exactly that - M4).
    expect(script).toContain("Codex: detected, skipped ^(!SKIP_CODEX_SOURCE!^).");
    expect(script).toContain("echo Codex detected.");
    expect(script).toContain("The Windows installer only prints manual Codex setup instructions");
    // M4: the existing-hook note requires plannotator CONTENT in hooks.json,
    // never mere file existence, and its wording matches what this platform
    // actually does.
    expect(script).toContain('findstr /c:"plannotator" "!CODEX_DIR!\\hooks.json"');
    expect(script).toContain("Your existing Codex Stop hook at !CODEX_DIR!\\hooks.json is unaffected.");
    expect(script).not.toContain("An existing Codex integration at !CODEX_DIR!\\hooks.json was left untouched.");
    expect(script).toContain("Gemini: detected, skipped ^(!SKIP_GEMINI_SOURCE!^).");
    expect(script).toContain("Kiro was detected, but the integration was skipped");
    // Skip suspends even plannotator's own cleanup inside the skipped
    // agent's home (do-not-write, never remove).
    // (A skills opt-out suspends the same sweep, hence the extra guard.)
    expect(script).toContain(
      'if "!SKIP_CODEX!"=="0" if "!SKIP_SKILLS!"=="0" if exist "!STALE_CODEX_SKILLS_DIR!\\%%S"',
    );
    expect(script).toContain('if /i "%%~D"=="!KIRO_SKILLS_DIR!" if "!SKIP_KIRO!"=="1" set "SCOPE_OK=0"');
    // Gated install sites for the mirrored opt-outs.
    expect(script).toContain('if "!KIRO_AVAILABLE!"=="1" if "!SKIP_KIRO!"=="0" if exist "apps\\kiro-cli\\skills"');
    expect(script).toContain('if exist "%USERPROFILE%\\.gemini" if "!SKIP_GEMINI!"=="0"');
  });

  test("--skip-skills: flag, env var, config key, precedence (#1201)", () => {
    expect(script).toContain('if /i "%~1"=="--skip-skills"');
    expect(script).toContain('set "SKIP_SKILLS_FLAG=0"');
    expect(script).toContain("PLANNOTATOR_SKIP_SKILLS_INSTALL");
    expect(script).toContain("skipInstall.skills");
    // Precedence by textual layering (later assignment wins): config, then
    // env var, then flag - matching SKIP_CODEX.
    const configIdx = script.indexOf('set "SKIP_SKILLS_SOURCE=config skipInstall.skills"');
    const envIdx = script.indexOf('set "SKIP_SKILLS_SOURCE=PLANNOTATOR_SKIP_SKILLS_INSTALL"');
    const flagIdx = script.indexOf('set "SKIP_SKILLS_SOURCE=--skip-skills"');
    expect(configIdx).toBeGreaterThan(0);
    expect(envIdx).toBeGreaterThan(configIdx);
    expect(flagIdx).toBeGreaterThan(envIdx);
    // Advertised in the usage text alongside the per-agent opt-outs.
    expect(script).toContain("[--skip-opencode] [--skip-skills]");
  });

  test("--skip-skills jumps past the clone without tripping the guard (#1201)", () => {
    // The jump lands after the clone/copy block but before the cleanup, so
    // CHECKOUT_FAILED stays 0: an opt-out is not a fetch failure.
    const gotoIdx = script.indexOf('if "!SKIP_SKILLS!"=="1" goto skills_checkout_done');
    const cloneIdx = script.indexOf("git clone --depth 1 --filter=blob:none --sparse");
    const labelIdx = script.indexOf(":skills_checkout_done");
    const guardIdx = script.indexOf('if "!CHECKOUT_FAILED!"=="1" (');
    expect(gotoIdx).toBeGreaterThan(0);
    expect(cloneIdx).toBeGreaterThan(gotoIdx);
    expect(labelIdx).toBeGreaterThan(cloneIdx);
    expect(guardIdx).toBeGreaterThan(labelIdx);
    // The fetch-failure guard is untouched.
    expect(script).toContain("echo Error: unable to fetch !REPO! at !TAG! ^(network or git error^). 1>&2");
    // git stops being a hard requirement, and the hard-fail names the flag.
    expect(script).toContain("echo To install without them, re-run with --skip-skills. 1>&2");
  });

  test("--skip-skills reports honestly and suspends every skill write (#1201)", () => {
    expect(script).toContain("echo Skills: skipped ^(!SKIP_SKILLS_SOURCE!^).");
    // The "skills are ready" line must not print when nothing was installed.
    const readyIdx = script.indexOf(
      "echo The /plannotator-review, /plannotator-annotate, and /plannotator-last skills are ready to use!",
    );
    const bannerGateIdx = script.lastIndexOf('if "!SKIP_SKILLS!"=="1" (', readyIdx);
    expect(readyIdx).toBeGreaterThan(0);
    expect(bannerGateIdx).toBeGreaterThan(0);
    expect(script.slice(bannerGateIdx, readyIdx)).toContain("skills are NOT installed.");
    // Extras are skills too, and the do-not-write sweeps are suspended.
    expect(script).toContain(
      'if "!SKIP_SKILLS!"=="0" if "!EXTRAS_CHOICE!"=="yes" if "!EXTRAS_PRESENT!"=="0" (',
    );
    expect(script).toContain(
      'if "!SKIP_SKILLS!"=="0" if defined INVOCABLE_CHOICE if not "!INVOCABLE_CHOICE!"=="none" (',
    );
    expect(script).toContain('if "!SKIP_SKILLS!"=="1" set "SCOPE_OK=0"');
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
  const sh = readScript("install.sh");
  const ps = readScript("install.ps1");

  test("all installers advertise the conventional uninstall command", () => {
    for (const [name, script] of [
      ["install.sh", sh],
      ["install.ps1", ps],
      ["install.cmd", readScript("install.cmd")],
    ] as const) {
      expect(script, name).toContain(
        "To uninstall later: plannotator uninstall",
      );
    }
  });

  test("every extras install command uses global scope", () => {
    const files = [
      "scripts/install.sh",
      "scripts/install.ps1",
      "scripts/install.cmd",
      "AGENTS.md",
      "apps/marketing/src/content/docs/getting-started/installation.md",
      "apps/marketing/src/content/docs/guides/claude-code.md",
    ];
    const command = "npx skills add backnotprop/plannotator/apps/skills/extra";

    for (const file of files) {
      const contents = readFileSync(join(scriptsDir, "..", file), "utf-8").replace(/\r\n?/g, "\n");
      const commandCount = contents.split(command).length - 1;
      const globalCommandCount = contents.split(`${command} --global`).length - 1;
      expect(commandCount, `${file} should contain an extras install command`).toBeGreaterThan(0);
      expect(globalCommandCount, `${file} has an extras install command without --global`).toBe(commandCount);
    }
  });

  test("install.cmd contains no unix redirect bash-isms", () => {
    // Tripwire: during PR #850 development, three freshly written `>nul`
    // redirects in install.cmd were found rewritten to `>/dev/null` by an
    // unidentified external tool. In batch, >/dev/null redirects to a literal
    // .\dev\null file. If this trips, something between editor and disk is
    // rewriting cmd syntax.
    const cmdScript = readScript("install.cmd");
    expect(cmdScript).not.toContain("/dev/null");
  });

  test("binary-only (minimal) mode exists in all three installers", () => {
    const cmdScript = readScript("install.cmd");
    // Every installer exposes the flag, its --binary-only / -BinaryOnly alias,
    // the explicit opt-out, and the PLANNOTATOR_MINIMAL env-var fallback — so a
    // user gets the same binary-only path whatever host they install from.
    expect(sh).toContain("--minimal|--binary-only)");
    expect(sh).toContain("--no-minimal)");
    expect(sh).toContain("PLANNOTATOR_MINIMAL");

    expect(ps).toContain('[Alias("BinaryOnly")]');
    expect(ps).toContain("[switch]$Minimal");
    expect(ps).toContain("[switch]$NoMinimal");
    expect(ps).toContain("$env:PLANNOTATOR_MINIMAL");

    expect(cmdScript).toContain('if /i "%~1"=="--minimal"');
    expect(cmdScript).toContain('if /i "%~1"=="--binary-only"');
    expect(cmdScript).toContain('if /i "%~1"=="--no-minimal"');
    expect(cmdScript).toContain("PLANNOTATOR_MINIMAL");
  });

  test("guided install exists in all three installers with safe automation behavior", () => {
    const cmdScript = readScript("install.cmd");
    // Shared prefs file (same format across platforms) in the data dir.
    expect(sh).toContain('PREFS_FILE="$_config_dir/install-prefs"');
    expect(ps).toContain('Join-Path $configDir "install-prefs"');
    expect(cmdScript).toContain('set "PREFS_FILE=!_CONFIG_DIR!\\install-prefs"');
    // Non-interactive escape hatch everywhere.
    expect(sh).toContain("--non-interactive");
    expect(ps).toContain("[switch]$NonInteractive");
    expect(cmdScript).toContain('"%~1"=="--non-interactive"');
    // Prompts are bounded so an attached-but-unattended console can't hang:
    // sh via read -t / PROMPT_TIMEOUT, ps1 via a timed Read-LineWithTimeout,
    // both overridable with PLANNOTATOR_PROMPT_TIMEOUT.
    expect(sh).toContain("PLANNOTATOR_PROMPT_TIMEOUT");
    expect(ps).toContain("Read-LineWithTimeout");
    expect(ps).toContain("PLANNOTATOR_PROMPT_TIMEOUT");
    // The wizard only runs with a real terminal/console attached.
    expect(sh).toContain("{ : < /dev/tty; } 2>/dev/null");
    expect(ps).toContain("[Console]::IsInputRedirected");
    // cmd probes for a real console via `timeout /t 0` (errors when stdin is
    // redirected) so CI/redirected runs never see the wizard — and never run
    // the wizard-only install (npx extras). set /p's empty-at-EOF
    // behavior remains as a second line of defense against hangs.
    expect(cmdScript).toContain("timeout /t 0");
    expect(cmdScript).toContain('if "!CAN_PROMPT!"=="1"');
    expect(cmdScript).toContain("set /p");
    // Silent re-runs must not clobber saved answers with defaults, and a wizard
    // that timed out to synthetic fallbacks (unattended /dev/tty) must not be
    // persisted — ask_yes_no returns non-zero on timeout/EOF, each prompt ORs
    // that into wizard_timed_out, and the prefs write is gated on it.
    expect(sh).toContain('if [ "$wizard_timed_out" -eq 0 ] && { [ "$run_wizard" -eq 1 ] || [ -n "$EXTRAS_FLAG" ] || [ -n "$MODEL_INVOCABLE_FLAG" ]; }');
    expect(sh).toContain("wizard_timed_out=0");
    expect(sh).toContain("|| wizard_timed_out=1");
    expect(sh).toMatch(/echo "no"\s+return 1/);
    // The bounded read stays in a tested context (`|| rc=$?`) so `set -e` never
    // aborts ask_yes_no on a timeout/EOF, regardless of how it's called.
    expect(sh).toContain('< /dev/tty || rc=$?');
    expect(ps).toContain("if ($runWizard -or $Extras -or $NoExtras -or $ModelInvocable)");
    expect(cmdScript).toContain('if "!DO_PERSIST!"=="1"');
    // The Glimpse install option was removed — installers must not reference it
    // (the runtime still auto-detects glimpseui on PATH; that lives elsewhere).
    for (const s of [sh, ps, cmdScript]) {
      expect(s).not.toContain("glimpseui");
      expect(s.toLowerCase()).not.toContain("--no-glimpse");
    }
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
    const cmdScript = readScript("install.cmd");
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
    const cmdScript = readScript("install.cmd");
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
    const cmdScript = readScript("install.cmd");

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
    const cmdScript = readScript("install.cmd");

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
    const cmdScript = readScript("install.cmd");
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
    const cmdScript = readScript("install.cmd");

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
    const cmdScript = readScript("install.cmd");
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
    const cmdScript = readScript("install.cmd");
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
    const cmdScript = readScript("install.cmd");
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
    const cmdScript = readScript("install.cmd");
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
    const cmdScript = readScript("install.cmd");

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

  test("all installers install sem sidecar as a non-fatal optional dependency", () => {
    const cmdScript = readScript("install.cmd");

    expect(sh).toContain('SEM_REPO="Ataraxy-Labs/sem"');
    expect(sh).toContain('SEM_VERSION="v0.8.0"');
    expect(sh).toContain("install_sem_sidecar");
    expect(sh).toContain("Skipping semantic diff sidecar install");
    expect(sh).toContain('${_config_dir}/vendor/sem/${SEM_VERSION}');
    expect(sh).toContain('if ! mkdir -p "$sem_dir"; then');
    expect(sh).toContain('if ! cp "$extracted_sem" "$sem_bin"; then');
    expect(sh).toContain('if ! chmod +x "$sem_bin"; then');

    expect(ps).toContain('$semRepo = "Ataraxy-Labs/sem"');
    expect(ps).toContain('$semVersion = "v0.8.0"');
    expect(ps).toContain("function Install-SemSidecar");
    expect(ps).toContain('if ($platform -eq "win32-x64")');
    expect(ps).toContain("Skipping semantic diff sidecar install");

    expect(cmdScript).toContain('set "SEM_REPO=Ataraxy-Labs/sem"');
    expect(cmdScript).toContain('set "SEM_VERSION=v0.8.0"');
    expect(cmdScript).toContain("call :InstallSemSidecar");
    expect(cmdScript).toContain('if /i "!PLATFORM!"=="win32-x64" set "SEM_ASSET=sem-windows-x86_64.zip"');
    expect(cmdScript).toContain("Skipping semantic diff sidecar install");
    expect(cmdScript).toContain("Get-ChildItem -Path $env:SEM_EXTRACT -Filter sem.exe -Recurse -File");
    expect(cmdScript).toContain('copy /y "!EXTRACTED_SEM!" "!SEM_PATH!"');

    // The sidecar download is time-bounded so a slow/hung fetch can't wedge an
    // install where plannotator itself already landed (all three installers).
    expect(sh).toContain("--connect-timeout 10 --max-time 120");
    expect(ps).toContain("-TimeoutSec 120");
    expect(cmdScript).toContain("--connect-timeout 10 --max-time 120");
    // And the opt-out is documented in the help text.
    expect(sh).toContain("PLANNOTATOR_SKIP_SEM_INSTALL=1");
  });

  test("all installers install agent terminal runtime as a non-fatal optional dependency", () => {
    const cmdScript = readScript("install.cmd");

    expect(sh).toContain("install_agent_terminal_runtime");
    expect(sh).toContain('"$INSTALL_DIR/plannotator" install-runtime agent-terminal');
    expect(sh).toContain("Skipping agent terminal runtime install");
    expect(sh).toContain("PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL=1");

    expect(ps).toContain("function Install-AgentTerminalRuntime");
    expect(ps).toContain("& $plannotatorPath install-runtime agent-terminal");
    expect(ps).toContain("Skipping agent terminal runtime install");
    expect(ps).toContain("PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL");

    expect(cmdScript).toContain("call :InstallAgentTerminalRuntime");
    expect(cmdScript).toContain('"!INSTALL_PATH!" install-runtime agent-terminal');
    expect(cmdScript).toContain("Skipping agent terminal runtime install");
    expect(cmdScript).toContain("PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL");
  });

  test("the CallDiff runtime is strictly opt-in: default sequence never installs it", () => {
    const cmdScript = readScript("install.cmd");

    // install.sh: the install call is gated on the resolved opt-in, which
    // defaults to 0, and the default path prints the in-app install note.
    expect(sh).toContain("install_call_flow=0");
    expect(sh).toContain('if [ "$install_call_flow" -ne 1 ]; then');
    expect(sh).toContain("available as an in-app opt-in install");
    expect(sh).toContain('"$INSTALL_DIR/plannotator" install-runtime call-flow');

    // install.ps1: same shape via $installCallFlowResolved (default $false).
    expect(ps).toContain("$installCallFlowResolved = $false");
    expect(ps).toContain("if (-not $installCallFlowResolved) {");
    expect(ps).toContain("available as an in-app opt-in install");
    expect(ps).toContain("& $plannotatorPath install-runtime call-flow");

    // install.cmd: same shape via INSTALL_CALL_FLOW (default 0).
    expect(cmdScript).toContain('set "INSTALL_CALL_FLOW=0"');
    expect(cmdScript).toContain('if not "!INSTALL_CALL_FLOW!"=="1" (');
    expect(cmdScript).toContain("available as an in-app opt-in install");
    expect(cmdScript).toContain('"!INSTALL_PATH!" install-runtime call-flow');
  });

  test("the CallDiff opt-in resolves flag > env > config in every installer", () => {
    const cmdScript = readScript("install.cmd");

    // Flag layer.
    expect(sh).toContain("--with-call-flow)");
    expect(ps).toContain("[switch]$WithCallFlow");
    expect(cmdScript).toContain('if /i "%~1"=="--with-call-flow" (');

    // Env layer.
    expect(sh).toContain("PLANNOTATOR_INSTALL_CALLDIFF");
    expect(ps).toContain("PLANNOTATOR_INSTALL_CALLDIFF");
    expect(cmdScript).toContain("PLANNOTATOR_INSTALL_CALLDIFF");

    // Config layer (flat top-level boolean, matching verifyAttestation).
    expect(sh).toContain('"installCallFlow"');
    expect(ps).toContain("$cfg.installCallFlow");
    expect(cmdScript).toContain('\\"installCallFlow\\"');

    // In each script the flag assignment comes after the env resolution so
    // the flag wins, mirroring the verifyAttestation layering.
    const shEnv = sh.indexOf('PLANNOTATOR_INSTALL_CALLDIFF:-');
    const shFlag = sh.indexOf('install_call_flow="$WITH_CALL_FLOW_FLAG"');
    expect(shEnv).toBeGreaterThan(0);
    expect(shFlag).toBeGreaterThan(shEnv);
    const psEnv = ps.indexOf("$env:PLANNOTATOR_INSTALL_CALLDIFF");
    const psFlag = ps.indexOf("if ($WithCallFlow) { $installCallFlowResolved = $true }");
    expect(psEnv).toBeGreaterThan(0);
    expect(psFlag).toBeGreaterThan(psEnv);
    const cmdEnv = cmdScript.indexOf('if /i "!PLANNOTATOR_INSTALL_CALLDIFF!"=="1"');
    const cmdFlag = cmdScript.indexOf('if "!WITH_CALL_FLOW_FLAG!"=="1" set "INSTALL_CALL_FLOW=1"');
    expect(cmdEnv).toBeGreaterThan(0);
    expect(cmdFlag).toBeGreaterThan(cmdEnv);
  });

  test("the removed CallDiff skip opt-out is gone from every installer", () => {
    const cmdScript = readScript("install.cmd");
    // Opting out of a default-off install is meaningless; the env var was
    // deleted rather than kept for back-compat.
    expect(sh).not.toContain("PLANNOTATOR_SKIP_CALLDIFF_INSTALL");
    expect(ps).not.toContain("PLANNOTATOR_SKIP_CALLDIFF_INSTALL");
    expect(cmdScript).not.toContain("PLANNOTATOR_SKIP_CALLDIFF_INSTALL");
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
    const cmdScript = readScript("install.cmd");
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
    const cmdScript = readScript("install.cmd");
    expect(cmdScript).toContain('if not "!TAG:~0,1!"=="v"');
    expect(cmdScript).not.toContain("echo !TAG! | findstr");
  });

  test("all installers constrain attestation verify to tag + signer workflow", () => {
    // Every `gh attestation verify` call must pass --source-ref and
    // --signer-workflow, not just --repo. Without --source-ref a
    // misattached asset from a different release would pass; without
    // --signer-workflow an attestation from an unrelated workflow in
    // the same repo would pass. GitHub's own docs recommend both.
    const cmdScript = readScript("install.cmd");

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

  test("all installers authenticate the api.github.com version-resolution call", () => {
    // api.github.com caps unauthenticated requests at 60/hour per source IP
    // (not per user), which fails installs behind shared egress IPs
    // (NAT/CGNAT/corporate proxies) and during repeated/debug runs within an
    // hour. Each installer must attach an Authorization header to the
    // releases/latest call when a token is available, using the same
    // precedence across platforms: GITHUB_TOKEN > GH_TOKEN > `gh auth token`.
    // When no token is found it must fall back to anonymous (unchanged
    // behavior). See backnotprop/plannotator#1156.
    const cmdScript = readScript("install.cmd");

    // Shared precedence + bearer scheme across all three installers.
    for (const [name, script] of [["install.sh", sh], ["install.ps1", ps], ["install.cmd", cmdScript]] as const) {
      expect(script, `${name} should read GITHUB_TOKEN`).toContain("GITHUB_TOKEN");
      expect(script, `${name} should read GH_TOKEN`).toContain("GH_TOKEN");
      expect(script, `${name} should use a Bearer scheme`).toContain("Bearer ");
      // The gh fallback is pinned to github.com so a gh setup whose default
      // host is a GitHub Enterprise server never leaks a GHES token to
      // api.github.com. (cmd invokes gh via a where-resolved absolute path,
      // so match on the flag-bearing suffix common to all three.)
      expect(script, `${name} should scope the gh fallback to github.com`).toContain(
        "auth token --hostname github.com",
      );
    }

    // Precedence pin: GITHUB_TOKEN is consulted before GH_TOKEN in every
    // installer (matching gh's own precedence).
    expect(sh).toContain("${GITHUB_TOKEN:-${GH_TOKEN:-}}");
    const psGithubRead = ps.indexOf("$ghToken = $env:GITHUB_TOKEN");
    const psGhRead = ps.indexOf("{ $ghToken = $env:GH_TOKEN }");
    expect(psGithubRead).toBeGreaterThan(0);
    expect(psGhRead).toBeGreaterThan(psGithubRead);
    const cmdGithubRead = cmdScript.indexOf('set "GH_TOKEN_VAL=!GITHUB_TOKEN!"');
    const cmdGhRead = cmdScript.indexOf('set "GH_TOKEN_VAL=!GH_TOKEN!"');
    expect(cmdGithubRead).toBeGreaterThan(0);
    expect(cmdGhRead).toBeGreaterThan(cmdGithubRead);
    // The percent-expansion reads are injection vectors (cmd's phase-1 %
    // expansion re-parses metacharacters in the value) and must stay gone.
    expect(cmdScript).not.toContain('set "GH_TOKEN_VAL=%GITHUB_TOKEN%"');
    expect(cmdScript).not.toContain('set "GH_TOKEN_VAL=%GH_TOKEN%"');

    // install.sh: header array splatted into the api curl.
    expect(sh).toContain("GH_AUTH_HEADER=()");
    expect(sh).toContain('"${GH_AUTH_HEADER[@]}" "$_api_url"');

    // install.ps1: hashtable passed via -Headers to Invoke-RestMethod.
    expect(ps).toContain('$ghHeaders = if ($ghToken) { @{ Authorization = "Bearer $ghToken" } } else { @{} }');
    expect(ps).toContain("-Headers $ghHeaders");

    // install.cmd: arg splatted into the api curl via delayed expansion.
    expect(cmdScript).toContain('set "GH_AUTH_HEADER=-H "Authorization: Bearer !GH_TOKEN_VAL!""');
    expect(cmdScript).toContain('curl -fsSL !GH_AUTH_HEADER! "https://api.github.com/repos/!REPO!/releases/latest"');
  });

  test("auth header is used ONLY on the api.github.com call, never on downloads", () => {
    // The 60/hr REST limit applies only to api.github.com. Release-asset
    // downloads (github.com/.../releases/download) are not subject to it,
    // and authing those would expose the token in argv/process list for the
    // full duration of a large binary download. Tripwire: if a future edit
    // splats the auth header into any download curl, these fail. See
    // backnotprop/plannotator#1156.
    const cmdScript = readScript("install.cmd");

    // install.sh: binary download and checksum download must NOT carry the
    // auth header array. Token vars cleared right after the api call so
    // they don't linger for the download phase.
    expect(sh).not.toContain('curl -fsSL "${GH_AUTH_HEADER[@]}" -o "$tmp_file"');
    expect(sh).not.toContain('curl -fsSL "${GH_AUTH_HEADER[@]}" "$checksum_url"');
    expect(sh).toContain("unset _gh_token GH_AUTH_HEADER _api_url");

    // install.ps1: binary download must NOT carry $ghHeaders, which is nulled.
    expect(ps).not.toContain('Invoke-WebRequest -Uri $binaryUrl -OutFile $tmpFile -Headers $ghHeaders');
    expect(ps).toContain('$ghToken = $null; $ghHeaders = $null; $apiUrl = $null');

    // install.cmd: binary download must NOT carry !GH_AUTH_HEADER!. Token
    // vars cleared after the api call.
    expect(cmdScript).not.toContain('curl -fsSL !GH_AUTH_HEADER! "!BINARY_URL!"');
    expect(cmdScript).toContain('set "GH_TOKEN_VAL="');
    expect(cmdScript).toContain('set "GH_AUTH_HEADER="');
  });

  test("sh and ps1 retry anonymously ONLY on HTTP 401; cmd retry is token-gated", () => {
    // A stale/revoked token (expired GITHUB_TOKEN lingering in CI images,
    // dotfiles, direnv) gets a 401 and would break an install that works
    // fine anonymously today. install.sh and install.ps1 inspect the HTTP
    // status and retry WITHOUT the header only on 401: requests carrying
    // invalid credentials count against the anonymous 60/hour per-IP pool,
    // so a blind retry on any failure would double the burn, and network
    // failures gain nothing from a second attempt. install.cmd keeps
    // retry-on-any-failure (portable status capture in batch is not worth
    // the complexity) but only when a token was actually used.
    // See backnotprop/plannotator#1157 (second review).
    const cmdScript = readScript("install.cmd");

    // install.sh: status captured via curl -w; anonymous retry is gated on
    // a 401 AND a previously attached header.
    expect(sh).toContain("curl -sSL -w '\\n%{http_code}'");
    expect(sh).toContain('if [ "$_api_code" = "401" ] && [ ${#GH_AUTH_HEADER[@]} -gt 0 ]; then');
    // The anonymous retry line drops the header array entirely (and is not
    // a substring of the authenticated call).
    expect(sh).toContain(
      "_api_body=$(curl -sSL -w '\\n%{http_code}' \"$_api_url\" 2>/dev/null) || true",
    );
    // The tag is only parsed out of a 200 response.
    expect(sh).toContain('if [ "$_api_code" = "200" ]; then');

    // install.ps1: the catch inspects the response status; the anonymous
    // retry requires a token AND a 401, and both terminal error paths
    // surface the original exception message.
    expect(ps).toContain("$status = [int]$_.Exception.Response.StatusCode");
    expect(ps).toContain("if ($ghHeaders.Count -gt 0 -and $status -eq 401) {");
    expect(ps).toContain('Failed to fetch latest version: $($_.Exception.Message)');

    // install.cmd: retry only when a token was present, with the anonymous
    // retry curl adjacent to the first curl's ERRORLEVEL read.
    expect(cmdScript).toContain('if !ERRORLEVEL! neq 0 if defined GH_AUTH_HEADER (');
    expect(cmdScript).toContain('curl -fsSL "https://api.github.com/repos/!REPO!/releases/latest" -o "!RELEASE_JSON!"');
    // F7 pin: the failure check must appear BEFORE the token clears in file
    // order - `set` can disturb ERRORLEVEL, so every ERRORLEVEL read stays
    // immediately adjacent to the curl it tests.
    const cmdFailureCheck = cmdScript.indexOf("Failed to get latest version");
    const cmdTokenClear = cmdScript.lastIndexOf('set "GH_TOKEN_VAL="');
    const cmdHeaderClear = cmdScript.lastIndexOf('set "GH_AUTH_HEADER="');
    expect(cmdFailureCheck).toBeGreaterThan(0);
    expect(cmdTokenClear).toBeGreaterThan(cmdFailureCheck);
    expect(cmdHeaderClear).toBeGreaterThan(cmdFailureCheck);
  });

  test("install.cmd hardens the gh fallback and token value (second review)", () => {
    const cmdScript = readScript("install.cmd");
    // gh is resolved via `where` and invoked by absolute path, so the for /f
    // command line never runs a bare `gh` name that cmd would resolve from
    // the current directory first.
    expect(cmdScript).toContain("('where gh 2^>nul')");
    expect(cmdScript).toContain('"!GH_EXE!" auth token --hostname github.com');
    expect(cmdScript).not.toContain("('gh auth token");
    // Charset allowlist: a token containing anything outside [A-Za-z0-9_-]
    // (a quote in particular could break out of the quoted Authorization
    // header on the curl line) is dropped and the call goes anonymous.
    expect(cmdScript).toContain('if defined TOKEN_RESIDUE set "GH_TOKEN_VAL="');
  });

  test("attestation verify prefers the public bundle endpoint, single attempt, authenticated fallback (#1178)", () => {
    // The attestations endpoint on api.github.com is world-readable for
    // public repos: fetch the Sigstore bundle anonymously and verify with
    // `gh attestation verify --bundle`, so provenance checking works with no
    // gh login. gh's authenticated fetch stays as the fallback when the
    // public fetch fails; verification itself is never silently skipped.
    const cmdScript = readScript("install.cmd");

    for (const [name, script] of [["install.sh", sh], ["install.ps1", ps], ["install.cmd", cmdScript]] as const) {
      // The public endpoint is used...
      expect(script, `${name} should fetch the public attestations endpoint`).toContain("/attestations/sha256:");
      // ...exactly once — the unauthenticated API allows 60 requests/hour
      // per IP, so a retry loop is deliberately forbidden.
      const fetches = script.split("/attestations/sha256:").length - 1;
      expect(fetches, `${name} must fetch the bundle exactly once (no retry loop)`).toBe(1);
      // The bundle is handed to gh, and the credentialed path remains as
      // fallback (both --bundle and a bundle-less gh invocation exist).
      expect(script, `${name} should verify with --bundle`).toContain("--bundle");
      expect(script, `${name} should keep the authenticated fallback`).toContain(
        "falling back to gh's authenticated fetch",
      );
      // Distinct failure classes: TUF trust-root unreachable is worded as
      // connectivity (the root is fetched per-run), never conflated with a
      // real provenance failure — and both fail closed.
      expect(script, `${name} should classify TUF trust-root failures`).toContain("Sigstore verifiers");
      expect(script, `${name} should word TUF failures as connectivity`).toContain(
        "This is a connectivity failure",
      );
      expect(script, `${name} should classify fallback auth failures`).toContain("gh auth login");
      expect(script, `${name} must keep the loud provenance failure`).toContain("Refusing to install");
    }

    // JSONL extraction: the API returns { attestations: [ { bundle } ] } and
    // gh --bundle expects one bundle JSON document per line. sh extracts via
    // node with python3 and jq fallbacks (M3); with no extractor at all the
    // message names that cause instead of blaming a fetch that never ran.
    expect(sh).toContain("p.attestations");
    expect(sh).toContain("python3 -c");
    expect(sh).toContain("jq -c '.attestations[]?.bundle | select(. != null)'");
    expect(sh).toContain("No JSON extractor found");
    // The Windows scripts extract each bundle as a byte-exact substring of
    // the raw response (string-literal-aware brace scan), never a
    // ConvertFrom-Json/ConvertTo-Json round trip - PowerShell's DateTime
    // coercion re-serializes date-shaped strings differently across PS
    // 5.1/7 and could corrupt a bundle field (M7 guard).
    // Ordinal comparison so a culture-sensitive IndexOf can never mismatch
    // the byte-literal key under exotic locales.
    expect(ps).toContain("$attRaw.IndexOf('\"bundle\"', $searchFrom, [System.StringComparison]::Ordinal)");
    expect(ps).not.toContain("| ConvertTo-Json");
    expect(cmdScript).toContain("$raw.IndexOf('\"bundle\"', $searchFrom, [System.StringComparison]::Ordinal)");
    expect(cmdScript).not.toContain("| ConvertTo-Json");
    // The cmd fetcher runs via -EncodedCommand: NO helper file ever exists
    // on disk (a %RANDOM%-named .ps1 under %TEMP% would be a
    // predictable-path code-execution vector).
    expect(cmdScript).toContain("powershell -NoProfile -EncodedCommand !ATT_FETCH_B64!");
    expect(cmdScript).not.toContain("plannotator-attfetch");
    expect(cmdScript).not.toContain('-ExecutionPolicy Bypass -File');

    // H1: a failure of the --bundle invocation is retried once through the
    // exact authenticated path before ANY classification, so a gh that
    // cannot handle --bundle (or a corrupted bundle) never gets reported as
    // "no valid signed provenance". All three scripts share the message.
    for (const [name, script] of [["install.sh", sh], ["install.ps1", ps], ["install.cmd", cmdScript]] as const) {
      expect(script, `${name} must retry the authenticated path on bundle-verify failure`).toContain(
        "Bundle-based verification did not complete; retrying via gh's authenticated fetch.",
      );
    }

    // M5 (sh): the bundle lives inside a private mktemp -d directory - no
    // rename-into-place of a predictable sibling path - cleaned with one
    // rm -rf, and a mktemp failure degrades to the fallback instead of
    // aborting under set -e.
    expect(sh).toContain("attestation_bundle_dir=$(mktemp -d 2>/dev/null) || attestation_bundle_dir=\"\"");
    expect(sh).toContain('rm -rf "$attestation_bundle_dir"');
    expect(sh).not.toContain('mv "$_att_tmp"');

    // Failure-classification precedence is aligned across scripts: TUF wins
    // over auth. cmd runs the auth findstr FIRST so the TUF assignment
    // lands last; sh's case statement lists TUF first.
    const cmdAuthProbe = cmdScript.indexOf('findstr /c:"gh auth login" "!GH_OUTPUT!"');
    const cmdTufProbe = cmdScript.indexOf('findstr /c:"Sigstore verifiers" "!GH_OUTPUT!"');
    expect(cmdAuthProbe).toBeGreaterThan(0);
    expect(cmdTufProbe).toBeGreaterThan(cmdAuthProbe);

    // Both gh invocations (bundle + fallback) stay fully constrained in every
    // installer: at least two --signer-workflow flags pinning release.yml
    // must exist (one per invocation), so neither path loosened the policy.
    for (const [name, script] of [["install.sh", sh], ["install.ps1", ps], ["install.cmd", cmdScript]] as const) {
      const pinned = script.split(
        '--signer-workflow "backnotprop/plannotator/.github/workflows/release.yml"',
      ).length - 1;
      expect(pinned, `${name}: both verify invocations must pin the signer workflow`)
        .toBeGreaterThanOrEqual(2);
    }
  });

  test("install.ps1 git calls run under a scoped Continue preference", () => {
    // On PowerShell < 7.2 (and profiles restoring the old behavior),
    // redirecting a native command's stderr under
    // $ErrorActionPreference=Stop turns its FIRST stderr line into a
    // terminating error. git prints normal progress ("Cloning into ...")
    // on stderr, so without the scope the skill install failed on the line
    // announcing the clone had started. See #1162. Failure detection must
    // stay exit-code/Test-Path based, never throw-based.
    // The sparse-probe clone also pins LC_ALL=C inside the same scoped
    // block (the "unknown option" capability match is English-only), so its
    // expected prefix carries the env save alongside the preference.
    expect(ps).toContain(
      "& { $local:ErrorActionPreference = 'Continue'; $prevLcAll = $env:LC_ALL; $env:LC_ALL = 'C'; git clone",
    );
    expect(ps).toContain(
      "& { $local:ErrorActionPreference = 'Continue'; git sparse-checkout set",
    );
    // Tripwire: no bare git clone/sparse-checkout with stderr redirection
    // may exist outside the scoped block.
    for (const line of ps.split("\n")) {
      if (/^\s*git (clone|sparse-checkout)\b/.test(line)) {
        throw new Error(`unscoped native git call in install.ps1: ${line.trim()}`);
      }
    }
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

  test("exports skipInstall per-agent opt-outs (#1178)", () => {
    const configTs = readFileSync(
      join(scriptsDir, "..", "packages", "shared", "config.ts"),
      "utf-8",
    );
    const match = configTs.match(
      /export interface PlannotatorConfig \{([\s\S]*?)\n\}/
    );
    expect(match).toBeTruthy();
    expect(match![1]).toContain("skipInstall?: {");
    expect(match![1]).toContain("codex?: boolean");
    expect(match![1]).toContain("gemini?: boolean");
    expect(match![1]).toContain("kiro?: boolean");
    expect(match![1]).toContain("opencode?: boolean");
  });
});

// ---------------------------------------------------------------------------
// Functional tests (POSIX): run install.sh against a sandbox HOME with a
// stubbed curl/gh/git PATH. No network, no real agent CLI reachable. These
// pin the behaviors a source scan cannot: the H1 authenticated retry after a
// --bundle failure, the fail-closed abort (deleting the exit would leave all
// source-scan tests green while an unverified binary installs), and the M2
// skipInstall config scoping.
// ---------------------------------------------------------------------------

const FAKE_BINARY = "fake plannotator binary\n";
const FAKE_BINARY_SHA256 = createHash("sha256").update(FAKE_BINARY).digest("hex");
const ATTESTATION_FIXTURE = join(scriptsDir, "fixtures", "attestations-response.json");

type GhBehavior = "reject-bundle" | "fail-all" | "pass-all";
type GitBehavior = "fail" | "sparse-unsupported" | "network-error";

// git shim that behaves like git 2.23 (macOS with stale Xcode CLT, #1238):
// `clone --sparse` dies instantly on "unknown option" (exit 129, before any
// network call), a plain shallow clone succeeds and fake-creates the paths
// the installer's copy steps read, and `sparse-checkout` is not a command.
// Backslashes in the clone destination are normalized so the same shim also
// serves the install.ps1 region driver (PS normalizes `\` on Unix; a literal
// backslash dir name would not round-trip through Test-Path).
const GIT_SPARSE_UNSUPPORTED_SHIM = `#!/bin/bash
if [ "$1" = "clone" ]; then
  for a in "$@"; do
    if [ "$a" = "--sparse" ]; then
      echo "error: unknown option \\\`sparse'" >&2
      echo "usage: git clone [<options>] [--] <repo> [<dir>]" >&2
      exit 129
    fi
  done
  dest=""
  for a in "$@"; do dest="$a"; done
  dest="\${dest//\\\\//}"
  mkdir -p "$dest"
  for skill in plannotator-review plannotator-annotate plannotator-last; do
    mkdir -p "$dest/apps/skills/claude/$skill" "$dest/apps/skills/core/$skill"
    printf 'name: %s\\n' "$skill" > "$dest/apps/skills/claude/$skill/SKILL.md"
    printf 'name: %s\\n' "$skill" > "$dest/apps/skills/core/$skill/SKILL.md"
  done
  mkdir -p "$dest/apps/opencode-plugin/commands"
  printf 'stub\\n' > "$dest/apps/opencode-plugin/commands/plannotator-review.md"
  exit 0
fi
if [ "$1" = "sparse-checkout" ]; then
  echo "git: 'sparse-checkout' is not a git command. See 'git --help'." >&2
  exit 1
fi
exit 0
`;

// git shim for a genuine (network) clone failure with a distinctive stderr
// the installer must now surface instead of swallowing (#1238).
const GIT_NETWORK_ERROR_SHIM = `#!/bin/bash
if [ "$1" = "clone" ]; then
  echo "Cloning into 'repo'..." >&2
  echo "fatal: unable to access 'https://github.com/backnotprop/plannotator.git/': Could not resolve host: github.com" >&2
  exit 128
fi
exit 1
`;

function gitShimBody(git: GitBehavior): string {
  switch (git) {
    case "sparse-unsupported":
      return GIT_SPARSE_UNSUPPORTED_SHIM;
    case "network-error":
      return GIT_NETWORK_ERROR_SHIM;
    case "fail":
      return "#!/bin/bash\nexit 1\n";
  }
}

function setupInstallSandbox(opts: {
  gh: GhBehavior;
  git?: GitBehavior;
  codexHome?: boolean;
  plannotatorConfig?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-install-test-"));
  const home = join(root, "home");
  const stub = join(root, "stub-bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, "tmp"), { recursive: true });
  mkdirSync(stub, { recursive: true });

  // Stub curl: serves the fake binary, its checksum, and the captured real
  // attestations response. Anything else fails, so a test can never reach
  // the network.
  writeFileSync(
    join(stub, "curl"),
    `#!/bin/bash
out=""
url=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  case "$a" in
    http*) url="$a" ;;
  esac
  prev="$a"
done
case "$url" in
  *".sha256") printf '%s  plannotator\\n' "$STUB_CHECKSUM" ;;
  */releases/download/*) printf 'fake plannotator binary\\n' > "$out" ;;
  */attestations/sha256:*) cat "$STUB_ATT_JSON" ;;
  *) exit 22 ;;
esac
`,
    { mode: 0o755 },
  );

  // Stub gh with selectable behavior.
  const ghBody =
    opts.gh === "reject-bundle"
      ? `case "$*" in
  *"--bundle"*) echo "unknown flag: --bundle" >&2; exit 1 ;;
  *) exit 0 ;;
esac`
      : opts.gh === "fail-all"
        ? `echo "some gh verify error" >&2
exit 1`
        : "exit 0";
  writeFileSync(join(stub, "gh"), `#!/bin/bash\n${ghBody}\n`, { mode: 0o755 });

  // Stub git. Default ("fail"): fails instantly on clone, so the skills
  // checkout never reaches the network and the run terminates
  // deterministically right after the agent-integration blocks whose output
  // the tests assert on. The #1238 behaviors emulate an old git without
  // --sparse and a genuine network failure.
  writeFileSync(join(stub, "git"), gitShimBody(opts.git ?? "fail"), { mode: 0o755 });

  // Real node for the bundle extraction.
  const nodeBin = Bun.which("node");
  if (nodeBin) symlinkSync(nodeBin, join(stub, "node"));

  if (opts.codexHome) {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
  }
  if (opts.plannotatorConfig) {
    mkdirSync(join(home, ".plannotator"), { recursive: true });
    writeFileSync(join(home, ".plannotator", "config.json"), opts.plannotatorConfig);
  }
  return { home, stub };
}

function runInstallSh(sandbox: { home: string; stub: string }, args: string[]) {
  const r = Bun.spawnSync(
    ["bash", join(scriptsDir, "install.sh"), ...args],
    {
      env: {
        HOME: sandbox.home,
        TMPDIR: join(sandbox.home, "tmp"),
        PATH: `${sandbox.stub}:/usr/bin:/bin`,
        STUB_CHECKSUM: FAKE_BINARY_SHA256,
        STUB_ATT_JSON: ATTESTATION_FIXTURE,
        PLANNOTATOR_SKIP_SEM_INSTALL: "1",
        PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    code: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
  };
}

describe.skipIf(process.platform === "win32" || !Bun.which("node"))(
  "install.sh functional (stubbed PATH, sandbox HOME)",
  () => {
    test("H1: a gh that rejects --bundle falls back to the authenticated path, never a provenance false alarm", () => {
      const sandbox = setupInstallSandbox({ gh: "reject-bundle" });
      const { code, out } = runInstallSh(sandbox, [
        "--version", "v99.9.9", "--verify-attestation", "--minimal", "--non-interactive",
      ]);
      expect(out).toContain(
        "Bundle-based verification did not complete; retrying via gh's authenticated fetch.",
      );
      // The retry's authenticated verify succeeded, so the install completes
      // with the plain (non-credential-free) success line...
      expect(out).toContain("verified build provenance (SLSA)");
      expect(out).not.toContain("credential-free via the public attestations API");
      // ...and the loud provenance-failure diagnosis must NOT appear.
      expect(out).not.toContain("no valid signed provenance");
      expect(out).not.toContain("Attestation verification failed!");
      expect(code).toBe(0);
      expect(existsSync(join(sandbox.home, ".local", "bin", "plannotator"))).toBe(true);
    });

    test("fail-closed: a real verification failure aborts with exit 1 and installs nothing", () => {
      // The reviewer proved that deleting the exit after the provenance
      // message left every source-scan test green while an unverified
      // binary installed. This pins the abort behaviorally, and it pins it
      // DISCRIMINATINGLY: with the `exit 1` deleted, execution continues
      // past the message and a later mv of the already-removed temp file
      // appends its own error after "Refusing to install." - so asserting
      // the output ENDS with the refusal catches the mutation, where a
      // bare nonzero-exit-code check would not (the incidental mv failure
      // also exits nonzero). Mutation-verified during review round two.
      const sandbox = setupInstallSandbox({ gh: "fail-all" });
      const { code, out } = runInstallSh(sandbox, [
        "--version", "v99.9.9", "--verify-attestation", "--minimal", "--non-interactive",
      ]);
      expect(out).toContain("Attestation verification failed!");
      expect(out.trimEnd().endsWith("Refusing to install.")).toBe(true);
      expect(code).toBe(1);
      expect(existsSync(join(sandbox.home, ".local", "bin", "plannotator"))).toBe(false);
    });

    test("M2: a foreign \"codex\": true outside skipInstall (plus explicit false inside) does NOT skip", () => {
      const sandbox = setupInstallSandbox({
        gh: "pass-all",
        codexHome: true,
        plannotatorConfig: '{"skipInstall":{"codex":false},"somethingElse":{"codex":true}}\n',
      });
      const { out } = runInstallSh(sandbox, [
        "--version", "v99.9.9", "--non-interactive", "--no-extras",
      ]);
      expect(out).not.toContain("detected, skipped");
      expect(out).toContain("Created Codex hooks at");
      expect(existsSync(join(sandbox.home, ".codex", "hooks.json"))).toBe(true);
    });

    test("M2: skipInstall.codex true skips, names the config as the source, and writes nothing to the Codex home", () => {
      const sandbox = setupInstallSandbox({
        gh: "pass-all",
        codexHome: true,
        plannotatorConfig: '{ "skipInstall": { "codex": true } }\n',
      });
      const { out } = runInstallSh(sandbox, [
        "--version", "v99.9.9", "--non-interactive", "--no-extras",
      ]);
      expect(out).toContain("Codex: detected, skipped (config skipInstall.codex).");
      expect(out).not.toContain("Created Codex hooks at");
      expect(existsSync(join(sandbox.home, ".codex", "hooks.json"))).toBe(false);
    });

    test("#1238: a git without clone --sparse falls back to a plain shallow clone and still installs the skills", () => {
      // git 2.23 (macOS with stale Xcode CLT) rejects --sparse instantly on
      // "unknown option" before any network call. The installer must probe
      // that from the captured stderr, retry as a plain shallow clone, skip
      // `git sparse-checkout set` (equally missing on that git — the shim
      // hard-fails it to prove it is never run), and complete the install.
      const sandbox = setupInstallSandbox({ gh: "pass-all", git: "sparse-unsupported" });
      const { code, out } = runInstallSh(sandbox, [
        "--version", "v99.9.9", "--non-interactive", "--no-extras",
      ]);
      expect(out).toContain(
        "This git does not support 'git clone --sparse' (needs git >= 2.25)",
      );
      expect(out).toContain("falling back to a plain shallow clone");
      expect(out).toContain("Installed Claude Code skills to");
      expect(out).toContain("Installed shared agent skills to");
      // The misleading terminal failure from the issue must be gone entirely.
      expect(out).not.toContain("network or git error");
      expect(code).toBe(0);
      // The downstream copy steps work identically from the full checkout.
      for (const skill of CORE_SKILLS) {
        expect(existsSync(join(sandbox.home, ".claude", "skills", skill, "SKILL.md"))).toBe(true);
        expect(existsSync(join(sandbox.home, ".agents", "skills", skill, "SKILL.md"))).toBe(true);
      }
    });

    test("#1238: a genuine clone failure surfaces git's captured stderr next to the generic message", () => {
      const sandbox = setupInstallSandbox({ gh: "pass-all", git: "network-error" });
      const { code, out } = runInstallSh(sandbox, [
        "--version", "v99.9.9", "--non-interactive", "--no-extras",
      ]);
      // The real diagnostic is no longer swallowed by 2>/dev/null...
      expect(out).toContain("git reported:");
      expect(out).toContain("Could not resolve host: github.com");
      // ...and the existing hard-fail contract for genuine errors holds.
      expect(out).toContain("network or git error");
      expect(code).toBe(1);
      expect(existsSync(join(sandbox.home, ".claude", "skills", "plannotator-review"))).toBe(false);
      // A network failure is not a capability miss: no fallback attempt.
      expect(out).not.toContain("falling back to a plain shallow clone");
    });
  },
);

// ---------------------------------------------------------------------------
// M7: the Windows installers' bundle extraction, exercised under PowerShell
// against the captured REAL attestations response (scripts/fixtures/). The
// scanner must emit each attestations[].bundle as a byte-exact substring of
// the raw response - proving there is no ConvertFrom-Json/ConvertTo-Json
// round trip whose DateTime coercion could corrupt a bundle field. Skipped
// when no PowerShell is available on the host (runs on Windows CI and any
// machine with pwsh installed).
// ---------------------------------------------------------------------------

const pwshBin = Bun.which("pwsh") ?? Bun.which("powershell");

function extractPs1ScannerRegion(): string {
  const ps = readScript("install.ps1");
  const start = ps.indexOf("$bundles = @()");
  const end = ps.indexOf("if ($bundles.Count -gt 0) {");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("could not locate the bundle scanner region in install.ps1");
  }
  return ps.slice(start, end);
}

function decodeCmdFetcherBlob(): string {
  // install.cmd carries its fetch helper as a base64(UTF-16LE) blob run via
  // `powershell -EncodedCommand` so no helper file ever exists on disk.
  // Decoding it yields exactly the PowerShell the installer runs.
  const cmd = readScript("install.cmd");
  const m = cmd.match(/^set "ATT_FETCH_B64=([A-Za-z0-9+/=]+)"$/m);
  if (!m) throw new Error("could not locate the ATT_FETCH_B64 blob in install.cmd");
  return Buffer.from(m[1], "base64").toString("utf16le");
}

function extractCmdScannerRegion(): string {
  const script = decodeCmdFetcherBlob();
  const start = script.indexOf("$bundles = @()");
  const end = script.indexOf("if ($bundles.Count -eq 0)");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("could not locate the bundle scanner region in install.cmd's encoded fetcher");
  }
  return script.slice(start, end);
}

function runScanner(scannerBody: string, rawJson: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-scanner-test-"));
  const inputPath = join(dir, "input.json");
  writeFileSync(inputPath, rawJson);
  // Both scanner variants read the raw response text; ps1 calls it $attRaw,
  // the cmd-generated helper calls it $raw. Alias both.
  const driver = [
    "param([string]$FixturePath)",
    "$raw = [System.IO.File]::ReadAllText($FixturePath)",
    "$attRaw = $raw",
    scannerBody,
    'foreach ($b in $bundles) { [Console]::Out.WriteLine($b) }',
  ].join("\n");
  const driverPath = join(dir, "driver.ps1");
  writeFileSync(driverPath, driver);
  const r = Bun.spawnSync([pwshBin!, "-NoProfile", "-File", driverPath, inputPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    throw new Error(`scanner driver failed: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().split("\n").filter((l) => l.length > 0);
}

describe("install.cmd encoded fetcher blob", () => {
  test("decodes to exactly the documented REM PS: plaintext (no PowerShell needed)", () => {
    // The -EncodedCommand payload is opaque to a human reader; the REM PS:
    // lines directly above it are the documentation. This drift guard makes
    // them one thing: the blob must decode byte-for-byte to those lines.
    const cmd = readScript("install.cmd");
    const remLines = cmd
      .split("\n")
      .filter((l) => l.startsWith("REM PS: "))
      .map((l) => l.slice("REM PS: ".length));
    expect(remLines.length).toBeGreaterThan(20);
    const documented = remLines.join("\n") + "\n";
    expect(decodeCmdFetcherBlob()).toBe(documented);
  });

  test("decoded fetcher keeps the security-relevant shape", () => {
    const decoded = decodeCmdFetcherBlob();
    // Inputs travel via env vars, never string interpolation.
    expect(decoded).toContain("$env:REPO");
    expect(decoded).toContain("$env:ATT_DIGEST");
    expect(decoded).toContain("$env:ATT_BUNDLE_FILE");
    // Byte-exact substring extraction, no JSON round trip.
    expect(decoded).toContain("[System.StringComparison]::Ordinal");
    expect(decoded).not.toContain("ConvertFrom-Json");
    expect(decoded).not.toContain("ConvertTo-Json");
    // Distinct exit codes for fetch failure vs empty extraction.
    expect(decoded).toContain("exit 2");
    expect(decoded).toContain("exit 3");
  });
});

test("PowerShell scanner coverage must not silently vanish on CI", () => {
  // The M7 scanner tests skip when no PowerShell is on the host, which is
  // fine for contributor laptops - but a CI image change dropping pwsh
  // must fail loudly instead of quietly shrinking coverage.
  if (process.env.CI) {
    expect(
      pwshBin,
      "CI has no pwsh/powershell on PATH; the attestation scanner tests would silently skip. Restore PowerShell in the CI image.",
    ).toBeTruthy();
  }
});

// Each of these tests spawns PowerShell. The first spawn in the process pays
// pwsh's cold start (assembly load + JIT), which on a loaded CI runner exceeds
// bun's 5s default and fails whichever test happens to run first - a flake with
// no relation to the code under test. Warm spawns finish in ~300ms.
const PWSH_SCANNER_TIMEOUT_MS = 60_000;

describe.skipIf(!pwshBin)("attestation bundle scanner under PowerShell (M7)", () => {
  const fixtureRaw = readFileSync(ATTESTATION_FIXTURE, "utf-8");
  const fixture = JSON.parse(fixtureRaw);
  const scanners: Array<[string, string]> = [
    ["install.ps1 inline scanner", extractPs1ScannerRegion()],
    ["install.cmd generated fetcher scanner", extractCmdScannerRegion()],
  ];

  for (const [name, body] of scanners) {
    test(`${name}: byte-stable extraction of the real attestations response`, () => {
      const lines = runScanner(body, fixtureRaw);
      expect(lines.length).toBe(fixture.attestations.length);
      for (let i = 0; i < lines.length; i++) {
        // Byte-stability by construction: every emitted bundle is a literal
        // substring of the API response.
        expect(fixtureRaw).toContain(lines[i]);
        // And it is the RIGHT substring: parsing it yields exactly the
        // bundle object the response carried.
        expect(JSON.parse(lines[i])).toEqual(fixture.attestations[i].bundle);
      }
    }, PWSH_SCANNER_TIMEOUT_MS);

    test(`${name}: date-shaped strings survive untouched (DateTime coercion guard)`, () => {
      // A ConvertFrom-Json/ConvertTo-Json round trip would parse this into
      // a DateTime and re-serialize it in a different format (varies across
      // PS 5.1/7). The scanner must reproduce the exact bytes.
      const synthetic = '{"attestations":[{"bundle_url":"https://x.test/a","bundle":{"ts":"2026-01-02T03:04:05.000Z","integratedTime":"1785415430"}}]}';
      const lines = runScanner(body, synthetic);
      expect(lines).toEqual(['{"ts":"2026-01-02T03:04:05.000Z","integratedTime":"1785415430"}']);
    }, PWSH_SCANNER_TIMEOUT_MS);

    test(`${name}: braces and escaped quotes inside string values do not derail the depth scan`, () => {
      const bundle = { weird: 'a}b{c"}{', nested: { deep: "{{{}}}" } };
      const synthetic = JSON.stringify({ attestations: [{ bundle }] });
      const lines = runScanner(body, synthetic);
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0])).toEqual(bundle);
      expect(synthetic).toContain(lines[0]);
    }, PWSH_SCANNER_TIMEOUT_MS);
  }
});

// ---------------------------------------------------------------------------
// #1238 under PowerShell: the install.ps1 skills-checkout region, extracted
// and driven the same way the M7 scanner region is, against the same git
// shims the bash functional tests use. The shims are bash scripts, so these
// run on Unix hosts with pwsh (the copy-step fidelity on Windows is covered
// by the bash functional tests plus the shared source-scan suite).
// ---------------------------------------------------------------------------

function extractPs1SkillsCheckoutRegion(): string {
  const ps = readScript("install.ps1");
  const start = ps.indexOf("$checkoutFailed = $false");
  const end = ps.indexOf("# Claude Code commands are deprecated");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("could not locate the skills checkout region in install.ps1");
  }
  return ps.slice(start, end);
}

function runPs1SkillsCheckout(git: GitBehavior): { code: number; out: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "plannotator-ps1-checkout-test-"));
  const home = join(root, "home");
  const stub = join(root, "stub-bin");
  mkdirSync(join(home, "tmp"), { recursive: true });
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, "git"), gitShimBody(git), { mode: 0o755 });

  const driver = [
    `$ErrorActionPreference = "Stop"`,
    `$repo = "backnotprop/plannotator"`,
    `$latestTag = "v9.9.9"`,
    `$skipSkillsResolved = $false`,
    `$skipKiroResolved = $true`,
    `$skipOpencodeResolved = $true`,
    `$skipGeminiResolved = $true`,
    `$kiroAvailable = $false`,
    `$claudeSkillsDir = Join-Path "${home}" ".claude/skills"`,
    `$agentsSkillsDir = Join-Path "${home}" ".agents/skills"`,
    extractPs1SkillsCheckoutRegion(),
    `exit 0`,
  ].join("\n");
  const driverPath = join(root, "driver.ps1");
  writeFileSync(driverPath, driver);
  const r = Bun.spawnSync([pwshBin!, "-NoProfile", "-File", driverPath], {
    env: {
      PATH: `${stub}:/usr/bin:/bin`,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: join(home, "tmp"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
    home,
  };
}

describe.skipIf(!pwshBin || process.platform === "win32")(
  "install.ps1 skills checkout on old git (#1238)",
  () => {
    test("a git without clone --sparse falls back to a plain shallow clone and still installs the skills", () => {
      const { code, out, home } = runPs1SkillsCheckout("sparse-unsupported");
      expect(out).toContain(
        "This git does not support 'git clone --sparse' (needs git >= 2.25)",
      );
      expect(out).toContain("falling back to a plain shallow clone");
      expect(out).toContain("Installed Claude Code skills to");
      expect(out).not.toContain("network or git error");
      expect(code).toBe(0);
      expect(
        existsSync(join(home, ".claude", "skills", "plannotator-review", "SKILL.md")),
      ).toBe(true);
    }, PWSH_SCANNER_TIMEOUT_MS);

    test("a genuine clone failure surfaces git's captured stderr next to the generic message", () => {
      const { code, out } = runPs1SkillsCheckout("network-error");
      expect(out).toContain("git reported:");
      expect(out).toContain("Could not resolve host: github.com");
      expect(out).toContain("network or git error");
      expect(out).not.toContain("falling back to a plain shallow clone");
      expect(code).toBe(1);
    }, PWSH_SCANNER_TIMEOUT_MS);
  },
);
