/**
 * Annotate's live app mode never proxies a Plannotator server (Pi side; the
 * Bun mirror is packages/server/live-proxy-plannotator.test.ts).
 *
 * Over the vendored modules the Pi extension runs: the Pi servers mark their
 * responses and refuse a request the live proxy forwarded; the probe refuses
 * a target by port (the data dir's registries) and by the Plannotator server
 * header, and `--app` says so; the node:http proxy refuses the editor's own
 * port and never lets a proxied same-origin write reach a scratch Inbox or a
 * Pi annotate server.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "../../../packages/server/inbox.ts";
import { buildForceAppFailureMessage, probeLiveAppTarget } from "../generated/live-probe.ts";
import { LIVE_PROXY_PLANNOTATOR_UPSTREAM_MESSAGE, type LiveAppProxy } from "../generated/live-proxy-core.ts";
import { startLiveAppProxyNode } from "../generated/live-proxy-node.ts";
import { listPlannotatorServerPorts } from "../generated/plannotator-ports.ts";
import {
	LIVE_PROXIED_REFUSED_CODE,
	PLANNOTATOR_LIVE_PROXY_HEADER,
	PLANNOTATOR_SERVER_HEADER,
} from "../generated/plannotator-server-marker.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

const MINIMAL_HTML = "<html><body>editor</body></html>";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AI", "PLANNOTATOR_INBOX_CONNECT"] as const;
const saved: Record<string, string | undefined> = {};
let root: string;
let dataDir: string;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
	root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pi-live-plannotator-")));
	dataDir = join(root, "data");
	mkdirSync(dataDir, { recursive: true });
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	process.env.PLANNOTATOR_REMOTE = "0";
	process.env.PLANNOTATOR_AI = "disabled";
	process.env.PLANNOTATOR_INBOX_CONNECT = "0";
	delete process.env.PLANNOTATOR_PORT;
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(root, { recursive: true, force: true });
});

async function scratchInbox(): Promise<InboxServer> {
	const server = await startInboxServer({ dataDir, binaryPath: null, phones: false });
	cleanups.push(() => server.stop());
	return server;
}

async function piAnnotate() {
	const server = await startAnnotateServer({ markdown: "# T", filePath: join(root, "t.md"), htmlContent: MINIMAL_HTML });
	cleanups.push(() => server.stop());
	return server;
}

async function proxyTo(targetUrl: string): Promise<LiveAppProxy> {
	const proxy = await startLiveAppProxyNode({
		targetUrl,
		editorOrigins: ["http://localhost:1", "http://127.0.0.1:1"],
		bridgeJs: "/* bridge */",
	});
	cleanups.push(() => proxy.stop());
	return proxy;
}

