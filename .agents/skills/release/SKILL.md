---
name: release-plannotator
description: Prepare and execute a Plannotator release — draft release notes with full contributor credit, bump versions across all package files, build in dependency order, and kick off the tag-driven release pipeline. Use this skill whenever the user mentions preparing a release, bumping versions, writing release notes, tagging a release, or publishing. Also trigger when the user says things like "let's ship", "prep a release", "what's changed since last release", or "time to cut a new version".
---

# Plannotator Release

The process has four phases. Phase 1 (release notes) is where most of the work happens — present the draft for review before proceeding to later phases.

## Phase 1: Draft Release Notes

This is the most important phase. The release notes are the public face of each version and the primary way the community sees their contributions recognized.

### Step 1: Determine scope

1. Find the latest release tag: `git tag --sort=-v:refname | head -1`
2. Determine the new version number. Ask the user if unclear (patch, minor, or major).
3. Gather all changes since the last tag:
   - `git log --oneline <last-tag>..HEAD` for commit history
   - `git log --merges --oneline <last-tag>..HEAD` for merged PRs
4. For each PR, use `gh pr view <number> --json title,author,body,closedIssues,labels` to get details.

### Step 2: Research contributors

This is critical. Every person who participated in the release gets credit — not just PR authors.

For each PR and linked issue, collect:
- **PR authors** — the person who wrote the code
- **Issue reporters** — who filed the bug or feature request
- **Issue commenters** — who participated in the discussion with useful context
- **Discussion creators** — who started relevant GitHub Discussions
- **Feature requestors** — check the linked "closes #N" issues and their authors

Use the GitHub API via `gh`:
```bash
# Get issue details including author
gh issue view <number> --json author,title,body

# Get issue comments to find participants
gh api repos/backnotprop/plannotator/issues/<number>/comments --jq '.[].user.login'

# Get PR review comments
gh api repos/backnotprop/plannotator/pulls/<number>/comments --jq '.[].user.login'
```

### Step 3: Write the release notes

Read the reference release notes in `references/` for the canonical template structure. These are real release notes from previous versions — match their tone, structure, and level of detail.

- `release-notes-v0.13.0.md` — large release, 14 PRs, 3 first-time contributors, "New Contributors" + narrative "Contributors" section
- `release-notes-v0.12.0.md` — large community release, 14 PRs, 10 external, detailed narrative "Contributors" section
- `release-notes-v0.13.1.md` — small patch release, 2 PRs, no external authors, "Community" section focused on issue reporters

Pay attention to how each reference handles contributor crediting differently. Pick the pattern that fits the release's contributor profile — a release with many external PRs warrants a narrative "Contributors" section; a patch driven by issue reports uses a lighter "Community" section.

Write the file to the repo root as `RELEASE_NOTES_v<VERSION>.md`.

#### Structure

1. **X/Twitter follow link** — first line, always the same:
   ```
   Follow [@plannotator](https://x.com/plannotator) on X for updates
   ```

