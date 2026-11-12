import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentPiHost, type PiAgentToolHost } from "./pi-host.ts";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = join(PACKAGE_DIR, "package.json");

export function readPackageVersion(path: string = PACKAGE_JSON_PATH): string | null {
	try {
		const pkg = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown };
		return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
	} catch {
		return null;
	}
}

export function packageInstallSettled(dir: string = PACKAGE_DIR): boolean {
	let pkg: { pi?: { extensions?: unknown }; dependencies?: unknown };
	try {
		pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
	} catch {
		return false;
	}
	try {
		const retired = `.${basename(dir)}-`;
		if (readdirSync(dirname(dir)).some((name) => name.startsWith(retired))) return false;
	} catch {
	}
	const entries = Array.isArray(pkg.pi?.extensions) ? (pkg.pi.extensions as unknown[]) : ["./"];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const path = resolve(dir, entry);
		let isDir = false;
		try {
			isDir = statSync(path).isDirectory();
		} catch {
			return false;
		}
		if (isDir && !existsSync(join(path, "index.ts")) && !existsSync(join(path, "index.js"))) return false;
	}
	const deps = pkg.dependencies && typeof pkg.dependencies === "object" ? Object.keys(pkg.dependencies) : [];
	for (const dep of deps) if (!dependencyOnDisk(dir, dep)) return false;
	return true;
}

function dependencyOnDisk(dir: string, dep: string): boolean {
	let at = dir;
	for (;;) {
		if (existsSync(join(at, "node_modules", dep, "package.json"))) return true;
		const up = dirname(at);
		if (up === at) return false;
		at = up;
	}
}

const LOADED_VERSION = readPackageVersion();

export function loadedPackageVersion(): string | null {
	return LOADED_VERSION;
}

export function piHostDisplayName(host: PiAgentToolHost): string {
	return host === "oh-my-pi" ? "Oh My Pi" : "Pi";
}

export function piReloadCommand(host: PiAgentToolHost): string {
	return host === "oh-my-pi" ? "/restart" : "/reload";
}

export function packageUpdatedMessage(from: string | null, to: string | null, host: PiAgentToolHost): string {
	const name = piHostDisplayName(host);
	const fix = `Type ${piReloadCommand(host)} to load the new version.`;
	if (from && to && from !== to) {
		return `Plannotator was updated from ${from} to ${to} while ${name} was running. ${fix}`;
	}
	return `Plannotator's files changed on disk while ${name} was running. ${fix}`;
}

export function checkPackageVersion(loaded: string | null, onDisk: string | null, host: PiAgentToolHost): string | null {
	if (loaded === null || onDisk === null || loaded === onDisk) return null;
	return packageUpdatedMessage(loaded, onDisk, host);
}

export class PlannotatorUpdatedError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "PlannotatorUpdatedError";
	}
}

export function isPlannotatorUpdatedError(error: unknown): error is PlannotatorUpdatedError {
	return error instanceof PlannotatorUpdatedError;
}

export function isStaleModuleLinkError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return /Export named '[^']*' not found in module/.test(message);
}

export interface FreshImportOptions {
	loaded?: string | null;
	readOnDisk?: () => string | null;
	host?: PiAgentToolHost;
}

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
			const sameVersion = loaded !== null && onDisk !== null && loaded === onDisk;
			const detail = sameVersion && error instanceof Error ? ` (${error.message})` : "";
			throw new PlannotatorUpdatedError(`${message}${detail}`, { cause: error });
		}
		throw error;
	}
}

export function launchFailureText(prefix: string, error: unknown): string {
	if (isPlannotatorUpdatedError(error)) return error.message;
	return `${prefix}: ${error instanceof Error ? error.message : "Unknown error"}`;
}
