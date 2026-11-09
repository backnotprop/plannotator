/**
 * Annotate server (Pi/Node): AsciiDoc sources (.adoc/.asciidoc).
 *
 * Node mirror of packages/server/annotate.asciidoc.test.ts. Both runtimes must
 * name AsciiDoc in `renderAs` and serve the file's raw text, or the same .adoc
 * renders as AsciiDoc under Claude Code and as broken markdown under Pi.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { NO_BROWSER } from "../../../tests/helpers/no-browser.ts";

const MINIMAL_HTML = "<html><body>editor</body></html>";
const ADOC = "= Guide\n\n== Install\n\n* step one\n";

describe("pi annotate server: AsciiDoc sources", () => {
	const ENV_KEYS = ["PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_ANNOTATE_HISTORY", "PLANNOTATOR_BROWSER"] as const;
	let dir: string;
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pn-pi-adoc-"));
		saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		delete process.env.PLANNOTATOR_PORT;
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_DATA_DIR = join(dir, ".data");
		process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
		process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	test("/api/plan names AsciiDoc and keeps the raw text", async () => {
		const file = join(dir, "guide.adoc");
		writeFileSync(file, ADOC, "utf-8");
		const server = await startAnnotateServer({ markdown: ADOC, filePath: file, htmlContent: MINIMAL_HTML });
		try {
			const json = (await (await fetch(`${server.url}/api/plan`)).json()) as { plan: string; renderAs?: string };
			expect(json.renderAs).toBe("asciidoc");
			expect(json.plan).toBe(ADOC);
		} finally {
			server.stop();
		}
	});

	test("/api/doc serves an .adoc file in a folder with its kind and raw text", async () => {
		const file = join(dir, "guide.adoc");
		writeFileSync(file, ADOC, "utf-8");
		const server = await startAnnotateServer({
			markdown: "",
			filePath: dir,
			folderPath: dir,
			mode: "annotate-folder",
			htmlContent: MINIMAL_HTML,
		});
		try {
			const res = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(file)}`);
			const json = (await res.json()) as { renderAs?: string; markdown?: string };
			expect(res.status).toBe(200);
			expect(json.renderAs).toBe("asciidoc");
			expect(json.markdown).toBe(ADOC);
		} finally {
			server.stop();
		}
	});
});
