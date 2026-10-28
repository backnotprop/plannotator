/**
 * Per-session pins on the folders a review reads from.
 *
 * Why: every guarded read (repo-file.ts) and every git or jj command resolves
 * its folder again by path. Someone who can write a reviewed folder's parent
 * (a worktree under `.claude/worktrees`, a repo in /tmp, a nested repo) can
 * `mv repo repo.old; ln -s /elsewhere repo` mid-review, and every later check
 * would pass against the new "root". A pin keeps the folder's real path, dev
 * and ino as the session first saw it; a pinned folder that no longer
 * resolves to that same directory is refused ("root-replaced").
 *
 * Pins are per session ({@link RepoRootPins}). A server makes one when it
 * starts, pins the folders it was opened on (and their git toplevels, every
 * workspace member, every PR worktree its pool creates) and runs each request
 * inside it ({@link RepoRootPins.run}, an AsyncLocalStorage scope), so the
 * readers and the command runners find the session without threading it
 * through every call. Sessions never share or overwrite pins: a new session on
 * a recreated folder pins the new directory, and an old session that is never
 * stopped holds pins that only its own requests see.
 *
 * Trusted and first-use pins: folders pinned by the server (`pin`) are
 * trusted. A folder first seen in a request is pinned then (first use), which
 * guards it from later swaps, but only a trusted pin may stand as the git
 * toplevel above a reviewed folder ({@link checkRepoToplevel}): the toplevel
 * comes from `git rev-parse`, which a racing swap can point at any repo above.
 *
 * Without a session (tests, the VS Code guide source) nothing is pinned and
 * every check only resolves the path.
 *
 * Gated commands ({@link checkRepoCommandCwd}): git, jj, but and p4, the
 * code-nav search, semantic diff and call flow. Agents the review launches
 * are not gated; they act for the user in the folder they were given.
 *
 * Residual: a check runs before the tool starts, and the tool opens paths
 * itself. A swap that lands after the check and before the tool resolves
 * its working folder cannot be caught from here; the ceiling set for git
 * ({@link checkRepoCommandCwd}) still stops it from discovering a repository
 * above the session's folders.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

interface RootPin {
	/** The folder as the session named it, resolved lexically. */
	path: string;
	real: string;
	dev: bigint;
	ino: bigint;
	/** Pinned by the server (startup, pool), not on first use in a request. */
	trusted: boolean;
}

interface DirIdentity {
	real: string;
	dev: bigint;
	ino: bigint;
}

const scope = new AsyncLocalStorage<RepoRootPins>();

function identityOf(path: string): DirIdentity | null {
	try {
		const real = realpathSync(path);
		const stats = lstatSync(real, { bigint: true });
		if (!stats.isDirectory()) return null;
		return { real, dev: stats.dev, ino: stats.ino };
	} catch {
		return null;
	}
}

function sameDir(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

/** Case folds where the usual filesystem does (macOS, Windows), for containment only. */
function comparable(path: string): string {
	return process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
}

function isInside(candidate: string, root: string): boolean {
	const c = comparable(candidate);
	const r = comparable(root);
	if (c === r) return true;
	return c.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

/** The pinned directory is still there, under the same real path, as the same directory. */
function pinHolds(pin: RootPin): boolean {
	const now = identityOf(pin.path);
	return now !== null && now.real === pin.real && sameDir(now, pin);
}

export type RepoRootCheck =
	| { ok: true; realRoot: string }
	| { ok: false; reason: "not-found" | "root-replaced" };

/** One review session's pins. See the module header. */
export class RepoRootPins {
	#pins: RootPin[] = [];
	#closed = false;

	constructor(paths?: Iterable<string | null | undefined>) {
		if (paths) this.pin(paths);
	}

	/**
	 * Pin folders this session trusts as they are now. A folder already pinned
	 * keeps its pin (a first-use pin of the same directory becomes trusted).
	 * Missing folders are skipped.
	 */
	pin(paths: Iterable<string | null | undefined>): void {
		if (this.#closed) return;
		for (const path of paths) {
			if (!path) continue;
			const existing = this.#byPath(path);
			if (existing) {
				if (!existing.trusted && pinHolds(existing)) existing.trusted = true;
				continue;
			}
			const identity = identityOf(path);
			if (identity) this.#pins.push({ path: resolve(path), ...identity, trusted: true });
		}
	}

	/** Run `fn` (a request) in this session, so the readers and runners find its pins. */
	run<T>(fn: () => T): T {
		return scope.run(this, fn);
	}

	/** `handler` (a node:http request listener) run in this session. */
	scoped<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
		return (...args: A) => this.run(() => handler(...args));
	}

	/** Bun.serve options whose `fetch` runs in this session. */
	scopeFetch<T extends object>(options: T): T {
		const record = options as Record<string, unknown>;
		const fetch = record.fetch;
		if (typeof fetch === "function") {
			const pins = this;
			record.fetch = function (this: unknown, ...args: unknown[]) {
				return pins.run(() => fetch.apply(this, args));
			};
		}
		return options;
	}

	/** End the session: its pins are dropped and its scope stops guarding. */
	release(): void {
		this.#closed = true;
		this.#pins = [];
	}

	get closed(): boolean {
		return this.#closed;
	}

	#byPath(path: string): RootPin | undefined {
		const key = resolve(path);
		return this.#pins.find((pin) => pin.path === key) ?? this.#pins.find((pin) => pin.real === key);
	}

	/** @internal */
	check(root: string): RepoRootCheck {
		const now = identityOf(root);
		const pin = this.#byPath(root) ?? (now ? this.#pins.find((p) => sameDir(p, now)) : undefined);
		if (!pin) {
			if (!now) return { ok: false, reason: "not-found" };
			this.#pins.push({ path: resolve(root), ...now, trusted: false });
			return { ok: true, realRoot: now.real };
		}
		if (!now || !sameDir(now, pin) || !pinHolds(pin)) return { ok: false, reason: "root-replaced" };
		return { ok: true, realRoot: pin.real };
	}

	/** @internal A trusted pin of this very directory that still holds. */
	trustedPinOf(identity: DirIdentity): RootPin | undefined {
		return this.#pins.find((pin) => pin.trusted && sameDir(pin, identity) && pinHolds(pin));
	}

	/** @internal Pins whose folder holds `path` (lexically or by real path). */
	pinsAround(path: string, real: string | null): RootPin[] {
		return this.#pins.filter((pin) =>
			isInside(path, pin.path) || isInside(path, pin.real) || (real !== null && isInside(real, pin.real)),
		);
	}
}

