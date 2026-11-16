/**
 * The Pi review server's guide routes take an id from the path. A malformed
 * escape in it (`/api/guide/%`) once threw a URIError inside the node:http
 * handler, which has no top-level catch: an unhandled rejection that can end
 * the Pi process. Each route answers a JSON 400 now and nothing escapes; a
 * well-formed id still reaches the route. Bun mirror:
 * packages/server/guide-malformed-path.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_BROWSER } from "../../../tests/helpers/no-browser.ts";
import { startReviewServer } from "./serverReview.ts";

const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_BROWSER"] as const;

async function sandboxed(run: () => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	const dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-guide-malformed-path-"));
	try {
		process.env.PLANNOTATOR_DATA_DIR = dataDir;
		process.env.PLANNOTATOR_AI = "disabled";
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
		delete process.env.PLANNOTATOR_PORT;
		await run();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key]!;
		}
		rmSync(dataDir, { recursive: true, force: true });
	}
}

/** Collect anything the host would see as a fatal process error while `run` executes. */
async function trapFatal(run: () => Promise<void>): Promise<unknown[]> {
	const fatal: unknown[] = [];
	const onFatal = (err: unknown) => fatal.push(err);
	process.on("uncaughtException", onFatal);
	process.on("unhandledRejection", onFatal);
	try {
		await run();
		await new Promise((resolve) => setTimeout(resolve, 50));
	} finally {
		process.off("uncaughtException", onFatal);
		process.off("unhandledRejection", onFatal);
	}
	return fatal;
}

/** Every route that decodes an id from the path, each with a malformed escape. */
const MALFORMED: Array<[method: string, path: string]> = [
	["GET", "/api/guide/%"],
	["PUT", "/api/guide/%E0%A4%A/reviewed"],
	["GET", "/api/guide/%/export"],
	["GET", "/api/guide/%/export-info"],
	["GET", "/api/guide/%/share-info"],
	["POST", "/api/guide/%/share"],
	["DELETE", "/api/guide/%/share"],
	["DELETE", "/api/guides/%"],
];

describe("Pi review: a malformed escape in a guide route's id", () => {
	test("answers 400 with a JSON error on every guide route and never escapes the handler", () =>
		sandboxed(async () => {
			const server = await startReviewServer({ rawPatch: "", gitRef: "HEAD", origin: "pi", htmlContent: "<html></html>" });
			try {
				const fatal = await trapFatal(async () => {
					for (const [method, path] of MALFORMED) {
						const res = await fetch(`${server.url}${path}`, { method, headers: { "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
						expect({ method, path, status: res.status }).toEqual({ method, path, status: 400 });
						expect(await res.json()).toEqual({ error: "malformed URL encoding" });
					}
					const valid = await fetch(`${server.url}/api/guide/no%20such%20job`);
					expect(valid.status).toBe(404);
					expect(await valid.json()).toEqual({ error: "Guide not found" });
				});
				expect(fatal).toEqual([]);
			} finally {
				server.stop();
			}
		}));
});
