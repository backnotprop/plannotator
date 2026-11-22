/**
 * The Pi network key guard's WebSocket half: node:http hands an upgrade to
 * every `upgrade` listener (the annotate agent terminal attaches one), so the
 * guard intercepts the event. Over SSH, an upgrade from another computer
 * without the key must never reach the listener; one with the cookie, or from
 * this machine, does. (Bun's node:http emulation, which runs this suite,
 * relays no bytes written to an upgrade socket, so what is checked is who
 * reached the listener, as in request-host-guard.test.ts.)
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNetworkKey, networkKeyCookieName, resetNetworkKeysForTests, setThisMachineForTests } from "../generated/network-key.ts";
import { createNetworkKeyGuard } from "./network-key-guard.ts";

const KEYS = ["PLANNOTATOR_REMOTE", "PLANNOTATOR_DATA_DIR", "SSH_CONNECTION", "SSH_TTY"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let server: Server | undefined;

afterEach(async () => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	setThisMachineForTests(null);
	resetNetworkKeysForTests();
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = undefined;
});

function upgrade(port: number, headers: Record<string, string> = {}): Promise<void> {
	return new Promise((resolve) => {
		const req = request({ host: "127.0.0.1", port, path: "/ws", headers: { connection: "Upgrade", upgrade: "websocket", ...headers } });
		req.on("response", (res) => {
			res.resume();
			resolve();
		});
		req.on("upgrade", (_res, socket) => {
			socket.destroy();
			resolve();
		});
		req.on("error", () => resolve());
		req.setTimeout(1500, () => {
			req.destroy();
			resolve();
		});
		req.end();
	});
}

test("over SSH, an upgrade from another computer needs the key; this machine's does not", async () => {
	delete process.env.PLANNOTATOR_REMOTE;
	delete process.env.SSH_TTY;
	process.env.SSH_CONNECTION = "10.0.0.2 51000 10.0.0.1 22";
	const dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-network-key-"));
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	const guard = createNetworkKeyGuard();
	const reached: string[] = [];
	server = createServer((req, res) => {
		if (guard.refuse(req, res)) return;
		res.end("ok");
	});
	guard.attach(server);
	server.on("upgrade", (req, socket) => {
		reached.push(String(req.headers["x-case"]));
		socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const key = loadNetworkKey(dataDir);

	await upgrade(port, { "x-case": "this-machine" });
	setThisMachineForTests({ addresses: [], loopback: false });
	await upgrade(port, { "x-case": "no-key" });
	await upgrade(port, { "x-case": "wrong", cookie: `${networkKeyCookieName(key)}=${"A".repeat(43)}` });
	await upgrade(port, { "x-case": "cookie", cookie: `${networkKeyCookieName(key)}=${key}` });
	expect(reached).toEqual(["this-machine", "cookie"]);
});

test("PLANNOTATOR_REMOTE=1 leaves upgrades alone", async () => {
	process.env.PLANNOTATOR_REMOTE = "1";
	process.env.SSH_CONNECTION = "10.0.0.2 51000 10.0.0.1 22";
	process.env.PLANNOTATOR_DATA_DIR = mkdtempSync(join(tmpdir(), "plannotator-pi-network-key-"));
	const guard = createNetworkKeyGuard();
	const reached: string[] = [];
	server = createServer((req, res) => {
		if (guard.refuse(req, res)) return;
		res.end("ok");
	});
	guard.attach(server);
	server.on("upgrade", (req, socket) => {
		reached.push("reached");
		socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	setThisMachineForTests({ addresses: [], loopback: false });
	await upgrade((server.address() as AddressInfo).port);
	expect(reached).toEqual(["reached"]);
});
