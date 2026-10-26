/**
 * Pi (Node) mirror of packages/server/agent-jobs-cursor.test.ts: Cursor agent
 * jobs never start another program named `agent` (Grok Build's, for one).
 * PATH holds only a scratch folder of fake programs plus /usr/bin:/bin; the
 * real Cursor and Grok CLIs are never run.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSameProgramAnswers } from "../generated/agent-program.ts";
import { buildMarkerCommand, MARKER_ENGINES } from "../generated/marker-review.ts";
import { createAgentJobHandler } from "./agent-jobs.ts";
import { requestUrl } from "./helpers.ts";

const posix = process.platform !== "win32";
const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pi-cursor-jobs-")));
const log = join(root, "ran.log");
let bin = "";
let realPath: string | undefined;

function fake(name: string, version: string): void {
	const path = join(bin, name);
	writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> '${log}'\nif [ "$1" = "--version" ]; then echo "${version}"; fi\nexit 0\n`);
	chmodSync(path, 0o755);
}

const ran = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

async function serve(onDone?: () => void): Promise<{ server: Server; base: string; handler: ReturnType<typeof createAgentJobHandler> }> {
	const handler = createAgentJobHandler({
		mode: "review",
		getServerUrl: () => "http://localhost:1234",
		getCwd: () => root,
		async buildCommand() {
			const { command } = buildMarkerCommand(MARKER_ENGINES.cursor, "review this", undefined, root);
			return { command, prompt: "review this", cwd: root, captureStdout: true };
		},
		async onJobComplete() {
			onDone?.();
		},
	});
	const server = createServer(async (req, res) => {
		if (!(await handler.handle(req, res, requestUrl(req)))) {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return { server, base: `http://127.0.0.1:${address.port}`, handler };
}

async function cursorAvailable(base: string): Promise<boolean> {
	const body = (await (await fetch(`${base}/api/agents/capabilities`)).json()) as { providers: { id: string; available: boolean }[] };
	return body.providers.find((p) => p.id === "cursor")!.available;
}

const launch = (base: string) =>
	fetch(`${base}/api/agents/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "cursor" }) });

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

beforeEach(() => {
	forgetSameProgramAnswers();
	rmSync(log, { force: true });
	bin = mkdtempSync(join(root, "bin-"));
	realPath = process.env.PATH;
	process.env.PATH = `${bin}:/usr/bin:/bin`;
});
afterEach(() => {
	process.env.PATH = realPath;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.if(posix)("pi: Cursor agent jobs and another program named agent", () => {
	test("Grok Build's `agent` alone: Cursor is not available and nothing is started", async () => {
		fake("agent", "grok 1.0.70 (f50904eaee6c) [stable]");
		const { server, base } = await serve();
		try {
			expect(await cursorAvailable(base)).toBe(false);
			expect((await launch(base)).status).toBe(400);
			expect(ran()).toEqual(["agent --version"]);
		} finally {
			await close(server);
		}
	});

	test("Cursor's `agent` alone: available, and the job starts it", async () => {
		fake("agent", "2026.07.08-0c04a8a");
		let done: () => void = () => {};
		const finished = new Promise<void>((resolve) => (done = resolve));
		const { server, base, handler } = await serve(done);
		try {
			expect(await cursorAvailable(base)).toBe(true);
			expect((await launch(base)).status).toBe(201);
			await finished;
			expect(ran().find((line) => line.includes(" -p "))).toStartWith("agent -p --mode ask");
			handler.killAll();
		} finally {
			await close(server);
		}
	});

	test("`cursor-agent` wins, and another `agent` is never asked", async () => {
		fake("cursor-agent", "2026.07.08-0c04a8a");
		fake("agent", "grok 1.0.70 (f50904eaee6c) [stable]");
		let done: () => void = () => {};
		const finished = new Promise<void>((resolve) => (done = resolve));
		const { server, base, handler } = await serve(done);
		try {
			expect(await cursorAvailable(base)).toBe(true);
			expect((await launch(base)).status).toBe(201);
			await finished;
			expect(ran().some((line) => line.startsWith("agent "))).toBe(false);
			expect(ran().find((line) => line.includes(" -p "))).toStartWith("cursor-agent -p --mode ask");
			handler.killAll();
		} finally {
			await close(server);
		}
	});
});
