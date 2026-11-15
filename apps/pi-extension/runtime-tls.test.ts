/**
 * The runtime warning that replaced the package's Node engines floor (#902):
 * which runtimes lack the October 2026 TLS fixes, Bun judged as Bun, and at
 * most one warning per Pi start.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EMSIGN_ECC_G3_PEM } from "../../scripts/check-bun-runtime-trust.ts";
import { runtimeTlsWarning, warnRuntimeTlsOnce } from "./runtime-tls.ts";

/** Any other root, as Bun's store lists it (64-column PEM). */
const OTHER_ROOT = `-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ2xlYW4tcm9vdC1mb3ItdGVzdHMwCgYIKoZIzj0EAwIw\n-----END CERTIFICATE-----\n`;
/** Bun's store as it was before the fix (still holds emSign ECC Root CA - G3), wrapped at 64 columns like Bun lists it. */
const G3_WRAPPED = EMSIGN_ECC_G3_PEM.replace(/\s/g, "")
	.replace("-----BEGINCERTIFICATE-----", "")
	.replace("-----ENDCERTIFICATE-----", "")
	.match(/.{1,64}/g)!
	.join("\n");
const UNFIXED_ROOTS = [OTHER_ROOT, `-----BEGIN CERTIFICATE-----\n${G3_WRAPPED}\n-----END CERTIFICATE-----\n`];
/** A store with the fix (NSS 3.131.1): G3 is gone. */
const FIXED_ROOTS = [OTHER_ROOT];

const WARNED = Symbol.for("plannotator.pi.runtimeTlsWarned");
const store = globalThis as Record<symbol, unknown>;
const saved = store[WARNED];

afterEach(() => {
	if (saved === undefined) delete store[WARNED];
	else store[WARNED] = saved;
});

describe("runtimeTlsWarning", () => {
	test("Node releases with the fixes get no warning", () => {
		for (const node of ["22.23.4", "22.30.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0", "27.0.0", "30.1.2"]) {
			expect(runtimeTlsWarning({ node })).toBeNull();
		}
	});

	test("Node releases without them are named, with the versions to move to", () => {
		for (const node of ["18.20.4", "20.19.0", "22.23.3", "23.11.0", "24.15.0", "24.22.0", "25.2.1", "26.12.0"]) {
			expect(runtimeTlsWarning({ node })).toBe(
				`Plannotator: your Node v${node} is missing the October 2026 TLS fixes (a compromised certificate authority); update to 22.23.4, 24.22.1 or 26.12.1 or later.`,
			);
		}
	});

	test("on Bun only Bun's version counts, whatever Node version it reports", () => {
		expect(runtimeTlsWarning({ bun: "1.4.4", node: "24.3.0" }, "/usr/local/bin/bun")).toBeNull();
		expect(runtimeTlsWarning({ bun: "1.5.0", node: "20.0.0" }, "/usr/local/bin/bun")).toBeNull();
		expect(runtimeTlsWarning({ bun: "1.3.14", node: "24.22.1" }, "/usr/local/bin/bun", UNFIXED_ROOTS)).toBe(
			"Plannotator: your Bun v1.3.14 is missing the October 2026 TLS fixes (a compromised certificate authority); update Bun to 1.4.4 or later.",
		);
		expect(runtimeTlsWarning({ bun: "1.3.14" }, "C:\\Users\\me\\.bun\\bin\\bun.exe", UNFIXED_ROOTS)).toContain("update Bun to 1.4.4");
	});

	test("Pi's Bun-compiled binary is told to update Pi, not Bun", () => {
		for (const execPath of ["/Users/me/.pi/bin/pi", "C:\\Program Files\\pi\\pi.exe"]) {
			expect(runtimeTlsWarning({ bun: "1.3.14", node: "24.3.0" }, execPath, UNFIXED_ROOTS)).toBe(
				"Plannotator: this Pi build runs on Bun v1.3.14, which is missing the October 2026 TLS fixes (a compromised certificate authority); update Pi to a build with Bun 1.4.4 or later.",
			);
		}
	});

	test("a Bun below 1.4.4 with the fix ported (its roots dropped emSign G3) gets no warning (#2914)", () => {
		for (const execPath of ["/opt/pi-bolt/bin/pi", "/usr/local/bin/bun"]) {
			expect(runtimeTlsWarning({ bun: "1.4.3", node: "24.3.0" }, execPath, FIXED_ROOTS)).toBeNull();
			expect(runtimeTlsWarning({ bun: "1.4.3", node: "24.3.0" }, execPath, UNFIXED_ROOTS)).toContain("missing the October 2026 TLS fixes");
		}
	});

	test("the probe reads this Bun's real store: G3 is there before 1.4.4 and gone from 1.4.4", () => {
		const fixed = Bun.semver.order(Bun.version, "1.4.4") >= 0;
		const warning = runtimeTlsWarning({ bun: "1.4.3" }, "/usr/local/bin/bun");
		expect(warning === null).toBe(fixed);
	});

	test("an empty root store proves nothing: the version decides", () => {
		expect(runtimeTlsWarning({ bun: "1.4.3" }, "/usr/local/bin/bun", [])).toContain("update Bun to 1.4.4");
	});

	test("an unreadable version is not warned about", () => {
		expect(runtimeTlsWarning({ node: "" })).toBeNull();
		expect(runtimeTlsWarning({})).toBeNull();
	});
});

describe("warnRuntimeTlsOnce", () => {
	test("warns once per start, however many sessions or reloads follow", () => {
		delete store[WARNED];
		const shown: string[] = [];
		expect(warnRuntimeTlsOnce((m) => shown.push(m), { node: "24.15.0" })).toBe(true);
		expect(warnRuntimeTlsOnce((m) => shown.push(m), { node: "24.15.0" })).toBe(false);
		expect(shown).toHaveLength(1);
	});

	test("a ported fix shows nothing", () => {
		delete store[WARNED];
		const shown: string[] = [];
		expect(warnRuntimeTlsOnce((m) => shown.push(m), { bun: "1.4.3" }, "/opt/pi-bolt/bin/pi", FIXED_ROOTS)).toBe(false);
		expect(shown).toEqual([]);
	});

	test("a fixed runtime shows nothing", () => {
		delete store[WARNED];
		const shown: string[] = [];
		expect(warnRuntimeTlsOnce((m) => shown.push(m), { node: "24.22.1" })).toBe(false);
		expect(shown).toEqual([]);
	});
});
