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
	test("every packed tarball is a gated subject", () => {
		expect(packed.length).toBeGreaterThanOrEqual(3);
		for (const path of packed) expect(NPM_SUBJECTS).toContain(path);
	});

	test("every published tarball is a gated subject", () => {
		expect(published.length).toBeGreaterThanOrEqual(3);
		for (const path of published) expect(NPM_SUBJECTS).toContain(path);
	});

	test("every gated npm subject is in the SBOM attestation", () => {
		expect(attestBlock).not.toBe("");
		for (const path of NPM_SUBJECTS) expect(attestBlock).toContain(path);
	});

	test("every gated npm subject is packed and published", () => {
		for (const path of NPM_SUBJECTS) {
			expect(packed).toContain(path);
			expect(published).toContain(path);
		}
	});
});

const jobs = (Bun.YAML.parse(workflow) as { jobs: Record<string, { needs?: string | string[]; if?: string }> }).jobs;
const needsOf = (job: string): string[] => [jobs[job]?.needs ?? []].flat();

describe("release.yml: nothing is attested or published before the gates pass", () => {
	for (const job of ["npm-publish", "attest"]) {
		test(`${job} needs every smoke, release-security and viewer-pin-live`, () => {
			for (const need of ["smoke-binaries", "pi-extension-ai-runtime-windows", "install-script-smoke", "release-security", "viewer-pin-live"]) {
				expect(needsOf(job)).toContain(need);
			}
		});

		test(`${job} runs only when every need succeeded`, () => {
			expect(jobs[job]?.if).toBeString();
			expect(jobs[job]!.if!).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
		});
	}
});
