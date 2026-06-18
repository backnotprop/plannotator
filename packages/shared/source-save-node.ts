import { createHash } from "crypto";
import {
	chmodSync,
	existsSync,
	realpathSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { isWithinProjectRoot, resolveUserPath } from "./resolve-file";
import {
	disabledSourceSave,
	enabledSourceSave,
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

export function saveSourceFileAtomic(
	filePath: string,
	text: string,
	baseHash: string,
): SourceSaveResponse {
	if (!isSourceSaveFilePath(filePath)) {
		return {
			ok: false,
			code: "not-writable",
			message: "This file type cannot be saved from Plannotator.",
		};
	}

	let before: SourceFileSnapshot;
	let mode: number | undefined;
	try {
		const real = realpathSync(filePath);
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
	} catch {
		return {
			ok: false,
			code: "not-writable",
			message: "This file is missing or cannot be read.",
		};
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

	const output = applySourceEolPolicy(text, before.eol);
	const dir = dirname(filePath);
	const tmp = join(dir, `.plannotator-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);

	try {
		writeFileSync(tmp, output, { encoding: "utf8", mode });
		if (mode !== undefined) chmodSync(tmp, mode);
		renameSync(tmp, filePath);
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
