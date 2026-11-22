/**
 * The network key of a session that SSH alone put in remote mode (#956).
 *
 * Over SSH with `PLANNOTATOR_REMOTE` unset, the plan, review and annotate
 * servers still bind every interface on 19432, so a browser on another
 * computer can open `http://<host>:19432`. Before this, anything that reached
 * the port could also read the plan or diff and decide it. Now a request is
 * answered as before when its TCP peer is this machine (loopback, or one of
 * this machine's own interface addresses: every `ssh -L` tunnel, editor port
 * forward, the VS Code panel proxy, an agent or plugin calling the API), and
 * any other peer must bring this machine's key: `?key=<key>` in the URL once,
 * which the server answers by setting a cookie and sending the browser back to
 * the same address without it, or that cookie afterwards (reloads, second tabs,
 * later sessions on the same port).
 *
 * The key is random, one per data directory (`<data dir>/network-key`, mode
 * 0600), so a link or cookie keeps working across sessions. Explicit remote
 * mode (`PLANNOTATOR_REMOTE=1`) and local mode never check it.
 *
 * Runtime-agnostic apart from node:crypto, node:fs and node:os (vendored to Pi
 * as generated/network-key.ts). The adapters are
 * packages/server/network-key-guard.ts and
 * apps/pi-extension/server/network-key-guard.ts.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

/** The query parameter a link carries the key in. */
export const NETWORK_KEY_PARAM = "key";
/** The key's file in the data directory. */
export const NETWORK_KEY_FILE = "network-key";
/** `code` of the JSON refusal, and `X-Plannotator-Error` of every refusal. */
export const NETWORK_KEY_REQUIRED_CODE = "network_key_required";

/** 32 random bytes, base64url. */
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
/** 400 days: the longest a browser keeps a cookie. */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
/**
 * The annotated-HTML frame's support files. The frame is sandboxed without
 * `allow-same-origin`, so its requests carry no SameSite cookie; each path
 * already holds an unguessable token that only a keyed page is given.
 */
const CAPABILITY_PATH_PREFIX = "/api/html-assets/";

const keys = new Map<string, string>();

/** How long a reader waits for an empty key file another process is still writing. */
const EMPTY_FILE_WAIT_MS = 500;
const EMPTY_FILE_POLL_MS = 25;
/** An empty key file older than this was abandoned (its writer died): it may be replaced. */
const EMPTY_FILE_ABANDONED_MS = 2_000;

/** Tests only: how loadNetworkKey waits (see setNetworkKeyWaitForTests). */
let waitForTests: ((ms: number) => void) | null = null;

function sleepSync(ms: number): void {
	if (waitForTests) return waitForTests(ms);
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {}
}

type KeyFileState =
	| { kind: "valid"; key: string }
	| { kind: "missing" }
	/** Empty: another process may be between creating it and writing the key. */
	| { kind: "empty"; ageMs: number }
	/** Holds something that is not a key. */
	| { kind: "invalid" };

function readKeyFile(file: string): KeyFileState {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
	}
	const value = text.trim();
	if (KEY_RE.test(value)) return { kind: "valid", key: value };
	if (value) return { kind: "invalid" };
	let ageMs = Number.POSITIVE_INFINITY;
	try {
		ageMs = Date.now() - statSync(file).mtimeMs;
	} catch {}
	return { kind: "empty", ageMs };
}

/** Keep an existing key file private to its owner (an older or hand-made one may be 0644). */
function tightenMode(file: string): void {
	if (process.platform === "win32") return;
	try {
		if (statSync(file).mode & 0o077) chmodSync(file, 0o600);
	} catch {}
}

/** A temp file next to `file` holding `key` (0600), or null. */
function writeTemp(file: string, key: string): string | null {
	const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, `${key}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		return temp;
	} catch {
		return null;
	}
}

function removeQuietly(file: string): void {
	try {
		unlinkSync(file);
	} catch {}
}

/**
 * Publish `key` as the key file only if there is none yet. The file appears
 * whole (a hard link of a finished temp file), so another process never sees
 * it empty. "created", "exists" (another process got there first), or
 * "failed" (nothing written).
 */
function publishIfAbsent(file: string, key: string): "created" | "exists" | "failed" {
	const temp = writeTemp(file, key);
	if (temp) {
		try {
			linkSync(temp, file);
			return "created";
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return "exists";
			// A filesystem without hard links: the exclusive create below.
		} finally {
			removeQuietly(temp);
		}
	}
	try {
		writeFileSync(file, `${key}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		return "created";
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EEXIST" ? "exists" : "failed";
	}
}

