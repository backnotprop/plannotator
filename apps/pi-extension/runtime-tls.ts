import tls from "node:tls";

type Triple = readonly [number, number, number];

const NODE_FIXED: readonly Triple[] = [
	[22, 23, 4],
	[24, 22, 1],
	[26, 12, 1],
];
const BUN_FIXED: Triple = [1, 4, 4];

const EMSIGN_ECC_G3_BODY =
	"MIICTjCCAdOgAwIBAgIKPPYHqWhwDtqLhDAKBggqhkjOPQQDAzBrMQswCQYDVQQGEwJJTjETMBEG" +
	"A1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRlZDEg" +
	"MB4GA1UEAxMXZW1TaWduIEVDQyBSb290IENBIC0gRzMwHhcNMTgwMjE4MTgzMDAwWhcNNDMwMjE4" +
	"MTgzMDAwWjBrMQswCQYDVQQGEwJJTjETMBEGA1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11" +
	"ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRlZDEgMB4GA1UEAxMXZW1TaWduIEVDQyBSb290IENBIC0g" +
	"RzMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQjpQy4LRL1KPOxst3iAhKAnjlfSU2fySU0WXTsuwYc" +
	"58Byr+iuL+FBVIcUqEqy6HyC5ltqtdyzdc6LBtCGI79G1Y4PPwT01xySfvalY8L1X44uT6EYGQIr" +
	"MgqCZH0Wk9GjQjBAMB0GA1UdDgQWBBR8XQKEE9TMipuBzhccLikenEhjQjAOBgNVHQ8BAf8EBAMC" +
	"AQYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAwNpADBmAjEAvvNhzwIQHWSVB7gYboiFBS+D" +
	"CBeQyh+KTOgNG3qxrdWBCUfvO6wIBHxcmbHtRwfSAjEAnbpV/KlK6O3t5nYBQnvI+GDZjVGLVTv7" +
	"jHvrZQnD+JbNR6iC8hZVdyR+EhCVBCyj";

function bunRootsFixed(roots: readonly string[]): boolean {
	if (roots.length === 0) return false;
	return !roots.some((pem) => pem.replace(/-----[^-]+-----|\s/g, "") === EMSIGN_ECC_G3_BODY);
}

function bundledRoots(): readonly string[] {
	try {
		return tls.rootCertificates;
	} catch {
		return [];
	}
}

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

function bunCompiled(execPath: string): boolean {
	const name = execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	return !/^bun(-debug)?(\.exe)?$/.test(name);
}

export function runtimeTlsWarning(
	versions: Partial<Record<string, string>> = process.versions,
	execPath: string = process.execPath,
	roots?: readonly string[],
): string | null {
	if (versions.bun) {
		const bun = parse(versions.bun);
		if (!bun || atLeast(bun, BUN_FIXED)) return null;
		if (bunRootsFixed(roots ?? bundledRoots())) return null;
		return bunCompiled(execPath)
			? `Plannotator: this Pi build runs on Bun v${versions.bun}, which is missing the October 2026 TLS fixes (a compromised certificate authority); update Pi to a build with Bun 1.4.4 or later.`
			: `Plannotator: your Bun v${versions.bun} is missing the October 2026 TLS fixes (a compromised certificate authority); update Bun to 1.4.4 or later.`;
	}
	const node = parse(versions.node);
	if (!node || nodeFixed(node)) return null;
	return `Plannotator: your Node v${versions.node} is missing the October 2026 TLS fixes (a compromised certificate authority); update to 22.23.4, 24.22.1 or 26.12.1 or later.`;
}

const WARNED = Symbol.for("plannotator.pi.runtimeTlsWarned");

export function warnRuntimeTlsOnce(
	notify: (message: string) => void,
	versions: Partial<Record<string, string>> = process.versions,
	execPath: string = process.execPath,
	roots?: readonly string[],
): boolean {
	const store = globalThis as Record<symbol, unknown>;
	if (store[WARNED]) return false;
	const warning = runtimeTlsWarning(versions, execPath, roots);
	if (!warning) return false;
	store[WARNED] = true;
	notify(warning);
	return true;
}