function proxiedPost(proxy: LiveAppProxy, path: string, body: unknown): Promise<Response> {
	return fetch(`http://127.0.0.1:${proxy.port}${path}`, {
		method: "POST",
		headers: {
			Host: `localhost:${proxy.port}`,
			Origin: `http://localhost:${proxy.port}`,
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

function readConfig(): string | null {
	try {
		return readFileSync(join(dataDir, "config.json"), "utf8");
	} catch {
		return null;
	}
}

describe("pi: annotate's live app mode never proxies a Plannotator server", () => {
	test("the Pi annotate server marks its responses and refuses a proxied request", async () => {
		const server = await piAnnotate();
		const page = await fetch(`${server.url}/`);
		expect(page.headers.get(PLANNOTATOR_SERVER_HEADER)).not.toBeNull();
		const proxied = await fetch(`${server.url}/api/plan`, { headers: { [PLANNOTATOR_LIVE_PROXY_HEADER]: "1" } });
		expect(proxied.status).toBe(403);
		expect(proxied.headers.get("x-plannotator-error")).toBe(LIVE_PROXIED_REFUSED_CODE);
	});

	test("the probe refuses by registry port before any request, and by the header", async () => {
		const inbox = await scratchInbox();
		const byPort = `http://localhost:${inbox.port}/`;
		let requests = 0;
		const counting = (async () => {
			requests += 1;
			return new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
		}) as unknown as typeof fetch;
		const portProbe = await probeLiveAppTarget(byPort, new URL(byPort), counting, {
			plannotatorPorts: listPlannotatorServerPorts(dataDir),
		});
		expect(portProbe).toMatchObject({ liveEligible: false, plannotator: true });
		expect(requests).toBe(0);

		// A Pi server is in no registry: its header decides.
		const pi = await piAnnotate();
		const headerProbe = await probeLiveAppTarget(`${pi.url}/`, new URL(`${pi.url}/`));
		expect(headerProbe).toMatchObject({ liveEligible: false, plannotator: true, probeError: null });
		expect(buildForceAppFailureMessage(`${pi.url}/`, headerProbe)).toContain("is a Plannotator server");
	});

	test("the node proxy refuses the editor's own port at start", async () => {
		await expect(
			startLiveAppProxyNode({
				targetUrl: "http://127.0.0.1:4100/",
				editorOrigins: ["http://localhost:4100", "http://127.0.0.1:4100"],
				bridgeJs: "",
			}),
		).rejects.toThrow(/never proxies a Plannotator server/);
	});

	test("a proxied same-origin write never reaches a scratch Inbox", async () => {
		const inbox = await scratchInbox();
		const before = readConfig();
		const proxy = await proxyTo(`http://127.0.0.1:${inbox.port}/`);
		const write = await proxiedPost(proxy, "/api/inbox/settings", { serverSession: inbox.serverSession, text_size: 12 });
		expect(write.status).toBe(502);
		expect(await write.text()).toBe(LIVE_PROXY_PLANNOTATOR_UPSTREAM_MESSAGE);
		expect(readConfig()).toBe(before);
	});

	test("a proxied same-origin write never reaches a Pi annotate server", async () => {
		const server = await piAnnotate();
		const proxy = await proxyTo(`${server.url}/`);
		const write = await proxiedPost(proxy, "/api/config", { agentTool: true });
		expect(write.status).toBe(502);
		expect(readConfig() ?? "").not.toContain("agentTool");
	});
});

/**
 * The node proxy in a REAL node process: under Bun's node:http shim, writes
 * to an 'upgrade' socket never reach the wire (see
 * packages/shared/live-proxy-node.child.ts), so WebSocket cases run there.
 */
async function nodeProxyTo(targetUrl: string): Promise<number> {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-live-ws-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const entrySource = join(dir, "child.ts");
	const modulePath = join(import.meta.dir, "..", "generated", "live-proxy-node.ts");
	writeFileSync(
		entrySource,
		`import { startLiveAppProxyNode } from ${JSON.stringify(modulePath)};\n`
			+ `const proxy = await startLiveAppProxyNode({ targetUrl: process.env.LIVE_PROXY_TARGET, editorOrigins: ["http://localhost:1"], bridgeJs: "" });\n`
			+ `process.stdout.write(JSON.stringify({ port: proxy.port }) + "\\n");\n`,
	);
	const build = await Bun.build({ entrypoints: [entrySource], target: "node", format: "esm" });
	if (!build.success) throw new Error(build.logs.map((log) => log.message).join("; "));
	const entry = join(dir, "child.mjs");
	writeFileSync(entry, await build.outputs[0]!.text());
	const child = Bun.spawn(["node", entry], {
		env: { ...process.env, LIVE_PROXY_TARGET: targetUrl },
		stdout: "pipe",
		stderr: "inherit",
	});
	cleanups.push(() => {
		child.kill();
	});
	const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	let banner = "";
	while (!banner.includes("\n")) {
		const { done, value } = await reader.read();
		if (done) break;
		banner += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	return (JSON.parse(banner.split("\n")[0]!) as { port: number }).port;
}

/** A raw WebSocket handshake to `port`; resolves with the response head. */
function rawUpgrade(port: number, extra: Record<string, string> = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1", () => {
			const lines = [
				"GET / HTTP/1.1",
				`Host: localhost:${port}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
				"Sec-WebSocket-Version: 13",
				...Object.entries(extra).map(([name, value]) => `${name}: ${value}`),
			];
			socket.write(`${lines.join("\r\n")}\r\n\r\n`);
		});
		let head = "";
		socket.on("data", (chunk) => {
			head += chunk.toString("latin1");
			if (head.includes("\r\n\r\n")) {
				socket.destroy();
				resolve(head);
			}
		});
		socket.on("error", reject);
		socket.on("close", () => resolve(head));
	});
}

describe("pi: WebSocket upgrades through the node live proxy", () => {
	test("the upstream handshake carries the tag exactly once, a client's copy dropped", async () => {
		let received = "";
		const upstream = createNetServer((socket) => {
			socket.on("data", (chunk) => {
				received += chunk.toString("latin1");
				if (received.includes("\r\n\r\n")) socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
			});
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => {
			upstream.close();
		});
		const port = (upstream.address() as { port: number }).port;
		const proxyPort = await nodeProxyTo(`http://127.0.0.1:${port}/`);
		await rawUpgrade(proxyPort, { [PLANNOTATOR_LIVE_PROXY_HEADER]: "forged" });
		const tags = received.split("\r\n").filter((line) => line.toLowerCase().startsWith(`${PLANNOTATOR_LIVE_PROXY_HEADER}:`));
		expect(tags).toEqual([`${PLANNOTATOR_LIVE_PROXY_HEADER}: 1`]);
	});

	test("an upgrade through the proxy to an Inbox is refused", async () => {
		const inbox = await scratchInbox();
		const proxyPort = await nodeProxyTo(`http://127.0.0.1:${inbox.port}/`);
		const head = await rawUpgrade(proxyPort);
		expect(head).toStartWith("HTTP/1.1 403");
		expect(head.toLowerCase()).toContain(`x-plannotator-error: ${LIVE_PROXIED_REFUSED_CODE}`);
	});
});
