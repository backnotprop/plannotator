#!/usr/bin/env bash
set -euo pipefail

workspace="${GITHUB_WORKSPACE:-$(pwd)}"
subjects_dir="${PLANNOTATOR_RELEASE_SUBJECTS_DIR:?Set PLANNOTATOR_RELEASE_SUBJECTS_DIR to the downloaded release subjects}"
output_dir="${PLANNOTATOR_RELEASE_SECURITY_DIR:?Set PLANNOTATOR_RELEASE_SECURITY_DIR to an empty output directory}"
repository="https://github.com/${GITHUB_REPOSITORY:-backnotprop/plannotator}"
commit="${GITHUB_SHA:-$(git -C "$workspace" rev-parse HEAD)}"
version="$(jq -r .version "$workspace/package.json")"

syft_version="1.51.0"
syft_commit="2293641e3bd628a01bb37639318d62c0ebe89b39"
syft_manifest_sha256="3d85f1d0e1266cae4346514124665f10b7cefd9cce815be13921d199917e5581"
syft_archive_sha256="2a2e837a2c8d59ec9af5472ee22d3b04ee463c4e44476ecf993fd1e5ab6ebc7f"

grype_version="0.117.0"
grype_commit="b5fa92bbcbef655497e3be840a2f718380e2cdd3"
grype_manifest_sha256="960a8acecdd2fa4b20520cb04d7e11ab40df58fc22769b513a25b8257d18dcfe"
grype_archive_sha256="38525dab1e06f162ebaa02f94d82d1f807076b011a44180cf2777edf1a7b9c26"

cyclonedx_version="0.33.1"
cyclonedx_commit="b3cfa4b0edc356dad07e0b6e7ab6da0a94af0246"
cyclonedx_sha256="bfc8b2538da86fe239bc53658bbb63c1c8c510a293c1e6891aa5bea5d3c58746"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "run-release-security.sh supports the release workflow's Linux x64 runner only" >&2
  exit 1
fi
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Release commit must be a full 40-character SHA: $commit" >&2
  exit 1
fi

tools_dir="$output_dir/tools"
downloads_dir="$output_dir/downloads"
sbom_input="$output_dir/sbom-input"
evidence_dir="$output_dir/evidence"
public_dir="$output_dir/public"
db_dir="$output_dir/grype-db"
grype_config="$workspace/scripts/release-security/grype.yaml"
mkdir -p "$tools_dir" "$downloads_dir" "$sbom_input" "$evidence_dir" "$public_dir" "$db_dir"

if [[ ! -f "$grype_config" ]]; then
  echo "Pinned Grype configuration is missing: $grype_config" >&2
  exit 1
fi

download() {
  local url="$1"
  local destination="$2"
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 --output "$destination" "$url"
}

verify_sha256() {
  local expected="$1"
  local file="$2"
  printf '%s  %s\n' "$expected" "$file" | sha256sum --check --strict -
}

syft_archive="$downloads_dir/syft_${syft_version}_linux_amd64.tar.gz"
syft_manifest="$downloads_dir/syft_${syft_version}_checksums.txt"
download "https://github.com/anchore/syft/releases/download/v${syft_version}/syft_${syft_version}_linux_amd64.tar.gz" "$syft_archive"
download "https://github.com/anchore/syft/releases/download/v${syft_version}/syft_${syft_version}_checksums.txt" "$syft_manifest"
verify_sha256 "$syft_manifest_sha256" "$syft_manifest"
verify_sha256 "$syft_archive_sha256" "$syft_archive"
(
  cd "$downloads_dir"
  grep "  $(basename "$syft_archive")$" "$(basename "$syft_manifest")" | sha256sum --check --strict -
)
tar -xzf "$syft_archive" -C "$tools_dir" syft

grype_archive="$downloads_dir/grype_${grype_version}_linux_amd64.tar.gz"
grype_manifest="$downloads_dir/grype_${grype_version}_checksums.txt"
download "https://github.com/anchore/grype/releases/download/v${grype_version}/grype_${grype_version}_linux_amd64.tar.gz" "$grype_archive"
download "https://github.com/anchore/grype/releases/download/v${grype_version}/grype_${grype_version}_checksums.txt" "$grype_manifest"
verify_sha256 "$grype_manifest_sha256" "$grype_manifest"
verify_sha256 "$grype_archive_sha256" "$grype_archive"
(
  cd "$downloads_dir"
  grep "  $(basename "$grype_archive")$" "$(basename "$grype_manifest")" | sha256sum --check --strict -
)
tar -xzf "$grype_archive" -C "$tools_dir" grype

cyclonedx_binary="$tools_dir/cyclonedx"
download "https://github.com/CycloneDX/cyclonedx-cli/releases/download/v${cyclonedx_version}/cyclonedx-linux-x64" "$cyclonedx_binary"
verify_sha256 "$cyclonedx_sha256" "$cyclonedx_binary"
chmod +x "$tools_dir/syft" "$tools_dir/grype" "$cyclonedx_binary"

# Schema validation does not require locale-sensitive behavior. Keep the
# self-contained .NET CycloneDX binary independent of the runner's ICU image.
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1

