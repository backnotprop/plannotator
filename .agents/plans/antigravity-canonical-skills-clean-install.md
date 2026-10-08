# Plan: Antigravity CLI Plugin Canonical Structure & Clean Reinstall Alignment

Align Antigravity CLI plugin skills to the canonical prefixed naming standard (`plannotator-plan`, `plannotator-annotate`, `plannotator-review`), eliminate obsolete duplicate un-prefixed skills (`plan`, `annotate`, `review`, `last`), update installer scripts (`install.ps1`, `install.sh`, `install.cmd`) to enforce atomic wholesale replacement on install/reinstall, and clarify CLI-exclusive target context in plugin rules (`rules/AGENTS.md`), README, and plugin metadata without touching individual skill prompt bodies.

---

## 1. Problem Statement & Root Cause

1. **Skill Duplication & Collision**:
   - `~/.gemini/config/plugins/plannotator/skills/` currently contains 7 skills: 4 legacy un-prefixed ones (`plan`, `annotate`, `review`, `last`) and 3 prefixed ones (`plannotator-plan`, `plannotator-annotate`, `plannotator-review`).
   - The un-prefixed `plan` skill conflicts with Antigravity's native planning system.
   - The workspace plugin template at `.agents/plugins/plannotator/skills/` holds legacy un-prefixed skills (`plan`, `annotate`, `review`, `last`), causing drift from `apps/antigravity/skills/`.
2. **Non-Atomic Installer Staging**:
   - `scripts/install.ps1`, `scripts/install.sh`, and `scripts/install.cmd` currently write an inline un-prefixed `skills/plan/SKILL.md` (`name: plan`) and do not perform a clean wipe of `$antigravityPluginsDir`.
   - Subsequent installs or updates merge directory contents instead of replacing them wholesale, leaving legacy/orphaned skills behind.
3. **Surface Ambiguity in Documentation & Rules**:
   - `apps/antigravity/README.md` and `.agents/plugins/plannotator/README.md` previously claimed support across all surfaces ("Antigravity 2.0 and Antigravity IDE"), but the plugin is strictly scoped to **Antigravity CLI (`agy`)** because 2.0 Desktop and IDE possess their own built-in planning mode and UI.
   - Per feedback, skill files (`SKILL.md`) should remain clean, while the surface context and host isolation are properly documented in `rules/AGENTS.md`, `README.md`, and `plugin.json`.

---

## 2. Blast Radius Analysis

Files affected and their downstream consumers:

