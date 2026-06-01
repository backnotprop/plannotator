import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { createPiAIRuntime } from "../apps/pi-extension/server/ai-runtime.ts";

function writeText(path: string, content: string): void {
	writeFileSync(path, content.replace(/\n/g, "\r\n"), "utf-8");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTempDirWithRetry(path: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			await sleep(250);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main(): Promise<void> {
	if (process.platform !== "win32") {
		console.log("Skipping Pi extension AI runtime smoke: Windows-only.");
		return;
	}

	const tempDir = mkdtempSync(join(tmpdir(), "plannotator-pi-ai-smoke-"));
	const fakeBin = join(tempDir, "bin");
	const pathEnvKey =
		Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
		"PATH";
	const originalPath = process.env[pathEnvKey] ?? "";

	try {
		mkdirSync(fakeBin, { recursive: true });
		writeText(
			join(fakeBin, "where.cmd"),
			`@echo off
if /I "%~1"=="pi" (
  echo %~dp0pi
  echo %~dp0pi.cmd
  exit /b 0
)
exit /b 1
`,
		);
		writeText(
			join(fakeBin, "pi"),
			`extensionless npm shim placeholder
`,
		);
		writeText(
			join(fakeBin, "pi.cmd"),
			`@echo off
node "%~dp0pi-rpc.cjs" %*
`,
		);
		writeFileSync(
			join(fakeBin, "pi-rpc.cjs"),
			`
const fs = require("node:fs");
const readline = require("node:readline");
const marker = require("node:path").join(__dirname, "spawned.txt");
const lock = fs.openSync(require("node:path").join(__dirname, "child.lock"), "w");

fs.writeFileSync(marker, process.argv.slice(2).join(" "), "utf8");
fs.writeSync(lock, String(process.pid));

if (process.argv[2] !== "--mode" || process.argv[3] !== "rpc") {
  console.error("unexpected args:", process.argv.slice(2).join(" "));
  process.exit(2);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "get_available_models") {
    process.stdout.write(JSON.stringify({
      type: "response",
      id: message.id,
      success: true,
      data: {
        models: [
          { provider: "fake", id: "windows-smoke", name: "Windows smoke" }
        ]
      }
    }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    type: "response",
    id: message.id,
    success: true,
    data: {}
  }) + "\\n");
});

setInterval(() => {}, 1000);
`,
			"utf-8",
		);

		process.env[pathEnvKey] = `${fakeBin}${delimiter}${originalPath}`;

		const runtime = await createPiAIRuntime({
			cwd: tempDir,
			getCwd: () => tempDir,
		});
		if (!runtime) throw new Error("createPiAIRuntime returned null");

		try {
			const response = await runtime.endpoints["/api/ai/capabilities"](
				new Request("http://localhost/api/ai/capabilities"),
			);
			if (!response.ok) {
				throw new Error(`/api/ai/capabilities returned ${response.status}`);
			}

			const body = (await response.json()) as {
				providers?: Array<{
					id: string;
					name: string;
					models?: Array<{ id: string; label: string }>;
				}>;
			};
			const piProvider = body.providers?.find(
				(provider) => provider.name === "pi-sdk",
			);
			if (!piProvider) {
				throw new Error(`pi-sdk provider missing: ${JSON.stringify(body)}`);
			}
			if (
				!piProvider.models?.some(
					(model) => model.id === "fake/windows-smoke",
				)
			) {
				throw new Error(`fake Pi model missing: ${JSON.stringify(body)}`);
			}

			console.log("Pi extension AI runtime Windows shim smoke passed.");
		} finally {
			runtime.dispose();
		}
	} finally {
		process.env[pathEnvKey] = originalPath;
		await removeTempDirWithRetry(tempDir);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
