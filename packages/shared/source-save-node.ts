import { createHash } from "crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	realpathSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { isWithinProjectRoot, resolveUserPath } from "./resolve-file";
import {
	disabledSourceSave,
	enabledSourceSave,
	isSourceFileEol,
	isSourceSaveFilePath,
	type SourceFileEol,
	type SourceFileSnapshot,
	type SourceSaveCapability,
	type SourceSaveResponse,
	type SourceSaveScope,
} from "./source-save";

export function hashSourceBytes(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isFileExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "EEXIST"
	);
}

export function detectSourceEol(text: string): SourceFileEol {
	const crlf = (text.match(/\r\n/g) ?? []).length;
	const withoutCrlf = text.replace(/\r\n/g, "");
	const loneCr = (withoutCrlf.match(/\r/g) ?? []).length;
	const loneLf = (withoutCrlf.match(/\n/g) ?? []).length;
	const lf = loneLf + loneCr;

	if (crlf === 0 && lf === 0) return "none";
	if (crlf > 0 && lf === 0) return "crlf";
	if (crlf === 0 && lf > 0) return "lf";
	return "mixed";
}

export function applySourceEolPolicy(text: string, eol: SourceFileEol): string {
	const normalized = text.replace(/\r\n?/g, "\n");
	if (eol === "crlf") return normalized.replace(/\n/g, "\r\n");
	return normalized;
}

export function readSourceFileSnapshot(filePath: string): SourceFileSnapshot {
	const bytes = readFileSync(filePath);
	const stat = statSync(filePath);
	const text = bytes.toString("utf8");
	return {
		text,
		hash: hashSourceBytes(bytes),
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		eol: detectSourceEol(text),
	};
}

export function sourceFileSnapshotFromText(text: string): SourceFileSnapshot {
	const bytes = Buffer.from(text, "utf8");
	return {
		text,
		hash: hashSourceBytes(bytes),
		mtimeMs: 0,
		size: bytes.byteLength,
		eol: detectSourceEol(text),
	};
}

export function resolveFolderSourceFile(filePath: string, folderPath: string): string | null {
	if (!isSourceSaveFilePath(filePath)) return null;

	let root: string;
	let candidate: string;
	try {
		root = realpathSync(resolveUserPath(folderPath));
		candidate = resolveUserPath(filePath, root);
		if (!existsSync(candidate)) return null;
		candidate = realpathSync(candidate);
	} catch {
		return null;
	}

	if (!isWithinProjectRoot(candidate, root)) return null;
	return candidate;
}

export function resolveFolderSourceFileForSave(filePath: string, folderPath: string): string | null {
	if (!isSourceSaveFilePath(filePath)) return null;

	let root: string;
	let candidate: string;
	try {
		root = realpathSync(resolveUserPath(folderPath));
		candidate = resolveUserPath(filePath, root);
	} catch {
		return null;
	}

	try {
		if (existsSync(candidate)) return resolveFolderSourceFile(candidate, root);

		const realParent = realpathSync(dirname(candidate));
		if (!isWithinProjectRoot(realParent, root)) return null;
		const resolvedMissingLeaf = join(realParent, basename(candidate));
		if (!isWithinProjectRoot(resolvedMissingLeaf, root)) return null;
		return resolvedMissingLeaf;
	} catch {
		return null;
	}
}

export function resolveExistingSourceSaveFile(
	scope: SourceSaveScope,
	filePath: string,
	folderPath?: string,
): string | null {
	if (!isSourceSaveFilePath(filePath)) return null;

	const resolved =
		scope === "folder-file" && folderPath
			? resolveFolderSourceFile(filePath, folderPath)
			: resolveUserPath(filePath);

	if (!resolved) return null;
	if (!existsSync(resolved)) return null;

	try {
		const real = realpathSync(resolved);
		if (scope === "folder-file" && folderPath) {
			const root = realpathSync(resolveUserPath(folderPath));
			if (!isWithinProjectRoot(real, root)) return null;
		}
		const stat = statSync(real);
		if (!stat.isFile()) return null;
		return real;
	} catch {
		return null;
	}
}

export function createSourceSaveCapabilityFromSnapshot(
	scope: SourceSaveScope,
	filePath: string,
	snapshot: SourceFileSnapshot,
	folderPath?: string,
): SourceSaveCapability {
	if (!isSourceSaveFilePath(filePath)) {
		return disabledSourceSave("unsupported-extension");
	}

	const resolved = resolveExistingSourceSaveFile(scope, filePath, folderPath);
	if (!resolved) return disabledSourceSave("not-local-file");
	return enabledSourceSave(scope, resolved, snapshot);
}

