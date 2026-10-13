/**
 * Annotate server (Pi/Node): diagram sources (.mmd/.mermaid/.dot/.gv)
 *
 * Node mirror of packages/server/annotate.diagram.test.ts. Both runtimes must
 * name the engine in `renderAs` and serve the file's RAW text as the document
 * body, on /api/plan and on /api/doc, or the same .mmd renders as a diagram
 * under Claude Code and as plain text under Pi.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./serverAnnotate.ts";

const MINIMAL_HTML = "<html><body>editor</body></html>";
const MERMAID = "flowchart TD\n  A[Start] --> B{Choice}\n  B --> C[Done]\n";
const DOT = "digraph G {\n  a -> b;\n}\n";

describe("pi annotate server: diagram sources", () => {
	let dir: string;
	let savedPort: string | undefined;
	let savedRemote: string | undefined;
	let savedHistory: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pn-pi-diagram-"));
		savedPort = process.env.PLANNOTATOR_PORT;
		savedRemote = process.env.PLANNOTATOR_REMOTE;
		savedHistory = process.env.PLANNOTATOR_ANNOTATE_HISTORY;
		delete process.env.PLANNOTATOR_PORT;
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
		else process.env.PLANNOTATOR_PORT = savedPort;
		if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
		else process.env.PLANNOTATOR_REMOTE = savedRemote;
		if (savedHistory === undefined) delete process.env.PLANNOTATOR_ANNOTATE_HISTORY;
		else process.env.PLANNOTATOR_ANNOTATE_HISTORY = savedHistory;
	});

	test("/api/plan names the engine and keeps the raw text", async () => {
		const file = join(dir, "flow.mmd");
		writeFileSync(file, MERMAID, "utf-8");
		const server = await startAnnotateServer({ markdown: MERMAID, filePath: file, htmlContent: MINIMAL_HTML });
		try {
			const json = (await (await fetch(`${server.url}/api/plan`)).json()) as {
				plan: string; renderAs?: string; rawHtml?: string;
			};
			expect(json.renderAs).toBe("mermaid");
			expect(json.plan).toBe(MERMAID);
			expect(json.rawHtml).toBeUndefined();
		} finally {
			server.stop();
		}
	});

	test("/api/plan maps .dot onto graphviz and leaves markdown alone", async () => {
		const dotFile = join(dir, "graph.dot");
		writeFileSync(dotFile, DOT, "utf-8");
		const dotServer = await startAnnotateServer({ markdown: DOT, filePath: dotFile, htmlContent: MINIMAL_HTML });
		try {
			const json = (await (await fetch(`${dotServer.url}/api/plan`)).json()) as { renderAs?: string };
			expect(json.renderAs).toBe("graphviz");
		} finally {
			dotServer.stop();
		}

		const mdFile = join(dir, "notes.md");
		writeFileSync(mdFile, "# Notes", "utf-8");
		const mdServer = await startAnnotateServer({ markdown: "# Notes", filePath: mdFile, htmlContent: MINIMAL_HTML });
		try {
			const json = (await (await fetch(`${mdServer.url}/api/plan`)).json()) as { renderAs?: string };
			expect(json.renderAs).toBe("markdown");
		} finally {
			mdServer.stop();
		}
	});

	test("/api/doc serves a diagram sibling with its engine and raw text", async () => {
		writeFileSync(join(dir, "index.md"), "# Index\n", "utf-8");
		const file = join(dir, "flow.mmd");
		writeFileSync(file, MERMAID, "utf-8");
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
			expect(json.renderAs).toBe("mermaid");
			expect(json.markdown).toBe(MERMAID);
		} finally {
			server.stop();
		}
	});
});
