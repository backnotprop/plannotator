export type SourceSaveLanguage = "markdown" | "mdx" | "text";

export type SourceSaveDisabledReason =
	| "not-annotate-mode"
	| "not-local-file"
	| "unsupported-extension"
	| "converted-source"
	| "html-render"
	| "folder-mode"
	| "message-mode"
	| "shared-session"
	| "missing-file"
	| "unreadable-file";

export type SourceSaveScope = "single-file" | "folder-file";

export type SourceFileEol = "lf" | "crlf" | "mixed" | "none";

export interface SourceFileSnapshot {
	text: string;
	hash: string;
	mtimeMs: number;
	size: number;
	eol: SourceFileEol;
}

export type SourceSaveCapability =
	| {
			enabled: true;
			kind: "local-text-file";
			scope: SourceSaveScope;
			path: string;
			basename: string;
			language: SourceSaveLanguage;
			hash: string;
			mtimeMs: number;
			size: number;
			eol: SourceFileEol;
	  }
	| {
			enabled: false;
			reason: SourceSaveDisabledReason;
	  };

export interface SourceSaveRequest {
	path?: string;
	text: string;
	baseHash: string;
	baseMtimeMs?: number;
	baseEol?: SourceFileEol;
	allowMissingBase?: boolean;
	/** The stale-tab guard's nonce (server-session.ts); absent from older clients. */
	serverSession?: string;
}

export type SourceSaveResponse =
	| {
			ok: true;
			hash: string;
			mtimeMs: number;
			size: number;
			eol: SourceFileEol;
	  }
	| {
			ok: false;
			code: "conflict";
			message: string;
			currentText: string;
			currentHash: string;
			currentMtimeMs: number;
			currentSize: number;
			currentEol: SourceFileEol;
	  }
	| {
			ok: false;
			code: "not-writable" | "write-failed" | "invalid-request";
			message: string;
	  };

/**
 * The refusal a source save gets once the review is decided (feedback,
 * approve, Close, or the agent's close), answered with status 409: a tab left
 * open after the decision can no longer write the reviewer's files.
 */
export function sourceSaveDecidedResponse(): SourceSaveResponse & { decided: true } {
	return {
		ok: false,
		code: "not-writable",
		decided: true,
		message: "This review is already decided, so the file was not saved.",
	};
}

/** The refusal a cross-origin source save gets (status 403). */
export function sourceSaveCrossOriginResponse(): SourceSaveResponse {
	return { ok: false, code: "not-writable", message: "Cross-origin source saves are not allowed." };
}

export type SourceSaveConflictResponse =Extract<SourceSaveResponse, { ok: false; code: "conflict" }>;

export function isSourceFileEol(value: unknown): value is SourceFileEol {
	return value === "lf" || value === "crlf" || value === "mixed" || value === "none";
}

export function hasSourceSaveConflictSnapshot(response: SourceSaveResponse): response is SourceSaveConflictResponse {
	if (!("code" in response) || response.code !== "conflict") return false;
	const conflict = response as SourceSaveConflictResponse;
	return (
		typeof conflict.currentText === "string" &&
		typeof conflict.currentHash === "string" &&
		typeof conflict.currentMtimeMs === "number" &&
		typeof conflict.currentSize === "number" &&
		isSourceFileEol(conflict.currentEol)
	);
}

export const SOURCE_SAVE_FILE_REGEX = /\.(md|mdx|txt)$/i;

export function isSourceSaveFilePath(filePath: string): boolean {
	return SOURCE_SAVE_FILE_REGEX.test(filePath);
}

export function getSourceSaveLanguage(filePath: string): SourceSaveLanguage | null {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".mdx")) return "mdx";
	if (lower.endsWith(".md")) return "markdown";
	if (lower.endsWith(".txt")) return "text";
	return null;
}

export function basenameFromPath(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	return normalized.split("/").pop() || filePath;
}

export function disabledSourceSave(reason: SourceSaveDisabledReason): SourceSaveCapability {
	return { enabled: false, reason };
}

export function enabledSourceSave(
	scope: SourceSaveScope,
	filePath: string,
	snapshot: SourceFileSnapshot,
): SourceSaveCapability {
	const language = getSourceSaveLanguage(filePath);
	if (!language) return disabledSourceSave("unsupported-extension");
	return {
		enabled: true,
		kind: "local-text-file",
		scope,
		path: filePath,
		basename: basenameFromPath(filePath),
		language,
		hash: snapshot.hash,
		mtimeMs: snapshot.mtimeMs,
		size: snapshot.size,
		eol: snapshot.eol,
	};
}
