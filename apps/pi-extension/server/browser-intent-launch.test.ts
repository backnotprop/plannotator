import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL = "http://localhost:4321";
const posix = process.platform !== "win32";

let root: string;
let bin: string;
let log: string;
let dataDir: string;
let childScript: string;
let recordingBrowser: string;

function stub(name: string): string {
	const path = join(bin, name);
	writeFileSync(path, `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${log}'\n`, { mode: 0o755 });
	return path;
}

function launches(): string {
	return existsSync(log) ? readFileSync(log, "utf8") : "";
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "plannotator-pi-browser-intent-"));
	bin = join(root, "bin");
	dataDir = join(root, "data");
	log = join(root, "launches.log");
	mkdirSync(bin);
	mkdirSync(dataDir);
	for (const name of ["open", "xdg-open", "glimpseui"]) stub(name);
	recordingBrowser = stub("recording-browser");

	childScript = join(root, "child.ts");
	writeFileSync(
		childScript,
		`const { openBrowser } = await import(${JSON.stringify(join(import.meta.dir, "network.ts"))});
process.stdout.write(JSON.stringify(await openBrowser(process.argv[2])));
`,
	);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

async function run(
	remote: boolean,
	browserEnv: Record<string, string>,
): Promise<{ result: Record<string, unknown>; stderr: string }> {
	rmSync(log, { force: true });
	const child = Bun.spawn([process.execPath, childScript, URL], {
		cwd: root,
		env: {
			PATH: bin,
			HOME: root,
			TMPDIR: root,
			PLANNOTATOR_DATA_DIR: dataDir,
			PLANNOTATOR_REMOTE: remote ? "1" : "0",
			...browserEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { result: JSON.parse(stdout), stderr };
}

async function settledLaunches(wanted?: string): Promise<string> {
	const deadline = Date.now() + (wanted ? 3000 : 400);
	while (Date.now() < deadline) {
		if (wanted && launches().includes(wanted)) break;
		await Bun.sleep(25);
	}
	return launches();
}

describe.if(posix)("PLANNOTATOR_BROWSER=none on the Pi runtime", () => { // no-browser-guard: sentinel under test (expected text, nothing is set)
	for (const remote of [false, true]) {
		test(`a ${remote ? "remote" : "local"} session launches nothing and says why`, async () => {
			const { result } = await run(remote, {
				PLANNOTATOR_BROWSER: "none", // no-browser-guard: sentinel under test (PATH holds only stand-ins)
				BROWSER: recordingBrowser,
			});
			expect(result).toEqual({
				opened: false,
				notOpening: "Not opening a browser (PLANNOTATOR_BROWSER=none).", // no-browser-guard: sentinel under test (expected text, nothing is set)
				url: URL,
			});
			expect(await settledLaunches()).toBe("");
		}, 30_000);
	}

	test("BROWSER=true still launches the default opener locally", async () => {
		const opener = process.platform === "darwin" ? "open" : "xdg-open";
		const { result } = await run(false, { BROWSER: "true" });
		expect(result).toEqual({ opened: true });
		expect(await settledLaunches(`${opener} ${URL}\n`)).toContain(`${opener} ${URL}\n`);
	}, 30_000);
});