"$tools_dir/syft" version -o json | tee "$evidence_dir/syft-version.json"
"$tools_dir/grype" --config "$grype_config" version -o json | tee "$evidence_dir/grype-version.json"
"$cyclonedx_binary" --version | tee "$evidence_dir/cyclonedx-cli-version.txt"

jq -e --arg version "$syft_version" --arg commit "$syft_commit" \
  '.application == "syft" and .version == $version and .gitCommit == $commit' \
  "$evidence_dir/syft-version.json" >/dev/null
jq -e --arg version "$grype_version" --arg commit "$grype_commit" \
  --argjson schema 6 \
  '.application == "grype" and .version == $version and .gitCommit == $commit and .supportedDbSchema == $schema' \
  "$evidence_dir/grype-version.json" >/dev/null
grep -Fx "${cyclonedx_version}+${cyclonedx_commit}" "$evidence_dir/cyclonedx-cli-version.txt" >/dev/null

bun "$workspace/scripts/release-security/release-evidence.mjs" prepare \
  --repository-root "$workspace" \
  --subjects-root "$subjects_dir" \
  --sbom-input "$sbom_input" \
  --evidence-directory "$evidence_dir" \
  --version "$version" \
  --repository "$repository" \
  --commit "$commit"

sbom_name="plannotator-${version}-release-sbom.cdx.json"
public_sbom="$public_dir/$sbom_name"
private_sbom="$evidence_dir/plannotator-${version}-release.sbom.syft.json"
"$tools_dir/syft" scan "dir:$sbom_input" \
  --source-name plannotator-release \
  --source-version "$version" \
  -o "syft-json=$private_sbom" \
  -o "cyclonedx-json@1.6=$public_sbom"

bun "$workspace/scripts/release-security/release-evidence.mjs" finalize-sbom \
  --cyclonedx "$public_sbom" \
  --syft "$private_sbom" \
  --subjects "$evidence_dir/release-subjects.json" \
  --version "$version" \
  --repository "$repository" \
  --commit "$commit" \
  --syft-version "$syft_version"

"$cyclonedx_binary" validate --input-file "$public_sbom" --input-format json --input-version v1_6
"$tools_dir/syft" convert "$public_sbom" -o "syft-json=$evidence_dir/cyclonedx-roundtrip.syft.json"
jq -e '.artifacts | length > 0' "$evidence_dir/cyclonedx-roundtrip.syft.json" >/dev/null
(
  cd "$public_dir"
  sha256sum "$sbom_name" > "${sbom_name}.sha256"
)

export GRYPE_DB_CACHE_DIR="$db_dir"
export GRYPE_DB_AUTO_UPDATE=false
export GRYPE_DB_VALIDATE_BY_HASH_ON_START=true
export GRYPE_DB_VALIDATE_AGE=true
export GRYPE_DB_MAX_ALLOWED_BUILT_AGE=120h
export GRYPE_CHECK_FOR_APP_UPDATE=false

update_grype_database() {
  local attempt
  for attempt in 1 2 3; do
    echo "Grype database update attempt ${attempt}/3"
    if "$tools_dir/grype" --config "$grype_config" db update; then
      return 0
    fi
    if [[ "$attempt" -eq 3 ]]; then
      echo "Grype database update failed after 3 attempts" >&2
      return 1
    fi
    sleep "$((attempt * 5))"
  done
}

update_grype_database
"$tools_dir/grype" --config "$grype_config" db status -o json > "$evidence_dir/grype-db-status.json"
"$tools_dir/grype" --config "$grype_config" db list -o json > "$evidence_dir/grype-db-list.json"
"$tools_dir/grype" --config "$grype_config" db check -o json > "$evidence_dir/grype-db-check.json"
"$tools_dir/grype" --config "$grype_config" "sbom:$private_sbom" -o json > "$evidence_dir/grype-results.json"

policy_arguments=(
  --scan "$evidence_dir/grype-results.json"
  --db-status "$evidence_dir/grype-db-status.json"
  --db-list "$evidence_dir/grype-db-list.json"
  --db-check "$evidence_dir/grype-db-check.json"
  --applicability "$evidence_dir/release-applicability.json"
  --grype-version "$grype_version"
  --output "$evidence_dir/grype-policy-result.json"
  --summary "$evidence_dir/grype-policy-summary.md"
)
if [[ -n "${PLANNOTATOR_RELEASE_VEX:-}" ]]; then
  policy_arguments+=(--vex "$PLANNOTATOR_RELEASE_VEX")
fi
policy_status=0
bun "$workspace/scripts/release-security/grype-policy.mjs" "${policy_arguments[@]}" || policy_status=$?

if [[ -n "${GITHUB_STEP_SUMMARY:-}" && -f "$evidence_dir/grype-policy-summary.md" ]]; then
  cat "$evidence_dir/grype-policy-summary.md" >> "$GITHUB_STEP_SUMMARY"
fi
if [[ "$policy_status" -ne 0 ]]; then
  exit "$policy_status"
fi

echo "Release security evidence is ready:"
echo "  public SBOM: $public_sbom"
echo "  private evidence: $evidence_dir"
