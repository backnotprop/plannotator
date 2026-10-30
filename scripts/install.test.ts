/**
 * Install Script Validation Tests
 *
 * Validates that install scripts produce correct JSON and command structures
 * without actually running the installers.
 *
 * Run: bun test scripts/install.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteHookWord } from "../packages/shared/t3-hook-command";

const scriptsDir = import.meta.dir;

function readScript(name: string): string {
  return readFileSync(join(scriptsDir, name), "utf-8").replace(/\r\n?/g, "\n");
}

// The always-installed core skills (apps/skills/core/*). Single list so
// the copy assertions, sidecar checks, and frontmatter checks can't drift.
const CORE_SKILLS = [
  "plannotator-review",
  "plannotator-annotate",
  "plannotator-last",
  "plannotator-inbox",
];

describe("install.sh", () => {
  const script = readScript("install.sh");

  test("never writes the Claude Code marketplace clone's hooks.json", () => {
    // The clone is Claude Code's own checkout of this repo, and its hooks.json
    // is the source of truth. A hard-coded rewrite dropped keys twice (#689
    // the EnterPlanMode hook, then "modules", the Claude Code mod).
    expect(script).not.toMatch(/>\s*"\$PLUGIN_HOOKS"/);
    expect(script).not.toContain("<< 'HOOKS_EOF'");
    expect(script).toContain('repair_legacy_plugin_hooks "$PLUGIN_MARKETPLACE_DIR" || true');
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
      "git sparse-checkout set apps/skills apps/kiro-cli apps/vibe apps/opencode-plugin/commands apps/gemini/commands",
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
    // The knowledge skill has no Claude-only injection form: both scopes
    // install the single-sourced apps/skills/core/plannotator copy.
    expect(script).toContain('copy_skill_if_present apps/skills/core/plannotator "$CLAUDE_SKILLS_DIR"');
    expect(script).toContain('copy_skill_if_present apps/skills/core/plannotator "$AGENTS_SKILLS_DIR"');
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
    // The knowledge skill has no Kiro-specific form either, so Kiro gets the
    // same single-sourced core copy as Claude and ~/.agents. Kiro shipping
    // only the action skills and no CLI reference was the #1377 install-reach
    // gap; assert the copy line so the scope cannot be dropped again.
    expect(script).toContain('copy_skill_if_present apps/skills/core/plannotator "$KIRO_SKILLS_DIR"');
    // The two extras Kiro keeps receiving come from apps/skills/extra.
    expect(script).toContain('copy_skill_if_present apps/skills/extra/plannotator-setup-goal "$KIRO_SKILLS_DIR"');
    expect(script).toContain('copy_skill_if_present apps/skills/extra/plannotator-visual-explainer "$KIRO_SKILLS_DIR"');
    // sparse-checkout fetches apps/kiro-cli (skills + agent example).
    expect(script).toContain("git sparse-checkout set apps/skills apps/kiro-cli apps/vibe");
    // The installer also writes the example custom agent to ~/.kiro/agents.
    expect(script).toContain('cp apps/kiro-cli/agents/plannotator.json "$HOME/.kiro/agents/plannotator.json"');
    // Parity: no bespoke flag, like every other agent.
    expect(script).not.toContain("--kiro");
    expect(script).not.toContain("INSTALL_KIRO");
  });

  test("auto-installs Vibe skills + managed hook when ~/.vibe is detected (no flag)", () => {
    // Vibe (Mistral's TUI coding agent) is auto-detected like Kiro/Codex:
    // PATH executable or an existing ~/.vibe, never gated behind a bespoke flag.
    expect(script).toContain("vibe_available=0");
    expect(script).toContain('[ -d "$VIBE_HOME" ]');
    expect(script).toContain('VIBE_HOME="${VIBE_HOME:-$HOME/.vibe}"');
    expect(script).toContain("VIBE_SKILLS_DIR");
    expect(script).toContain('$VIBE_HOME/skills');
    expect(script).toContain('if [ "$vibe_available" -eq 1 ]');
    // Vibe-specific skills (origin baked in) come from apps/vibe/skills.
    for (const skill of ["plannotator-review", "plannotator-annotate", "plannotator-last"]) {
      expect(script).toContain(`copy_skill_if_present apps/vibe/skills/${skill} "$VIBE_SKILLS_DIR"`);
    }
    // The knowledge skill is agent-agnostic and single-sourced in apps/skills/core.
    expect(script).toContain('copy_skill_if_present apps/skills/core/plannotator "$VIBE_SKILLS_DIR"');
    // So is /plannotator-inbox, which needs no origin label.
    expect(script).toContain('copy_skill_if_present apps/skills/core/plannotator-inbox "$VIBE_SKILLS_DIR"');
    // sparse-checkout fetches apps/vibe (skills + hook templates).
    expect(script).toContain("git sparse-checkout set apps/skills apps/kiro-cli apps/vibe");
    // Managed marker block so the hook coexists with the user's own hooks.toml.
    expect(script).toContain('VIBE_MANAGED_START="# >>> plannotator-managed-vibe-hooks (managed; do not edit) >>>"');
    expect(script).toContain('VIBE_MANAGED_END="# <<< plannotator-managed-vibe-hooks <<<"');
    // The hook command is argv-only with the absolute binary path (no env
    // prefix) so it survives both shell and shell-free hook executors, and
    // origin detection happens in the binary from the hook payload.
    expect(script).toContain('command = "${PLANNOTATOR_BIN}"');
    expect(script).toContain("PLANNOTATOR_BIN=\"${INSTALL_DIR}/plannotator\"");
    expect(script).toContain('match = "exit_plan_mode"');
    // Hooks are stable in Vibe 2.25+; no config.toml flag is written, and the
    // installer must not touch $VIBE_HOME/config.toml at all.
    expect(script).not.toContain("enable_experimental_hooks");
    expect(script).not.toContain('VIBE_CONFIG="$VIBE_HOME/config.toml"');
    // Parity: no bespoke flag, like every other agent.
    expect(script).not.toContain("--vibe-only");
    expect(script).not.toContain("INSTALL_VIBE");
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
      'for scope in "$CLAUDE_SKILLS_DIR" "$AGENTS_SKILLS_DIR" "$KIRO_SKILLS_DIR" "$VIBE_SKILLS_DIR"; do',
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
    // The extension resolves its skill overlap with ~/.agents/skills itself
    // (apps/pi-extension/bundled-skill.ts, #1642), so the installer never
    // edits Pi's settings.json (it only reads it to tell an update from a
    // first install: see the fake-pi tests below).
    expect(script).toContain("update_pi_extension_if_present");
    expect(script).toContain("npm:@plannotator/pi-extension");
    expect(script).not.toContain("configure_pi_plannotator_package_filter");
    expect(script).not.toContain("plannotator_shared_agent_skills_available");
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
    const pluginHooksIndex = script.indexOf('repair_legacy_plugin_hooks "$PLUGIN_MARKETPLACE_DIR" || true');
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
      'mv -f "$staged_file" "$INSTALL_DIR/plannotator"',
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
    for (const flag of ["--skip-codex)", "--skip-gemini)", "--skip-kiro)", "--skip-vibe)", "--skip-opencode)"]) {
      expect(script).toContain(flag);
    }
    // Env vars follow the existing PLANNOTATOR_SKIP_*_INSTALL naming.
    expect(script).toContain("PLANNOTATOR_SKIP_CODEX_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_GEMINI_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_KIRO_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_VIBE_INSTALL");
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
    expect(script).toContain("for _agent in codex gemini kiro vibe opencode qwen skills claudePlugin; do");
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
    // detected vs installed. "Not detected" is now conveyed by omitting the
    // CODEX USERS closing section entirely (see the functional closing-summary
    // tests below), never by a skip message.
    expect(script).toContain('Codex: detected, skipped (${skip_codex_source}).');
    expect(script).not.toContain("Codex was not detected.");
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
    expect(script).toContain("[--skip-kiro] [--skip-vibe] [--skip-opencode] [--skip-skills]");
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

  test("never writes the Claude Code marketplace clone's hooks.json", () => {
    expect(script).not.toMatch(/Set-Content -Path \$pluginHooks/);
    expect(script).not.toContain("$exePathJson");
    expect(script).toContain("try { Repair-LegacyPluginHooks -Clone $pluginMarketplaceDir } catch { }");
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
      "git sparse-checkout set apps/skills apps/kiro-cli apps/vibe apps/opencode-plugin/commands apps/gemini/commands",
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
    // Knowledge skill: single-sourced from core into both scopes.
    expect(script).toContain('Copy-SkillIfPresent "apps\\skills\\core\\plannotator" $claudeSkillsDir');
    expect(script).toContain('Copy-SkillIfPresent "apps\\skills\\core\\plannotator" $agentsSkillsDir');
    expect(script).toContain('"plannotator-review", "plannotator-annotate", "plannotator-last"');
    expect(script).toContain('foreach ($skill in @("plannotator-review", "plannotator-annotate", "plannotator-last", "plannotator-inbox"))');
    // Copy-SkillIfPresent pre-removes the destination to avoid nesting on upgrade.
    expect(script).toContain("Remove-Item -Recurse -Force -LiteralPath $dest");
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

  test("detects Vibe only by its home and writes nothing under it", () => {
    // A `vibe` binary on PATH alone must not count as Vibe detected
    // (install.sh parity).
    expect(script).toContain("$vibeAvailable = [bool](Test-Path $vibeHome)");
    expect(script).not.toContain("Get-Command vibe");
    // The apps/vibe skills use a POSIX env-prefix that Vibe's PowerShell
    // fallback cannot run, so Windows never copies them (or anything else)
    // into the Vibe home.
    expect(script).not.toContain("apps\\vibe\\skills\\");
    expect(script).not.toContain('Join-Path $vibeHome "skills"');
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
    expect(script).toContain("[switch]$SkipVibe");
    expect(script).toContain("[switch]$SkipOpencode");
    expect(script).toContain("PLANNOTATOR_SKIP_CODEX_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_GEMINI_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_KIRO_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_VIBE_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_OPENCODE_INSTALL");
    // Config layer parses the real nested JSON (strict boolean check, like
    // verifyAttestation).
    expect(script).toContain("$cfg.skipInstall.codex -is [bool]");
    expect(script).toContain("$cfg.skipInstall.gemini -is [bool]");
    expect(script).toContain("$cfg.skipInstall.kiro -is [bool]");
    expect(script).toContain("$cfg.skipInstall.vibe -is [bool]");
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

  test("never writes the Claude Code marketplace clone's hooks.json", () => {
    expect(script).not.toContain('> "!PLUGIN_HOOKS!"');
    expect(script).not.toContain("EXE_PATH");
    expect(script).toContain('if exist "!PLUGIN_HOOKS!" call :RepairLegacyPluginHooks');
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
      "git sparse-checkout set apps/skills apps/kiro-cli apps/vibe apps/opencode-plugin/commands apps/gemini/commands",
    );
    expect(script).toContain("CLAUDE_SKILLS_DIR");
    expect(script).toContain("AGENTS_SKILLS_DIR");
    expect(script).toContain("%USERPROFILE%\\.agents\\skills");
    // Claude Code reads injection-form skills (apps\skills\claude); the shared
    // agent (Codex) scope reads the prose skills (apps\skills\core).
    expect(script).toContain('xcopy /s /i /y /q "apps\\skills\\claude\\%%S" "!CLAUDE_SKILLS_DIR!\\%%S\\"');
    expect(script).toContain('xcopy /s /i /y /q "apps\\skills\\core\\%%S" "!AGENTS_SKILLS_DIR!\\%%S\\"');
    expect(script).toContain("for %%S in (plannotator-review plannotator-annotate plannotator-last plannotator-inbox) do");
    // Knowledge skill: single-sourced from core into both scopes.
    expect(script).toContain("for %%S in (plannotator-review plannotator-annotate plannotator-last plannotator-inbox plannotator) do");
    expect(script).toContain('xcopy /s /i /y /q "apps\\skills\\core\\plannotator" "!CLAUDE_SKILLS_DIR!\\plannotator\\"');
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

  test("detects Vibe only by its home and writes nothing under it", () => {
    // A vibe executable on PATH alone must not count as Vibe detected
    // (install.sh parity).
    expect(script).toContain('if exist "!VIBE_HOME!" set "VIBE_AVAILABLE=1"');
    expect(script).not.toContain("where vibe");
    // Windows never copies the POSIX-only apps/vibe skills into the Vibe home.
    expect(script).not.toContain("apps\\vibe\\skills\\");
    expect(script).not.toContain("VIBE_SKILLS_DIR");
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

  // The Claude Code plugin hooks run bare `plannotator` (#1689), so the
  // binary's directory has to be on the user PATH, which install.ps1 already
  // writes. install.cmd used to only print advice.
  describe(":PrintPathAdvice adds INSTALL_DIR to the user PATH", () => {
    const start = script.indexOf("\n:PrintPathAdvice\n");
    const end = script.indexOf("goto :eof", start);
    const body = script.slice(start, end);
    const psLine = body.split("\n").find((line) => line.startsWith("powershell ")) ?? "";
    const command = psLine.slice(psLine.indexOf('-Command "') + '-Command "'.length, psLine.lastIndexOf('"'));

    test("runs one top-level PowerShell call, outside any parenthesized block", () => {
      expect(start).toBeGreaterThan(0);
      expect(psLine).toStartWith("powershell -NoProfile -ExecutionPolicy Bypass -Command \"");
      expect(psLine.endsWith('"')).toBe(true);
      // No enclosing `(` block: every line before it at column 0 or a label.
      const before = body.slice(0, body.indexOf(psLine));
      expect(before.split("(").length).toBe(before.split(")").length);
    });

    test("the command carries nothing cmd.exe would reinterpret", () => {
      expect(command.length).toBeGreaterThan(100);
      // Delayed expansion is on: `!` would be eaten; `%` expands; the quote
      // would end the argument; `^`, `&`, `<`, `>` are cmd operators.
      for (const ch of ['"', "%", "!", "^", "&", "<", ">"]) {
        expect(command.includes(ch), `install.cmd PATH command contains ${ch}`).toBe(false);
      }
    });

    test("passes the directory through the environment, never interpolated", () => {
      expect(body).toContain('set "PLN_PATH_DIR=!INSTALL_DIR!"');
      expect(command).toContain("$env:PLN_PATH_DIR");
      expect(command).not.toContain("INSTALL_DIR");
      expect(body).toContain('set "PLN_PATH_DIR="');
    });

    test("edits the user PATH through the registry, unexpanded, keeping its kind, without duplicates", () => {
      expect(command).toContain("[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')");
      expect(command).toContain("DoNotExpandEnvironmentNames");
      expect(command).toContain("$k.GetValueKind('Path')");
      expect(command).toContain("$k.SetValue('Path',$n,$kind)");
      // Idempotent: an existing entry (raw or expanded, case-insensitive,
      // trailing backslash ignored) exits before any write.
      expect(command).toContain("-ieq $d");
      expect(command).toContain("ExpandEnvironmentVariables");
      expect(command.indexOf("if($has.Count -gt 0)")).toBeLessThan(command.indexOf("$k.SetValue("));
      // Not the 1024-char-truncating setx, and not the machine PATH.
      expect(command).not.toContain("setx");
      expect(command).not.toContain("LocalMachine");
    });

    test("keeps the printed note and falls back to manual advice when PowerShell fails", () => {
      expect(body).toContain("is not in your PATH. Adding it to your user PATH...");
      expect(body).toContain("if errorlevel 1 (");
      expect(body).toContain('echo   setx PATH "%%PATH%%;!INSTALL_DIR!"');
      expect(body).toContain("echo   set PATH=%%PATH%%;!INSTALL_DIR!");
      expect(script.slice(end)).toStartWith("goto :eof");
    });

    const powershell = Bun.which("pwsh") ?? Bun.which("powershell") ?? Bun.which("powershell.exe");
    test.skipIf(!powershell)("the command parses cleanly in a real PowerShell (parse only, no registry access)", async () => {
      const proc = Bun.spawn(
        [
          powershell!,
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:PLANNOTATOR_TEST_SCRIPT,[ref]$null,[ref]$errors); if($errors.Count -gt 0){$errors | ForEach-Object { Write-Output $_.Message }; exit 1}; exit 0",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, PLANNOTATOR_TEST_SCRIPT: command } },
      );
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(stdout.trim()).toBe("");
      expect(exitCode).toBe(0);
    }, 60_000);
  });

  test("per-agent skip opt-outs: flags, env vars, config keys, precedence (#1178)", () => {
    expect(script).toContain('if /i "%~1"=="--skip-codex"');
    expect(script).toContain('if /i "%~1"=="--skip-gemini"');
    expect(script).toContain('if /i "%~1"=="--skip-kiro"');
    expect(script).toContain('if /i "%~1"=="--skip-vibe"');
    expect(script).toContain('if /i "%~1"=="--skip-opencode"');
    expect(script).toContain("PLANNOTATOR_SKIP_CODEX_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_GEMINI_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_KIRO_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_VIBE_INSTALL");
    expect(script).toContain("PLANNOTATOR_SKIP_OPENCODE_INSTALL");
    // Config layer (M2): the REAL JSON is parsed by PowerShell (strict
    // boolean check, matching install.ps1) instead of a line-oblivious
    // findstr - so a "codex": true under some OTHER key can never opt
    // anyone out and an explicit false inside skipInstall is honored.
    expect(script).toContain("$c.skipInstall.$k");
    expect(script).toContain("@('codex','gemini','kiro','vibe','opencode','qwen','skills','claudePlugin')");
    expect(script).toContain("$v -is [bool] -and $v");
    expect(script).toContain("PLN_CONFIG_JSON");
    expect(script).toContain("skipInstall.codex");
    expect(script).toContain("skipInstall.gemini");
    expect(script).toContain("skipInstall.kiro");
    expect(script).toContain("skipInstall.vibe");
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
    for (const skill of [...CORE_SKILLS, "plannotator"]) {
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

  test("every skill in the repo sets disable-model-invocation: true (knowledge skill excepted)", () => {
    // Maintainer rule: ALL Plannotator skills are user-invoked, never
    // model-auto-invoked. Load-bearing for #842: Pi natively discovers
    // ~/.agents/skills, and this frontmatter line is the only thing keeping
    // skills out of Pi's system prompt (<available_skills>). Scans every
    // SKILL.md dynamically so newly added skills are covered automatically.
    //
    // ONE deliberate exception: apps/skills/core/plannotator, the knowledge
    // layer. Its whole purpose is that an agent asked to "use Plannotator"
    // can pull in the CLI reference itself, so it ships model-invocable; it
    // only loads reference text and runs nothing. Asserted both ways below
    // so neither an accidental lock of the knowledge skill nor an accidental
    // unlock of any other skill can slip through.
    const MODEL_INVOCABLE_SKILLS = new Set(["plannotator"]);
    const skillRoots = [
      join(scriptsDir, "..", "apps", "skills", "core"),
      join(scriptsDir, "..", "apps", "skills", "extra"),
      join(scriptsDir, "..", "apps", "kiro-cli", "skills"),
    ];
    let checked = 0;
    let invocableSeen = 0;
    for (const root of skillRoots) {
      for (const dir of readdirSync(root)) {
        const skillMd = join(root, dir, "SKILL.md");
        if (!existsSync(skillMd)) continue;
        const frontmatter = readFileSync(skillMd, "utf-8").split("---")[1] ?? "";
        if (MODEL_INVOCABLE_SKILLS.has(dir)) {
          expect(frontmatter).not.toContain("disable-model-invocation");
          invocableSeen++;
          continue;
        }
        expect(frontmatter).toContain("disable-model-invocation: true");
        checked++;
      }
    }
    // 3 core + 3 extra + 2 kiro — bump when adding skills, never below.
    expect(checked).toBeGreaterThanOrEqual(8);
    expect(invocableSeen).toBe(1);
  });

  test("the knowledge skill's Codex sidecar allows implicit invocation", () => {
    // The counterpart of the exception above: the OpenAI sidecar must not
    // re-lock what the frontmatter deliberately leaves invocable.
    const sidecar = readFileSync(
      join(scriptsDir, "..", "apps", "skills", "core", "plannotator", "agents", "openai.yaml"),
      "utf-8",
    );
    expect(sidecar).toContain("allow_implicit_invocation: true");
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

  test("every installer copies the knowledge skill into the Kiro scope", () => {
    // #1377 install reach: the Kiro leg copied only the two action skills, so
    // Kiro users got launchers and no CLI reference. Each script spells the
    // copy differently, so assert the source path reaches the Kiro skills dir
    // in each dialect rather than one shared string.
    const kiroKnowledgeSkillCopy: ReadonlyArray<readonly [string, string]> = [
      ["install.sh", 'copy_skill_if_present apps/skills/core/plannotator "$KIRO_SKILLS_DIR"'],
      ["install.ps1", 'Copy-SkillIfPresent "apps\\skills\\core\\plannotator" $kiroSkillsDir'],
      ["install.cmd", 'xcopy /s /i /y /q "apps\\skills\\core\\plannotator" "!KIRO_SKILLS_DIR!\\plannotator\\"'],
    ];
    for (const [name, expected] of kiroKnowledgeSkillCopy) {
      expect(readScript(name), name).toContain(expected);
    }
  });

  test("every extras install command uses global scope", () => {
    const files = [
      "scripts/install.sh",
      "scripts/install.ps1",
      "scripts/install.cmd",
      // The repository map (with the extras install line) moved out of the
      // root AGENTS.md into the project guide.
      "docs/agent-guides/project-and-development.md",
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
    const cmdFailureCheck = cmdScript.indexOf("API unavailable (anonymous rate limit, proxy)");
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
    expect(match![1]).toContain("claudePlugin?: boolean");
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
type GitBehavior = "fail" | "sparse-unsupported" | "network-error" | "real-no-clone" | "repo-copy";

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
  for skill in plannotator-review plannotator-annotate plannotator-last plannotator-inbox; do
    mkdir -p "$dest/apps/skills/claude/$skill" "$dest/apps/skills/core/$skill"
    printf 'name: %s\\n' "$skill" > "$dest/apps/skills/claude/$skill/SKILL.md"
    printf 'name: %s\\n' "$skill" > "$dest/apps/skills/core/$skill/SKILL.md"
  done
  # The knowledge skill exists only under core (no Claude injection variant).
  mkdir -p "$dest/apps/skills/core/plannotator"
  printf 'name: plannotator\\n' > "$dest/apps/skills/core/plannotator/SKILL.md"
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

// git shim whose clone copies this checkout's real apps/skills and
// apps/qwen-code (so the installer copies the files that ship), and whose
// sparse-checkout succeeds and records its paths in $HOME/git-sparse.log.
// GIT_SHIM_NO_QWEN=1 leaves apps/qwen-code out, like a tag from before it.
const GIT_REPO_COPY_SHIM = `#!/bin/bash
if [ "$1" = "clone" ]; then
  dest=""
  for a in "$@"; do dest="$a"; done
  dest="\${dest//\\\\//}"
  mkdir -p "$dest/apps"
  cp -R "${join(scriptsDir, "..", "apps", "skills")}" "$dest/apps/skills"
  [ -n "$GIT_SHIM_NO_QWEN" ] || cp -R "${join(scriptsDir, "..", "apps", "qwen-code")}" "$dest/apps/qwen-code"
  exit 0
fi
if [ "$1" = "sparse-checkout" ]; then
  printf '%s\\n' "$*" >> "$HOME/git-sparse.log"
  exit 0
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
    case "real-no-clone":
      // The host git for everything but a clone (which would reach the
      // network), so the installer can inspect a real fixture repository.
      return `#!/bin/bash\nif [ "$1" = "clone" ]; then exit 1; fi\nexec "${Bun.which("git")}" "$@"\n`;
    case "repo-copy":
      return GIT_REPO_COPY_SHIM;
  }
}

function setupInstallSandbox(opts: {
  gh: GhBehavior;
  git?: GitBehavior;
  codexHome?: boolean;
  plannotatorConfig?: string;
  binary?: string;
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
if [ -n "$STUB_CURL_LOG" ]; then printf '%s\\n' "$*" >> "$STUB_CURL_LOG"; fi
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
  https://github.com/*/releases/latest) printf '%s' "\${STUB_LATEST_URL:-https://github.com/backnotprop/plannotator/releases/tag/v99.9.9}" ;;
  */releases/latest)
    if [ -n "$STUB_API_DOWN" ]; then printf '{"message":"API rate limit exceeded"}\\n403'
    else printf '{"tag_name":"v99.9.9"}\\n200'; fi ;;
  *".sha256") printf '%s  plannotator\\n' "$STUB_CHECKSUM" ;;
  */releases/download/*)
    if [ -n "$STUB_BINARY_SOURCE" ]; then cat "$STUB_BINARY_SOURCE" > "$out"
    else printf 'fake plannotator binary\\n' > "$out"; fi ;;
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
  const binarySource = opts.binary ? join(root, "binary-fixture") : undefined;
  if (binarySource) writeFileSync(binarySource, opts.binary!);
  const binaryChecksum = opts.binary ? createHash("sha256").update(opts.binary).digest("hex") : FAKE_BINARY_SHA256;
  return { home, stub, binarySource, binaryChecksum };
}

function runInstallSh(
  sandbox: { home: string; stub: string; binarySource?: string; binaryChecksum?: string },
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const r = Bun.spawnSync(
    ["bash", join(scriptsDir, "install.sh"), ...args],
    {
      env: {
        HOME: sandbox.home,
        TMPDIR: join(sandbox.home, "tmp"),
        PATH: `${sandbox.stub}:/usr/bin:/bin`,
        STUB_CHECKSUM: sandbox.binaryChecksum ?? FAKE_BINARY_SHA256,
        STUB_BINARY_SOURCE: sandbox.binarySource ?? "",
        STUB_ATT_JSON: ATTESTATION_FIXTURE,
        PLANNOTATOR_SKIP_SEM_INSTALL: "1",
        PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL: "1",
        ...extraEnv,
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
  "install.sh latest version without the GitHub API (#1994)",
  () => {
    const args = ["--non-interactive", "--skip-skills"];
    const binary = "#!/bin/sh\necho plannotator-fixture\n";
    const REDIRECT_PAGE = "https://github.com/backnotprop/plannotator/releases/latest";

    function run(env: Record<string, string>, extraArgs: string[] = []) {
      const sandbox = setupInstallSandbox({ gh: "pass-all", binary });
      const log = join(sandbox.home, "curl.log");
      const result = runInstallSh(sandbox, [...args, ...extraArgs], { STUB_CURL_LOG: log, ...env });
      const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
      return { ...result, calls, home: sandbox.home };
    }

    test("falls back to the releases/latest redirect when the API is rate-limited, and still checks the checksum", () => {
      const result = run({ STUB_API_DOWN: "1" });
      expect(result.code).toBe(0);
      expect(result.out).toContain("Installing plannotator v99.9.9...");
      // The only new request is a HEAD on the release page; the binary and
      // its checksum are fetched exactly as on the API path.
      const fallback = result.calls.filter((c) => c.includes(REDIRECT_PAGE));
      expect(fallback).toHaveLength(1);
      expect(fallback[0]).toContain("-fsSLI");
      expect(result.calls.some((c) => c.includes("/releases/download/v99.9.9/") && c.endsWith(".sha256"))).toBe(true);
      expect(existsSync(join(result.home, ".local", "bin", "plannotator"))).toBe(true);
    });

    test("a wrong checksum still stops an install whose tag came from the redirect", () => {
      const result = run({ STUB_API_DOWN: "1", STUB_CHECKSUM: "0".repeat(64) });
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("Checksum verification failed");
      expect(existsSync(join(result.home, ".local", "bin", "plannotator"))).toBe(false);
    });

    test("the redirect is not requested when the API answers", () => {
      const result = run({});
      expect(result.code).toBe(0);
      expect(result.out).toContain("Installing plannotator v99.9.9...");
      expect(result.calls.some((c) => c.includes(REDIRECT_PAGE))).toBe(false);
    });

    test("a pinned --version asks neither the API nor the redirect", () => {
      const result = run({ STUB_API_DOWN: "1" }, ["--version", "v99.9.9"]);
      expect(result.code).toBe(0);
      expect(result.calls.some((c) => c.includes("/releases/latest"))).toBe(false);
    });

    test("fails clearly when neither the API nor the redirect gives a tag", () => {
      const result = run({ STUB_API_DOWN: "1", STUB_LATEST_URL: REDIRECT_PAGE });
      expect(result.code).toBe(1);
      expect(result.out).toContain("Failed to fetch latest version (check your connection, or pass --version vX.Y.Z)");
      expect(result.calls.some((c) => c.includes("/releases/download/"))).toBe(false);
    });

    for (const hostile of [
      "https://github.com/backnotprop/plannotator/releases/tag/v1.2.3?x=1",
      "https://github.com/backnotprop/plannotator/releases/tag/v1.2.3-evil",
      "https://github.com/backnotprop/plannotator/releases/tag/v1.2.3$(touch pwned)",
      "https://github.com/backnotprop/plannotator/releases/tag/v1.2.3/",
      "https://github.com/backnotprop/plannotator/releases/tag/v1.2.3.4",
      "https://github.com/backnotprop/plannotator/releases/tag/V1.2.3",
      "https://github.com/backnotprop/plannotator/releases/tag/v1..3",
    ]) {
      test(`rejects a redirect that is not a plain vX.Y.Z tag: ${hostile}`, () => {
        const result = run({ STUB_API_DOWN: "1", STUB_LATEST_URL: hostile });
        expect(result.code).toBe(1);
        expect(result.out).toContain("Failed to fetch latest version");
        expect(result.calls.some((c) => c.includes("/releases/download/"))).toBe(false);
        expect(existsSync(join(result.home, "pwned"))).toBe(false);
      });
    }
  },
);

// Safe updates (step 1): Plannotator's own updater downloads this script and
// the .sha256 of both binaries with its own connection, and hands them over in
// PLANNOTATOR_EXPECTED_SHA256. The script must compare its download against
// that value before anything is replaced, exit 113 on a mismatch (after
// marking it in the updater's PLANNOTATOR_UPDATE_MISMATCH_FILE), and keep the
// installed binary. Without the variables it behaves exactly as before.
describe.skipIf(process.platform === "win32" || !Bun.which("node"))(
  "install.sh PLANNOTATOR_EXPECTED_SHA256 (safe updates)",
  () => {
    const args = ["--version", "v99.9.9", "--non-interactive", "--skip-skills"];
    const binary = "#!/bin/sh\necho plannotator-fixture-new\n";
    const os = process.platform === "darwin" ? "darwin" : "linux";
    const machine = Bun.spawnSync(["uname", "-m"]).stdout.toString().trim();
    const arch = machine === "x86_64" || machine === "amd64" ? "x64" : "arm64";
    const mine = `plannotator-${os}-${arch}`;
    const other = `plannotator-${os}-${arch === "x64" ? "arm64" : "x64"}`;
    const OLD = "#!/bin/sh\necho plannotator-old\n";

    function run(pin: string | undefined, opts: { servedChecksum?: string; marker?: string } = {}) {
      const sandbox = setupInstallSandbox({ gh: "pass-all", binary });
      const installed = join(sandbox.home, ".local", "bin", "plannotator");
      mkdirSync(join(sandbox.home, ".local", "bin"), { recursive: true });
      writeFileSync(installed, OLD, { mode: 0o755 });
      const log = join(sandbox.home, "curl.log");
      const env: Record<string, string> = { STUB_CURL_LOG: log };
      if (pin !== undefined) env.PLANNOTATOR_EXPECTED_SHA256 = pin;
      if (opts.servedChecksum) env.STUB_CHECKSUM = opts.servedChecksum;
      if (opts.marker) env.PLANNOTATOR_UPDATE_MISMATCH_FILE = opts.marker;
      const result = runInstallSh(sandbox, args, env);
      const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
      return { ...result, calls, installed: readFileSync(installed, "utf8"), checksum: sandbox.binaryChecksum! };
    }
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const fetchedSha256 = (calls: string[]) => calls.some((c) => c.endsWith(".sha256"));

    test("a matching pin installs, says so, and does not fetch the .sha256 again", () => {
      const r = run(`${other}=${"0".repeat(64)} ${mine}=${sha(binary)}`);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Checksum matches the one Plannotator fetched for v99.9.9.");
      expect(fetchedSha256(r.calls)).toBe(false);
      expect(r.installed).toBe(binary);
    });

    test("the pin is read for this machine's CPU type only, and in any letter case", () => {
      // Upper case is the pin itself (no fallback to the .sha256): it says so.
      const upper = run(`${mine}=${sha(binary).toUpperCase()} ${other}=${"f".repeat(64)}`);
      expect(upper.code).toBe(0);
      expect(upper.out).toContain("Checksum matches the one Plannotator fetched for v99.9.9.");
      expect(fetchedSha256(upper.calls)).toBe(false);
      // Only the other CPU type matches: this one is a mismatch.
      const r = run(`${mine}=${"f".repeat(64)} ${other}=${sha(binary)}`);
      expect(r.code).toBe(113);
    });

    test("only this machine's pin is enough (the other CPU type's may be missing)", () => {
      const r = run(`${mine}=${sha(binary)}`);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Checksum matches the one Plannotator fetched for v99.9.9.");
      expect(r.installed).toBe(binary);
    });

    test("tamper: a download that differs from the pin exits 113, marks it, and keeps the installed binary", () => {
      // The network serves a .sha256 that matches the altered binary: only the pin catches it.
      const markerDir = mkdtempSync(join(tmpdir(), "plannotator-mismatch-mark-"));
      const marker = join(markerDir, "checksum-mismatch");
      const r = run(`${mine}=${sha("the genuine binary")} ${other}=${sha("the genuine binary")}`, { servedChecksum: sha(binary), marker });
      expect(r.code).toBe(113);
      expect(existsSync(marker)).toBe(true);
      rmSync(markerDir, { recursive: true, force: true });
      expect(r.out).toContain("Stopped: the v99.9.9 download doesn't match the checksum Plannotator fetched for it.");
      expect(r.out).toContain("Nothing was changed; the Plannotator you have still works.");
      expect(r.out).not.toContain("curl -fsSL");
      expect(r.installed).toBe(OLD);
      expect(fetchedSha256(r.calls)).toBe(false);
    });

    test("the marker is only ever a file named checksum-mismatch at an absolute path", () => {
      const markerDir = mkdtempSync(join(tmpdir(), "plannotator-mismatch-mark-"));
      const elsewhere = join(markerDir, "some-other-file");
      const r = run(`${mine}=${"f".repeat(64)}`, { marker: elsewhere });
      expect(r.code).toBe(113);
      expect(existsSync(elsewhere)).toBe(false);
      rmSync(markerDir, { recursive: true, force: true });
    });

    test("a pin with no entry for this binary, or a malformed one, falls back to the .sha256 check", () => {
      for (const pin of [`${other}=${sha(binary)}`, `${mine}=nothex`, `${mine}=${"a".repeat(63)}`, "garbage"]) {
        const r = run(pin);
        expect(r.code).toBe(0);
        expect(r.out).toContain(`the update carried no checksum for ${mine}`);
        expect(fetchedSha256(r.calls)).toBe(true);
        expect(r.installed).toBe(binary);
      }
    });

    test("without the variable nothing changes: the .sha256 is fetched and a mismatch is exit 1, as before", () => {
      const ok = run(undefined);
      expect(ok.code).toBe(0);
      expect(fetchedSha256(ok.calls)).toBe(true);
      expect(ok.out).not.toContain("Plannotator fetched");
      const bad = run(undefined, { servedChecksum: "0".repeat(64) });
      expect(bad.code).toBe(1);
      expect(bad.out).toContain("Checksum verification failed!");
      expect(bad.installed).toBe(OLD);
    });
  },
);

describe("install scripts pin the sem sidecar's checksums (no checksums.txt fetch)", () => {
  const sh = readFileSync(join(scriptsDir, "install.sh"), "utf8");
  const ps1 = readFileSync(join(scriptsDir, "install.ps1"), "utf8");
  const cmd = readFileSync(join(scriptsDir, "install.cmd"), "utf8");
  // Bumping SEM_VERSION without new pins would make every sem install skip
  // ("checksum mismatch"); this fails first, naming the version to re-pin.
  test("each installer pins sem v0.8.0 and no longer reads checksums.txt", () => {
    for (const [name, text] of [["install.sh", sh], ["install.ps1", ps1], ["install.cmd", cmd]] as const) {
      expect(`${name}:${/v0\.8\.0/.test(text)}`).toBe(`${name}:true`);
      expect(`${name}:${text.includes("checksums.txt\"") || /\/checksums\.txt/.test(text)}`).toBe(`${name}:false`);
    }
    expect(sh).toContain("a98235ac9f8fae93364ddb7c681036fbe33af756db40e067331ef2091ecc8e6a");
    expect(ps1).toContain("2a4b57f8368f0c88ded52f9ecbe0a85771008e37aa09215fc9ce750adab03d06");
    expect(cmd).toContain("2a4b57f8368f0c88ded52f9ecbe0a85771008e37aa09215fc9ce750adab03d06");
  });
});

describe("is_release_tag (install.sh): only a plain vX.Y.Z tag", () => {
  const script = readScript("install.sh");
  const fn = script.slice(script.indexOf("is_release_tag() {"), script.indexOf("\n}\n", script.indexOf("is_release_tag() {")) + 3);
  const check = (tag: string) =>
    Bun.spawnSync(["bash", "-c", `${fn}\nis_release_tag "$1"`, "bash", tag], { env: { LC_ALL: "en_US.UTF-8", PATH: "/usr/bin:/bin" } }).exitCode === 0;

  test("accepts release tags", () => {
    for (const t of ["v0.28.25", "v1.2.3", "v10.20.30"]) expect(check(t)).toBe(true);
  });

  test("rejects everything else", () => {
    for (const t of ["", "latest", "1.2.3", "V1.2.3", "v1.2", "v1.2.3.4", "v.1.2", "v1..2", "v1.2.", "v1.2.3-rc1", "v1.2.3?x", "v1.2.3/", "v1.2.3 ", "v1.2.3\nx", "-v1.2.3", "v1.2.\u0663", "v1.2.3;id"]) {
      expect(check(t)).toBe(false);
    }
  });
});

describe("install.ps1 / install.cmd: the latest tag is strictly validated (#1994)", () => {
  test("install.ps1 checks the API tag and the redirect tag with one anchored, case-sensitive pattern", () => {
    const ps = readScript("install.ps1");
    expect(ps).toContain("$releaseTagPattern = '^v[0-9]+\\.[0-9]+\\.[0-9]+\\z'");
    expect(ps).toContain("if ($latestTag -cnotmatch $releaseTagPattern) { $latestTag = $null }");
    expect(ps).toContain("if ($candidate -cmatch $releaseTagPattern) { $latestTag = $candidate }");
    expect(ps).not.toMatch(/-match '\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+'/);
  });

  test("install.cmd splits the redirect URL without FOR-IN globbing and checks every character of the tag", () => {
    const cmd = readScript("install.cmd");
    expect(cmd).not.toContain('for %%t in ("!LATEST_URL:/=" "!")');
    expect(cmd).toContain('set "LATEST_URL=!LATEST_URL:*/=!"');
    expect(cmd).toContain("for %%c in (0 1 2 3 4 5 6 7 8 9) do if defined TAG_DOTS");
    expect(cmd).toContain('if not "!TAG_DOTS!"==".." set "TAG="');
    expect(cmd).toContain("-cmatch '^v[0-9]+\\.[0-9]+\\.[0-9]+\\z'");
    // The strict check runs on every latest-resolved tag (API or redirect),
    // before the empty-tag failure.
    const check = cmd.indexOf('if not "!TAG_DOTS!"==".." set "TAG="');
    const redirect = cmd.indexOf("releases/latest\"`) do set \"LATEST_URL=%%u\"");
    const fail = cmd.indexOf("Failed to get latest version");
    expect(redirect).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(redirect);
    expect(fail).toBeGreaterThan(check);
  });
});