// Used when Plannotator already read the source text, but the file vanished
// before the browser asked for /api/plan. Disk reads should use
// createSourceSaveCapability/createSourceSaveCapabilityFromSnapshot instead.
export function createSourceSaveCapabilityFromText(
	scope: SourceSaveScope,
	filePath: string,
	text: string,
	folderPath?: string,
): SourceSaveCapability {
	if (!isSourceSaveFilePath(filePath)) {
		return disabledSourceSave("unsupported-extension");
	}

	if (scope === "folder-file") {
		if (!folderPath) return disabledSourceSave("not-local-file");
		const resolved = resolveFolderSourceFileForSave(filePath, folderPath);
		if (!resolved) return disabledSourceSave("not-local-file");
		return enabledSourceSave(scope, resolved, sourceFileSnapshotFromText(text));
	}

	const resolved = resolveUserPath(filePath);
	try {
		if (existsSync(resolved)) {
			const real = realpathSync(resolved);
			const stat = statSync(real);
			if (!stat.isFile()) return disabledSourceSave("unsupported-extension");
			return enabledSourceSave(scope, real, sourceFileSnapshotFromText(text));
		}

		const realParent = realpathSync(dirname(resolved));
		return enabledSourceSave(scope, join(realParent, basename(resolved)), sourceFileSnapshotFromText(text));
	} catch {
		return disabledSourceSave("missing-file");
	}
}

export function createSourceSaveCapability(
	scope: SourceSaveScope,
	filePath: string,
	folderPath?: string,
): SourceSaveCapability {
	if (!isSourceSaveFilePath(filePath)) {
		return disabledSourceSave("unsupported-extension");
	}

	const resolved =
		scope === "folder-file" && folderPath
			? resolveFolderSourceFile(filePath, folderPath)
			: resolveUserPath(filePath);

	if (!resolved) return disabledSourceSave("not-local-file");
	if (!existsSync(resolved)) return disabledSourceSave("missing-file");

	try {
		const real = realpathSync(resolved);
		if (scope === "folder-file" && folderPath) {
			const root = realpathSync(resolveUserPath(folderPath));
			if (!isWithinProjectRoot(real, root)) {
				return disabledSourceSave("not-local-file");
			}
		}
		const stat = statSync(real);
		if (!stat.isFile()) return disabledSourceSave("unsupported-extension");
		const snapshot = readSourceFileSnapshot(real);
		return enabledSourceSave(scope, real, snapshot);
	} catch {
		return disabledSourceSave("unreadable-file");
	}
}

// --- Reviews of several files (annotate bundles) ---
//
// A bundle is several single-file sessions in one review, so source save
// follows the single-file rule for each listed file and nothing else: the
// writable set is the real paths of the bundle's own files (a symlinked entry
// resolves to its target, as its reference roots do), captured when the
// review opens. Documents a bundle file links to stay read-only, exactly as
// documents linked from a single file do.

/** Where `filePath` lives: its real path, or for a missing file its real parent plus its name. */
function resolveSourceSaveLocation(filePath: string): string | null {
	const resolved = resolveUserPath(filePath);
	if (!resolved) return null;
	try {
		if (existsSync(resolved)) return realpathSync(resolved);
		return join(realpathSync(dirname(resolved)), basename(resolved));
	} catch {
		return null;
	}
}

/**
 * The real paths source save may write in a review of several files: each
 * listed file whose named path and real path are both a source-save type
 * (`SOURCE_SAVE_FILE_REGEX`) and which is a regular file. Raw HTML, diagram
 * sources and data files are left out, as they are for a single file.
 */
export function resolveBundleSourceSavePaths(paths: readonly string[]): Set<string> {
	const allowed = new Set<string>();
	for (const path of paths) {
		if (!isSourceSaveFilePath(path)) continue;
		const real = resolveSourceSaveLocation(path);
		if (!real || !isSourceSaveFilePath(real)) continue;
		try {
			if (!statSync(real).isFile()) continue;
		} catch {
			continue;
		}
		allowed.add(real);
	}
	return allowed;
}

/** Where a save request for `filePath` writes in a bundle, or null when it names none of the bundle's files. */
export function resolveBundleSourceSaveTarget(filePath: string, allowed: ReadonlySet<string>): string | null {
	if (!isSourceSaveFilePath(filePath)) return null;
	const real = resolveSourceSaveLocation(filePath);
	return real && allowed.has(real) ? real : null;
}

/**
 * The source-save capability of a document served in a bundle: enabled only
 * for one of the bundle's own files, null otherwise. Its scope is
 * "folder-file" because the client addresses the save by path
 * (`SourceSaveRequest.path`), as it does in a folder session.
 */
export function createBundleSourceSaveCapability(
	filePath: string,
	allowed: ReadonlySet<string>,
	snapshot?: SourceFileSnapshot,
): SourceSaveCapability | null {
	if (!resolveBundleSourceSaveTarget(filePath, allowed)) return null;
	const capability = snapshot
		? createSourceSaveCapabilityFromSnapshot("folder-file", filePath, snapshot)
		: createSourceSaveCapability("folder-file", filePath);
	return capability.enabled && allowed.has(capability.path) ? capability : null;
}

