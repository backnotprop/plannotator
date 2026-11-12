import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunShapeRoutes } from "../../../packages/server/shape-routes.ts";
import { createShapeStore } from "../../../packages/shared/shape/store.ts";
import { createPiShapeRoutes } from "./serverShape.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const done of cleanups.splice(0)) done();
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "shape-pi-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function startPi(dataDir: string): Promise<string> {
	const routes = createPiShapeRoutes({ dataDir, watchMs: 20 });
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		void routes.handle(req, res, url).then((done) => {
			if (!done) {
				res.writeHead(404);
				res.end();
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => {
		server.closeAllConnections();
		server.close();
	});
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function startBun(dataDir: string): string {
	const routes = createBunShapeRoutes({ dataDir, watchMs: 20 });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: async (req) => (await routes.route(req, new URL(req.url))) ?? new Response("", { status: 404 }) });
	cleanups.push(() => server.stop(true));
	return `http://127.0.0.1:${server.port}`;
}

function seed(dataDir: string) {
	const store = createShapeStore({ dataDir });
	const source = scratch();
	writeFileSync(join(source, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	const made = store.update({
		board: {
			title: "The kettle whistles once",
			claim: "Built.",
			views: { picture: { html: '<p data-mark="p-a">once</p>' } },
			refs: [{ n: 1, kind: "image", title: "Shot", target: "shot.png" }],
		},
		project: { name: "kettle", root: source },
		sourceDir: source,
	});
	if (!made.ok) throw new Error(JSON.stringify(made));
	return { store, id: made.id, file: store.read(made.id)!.refs![0]!.target.replace(/^files\//, "") };
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
	const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
	const type = res.headers.get("content-type") ?? "";
	const text = type.includes("json") ? JSON.stringify(await res.json()).replace(/(shp_|shn_)[0-9A-HJKMNP-TV-Z]{26}/g, "$1ID").replace(/"root":"[^"]*"/g, '"root":"R"').replace(/"\d{4}-\d\d-\d\dT[^"]+"/g, '"AT"') : `${type}:${(await res.arrayBuffer()).byteLength}:${res.headers.get("content-security-policy")}`;
	return `${res.status} ${text}`;
}

test("Pi answers every Shape route as Bun does", async () => {
	const answers: string[][] = [];
	for (const start of [startPi, async (d: string) => startBun(d)]) {
		const dataDir = scratch();
		const { id, file } = seed(dataDir);
		const base = await start(dataDir);
		const out: string[] = [];
		out.push(await call(base, "GET", "/api/shapes"));
		out.push(await call(base, "GET", `/api/shapes/${id}`));
		out.push(await call(base, "GET", `/api/shapes/${id}/versions`));
		out.push(await call(base, "GET", `/api/shapes/${id}?n=7`));
		out.push(await call(base, "POST", `/api/shapes/${id}/notes`, { kind: "change", v: 1, view: "picture", part: "p-a", text: "Twice" }));
		out.push(await call(base, "POST", `/api/shapes/${id}/notes`, { kind: "nope" }));
		out.push(await call(base, "POST", `/api/shapes/${id}/seen`, { n: 1 }));
		out.push(await call(base, "POST", `/api/shapes/${id}/state`, { state: "finished" }));
		out.push(await call(base, "GET", `/api/shapes/${id}/files/${file}`));
		out.push(await call(base, "GET", `/api/shapes/${id}/files/..%2Fshape.json`));
		out.push(await call(base, "GET", `/api/shapes/${id}/code/file?path=../../etc/passwd`));
		out.push(await call(base, "GET", `/api/shapes/${id}/code/file?path=shot.png`));
		answers.push(out);
	}
	expect(answers[0]).toEqual(answers[1]!);
	const [pi] = answers;
	expect(pi![4]).toStartWith("200 ");
	expect(pi![5]).toStartWith("400 ");
	expect(pi![8]).toBe("200 image/png:8:sandbox");
	expect(pi![9]).toStartWith("404 ");
	expect(pi![10]).toStartWith("400 ");
});

test("Pi refuses another site's read and write", async () => {
	const dataDir = scratch();
	const { id } = seed(dataDir);
	const base = await startPi(dataDir);
	const other = { Origin: "https://evil.invalid", "Sec-Fetch-Site": "cross-site" };
	expect(await call(base, "GET", `/api/shapes/${id}`, undefined, other)).toStartWith("403 ");
	expect(await call(base, "POST", `/api/shapes/${id}/seen`, { n: 1 }, other)).toStartWith("403 ");
});

test("both feeds name the shape when an agent picks up its waiting change", async () => {
	for (const start of [startPi, async (d: string) => startBun(d)]) {
		const dataDir = scratch();
		const { store, id } = seed(dataDir);
		store.addNote(id, { kind: "change", v: 1, text: "Twice" });
		const base = await start(dataDir);
		const controller = new AbortController();
		const res = await fetch(`${base}/api/shapes/events`, { signal: controller.signal });
		const reader = res.body!.getReader();
		let text = "";
		const read = (async () => {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				text += new TextDecoder().decode(value);
				if (text.includes("event: shapes")) break;
			}
		})();
		await Bun.sleep(60);
		const agent = createShapeStore({ dataDir });
		agent.markDelivered(id, agent.waiting(id).map((n) => n.id));
		await Promise.race([read, Bun.sleep(1500)]);
		controller.abort();
		expect(text).toContain(`event: shapes\ndata: {"ids":["${id}"]}`);
	}
});

test("views.changed (kept, never shown) comes back from Pi as from Bun, as the agent wrote it, and an old note on it is still taken", async () => {
	const { KETTLE_CHANGED, kettleBoard } = await import("../../../tests/fixtures/shape-whats-changed.ts");
	const answers: string[][] = [];
	for (const start of [startPi, async (d: string) => startBun(d)]) {
		const dataDir = scratch();
		const store = createShapeStore({ dataDir });
		const made = store.update({ board: kettleBoard(), project: { name: "kettle", root: scratch() } });
		if (!made.ok) throw new Error(JSON.stringify(made));
		const base = await start(dataDir);
		const read = await fetch(`${base}/api/shapes/${made.id}`).then((r) => r.json() as Promise<{ version: { views: { changed?: unknown } } }>);
		expect(read.version.views.changed).toEqual(KETTLE_CHANGED);
		answers.push([
			await call(base, "GET", `/api/shapes/${made.id}`),
			await call(base, "POST", `/api/shapes/${made.id}/notes`, { kind: "change", v: 1, view: "changed", part: "whistle", quote: "One whistle", text: "Twice is fine" }),
		]);
	}
	expect(answers[0]).toEqual(answers[1]!);
	expect(answers[0]![1]).toStartWith('200 {"note":{');
	expect(answers[0]![1]).toContain('"view":"changed","part":"whistle"');
});

test("a board's scene comes back from Pi as from Bun, as the agent wrote it", async () => {
	const { sceneBoard } = await import("../../../tests/fixtures/shape-scene-board.ts");
	const answers: string[] = [];
	for (const start of [startPi, async (d: string) => startBun(d)]) {
		const dataDir = scratch();
		const made = createShapeStore({ dataDir }).update({ board: sceneBoard(), project: { name: "lamp", root: scratch() } });
		if (!made.ok) throw new Error(JSON.stringify(made));
		const base = await start(dataDir);
		const read = await fetch(`${base}/api/shapes/${made.id}`).then((r) => r.json() as Promise<{ version: { scenes?: Record<string, unknown> } }>);
		expect(read.version.scenes).toEqual(sceneBoard().scenes);
		answers.push(await call(base, "GET", `/api/shapes/${made.id}`));
	}
	expect(answers[0]).toEqual(answers[1]!);
});
