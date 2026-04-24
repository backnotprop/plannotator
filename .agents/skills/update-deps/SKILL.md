---
name: update-deps
description: Audit and update npm/Bun dependencies with supply chain integrity checks — verifies maintainers, publish age, tarball diffs, and provenance before bumping. Defers risky packages to ~/.supply-chain/notes/.
disable-model-invocation: true
---

# Update Dependencies

Audit outdated packages, verify supply chain integrity, bump what's safe, defer what needs review, and log everything.

This process has three phases: discovery, integrity audit, and execution. The integrity audit is the most important — every package gets checked before it touches the lockfile.

## Phase 1: Discovery

Run `bun outdated` to get the full list of packages with available updates.

```bash
bun outdated
```

Parse the output into a structured list. For each package, note:
- Package name
- Current version
- Available update version
- Whether it's age-gated (indicated by `*` in the output — the footnote "The * indicates that version isn't true latest due to minimum release age" confirms this)
- Whether it's a runtime dep, dev dep, or peer dep

Also check whether any packages are blocked entirely by the age gate (like `@pierre/diffs` was when its minimum semver range couldn't resolve). Flag these separately — they may need `minimumReleaseAgeExcludes` in `bunfig.toml`.

## Phase 2: Integrity Audit

This is the core of the process. Spawn one **Sonnet sub-agent per package** to run the integrity check in parallel. Sonnet is used here because these are independent, structured verification tasks that don't need heavier reasoning.

Each sub-agent receives the package name, current version, and target version, and performs the following checks:

### Sub-agent prompt template

For each outdated package, spawn a Sonnet agent with this task:

```
You are auditing the npm package "{package}" for a version bump from {current} to {target}.

Run these checks and report back with a JSON object:

1. **Maintainer verification**: Check if maintainers changed between versions.
   npm view {package}@{current} maintainers --json
   npm view {package}@{target} maintainers --json
   Compare the two lists. Flag any additions or removals.

2. **Publish date and age**: Get the publish timestamp.
   npm view {package} time --json
   Extract the date for version {target}. Calculate days since publication.
   Flag if younger than 7 days.

3. **Provenance**: Check if the package has registry signatures or attestations.
   npm audit signatures (if not already run this session)
   Note whether the package has provenance attestations.

4. **Tarball diff**: Show what actually changed in the published package.
   npm diff --diff={package}@{current} --diff={package}@{target}
   Summarize the changes:
   - How many files changed
   - Are changes limited to version bumps, deps, and rebuilt dist? Or are there meaningful source changes?
   - Any new runtime dependencies added?
   - Any suspicious patterns (obfuscated code, eval(), network calls in unexpected places)

5. **Release notes**: Try to find what changed.
   Check the package's repository for release notes or changelog:
   npm view {package}@{target} repository.url
   gh release view v{target} --repo <owner/repo> (try with and without v prefix)
   Summarize the changelog if found.

Report your findings as JSON:

{{
  "package": "{package}",
  "from": "{current}",
  "to": "{target}",
  "age_days": <number>,
  "maintainers_changed": <boolean>,
  "maintainers_added": [],
  "maintainers_removed": [],
  "provenance": <boolean>,
  "new_runtime_deps": [],
  "files_changed": <number>,
  "has_source_changes": <boolean>,
  "changelog_summary": "<brief summary>",
  "suspicious_patterns": [],
  "verdict": "safe" | "review" | "defer",
  "verdict_reason": "<one sentence explanation>"
}}

Verdict guidelines:
- "safe": Same maintainers, no new runtime deps, changes match what changelog describes, no suspicious patterns
- "review": Minor concerns (e.g., new maintainer who is clearly from the same org, small new dep from known publisher)
- "defer": Maintainer changes from unknown accounts, new runtime deps with unclear purpose, suspicious code patterns, substantive API changes that need integration testing
```

### Collecting results

As sub-agents complete, collect their JSON reports. If a sub-agent fails or times out, mark that package as "defer" with reason "audit failed".

### Tier classification

After collecting all results, classify packages into tiers. This helps the user understand the risk profile at a glance:

| Tier | Description | Typical action |
|------|-------------|----------------|
| **Runtime, high surface** | Libraries your code calls directly (parsers, diff engines, UI libs) | Check provenance, review diff, run tests |
| **SDK/API deps** | Third-party service SDKs (agent SDKs, platform integrations) | Read changelog for API changes, test integration |
| **Dev-only** | Type definitions, build tools, test frameworks | Update freely — these don't ship |
| **Build toolchain** | Bun itself, compilers, bundlers | Most caution — breakage affects all outputs |

## Phase 3: Execution

### Bump safe packages

For all packages with verdict "safe":

```bash
bun update pkg1@version1 pkg2@version2 ...
```

If the update fails due to age gate conflicts (a package's minimum semver can't resolve), add it to `minimumReleaseAgeExcludes` in `bunfig.toml` and document why.

### Log to supply chain notes

Write the full audit results to `~/.supply-chain/notes/<YYYY-MM-DD>.json`:

```json
{
  "date": "YYYY-MM-DD",
  "project": "plannotator",
  "bumped": [
    {
      "package": "...",
      "from": "...",
      "to": "...",
      "age_days": 0,
      "maintainers_changed": false,
      "provenance": false,
      "notes": "..."
    }
  ],
  "deferred": [
    {
      "package": "...",
      "current": "...",
      "available": "...",
      "age_days": 0,
      "maintainers_changed": false,
      "reason": "...",
      "review_by": "YYYY-MM-DD"
    }
  ],
  "excluded_from_age_gate": [
    {
      "package": "...",
      "reason": "..."
    }
  ]
}
```

Set `review_by` to 7 days from today for deferred packages.

### Check previously deferred packages

Read all files in `~/.supply-chain/notes/` and collect any deferred packages from previous audits that are still at the same version in the current lockfile. These are packages that were deferred before and still haven't been updated.

To check: for each previously deferred entry, see if the current installed version matches the `current` field from the deferral note. If it does, the package is still deferred.

## Phase 4: Recap

Present a clear summary to the user:

### Updated
List each bumped package with version change and one-line reason it was safe.

### Deferred
List each deferred package with version change and reason for deferral.

### Still Deferred (from previous audits)
List any packages that were deferred in previous audit sessions and still haven't been bumped. Include the original deferral date and reason. This is the "you've been putting this off" section — it keeps deferred packages from being forgotten.

If the still-deferred list is empty, say so — that's a good sign.

### Age Gate Exclusions
If any packages were added to `minimumReleaseAgeExcludes`, note them and why.