/** Replace a key file that holds no key (never a valid one), atomically. */
function replaceInvalid(file: string, key: string): void {
	const temp = writeTemp(file, key);
	if (!temp) return;
	try {
		renameSync(temp, file);
	} catch {
		removeQuietly(temp);
	}
}

/**
 * This data directory's key, created on first use (0600). Two sessions
 * starting at once agree on one key: the file is created whole, a reader that
 * finds it empty (an older writer between create and write) waits for it, and
 * a valid key is never overwritten. Never throws: an unwritable data directory
 * gets a key for this process only.
 */
export function loadNetworkKey(dataDir: string): string {
	const cached = keys.get(dataDir);
	if (cached) return cached;
	const file = join(dataDir, NETWORK_KEY_FILE);
	const key = resolveKey(dataDir, file);
	keys.set(dataDir, key);
	return key;
}

function resolveKey(dataDir: string, file: string): string {
	const fresh = randomBytes(32).toString("base64url");
	let state = readKeyFile(file);
	if (state.kind === "missing") {
		try {
			mkdirSync(dataDir, { recursive: true });
		} catch {}
		const published = publishIfAbsent(file, fresh);
		if (published === "created") return fresh;
		if (published === "failed") return fresh;
		state = readKeyFile(file);
	}
	for (let waited = 0; state.kind === "empty" && state.ageMs < EMPTY_FILE_ABANDONED_MS && waited < EMPTY_FILE_WAIT_MS; waited += EMPTY_FILE_POLL_MS) {
		sleepSync(EMPTY_FILE_POLL_MS);
		state = readKeyFile(file);
	}
	if (state.kind === "valid") {
		tightenMode(file);
		return state.key;
	}
	// Still empty but fresh: another writer may yet fill it; leave it alone.
	if (state.kind === "empty" && state.ageMs < EMPTY_FILE_ABANDONED_MS) return fresh;
	if (state.kind === "missing") return publishIfAbsent(file, fresh) === "exists" ? (validKey(file) ?? fresh) : fresh;
	// Abandoned empty, or not a key: replace it, then use whatever is there now.
	replaceInvalid(file, fresh);
	return validKey(file) ?? fresh;
}

function validKey(file: string): string | null {
	const state = readKeyFile(file);
	return state.kind === "valid" ? state.key : null;
}

/**
 * Tests only: replace loadNetworkKey's wait while it watches an empty key file
 * (so a test can play the other process finishing its write). `null` restores it.
 */
export function setNetworkKeyWaitForTests(wait: ((ms: number) => void) | null): void {
	waitForTests = wait;
}

/** Forget cached keys (tests). */
export function resetNetworkKeysForTests(): void {
	keys.clear();
}

/**
 * The cookie's name. It names the key (a hash prefix, never the key), so two
 * people's sessions on one shared machine do not overwrite each other's.
 */
