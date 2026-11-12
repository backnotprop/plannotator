import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface PackageManifest {
	name?: string;
	version?: string;
	private?: boolean;
	engines?: Record<string, unknown>;
	os?: unknown;
	cpu?: unknown;
	libc?: unknown;
	dependencies?: Record<string, unknown>;
	peerDependencies?: Record<string, unknown>;
}

export interface PublishedPackage {
	path: string;
	manifest: PackageManifest;
}

export interface FloorAllowance {
	package: string;
	field: string;
	value: unknown;
	reason: string;
}

export interface FloorFinding {
	package: string;
	field: string;
	value: unknown;
}

const GATED_ENGINES = ["node", "npm", "opencode", "vscode", "bun"] as const;
const GATED_PLATFORM_FIELDS = ["os", "cpu", "libc"] as const;

const OPENCODE_HOST = /^(?:@opencode-ai\/|@opencode\/|opencode-ai$|opencode$)/;
const PI_HOST = /^(?:@earendil-works\/|@mariozechner\/|pi-coding-agent$)/;
const PI_ALLOWED_PEER = /^@earendil-works\/pi-/;

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "generated"]);

export function findPublishablePackages(repoRoot: string): PublishedPackage[] {
	return findRepoPackages(repoRoot).filter(({ manifest }) => manifest.private !== true);
}

export function findRepoPackages(repoRoot: string): PublishedPackage[] {
	const found: PublishedPackage[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name === "package.json") {
				const manifest = JSON.parse(readFileSync(full, "utf8")) as PackageManifest;
				found.push({ path: relative(repoRoot, full), manifest });
			}
		}
	};
	walk(repoRoot);
	return found.sort((a, b) => a.path.localeCompare(b.path));
}

function gatedFields(manifest: PackageManifest): FloorFinding[] {
	const name = manifest.name ?? "(unnamed)";
	const findings: FloorFinding[] = [];
	for (const key of GATED_ENGINES) {
		const value = manifest.engines?.[key];
		if (value !== undefined) findings.push({ package: name, field: `engines.${key}`, value });
	}
	for (const key of GATED_PLATFORM_FIELDS) {
		const value = manifest[key];
		if (value !== undefined) findings.push({ package: name, field: key, value });
	}
	for (const [peer, value] of Object.entries(manifest.peerDependencies ?? {})) {
		const gated = OPENCODE_HOST.test(peer) || (PI_HOST.test(peer) && !PI_ALLOWED_PEER.test(peer));
		if (gated) findings.push({ package: name, field: `peerDependencies.${peer}`, value });
	}
	return findings;
}

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function updateBlockingFields(
	manifest: PackageManifest,
	allowlist: readonly FloorAllowance[],
): FloorFinding[] {
	return gatedFields(manifest).filter(
		(finding) =>
			!allowlist.some(
				(allowed) =>
					allowed.package === finding.package &&
					allowed.field === finding.field &&
					sameValue(allowed.value, finding.value),
			),
	);
}

export function staleAllowances(
	packages: readonly PublishedPackage[],
	allowlist: readonly FloorAllowance[],
): FloorAllowance[] {
	const present = packages.flatMap(({ manifest }) => gatedFields(manifest));
	return allowlist.filter(
		(allowed) =>
			!present.some(
				(finding) =>
					finding.package === allowed.package &&
					finding.field === allowed.field &&
					sameValue(finding.value, allowed.value),
			),
	);
}
