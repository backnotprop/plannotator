import { afterEach, expect, test } from "bun:test";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequestHostGuard } from "./request-host-guard.ts";

const saved = { remote: process.env.PLANNOTATOR_REMOTE, allowed: process.env.PLANNOTATOR_ALLOWED_HOSTS };
let server: Server | undefined;

afterEach(async () => {
	if (saved.remote === undefined) delete process.env.PLANNOTATOR_REMOTE;
	else process.env.PLANNOTATOR_REMOTE = saved.remote;
	if (saved.allowed === undefined) delete process.env.PLANNOTATOR_ALLOWED_HOSTS;
	else process.env.PLANNOTATOR_ALLOWED_HOSTS = saved.allowed;
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = undefined;
});

function upgrade(port: number, host: string): Promise<number | "upgraded" | "closed"> {
	return new Promise((resolve) => {
		const req = request({
			host: "127.0.0.1",
			port,
			path: "/ws",
			headers: { host, connection: "Upgrade", upgrade: "websocket" },
		});
		req.on("response", (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("upgrade", (_res, socket) => {
			socket.destroy();
			resolve("upgraded");
		});
		req.on("error", () => resolve("closed"));
		req.end();
	});
}

test("a refused Host never reaches an upgrade listener; an allowed one does", async () => {
	process.env.PLANNOTATOR_REMOTE = "0";
	delete process.env.PLANNOTATOR_ALLOWED_HOSTS;
	const guard = createRequestHostGuard();
	const reached: string[] = [];
	server = createServer((req, res) => {
		if (guard.refuse(req, res)) return;
		res.end("ok");
	});
	guard.attach(server);
	server.on("upgrade", (req, socket) => {
		reached.push(String(req.headers.host));
		socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;

	expect([403, "closed"]).toContain(await upgrade(port, `evil.example:${port}`));
	expect(reached).toEqual([]);
	expect(["upgraded", "closed"]).toContain(await upgrade(port, `localhost:${port}`));
	expect(reached).toEqual([`localhost:${port}`]);
});