export function saveSourceFileAtomic(
	filePath: string,
	text: string,
	baseHash: string,
	options: {
		allowMissingBase?: boolean;
		missingBaseEol?: SourceFileEol;
		allowedRoot?: string;
		/** Only these real paths may be written (a review of several files: its own files). */
		allowedFiles?: ReadonlySet<string>;
	} = {},
): SourceSaveResponse {
	if (!isSourceSaveFilePath(filePath)) {
		return {
			ok: false,
			code: "not-writable",
			message: "This file type cannot be saved from Plannotator.",
		};
	}

	let allowedRoot: string | null = null;
	if (options.allowedRoot) {
		try {
			allowedRoot = realpathSync(resolveUserPath(options.allowedRoot));
		} catch {
			return {
				ok: false,
				code: "not-writable",
				message: "This file cannot be saved outside the allowed folder.",
			};
		}
	}

	let before: SourceFileSnapshot;
	let mode: number | undefined;
	let outputEol: SourceFileEol;
	let recreateMissingBase = false;
	try {
		const real = realpathSync(filePath);
		if (allowedRoot && !isWithinProjectRoot(real, allowedRoot)) {
			return {
				ok: false,
				code: "not-writable",
				message: "This file cannot be saved outside the allowed folder.",
			};
		}
		if (options.allowedFiles && !options.allowedFiles.has(real)) {
			return {
				ok: false,
				code: "not-writable",
				message: "Only the files in this review can be saved.",
			};
		}
		const stat = statSync(real);
		if (!stat.isFile()) {
			return {
				ok: false,
				code: "not-writable",
				message: "This path is not a writable file.",
			};
		}
		mode = stat.mode;
		before = readSourceFileSnapshot(real);
		filePath = real;
		outputEol = before.eol;
	} catch {
		if (existsSync(filePath)) {
			return {
				ok: false,
				code: "not-writable",
				message: "This file is missing or cannot be read.",
			};
		}
		if (!options.allowMissingBase) {
			return {
				ok: false,
				code: "not-writable",
				message: "This file is missing or cannot be read.",
			};
		}
		try {
			const realParent = realpathSync(dirname(filePath));
			filePath = join(realParent, basename(filePath));
			if (allowedRoot && !isWithinProjectRoot(filePath, allowedRoot)) {
				return {
					ok: false,
					code: "not-writable",
					message: "This file cannot be saved outside the allowed folder.",
				};
			}
			if (options.allowedFiles && !options.allowedFiles.has(filePath)) {
				return {
					ok: false,
					code: "not-writable",
					message: "Only the files in this review can be saved.",
				};
			}
			before = {
				text: "",
				hash: baseHash,
				mtimeMs: 0,
				size: 0,
				eol: isSourceFileEol(options.missingBaseEol) ? options.missingBaseEol : "lf",
			};
			outputEol = before.eol;
			recreateMissingBase = true;
		} catch {
			return {
				ok: false,
				code: "not-writable",
				message: "This file is missing or cannot be recreated.",
			};
		}
	}

	if (before.hash !== baseHash) {
		return {
			ok: false,
			code: "conflict",
			message: "The file changed on disk since Plannotator opened it.",
			currentText: before.text,
			currentHash: before.hash,
			currentMtimeMs: before.mtimeMs,
			currentSize: before.size,
			currentEol: before.eol,
		};
	}

	const output = applySourceEolPolicy(text, outputEol);
	const dir = dirname(filePath);
	const tmp = join(dir, `.plannotator-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);

	try {
		writeFileSync(tmp, output, { encoding: "utf8", mode });
		if (mode !== undefined) chmodSync(tmp, mode);
		if (recreateMissingBase) {
			try {
				// Create the final path only if it is still absent. A plain rename
				// would overwrite a file recreated by another tool after our first
				// missing-file check.
				linkSync(tmp, filePath);
			} catch (error) {
				if (isFileExistsError(error)) {
					const current = readSourceFileSnapshot(filePath);
					try {
						unlinkSync(tmp);
					} catch {
						/* best effort */
					}
					return {
						ok: false,
						code: "conflict",
						message: "The file changed on disk since Plannotator opened it.",
						currentText: current.text,
						currentHash: current.hash,
						currentMtimeMs: current.mtimeMs,
						currentSize: current.size,
						currentEol: current.eol,
					};
				}
				throw error;
			}
			try {
				unlinkSync(tmp);
			} catch {
				/* best effort */
			}
		} else {
			renameSync(tmp, filePath);
		}
		const after = readSourceFileSnapshot(filePath);
		return {
			ok: true,
			hash: after.hash,
			mtimeMs: after.mtimeMs,
			size: after.size,
			eol: after.eol,
		};
	} catch {
		try {
			unlinkSync(tmp);
		} catch {
			/* best effort */
		}
		return {
			ok: false,
			code: "write-failed",
			message: "Failed to save the file.",
		};
	}
}