describe.skipIf(process.platform === "win32" || !Bun.which("node"))(
  "install.sh optional T3 hook",
  () => {
    const args = ["--version", "v99.9.9", "--non-interactive", "--skip-skills"];
    const sourceHook = join(scriptsDir, "..", "packages", "t3-code", "hook.ts");
    const helper = `import { runT3Hook } from ${JSON.stringify(sourceHook)}; await runT3Hook(Bun.argv.slice(2), [process.execPath]);`;
    const binary = `#!/bin/sh\nexec ${quoteHookWord(process.execPath)} --eval ${quoteHookWord(helper)} "$@"\n`;
    const fixture = () => setupInstallSandbox({ gh: "pass-all", binary });
    const settingsFile = (home: string) => join(home, ".claude", "settings.json");

    test("default installation adds no T3 hook or Claude settings file", () => {
      const sandbox = fixture();
      const result = runInstallSh(sandbox, args);
      expect(result.code).toBe(0);
      expect(existsSync(settingsFile(sandbox.home))).toBe(false);
      expect(result.out).not.toContain("T3 hook installed");
    });

    test("opt-in uses the chosen profile, safely pins the binary and data directory, and remains idempotent", () => {
      const sandbox = fixture();
      const profile = join(sandbox.home, "Claude work's profile");
      const dataDir = join(sandbox.home, "T3 session's data");
      const file = join(profile, "settings.json");
      const customHook = { matcher: "Bash", hooks: [{ type: "command", command: "my-custom-hook" }] };
      mkdirSync(profile);
      writeFileSync(file, JSON.stringify({ theme: "dark", hooks: { PreToolUse: [customHook] } }));
      const env = { CLAUDE_CONFIG_DIR: profile, PLANNOTATOR_DATA_DIR: dataDir };
      const installed = runInstallSh(sandbox, [...args, "--with-t3"], env);
      expect(installed.code).toBe(0);
      const settings = JSON.parse(readFileSync(file, "utf8"));
      expect(settings.theme).toBe("dark");
      expect(settings.hooks.PreToolUse).toHaveLength(2);
      expect(settings.hooks.PreToolUse[0]).toEqual(customHook);
      expect(existsSync(settingsFile(sandbox.home))).toBe(false);
      const command = settings.hooks.PreToolUse[1].hooks[0].command;
      const invoke = (entrypoint?: string) => Bun.spawnSync(["/bin/sh", "-c", command], {
        env: { HOME: sandbox.home, PATH: "/usr/bin:/bin", ...(entrypoint ? { CLAUDE_CODE_ENTRYPOINT: entrypoint } : {}) },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_fixture", session_id: "fixture",
          cwd: sandbox.home, tool_input: { command: "plannotator annotate notes.md --gate" },
        })),
        stdout: "pipe", stderr: "pipe",
      });
      // An Agent SDK session (T3 runs Claude through it) reaches the binary.
      const invoked = invoke("sdk-ts");
      expect(invoked.exitCode).toBe(0);
      expect(JSON.parse(invoked.stdout.toString())).toEqual({});
      // Any other Claude session is answered by the shell: no output, no decision.
      for (const entrypoint of ["cli", undefined]) {
        const skipped = invoke(entrypoint);
        expect(skipped.exitCode).toBe(0);
        expect(skipped.stdout.toString()).toBe("");
        expect(skipped.stderr.toString()).toBe("");
      }
      expect(JSON.parse(readFileSync(join(dataDir, "install-flags.json"), "utf8"))).toEqual({ v: 1, flags: ["with-t3", "skip-skills"] });
      const before = readFileSync(file, "utf8");
      expect(runInstallSh(sandbox, [...args, "--with-t3"], env).code).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(runInstallSh(sandbox, args, env).code).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(before);
    });

    test("removal preserves other hooks and the saved connection", () => {
      const sandbox = fixture();
      const file = settingsFile(sandbox.home);
      const customHook = { matcher: "Bash", hooks: [{ type: "command", command: "my-custom-hook" }] };
      mkdirSync(join(sandbox.home, ".claude"));
      writeFileSync(file, JSON.stringify({ theme: "dark", hooks: { PreToolUse: [customHook] } }));
      expect(runInstallSh(sandbox, [...args, "--with-t3"]).code).toBe(0);
      const credential = join(sandbox.home, ".plannotator", "t3-code", "connection", "oauth.json");
      mkdirSync(join(credential, ".."), { recursive: true });
      writeFileSync(credential, "private fixture connection");
      expect(runInstallSh(sandbox, [...args, "--without-t3"]).code).toBe(0);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ theme: "dark", hooks: { PreToolUse: [customHook] } });
      expect(readFileSync(credential, "utf8")).toBe("private fixture connection");
      const before = readFileSync(file, "utf8");
      expect(runInstallSh(sandbox, [...args, "--without-t3"]).code).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(JSON.parse(readFileSync(join(sandbox.home, ".plannotator", "install-flags.json"), "utf8"))).toEqual({ v: 1, flags: ["without-t3", "skip-skills"] });
    });

    test("a T3 hook step that fails is reported but never aborts the install, and malformed settings are preserved", () => {
      // What regresses: under `set -e` a failed opt-in step ended the whole
      // install before the rest of it (and install-flags.json) ran.
      const sandbox = fixture();
      const file = settingsFile(sandbox.home);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "{invalid settings");
      const result = runInstallSh(sandbox, [...args, "--with-t3"]);
      expect(result.code).toBe(0);
      expect(result.out).not.toContain("T3 hook installed");
      expect(result.out).toContain("T3 Code hook: could not install it");
      expect(readFileSync(file, "utf8")).toBe("{invalid settings");
      expect(JSON.parse(readFileSync(join(sandbox.home, ".plannotator", "install-flags.json"), "utf8"))).toEqual({ v: 1, flags: ["with-t3", "skip-skills"] });
      const removal = runInstallSh(sandbox, [...args, "--without-t3"]);
      expect(removal.code).toBe(0);
      expect(removal.out).toContain("T3 Code hook: could not remove it");
      expect(readFileSync(file, "utf8")).toBe("{invalid settings");
    });

    test("minimal stays binary-only even when T3 is requested", () => {
      const sandbox = fixture();
      const result = runInstallSh(sandbox, [...args, "--minimal", "--with-t3"]);
      expect(result.code).toBe(0);
      expect(existsSync(settingsFile(sandbox.home))).toBe(false);
      expect(result.out).not.toContain("T3 hook installed");
    });

    test("conflicting choices fail before downloading a binary", () => {
      const sandbox = fixture();
      const result = runInstallSh(sandbox, [...args, "--with-t3", "--without-t3"]);
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("mutually exclusive");
      expect(existsSync(join(sandbox.home, ".local", "bin", "plannotator"))).toBe(false);
    });

    test("the optional Bash hook causes no false plan-plugin warning, but a native plan hook still does", () => {
      const sandbox = fixture();
      const plugin = join(sandbox.home, ".claude", "plugins", "marketplaces", "plannotator", "apps", "hook", "hooks", "hooks.json");
      mkdirSync(join(plugin, ".."), { recursive: true });
      writeFileSync(plugin, readFileSync(join(scriptsDir, "..", "apps", "hook", "hooks", "hooks.json")));
      const installed = runInstallSh(sandbox, [...args, "--with-t3"]);
      expect(installed.code).toBe(0);
      expect(installed.out).not.toContain("DUPLICATE HOOK DETECTED");
      const file = settingsFile(sandbox.home);
      const settings = JSON.parse(readFileSync(file, "utf8"));
      settings.hooks.PermissionRequest = [{ matcher: "ExitPlanMode", hooks: [{ type: "command", command: "plannotator" }] }];
      writeFileSync(file, JSON.stringify(settings));
      const repeated = runInstallSh(sandbox, args);
      expect(repeated.code).toBe(0);
      expect(repeated.out).toContain("DUPLICATE HOOK DETECTED");
      expect(readFileSync(plugin)).toEqual(readFileSync(join(scriptsDir, "..", "apps", "hook", "hooks", "hooks.json")));
    });
  },
);

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
      // The knowledge skill lands in both scopes from its single core source.
      expect(existsSync(join(sandbox.home, ".claude", "skills", "plannotator", "SKILL.md"))).toBe(true);
      expect(existsSync(join(sandbox.home, ".agents", "skills", "plannotator", "SKILL.md"))).toBe(true);
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
// Closing summary: agent-specific sections print only for agents the run
// detected (existing detection legs: `pi` on PATH, ~/.gemini, Codex home or
// CLI, ~/.kiro or kiro-cli). OpenCode (no detection leg) and Claude Code stay
// universal. Every run is a full install into a temp HOME with a stubbed PATH;
// the git shim supplies a local checkout, so nothing reaches the network.
// ---------------------------------------------------------------------------
type SummaryAgent = "pi" | "omp" | "gemini" | "codex" | "kiro";