2. **"Missed recent releases?"** collapsible table — copy from the previous release's notes, then:
   - Add the previous release (the one you're succeeding) as the newest row
   - Keep roughly 10-12 rows; drop the oldest if needed
   - Each row: version link + comma-separated feature highlights (short phrases)

3. **"What's New in vX.Y.Z"** — the heart of the notes
   - Open with 1-3 sentences summarizing the release theme and scope. Mention how many PRs, how many from external contributors, any first-timers.
   - Each major feature/fix gets its own `###` subsection with:
     - A descriptive heading (not the PR title verbatim — rephrase for clarity)
     - 1-4 paragraphs explaining what changed and why it matters. Be specific and concrete. Describe the problem that existed before, what the change does, and how users experience it.
     - Credit line at the bottom: PR link, linked issues with `closing [#N]`, and contributor attribution
   - Minor changes go under `### Additional Changes` as bold-titled bullets

4. **Install / Update** — standard block, read from the previous release notes and reuse verbatim

5. **"What's Changed"** — bullet list of every PR in the release:
   ```
   - feat: descriptive PR title by @author in [#N](url)
   ```

6. **"New Contributors"** — if any first-time contributors:
   ```
   - @username made their first contribution in [#N](url)
   ```

7. **"Contributors" or "Community"** — narrative section recognizing everyone who participated:
   - PR authors get a sentence about what they built
   - Issue reporters and commenters get listed with what they reported/discussed
   - Group community issue reporters in a bullet list at the end

8. **Full Changelog link**:
   ```
   **Full Changelog**: https://github.com/backnotprop/plannotator/compare/<prev-tag>...<new-tag>
   ```

#### Writing guidelines

- **Narrative over noise.** Write in clear, readable prose. Not marketing-speak, not changelog-dump. Explain what changed and why someone should care, in plain language.
- **Bullets where they help.** Use bullet lists for enumerating discrete items (additional changes, contributor lists). Use paragraphs for explaining features.
- **No cliches or buzzwords.** Don't say "exciting", "game-changing", "seamless", "powerful". Just describe what happened.
- **No punchlines.** Don't end sections with a clever quip or a summary zinger. Let the feature speak for itself.
- **Speak through practical benefit.** Describe what changed and what it means for the user in concrete, reliable terms. Not aspirational, not hype — just what it does.
- **Don't overuse em dashes.** One or two per release is fine. If you notice them stacking up, restructure the sentence instead.
- **Grammatical structure matters.** Vary sentence structure. Active voice. Concrete subjects and verbs.
- **Contributor tags.** Use `@username` — bare at-mentions, not markdown links like `[@user](url)`. GitHub renders bare `@mentions` with avatar icons in release notes. This is important for community recognition.
- **Every contributor counts.** Everyone who filed an issue, left a comment that shaped a decision, or participated in a discussion gets mentioned. This project's community is its lifeblood.

### Step 4: Present for review

Write the draft to `RELEASE_NOTES_v<VERSION>.md` in the repo root and tell the user it's ready for review. Do not `git add` or commit this file — release notes are kept untracked by design. Wait for their feedback before proceeding to Phase 2.

---

## Phase 2: Version Bump

Bump the version string in these **7 files** (and only these — other package.json files use stub versions):

| File | Field |
|------|-------|
| `package.json` (root) | `"version"` |
| `apps/opencode-plugin/package.json` | `"version"` |
| `apps/pi-extension/package.json` | `"version"` |
| `apps/hook/.claude-plugin/plugin.json` | `"version"` |
| `apps/copilot/plugin.json` | `"version"` |
| `openpackage.yml` (root) | `version:` |
| `packages/server/package.json` | `"version"` |

Read each file, confirm the current version matches expectations, then update all 7 atomically.

Do not bump the VS Code extension (`apps/vscode-extension/package.json`) — it has independent versioning.

---

## Phase 3: Build

Run builds in dependency order:

```bash
bun run build:review    # 1. Code review editor (standalone Vite build)
bun run build:hook      # 2. Plan review + hook server (copies review's built HTML into hook dist)
bun run build:opencode  # 3. OpenCode plugin (copies built HTML from hook + review)
bun run build:pi        # 4. Pi extension (chains review → hook → pi internally, safe to run after 1-2)
```

`build:pi` chains review and hook internally, so after steps 1-2 it only runs the pi-specific build.

Verify all builds succeed before proceeding.

### Pi Parity Gate

After builds pass, audit the Pi extension to ensure all server-side imports resolve in the published package. This catches missing files before they reach npm.

1. **Check imports vs `files` array.** Trace all local imports (starting with `./` or `../`) from `index.ts`, `server.ts`, `tool-scope.ts`, and every file in `server/`. Verify each target is covered by a pattern in the `files` array of `apps/pi-extension/package.json`.

2. **Check `vendor.sh` covers all shared/ai imports.** Every `../generated/*.js` import in the server files must have a corresponding entry in `vendor.sh`'s copy loops. If a new shared module or AI module was added to `packages/shared/` or `packages/ai/` and is imported by Pi's server code, it must be added to `vendor.sh`.

3. **Dry-run the pack.** Run `cd apps/pi-extension && bun pm pack --dry-run` and verify the output includes every file the server imports. Look specifically for any newly added files since the last release.

4. **Quick smoke test.** Confirm `generated/` contains all expected files after build, especially any new ones (e.g., a new shared module added in this release cycle).

If anything is missing, fix it before proceeding to Phase 4. Common fixes:
- Add the file to `vendor.sh`'s copy loop
- Add the file or directory to the `files` array in `package.json`
- Add an import path fix (Pi uses `../generated/` not `@plannotator/shared` or `@plannotator/ai`)

---

## Phase 4: Commit, Tag, and Release

1. **Commit the version bump:**
   ```
   chore: bump version to X.Y.Z
   ```
   Stage only the 7 version-bumped files. Do not stage the release notes file (it's untracked by design).

2. **Create and push the tag:**
   ```bash
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```
   The `v*` tag push triggers the release pipeline (`.github/workflows/release.yml`).

3. **The pipeline handles everything else:**
   - Runs tests
   - Cross-compiles binaries for 6 platforms (macOS ARM64/x64, Linux x64/ARM64, Windows x64/ARM64)
   - Compiles paste service binaries (same 6 platforms)
   - Packs the two npm packages in a credential-free job
   - Downloads pinned, checksum-verified Syft and Grype binaries; generates and schema-validates the release-wide CycloneDX SBOM after all shipped subjects exist
   - Forces the repository-owned, suppression-free Grype configuration, retries the official database update up to three times, requires a valid/active schema-v6 database no more than 120 hours old with no pending update, and preserves the machine-readable scan/database/policy evidence as a workflow artifact
   - Rejects every scanner-side ignored match, then blocks before any attestation or publication on CISA KEV or fixable Critical findings classified as shipped/runtime or unknown-applicability. High, development-only, and no-fix Critical findings are report-only but remain in the evidence
   - Generates SLSA build provenance attestations for all 12 binaries via `actions/attest-build-provenance` (signed through Sigstore, recorded in Rekor)
   - Uses the separate official `actions/attest` SBOM path to bind the CycloneDX predicate to all 12 binaries and both npm tarballs through the same GitHub OIDC/Sigstore service. This is an inventory attestation, not a replacement for SLSA or npm provenance
   - Creates the GitHub Release with all binaries, SHA256 sidecars, the versioned CycloneDX SBOM, and its SHA256 sidecar attached
   - Publishes `@plannotator/opencode` and `@plannotator/pi-extension` to npm with provenance

   **SBOM scope:** the public document is a release-wide Syft inventory of the monorepo's locked build inputs and dependencies. It is deliberately not described as exact binary runtime contents. Coverage testing found that Bun standalone executables hide bundled JavaScript dependency metadata from Syft. The OpenCode tarball is similarly opaque; the Pi tarball exposes only a partial view through nested package-lock files. The scope and limitations are also embedded in the CycloneDX metadata.

   **Exceptions:** there is no active production exception file. If a future release baseline needs one, do not add a loose ignore. Add a repository-reviewed OpenVEX document and explicitly wire it through `PLANNOTATOR_RELEASE_VEX`; each statement must match one exact package URL and vulnerability ID and carry `not_affected` status, an OpenVEX justification, impact statement, HTTPS evidence, owner, created date, and expiration date. The policy tests reject expired, malformed, broad, and nonmatching records.

   **Note on immutable releases:** The repo has GitHub Immutable Releases enabled, so once the `v*` tag is pushed and the release is created, the tag→commit and tag→asset bindings are permanent. You cannot delete and re-create a tag to "fix" a bad release — you must ship a new version. Release notes remain editable (see step 5), but everything else is locked.

4. **Monitor the pipeline:**
   Watch the release workflow run until it completes:
   ```bash
   gh run list --workflow=release.yml --limit=1
   gh run view <run-id> --log
   ```
   Verify:
   - All jobs pass, including `release-security`, `attest`, `release`, and `npm-publish`
   - `release-security-evidence` records the Syft/Grype versions, active database schema/build/checksum/update status, all Grype matches, and an `ACCEPT` policy decision
   - The GitHub Release was created with all binary artifacts, SHA256 sidecars, the versioned `plannotator-X.Y.Z-release-sbom.cdx.json`, and its `.sha256` sidecar
   - npm packages published successfully (check with `npm view @plannotator/opencode version` and `npm view @plannotator/pi-extension version`)

   A pull request proves generation, schema/sentinel validation, database policy, Grype evaluation, least-privilege job wiring, and all report artifacts. GitHub OIDC issuance, publication to the artifact-attestation service, and final release-asset publication only run for a real eligible `v*` tag. For the first release after this control lands, complete this bounded tag-only verification before calling the rollout complete:

   Before tagging that first release, update the canonical Mintlify page at `https://docs.plannotator.ai/open-source/start/installation#pin-or-verify-a-release` with the SBOM scope/limitations, Grype policy, download/checksum commands, and both predicate-verification commands from the README. The legacy Astro files under `apps/marketing/src/content/docs/` are redirect-only/deprecated copies and are not the public documentation source. Confirm the live Mintlify page contains the material; do not let its publication lag the shipped control.

   ```bash
   tag=vX.Y.Z
   version="${tag#v}"
   gh release download "$tag" --pattern 'plannotator-linux-x64*' --pattern "plannotator-${version}-release-sbom.cdx.json*" --dir /tmp/plannotator-release-verify
   (cd /tmp/plannotator-release-verify && sha256sum --check plannotator-linux-x64.sha256)
   (cd /tmp/plannotator-release-verify && sha256sum --check "plannotator-${version}-release-sbom.cdx.json.sha256")

   gh attestation verify /tmp/plannotator-release-verify/plannotator-linux-x64 \
     --repo backnotprop/plannotator \
     --source-ref "refs/tags/$tag" \
     --signer-workflow backnotprop/plannotator/.github/workflows/release.yml \
     --predicate-type https://slsa.dev/provenance/v1

   gh attestation verify /tmp/plannotator-release-verify/plannotator-linux-x64 \
     --repo backnotprop/plannotator \
     --source-ref "refs/tags/$tag" \
     --signer-workflow backnotprop/plannotator/.github/workflows/release.yml \
     --predicate-type https://cyclonedx.org/bom
   ```

   Also extract the attested CycloneDX predicate with `gh attestation verify --format json --jq '.[0].verificationResult.statement.predicate'`, canonicalize both it and the downloaded release SBOM with `jq -S`, and `cmp` them. Verify one npm tarball subject the same way if you download the exact published tarball. Record any tag-only discrepancy as a release blocker and ship a new version rather than mutating an immutable release.

   If anything fails, investigate the logs and report to the user before retrying.

5. **Replace the release notes:**
   Once the release is live and verified, replace the auto-generated notes body with the drafted release notes:
   ```bash
   gh release edit vX.Y.Z --notes-file RELEASE_NOTES_v<VERSION>.md
   ```

---

## Checklist

Before tagging, verify:
- [ ] All 7 version files bumped consistently
- [ ] Release notes drafted and reviewed
- [ ] `bun run build:review` succeeded
- [ ] `bun run build:hook` succeeded
- [ ] `bun run build:opencode` succeeded
- [ ] `bun run build:pi` succeeded (or pi-specific build step)
- [ ] Version bump committed
- [ ] Pi parity gate passed (imports, vendor.sh, dry-run pack)
- [ ] No stale build artifacts (clean builds, no cache issues — run `bun install` first if dependencies changed)
- [ ] The PR-safe `release-security` job generated a schema-valid, sentinel-complete SBOM and accepted the Grype policy with a fresh database
- [ ] No scanner binary, database, generated SBOM/report, credential, or `DO_NOT_COMMIT` content is staged
- [ ] For the first SBOM-enabled release, the canonical Mintlify install/verification page contains the README's SBOM scope, policy, checksum, SLSA, and CycloneDX commands (do not edit the deprecated Astro docs instead)

After tagging, verify:
- [ ] Release workflow completed with `release-security`, `attest`, `release`, and `npm-publish` green
- [ ] GitHub Release created with all binaries, sidecars, SBOM, and SBOM sidecar
- [ ] One native binary passes both the explicit SLSA and CycloneDX predicate checks pinned to the tag and signer workflow
- [ ] Downloaded SBOM checksum passes and canonical JSON matches the attested predicate
- [ ] `release-security-evidence` shows a fresh/active database and an accepted policy decision
- [ ] npm packages published at correct version
- [ ] npm trusted-publishing provenance remains visible for both packages
- [ ] Release notes replaced via `gh release edit`
