/**
 * #2372 on real Windows, the Pi server's mirror of
 * packages/server/agent-jobs-windows-cmd-shim.test.ts: a Pi installed as
 * `pi.cmd` starts through the real POST /api/agents/jobs spawn path (Node's
 * child_process, where the bare name failed with `spawn pi ENOENT`). A stub
 * `pi.cmd` (tests/helpers/fake-pi-cmd.ts, never a real agent CLI) records
 * what it got: the prompt arrives intact on stdin, every argument stays
 * inside its quotes, and Stop ends the whole tree, not only cmd.exe.
 *
 * Windows only (skipped elsewhere); it runs in the Windows workflow's
 * `pi-extension-ai-runtime-windows` job.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_BROWSER } from "../../../tests/helpers/no-browser.ts";
import { fakePiCmdPath, HOSTILE_MODEL, HOSTILE_PROMPT, writeFakePiCmd, type FakePiCmd } from "../../../tests/helpers/fake-pi-cmd.ts";
import { buildMarkerCommand, MARKER_ENGINES } from "../generated/marker-review.ts";
import { createAgentJobHandler } from "./agent-jobs.ts";
import { requestUrl } from "./helpers.ts";

const SANDBOX_KEYS = ["PATH", "HOME", "USERPROFILE", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_CONNECT", "NO_BROWSER"];

let root = "";
let stub: FakePiCmd;
let saved: { [key: string]: string | undefined } = {};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "plannotator-pi-job-cmd-shim-"));
	for (const dir of ["home", "data", "cwd"]) mkdirSync(join(root, dir));
	stub = writeFakePiCmd(root);
	saved = Object.fromEntries(SANDBOX_KEYS.map((key) => [key, process.env[key]]));
	process.env.PATH = fakePiCmdPath(stub);
	process.env.HOME = join(root, "home");
	process.env.USERPROFILE = join(root, "home");
	process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
	process.env.PLANNOTATOR_INBOX_CONNECT = "0";
	process.env.NO_BROWSER = NO_BROWSER;
});

afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

async function until<T>(read: () => T | undefined, what: string, ms = 20_000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${what}`);
}

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function piServer(prompt: string) {
	const command = buildMarkerCommand(MARKER_ENGINES.pi, prompt, HOSTILE_MODEL, join(root, "cwd"), { thinking: "high" }).command;
	const handler = createAgentJobHandler({
		mode: "review",
		getServerUrl: () => "http://localhost:1234",
		getCwd: () => join(root, "cwd"),
		buildCommand: async () => ({ command, cwd: join(root, "cwd"), captureStdout: true, prompt }),
	});
	const server: Server = createServer(async (req, res) => {
		if (!(await handler.handle(req, res, requestUrl(req)))) {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const base = `http://127.0.0.1:${address.port}/api/agents/jobs`;
	return {
		command,
		async post() {
			const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "pi" }) });
			expect(res.status).toBe(201);
			return ((await res.json()) as { job: { id: string } }).job;
		},
		stop: (id: string) => fetch(`${base}/${id}`, { method: "DELETE" }),
		async close() {
			handler.killAll();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

const readRecord = () =>
	existsSync(stub.record) ? (JSON.parse(readFileSync(stub.record, "utf8")) as { argv: string[]; stdin: string }) : undefined;

describe.skipIf(process.platform !== "win32")("Pi server: a Pi installed as pi.cmd (#2372)", () => {
	test("the prompt arrives intact on stdin and no argument breaks out of its quotes", async () => {
		const pi = await piServer(HOSTILE_PROMPT);
		try {
			await pi.post();
			const record = await until(readRecord, "the stub's record");
			expect(record.stdin).toBe(HOSTILE_PROMPT);
			// The same Pi call, prompt moved off the command line.
			expect(record.argv).toEqual(pi.command.slice(1, -1));
			expect(record.argv).toContain(HOSTILE_MODEL);
			expect(existsSync(join(root, "cwd", "broke"))).toBe(false);
		} finally {
			await pi.close();
		}
	}, 40_000);

	test("Stop ends the whole tree, not only cmd.exe", async () => {
		const pi = await piServer(`${HOSTILE_PROMPT}\nHANG`);
		try {
			const job = await pi.post();
			const pid = Number(await until(() => (existsSync(stub.pidFile) ? readFileSync(stub.pidFile, "utf8") : undefined), "the stub's pid"));
			expect(isAlive(pid)).toBe(true);
			expect((await pi.stop(job.id)).status).toBe(200);
			await until(() => (isAlive(pid) ? undefined : true), "the stub to end", 10_000);
		} finally {
			await pi.close();
		}
	}, 40_000);
});