const SUMMARY_HEADERS: Record<SummaryAgent, string> = {
  pi: "  PI USERS",
  omp: "  OH MY PI (OMP) USERS",
  gemini: "  GEMINI CLI USERS",
  codex: "  CODEX USERS",
  kiro: "  KIRO CLI USERS",
};

function runSummaryInstall(detected: SummaryAgent[], extraArgs: string[] = []) {
  const sandbox = setupInstallSandbox({
    gh: "pass-all",
    git: "sparse-unsupported",
    codexHome: detected.includes("codex"),
  });
  if (detected.includes("gemini")) mkdirSync(join(sandbox.home, ".gemini"), { recursive: true });
  if (detected.includes("kiro")) mkdirSync(join(sandbox.home, ".kiro"), { recursive: true });
  // A no-op `pi` on PATH is exactly what the Pi detection leg checks; the
  // installer's `pi install` call against it succeeds without doing anything.
  if (detected.includes("pi")) writeFileSync(join(sandbox.stub, "pi"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  // OMP is detected by `omp` on PATH. The installer never runs it (the stub
  // exits 1 so a call would show up as a failure), it only prints how to install.
  if (detected.includes("omp")) writeFileSync(join(sandbox.stub, "omp"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
  const r = runInstallSh(sandbox, ["--version", "v99.9.9", "--non-interactive", "--no-extras", ...extraArgs]);
  return { ...r, home: sandbox.home };
}

function expectOnlySections(out: string, detected: SummaryAgent[]) {
  for (const agent of Object.keys(SUMMARY_HEADERS) as SummaryAgent[]) {
    const lines = out.split("\n");
    const present = lines.includes(SUMMARY_HEADERS[agent]);
    expect({ agent, present }).toEqual({ agent, present: detected.includes(agent) });
  }
  // Universal sections are unaffected by detection.
  expect(out).toContain("  OPENCODE USERS");
  expect(out).toContain("CLAUDE CODE USERS:");
  expect(out).toContain("/plugin marketplace add backnotprop/plannotator");
  // An undetected agent is represented by absence, never by a nag.
  expect(out).not.toContain("was not detected");
}

describe.skipIf(process.platform === "win32" || !Bun.which("node"))(
  "install.sh closing summary shows only detected agents",
  () => {
    test("nothing detected: only the universal OpenCode and Claude Code sections", () => {
      const { code, out } = runSummaryInstall([]);
      expect(code).toBe(0);
      expectOnlySections(out, []);
      expect(out).toContain("The /plannotator-review, /plannotator-annotate, and /plannotator-last commands are ready to use after you restart Claude Code!");
    });

    for (const agent of Object.keys(SUMMARY_HEADERS) as SummaryAgent[]) {
      test(`only ${agent} detected: only its section is added`, () => {
        const { code, out } = runSummaryInstall([agent]);
        expect(code).toBe(0);
        expectOnlySections(out, [agent]);
      });
    }

    test("all detected: every agent section prints, in the original order", () => {
      const all: SummaryAgent[] = ["pi", "omp", "gemini", "codex", "kiro"];
      const { code, out } = runSummaryInstall(all);
      expect(code).toBe(0);
      expectOnlySections(out, all);
      const order = ["  OPENCODE USERS", ...all.map((a) => SUMMARY_HEADERS[a]), "CLAUDE CODE USERS:"].map((h) =>
        out.indexOf(h),
      );
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(out).toContain("Launch it: kiro-cli chat --agent plannotator");
      expect(out).toContain("Plan review is configured through the Codex Stop hook.");
      // The OMP section names the plugin install command (#1814).
      expect(out).toContain("  omp plugin install @plannotator/pi-extension");
    });

    test("a detected-but-skipped agent keeps its honest skipped section", () => {
      const { code, out } = runSummaryInstall(["codex", "gemini"], ["--skip-codex", "--skip-gemini"]);
      expect(code).toBe(0);
      expectOnlySections(out, ["codex", "gemini"]);
      expect(out).toContain("Codex was detected, but the integration was skipped (--skip-codex).");
      expect(out).toContain("Gemini was detected, but the integration was skipped (--skip-gemini).");
    });

    test("--skip-skills: detected sections report the skip, undetected ones stay hidden", () => {
      const { code, out } = runSummaryInstall(["kiro"], ["--skip-skills"]);
      expect(code).toBe(0);
      expectOnlySections(out, ["kiro"]);
      expect(out).toContain("Kiro was detected, but skills were skipped (--skip-skills)");
      expect(out).toContain("  CLAUDE CODE USERS: BINARY INSTALLED");
    });

    test("--minimal prints no agent sections at all, detected or not", () => {
      const { code, out } = runSummaryInstall(["pi", "omp", "gemini", "codex", "kiro"], ["--minimal"]);
      expect(code).toBe(0);
      expect(out).toContain("Minimal install complete");
      expect(out).not.toContain(" USERS");
    });
  },
);

// ---------------------------------------------------------------------------
// install-flags.json (#1634): each successful run records the install-affecting
// flags it was given, so a background auto-update re-runs with the same ones.
// ---------------------------------------------------------------------------
describe.skipIf(process.platform === "win32" || !Bun.which("node"))(
  "install.sh remembers its command-line flags",
  () => {
    const readFlags = (home: string) =>
      JSON.parse(readFileSync(join(home, ".plannotator", "install-flags.json"), "utf-8"));

    test("a full install records its opt-out flags as neutral ids", () => {
      const { code, home } = runSummaryInstall(["codex"], ["--skip-codex", "--skip-skills"]);
      expect(code).toBe(0);
      expect(readFlags(home)).toEqual({ v: 1, flags: ["skip-codex", "skip-skills"] });
    });

    test("a minimal install records --minimal (the binary-only early exit writes it too)", () => {
      const { code, home } = runSummaryInstall([], ["--minimal", "--skip-gemini"]);
      expect(code).toBe(0);
      expect(readFlags(home)).toEqual({ v: 1, flags: ["minimal", "skip-gemini"] });
    });

    test("a run with no flags records an empty set; non-install flags are never recorded", () => {
      const { code, home } = runSummaryInstall([]);
      expect(code).toBe(0);
      // runSummaryInstall passes --version, --non-interactive and --no-extras.
      expect(readFlags(home)).toEqual({ v: 1, flags: [] });
    });

    test("the file lands in PLANNOTATOR_DATA_DIR when it is set", () => {
      const sandbox = setupInstallSandbox({ gh: "pass-all" });
      const dataDir = join(sandbox.home, "custom-data");
      const r = Bun.spawnSync(
        ["bash", join(scriptsDir, "install.sh"), "--version", "v99.9.9", "--minimal", "--skip-attestation", "--non-interactive"],
        {
          env: {
            HOME: sandbox.home,
            TMPDIR: join(sandbox.home, "tmp"),
            PATH: `${sandbox.stub}:/usr/bin:/bin`,
            STUB_CHECKSUM: FAKE_BINARY_SHA256,
            STUB_ATT_JSON: ATTESTATION_FIXTURE,
            PLANNOTATOR_DATA_DIR: dataDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(dataDir, "install-flags.json"), "utf-8"))).toEqual({
        v: 1,
        flags: ["minimal", "skip-attestation"],
      });
      expect(existsSync(join(sandbox.home, ".plannotator", "install-flags.json"))).toBe(false);
    });
  },
);

describe("install-flags.json is written by every installer", () => {
  test("install.ps1 and install.cmd record the same neutral ids after both exits", () => {
    const ps = readScript("install.ps1");
    const cmd = readScript("install.cmd");
    for (const id of ["minimal", "no-minimal", "verify-attestation", "skip-attestation", "with-call-flow", "skip-codex", "skip-gemini", "skip-kiro", "skip-vibe", "skip-opencode", "skip-qwen", "skip-skills", "skip-claude-plugin"]) {
      expect(ps).toContain(`$ids += "${id}"`);
      expect(cmd).toContain(`call :AddInstallFlag ${id}`);
    }
    // Called in the minimal gate and once at the end of the full install.
    expect(ps.split("\n").filter((l) => l.trim() === "Write-InstallFlags")).toHaveLength(2);
    expect(cmd.split("\n").filter((l) => l.trim() === "call :WriteInstallFlags")).toHaveLength(2);
  });
});

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

// ---------------------------------------------------------------------------
// Closing summary on Windows: install.ps1 prints PI USERS / KIRO CLI USERS
// only for a detected agent (install.ps1 has no Gemini or Codex closing
// section), and install.cmd prints KIRO CLI USERS only when KIRO_AVAILABLE.
// The ps1 region is driven under pwsh when available; both are source-scanned.
// ---------------------------------------------------------------------------

function extractPs1ClosingSummaryRegion(): string {
  const ps = readScript("install.ps1");
  const start = ps.indexOf('Write-Host "  OPENCODE USERS"');
  const end = ps.indexOf("# Warn if plannotator is configured in both settings.json hooks");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("could not locate the closing summary region in install.ps1");
  }
  return ps.slice(start, end);
}

describe("closing summary sections are gated on detection (Windows installers)", () => {
  test("install.ps1 gates PI USERS on the Pi detection leg and KIRO CLI USERS on $kiroAvailable", () => {
    const region = extractPs1ClosingSummaryRegion();
    const piGate = region.indexOf("if ($piDetected) {");
    const kiroGate = region.indexOf("if ($kiroAvailable) {");
    expect(region).toContain("$piDetected = [bool](Get-Command pi -ErrorAction SilentlyContinue)");
    expect(piGate).toBeGreaterThan(0);
    expect(kiroGate).toBeGreaterThan(piGate);
    // Each header sits inside its gate, not before it.
    expect(region.indexOf('Write-Host "  PI USERS"')).toBeGreaterThan(piGate);
    const ompGate = region.indexOf("if ($ompDetected) {");
    expect(region).toContain("$ompDetected = [bool](Get-Command omp -ErrorAction SilentlyContinue)");
    expect(ompGate).toBeGreaterThan(piGate);
    expect(region.indexOf('Write-Host "  OH MY PI (OMP) USERS"')).toBeGreaterThan(ompGate);
    expect(region.indexOf('Write-Host "  KIRO CLI USERS"')).toBeGreaterThan(kiroGate);
    expect(region).not.toContain("Kiro was not detected");
    // The Claude Code block stays universal.
    expect(region).toContain('Write-Host "  CLAUDE CODE USERS: YOU ARE ALL SET!"');
  });

  test("install.cmd prints the KIRO CLI USERS header only inside the KIRO_AVAILABLE gate", () => {
    const script = readScript("install.cmd");
    const header = script.indexOf("echo   KIRO CLI USERS");
    const gate = script.lastIndexOf('if "!KIRO_AVAILABLE!"=="1" (', header);
    expect(header).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(0);
    // Nothing but the separator lines between the gate and the header.
    expect(script.slice(gate, header)).toBe(
      'if "!KIRO_AVAILABLE!"=="1" (\n    echo.\n    echo ==========================================\n    ',
    );
    expect(script).not.toContain("Kiro was not detected");
  });
});

function runPs1ClosingSummary(opts: { pi: boolean; kiro: boolean; omp?: boolean; skipKiro?: boolean; skipSkills?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-ps1-summary-test-"));
  const home = join(root, "home");
  const stub = join(root, "stub-bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(stub, { recursive: true });
  if (opts.pi) writeFileSync(join(stub, "pi"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  if (opts.omp) writeFileSync(join(stub, "omp"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
  const driver = [
    `$ErrorActionPreference = "Stop"`,
    `$skipOpencodeResolved = $false`,
    `$skipSkillsResolved = $${opts.skipSkills ? "true" : "false"}`,
    `$skipSkillsSource = "-SkipSkills"`,
    `$kiroAvailable = $${opts.kiro ? "true" : "false"}`,
    `$skipKiroResolved = $${opts.skipKiro ? "true" : "false"}`,
    `$skipKiroSource = "-SkipKiro"`,
    `$extrasChoice = "no"`,
    // The Claude Code block reads the plugin-update state and prints the
    // manual commands through the installer's own helper.
    `$claudePluginState = "none"`,
    `$claudePluginVersion = ""`,
    `$claudePluginId = "plannotator@plannotator"`,
    extractPs1Function("Write-ClaudePluginManualUpdate"),
    `Write-Host ""`,
    `Write-Host "=========================================="`,
    extractPs1ClosingSummaryRegion(),
    `exit 0`,
  ].join("\n");
  const driverPath = join(root, "driver.ps1");
  writeFileSync(driverPath, driver);
  const r = Bun.spawnSync([pwshBin!, "-NoProfile", "-File", driverPath], {
    env: { PATH: `${stub}:/usr/bin:/bin`, HOME: home, USERPROFILE: home, TMPDIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe.skipIf(!pwshBin || process.platform === "win32")(
  "install.ps1 closing summary under PowerShell",
  () => {
    test("nothing detected: no PI or KIRO section, universal sections intact", () => {
      const { code, out } = runPs1ClosingSummary({ pi: false, kiro: false });
      expect(code).toBe(0);
      expect(out).not.toContain("PI USERS");
      expect(out).not.toContain("OH MY PI (OMP) USERS");
      expect(out).not.toContain("KIRO CLI USERS");
      expect(out).not.toContain("was not detected");
      expect(out).toContain("OPENCODE USERS");
      expect(out).toContain("CLAUDE CODE USERS: YOU ARE ALL SET!");
    }, PWSH_SCANNER_TIMEOUT_MS);

    test("pi and kiro detected: both sections print", () => {
      const { code, out } = runPs1ClosingSummary({ pi: true, kiro: true });
      expect(code).toBe(0);
      expect(out).toContain("  PI USERS");
      // Install and update are different Pi commands (#902).
      expect(out).toContain("  pi install npm:@plannotator/pi-extension\n");
      expect(out).toContain("  pi update npm:@plannotator/pi-extension\n");
      expect(out).toContain("  KIRO CLI USERS");
      expect(out).toContain("Launch it: kiro-cli chat --agent plannotator");
    }, PWSH_SCANNER_TIMEOUT_MS);

    test("omp detected: the OMP section names the plugin install command", () => {
      const { code, out } = runPs1ClosingSummary({ pi: false, kiro: false, omp: true });
      expect(code).toBe(0);
      expect(out).toContain("  OH MY PI (OMP) USERS");
      expect(out).toContain("  omp plugin install @plannotator/pi-extension");
      expect(out.split("\n")).not.toContain("  PI USERS");
    }, PWSH_SCANNER_TIMEOUT_MS);

    test("detected-but-skipped Kiro keeps its honest skipped section", () => {
      const { code, out } = runPs1ClosingSummary({ pi: false, kiro: true, skipKiro: true });
      expect(code).toBe(0);
      expect(out).toContain("Kiro was detected, but the integration was skipped (-SkipKiro).");
      expect(out).not.toContain("PI USERS");
    }, PWSH_SCANNER_TIMEOUT_MS);

    test("-SkipSkills with Kiro detected reports the skills skip", () => {
      const { code, out } = runPs1ClosingSummary({ pi: false, kiro: true, skipSkills: true });
      expect(code).toBe(0);
      expect(out).toContain("Kiro was detected, but skills were skipped (-SkipSkills)");
      expect(out).toContain("CLAUDE CODE USERS: BINARY INSTALLED");
    }, PWSH_SCANNER_TIMEOUT_MS);
  },
);

// Auto-update (#1634) runs these scripts in the background while other
// plannotator processes may be running, so the binary swap must never leave
// the path missing (sh) and must never try to overwrite a running .exe
// (ps1/cmd, where Windows refuses; renaming a running exe is allowed).
describe("binary replacement is safe while plannotator is running", () => {
  test("install.sh stages next to the target and renames over it, with no rm first", () => {
    const script = readScript("install.sh");
    const stage = script.indexOf('staged_file="$INSTALL_DIR/.plannotator.new.$$"');
    const swap = script.indexOf('mv -f "$staged_file" "$INSTALL_DIR/plannotator"');
    expect(stage).toBeGreaterThan(0);
    expect(swap).toBeGreaterThan(stage);
    expect(script).not.toContain('rm -f "$INSTALL_DIR/plannotator" "$INSTALL_DIR/plannotator.exe"');
  });

  test("install.ps1 renames the running exe aside before moving the new one in", () => {
    const script = readScript("install.ps1");
    const aside = script.indexOf("Move-Item -Force $targetExe $asideExe -ErrorAction Stop");
    const place = script.indexOf('Move-Item -Force $tmpFile "$installDir\\plannotator.exe"');
    expect(aside).toBeGreaterThan(0);
    expect(place).toBeGreaterThan(aside);
  });

  test("install.cmd renames the running exe aside before moving the new one in", () => {
    const script = readScript("install.cmd");
    const aside = script.indexOf('move /y "!INSTALL_PATH!" "!INSTALL_PATH!.old"');
    const place = script.indexOf('move /y "!TEMP_FILE!" "!INSTALL_PATH!"');
    expect(aside).toBeGreaterThan(0);
    expect(place).toBeGreaterThan(aside);
  });
});

describe("latest tag is parsed by key, not by line (#1655)", () => {
  // GitHub can serve releases/latest compact on a single line. The old
  // `grep '"tag_name"' | cut -d'"' -f4` then returned the first quoted value
  // on that line ("url"), so installs tried to download from the API URL.
  const script = readScript("install.sh");
  const parseLine = script
    .split("\n")
    .find((line) => line.includes('latest_tag=$(printf') && line.includes("tag_name"));

  const release = {
    url: "https://api.github.com/repos/backnotprop/plannotator/releases/400625228",
    html_url: "https://github.com/backnotprop/plannotator/releases/tag/v0.27.24",
    id: 400625228,
    tag_name: "v0.27.24",
    body: 'Notes mention \\"tag_name\\": \\"v9.9.9\\" in text',
  };

  function runParse(apiBody: string): string {
    const fnStart = script.indexOf("is_release_tag() {");
    const fn = script.slice(fnStart, script.indexOf("\n}\n", fnStart) + 3);
    const cmd = `${fn}\n_api_body="$1"\n${parseLine!.trim()}\nis_release_tag "$latest_tag" || latest_tag=""\nprintf '%s' "$latest_tag"`;
    const proc = Bun.spawnSync(["bash", "-c", cmd, "bash", apiBody]);
    return proc.stdout.toString();
  }

  test("the parse line exists in install.sh", () => {
    expect(parseLine).toBeDefined();
    expect(script).not.toContain(`grep '"tag_name"' | cut -d'"' -f4`);
  });

  test("pretty-printed response", () => {
    expect(runParse(JSON.stringify(release, null, 2) + "\n200")).toBe("v0.27.24");
  });

  test("compact single-line response", () => {
    expect(runParse(JSON.stringify(release) + "\n200")).toBe("v0.27.24");
  });

  test("a response without a valid tag yields nothing", () => {
    expect(runParse(JSON.stringify({ url: release.url }) + "\n200")).toBe("");
    expect(runParse(JSON.stringify({ tag_name: "latest" }) + "\n200")).toBe("");
  });

  test("install.cmd parses the JSON with PowerShell, not findstr", () => {
    const cmdScript = readScript("install.cmd");
    expect(cmdScript).toContain("ConvertFrom-Json).tag_name");
    expect(cmdScript).not.toContain('findstr /c:"\\"tag_name\\""');
  });
});

// ---------------------------------------------------------------------------
// Claude Code marketplace clone: the installers never write it, and repair a
// hooks.json an earlier installer rewrote.
//
// <claude config>/plugins/marketplaces/plannotator is Claude Code's own git
// clone of this repo; installing or updating the plugin copies apps/hook from
// it. Installers used to overwrite its apps/hook/hooks/hooks.json with a
// hard-coded copy that had no "modules" key, so a plugin installed from that
// clone lost the Claude Code mod. These tests pin both halves: the clone is
// left byte-for-byte alone, and a clone still carrying an old rewrite is
// restored to its HEAD, while a user's own edit is never discarded.
// ---------------------------------------------------------------------------

const REPO_HOOKS_JSON = readFileSync(
  join(scriptsDir, "..", "apps", "hook", "hooks", "hooks.json"),
  "utf-8",
);

// Every hooks.json shape an earlier installer wrote, rebuilt from the old
// writers: install.sh (#230 PermissionRequest only, #689 + EnterPlanMode),
// install.ps1 / install.cmd (#230 bare command, #267 unquoted exe path,
// 47bdd210 quoted exe path; CRLF line endings).
function legacyPluginHooks(opts: {
  command: string;
  improveContext: boolean;
  eol?: string;
}): string {
  const hook = (command: string, timeout: number) => [
    "        \"hooks\": [",
    "          {",
    "            \"type\": \"command\",",
    `            "command": "${command}",`,
    `            "timeout": ${timeout}`,
    "          }",
    "        ]",
  ];
  const lines = ["{", "  \"hooks\": {"];
  if (opts.improveContext) {
    lines.push(
      "    \"PreToolUse\": [",
      "      {",
      "        \"matcher\": \"EnterPlanMode\",",
      ...hook(`${opts.command} improve-context`, 5),
      "      }",
      "    ],",
    );
  }
  lines.push(
    "    \"PermissionRequest\": [",
    "      {",
    "        \"matcher\": \"ExitPlanMode\",",
    ...hook(opts.command, 345600),
    "      }",
    "    ]",
    "  }",
    "}",
  );
  const eol = opts.eol ?? "\n";
  return lines.join(eol) + eol;
}

const WIN_EXE = "C:/Users/John Smith/AppData/Local/plannotator/plannotator.exe";
const LEGACY_REWRITES: Record<string, string> = {
  "install.sh #230": legacyPluginHooks({ command: "plannotator", improveContext: false }),
  "install.sh #689": legacyPluginHooks({ command: "plannotator", improveContext: true }),
  "install.cmd #230": legacyPluginHooks({ command: "plannotator", improveContext: false, eol: "\r\n" }),
  "install.ps1 #267": legacyPluginHooks({ command: WIN_EXE, improveContext: false, eol: "\r\n" }),
  "install.ps1 #689": legacyPluginHooks({ command: WIN_EXE, improveContext: true, eol: "\r\n" }),
  "install.ps1 quoted": legacyPluginHooks({ command: `\\"${WIN_EXE}\\"`, improveContext: true, eol: "\r\n" }),
};

// Shapes that are NOT an installer's rewrite and must never be discarded.
const NOT_LEGACY: Record<string, string> = {
  "the repo's hooks.json": REPO_HOOKS_JSON,
  "a user's changed timeout": legacyPluginHooks({ command: "plannotator", improveContext: true }).replace("345600", "60"),
  "a user's extra key": legacyPluginHooks({ command: "plannotator", improveContext: true }).replace(
    "{\n  \"hooks\"",
    "{\n  \"modules\": [\"./mine.ts\"],\n  \"hooks\"",
  ),
  "a user's other command": legacyPluginHooks({ command: "my-review-tool", improveContext: false }),
};

function compactHooks(text: string): string {
  return text.replace(/[\s\uFEFF]/g, "");
}

describe("legacy plugin hooks.json pattern (all three installers)", () => {
  const shRe = /^LEGACY_PLUGIN_HOOKS_RE='(.*)'$/m.exec(readScript("install.sh"))?.[1];
  const ps1Re = /^\$legacyPluginHooksRe = '(.*)'$/m.exec(readScript("install.ps1"))?.[1];
  const cmdRe = /^set "PLN_HOOKS_RE=(.*)"$/m.exec(readScript("install.cmd"))?.[1];

  test("install.ps1 and install.cmd carry the identical .NET pattern", () => {
    expect(ps1Re).toBeTruthy();
    expect(cmdRe).toBe(ps1Re!);
    // cmd.exe would parse these: keep them out of the pattern. (A caret is
    // literal inside the quoted set as long as the line has no "!".)
    expect(cmdRe!).not.toMatch(/["|!%&<>]/);
  });

  // ERE (install.sh) is JS-compatible as written; the .NET form only needs
  // its \A / \z anchors spelled for JS.
  const patterns = () => ({
    "install.sh": new RegExp(shRe!),
    "install.ps1/cmd": new RegExp(ps1Re!.replace(/^\\A/, "^").replace(/\\z$/, "$")),
  });

  for (const [name, text] of Object.entries(LEGACY_REWRITES)) {
    test(`recognizes the ${name} rewrite`, () => {
      for (const [script, re] of Object.entries(patterns())) {
        expect({ script, match: re.test(compactHooks(text)) }).toEqual({ script, match: true });
      }
    });
  }

  for (const [name, text] of Object.entries(NOT_LEGACY)) {
    test(`does not recognize ${name}`, () => {
      for (const [script, re] of Object.entries(patterns())) {
        expect({ script, match: re.test(compactHooks(text)) }).toEqual({ script, match: false });
      }
    });
  }
});

function makeMarketplaceClone(home: string, configDir = join(home, ".claude")): string {
  const clone = join(configDir, "plugins", "marketplaces", "plannotator");
  mkdirSync(join(clone, "apps", "hook", "hooks"), { recursive: true });
  writeFileSync(join(clone, "apps", "hook", "hooks", "hooks.json"), REPO_HOOKS_JSON);
  writeFileSync(join(clone, "README.md"), "plannotator\n");
  const gitEnv = { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const run = (args: string[]) => {
    const r = Bun.spawnSync([Bun.which("git")!, "-C", clone, ...args], { env: gitEnv });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
  };
  run(["init", "-q", "-b", "main"]);
  run(["add", "-A"]);
  run(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "fixture"]);
  return clone;
}

function cloneStatus(home: string, clone: string): string {
  const r = Bun.spawnSync([Bun.which("git")!, "-C", clone, "status", "--porcelain"], {
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  return r.stdout.toString();
}

const SANDBOX_INSTALL_ARGS = [
  "--version", "v99.9.9", "--non-interactive", "--no-extras", "--skip-skills",
];

describe.skipIf(process.platform === "win32" || !Bun.which("node") || !Bun.which("git"))(
  "install.sh leaves the Claude Code marketplace clone alone (stubbed PATH, sandbox HOME)",
  () => {
    test("a clean clone is untouched, so the plugin keeps its mod", () => {
      const sandbox = setupInstallSandbox({ gh: "pass-all", git: "real-no-clone" });
      const clone = makeMarketplaceClone(sandbox.home);
      const hooks = join(clone, "apps", "hook", "hooks", "hooks.json");
      const { code, out } = runInstallSh(sandbox, SANDBOX_INSTALL_ARGS);
      expect(code).toBe(0);
      expect(readFileSync(hooks, "utf-8")).toBe(REPO_HOOKS_JSON);
      expect(JSON.parse(readFileSync(hooks, "utf-8")).modules).toEqual(["./mod/register.ts"]);
      expect(cloneStatus(sandbox.home, clone)).toBe("");
      expect(out).not.toContain("Restored ");
    });

    test("a clone carrying an earlier installer's rewrite is restored to HEAD (CLAUDE_CONFIG_DIR)", () => {
      const sandbox = setupInstallSandbox({ gh: "pass-all", git: "real-no-clone" });
      const configDir = join(sandbox.home, "claude-config");
      const clone = makeMarketplaceClone(sandbox.home, configDir);
      const hooks = join(clone, "apps", "hook", "hooks", "hooks.json");
      writeFileSync(hooks, LEGACY_REWRITES["install.sh #689"]!);
      expect(cloneStatus(sandbox.home, clone)).not.toBe("");
      const { code, out } = runInstallSh(sandbox, SANDBOX_INSTALL_ARGS, {
        CLAUDE_CONFIG_DIR: configDir,
      });
      expect(code).toBe(0);
      expect(out).toContain(`Restored ${hooks} from its git checkout`);
      expect(readFileSync(hooks, "utf-8")).toBe(REPO_HOOKS_JSON);
      expect(cloneStatus(sandbox.home, clone)).toBe("");
    });

    test("a user's own edit to the clone is never discarded", () => {
      const sandbox = setupInstallSandbox({ gh: "pass-all", git: "real-no-clone" });
      const clone = makeMarketplaceClone(sandbox.home);
      const hooks = join(clone, "apps", "hook", "hooks", "hooks.json");
      const edited = NOT_LEGACY["a user's changed timeout"]!;
      writeFileSync(hooks, edited);
      const { code, out } = runInstallSh(sandbox, SANDBOX_INSTALL_ARGS);
      expect(code).toBe(0);
      expect(readFileSync(hooks, "utf-8")).toBe(edited);
      expect(out).not.toContain("Restored ");
    });

    test("without a usable git the rewrite is left as is and the install still succeeds", () => {
      const sandbox = setupInstallSandbox({ gh: "pass-all", git: "real-no-clone" });
      const clone = makeMarketplaceClone(sandbox.home);
      const hooks = join(clone, "apps", "hook", "hooks", "hooks.json");
      writeFileSync(hooks, LEGACY_REWRITES["install.sh #689"]!);
      writeFileSync(join(sandbox.stub, "git"), gitShimBody("fail"), { mode: 0o755 });
      const { code } = runInstallSh(sandbox, SANDBOX_INSTALL_ARGS);
      expect(code).toBe(0);
      expect(readFileSync(hooks, "utf-8")).toBe(LEGACY_REWRITES["install.sh #689"]!);
    });
  },
);

// ---------------------------------------------------------------------------
// OpenCode plugin cache. OpenCode 2 caches npm plugins at
// <cache>/opencode/npm/<name>@<spec>/<generation>/ (packages/util/src/npm.ts
// in OpenCode 2.0.22), so @plannotator/opencode@latest is the nested
// npm/@plannotator/opencode@latest. OpenCode 1 used node_modules/ and
// packages/. Both root <cache> at ${XDG_CACHE_HOME:-~/.cache}.
// ---------------------------------------------------------------------------

function seedOpenCodeCache(cacheRoot: string) {
  const oc = join(cacheRoot, "opencode");
  const paths = {
    oc1Plugin: join(oc, "node_modules", "@plannotator", "opencode", "package.json"),
    oc2Latest: join(oc, "npm", "@plannotator", "opencode@latest", "1790000000000", "node_modules", "@plannotator", "opencode", "package.json"),
    oc2Pinned: join(oc, "npm", "@plannotator", "opencode@0.27.25", "1790000000000", "package.json"),
    oc2Sibling: join(oc, "npm", "@plannotator", "pi-extension@latest", "1790000000000", "package.json"),
    oc2Unrelated: join(oc, "npm", "some-plugin@latest", "1790000000000", "package.json"),
  };
  for (const p of Object.values(paths)) {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "{}\n");
  }
  return paths;
}

describe.skipIf(process.platform === "win32" || !Bun.which("node"))(
  "install.sh clears the OpenCode plugin cache (stubbed PATH, sandbox HOME)",
  () => {
    test("removes OpenCode 1 and OpenCode 2 entries for our plugin and nothing else", () => {
      const sandbox = setupInstallSandbox({ gh: "pass-all" });
      const cache = seedOpenCodeCache(join(sandbox.home, ".cache"));
      const { code } = runInstallSh(sandbox, SANDBOX_INSTALL_ARGS);
      expect(code).toBe(0);
      const npmScope = join(sandbox.home, ".cache", "opencode", "npm", "@plannotator");
      expect(existsSync(cache.oc1Plugin)).toBe(false);
      expect(existsSync(join(npmScope, "opencode@latest"))).toBe(false);
      expect(existsSync(join(npmScope, "opencode@0.27.25"))).toBe(false);
      expect(existsSync(cache.oc2Sibling)).toBe(true);
      expect(existsSync(cache.oc2Unrelated)).toBe(true);
    });

    test("honors XDG_CACHE_HOME and drops the scope directory once it is empty", () => {
      const sandbox = setupInstallSandbox({ gh: "pass-all" });
      const xdg = join(sandbox.home, "xdg-cache");
      const scope = join(xdg, "opencode", "npm", "@plannotator");
      const latest = join(scope, "opencode@latest", "1790000000000", "package.json");
      mkdirSync(join(latest, ".."), { recursive: true });
      writeFileSync(latest, "{}\n");
      const unrelated = join(xdg, "opencode", "npm", "some-plugin@latest", "package.json");
      mkdirSync(join(unrelated, ".."), { recursive: true });
      writeFileSync(unrelated, "{}\n");
      const { code } = runInstallSh(sandbox, SANDBOX_INSTALL_ARGS, { XDG_CACHE_HOME: xdg });
      expect(code).toBe(0);
      expect(existsSync(scope)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
    });

    test("--skip-opencode leaves OpenCode's cache alone", () => {
      const sandbox = setupInstallSandbox({ gh: "pass-all" });
      const cache = seedOpenCodeCache(join(sandbox.home, ".cache"));
      const { code } = runInstallSh(sandbox, [...SANDBOX_INSTALL_ARGS, "--skip-opencode"]);
      expect(code).toBe(0);
      for (const p of Object.values(cache)) expect(existsSync(p)).toBe(true);
    });
  },
);

describe("Windows installers clear the OpenCode 2 plugin cache (source scan)", () => {
  test("install.ps1 roots the cache at XDG_CACHE_HOME and removes only opencode@* under npm\\@plannotator", () => {
    const script = readScript("install.ps1");
    expect(script).toContain(
      '$opencodeCacheDir = if ($env:XDG_CACHE_HOME) { "$env:XDG_CACHE_HOME\\opencode" } else { "$env:USERPROFILE\\.cache\\opencode" }',
    );
    // Join-Path throws under ErrorActionPreference=Stop when the drive is not mapped;
    // a string cannot, so an unusual XDG_CACHE_HOME never aborts the install.
    expect(script).not.toContain(
      'Join-Path $env:XDG_CACHE_HOME',
    );
    expect(script).toContain('$opencodeNpmScope = "$opencodeCacheDir\\npm\\@plannotator"');
    expect(script).toContain("Where-Object { $_.Name -like 'opencode@*' }");
    expect(script).not.toContain('"$env:USERPROFILE\\.cache\\opencode\\node_modules\\@plannotator"');
  });

  test("install.cmd roots the cache at XDG_CACHE_HOME and removes only opencode@* under npm\\@plannotator", () => {
    const script = readScript("install.cmd");
    expect(script).toContain('set "OPENCODE_CACHE_DIR=%XDG_CACHE_HOME%\\opencode"');
    expect(script).toContain(
      'for /d %%D in ("!OPENCODE_CACHE_DIR!\\npm\\@plannotator\\opencode@*") do rmdir /s /q "%%~fD" >nul 2>&1',
    );
    expect(script).not.toContain('"%USERPROFILE%\\.cache\\opencode\\node_modules\\@plannotator"');
  });
});

// ---------------------------------------------------------------------------
// Claude Code plugin update. The plugin comes from a GitHub marketplace, which
// Claude Code does not auto-update, so every installer runs
// `claude plugin marketplace update plannotator` and
// `claude plugin update plannotator@plannotator --scope user` when (and only when) the
// claude CLI is on PATH and the plugin is already installed at user scope.
// Every run uses a FAKE `claude` that logs its argv; nothing reaches the real
// CLI, ~/.claude or the network.
// ---------------------------------------------------------------------------

const CLAUDE_PLUGIN_COMMANDS = [
  "plugin marketplace update plannotator",
  "plugin update plannotator@plannotator --scope user",
];

/** A v2 installed_plugins.json, as Claude Code writes it. */
function claudePluginRegistry(
  records: Array<{ scope?: string; version: string; sha?: string }>,
  id = "plannotator@plannotator",
): string {
  return JSON.stringify(
    {
      version: 2,
      plugins: {
        "other@elsewhere": [{ scope: "user", installPath: "/x/other", version: "9.9.9" }],
        [id]: records.map((r) => ({
          ...(r.scope ? { scope: r.scope } : {}),
          installPath: `/x/cache/plannotator/plannotator/${r.version}`,
          version: r.version,
          installedAt: "2026-09-01T00:00:00.000Z",
          lastUpdated: "2026-09-01T00:00:00.000Z",
          gitCommitSha: r.sha ?? "aaaaaaa",
        })),
      },
    },
    null,
    2,
  );
}

// The fake logs one line per call; on `plugin marketplace update` it also notes
// whether the marketplace clone's hooks.json already carries the mod (proves
// the update runs after the repair). `plugin update` rewrites the registry to
// FAKE_CLAUDE_NEW_VERSION when that is set, as the real command records the
// new install. FAKE_CLAUDE_FAIL=<marketplace|plugin> fails that step;
// FAKE_CLAUDE_HANG=1 never returns.
const FAKE_CLAUDE = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_CLAUDE_LOG"
if [ -n "$CLAUDECODE" ]; then echo "CLAUDECODE was set" >> "$FAKE_CLAUDE_LOG"; fi
if [ "$FAKE_CLAUDE_HANG" = "1" ]; then exec sleep 30; fi
step=""
[ "$1 $2 $3" = "plugin marketplace update" ] && step="marketplace"
[ "$1 $2" = "plugin update" ] && step="plugin"
if [ -n "$FAKE_CLAUDE_FAIL" ] && [ "$FAKE_CLAUDE_FAIL" = "$step" ]; then
  echo "Updating marketplace..."
  echo "\${FAKE_CLAUDE_FAIL_MESSAGE:-Error: failed to reach github.com}" >&2
  exit 3
fi
if [ "$step" = "marketplace" ] && [ -n "$FAKE_CLAUDE_HOOKS" ]; then
  if grep -q '"modules"' "$FAKE_CLAUDE_HOOKS" 2>/dev/null; then
    echo "hooks-at-marketplace-update: repaired" >> "$FAKE_CLAUDE_LOG"
  else
    echo "hooks-at-marketplace-update: legacy" >> "$FAKE_CLAUDE_LOG"
  fi
fi
if [ "$step" = "plugin" ] && [ -n "$FAKE_CLAUDE_NEW_VERSION" ]; then
  sed "s/0\\.28\\.7/$FAKE_CLAUDE_NEW_VERSION/g; s/aaaaaaa/bbbbbbb/g" "$FAKE_CLAUDE_REGISTRY" > "$FAKE_CLAUDE_REGISTRY.new"
  mv "$FAKE_CLAUDE_REGISTRY.new" "$FAKE_CLAUDE_REGISTRY"
fi
exit 0
`;

function setupClaudePluginSandbox(opts: {
  registry?: string | null;
  claude?: boolean;
  configDir?: boolean;
  git?: GitBehavior;
  plannotatorConfig?: string;
}) {
  const sandbox = setupInstallSandbox({
    gh: "pass-all",
    git: opts.git,
    plannotatorConfig: opts.plannotatorConfig,
  });
  const configDir = opts.configDir ? join(sandbox.home, "claude-config") : join(sandbox.home, ".claude");
  const registryPath = join(configDir, "plugins", "installed_plugins.json");
  if (opts.registry !== null) {
    mkdirSync(join(configDir, "plugins"), { recursive: true });
    writeFileSync(registryPath, opts.registry ?? claudePluginRegistry([{ scope: "user", version: "0.28.7" }]));
  }
  if (opts.claude !== false) writeFileSync(join(sandbox.stub, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  const log = join(sandbox.home, "claude-calls.log");
  const env: Record<string, string> = {
    // As in an auto-update started from a Claude Code session; the installers
    // clear it for the claude commands (the fake logs it if it leaks through).
    CLAUDECODE: "1",
    FAKE_CLAUDE_LOG: log,
    FAKE_CLAUDE_REGISTRY: registryPath,
    ...(opts.configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : []);
  return { sandbox, configDir, registryPath, env, calls };
}

// No --version: the latest-release path, which the stub curl serves. A
// --version pin skips the plugin update (see the pinned tests).
const PLUGIN_INSTALL_ARGS = ["--non-interactive", "--no-extras", "--skip-skills"];
const MISSING_MARKETPLACE =
  "Error: Marketplace 'plannotator' not found. Available marketplaces: claude-plugins-official";
const MANUAL_PLUGIN_COMMANDS =
  "  claude plugin marketplace update plannotator\n  claude plugin update plannotator@plannotator --scope user\n";
const READD_PLUGIN_COMMANDS =
  "  claude plugin marketplace add backnotprop/plannotator\n  claude plugin update plannotator@plannotator --scope user\n";

describe.skipIf(process.platform === "win32" || !Bun.which("node"))(
  "install.sh updates an installed Claude Code plugin (fake claude, sandbox HOME)",
  () => {
    test("installed: both update commands run, in order, and the new version is reported", () => {
      const s = setupClaudePluginSandbox({});
      const { code, out } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, {
        ...s.env,
        FAKE_CLAUDE_NEW_VERSION: "0.28.11",
      });
      expect(code).toBe(0);
      expect(s.calls()).toEqual(CLAUDE_PLUGIN_COMMANDS);
      expect(out).toContain(
        "Updating the Claude Code plugin...\nClaude Code plugin: updated to 0.28.11 (restart Claude Code to load it).\n",
      );
      expect(out).toContain("The Claude Code plugin was updated to 0.28.11. Restart Claude Code to load it.");
      // An installed plugin needs neither install instructions nor manual commands.
      expect(out).not.toContain("/plugin marketplace add backnotprop/plannotator");
      expect(out).not.toContain(MANUAL_PLUGIN_COMMANDS);
    });

    test("installed and already current: says so, with the version", () => {
      const s = setupClaudePluginSandbox({});
      const { code, out } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, s.env);
      expect(code).toBe(0);
      expect(s.calls()).toEqual(CLAUDE_PLUGIN_COMMANDS);
      expect(out).toContain("Claude Code plugin: already up to date (0.28.7).");
      expect(out).toContain("The Claude Code plugin is up to date (0.28.7).");
    });

    test("runs after the legacy hooks.json repair, against CLAUDE_CONFIG_DIR", () => {
      const s = setupClaudePluginSandbox({ configDir: true, git: "real-no-clone" });
      const clone = makeMarketplaceClone(s.sandbox.home, s.configDir);
      const hooks = join(clone, "apps", "hook", "hooks", "hooks.json");
      writeFileSync(hooks, LEGACY_REWRITES["install.sh #689"]!);
      const { code, out } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, {
        ...s.env,
        FAKE_CLAUDE_HOOKS: hooks,
        FAKE_CLAUDE_NEW_VERSION: "0.28.11",
      });
      expect(code).toBe(0);
      expect(s.calls()).toEqual([
        CLAUDE_PLUGIN_COMMANDS[0],
        "hooks-at-marketplace-update: repaired",
        CLAUDE_PLUGIN_COMMANDS[1],
      ]);
      expect(out.indexOf("Restored ")).toBeGreaterThan(-1);
      expect(out.indexOf("Restored ")).toBeLessThan(out.indexOf("Updating the Claude Code plugin..."));
    });

    test("a v1 registry record (no scope) counts as the user install", () => {
      const s = setupClaudePluginSandbox({
        registry: JSON.stringify({
          version: 1,
          plugins: { "plannotator@plannotator": { version: "0.28.7", installPath: "/x/p", gitCommitSha: "aaaaaaa" } },
        }),
      });
      const { code } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, s.env);
      expect(code).toBe(0);
      expect(s.calls()).toEqual(CLAUDE_PLUGIN_COMMANDS);
    });

    const notInstalled: Array<[string, string | null]> = [
      ["no registry", null],
      ["a registry without the plugin", claudePluginRegistry([{ scope: "user", version: "1.0.0" }], "something@else")],
      ["only a project-scope install", claudePluginRegistry([{ scope: "project", version: "0.28.7" }])],
      ["an empty install list", JSON.stringify({ version: 2, plugins: { "plannotator@plannotator": [] } })],
    ];
    for (const [name, registry] of notInstalled) {
      test(`not installed (${name}): no claude command runs, install instructions stay`, () => {
        const s = setupClaudePluginSandbox({ registry });
        const { code, out } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, s.env);
        expect(code).toBe(0);
        expect(s.calls()).toEqual([]);
        expect(out).not.toMatch(/^Claude Code plugin:/m);
        expect(out).toContain("/plugin marketplace add backnotprop/plannotator");
        expect(out).toContain(
          `Updating the plugin? Run these in a terminal, then restart Claude Code:\n${MANUAL_PLUGIN_COMMANDS}`,
        );
      });
    }

    const optOuts: Array<[string, string[], Record<string, string>, string | undefined, string]> = [
      ["the flag", ["--skip-claude-plugin"], {}, undefined, "--skip-claude-plugin"],
      ["the env var", [], { PLANNOTATOR_SKIP_CLAUDE_PLUGIN_UPDATE: "1" }, undefined, "PLANNOTATOR_SKIP_CLAUDE_PLUGIN_UPDATE"],
      ["the config key", [], {}, '{"skipInstall":{"claudePlugin":true}}\n', "config skipInstall.claudePlugin"],
      ["the flag over env 0", ["--skip-claude-plugin"], { PLANNOTATOR_SKIP_CLAUDE_PLUGIN_UPDATE: "0" }, undefined, "--skip-claude-plugin"],
    ];
    for (const [name, args, env, config, source] of optOuts) {
      test(`opted out by ${name}: nothing runs, the manual commands are printed`, () => {
        const s = setupClaudePluginSandbox({ plannotatorConfig: config });
        const { code, out } = runInstallSh(s.sandbox, [...PLUGIN_INSTALL_ARGS, ...args], { ...s.env, ...env });
        expect(code).toBe(0);
        expect(s.calls()).toEqual([]);
        expect(out).toContain(`Claude Code plugin: not updated (${source}).`);
        expect(out).toContain(
          `Update the Claude Code plugin: run these in a terminal, then restart Claude Code:\n${MANUAL_PLUGIN_COMMANDS}`,
        );
      });
    }

    test("env var 0 overrides a config opt-out", () => {
      const s = setupClaudePluginSandbox({ plannotatorConfig: '{"skipInstall":{"claudePlugin":true}}\n' });
      const { code } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, {
        ...s.env,
        PLANNOTATOR_SKIP_CLAUDE_PLUGIN_UPDATE: "0",
      });
      expect(code).toBe(0);
      expect(s.calls()).toEqual(CLAUDE_PLUGIN_COMMANDS);
    });

    test("--minimal runs no claude command and says nothing about the plugin", () => {
      const s = setupClaudePluginSandbox({});
      const { code, out } = runInstallSh(s.sandbox, [...PLUGIN_INSTALL_ARGS, "--minimal"], s.env);
      expect(code).toBe(0);
      expect(s.calls()).toEqual([]);
      expect(out).not.toContain("Claude Code plugin");
    });

    test("a failing marketplace update stops there, keeps the install green and prints the manual commands", () => {
      const s = setupClaudePluginSandbox({});
      const { code, out } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, {
        ...s.env,
        FAKE_CLAUDE_FAIL: "marketplace",
      });
      expect(code).toBe(0);
      expect(s.calls()).toEqual([CLAUDE_PLUGIN_COMMANDS[0]]);
      expect(out).toContain(
        `Claude Code plugin: could not update it (claude exited 3: Error: failed to reach github.com). Run these, then restart Claude Code:\n${MANUAL_PLUGIN_COMMANDS}`,
      );
      expect(out).toContain("Update the Claude Code plugin: run these in a terminal, then restart Claude Code:");
    });

    test("a failing plugin update is reported the same way", () => {
      const s = setupClaudePluginSandbox({});
      const { code, out } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, { ...s.env, FAKE_CLAUDE_FAIL: "plugin" });
      expect(code).toBe(0);
      expect(s.calls()).toEqual(CLAUDE_PLUGIN_COMMANDS);
      expect(out).toContain(
        "Claude Code plugin: could not update it (claude exited 3: Error: failed to reach github.com).",
      );
    });

    test("a hanging claude is stopped at the time limit and the install still succeeds", () => {
      const s = setupClaudePluginSandbox({});
      const started = Date.now();
      const { code, out } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, {
        ...s.env,
        FAKE_CLAUDE_HANG: "1",
        PLANNOTATOR_CLAUDE_PLUGIN_TIMEOUT: "1",
      });
      expect(code).toBe(0);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(s.calls()).toEqual([CLAUDE_PLUGIN_COMMANDS[0]]);
      expect(out).toContain(
        "Claude Code plugin: could not update it (timed out after 1s). Run these, then restart Claude Code:",
      );
    }, 30_000);

    test("no claude on PATH: nothing runs, the banner keeps the manual commands", () => {
      const s = setupClaudePluginSandbox({ claude: false });
      const { code, out } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, s.env);
      expect(code).toBe(0);
      expect(s.calls()).toEqual([]);
      expect(out).not.toContain("Updating the Claude Code plugin");
      expect(out).not.toMatch(/^Claude Code plugin:/m);
      expect(out).toContain(
        `Update the Claude Code plugin: run these in a terminal, then restart Claude Code:\n${MANUAL_PLUGIN_COMMANDS}`,
      );
    });

    test("--skip-claude-plugin is remembered in install-flags.json", () => {
      const s = setupClaudePluginSandbox({});
      const { code } = runInstallSh(s.sandbox, [...PLUGIN_INSTALL_ARGS, "--skip-claude-plugin"], s.env);
      expect(code).toBe(0);
      expect(
        JSON.parse(readFileSync(join(s.sandbox.home, ".plannotator", "install-flags.json"), "utf-8")),
      ).toEqual({ v: 1, flags: ["skip-skills", "skip-claude-plugin"] });
    });

    test("a --version pin skips the update: a pinned binary keeps the plugin it has", () => {
      const s = setupClaudePluginSandbox({});
      const { code, out } = runInstallSh(s.sandbox, [...PLUGIN_INSTALL_ARGS, "--version", "v0.27.0"], s.env);
      expect(code).toBe(0);
      expect(s.calls()).toEqual([]);
      expect(out).toContain(
        "Claude Code plugin: not updated: pinned to v0.27.0; updating would install the newest plugin.\n",
      );
      expect(out).toContain(
        `Update the Claude Code plugin: run these in a terminal, then restart Claude Code:\n${MANUAL_PLUGIN_COMMANDS}`,
      );
    });

    test("auto-update's --version (the newest release, exported as PLANNOTATOR_UPDATE_VERSION) is not a pin", () => {
      const s = setupClaudePluginSandbox({});
      const { code } = runInstallSh(s.sandbox, [...PLUGIN_INSTALL_ARGS, "--version", "v99.9.9"], {
        ...s.env,
        PLANNOTATOR_UPDATE_VERSION: "v99.9.9",
      });
      expect(code).toBe(0);
      expect(s.calls()).toEqual(CLAUDE_PLUGIN_COMMANDS);
    });

    test("a missing plannotator marketplace prints the re-add command instead", () => {
      const s = setupClaudePluginSandbox({});
      const { code, out } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, {
        ...s.env,
        FAKE_CLAUDE_FAIL: "marketplace",
        FAKE_CLAUDE_FAIL_MESSAGE: MISSING_MARKETPLACE,
      });
      expect(code).toBe(0);
      expect(s.calls()).toEqual([CLAUDE_PLUGIN_COMMANDS[0]]);
      expect(out).toContain(
        `Claude Code plugin: could not update it (the plannotator marketplace is not registered). Re-add it, then restart Claude Code:\n${READD_PLUGIN_COMMANDS}`,
      );
      expect(out).toContain(
        `Re-add the Claude Code plugin's marketplace: run these in a terminal, then restart Claude Code:\n${READD_PLUGIN_COMMANDS}`,
      );
      expect(out).not.toContain(MANUAL_PLUGIN_COMMANDS);
    });

    test("its temporary files live in a private mktemp directory that is removed afterwards", () => {
      const s = setupClaudePluginSandbox({});
      const tmp = join(s.sandbox.home, "tmp");
      const { code } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, {
        ...s.env,
        FAKE_CLAUDE_HANG: "1",
        PLANNOTATOR_CLAUDE_PLUGIN_TIMEOUT: "1",
      });
      expect(code).toBe(0);
      expect(readdirSync(tmp).filter((n) => n.includes("claude-plugin") || n.includes("time-limit"))).toEqual([]);
    }, 30_000);

    test("no temporary directory: nothing runs, the manual commands are printed", () => {
      const s = setupClaudePluginSandbox({});
      // mktemp fails only for the plugin update's directory.
      writeFileSync(
        join(s.sandbox.stub, "mktemp"),
        `#!/bin/bash\ncase "$*" in *claude-plugin*) exit 1 ;; esac\nexec /usr/bin/mktemp "$@"\n`,
        { mode: 0o755 },
      );
      const { code, out } = runInstallSh(s.sandbox, PLUGIN_INSTALL_ARGS, s.env);
      expect(code).toBe(0);
      expect(s.calls()).toEqual([]);
      expect(out).toContain(
        `Claude Code plugin: could not update it (no temporary directory). Run these, then restart Claude Code:\n${MANUAL_PLUGIN_COMMANDS}`,
      );
    });
  },
);

describe("Claude Code plugin update: every installer (source scan)", () => {
  test("each installer takes the opt-out flag, env var and config key", () => {
    const sh = readScript("install.sh");
    const ps = readScript("install.ps1");
    const cmd = readScript("install.cmd");
    expect(sh).toContain("        --skip-claude-plugin)");
    expect(sh).toContain('case "${PLANNOTATOR_SKIP_CLAUDE_PLUGIN_UPDATE:-}" in');
    expect(sh).toContain("for _agent in codex gemini kiro vibe opencode qwen skills claudePlugin; do");
    expect(ps).toContain("[switch]$SkipClaudePlugin");
    expect(ps).toContain("$env:PLANNOTATOR_SKIP_CLAUDE_PLUGIN_UPDATE -match");
    expect(ps).toContain("$cfg.skipInstall.claudePlugin -is [bool]");
    expect(cmd).toContain('if /i "%~1"=="--skip-claude-plugin" (');
    expect(cmd).toContain('if /i "!PLANNOTATOR_SKIP_CLAUDE_PLUGIN_UPDATE!"=="%%V"');
    expect(cmd).toContain("'skills','claudePlugin'");
  });

  test("each installer runs the update after the legacy hooks.json repair", () => {
    const pairs: Array<[string, string, string]> = [
      ["install.sh", 'repair_legacy_plugin_hooks "$PLUGIN_MARKETPLACE_DIR" || true', "update_claude_plugin_if_installed || true"],
      ["install.ps1", "try { Repair-LegacyPluginHooks -Clone $pluginMarketplaceDir } catch { }", "try { Update-ClaudePluginIfInstalled } catch { }"],
      ["install.cmd", 'if exist "!PLUGIN_HOOKS!" call :RepairLegacyPluginHooks', "\ncall :UpdateClaudePlugin\n"],
    ];
    for (const [name, repair, update] of pairs) {
      const script = readScript(name);
      const r = script.indexOf(repair);
      const u = script.indexOf(update);
      expect({ name, repair: r > 0, update: u > r }).toEqual({ name, repair: true, update: true });
    }
  });

  test("every installer updates, and tells people to update, the user scope", () => {
    // `claude plugin update` auto-detects the scope on current Claude Code: from
    // inside a project with a project-scope install it would update that one.
    for (const name of ["install.sh", "install.ps1", "install.cmd"]) {
      const script = readScript(name);
      const bare = script.split("\n").filter((l) => /plugin update (plannotator@plannotator|\$\{CLAUDE_PLUGIN_ID\}|\$claudePluginId|' \+ \$id)/.test(l) && !l.includes("--scope user") && !/'--scope', 'user'|"--scope", "user"/.test(l) && !/^\s*(#|REM )/.test(l));
      expect({ name, bare }).toEqual({ name, bare: [] });
    }
    expect(readScript("install.cmd")).toContain(
      'if /i not "!VERSION!"=="latest" if not "!TAG!"=="!PLANNOTATOR_UPDATE_VERSION!" set "PLN_CP_PINNED=!TAG!"',
    );
  });

  test("install.cmd's PowerShell carries nothing cmd.exe would reinterpret", () => {
    expect(extractCmdClaudePluginCommand()).not.toMatch(/["%!]/);
  });
});

/** The PowerShell install.cmd runs inside :UpdateClaudePlugin. */
function extractCmdClaudePluginCommand(): string {
  const cmd = readScript("install.cmd");
  const sub = cmd.slice(cmd.indexOf("\n:UpdateClaudePlugin\n"));
  const m = /^powershell -NoProfile -ExecutionPolicy Bypass -Command "(.*)"$/m.exec(sub);
  if (!m) throw new Error("could not locate the :UpdateClaudePlugin PowerShell in install.cmd");
  return m[1];
}

/** One top-level function of install.ps1, by name, through its closing brace. */
function extractPs1Function(name: string): string {
  const ps = readScript("install.ps1");
  const start = ps.indexOf(`function ${name} {`);
  const end = ps.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`could not locate function ${name} in install.ps1`);
  return ps.slice(start, end + 2);
}

function extractPs1ClaudePluginRegion(): string {
  const ps = readScript("install.ps1");
  const start = ps.indexOf('$claudePluginId = "plannotator@plannotator"');
  const marker = "try { Update-ClaudePluginIfInstalled } catch { }";
  const end = ps.indexOf(marker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("could not locate the Claude Code plugin region in install.ps1");
  }
  return ps.slice(start, end + marker.length);
}

type PluginRunner = "install.ps1" | "install.cmd";

/**
 * Drive the Windows installers' plugin update under PowerShell: install.ps1's
 * region (extracted like the other ps1 regions), or the exact PowerShell
 * command install.cmd hands to `powershell -Command`. On Unix PowerShell a
 * backslash is an ordinary separator character, so the registry path is
 * handed in directly: CLAUDE_CONFIG_DIR is overridden after extraction for
 * ps1, and PLN_CP_REGISTRY is what install.cmd passes.
 */
function runWindowsClaudePluginUpdate(
  runner: PluginRunner,
  s: ReturnType<typeof setupClaudePluginSandbox>,
  opts: { skipSource?: string; pinned?: string; env?: Record<string, string> } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-ps-plugin-test-"));
  const driverPath = join(root, "driver.ps1");
  const body =
    runner === "install.ps1"
      ? [
          `$ErrorActionPreference = "Stop"`,
          `$skipClaudePluginResolved = $${opts.skipSource ? "true" : "false"}`,
          `$skipClaudePluginSource = "${opts.skipSource ?? ""}"`,
          // As install.ps1 resolves them: -Version stays "latest" unless pinned.
          `$Version = "${opts.pinned ?? "latest"}"`,
          `$latestTag = "${opts.pinned ?? "v99.9.9"}"`,
          extractPs1ClaudePluginRegion().replace(
            /^\$claudePluginRegistry = .*$/m,
            "$claudePluginRegistry = $env:PLN_CP_REGISTRY",
          ),
          `Write-Host ("STATE=" + $claudePluginState + " VERSION=" + $claudePluginVersion)`,
          `exit 0`,
        ]
      : [extractCmdClaudePluginCommand()];
  writeFileSync(driverPath, body.join("\n"));
  const r = Bun.spawnSync([pwshBin!, "-NoProfile", "-File", driverPath], {
    env: {
      PATH: `${s.sandbox.stub}:/usr/bin:/bin`,
      HOME: s.sandbox.home,
      USERPROFILE: s.sandbox.home,
      TMPDIR: join(s.sandbox.home, "tmp"),
      PLN_CP_REGISTRY: s.registryPath,
      ...(runner === "install.cmd" && opts.skipSource ? { PLN_CP_SKIP: opts.skipSource } : {}),
      ...(runner === "install.cmd" && opts.pinned ? { PLN_CP_PINNED: opts.pinned } : {}),
      ...s.env,
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe.skipIf(!pwshBin || process.platform === "win32")(
  "Windows installers update an installed Claude Code plugin (PowerShell, fake claude)",
  () => {
    // install.cmd's PowerShell reports its state as its exit code.
    const CMD_STATE = {
      none: 0,
      manual: 20,
      skipped: 21,
      updated: 22,
      current: 23,
      failed: 24,
      "no-marketplace": 25,
    };
    const expectState = (
      runner: PluginRunner,
      r: { code: number; out: string },
      expected: keyof typeof CMD_STATE,
    ) => {
      if (runner === "install.cmd") {
        expect({ code: r.code, out: r.out }).toMatchObject({ code: CMD_STATE[expected] });
      } else {
        expect(r.code).toBe(0);
        expect(r.out).toContain(`STATE=${expected} `);
      }
    };

    for (const runner of ["install.ps1", "install.cmd"] as const) {
      test(`${runner}: installed - both commands run in order and the new version is reported`, () => {
        const s = setupClaudePluginSandbox({});
        const r = runWindowsClaudePluginUpdate(runner, s, { env: { FAKE_CLAUDE_NEW_VERSION: "0.28.11" } });
        expectState(runner, r, "updated");
        expect(s.calls()).toEqual(CLAUDE_PLUGIN_COMMANDS);
        expect(r.out).toContain(
          "Updating the Claude Code plugin...\nClaude Code plugin: updated to 0.28.11 (restart Claude Code to load it).\n",
        );
      }, PWSH_SCANNER_TIMEOUT_MS);

      test(`${runner}: already current`, () => {
        const s = setupClaudePluginSandbox({});
        const r = runWindowsClaudePluginUpdate(runner, s);
        expectState(runner, r, "current");
        expect(s.calls()).toEqual(CLAUDE_PLUGIN_COMMANDS);
        expect(r.out).toContain("Claude Code plugin: already up to date (0.28.7).");
      }, PWSH_SCANNER_TIMEOUT_MS);

      test(`${runner}: a project-scope-only install is left alone`, () => {
        const s = setupClaudePluginSandbox({
          registry: claudePluginRegistry([{ scope: "project", version: "0.28.7" }]),
        });
        const r = runWindowsClaudePluginUpdate(runner, s);
        expectState(runner, r, "none");
        expect(s.calls()).toEqual([]);
        expect(r.out).not.toContain("Claude Code plugin");
      }, PWSH_SCANNER_TIMEOUT_MS);

      test(`${runner}: opted out - nothing runs`, () => {
        const s = setupClaudePluginSandbox({});
        const r = runWindowsClaudePluginUpdate(runner, s, { skipSource: "-SkipClaudePlugin" });
        expectState(runner, r, "skipped");
        expect(s.calls()).toEqual([]);
        expect(r.out).toContain("Claude Code plugin: not updated (-SkipClaudePlugin).");
      }, PWSH_SCANNER_TIMEOUT_MS);

      test(`${runner}: a failing claude never fails the run and prints the manual commands`, () => {
        const s = setupClaudePluginSandbox({});
        const r = runWindowsClaudePluginUpdate(runner, s, { env: { FAKE_CLAUDE_FAIL: "marketplace" } });
        expectState(runner, r, "failed");
        expect(s.calls()).toEqual([CLAUDE_PLUGIN_COMMANDS[0]]);
        expect(r.out).toContain(
          `Claude Code plugin: could not update it (claude exited 3: Error: failed to reach github.com). Run these, then restart Claude Code:\n${MANUAL_PLUGIN_COMMANDS}`,
        );
      }, PWSH_SCANNER_TIMEOUT_MS);

      test(`${runner}: a hanging claude is stopped at the time limit`, () => {
        const s = setupClaudePluginSandbox({});
        const started = Date.now();
        const r = runWindowsClaudePluginUpdate(runner, s, {
          env: { FAKE_CLAUDE_HANG: "1", PLANNOTATOR_CLAUDE_PLUGIN_TIMEOUT: "1" },
        });
        expectState(runner, r, "failed");
        expect(Date.now() - started).toBeLessThan(20_000);
        expect(r.out).toContain("Claude Code plugin: could not update it (timed out after 1s).");
      }, PWSH_SCANNER_TIMEOUT_MS);

      test(`${runner}: a claude that exits at once without reading stdin is a normal run, every time`, () => {
        // Start-Process -RedirectStandardInput wrote into the pipe after the
        // start and threw "Broken pipe" when claude had already exited (CI on
        // Linux, run 38076200627). Repeat to make that race show if it is back.
        for (let i = 0; i < 5; i++) {
          const s = setupClaudePluginSandbox({});
          writeFileSync(
            join(s.sandbox.stub, "claude"),
            `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_CLAUDE_LOG"\nexit 0\n`,
            { mode: 0o755 },
          );
          const r = runWindowsClaudePluginUpdate(runner, s);
          expect(r.out).not.toContain("could not run claude");
          expectState(runner, r, "current");
          expect(s.calls()).toEqual(CLAUDE_PLUGIN_COMMANDS);
        }
      }, PWSH_SCANNER_TIMEOUT_MS);

      test(`${runner}: a --version pin skips the update`, () => {
        const s = setupClaudePluginSandbox({});
        const r = runWindowsClaudePluginUpdate(runner, s, { pinned: "v0.27.0" });
        expectState(runner, r, "skipped");
        expect(s.calls()).toEqual([]);
        expect(r.out).toContain(
          "Claude Code plugin: not updated: pinned to v0.27.0; updating would install the newest plugin.\n",
        );
      }, PWSH_SCANNER_TIMEOUT_MS);

      test(`${runner}: a missing plannotator marketplace prints the re-add command`, () => {
        const s = setupClaudePluginSandbox({});
        const r = runWindowsClaudePluginUpdate(runner, s, {
          env: { FAKE_CLAUDE_FAIL: "marketplace", FAKE_CLAUDE_FAIL_MESSAGE: MISSING_MARKETPLACE },
        });
        expectState(runner, r, "no-marketplace");
        expect(s.calls()).toEqual([CLAUDE_PLUGIN_COMMANDS[0]]);
        expect(r.out).toContain(
          `Claude Code plugin: could not update it (the plannotator marketplace is not registered). Re-add it, then restart Claude Code:\n${READD_PLUGIN_COMMANDS}`,
        );
      }, PWSH_SCANNER_TIMEOUT_MS);

      test(`${runner}: no claude on PATH - nothing runs`, () => {
        const s = setupClaudePluginSandbox({ claude: false });
        const r = runWindowsClaudePluginUpdate(runner, s);
        expectState(runner, r, "manual");
        expect(s.calls()).toEqual([]);
        expect(r.out).not.toContain("Updating the Claude Code plugin");
      }, PWSH_SCANNER_TIMEOUT_MS);
    }
  },
);

// ---------------------------------------------------------------------------
// Pi extension update (#902). On an existing install, current Pi's
// `pi install npm:@plannotator/pi-extension` runs a bare npm install that
// keeps the saved version ("up to date") and exits 0, so the installers run
// `pi update <source>` and read the version back before saying "updated".
// The fake pi below behaves that way: its `install` leaves an existing
// package as it is (unless FAKE_PI_INSTALL_MOVES=1, older Pi's global
// `npm install -g`), and its `update` installs FAKE_PI_LATEST, the version the
// registry offers. A fake npm answers only `npm root -g` (older Pi's global
// install root). No real pi, npm or agent CLI is reachable, and HOME, the Pi
// agent dir and PLANNOTATOR_DATA_DIR all live in a temp sandbox.
// ---------------------------------------------------------------------------

const PI_SOURCE = "npm:@plannotator/pi-extension";
const FAKE_PI = [
  "#!/bin/bash",
  'printf \'%s\\n\' "$*" >> "$FAKE_PI_LOG"',
  'pkg="$FAKE_PI_PKG"',
  'write() { mkdir -p "$pkg"; printf \'{\\n  "name": "@plannotator/pi-extension",\\n  "version": "%s"\\n}\\n\' "$1" > "$pkg/package.json"; }',
  'case "$1" in',
  "  install)",
  '    picks="$FAKE_PI_INSTALL_PICKS"; [ -n "$picks" ] || picks="$FAKE_PI_LATEST"',
  '    if [ "$FAKE_PI_INSTALL_MOVES" = 1 ] || [ ! -f "$pkg/package.json" ]; then write "$picks"; echo "added 1 package"; else echo "up to date in 573ms"; fi',
  '    if ! grep -q "npm:@plannotator/pi-extension" "$FAKE_PI_SETTINGS" 2>/dev/null; then mkdir -p "$(dirname "$FAKE_PI_SETTINGS")"; printf \'{"packages":["%s"]}\\n\' "$2" > "$FAKE_PI_SETTINGS"; fi',
  '    echo "Installed $2"',
  "    exit 0 ;;",
  "  update)",
  '    if [ "$FAKE_PI_UPDATE" = missing ]; then echo "Unknown command: update" >&2; exit 1; fi',
  '    if [ "$FAKE_PI_UPDATE" = fail ]; then echo "npm error code ETIMEDOUT" >&2; exit 1; fi',
  '    write "$FAKE_PI_LATEST"',
  '    echo "Updated $2"',
  "    exit 0 ;;",
  "esac",
  "exit 1",
  "",
].join("\n");
const FAKE_NPM = [
  "#!/bin/bash",
  'if [ "$1" = "root" ] && [ "$2" = "-g" ]; then printf \'%s\\n\' "$FAKE_NPM_ROOT"; exit 0; fi',
  'if [ "$1" = "view" ]; then',
  '  printf \'%s\\n\' "$*" >> "$FAKE_NPM_LOG"',
  '  if [ "$FAKE_NPM_VIEW" = e404 ]; then echo "npm error code E404" >&2; echo "npm error 404 No match found for version" >&2; exit 1; fi',
  '  if [ "$FAKE_NPM_VIEW" = offline ]; then echo "npm error code ENOTFOUND" >&2; exit 1; fi',
  '  v="$2"; printf \'%s\\n\' "${v##*@}"; exit 0',
  "fi",
  "exit 1",
  "",
].join("\n");

/** The release every runner installs here: the stub curl's latest tag. */
const PI_RELEASE = "99.9.9";
const PI_OLDER = "99.9.8";
const PI_INSTALL_ARGS = ["--non-interactive", "--no-extras", "--skip-skills", "--skip-claude-plugin"];

interface PiScenario {
  /** Pi's settings.json entry for the extension; null: not listed (first install). */
  source: string | null;
  /** package.json version on disk before the run; null: none; "garbled": unreadable. */
  installed: string | null;
  /** Where the package lives: Pi's managed npm dir, or older Pi's global npm root. */
  where?: "managed" | "global";
  latest: string;
  update?: "ok" | "missing" | "fail";
  installMoves?: boolean;
  /** The version a bare-name `pi install` lands on (npm passing over a release whose engines Node misses). */
  installPicks?: string;
  /** `npm view <name>@<release> version`: found, E404 (not on the registry), or a network error. */
  npmView?: "published" | "e404" | "offline";
  /** PI_CODING_AGENT_DIR as the person set it ("~/..." is expanded as Pi does). */
  agentDirEnv?: string;
}

function setupPiSandbox(sc: PiScenario) {
  const sandbox = setupInstallSandbox({ gh: "pass-all" });
  const agentDir = sc.agentDirEnv
    ? join(sandbox.home, sc.agentDirEnv.replace(/^~\//, ""))
    : join(sandbox.home, ".pi", "agent");
  const settings = join(agentDir, "settings.json");
  const npmRoot = join(sandbox.home, "global-npm", "lib", "node_modules");
  const pkg =
    sc.where === "global"
      ? join(npmRoot, "@plannotator", "pi-extension")
      : join(agentDir, "npm", "node_modules", "@plannotator", "pi-extension");
  if (sc.source !== null) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(settings, JSON.stringify({ defaultProvider: "anthropic", packages: [sc.source] }, null, 2) + "\n");
  }
  if (sc.installed !== null) {
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      sc.installed === "garbled"
        ? "{ not json"
        : JSON.stringify({ name: "@plannotator/pi-extension", version: sc.installed }, null, 2),
    );
  }
  writeFileSync(join(sandbox.stub, "pi"), FAKE_PI, { mode: 0o755 });
  writeFileSync(join(sandbox.stub, "npm"), FAKE_NPM, { mode: 0o755 });
  const log = join(sandbox.home, "pi-calls.log");
  const env: Record<string, string> = {
    FAKE_PI_LOG: log,
    FAKE_PI_PKG: pkg,
    FAKE_PI_SETTINGS: settings,
    FAKE_PI_LATEST: sc.latest,
    FAKE_PI_UPDATE: sc.update ?? "ok",
    FAKE_PI_INSTALL_MOVES: sc.installMoves ? "1" : "0",
    FAKE_PI_INSTALL_PICKS: sc.installPicks ?? "",
    FAKE_NPM_ROOT: npmRoot,
    FAKE_NPM_VIEW: sc.npmView ?? "published",
    FAKE_NPM_LOG: join(sandbox.home, "npm-calls.log"),
    PLANNOTATOR_DATA_DIR: join(sandbox.home, "plannotator-data"),
    ...(sc.agentDirEnv ? { PI_CODING_AGENT_DIR: sc.agentDirEnv } : {}),
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : []);
  const version = () => {
    try {
      return JSON.parse(readFileSync(join(pkg, "package.json"), "utf-8")).version as string;
    } catch {
      return null;
    }
  };
  const settingsText = () => (existsSync(settings) ? readFileSync(settings, "utf-8") : null);
  const npmLog = env.FAKE_NPM_LOG!;
  const npmViews = () => (existsSync(npmLog) ? readFileSync(npmLog, "utf-8").split("\n").filter(Boolean) : []);
  return { sandbox, env, calls, version, settingsText, pkg, npmViews };
}

type PiRunner = "install.sh" | "install.ps1" | "install.cmd";

/** install.ps1's Pi region: from $piExtensionSource through Update-PiExtensionIfPresent. */
function extractPs1PiRegion(): string {
  const ps = readScript("install.ps1");
  const start = ps.indexOf('$piExtensionSource = "npm:@plannotator/pi-extension"');
  const fn = ps.indexOf("function Update-PiExtensionIfPresent {");
  const end = ps.indexOf("\n}\n", fn);
  if (start < 0 || fn < start || end < 0) throw new Error("could not locate the Pi region in install.ps1");
  return ps.slice(start, end + 2);
}

/** The PowerShell install.cmd runs inside :UpdatePiExtension. */
function extractCmdPiCommand(): string {
  const cmd = readScript("install.cmd");
  const sub = cmd.slice(cmd.indexOf("\n:UpdatePiExtension\n"));
  const m = /^powershell -NoProfile -ExecutionPolicy Bypass -Command "(.*)"$/m.exec(sub);
  if (!m) throw new Error("could not locate the :UpdatePiExtension PowerShell in install.cmd");
  return m[1];
}

/**
 * Run one installer's Pi step: the whole install.sh (its stub curl serves
 * v99.9.9), install.ps1's Pi region with $latestTag = v99.9.9, or the exact
 * PowerShell command install.cmd hands to `powershell -Command`.
 */
function runPiStep(runner: PiRunner, s: ReturnType<typeof setupPiSandbox>) {
  if (runner === "install.sh") return runInstallSh(s.sandbox, PI_INSTALL_ARGS, s.env);
  const root = mkdtempSync(join(tmpdir(), "plannotator-ps-pi-test-"));
  const driverPath = join(root, "driver.ps1");
  const body =
    runner === "install.ps1"
      ? [
          `$ErrorActionPreference = "Stop"`,
          `$latestTag = "v${PI_RELEASE}"`,
          extractPs1PiRegion(),
          "Update-PiExtensionIfPresent",
          "exit 0",
        ]
      : [extractCmdPiCommand()];
  writeFileSync(driverPath, body.join("\n"));
  const r = Bun.spawnSync([pwshBin!, "-NoProfile", "-File", driverPath], {
    env: {
      PATH: `${s.sandbox.stub}:/usr/bin:/bin`,
      HOME: s.sandbox.home,
      USERPROFILE: s.sandbox.home,
      TMPDIR: join(s.sandbox.home, "tmp"),
      PLN_PI_TARGET: `v${PI_RELEASE}`,
      ...s.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

const UPDATE_LATER = `To update it: pi update ${PI_SOURCE}`;

function piStepTests(runner: PiRunner) {
  const timeout = runner === "install.sh" ? undefined : PWSH_SCANNER_TIMEOUT_MS;

  test(`${runner}: an existing install that pi install would leave stale is moved by pi update`, () => {
    const s = setupPiSandbox({ source: PI_SOURCE, installed: PI_OLDER, latest: PI_RELEASE });
    const r = runPiStep(runner, s);
    expect(r.code).toBe(0);
    expect(s.calls()).toEqual([`update ${PI_SOURCE}`]);
    expect(s.version()).toBe(PI_RELEASE);
    expect(r.out).toContain(`Updating Pi extension...\nUpdated ${PI_SOURCE}\nPi extension updated to ${PI_RELEASE}.\n`);
    expect(r.out).not.toContain("still");
  }, timeout);

  test(`${runner}: a Pi without a working pi update falls back to pi install and reads the global copy`, () => {
    const s = setupPiSandbox({
      source: PI_SOURCE,
      installed: PI_OLDER,
      where: "global",
      latest: PI_RELEASE,
      update: "missing",
      installMoves: true,
    });
    const r = runPiStep(runner, s);
    expect(r.code).toBe(0);
    expect(s.calls()).toEqual([`update ${PI_SOURCE}`, `install ${PI_SOURCE}`]);
    expect(s.version()).toBe(PI_RELEASE);
    expect(r.out).toContain(`Pi extension updated to ${PI_RELEASE}.`);
  }, timeout);

  test(`${runner}: a first install runs pi install, as before`, () => {
    const s = setupPiSandbox({ source: null, installed: null, latest: PI_RELEASE });
    const r = runPiStep(runner, s);
    expect(r.code).toBe(0);
    expect(s.calls()).toEqual([`install ${PI_SOURCE}`]);
    expect(s.version()).toBe(PI_RELEASE);
    expect(r.out).toContain("Installing Pi extension...");
    expect(r.out).toContain(`Pi extension installed (${PI_RELEASE}).`);
    expect(r.out).not.toContain("Updating Pi extension");
  }, timeout);

  test(`${runner}: a first install that npm settles on an older version is moved by pi update`, () => {
    const s = setupPiSandbox({ source: null, installed: null, latest: PI_RELEASE, installPicks: PI_OLDER });
    const r = runPiStep(runner, s);
    expect(r.code).toBe(0);
    expect(s.calls()).toEqual([`install ${PI_SOURCE}`, `update ${PI_SOURCE}`]);
    expect(s.version()).toBe(PI_RELEASE);
    expect(r.out).toContain(`Pi extension installed (${PI_RELEASE}).`);
  }, timeout);

  test(`${runner}: still behind because the registry lacks the release: says so, never "updated"`, () => {
    const s = setupPiSandbox({ source: PI_SOURCE, installed: PI_OLDER, latest: PI_OLDER, npmView: "e404" });
    const r = runPiStep(runner, s);
    expect(r.code).toBe(0);
    expect(s.version()).toBe(PI_OLDER);
    expect(r.out).toContain(
      `Pi extension: still ${PI_OLDER} (${PI_RELEASE} is not on your npm registry yet). Run this later: pi update ${PI_SOURCE}\n`,
    );
    // A registry that never answers must not hold the install for minutes: one try, 10 s.
    expect(s.npmViews()).toEqual([
      `view @plannotator/pi-extension@${PI_RELEASE} version --fetch-timeout=10000 --fetch-retries=0`,
    ]);
    expect(r.out).not.toContain("Pi extension updated");
    expect(r.out).not.toContain("already up to date");
  }, timeout);

  test(`${runner}: still behind for a reason it can't see: the release and the command`, () => {
    const s = setupPiSandbox({ source: PI_SOURCE, installed: PI_OLDER, latest: PI_RELEASE, update: "fail", npmView: "offline" });
    const r = runPiStep(runner, s);
    expect(r.code).toBe(0);
    expect(s.calls()).toEqual([`update ${PI_SOURCE}`, `install ${PI_SOURCE}`]);
    expect(s.version()).toBe(PI_OLDER);
    expect(r.out).toContain(`Pi extension: still ${PI_OLDER} (this release is ${PI_RELEASE}). ${UPDATE_LATER}\n`);
    expect(r.out).not.toContain("Pi extension updated");
  }, timeout);

  test(`${runner}: a version that can't be read is not called updated, and nothing is removed`, () => {
    const s = setupPiSandbox({ source: PI_SOURCE, installed: "garbled", latest: PI_RELEASE, update: "fail" });
    const r = runPiStep(runner, s);
    expect(r.code).toBe(0);
    expect(s.calls()).toEqual([`update ${PI_SOURCE}`, `install ${PI_SOURCE}`]);
    expect(existsSync(join(s.pkg, "package.json"))).toBe(true);
    expect(r.out).toContain(`Pi extension: could not read its installed version. ${UPDATE_LATER}\n`);
    expect(r.out).not.toContain("Pi extension updated");
  }, timeout);

  test(`${runner}: a version pinned in Pi's settings is left alone, with the command that moves it`, () => {
    const s = setupPiSandbox({ source: `${PI_SOURCE}@${PI_OLDER}`, installed: PI_OLDER, latest: PI_RELEASE });
    const before = s.settingsText();
    const r = runPiStep(runner, s);
    expect(r.code).toBe(0);
    expect(s.calls()).toEqual([]);
    expect(s.settingsText()).toBe(before);
    expect(s.version()).toBe(PI_OLDER);
    expect(r.out).toContain(
      `Pi extension: pinned to ${PI_OLDER} in Pi's settings, left as is. To move it: pi install ${PI_SOURCE}@${PI_RELEASE}\n`,
    );
  }, timeout);

  test(`${runner}: already on the release: says so, with the version`, () => {
    const s = setupPiSandbox({ source: PI_SOURCE, installed: PI_RELEASE, latest: PI_RELEASE });
    const r = runPiStep(runner, s);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Pi extension already up to date (${PI_RELEASE}).`);
    expect(r.out).not.toContain("Pi extension updated");
  }, timeout);

  test(`${runner}: honors PI_CODING_AGENT_DIR with ~ expanded, as Pi does`, () => {
    const s = setupPiSandbox({ source: PI_SOURCE, installed: PI_OLDER, latest: PI_RELEASE, agentDirEnv: "~/custom-pi" });
    const r = runPiStep(runner, s);
    expect(r.code).toBe(0);
    expect(s.calls()).toEqual([`update ${PI_SOURCE}`]);
    expect(r.out).toContain(`Pi extension updated to ${PI_RELEASE}.`);
  }, timeout);
}

describe.skipIf(process.platform === "win32" || !Bun.which("node"))(
  "install.sh updates the Pi extension to the release (fake pi, sandbox HOME, #902)",
  () => {
    piStepTests("install.sh");

    test("the closing PI USERS section tells install and update apart", () => {
      const s = setupPiSandbox({ source: PI_SOURCE, installed: PI_RELEASE, latest: PI_RELEASE });
      const r = runInstallSh(s.sandbox, PI_INSTALL_ARGS, s.env);
      expect(r.code).toBe(0);
      const section = r.out.slice(r.out.indexOf("  PI USERS"));
      expect(section).toContain(`  pi install ${PI_SOURCE}\n`);
      expect(section).toContain(`  pi update ${PI_SOURCE}\n`);
    });

    test("no pi on PATH: no Pi step and no PI USERS section", () => {
      const sandbox = setupInstallSandbox({ gh: "pass-all" });
      const r = runInstallSh(sandbox, PI_INSTALL_ARGS, { PLANNOTATOR_DATA_DIR: join(sandbox.home, "plannotator-data") });
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("Pi extension");
      expect(r.out).not.toContain("PI USERS");
    });
  },
);

describe.skipIf(!pwshBin || process.platform === "win32")(
  "Windows installers update the Pi extension to the release (PowerShell, fake pi, #902)",
  () => {
    piStepTests("install.ps1");
    piStepTests("install.cmd");
  },
);

describe("install.cmd's Pi step", () => {
  test("runs as a subroutine called outside any parenthesized block", () => {
    expect(readScript("install.cmd")).toContain("where pi >nul 2>&1\nif !ERRORLEVEL! equ 0 call :UpdatePiExtension\n");
  });

  test("its PowerShell carries nothing cmd.exe would reinterpret", () => {
    expect(extractCmdPiCommand()).not.toMatch(/["%!^]/);
  });
});

// ---------------------------------------------------------------------------
// Qwen Code: the skills go to $QWEN_HOME/skills (default ~/.qwen/skills) and
// the plannotator extension is installed and updated with Qwen's own
// `qwen extensions` commands, from <data dir>/qwen-code/extension. A fake
// `qwen` on PATH (scripts/fixtures/fake-qwen.ts, started by a shell shim, or
// by a qwen.cmd on Windows like npm's) acts like Qwen's commands on
// $QWEN_HOME, extension store included, and logs every call. The git shim
// hands install.sh this checkout's real apps/skills and apps/qwen-code, so
// the files that ship are the ones installed.
// ---------------------------------------------------------------------------
const FAKE_QWEN_SCRIPT = join(scriptsDir, "fixtures", "fake-qwen.ts");

function writeFakeQwen(dir: string): void {
  if (process.platform === "win32") {
    writeFileSync(join(dir, "qwen.cmd"), `@echo off\r\n"${process.execPath}" "${FAKE_QWEN_SCRIPT}" %*\r\n`);
  } else {
    writeFileSync(join(dir, "qwen"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_QWEN_SCRIPT}" "$@"\n`, { mode: 0o755 });
  }
}

function removeFakeQwen(dir: string): void {
  rmSync(join(dir, process.platform === "win32" ? "qwen.cmd" : "qwen"), { force: true });
}

const QWEN_SKILLS = ["plannotator-review", "plannotator-annotate", "plannotator-last"];
const QWEN_ARGS = ["--version", "v99.9.9", "--non-interactive", "--no-extras"];

// Helpers on a Qwen folder the fake qwen manages.
function qwenFiles(qwenDir: string) {
  const extension = join(qwenDir, "extensions", "plannotator");
  const statePath = join(qwenDir, "extension-store", "state.json");
  type Policy = { name: string; defaultActivation: string; workspaceOverrides: Record<string, string> };
  const state = (): { extensions: Record<string, Policy> } => JSON.parse(readFileSync(statePath, "utf8"));
  return {
    extension,
    record: () => JSON.parse(readFileSync(join(extension, ".qwen-extension-install.json"), "utf8")) as { source: string; type: string },
    installedVersion: () => JSON.parse(readFileSync(join(extension, "qwen-extension.json"), "utf8")).version as string,
    policies: () => Object.entries(state().extensions).filter(([, p]) => p.name === "plannotator"),
    // An older version installed by the installer: what an update must replace.
    makeOlder: () => {
      const manifest = join(extension, "qwen-extension.json");
      writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "0.0.1" }));
      writeFileSync(join(extension, "hooks", "hooks.json"), '{"hooks":{}}\n');
    },
    turnOff: (how: "default" | "project") => {
      const s = state();
      for (const policy of Object.values(s.extensions)) {
        if (policy.name !== "plannotator") continue;
        if (how === "default") policy.defaultActivation = "disabled";
        else policy.workspaceOverrides["/work/some project"] = "disabled";
      }
      writeFileSync(statePath, JSON.stringify(s, null, 2));
    },
    seedLink: () => {
      mkdirSync(extension, { recursive: true });
      writeFileSync(join(extension, ".qwen-extension-install.json"), JSON.stringify({ source: "/dev/plannotator/apps/qwen-code/extension", type: "link" }));
    },
    seedForeign: () => {
      mkdirSync(join(extension, "hooks"), { recursive: true });
      writeFileSync(join(extension, "qwen-extension.json"), '{"name":"plannotator","version":"0.0.1"}\n');
      writeFileSync(join(extension, "hooks", "hooks.json"), '{"hooks":{}}\n');
      writeFileSync(join(extension, ".qwen-extension-install.json"), JSON.stringify({ source: "/elsewhere/plannotator", type: "local" }));
    },
  };
}

const qwenSource = (file: string) => readFileSync(join(scriptsDir, "..", "apps", "qwen-code", "extension", file), "utf8");

describe.skipIf(process.platform === "win32")("Qwen Code integration (install.sh, fake qwen)", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function qwenSandbox(opts: { qwenDir?: boolean; marker?: string | null; qwenCli?: boolean; config?: string } = {}) {
    const sandbox = setupInstallSandbox({ gh: "pass-all", git: "repo-copy" });
    roots.push(join(sandbox.home, ".."));
    const data = join(sandbox.home, "plannotator data");
    // The run's data dir (PLANNOTATOR_DATA_DIR below) is where the installer reads config.json.
    if (opts.config) {
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, "config.json"), opts.config);
    }
    const qwenDir = join(sandbox.home, ".qwen");
    if (opts.qwenDir ?? true) {
      mkdirSync(qwenDir, { recursive: true });
      // A real Qwen Code folder has its settings.json.
      const marker = opts.marker === undefined ? "settings.json" : opts.marker;
      if (marker) writeFileSync(join(qwenDir, marker), "{}\n");
    }
    if (opts.qwenCli ?? true) writeFakeQwen(sandbox.stub);
    const log = join(sandbox.home, "qwen-calls.log");
    const run = (args: string[] = [], env: Record<string, string> = {}) =>
      runInstallSh(sandbox, [...QWEN_ARGS, ...args], { FAKE_QWEN_LOG: log, FAKE_QWEN_HOME: sandbox.home, PLANNOTATOR_DATA_DIR: data, ...env });
    const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
    const calls = () => lines().map((line) => line.slice(line.indexOf("|") + 1));
    const extensionCalls = () => calls().filter((call) => call.startsWith("extensions "));
    const callDirs = () => lines().map((line) => line.slice(0, line.indexOf("|")));
    return {
      home: sandbox.home,
      stub: sandbox.stub,
      data,
      stable: join(data, "qwen-code", "extension"),
      qwenDir,
      run,
      calls,
      extensionCalls,
      callDirs,
      ...qwenFiles(qwenDir),
    };
  }

  test("installs the extension from the data folder with qwen, and the Qwen skills; the run succeeds", () => {
    const q = qwenSandbox();
    const r = q.run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("Installing the Qwen Code extension...\nQwen Code extension: installed (restart Qwen Code to load it).\n");
    expect(q.calls()).toEqual(["--version", `extensions install ${q.stable} --consent`]);
    // Run outside any project, so no project's .qwen settings take part.
    for (const dir of q.callDirs()) expect(dir).toContain("plannotator-qwen.");
    // Qwen records the source; it must be a path that stays.
    expect(q.record().source).toBe(q.stable);
    expect(readFileSync(join(q.stable, "hooks", "hooks.json"), "utf8")).toBe(qwenSource("hooks/hooks.json"));
    expect(readFileSync(join(q.extension, "hooks", "hooks.json"), "utf8")).toBe(qwenSource("hooks/hooks.json"));
    expect(readFileSync(join(q.extension, "qwen-extension.json"), "utf8")).toBe(qwenSource("qwen-extension.json"));
    for (const skill of QWEN_SKILLS) {
      expect(readFileSync(join(q.qwenDir, "skills", skill, "SKILL.md"), "utf8")).toBe(
        readFileSync(join(scriptsDir, "..", "apps", "qwen-code", "skills", skill, "SKILL.md"), "utf8"),
      );
    }
    expect(readFileSync(join(q.home, "git-sparse.log"), "utf8")).toContain(" apps/qwen-code");
    expect(r.out).toContain("  QWEN CODE USERS");
    expect(r.out).toContain("Qwen Code asks you to confirm the plan");
    expect(r.out).toContain(`Skills are installed to ${q.qwenDir}/skills/:`);
  });

  test("a re-run with the same version runs no extension command and changes nothing in Qwen", () => {
    const q = qwenSandbox();
    expect(q.run().code).toBe(0);
    const record = readFileSync(join(q.extension, ".qwen-extension-install.json"), "utf8");
    const state = readFileSync(join(q.qwenDir, "extension-store", "state.json"), "utf8");
    const r = q.run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("Qwen Code extension: already up to date.");
    expect(q.extensionCalls()).toHaveLength(1);
    expect(readFileSync(join(q.extension, ".qwen-extension-install.json"), "utf8")).toBe(record);
    expect(readFileSync(join(q.qwenDir, "extension-store", "state.json"), "utf8")).toBe(state);
  });

  test("another version is updated with qwen extensions update, keeping the id; never uninstalled", () => {
    const q = qwenSandbox();
    expect(q.run().code).toBe(0);
    const [[id]] = q.policies();
    q.makeOlder();
    const r = q.run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("Updating the Qwen Code extension...\nQwen Code extension: updated (restart Qwen Code to load it).\n");
    expect(q.extensionCalls().slice(1)).toEqual(["extensions update plannotator"]);
    expect(q.extensionCalls().some((call) => call.includes("uninstall"))).toBe(false);
    expect(q.installedVersion()).toBe(JSON.parse(qwenSource("qwen-extension.json")).version);
    expect(readFileSync(join(q.extension, "hooks", "hooks.json"), "utf8")).toBe(qwenSource("hooks/hooks.json"));
    expect(q.policies().map(([key]) => key)).toEqual([id]);
  });

  for (const how of ["default", "project"] as const) {
    test(`an extension turned off (${how === "default" ? "everywhere" : "in one project"}) stays off through an update, and the installer says so`, () => {
      const q = qwenSandbox();
      expect(q.run().code).toBe(0);
      q.turnOff(how);
      const before = q.policies();
      q.makeOlder();
      const r = q.run();
      expect(r.code).toBe(0);
      expect(q.installedVersion()).toBe(JSON.parse(qwenSource("qwen-extension.json")).version);
      expect(q.policies()).toEqual(before);
      expect(r.out).toContain("Qwen Code extension: updated (restart Qwen Code to load it).\nIt stays turned off where you turned it off in Qwen Code.\n");
      expect(r.out).toContain("The plannotator extension is turned off in Qwen Code");
      expect(r.out).not.toContain("the plan opens in your");
    });
  }

  test("a turned-off rule in Qwen's older enablement file is read too; an enabled extension says nothing", () => {
    const q = qwenSandbox();
    expect(q.run().code).toBe(0);
    q.makeOlder();
    expect(q.run().out).not.toContain("It stays turned off");
    q.makeOlder();
    writeFileSync(join(q.qwenDir, "extensions", "extension-enablement.json"), JSON.stringify({ plannotator: { overrides: ["!/*"] } }));
    expect(q.run().out).toContain("It stays turned off where you turned it off in Qwen Code.");
  });

  test("an update qwen did not make (it exits 0) is reported, and the installed one kept", () => {
    const q = qwenSandbox();
    expect(q.run().code).toBe(0);
    q.makeOlder();
    const r = q.run([], { FAKE_QWEN_UPDATE_FAIL: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Qwen Code extension: could not update it (Update failed: disk full). The installed one was left as it was.");
    expect(r.out).toContain("To try again by hand: qwen extensions update plannotator");
    expect(r.out).toContain("The plan-review extension could not be installed");
    expect(q.installedVersion()).toBe("0.0.1");
    expect(r.out).toContain("YOU'RE ALL SET!");
  });

  test("a linked extension (qwen extensions link) is left alone, quietly", () => {
    const q = qwenSandbox();
    q.seedLink();
    const r = q.run();
    expect(r.code).toBe(0);
    expect(q.extensionCalls()).toEqual([]);
    expect(r.out).toContain("Qwen Code extension: linked from a local folder (qwen extensions link), left as it is.");
    expect(r.out).not.toContain("could not");
    expect(r.out).not.toContain("the plan opens in your");
    expect(q.record().type).toBe("link");
  });

  test("an extension installed from another source is left alone, and says from where", () => {
    const q = qwenSandbox();
    q.seedForeign();
    const r = q.run();
    expect(r.code).toBe(0);
    expect(q.extensionCalls()).toEqual([]);
    expect(r.out).toContain("Qwen Code extension: installed from /elsewhere/plannotator, not by this installer, so it was left as it is.");
    expect(readFileSync(join(q.extension, "hooks", "hooks.json"), "utf8")).toBe('{"hooks":{}}\n');
  });

  test("a failed first install is reported with the command to run, and never fails the install", () => {
    const q = qwenSandbox();
    const r = q.run([], { FAKE_QWEN_INSTALL_FAIL: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Qwen Code extension: could not install it (qwen exited 1: Install failed: disk full).");
    expect(r.out).toContain(`To try again by hand: qwen extensions install "${q.stable}"`);
    expect(r.out).toContain("The plan-review extension could not be installed");
    expect(existsSync(q.extension)).toBe(false);
    // The skills still install.
    expect(existsSync(join(q.qwenDir, "skills", "plannotator-review", "SKILL.md"))).toBe(true);
  });

  test("a qwen that hangs is stopped at the time limit and the install goes on", () => {
    const q = qwenSandbox();
    const started = Date.now();
    const r = q.run([], { FAKE_QWEN_HANG: "1", PLANNOTATOR_QWEN_EXTENSION_TIMEOUT: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Qwen Code extension: could not install it (timed out after 1s).");
    expect(Date.now() - started).toBeLessThan(40_000);
  }, 45_000);

  for (const version of ["0.12.9", "0.6.0"]) {
    test(`Qwen Code ${version} (before extension hooks): nothing installed, and it says to update`, () => {
      const q = qwenSandbox();
      const r = q.run([], { FAKE_QWEN_VERSION: version });
      expect(r.code).toBe(0);
      expect(q.calls()).toEqual(["--version"]);
      expect(r.out).toContain(`Qwen Code ${version} is older than 0.13.0, so nothing was installed for it. Update Qwen Code to use plan review.`);
      expect(existsSync(join(q.qwenDir, "skills"))).toBe(false);
      expect(existsSync(q.extension)).toBe(false);
      expect(r.out).not.toContain("Skills are installed to");
      expect(r.out).not.toContain("the plan opens in your");
    });
  }

  test("a release from before the Qwen Code integration: no extension, and no claim that skills were installed", () => {
    const q = qwenSandbox();
    const r = q.run([], { GIT_SHIM_NO_QWEN: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("This release has no Qwen Code extension.");
    expect(existsSync(join(q.qwenDir, "skills"))).toBe(false);
    expect(r.out).not.toContain("Skills are installed to");
  });

  for (const version of ["0.13.0", "0.26.2-nightly.20261020", "not a version"]) {
    test(`Qwen Code reporting "${version}" gets the extension`, () => {
      const q = qwenSandbox();
      expect(q.run([], { FAKE_QWEN_VERSION: version }).out).toContain("Qwen Code extension: installed");
    });
  }

  for (const [label, args, env, config, sourceName] of [
    ["--skip-qwen", ["--skip-qwen"], {}, undefined, "--skip-qwen"],
    ["PLANNOTATOR_SKIP_QWEN_INSTALL", [], { PLANNOTATOR_SKIP_QWEN_INSTALL: "1" }, undefined, "PLANNOTATOR_SKIP_QWEN_INSTALL"],
    ["skipInstall.qwen", [], {}, '{ "skipInstall": { "qwen": true } }\n', "config skipInstall.qwen"],
  ] as const) {
    test(`${label}: no qwen command, nothing written under ~/.qwen, an installed extension left alone`, () => {
      const q = qwenSandbox({ config });
      q.seedForeign();
      const r = q.run([...args], env);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`Qwen Code: detected, skipped (${sourceName}).`);
      expect(r.out).toContain("The installed Qwen Code extension was left untouched.");
      expect(q.calls()).toEqual([]);
      expect(existsSync(join(q.qwenDir, "skills"))).toBe(false);
      expect(existsSync(q.stable)).toBe(false);
      expect(readFileSync(join(q.extension, "hooks", "hooks.json"), "utf8")).toBe('{"hooks":{}}\n');
    });
  }

  test("--skip-qwen is remembered for auto-update", () => {
    const q = qwenSandbox();
    expect(q.run(["--skip-qwen"]).code).toBe(0);
    const flags = JSON.parse(readFileSync(join(q.data, "install-flags.json"), "utf8"));
    expect(flags.flags).toContain("skip-qwen");
  });

  test("no Qwen folder: nothing Qwen-related runs or prints, even with qwen on PATH", () => {
    const q = qwenSandbox({ qwenDir: false });
    const r = q.run();
    expect(r.code).toBe(0);
    expect(q.calls()).toEqual([]);
    expect(existsSync(q.qwenDir)).toBe(false);
    expect(r.out).not.toContain("Qwen Code");
    expect(r.out).not.toContain("QWEN CODE USERS");
  });

  test("a ~/.qwen the skills CLI made (skills/ only, no qwen command) is not Qwen Code: nothing written or printed", () => {
    const q = qwenSandbox({ marker: null, qwenCli: false });
    mkdirSync(join(q.home, ".agents", "skills", "other-skill"), { recursive: true });
    mkdirSync(join(q.qwenDir, "skills"), { recursive: true });
    symlinkSync(join(q.home, ".agents", "skills", "other-skill"), join(q.qwenDir, "skills", "other-skill"));
    const r = q.run();
    expect(r.code).toBe(0);
    expect(readdirSync(join(q.qwenDir, "skills"))).toEqual(["other-skill"]);
    expect(readdirSync(q.qwenDir)).toEqual(["skills"]);
    expect(r.out).not.toContain("Qwen Code");
    expect(r.out).not.toContain("QWEN CODE USERS");
  });

  test("a ~/.qwen with only skills/ counts once the qwen command is on PATH", () => {
    const q = qwenSandbox({ marker: null });
    mkdirSync(join(q.qwenDir, "skills"), { recursive: true });
    expect(q.run().out).toContain("Qwen Code extension: installed");
  });

  for (const marker of ["settings.json", "installation_id", "projects", "extensions"]) {
    test(`Qwen Code's ${marker} counts as Qwen Code without the qwen command: skills installed, the extension reported`, () => {
      const q = qwenSandbox({ marker: null, qwenCli: false });
      if (marker.includes(".") || marker === "installation_id") writeFileSync(join(q.qwenDir, marker), "x\n");
      else mkdirSync(join(q.qwenDir, marker), { recursive: true });
      const r = q.run();
      expect(r.code).toBe(0);
      expect(r.out).toContain("Qwen Code extension: not installed (the qwen command is not on PATH).");
      expect(existsSync(join(q.qwenDir, "skills", "plannotator-last", "SKILL.md"))).toBe(true);
      expect(existsSync(join(q.extension, "qwen-extension.json"))).toBe(false);
    });
  }

  test("a Qwen skill the skills CLI linked is replaced, and what it pointed to is kept", () => {
    const q = qwenSandbox();
    const shared = join(q.home, "elsewhere", "plannotator-review");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "SKILL.md"), "shared copy\n");
    mkdirSync(join(q.qwenDir, "skills"), { recursive: true });
    symlinkSync(shared, join(q.qwenDir, "skills", "plannotator-review"));
    expect(q.run().code).toBe(0);
    expect(readFileSync(join(shared, "SKILL.md"), "utf8")).toBe("shared copy\n");
    expect(readFileSync(join(q.qwenDir, "skills", "plannotator-review", "SKILL.md"), "utf8")).toContain("is_background: true");
  });

  test("QWEN_HOME with a leading ~ is the Qwen folder itself", () => {
    const q = qwenSandbox({ qwenDir: false });
    mkdirSync(join(q.home, "qwen-home"), { recursive: true });
    const r = q.run([], { QWEN_HOME: "~/qwen-home" });
    expect(r.code).toBe(0);
    expect(existsSync(join(q.home, "qwen-home", "skills", "plannotator-review", "SKILL.md"))).toBe(true);
    expect(existsSync(join(q.home, "qwen-home", "extensions", "plannotator", "qwen-extension.json"))).toBe(true);
    expect(existsSync(q.qwenDir)).toBe(false);
  });

  test("--skip-skills: no extension and no Qwen skills, said plainly", () => {
    const q = qwenSandbox();
    const r = q.run(["--skip-skills"]);
    expect(r.code).toBe(0);
    expect(q.calls()).toEqual([]);
    expect(existsSync(join(q.qwenDir, "skills"))).toBe(false);
    expect(r.out).toContain("so neither was\ninstalled or changed");
  });

  test("--model-invocable unlocks the Qwen copy of a chosen skill too", () => {
    const q = qwenSandbox();
    const r = q.run(["--model-invocable", "plannotator-review"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(q.qwenDir, "skills", "plannotator-review", "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation: true",
    );
    expect(readFileSync(join(q.qwenDir, "skills", "plannotator-last", "SKILL.md"), "utf8")).toContain(
      "disable-model-invocation: true",
    );
  });
});

// The Windows installers' Qwen Code steps, driven with the same fake qwen:
// install.ps1's regions (its functions and state), and install.cmd's
// PowerShell program, both under PowerShell (pwsh on Linux and macOS; pwsh
// and Windows PowerShell 5.1 on Windows). On Windows install.cmd's
// subroutines also run under cmd.exe itself, and the fake is a qwen.cmd, as
// npm installs it. Every folder name has a space in it.
function extractRegion(text: string, start: string, end: string, what: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error(`could not locate ${what}`);
  return text.slice(from, to);
}

const ps1Text = () => readScript("install.ps1").replace(/\r\n/g, "\n");
const cmdText = () => readScript("install.cmd").replace(/\r\n/g, "\n");

function extractPs1QwenRegions(): string {
  const ps = ps1Text();
  return [
    extractRegion(ps, "# --- Qwen Code commands (only when Qwen Code is detected) ---", "# Captured tail of git's stderr", "the Qwen Code commands in install.ps1"),
    extractRegion(ps, "# --- Qwen Code extension (only when Qwen Code is detected) ---", "\nif (-not $checkoutFailed) {\n    try { Install-QwenExtensionIfPresent", "the Qwen Code extension in install.ps1"),
  ].join("\n");
}

function extractCmdQwenBlock(): string {
  return extractRegion(cmdText(), "REM BEGIN Qwen Code subroutines", "REM END Qwen Code subroutines", "the Qwen Code subroutines in install.cmd");
}

// install.cmd's PowerShell program, put together as install.cmd does.
function cmdQwenProgramLines(): string[] {
  const lines = extractCmdQwenBlock().split("\n");
  return lines.filter((line) => line.startsWith('set "PLN_QX_P')).map((line) => {
    const m = /^set "PLN_QX_P(\d{3})=(.*)"$/.exec(line);
    if (!m) throw new Error(`unexpected line: ${line}`);
    return m[2];
  });
}

describe("install.cmd's Qwen Code steps", () => {
  test("its PowerShell lines carry nothing cmd.exe would reinterpret, and are numbered in order", () => {
    const lines = extractCmdQwenBlock().split("\n").filter((line) => line.startsWith('set "PLN_QX_P'));
    expect(lines.length).toBeGreaterThan(10);
    lines.forEach((line, i) => expect(line.startsWith(`set "PLN_QX_P${String(i + 1).padStart(3, "0")}=`)).toBe(true));
    for (const line of cmdQwenProgramLines()) expect(line).not.toMatch(/["%!^]/);
  });

  test("its commands stay well under cmd.exe's 8191-character line limit", () => {
    for (const line of extractCmdQwenBlock().split("\n")) expect(line.length).toBeLessThan(2000);
  });

  test("runs as subroutines called outside any parenthesized block", () => {
    const cmd = cmdText();
    expect(cmd).toContain('\nif "!CHECKOUT_FAILED!"=="0" if "!QWEN_AVAILABLE!"=="1" call :InstallQwenExtension\n');
    expect(cmd).toContain("\ncall :QwenVersionCheck\nset \"CHECKOUT_FAILED=0\"\n");
  });
});

// Qwen state, as each runner reports it.
type QwenRunResult = { out: string; state: string; off: boolean; tooOld: boolean };
type QwenRunner = { name: string; run: (s: QwenPsSandbox, env?: Record<string, string>, skipSource?: string) => QwenRunResult };
type QwenPsSandbox = ReturnType<typeof setupQwenPs>;

const PS_SHELLS = (process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"]).map((name) => Bun.which(name)).filter(
  (path): path is string => !!path,
);

function setupQwenPs(roots: string[]) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-ps-qwen-test-"));
  roots.push(root);
  const stub = join(root, "stub bin");
  const qwenDir = join(root, "qwen home");
  const skillsTmp = join(root, "skills tmp");
  const src = join(skillsTmp, "qwen-extension");
  const data = join(root, "plannotator data");
  for (const dir of [stub, qwenDir, join(root, "tmp")]) mkdirSync(dir, { recursive: true });
  writeFakeQwen(stub);
  cpSync(join(scriptsDir, "..", "apps", "qwen-code", "extension"), src, { recursive: true });
  const log = join(root, "qwen-calls.log");
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => line.slice(line.indexOf("|") + 1).trim())
      : [];
  return {
    root,
    stub,
    qwenDir,
    skillsTmp,
    src,
    data,
    stable: join(data, "qwen-code", "extension"),
    log,
    calls,
    extensionCalls: () => calls().filter((call) => call.startsWith("extensions ")),
    ...qwenFiles(qwenDir),
  };
}

function qwenPsEnv(s: QwenPsSandbox, env: Record<string, string>): Record<string, string> {
  const base: Record<string, string> =
    process.platform === "win32"
      ? {
          // Only the system folders, so no real qwen on this machine's PATH is found.
          PATH: [
            s.stub,
            ...PS_SHELLS.map((shell) => join(shell, "..")),
            join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
            process.env.SystemRoot ?? "C:\\Windows",
            join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0"),
          ].join(";"),
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
          PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
          USERPROFILE: s.root,
          TEMP: join(s.root, "tmp"),
          TMP: join(s.root, "tmp"),
        }
      : { PATH: `${s.stub}:/usr/bin:/bin`, HOME: s.root, TMPDIR: join(s.root, "tmp") };
  return { ...base, QWEN_HOME: s.qwenDir, FAKE_QWEN_HOME: s.root, FAKE_QWEN_LOG: s.log, ...env };
}

function spawnPs(shell: string, s: QwenPsSandbox, body: string, env: Record<string, string>) {
  const driver = join(s.root, `driver-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(driver, body);
  const r = Bun.spawnSync([shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver], {
    env: qwenPsEnv(s, env),
    cwd: s.root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

function ps1Runner(shell: string): QwenRunner {
  return {
    name: `install.ps1 (${shell.split(/[\\/]/).pop()})`,
    run: (s, env = {}, skipSource) => {
      const body = [
        `$ErrorActionPreference = "Stop"`,
        `$qwenAvailable = $true`,
        `$skipQwenResolved = $${skipSource ? "true" : "false"}`,
        `$skipQwenSource = ${psQuote(skipSource ?? "")}`,
        `$skipSkillsResolved = $false`,
        `$qwenDir = ${psQuote(s.qwenDir)}`,
        `$configDir = ${psQuote(s.data)}`,
        extractPs1QwenRegions(),
        `Install-QwenExtensionIfPresent ${psQuote(s.src)}`,
        `Write-Host ("RESULT=" + $qwenExtensionState + ";" + $qwenExtensionOff + ";" + $qwenTooOld)`,
        `exit 0`,
      ].join("\n");
      const r = spawnPs(shell, s, body, env);
      const m = /RESULT=([^;]*);(\w+);(\w+)/.exec(r.out);
      if (!m) throw new Error(`no result: ${r.out}`);
      return { out: r.out, state: m[1], off: m[2] === "True", tooOld: m[3] === "True" };
    },
  };
}

// install.cmd's exit codes, as its :InstallQwenExtension reads them.
const CMD_STATES: Record<number, [string, boolean]> = {
  30: ["no-cli", false],
  31: ["current", false],
  32: ["installed", false],
  33: ["updated", false],
  34: ["failed", false],
  35: ["not-in-tag", false],
  37: ["linked", false],
  38: ["foreign", false],
  41: ["current", true],
  43: ["updated", true],
};

function cmdPsRunner(shell: string): QwenRunner {
  return {
    name: `install.cmd's PowerShell (${shell.split(/[\\/]/).pop()})`,
    run: (s, env = {}, skipSource) => {
      if (skipSource) throw new Error("install.cmd handles the opt-out in cmd.exe");
      const program = `${cmdQwenProgramLines().join("\n")}\nexit $rc\n`;
      const common = { PLN_QX_HOME: s.qwenDir, ...env };
      const version = spawnPs(shell, s, program, { ...common, PLN_QX_MODE: "version" });
      if (version.code === 36) return { out: version.out, state: "too-old", off: false, tooOld: true };
      expect(version.code).toBe(0);
      const r = spawnPs(shell, s, program, { ...common, PLN_QX_MODE: "extension", PLN_QX_SRC: s.src, PLN_QX_DATA: s.data });
      const [state, off] = CMD_STATES[r.code] ?? [`exit ${r.code}`, false];
      return { out: version.out + r.out, state, off, tooOld: false };
    },
  };
}

// install.cmd's own subroutines under cmd.exe (Windows only).
const cmdExeRunner: QwenRunner = {
  name: "install.cmd (cmd.exe)",
  run: (s, env = {}, skipSource) => {
    const driver = join(s.root, `driver-${Math.random().toString(36).slice(2)}.cmd`);
    const lines = [
      "@echo off",
      "setlocal EnableDelayedExpansion",
      'set "QWEN_AVAILABLE=1"',
      `set "SKIP_QWEN=${skipSource ? 1 : 0}"`,
      `set "SKIP_QWEN_SOURCE=${skipSource ?? ""}"`,
      'set "SKIP_SKILLS=0"',
      'set "QWEN_DIR=%DRV_QWEN_DIR%"',
      'set "SKILLS_TMP=%DRV_SKILLS_TMP%"',
      'set "_CONFIG_DIR=%DRV_DATA%"',
      'set "QWEN_EXTENSION_STATE="',
      "call :QwenVersionCheck",
      "call :InstallQwenExtension",
      "echo RESULT=!QWEN_EXTENSION_STATE!;!QWEN_TOO_OLD!",
      "exit /b 0",
      extractCmdQwenBlock(),
    ];
    writeFileSync(driver, lines.join("\r\n") + "\r\n");
    const r = Bun.spawnSync([process.env.ComSpec ?? "cmd.exe", "/d", "/c", driver], {
      env: qwenPsEnv(s, { DRV_QWEN_DIR: s.qwenDir, DRV_SKILLS_TMP: s.skillsTmp, DRV_DATA: s.data, ...env }),
      cwd: s.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = r.stdout.toString() + r.stderr.toString();
    const m = /RESULT=([^;\r\n]*);(\d)/.exec(out);
    if (!m) throw new Error(`no result: ${out}`);
    // cmd.exe keeps only ok / ok-off for a working extension.
    const state = { ok: "ok", "ok-off": "ok", "too-old": "too-old" }[m[1]] ?? m[1];
    return { out, state, off: m[1] === "ok-off", tooOld: m[2] === "1" };
  },
};

// install.cmd's program runs under pwsh directly; on Windows the cmd.exe
// runner covers it under Windows PowerShell 5.1 (what install.cmd starts),
// so it is not run under 5.1 a second time.
const QWEN_PS_RUNNERS: QwenRunner[] = [
  ...PS_SHELLS.map(ps1Runner),
  ...PS_SHELLS.filter((shell) => !/powershell(\.exe)?$/i.test(shell)).map(cmdPsRunner),
  ...(process.platform === "win32" ? [cmdExeRunner] : []),
];

// Windows PowerShell 5.1 on a CI runner takes many seconds per start.
const QWEN_PS_TIMEOUT_MS = process.platform === "win32" ? 300_000 : 120_000;

describe.skipIf(QWEN_PS_RUNNERS.length === 0)("Windows installers' Qwen Code steps (PowerShell, fake qwen)", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  const shipped = () => JSON.parse(qwenSource("qwen-extension.json")).version as string;

  for (const runner of QWEN_PS_RUNNERS) {
    // cmd.exe reports a working extension as "ok".
    const expectState = (r: QwenRunResult, state: string) =>
      expect(r.state).toBe(runner === cmdExeRunner && ["installed", "updated", "current"].includes(state) ? "ok" : state);

    test(`${runner.name}: installs from the data folder, then a re-run runs no extension command`, () => {
      const s = setupQwenPs(roots);
      const first = runner.run(s);
      expectState(first, "installed");
      expect(first.out).toContain("Qwen Code extension: installed (restart Qwen Code to load it).");
      expect(s.extensionCalls()).toEqual([`extensions install ${s.stable} --consent`]);
      expect(s.record().source).toBe(s.stable);
      expect(readFileSync(join(s.extension, "hooks", "hooks.json"), "utf8")).toBe(qwenSource("hooks/hooks.json"));
      const second = runner.run(s);
      expectState(second, "current");
      expect(second.out).toContain("Qwen Code extension: already up to date.");
      expect(s.extensionCalls()).toHaveLength(1);
    }, QWEN_PS_TIMEOUT_MS);

    test(`${runner.name}: another version is updated in place, and one turned off stays off`, () => {
      const s = setupQwenPs(roots);
      runner.run(s);
      s.turnOff("default");
      const before = s.policies();
      s.makeOlder();
      const r = runner.run(s);
      expectState(r, "updated");
      expect(r.off).toBe(true);
      expect(r.out).toContain("It stays turned off where you turned it off in Qwen Code.");
      expect(s.extensionCalls().slice(1)).toEqual(["extensions update plannotator"]);
      expect(s.installedVersion()).toBe(shipped());
      expect(s.policies()).toEqual(before);
    }, QWEN_PS_TIMEOUT_MS);

    test(`${runner.name}: an update qwen did not make is reported, the installed one kept`, () => {
      const s = setupQwenPs(roots);
      runner.run(s);
      s.makeOlder();
      const r = runner.run(s, { FAKE_QWEN_UPDATE_FAIL: "1" });
      expectState(r, "failed");
      expect(r.out).toContain("Qwen Code extension: could not update it (Update failed: disk full). The installed one was left as it was.");
      expect(s.installedVersion()).toBe("0.0.1");
    }, QWEN_PS_TIMEOUT_MS);

    test(`${runner.name}: a linked or a foreign extension is left alone`, () => {
      const linked = setupQwenPs(roots);
      linked.seedLink();
      const l = runner.run(linked);
      expectState(l, "linked");
      expect(linked.extensionCalls()).toEqual([]);
      const foreign = setupQwenPs(roots);
      foreign.seedForeign();
      const f = runner.run(foreign);
      expectState(f, "foreign");
      expect(f.out).toContain("installed from /elsewhere/plannotator, not by this installer");
      expect(foreign.extensionCalls()).toEqual([]);
    }, QWEN_PS_TIMEOUT_MS);

    test(`${runner.name}: a Qwen Code before 0.13.0 gets nothing`, () => {
      const s = setupQwenPs(roots);
      const r = runner.run(s, { FAKE_QWEN_VERSION: "0.12.0" });
      expect(r.tooOld).toBe(true);
      expect(r.out).toContain("Qwen Code 0.12.0 is older than 0.13.0, so nothing was installed for it. Update Qwen Code to use plan review.");
      expect(s.calls()).toEqual(["--version"]);
      expect(existsSync(s.extension)).toBe(false);
    }, QWEN_PS_TIMEOUT_MS);

    test(`${runner.name}: no qwen on PATH is reported, nothing runs`, () => {
      const s = setupQwenPs(roots);
      removeFakeQwen(s.stub);
      const r = runner.run(s);
      expectState(r, "no-cli");
      expect(r.out).toContain("Qwen Code extension: not installed (the qwen command is not on PATH).");
      expect(existsSync(s.extension)).toBe(false);
    }, QWEN_PS_TIMEOUT_MS);

    test(`${runner.name}: a qwen that hangs is stopped at the time limit`, () => {
      const s = setupQwenPs(roots);
      const r = runner.run(s, { FAKE_QWEN_HANG: "1", PLANNOTATOR_QWEN_EXTENSION_TIMEOUT: "2" });
      expectState(r, "failed");
      expect(r.out).toContain("could not install it (timed out after 2s)");
    }, QWEN_PS_TIMEOUT_MS);

    if (process.platform === "win32") {
      test(`${runner.name}: qwen.cmd is not run with a path cmd.exe would change`, () => {
        const odd = setupQwenPs(roots);
        const data = join(odd.root, "data 100%");
        const run = runner.run({ ...odd, data, stable: join(data, "qwen-code", "extension") });
        expectState(run, "failed");
        expect(run.out).toContain("a path has a character cmd.exe would change");
        expect(existsSync(odd.extension)).toBe(false);
      }, QWEN_PS_TIMEOUT_MS);
    }
  }

  for (const shell of PS_SHELLS) {
    test(`install.ps1 (${shell.split(/[\\/]/).pop()}): an opt-out runs nothing and says so`, () => {
      const s = setupQwenPs(roots);
      const r = ps1Runner(shell).run(s, {}, "-SkipQwen");
      expect(r.out).toContain("Qwen Code: detected, skipped (-SkipQwen).");
      expect(s.calls()).toEqual([]);
    }, QWEN_PS_TIMEOUT_MS);

    test(`install.ps1 (${shell.split(/[\\/]/).pop()}): the older enablement file's "!" rule counts as turned off`, () => {
      const s = setupQwenPs(roots);
      const runner = ps1Runner(shell);
      runner.run(s);
      s.makeOlder();
      expect(runner.run(s).off).toBe(false);
      s.makeOlder();
      writeFileSync(join(s.qwenDir, "extensions", "extension-enablement.json"), JSON.stringify({ plannotator: { overrides: ["!/*"] } }));
      expect(runner.run(s).off).toBe(true);
    }, QWEN_PS_TIMEOUT_MS);

    test(`install.ps1 (${shell.split(/[\\/]/).pop()}): Copy-SkillIfPresent replaces a linked skill and keeps what it pointed to`, () => {
      const s = setupQwenPs(roots);
      const shared = join(s.root, "agents skills", "plannotator-review");
      mkdirSync(shared, { recursive: true });
      writeFileSync(join(shared, "SKILL.md"), "shared copy\n");
      const skills = join(s.qwenDir, "skills");
      mkdirSync(skills, { recursive: true });
      symlinkSync(shared, join(skills, "plannotator-review"), process.platform === "win32" ? "junction" : "dir");
      const source = join(scriptsDir, "..", "apps", "qwen-code", "skills", "plannotator-review");
      const fn = extractRegion(ps1Text(), "function Copy-SkillIfPresent {", "\n# Captured tail of git's stderr", "Copy-SkillIfPresent");
      const body = `$ErrorActionPreference = "Stop"\n${fn.slice(0, fn.indexOf("\n}\n") + 3)}\nCopy-SkillIfPresent ${psQuote(source)} ${psQuote(skills)}\nexit 0\n`;
      const r = spawnPs(shell, s, body, {});
      expect(r.code).toBe(0);
      expect(readFileSync(join(shared, "SKILL.md"), "utf8")).toBe("shared copy\n");
      expect(readFileSync(join(skills, "plannotator-review", "SKILL.md"), "utf8")).toContain("is_background: true");
    }, QWEN_PS_TIMEOUT_MS);
  }
});

// F7 (#2338): install.ps1 under PowerShell. A run stopped between the swap's
// two moves left no plannotator.exe until the person reinstalled by hand. The
// next run now puts the binary it moved aside back before anything else, and
// the swap stages the new binary next to the target first, so its two moves
// are renames on one volume, back to back.
describe.skipIf(PS_SHELLS.length === 0)("install.ps1 always leaves a plannotator.exe (F7)", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), "plannotator-ps1-swap-test-"));
    roots.push(root);
    return root;
  }

  function runPs1Region(shell: string, region: string, vars: Record<string, string>) {
    const root = scratch();
    const driver = join(root, "driver.ps1");
    const lines = [`$ErrorActionPreference = "Stop"`, ...Object.entries(vars).map(([k, v]) => `$${k} = ${psQuote(v)}`), region, "exit 0", ""];
    writeFileSync(driver, lines.join("\n"));
    const env: Record<string, string> =
      process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: process.env.PATH ?? "", TEMP: root, TMP: root }
        : { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root };
    const r = Bun.spawnSync([shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  }

  function installDirWith(files: Record<string, string>): string {
    const dir = join(scratch(), "plannotator dir");
    mkdirSync(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  const recovery = () =>
    extractRegion(ps1Text(), '$targetExe = "$installDir\\plannotator.exe"\n\n# A run stopped', "# First plannotator release", "the plannotator.exe recovery in install.ps1");
  const swap = () =>
    extractRegion(ps1Text(), "# Stage the new binary next to the target first", '\nWrite-Host ""\nWrite-Host "plannotator $latestTag installed', "the binary swap in install.ps1");

  for (const shell of PS_SHELLS) {
    const name = shell.split(/[\\/]/).pop();

    test(`install.ps1 (${name}): a run stopped between the two moves gets its binary back first thing`, () => {
      const olderAside = `plannotator.exe.old-${"a".repeat(32)}`;
      const dir = installDirWith({ "plannotator.exe.old": "newest aside", [olderAside]: "older aside" });
      const older = (Date.now() - 60 * 60_000) / 1000;
      utimesSync(join(dir, olderAside), older, older);
      const r = runPs1Region(shell, recovery(), { installDir: dir });
      expect(r.code, r.out).toBe(0);
      expect(readFileSync(join(dir, "plannotator.exe"), "utf8")).toBe("newest aside");
      // A plannotator.exe that is there is never touched.
      const kept = installDirWith({ "plannotator.exe": "current", "plannotator.exe.old": "aside" });
      expect(runPs1Region(shell, recovery(), { installDir: kept }).code).toBe(0);
      expect(readFileSync(join(kept, "plannotator.exe"), "utf8")).toBe("current");
    }, QWEN_PS_TIMEOUT_MS);

    test(`install.ps1 (${name}): the swap puts the new binary in place and leaves no staged or aside copy`, () => {
      const dir = installDirWith({ "plannotator.exe": "old binary" });
      const tmpFile = join(installDirWith({ "download.tmp": "new binary" }), "download.tmp");
      const r = runPs1Region(shell, swap(), { installDir: dir, tmpFile });
      expect(r.code, r.out).toBe(0);
      expect(readFileSync(join(dir, "plannotator.exe"), "utf8")).toBe("new binary");
      expect(readdirSync(dir)).toEqual(["plannotator.exe"]);
      expect(existsSync(tmpFile)).toBe(false);
    }, QWEN_PS_TIMEOUT_MS);
  }
});
