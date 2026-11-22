/**
 * The network key's rule (#956): who passes without it, what a link or the
 * cookie must carry, and the ready-made link for another computer. Driven
 * against real servers in packages/server/network-key.scenarios.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	anotherComputerUrl,
	isThisMachinePeer,
	loadNetworkKey,
	NETWORK_KEY_FILE,
	NETWORK_KEY_REFUSAL_HTML,
	networkKeyCookieName,
	networkKeyRefusalBody,
	networkKeyVerdict,
	readCookie,
	resetNetworkKeysForTests,
	setThisMachineForTests,
	sshServerAddress,
	withNetworkKey,
	withoutNetworkKey,
	type NetworkKeyRequest,
} from "./network-key";

const KEY = "A".repeat(43);

afterEach(() => {
	setThisMachineForTests(null);
	resetNetworkKeysForTests();
});

const other = (over: Partial<NetworkKeyRequest> = {}): NetworkKeyRequest => ({
	method: "GET",
	url: "/api/plan",
	peer: "192.168.1.50",
	cookie: null,
	...over,
});

describe("loadNetworkKey", () => {
	test("creates one key per data dir, private to its owner, and keeps it across processes", () => {
		const dir = mkdtempSync(join(tmpdir(), "plannotator-network-key-"));
		const key = loadNetworkKey(dir);
		expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const file = join(dir, NETWORK_KEY_FILE);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		// A later session (a new process: the cache forgotten) reads the same key.
		resetNetworkKeysForTests();
		expect(loadNetworkKey(dir)).toBe(key);
		expect(readFileSync(file, "utf8").trim()).toBe(key);
	});

	test("a file that is not a key is replaced", () => {
		const dir = mkdtempSync(join(tmpdir(), "plannotator-network-key-"));
		writeFileSync(join(dir, NETWORK_KEY_FILE), "not a key\n");
		const key = loadNetworkKey(dir);
		expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
		resetNetworkKeysForTests();
		expect(loadNetworkKey(dir)).toBe(key);
	});
});

describe("this machine", () => {
	test("loopback in every form passes: IPv4, IPv6, IPv4 mapped into IPv6", () => {
		for (const peer of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "[::1]"]) {
			expect(isThisMachinePeer(peer)).toBe(true);
		}
	});

	test("one of this machine's own addresses passes (LAN or tailnet), any other address does not", () => {
		setThisMachineForTests({ addresses: ["192.168.1.20", "100.101.102.103", "fd7a:115c:a1e0::1"] });
		expect(isThisMachinePeer("192.168.1.20")).toBe(true);
		expect(isThisMachinePeer("::ffff:192.168.1.20")).toBe(true);
		expect(isThisMachinePeer("100.101.102.103")).toBe(true);
		expect(isThisMachinePeer("FD7A:115C:A1E0::1")).toBe(true);
		expect(isThisMachinePeer("192.168.1.50")).toBe(false);
		expect(isThisMachinePeer("100.64.0.9")).toBe(false);
		expect(isThisMachinePeer(undefined)).toBe(false);
		expect(isThisMachinePeer("")).toBe(false);
	});
});

describe("networkKeyVerdict", () => {
	test("this machine passes with no key at all (tunnels, the VS Code panel, agents, plugins)", () => {
		for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
			expect(networkKeyVerdict(other({ peer }), KEY)).toEqual({ kind: "pass" });
			expect(networkKeyVerdict(other({ peer, method: "POST", url: "/api/approve" }), KEY)).toEqual({ kind: "pass" });
		}
	});

	test("another computer without the key is refused: a page load gets the page, anything else JSON", () => {
		expect(networkKeyVerdict(other({ url: "/", secFetchDest: "document" }), KEY)).toEqual({ kind: "refuse", page: true });
		expect(networkKeyVerdict(other({ url: "/", accept: "text/html,application/xhtml+xml" }), KEY)).toEqual({ kind: "refuse", page: true });
		expect(networkKeyVerdict(other(), KEY)).toEqual({ kind: "refuse", page: false });
		expect(networkKeyVerdict(other({ method: "POST", url: "/api/approve" }), KEY)).toEqual({ kind: "refuse", page: false });
		expect(networkKeyVerdict(other({ url: "/ws", upgrade: true, accept: "text/html" }), KEY)).toEqual({ kind: "refuse", page: false });
		// An unknown peer is not this machine.
		expect(networkKeyVerdict(other({ peer: undefined }), KEY).kind).toBe("refuse");
	});

	test("a page load with the key sets the cookie and goes back to the same address without it", () => {
		const verdict = networkKeyVerdict(other({ url: `/?key=${KEY}&client=abc`, secFetchDest: "document" }), KEY);
		expect(verdict.kind).toBe("keep");
		if (verdict.kind !== "keep") return;
		expect(verdict.location).toBe("/?client=abc");
		expect(verdict.setCookie).toBe(`${networkKeyCookieName(KEY)}=${KEY}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax`);
		// Where it goes back to has no key, so a browser that drops the cookie is refused, never redirected again.
		expect(networkKeyVerdict(other({ url: verdict.location, secFetchDest: "document" }), KEY)).toEqual({ kind: "refuse", page: true });
		const bare = networkKeyVerdict(other({ url: `/?key=${KEY}`, secFetchDest: "document" }), KEY);
		expect(bare.kind === "keep" && bare.location).toBe("/");
	});

	test("the key in an API call's URL passes it; the cookie passes everything (reloads, second tabs, upgrades)", () => {
		expect(networkKeyVerdict(other({ url: `/api/plan?key=${KEY}` }), KEY)).toEqual({ kind: "pass" });
		const cookie = `theme=dark; ${networkKeyCookieName(KEY)}=${KEY}`;
		expect(networkKeyVerdict(other({ cookie }), KEY)).toEqual({ kind: "pass" });
		expect(networkKeyVerdict(other({ cookie, url: "/", secFetchDest: "document" }), KEY)).toEqual({ kind: "pass" });
		expect(networkKeyVerdict(other({ cookie, method: "POST", url: "/api/approve" }), KEY)).toEqual({ kind: "pass" });
		expect(networkKeyVerdict(other({ cookie, upgrade: true, url: "/api/agent-terminal/ws" }), KEY)).toEqual({ kind: "pass" });
	});

	test("a wrong key, a key under another name, or another machine's cookie is refused", () => {
		const wrong = "B".repeat(43);
		expect(networkKeyVerdict(other({ url: `/api/plan?key=${wrong}` }), KEY).kind).toBe("refuse");
		expect(networkKeyVerdict(other({ url: `/api/plan?k=${KEY}` }), KEY).kind).toBe("refuse");
		expect(networkKeyVerdict(other({ cookie: `${networkKeyCookieName(KEY)}=${wrong}` }), KEY).kind).toBe("refuse");
		expect(networkKeyVerdict(other({ cookie: `${networkKeyCookieName(wrong)}=${wrong}` }), KEY).kind).toBe("refuse");
		expect(networkKeyVerdict(other({ url: `/api/plan?key=${KEY.slice(1)}` }), KEY).kind).toBe("refuse");
	});

	test("the annotated-HTML frame's token paths pass (its sandbox sends no SameSite cookie)", () => {
		expect(networkKeyVerdict(other({ url: "/api/html-assets/0123456789abcdef/style.css" }), KEY)).toEqual({ kind: "pass" });
		expect(networkKeyVerdict(other({ url: "/api/html-assetsX" }), KEY).kind).toBe("refuse");
	});

	test("the cookie's name never holds the key, and the refusals never do", () => {
		expect(networkKeyCookieName(KEY)).not.toContain(KEY);
		expect(NETWORK_KEY_REFUSAL_HTML).not.toContain(KEY);
		expect(JSON.stringify(networkKeyRefusalBody())).not.toContain(KEY);
	});
});

describe("cookies and URLs", () => {
	test("readCookie finds one cookie among several", () => {
		expect(readCookie("a=1; b=2;c=3", "b")).toBe("2");
		expect(readCookie("a=1", "b")).toBeNull();
		expect(readCookie(null, "b")).toBeNull();
		expect(readCookie("ab=1", "b")).toBeNull();
	});

	test("withNetworkKey and withoutNetworkKey keep the rest of the URL", () => {
		expect(withNetworkKey("http://devbox:19432", KEY)).toBe(`http://devbox:19432/?key=${KEY}`);
		expect(withNetworkKey("https://review.example.com/plannotator/", KEY)).toBe(`https://review.example.com/plannotator/?key=${KEY}`);
		expect(withoutNetworkKey(`http://devbox:19432/?key=${KEY}`)).toBe("http://devbox:19432/");
		expect(withoutNetworkKey("http://localhost:19432")).toBe("http://localhost:19432");
	});
});

describe("the link for another computer", () => {
	test("is built from the SSH connection's own address while it is still this machine's", () => {
		setThisMachineForTests({ addresses: ["10.0.0.1", "fd00::5"] });
		expect(anotherComputerUrl(19432, "10.0.0.2 51000 10.0.0.1 22", KEY)).toBe(`http://10.0.0.1:19432/?key=${KEY}`);
		expect(anotherComputerUrl(19432, "fd00::9 51000 fd00::5 22", KEY)).toBe(`http://[fd00::5]:19432/?key=${KEY}`);
		expect(sshServerAddress("10.0.0.2 51000 ::ffff:10.0.0.1 22")).toBe("10.0.0.1");
	});

	test("is not printed when the address is unknown or would be wrong", () => {
		setThisMachineForTests({ addresses: ["10.0.0.1", "127.0.0.1", "fe80::1"] });
		for (const value of [
			undefined,
			"",
			"garbage",
			"10.0.0.2 51000 10.0.0.9 22", // a tmux session that outlived its connection: no longer this machine's
			"127.0.0.1 51000 127.0.0.1 22", // ssh to localhost
			"fe80::2 51000 fe80::1 22", // link-local needs a zone
			"10.0.0.2 51000 0.0.0.0 22",
			"10.0.0.2 51000 999.0.0.1 22",
			"10.0.0.2 51000 devbox 22",
		]) {
			expect(anotherComputerUrl(19432, value, KEY)).toBeNull();
		}
	});
});
