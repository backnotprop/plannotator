import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warmFileListCache } from "@plannotator/shared/resolve-file";
import { startAnnotateServer } from "./annotate";
import { startPlannotatorServer } from "./index";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";

type StartedServer = {
	readonly url: string;
	stop(): void;
};

type ReadyCallback = (url: string, isRemote: boolean, port: number) => void;

function observeWarmState(projectRoot: string): Promise<"ready" | "warm"> {
	const warm = warmFileListCache(projectRoot, "code").then(() => "warm" as const);
	const ready = new Promise<"ready">((resolve) => {
		queueMicrotask(() => resolve("ready"));
	});
	return Promise.race([warm, ready]);
}

async function expectReadyBeforeWarm(
	start: (onReady: ReadyCallback) => Promise<StartedServer>,
): Promise<void> {
	const projectRoot = mkdtempSync(join(tmpdir(), "plannotator-startup-warm-"));
	const dataRoot = mkdtempSync(join(tmpdir(), "plannotator-startup-data-"));
	const previousCwd = process.cwd();
	const previousPort = process.env.PLANNOTATOR_PORT;
	const previousRemote = process.env.PLANNOTATOR_REMOTE;
	const previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
	const previousLimit = process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
	let server: StartedServer | null = null;
	let ordering: Promise<"ready" | "warm"> | null = null;

	try {
		writeFileSync(join(projectRoot, "document.md"), "# Test\n");
		writeFileSync(join(projectRoot, "source.ts"), "export {};\n");
		process.chdir(projectRoot);
		delete process.env.PLANNOTATOR_PORT;
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_DATA_DIR = dataRoot;
		process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = "1";

		server = await start(() => {
			// Observe with the server's OWN cache key: process.cwd() inside onReady
			// is the realpath (on macOS mkdtemp returns /var/... but cwd resolves to
			// /private/var/...), and a key mismatch would race a FRESH warm instead
			// of the server's, making the test pass on any code.
			ordering = observeWarmState(process.cwd());
		});

		const observedOrdering = ordering;
		if (!observedOrdering) {
			throw new Error("Server did not invoke its ready callback");
		}
		expect(await observedOrdering).toBe("ready");

		const response = await fetch(`${server.url}/api/plan`);
		expect(response.status).toBe(200);
	} finally {
		server?.stop();
		process.chdir(previousCwd);
		if (previousPort === undefined) delete process.env.PLANNOTATOR_PORT;
		else process.env.PLANNOTATOR_PORT = previousPort;
		if (previousRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
		else process.env.PLANNOTATOR_REMOTE = previousRemote;
		if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
		else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
		if (previousLimit === undefined) {
			delete process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
		} else {
			process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = previousLimit;
		}
		rmSync(projectRoot, { recursive: true, force: true });
		rmSync(dataRoot, { recursive: true, force: true });
	}
}

describe("startup file-cache warm", () => {
	test("Bun plan server binds before its cache warm can settle", async () => {
		await expectReadyBeforeWarm((onReady) =>
			startPlannotatorServer({
				plan: "# Test plan",
				origin: "codex",
				htmlContent: MINIMAL_HTML,
				onReady,
			}),
		);
	});

	test("Bun annotate server binds before its cache warm can settle", async () => {
		await expectReadyBeforeWarm((onReady) =>
			startAnnotateServer({
				markdown: "# Test document",
				filePath: join(process.cwd(), "document.md"),
				htmlContent: MINIMAL_HTML,
				onReady,
			}),
		);
	});
});
