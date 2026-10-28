/**
 * The package was updated under a running host (#2085).
 *
 * Most of this extension's server code is imported lazily, on the first
 * review. When the package is upgraded in place while Pi or Oh My Pi keeps
 * running, that lazy import reads the NEW files from disk while the modules
 * loaded at startup (generated/config.ts and others) stay the OLD ones in the
 * host's module registry. Bun then fails to link ("Export named 'x' not found
 * in module …"), and jiti hands back `undefined` for the missing export. The
 * package itself is fine; the host has to reload it (Pi `/reload`, Oh My Pi
 * `/restart`) to load it whole.
 *
 * So the version this module was loaded with is recorded once, and every lazy
 * import first reads package.json on disk again (one small synchronous read).
 * A different version stops the import with a message that names that command.
 * A link error that slips past the check (a read that raced the upgrade) gets
 * the same message.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentPiHost, type PiAgentToolHost } from "./pi-host.ts";

const PACKAGE_JSON_PATH = join(dirname(fileURLToPath(import.meta.url)), "package.json");

/** The `version` in a package.json, or null when it cannot be read. */
export function readPackageVersion(path: string = PACKAGE_JSON_PATH): string | null {
	try {
		const pkg = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown };
		return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
	} catch {
		return null;
	}
}

/** The version of the code this process loaded, read when this module was evaluated. */
const LOADED_VERSION = readPackageVersion();

export function loadedPackageVersion(): string | null {
	return LOADED_VERSION;
}

/** The host's name as the person knows it. */
export function piHostDisplayName(host: PiAgentToolHost): string {
	return host === "oh-my-pi" ? "Oh My Pi" : "Pi";
}

/**
 * What loads the new version in the host, typed in the session: Pi's
 * `/reload` re-imports the extension from disk (since 0.79.9); Oh My Pi
 * imports an extension once per process, so `/restart` (restarts omp and
 * resumes the session; its `/reload-plugins` does not reload extension code).
 */
export function piReloadCommand(host: PiAgentToolHost): string {
	return host === "oh-my-pi" ? "/restart" : "/reload";
}

/** The message for an update under a running host; without versions, a plain "files changed". */
export function packageUpdatedMessage(from: string | null, to: string | null, host: PiAgentToolHost): string {
	const name = piHostDisplayName(host);
	const fix = `Type ${piReloadCommand(host)} to load the new version.`;
	if (from && to && from !== to) {
		return `Plannotator was updated from ${from} to ${to} while ${name} was running. ${fix}`;
	}
	return `Plannotator's files changed on disk while ${name} was running. ${fix}`;
}

/**
 * Null when the version on disk is the one that was loaded (or either cannot
 * be read: nothing to say then), else the message.
 */
export function checkPackageVersion(loaded: string | null, onDisk: string | null, host: PiAgentToolHost): string | null {
	if (loaded === null || onDisk === null || loaded === onDisk) return null;
	return packageUpdatedMessage(loaded, onDisk, host);
}

/** Thrown in place of a lazy import that would mix two versions of the package. */
export class PlannotatorUpdatedError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "PlannotatorUpdatedError";
	}
}

export function isPlannotatorUpdatedError(error: unknown): error is PlannotatorUpdatedError {
	return error instanceof PlannotatorUpdatedError;
}

/** Bun's link error for a module that imports a name its (stale) dependency lacks. */
export function isStaleModuleLinkError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return /Export named '[^']*' not found in module/.test(message);
}

/** Overridable for tests. */
export interface FreshImportOptions {
	loaded?: string | null;
	readOnDisk?: () => string | null;
	host?: PiAgentToolHost;
}

/**
 * Run a lazy import of this package's own modules, unless the package on disk
 * is no longer the version this process loaded. Pass the import as a literal
 * `() => import("./x.ts")` so the host's loader still sees the specifier.
 */
export async function importFresh<T>(load: () => Promise<T>, options: FreshImportOptions = {}): Promise<T> {
	const loaded = options.loaded !== undefined ? options.loaded : LOADED_VERSION;
	const readOnDisk = options.readOnDisk ?? (() => readPackageVersion());
	const host = options.host ?? currentPiHost();
	const stale = checkPackageVersion(loaded, readOnDisk(), host);
	if (stale) throw new PlannotatorUpdatedError(stale);
	try {
		return await load();
	} catch (error) {
		if (isStaleModuleLinkError(error)) {
			const onDisk = readOnDisk();
			const message = packageUpdatedMessage(loaded, onDisk, host);
			// Same version on both sides: the files may have changed under the same
			// version, or the package itself may be broken. Keep Bun's own words so
			// a packaging bug is not hidden behind "restart".
			const sameVersion = loaded !== null && onDisk !== null && loaded === onDisk;
			const detail = sameVersion && error instanceof Error ? ` (${error.message})` : "";
			throw new PlannotatorUpdatedError(`${message}${detail}`, { cause: error });
		}
		throw error;
	}
}

/** "<prefix>: <detail>", or the restart message alone when the package was updated. */
export function launchFailureText(prefix: string, error: unknown): string {
	if (isPlannotatorUpdatedError(error)) return error.message;
	return `${prefix}: ${error instanceof Error ? error.message : "Unknown error"}`;
}
