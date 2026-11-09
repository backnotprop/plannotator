#!/usr/bin/env bun
/**
 * Release-time check: a package about to be published must not depend on a
 * sibling repo package at a version npm doesn't have. ui 0.53.1 pins
 * @plannotator/core 0.25.14 while npm has 0.25.13, so publishing ui before
 * core ships a ui that fails to install with ETARGET.
 *
 *   bun scripts/check-sibling-deps.ts @plannotator/core @plannotator/ui
 *
 * Name every package this release publishes. A sibling named there counts at
 * its repo version (publish it first); any other sibling must already have a
 * matching version on npm. `workspace:` specs are read the way `bun pm pack`
 * rewrites them. Reads the npm registry, so it is not a unit test.
 */
import { resolve } from "node:path";
import { findRepoPackages, type PackageManifest } from "../tests/helpers/published-packages";

export interface SiblingGap {
	package: string;
	dependency: string;
	spec: string;
	reason: string;
}

/** The range a published manifest ends up with, or null for a spec this check doesn't read (npm:, file:, git). */
function publishedRange(spec: string, siblingVersion: string): string | null {
	if (spec.startsWith("workspace:")) {
		const rest = spec.slice("workspace:".length);
		if (rest === "" || rest === "*") return siblingVersion;
		if (rest === "^" || rest === "~") return `${rest}${siblingVersion}`;
		return rest;
	}
	return /^[\s\d^~<>=*xX|.-]/.test(spec) ? spec : null;
}

export function siblingDependencyGaps(
	repo: readonly PackageManifest[],
	publishing: readonly string[],
	npmVersions: (name: string) => readonly string[],
): SiblingGap[] {
	const byName = new Map(repo.filter((m) => m.name).map((m) => [m.name as string, m]));
	const gaps: SiblingGap[] = [];
	for (const name of publishing) {
		const manifest = byName.get(name);
		if (!manifest) throw new Error(`${name} is not a package in this repo`);
		for (const [dependency, rawSpec] of Object.entries(manifest.dependencies ?? {})) {
			const sibling = byName.get(dependency);
			if (!sibling || typeof rawSpec !== "string") continue;
			const range = publishedRange(rawSpec, sibling.version ?? "");
			if (range === null) continue;
			const inRelease = publishing.includes(dependency) && sibling.private !== true;
			if (inRelease && sibling.version && Bun.semver.satisfies(sibling.version, range)) continue;
			if (npmVersions(dependency).some((version) => Bun.semver.satisfies(version, range))) continue;
			const reason =
				sibling.private === true
					? `${dependency} is private and never published`
					: `npm has no ${dependency} matching ${range}${inRelease ? "" : ` (repo has ${sibling.version}: publish ${dependency} first and name it here)`}`;
			gaps.push({ package: name, dependency, spec: rawSpec, reason });
		}
	}
	return gaps;
}

async function fetchNpmVersions(name: string): Promise<string[]> {
	const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, {
		headers: { accept: "application/vnd.npm.install-v1+json" },
	});
	if (response.status === 404) return [];
	if (!response.ok) throw new Error(`registry answered ${response.status} for ${name}`);
	const body = (await response.json()) as { versions?: Record<string, unknown> };
	return Object.keys(body.versions ?? {});
}

if (import.meta.main) {
	const publishing = process.argv.slice(2);
	if (publishing.length === 0) {
		console.error("usage: bun scripts/check-sibling-deps.ts <package being published>...");
		process.exit(2);
	}
	const repo = findRepoPackages(resolve(import.meta.dir, "..")).map((pkg) => pkg.manifest);
	const siblings = new Set(repo.map((m) => m.name).filter((n): n is string => Boolean(n)));
	const wanted = new Set<string>();
	for (const m of repo) {
		if (!m.name || !publishing.includes(m.name)) continue;
		for (const dependency of Object.keys(m.dependencies ?? {})) if (siblings.has(dependency)) wanted.add(dependency);
	}
	const versions = new Map<string, string[]>();
	for (const name of wanted) versions.set(name, await fetchNpmVersions(name));
	const gaps = siblingDependencyGaps(repo, publishing, (name) => versions.get(name) ?? []);
	for (const gap of gaps) console.error(`${gap.package} depends on ${gap.dependency} ${gap.spec}: ${gap.reason}`);
	if (gaps.length > 0) process.exit(1);
	console.log(`Sibling dependencies resolve for: ${publishing.join(", ")}`);
}
