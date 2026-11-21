/**
 * Who may list and read what through the Files sidebar and Obsidian routes,
 * shared by the Bun and node:http servers.
 *
 * Another site's page is refused on all of them (the servers check
 * `isReferenceReadPath` with `isSameOriginRequest` first). A page on this
 * machine (`isThisMachineReader`, this-machine-reader.ts) lists any folder and
 * any vault the person adds in Settings, as before. Every other reader
 * (remote mode, tailnet peers, proxies) lists only folders inside the
 * session's roots and only the vaults Obsidian itself lists on this machine
 * (`detectObsidianVaults`): `referenceReadRefusal`. For every reader, a vault
 * document must be inside the vault as written, be a regular Markdown file by
 * its real path, and fit the 2MB cap; a reader off this machine must also stay
 * inside the vault after symlink resolution: `vaultDocRefusal`.
 */

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

/** A route that lists or reads the person's folders and vaults. */
export function isReferenceReadPath(pathname: string): boolean {
	return REFERENCE_READ_PATHS.has(pathname);
}

export interface ReferenceReader {
	/** `isThisMachineReader` for the request. */
	thisMachine: boolean;
	/** The session's roots, which every other reader keeps. */
	roots: string[];
}

export interface ReferenceRefusal {
	status: number;
	error: string;
}

/** A vault path as given and as it resolves, so a symlinked vault still contains its files. */
function vaultRoots(vault: string): string[] {
	try {
		return [vault, realpathSync(vault)];
	} catch {
		return [vault];
	}
}

/**
 * Why this reader may not list the folders or vault a request names, or null
 * when it may. A missing parameter passes, so the route answers its own 400.
 */
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

/**
 * Why a vault document may not be read, or null when it may. A missing file
 * passes, so the route still answers 404 for it. A page on this machine may
 * follow a symlink out of the vault (a folder shared between vaults, a wiki
 * link to it); it could name that folder as the vault anyway. Every other
 * reader stays inside the vault by real path too.
 */
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
		// A FIFO or device named *.md would block the read (and Pi's whole server).
		if (!stat.isFile()) return { status: 403, error: "Not a regular file" };
		if (stat.size > MAX_ANNOTATABLE_FILE_BYTES) {
			return { status: DOC_TOO_LARGE.status, error: String(DOC_TOO_LARGE.body.error) };
		}
	} catch {
		return null;
	}
	return null;
}