export function networkKeyCookieName(key: string): string {
	return `plannotator_key_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** One cookie's value from a `Cookie` header, or null. */
export function readCookie(header: string | null | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() !== name) continue;
		return part.slice(eq + 1).trim();
	}
	return null;
}

/**
 * Constant-time comparison of a presented value with the key. Compares bytes,
 * not characters (a same-length value with a non-ASCII character is longer in
 * bytes, and timingSafeEqual throws on unequal lengths). Never throws.
 */
export function matchesNetworkKey(presented: string | null | undefined, key: string): boolean {
	if (typeof presented !== "string" || !presented) return false;
	try {
		const a = Buffer.from(presented, "utf8");
		const b = Buffer.from(key, "utf8");
		return a.length === b.length && timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

/** The `Set-Cookie` value that keeps the key for this host. */
export function networkKeySetCookie(key: string): string {
	return `${networkKeyCookieName(key)}=${key}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax`;
}

/** An address as compared here: lowercase, no zone, IPv4 mapped into IPv6 unwrapped. */
export function normalizePeerAddress(address: string | null | undefined): string {
	let a = (address ?? "").trim().toLowerCase();
	if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
	const zone = a.indexOf("%");
	if (zone !== -1) a = a.slice(0, zone);
	if (a.startsWith("::ffff:") && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(a.slice(7))) a = a.slice(7);
	return a;
}

function isLoopbackAddress(a: string): boolean {
	return a === "::1" || a === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(a);
}

/** Tests only: what counts as this machine, and who every request comes from (see setThisMachineForTests). */
let testRule: { addresses: readonly string[] | null; loopback: boolean; peer: string | null } | null = null;
let ownAddressesCache: { at: number; set: Set<string> } | null = null;
const OWN_ADDRESSES_TTL_MS = 5_000;

/** This machine's interface addresses, normalized (re-read every few seconds: DHCP, VPNs). */
export function ownInterfaceAddresses(): Set<string> {
	if (testRule?.addresses) return new Set(testRule.addresses.map(normalizePeerAddress));
	const now = Date.now();
	if (ownAddressesCache && now - ownAddressesCache.at < OWN_ADDRESSES_TTL_MS) return ownAddressesCache.set;
	const set = new Set<string>();
	try {
		for (const list of Object.values(networkInterfaces())) {
			for (const entry of list ?? []) set.add(normalizePeerAddress(entry.address));
		}
	} catch {}
	ownAddressesCache = { at: now, set };
	return set;
}

/**
 * Tests only, so a test on one machine can play another computer:
 * `addresses` replaces this machine's interface addresses, `loopback: false`
 * stops loopback peers counting as this machine, and `peer` is the TCP peer
 * every request is judged as coming from (servers stay bound to loopback).
 * `null` restores the real rule.
 */
export function setThisMachineForTests(rule: { addresses?: readonly string[]; loopback?: boolean; peer?: string } | null): void {
	testRule = rule ? { addresses: rule.addresses ?? null, loopback: rule.loopback ?? true, peer: rule.peer ?? null } : null;
	ownAddressesCache = null;
}

/** Whether a TCP peer is this machine: loopback or one of its own interface addresses. */
export function isThisMachinePeer(address: string | null | undefined): boolean {
	const a = normalizePeerAddress(address);
	if (!a) return false;
	if (isLoopbackAddress(a)) return testRule?.loopback ?? true;
	return ownInterfaceAddresses().has(a);
}

export interface NetworkKeyRequest {
	method: string;
	/**
	 * The request's path, exactly as the server's router reads it (already
	 * parsed: never parsed again here, so a target like `//x/api/…` cannot be
	 * read one way here and another way by the router).
	 */
	pathname: string;
	/** The request's query string (`?x=1`, or empty). */
	search: string;
	/** The TCP peer address, when known. */
	peer: string | null | undefined;
	cookie: string | null | undefined;
	secFetchDest?: string | null;
	accept?: string | null;
	/** A WebSocket upgrade. */
	upgrade?: boolean;
}

export type NetworkKeyVerdict =
	| { kind: "pass" }
	/** The key came in the URL of a page load: set the cookie and go to `location` (the same address without the key). */
	| { kind: "keep"; location: string; setCookie: string }
	/** No key: `page` for a page load (HTML), else JSON (or plain text for an upgrade). */
	| { kind: "refuse"; page: boolean };

/** Whether a request may be answered, for a session whose guard is on. Never throws: anything unexpected is refused. */
export function networkKeyVerdict(req: NetworkKeyRequest, key: string): NetworkKeyVerdict {
	try {
		return verdictOf(req, key);
	} catch {
		return { kind: "refuse", page: false };
	}
}

function verdictOf(req: NetworkKeyRequest, key: string): NetworkKeyVerdict {
	if (isThisMachinePeer(testRule?.peer ?? req.peer)) return { kind: "pass" };
	if (req.pathname.startsWith(CAPABILITY_PATH_PREFIX)) return { kind: "pass" };
	if (matchesNetworkKey(readCookie(req.cookie, networkKeyCookieName(key)), key)) return { kind: "pass" };
	const page = isPageLoad(req);
	const params = new URLSearchParams(req.search);
	if (params.getAll(NETWORK_KEY_PARAM).some((value) => matchesNetworkKey(value, key))) {
		if (!page) return { kind: "pass" };
		params.delete(NETWORK_KEY_PARAM);
		const query = params.toString();
		return { kind: "keep", location: `${sameOriginPath(req.pathname)}${query ? `?${query}` : ""}`, setCookie: networkKeySetCookie(key) };
	}
	return { kind: "refuse", page };
}

