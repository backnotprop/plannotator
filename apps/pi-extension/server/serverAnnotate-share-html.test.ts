/**
 * Annotate server (Pi/Node): /api/share-html root-document freshness
 *
 * Node mirror of the Bun test in packages/server/annotate.test.ts: the client
 * re-fetches /api/share-html after a Refresh, so the root document must be
 * shared from its current bytes, with the startup snapshot only as the
 * fallback once the file is gone.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./serverAnnotate.ts";

const MINIMAL_HTML = "<html><body>editor</body></html>";

describe("pi annotate server: /api/share-html root document", () => {
	let savedPort: string | undefined;
	let savedRemote: string | undefined;

	beforeEach(() => {
		savedPort = process.env.PLANNOTATOR_PORT;
		savedRemote = process.env.PLANNOTATOR_REMOTE;
		delete process.env.PLANNOTATOR_PORT;
		process.env.PLANNOTATOR_REMOTE = "0";
	});

	afterEach(() => {
		if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
		else process.env.PLANNOTATOR_PORT = savedPort;
		if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
		else process.env.PLANNOTATOR_REMOTE = savedRemote;
	});

	test("shares the root document's current bytes after the file changes on disk", async () => {
		// realpath so the deleted-file fallback below is reachable: containment
		// realpaths the root but keeps a missing target's lexical path, which on a
		// symlinked tmpdir (macOS) would never match.
		const docDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pi-sharehtml-")));
		const pagePath = join(docDir, "page.html");
		const startupHtml = "<html><body>STARTUP_VERSION</body></html>";
		writeFileSync(pagePath, startupHtml, "utf-8");
		const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
		process.env.PLANNOTATOR_DATA_DIR = mkdtempSync(join(tmpdir(), "plannotator-pi-sharehtml-data-"));

		const server = await startAnnotateServer({
			markdown: "",
			filePath: pagePath,
			htmlContent: MINIMAL_HTML,
			rawHtml: startupHtml,
			renderHtml: true,
		});

		try {
			writeFileSync(pagePath, "<html><body>REFRESHED_VERSION</body></html>", "utf-8");
			const refreshed = (await (
				await fetch(`${server.url}/api/share-html?path=${encodeURIComponent(pagePath)}`)
			).json()) as { shareHtml: string };
			expect(refreshed.shareHtml).toContain("REFRESHED_VERSION");
			expect(refreshed.shareHtml).not.toContain("STARTUP_VERSION");

			unlinkSync(pagePath);
			const fallback = (await (await fetch(`${server.url}/api/share-html`)).json()) as { shareHtml: string };
			expect(fallback.shareHtml).toContain("STARTUP_VERSION");
		} finally {
			server.stop();
			if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
			else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
		}
	});
});
