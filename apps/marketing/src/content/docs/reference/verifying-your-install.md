---
title: "Verifying Your Install"
description: "SHA256 checksums and SLSA build provenance verification for Plannotator binaries."
sidebar:
  order: 4
section: "Reference"
---

Every released binary is accompanied by a SHA256 sidecar (verified automatically on every install) and a [SLSA build provenance](https://slsa.dev/) attestation signed via Sigstore and recorded in the public transparency log. The SHA256 check is mandatory and always runs. Provenance verification is **optional** — it's only needed if you want a cryptographic link from the binary back to the exact commit and workflow run that built it.

## Manual verification

Recommended for one-off audits. Requires the [GitHub CLI](https://cli.github.com) installed and authenticated (`gh auth login`). Replace `vX.Y.Z` with the tag of the version you installed — pinning the source ref and signer workflow gives you the "exact commit and workflow run" guarantee; `--repo` alone only proves the artifact was built by _some_ workflow in our repository.

**macOS / Linux:**

```bash
gh attestation verify ~/.local/bin/plannotator \
  --repo backnotprop/plannotator \
  --source-ref refs/tags/vX.Y.Z \
  --signer-workflow backnotprop/plannotator/.github/workflows/release.yml
```

**Windows (PowerShell installer):**

```powershell
gh attestation verify "$env:LOCALAPPDATA\plannotator\plannotator.exe" `
  --repo backnotprop/plannotator `
  --source-ref refs/tags/vX.Y.Z `
  --signer-workflow backnotprop/plannotator/.github/workflows/release.yml
```

**Windows (CMD installer):**

```cmd
gh attestation verify "%USERPROFILE%\.local\bin\plannotator.exe" ^
  --repo backnotprop/plannotator ^
  --source-ref refs/tags/vX.Y.Z ^
  --signer-workflow backnotprop/plannotator/.github/workflows/release.yml
```

**No gh login?** The attestations endpoint is world-readable for public repositories, so you can verify without authenticating: compute the binary's SHA256, fetch `https://api.github.com/repos/backnotprop/plannotator/attestations/sha256:<digest>` with plain `curl`, write each `attestations[].bundle` value to a file (one JSON document per line), and pass it via `--bundle <file>` alongside the same `--repo`/`--source-ref`/`--signer-workflow` flags. This is exactly what the installer's automatic verification does. Note the unauthenticated API allows 60 requests per hour per IP, and `gh` still needs network access to fetch the Sigstore trust root on every run.

For air-gapped or no-auth environments, see GitHub's docs on [verifying attestations offline](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/verifying-attestations-offline).

## Automatic verification during install

Provenance verification is **off by default** — the same default every major `curl | bash` installer uses (rustup, brew, bun, deno, helm). To have the installer additionally run `gh attestation verify` on every upgrade, enable it via any of the three mechanisms below. Precedence is CLI flag > env var > config file > default.

**1. Per-install flag** (one-shot):

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --verify-attestation
```

PowerShell: `... -VerifyAttestation`. Windows CMD: `install.cmd --verify-attestation`.

**2. Environment variable** (persist in your shell RC):

```bash
export PLANNOTATOR_VERIFY_ATTESTATION=1
```

**3. Config file** (persist shell-agnostic):

```bash
mkdir -p ~/.plannotator
echo '{ "verifyAttestation": true }' > ~/.plannotator/config.json
```

When enabled, the installer requires the `gh` CLI but **not** a `gh auth login`: it fetches the attestation bundle from GitHub's public attestations API (a single unauthenticated request) and verifies with `gh attestation verify --bundle`, pinning the same source ref and signer workflow as the manual commands above. On macOS/Linux the bundle extraction needs one JSON tool on PATH (node, python3, or jq); Windows uses PowerShell. If the bundle path is unavailable or does not complete, the installer falls back to gh's own authenticated fetch, which is where a login still helps. Verification always needs network access because the Sigstore trust root is fetched on every run; that failure is reported as a connectivity problem, distinct from a real provenance failure. Either way the install hard-fails rather than silently skipping verification. To force-skip for a single install, pass `--skip-attestation` (bash/cmd) or `-SkipAttestation` (PowerShell).

## Supported versions

Version pinning and provenance verification are fully supported from **v0.17.2 onwards** — the first release to ship native ARM64 Windows binaries and SLSA attestations. Pinning to a pre-v0.17.2 tag may work for default installs on macOS, Linux, and x64 Windows, but ARM64 Windows hosts will get a 404 and provenance verification will be rejected by the installer's pre-flight check.
