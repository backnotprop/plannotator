import { realpathSync, statSync } from "fs";
import { DOC_TOO_LARGE, isPathAllowed } from "./doc-resolve";
import { detectObsidianVaults } from "./integrations-common";
import { isWithinProjectRoot, MAX_ANNOTATABLE_FILE_BYTES, resolveUserPath } from "./resolve-file";

const REFERENCE_READ_PATHS = new Set([
	"/api/obsidian/vaults",
	"/api/reference/files",
	"/api/reference/files/stream",
	"/api/reference/obsidian/files",
	"/api/reference/obsidian/doc",
]);

export function isReferenceReadPath(pathname: string): boolean {
	return REFERENCE_READ_PATHS.has(pathname);
}

export interface ReferenceReader {
	thisMachine: boolean;
	roots: string[];
}

export interface ReferenceRefusal {
	status: number;
	error: string;
}

function vaultRoots(vault: string): string[] {
	try {
		return [vault, realpathSync(vault)];
	} catch {
		return [vault];
	}
}

export function referenceReadRefusal(url: URL, reader: ReferenceReader): ReferenceRefusal | null {
	if (reader.thisMachine) return null;
	if (url.pathname === "/api/reference/files" || url.pathname === "/api/reference/files/stream") {
		const paths = [...url.searchParams.getAll("dirPath"), ...url.searchParams.getAll("filePath")];
		return paths.every((path) => isPathAllowed(resolveUserPath(path), reader.roots))
			? null
			: { status: 403, error: "Access denied: path is outside project root" };
	}
	if (url.pathname === "/api/reference/obsidian/files" || url.pathname === "/api/reference/obsidian/doc") {
		const vaultPath = url.searchParams.get("vaultPath");
		if (!vaultPath) return null;
		const known = detectObsidianVaults().flatMap((vault) => vaultRoots(resolveUserPath(vault)));
		return known.length > 0 && isPathAllowed(resolveUserPath(vaultPath), known)
			? null
			: { status: 403, error: "Access denied: not an Obsidian vault on this machine" };
	}
	return null;
}

export function vaultDocRefusal(file: string, vault: string, thisMachine = false): ReferenceRefusal | null {
	const inside = thisMachine ? isWithinProjectRoot(file, vault) : isPathAllowed(file, vaultRoots(vault));
	if (!inside) return { status: 403, error: "Access denied: path is outside vault" };
	let real: string;
	try {
		real = realpathSync(file);
	} catch {
		return null;
	}
	if (!/\.mdx?$/i.test(real)) return { status: 403, error: "Only markdown files are supported" };
	try {
		const stat = statSync(real);
		if (!stat.isFile()) return { status: 403, error: "Not a regular file" };
		if (stat.size > MAX_ANNOTATABLE_FILE_BYTES) {
			return { status: DOC_TOO_LARGE.status, error: String(DOC_TOO_LARGE.body.error) };
		}
	} catch {
		return null;
	}
	return null;
}
