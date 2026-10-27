/**
 * One quiet warning when Pi runs on a runtime without the October 2026 TLS
 * fixes (the compromised eMudhra certificate authority): Node 22.23.4,
 * 24.22.1 and 26.12.1 (NSS 3.131.1 roots, chains with blocked keys rejected,
 * nodejs/node#66871), Bun 1.4.4.
 *
 * This replaces the package's `engines.node` floor (#902): npm passes over a
 * release whose engines the running Node misses when it resolves a bare name
 * or a range, so Pi on an older Node silently stayed on an old Plannotator,
 * with no gain (the old version runs on the same Node). Updates must always
 * install; the warning says what to fix instead.
 */

type Triple = readonly [number, number, number];

/** The first fixed release on each Node line that has one. 20 and older, 23 and 25 have none. */
const NODE_FIXED: readonly Triple[] = [
	[22, 23, 4],
	[24, 22, 1],
	[26, 12, 1],
];
const BUN_FIXED: Triple = [1, 4, 4];

function parse(version: string | undefined): Triple | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(a: Triple, b: Triple): boolean {
	for (let i = 0; i < 3; i++) {
		if (a[i]! !== b[i]!) return a[i]! > b[i]!;
	}
	return true;
}

function nodeFixed(v: Triple): boolean {
	const last = NODE_FIXED[NODE_FIXED.length - 1]!;
	if (v[0] > last[0]) return true;
	const line = NODE_FIXED.find((fixed) => fixed[0] === v[0]);
	return !!line && atLeast(v, line);
}

/**
 * Whether this process is a Bun-compiled program (Pi's standalone binary)
 * rather than the `bun` executable running Pi: a compiled program's execPath
 * is the program itself. Its Bun comes with it, so the fix is a newer Pi.
 */
function bunCompiled(execPath: string): boolean {
	const name = execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	return !/^bun(-debug)?(\.exe)?$/.test(name);
}

/**
 * The warning for this runtime, or null when it has the fixes (or its version
 * can't be read). Bun is checked first: it reports a Node-compatible
 * `process.versions.node` but brings its own TLS and root store.
 */
export function runtimeTlsWarning(
	versions: Partial<Record<string, string>> = process.versions,
	execPath: string = process.execPath,
): string | null {
	if (versions.bun) {
		const bun = parse(versions.bun);
		if (!bun || atLeast(bun, BUN_FIXED)) return null;
		return bunCompiled(execPath)
			? `Plannotator: this Pi build runs on Bun v${versions.bun}, which is missing the October 2026 TLS fixes (a compromised certificate authority); update Pi to a build with Bun 1.4.4 or later.`
			: `Plannotator: your Bun v${versions.bun} is missing the October 2026 TLS fixes (a compromised certificate authority); update Bun to 1.4.4 or later.`;
	}
	const node = parse(versions.node);
	if (!node || nodeFixed(node)) return null;
	return `Plannotator: your Node v${versions.node} is missing the October 2026 TLS fixes (a compromised certificate authority); update to 22.23.4, 24.22.1 or 26.12.1 or later.`;
}

const WARNED = Symbol.for("plannotator.pi.runtimeTlsWarned");

/**
 * Show the warning at most once per Pi start: the latch lives on globalThis,
 * so a `/reload` (which imports the extension again) or a new session does not
 * repeat it. Returns whether it was shown.
 */
export function warnRuntimeTlsOnce(
	notify: (message: string) => void,
	versions: Partial<Record<string, string>> = process.versions,
	execPath: string = process.execPath,
): boolean {
	const store = globalThis as Record<symbol, unknown>;
	if (store[WARNED]) return false;
	const warning = runtimeTlsWarning(versions, execPath);
	if (!warning) return false;
	store[WARNED] = true;
	notify(warning);
	return true;
}