| File | Change | Blast Radius / Consumers |
| :--- | :--- | :--- |
| `.agents/plugins/plannotator/skills/` | Remove `plan/`, `annotate/`, `review/`, `last/`. Add `plannotator-plan/`, `plannotator-annotate/`, `plannotator-review/`. | Workspace-local Antigravity plugin. Affects agents running inside this repository. No build or CI scripts consume this path. |
| `.agents/plugins/plannotator/README.md` & `apps/antigravity/README.md` | Update READMEs to specify CLI exclusivity (clarifying that 2.0 Desktop and IDE use native planning). | Documentation only. Zero runtime execution impact. |
| `apps/antigravity/plugin.json` & `.agents/plugins/plannotator/plugin.json` | Clarify description: specifically for Antigravity CLI. | Plugin manifest read by `agy plugin validate` and `agy plugin list`. Schema remains strictly valid JSON. |
| `apps/antigravity/rules/AGENTS.md` & `.agents/plugins/plannotator/rules/AGENTS.md` | Add explicit surface context: states that Plannotator protocol runs strictly in Antigravity CLI terminal sessions (`agy`), while Antigravity 2.0 Desktop and IDE use native planning. | Agent rules injected by Antigravity engine into system prompt context. Keeps individual skill files clean. |
| `scripts/install.ps1` | Replace inline un-prefixed `skills/plan` with wholesale directory wipe + install of canonical 3 skills, updated rules, hooks, and manifest. | Windows PowerShell users running `install.ps1`. Guarantees clean reinstall without leftover files. |
| `scripts/install.sh` | Replace inline un-prefixed `skills/plan` with `rm -rf "$antigravity_plugins_dir"` + clean staging of 3 canonical skills. | Linux/macOS users running `install.sh`. |
| `scripts/install.cmd` | Replace inline un-prefixed `skills/plan` with `rmdir /s /q` + clean staging of 3 canonical skills. | Windows Command Prompt users running `install.cmd`. |
| `C:\Users\dell\.gemini\config\plugins\plannotator\` | Clean wipe and fresh copy from `apps/antigravity/`. | User's live global Antigravity installation. Clears out the 4 stale legacy skills immediately. |

---

## 3. Proposed Changes

### A. Surface Exclusivity & Template Alignment
- **Surface Context in Rules (`rules/AGENTS.md`)**:
  - In `apps/antigravity/rules/AGENTS.md` and `.agents/plugins/plannotator/rules/AGENTS.md`, add an explicit note in Section 1 (Core Capabilities & Architecture):
    > **Surface Scope**: Plannotator is designed strictly for **Antigravity CLI (`agy`)** terminal sessions. When operating inside Antigravity 2.0 Desktop or Antigravity IDE, agents should rely on the host's native built-in Planning Mode.
  - Leave individual `SKILL.md` bodies untouched as requested.
- **Documentation & Manifest**:
  - Update `apps/antigravity/README.md` and `.agents/plugins/plannotator/README.md`:
    - Title: "Plannotator for Antigravity CLI"
    - Clarify: Strictly for Antigravity CLI (`agy`). Antigravity 2.0 Desktop and Antigravity IDE use their own built-in planning mode and UI.
  - Update `plugin.json` description: "Interactive browser-based plan review, code review diffs, and document annotation for Antigravity CLI."
- **Synchronize Repository Plugin Directories**:
  - Remove legacy un-prefixed skills (`plan/`, `annotate/`, `review/`, `last/`) from `.agents/plugins/plannotator/skills/`.
  - Copy the 3 canonical prefixed skills (`plannotator-plan/`, `plannotator-annotate/`, `plannotator-review/`) into `.agents/plugins/plannotator/skills/`.
  - Ensure `apps/antigravity/` and `.agents/plugins/plannotator/` are synchronized 1:1.

### B. Installer Scripts Wholesale Replacement (`install.ps1`, `install.sh`, `install.cmd`)
- **Clean Wipe on Install**:
  - In `install.ps1`:
    ```powershell
    if (Test-Path $antigravityPluginsDir) {
        Remove-Item -Path $antigravityPluginsDir -Recurse -Force
    }
    ```
  - In `install.sh`:
    ```bash
    rm -rf "$antigravity_plugins_dir"
    ```
  - In `install.cmd`:
    ```cmd
    if exist "!ANTIGRAVITY_CONFIG_DIR!\plugins\plannotator\" (
        rmdir /s /q "!ANTIGRAVITY_CONFIG_DIR!\plugins\plannotator" >nul 2>&1
    )
    ```
- **Install Canonical Prefixed Skills**:
  - Re-create `$antigravityPluginsDir` freshly.
  - Install the 3 canonical prefixed skills:
    - `skills/plannotator-plan/SKILL.md`
    - `skills/plannotator-annotate/SKILL.md`
    - `skills/plannotator-review/SKILL.md`
  - Write `rules/AGENTS.md` (with surface scope context), `hooks.json`, and `plugin.json`.
  - Eliminate the legacy un-prefixed `skills/plan/` inline generation.

### C. Live Environment Clean Staging
- Wipe the live installed directory `~/.gemini/config/plugins/plannotator`.
- Re-stage freshly from updated `apps/antigravity`.
- Run `agy plugin validate` to confirm exactly 3 skills and 1 hook are processed with zero duplicates.

---

## 4. Verification Plan

1. **Unit Tests**:
   - Run `bun test apps/hook/server/antigravity-plan.test.ts` (ensures hook gating logic remains 100% passing).
2. **Plugin Validation**:
   - Run `agy plugin validate C:\Users\dell\.gemini\config\plugins\plannotator`.
   - Verify output: `skills: 3 processed`, `hooks: 1 processed` (no extra or missing skills).
3. **Live Directory Verification**:
   - Inspect `~/.gemini/config/plugins/plannotator/skills` to confirm only `plannotator-plan`, `plannotator-annotate`, and `plannotator-review` exist.
4. **Git Inspection**:
   - Run `git status` and `git diff` across `scripts/install.*`, `apps/antigravity/`, and `.agents/plugins/plannotator/` to ensure no unexpected files were touched.