function currentPins(): RepoRootPins | undefined {
	const pins = scope.getStore();
	return pins && !pins.closed ? pins : undefined;
}

/**
 * The root's real path, held to the current session's pin: it must still be
 * the pinned directory (same real path, dev and ino). An unpinned root is
 * pinned here (first use). With no session the root is only resolved.
 */
export function checkPinnedRoot(root: string): RepoRootCheck {
	const pins = currentPins();
	if (pins) return pins.check(root);
	try {
		return { ok: true, realRoot: realpathSync(root) };
	} catch {
		return { ok: false, reason: "not-found" };
	}
}

/**
 * Accept `top` (from `git rev-parse --show-toplevel` in `cwd`) as the folder
 * working-tree paths are read under, or null. `cwd` must hold to its pin. In
 * a session, `top` is accepted when it is the same directory as `cwd` (by dev
 * and ino) or a trusted pin of this session that holds `cwd`; a toplevel above
 * `cwd` that the server never pinned is refused, since a racing swap can make
 * rev-parse name any repository above. Without a session, any `top` that
 * holds `cwd` is accepted. Returns the real path to read under.
 */
export function checkRepoToplevel(cwd: string, top: string): string | null {
	const pinnedCwd = checkPinnedRoot(cwd);
	if (!pinnedCwd.ok) return null;
	const cwdIdentity = identityOf(pinnedCwd.realRoot);
	const topIdentity = identityOf(top);
	if (!cwdIdentity || !topIdentity) return null;
	if (sameDir(cwdIdentity, topIdentity)) return pinnedCwd.realRoot;
	if (!isInside(cwdIdentity.real, topIdentity.real)) return null;
	const pins = currentPins();
	if (!pins) return topIdentity.real;
	const pin = pins.trustedPinOf(topIdentity);
	if (!pin || !isInside(cwdIdentity.real, pin.real)) return null;
	return pin.real;
}

export type RepoCommandCheck =
	| { ok: true; gitCeiling?: string }
	| { ok: false; message: string };

export const ROOT_REPLACED_MESSAGE = "The repository folder was replaced during the review";

/**
 * Gate for running git or jj in `cwd`. In a session, when `cwd` is a pinned
 * folder or lies under one, every such pin must still hold and `cwd` must
 * still resolve inside it; otherwise the command must not run (a replaced
 * folder would make git read another repository). `gitCeiling` is the parent
 * of the outermost trusted pin around `cwd`: passed as
 * GIT_CEILING_DIRECTORIES it stops git discovering a repository above the
 * session's folders (say after `.git` is removed from the reviewed repo).
 */
export function checkRepoCommandCwd(cwd: string | undefined): RepoCommandCheck {
	const pins = currentPins();
	if (!pins || !cwd) return { ok: true };
	const path = resolve(cwd);
	let real: string | null;
	try {
		real = realpathSync(path);
	} catch {
		real = null;
	}
	const around = pins.pinsAround(path, real);
	if (around.length === 0) return { ok: true };
	for (const pin of around) {
		if (!pinHolds(pin)) return { ok: false, message: ROOT_REPLACED_MESSAGE };
	}
	// A missing folder fails in the tool itself. One that resolves outside the
	// innermost pin naming it (a swapped subfolder) must not run; a pinned
	// folder that is itself a link (a workspace member linked in) names its
	// own target, so it is the innermost pin and passes.
	let innermost: RootPin | undefined;
	for (const pin of around) {
		const named = isInside(path, pin.path) ? pin.path : isInside(path, pin.real) ? pin.real : null;
		if (named === null) continue;
		const innermostNamed = innermost && (isInside(path, innermost.path) ? innermost.path : innermost.real);
		if (!innermostNamed || named.length > innermostNamed.length) innermost = pin;
	}
	if (real !== null && innermost && !isInside(real, innermost.real)) {
		return { ok: false, message: ROOT_REPLACED_MESSAGE };
	}
	// The ceiling sits above the outermost trusted pin around the folder's
	// real path, which is the path git walks up from.
	let outermost: RootPin | undefined;
	for (const pin of around) {
		if (!pin.trusted || real === null || !isInside(real, pin.real)) continue;
		if (!outermost || pin.real.length < outermost.real.length) outermost = pin;
	}
	if (!outermost) return { ok: true };
	const parent = dirname(outermost.real);
	return parent === outermost.real ? { ok: true } : { ok: true, gitCeiling: parent };
}

/** GIT_CEILING_DIRECTORIES with `ceiling` added to whatever `env` already lists. */
export function withGitCeiling(env: NodeJS.ProcessEnv, ceiling: string | undefined): NodeJS.ProcessEnv {
	if (!ceiling) return env;
	const delimiter = process.platform === "win32" ? ";" : ":";
	const existing = env.GIT_CEILING_DIRECTORIES;
	return { ...env, GIT_CEILING_DIRECTORIES: existing ? `${existing}${delimiter}${ceiling}` : ceiling };
}
