/**
 * Every npm package release.yml ships goes through the release security gate.
 *
 * release-security scans and checksums exactly the tarballs named in
 * NPM_SUBJECTS (scripts/release-security/release-evidence.mjs), and the attest
 * job binds the SBOM to the subject paths it lists. A package packed into its
 * own artifact, or published from a path outside that list, would ship
 * unscanned and outside the SBOM attestation, as @plannotator/dsh first did.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NPM_SUBJECTS } from "../scripts/release-security/release-evidence.mjs";

const repoRoot = resolve(import.meta.dir, "..");
const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");

const packed = [...workflow.matchAll(/bun pm pack --filename "\$GITHUB_WORKSPACE\/([^"]+)"/g)].map((m) => m[1]);
const published = [...workflow.matchAll(/npm publish \.\/(\S+\.tgz)/g)].map((m) => m[1]);
const attestBlock = workflow.match(/- name: Generate release SBOM attestation[\s\S]*?sbom-path:/)?.[0] ?? "";

describe("release.yml npm packages and the security gate", () => {
	// Catches: a pack step writing a tarball the gate never scans.
	test("every packed tarball is a gated subject", () => {
		expect(packed.length).toBeGreaterThanOrEqual(3);
		for (const path of packed) expect(NPM_SUBJECTS).toContain(path);
	});

	// Catches: a publish step that ships a tarball from outside the gated set.
	test("every published tarball is a gated subject", () => {
		expect(published.length).toBeGreaterThanOrEqual(3);
		for (const path of published) expect(NPM_SUBJECTS).toContain(path);
	});

	// Catches: a gated tarball that is published but not bound to the SBOM.
	test("every gated npm subject is in the SBOM attestation", () => {
		expect(attestBlock).not.toBe("");
		for (const path of NPM_SUBJECTS) expect(attestBlock).toContain(path);
	});

	// Catches: a gated subject nothing packs or publishes, which fails the gate
	// on a missing file at release time.
	test("every gated npm subject is packed and published", () => {
		for (const path of NPM_SUBJECTS) {
			expect(packed).toContain(path);
			expect(published).toContain(path);
		}
	});
});