/**
 * A path that stays on this origin as a `Location`: exactly one leading `/`
 * (a path like `//evil.example/` or `/\evil.example/` would send the browser
 * to another host).
 */
function sameOriginPath(pathname: string): string {
	return `/${pathname.replace(/^[/\\]+/, "")}`;
}

function isPageLoad(req: NetworkKeyRequest): boolean {
	if (req.upgrade) return false;
	const method = req.method.toUpperCase();
	if (method !== "GET" && method !== "HEAD") return false;
	const dest = (req.secFetchDest ?? "").toLowerCase();
	if (dest) return dest === "document" || dest === "iframe" || dest === "frame";
	return (req.accept ?? "").toLowerCase().includes("text/html");
}

/** The page a browser without the key gets (no session data in it). */
export const NETWORK_KEY_REFUSAL_HTML = [
	"<!doctype html>",
	'<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
	"<title>Plannotator</title>",
	"<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#222}h1{font-size:1.15rem;margin:0 0 .75rem}p{margin:.25rem 0;color:#555}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}}</style>",
	"</head><body>",
	"<h1>This review needs its link</h1>",
	"<p>On that machine, run: <code>plannotator sessions</code></p>",
	"<p>Then open its “From another computer” link</p>",
	"<p>Or open it through a forwarded port</p>",
	"</body></html>",
	"",
].join("\n");

/** The JSON body of a refused API call. */
export function networkKeyRefusalBody(): { ok: false; code: string; error: string } {
	return {
		ok: false,
		code: NETWORK_KEY_REQUIRED_CODE,
		error: "This review needs its link. On that machine, run: plannotator sessions",
	};
}

/** `url` with the key in its query. */
export function withNetworkKey(url: string, key: string): string {
	try {
		const next = new URL(url);
		next.searchParams.set(NETWORK_KEY_PARAM, key);
		return next.href;
	} catch {
		return url;
	}
}

/** `url` without the key, for anything written where others may read it. */
export function withoutNetworkKey(url: string): string {
	try {
		const next = new URL(url);
		if (!next.searchParams.has(NETWORK_KEY_PARAM)) return url;
		next.searchParams.delete(NETWORK_KEY_PARAM);
		return next.href;
	} catch {
		return url;
	}
}

/**
 * The address this SSH connection reached the machine at (`SSH_CONNECTION`'s
 * third field), when it is sane: an IP literal, not loopback, not
 * unspecified, not link-local IPv6 (needs a zone), and still one of this
 * machine's addresses (a tmux session can outlive the connection that
 * started it). Null otherwise: then no extra link is printed.
 */
export function sshServerAddress(sshConnection: string | undefined): string | null {
	const fields = (sshConnection ?? "").trim().split(/\s+/);
	if (fields.length < 4) return null;
	const address = normalizePeerAddress(fields[2]);
	const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
	if (ipv4) {
		if (ipv4.slice(1).some((part) => Number(part) > 255)) return null;
	} else if (!/^[0-9a-f:]+$/.test(address) || !address.includes(":")) {
		return null;
	}
	if (isLoopbackAddress(address) || address === "0.0.0.0" || address === "::") return null;
	if (/^fe[89ab]/.test(address)) return null;
	if (!ownInterfaceAddresses().has(address)) return null;
	return address;
}

/** Where a browser on another computer opens this port (no key), or null when the address is not known. */
export function anotherComputerBaseUrl(port: number, sshConnection: string | undefined): string | null {
	const address = sshServerAddress(sshConnection);
	if (!address) return null;
	const host = address.includes(":") ? `[${address}]` : address;
	return `http://${host}:${port}/`;
}

/** The ready-made link for a browser on another computer, or null when the address is not known. */
export function anotherComputerUrl(port: number, sshConnection: string | undefined, key: string): string | null {
	const base = anotherComputerBaseUrl(port, sshConnection);
	return base ? withNetworkKey(base, key) : null;
}
