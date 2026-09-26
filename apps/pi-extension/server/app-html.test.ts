/**
 * #1617, Pi mirror: the node:http app-HTML routes serve the page compressed
 * to remote sessions and unchanged to local ones, through the same vendored
 * helper as the Bun servers. Nothing else changes shape (API JSON, the
 * framed-embed 404 from #1561).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestEnvironment } from "../../../tests/helpers/environment.ts";
import { closeServer, occupyConsecutivePorts } from "../../../tests/helpers/ports.ts";
import {
	expectAppHtmlNegotiation,
	expectUncompressedLocalPage,
	makeAppHtml,
	rawRequest,
} from "../../../tests/helpers/app-html.ts";
import { startPlanReviewServer } from "./serverPlan.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { startReviewServer } from "./serverReview.ts";

const environment = createTestEnvironment(
	["PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_BROWSER"],
	"plannotator-pi-app-html-",
);

async function isolate(remote: boolean): Promise<void> {
	environment.reset();
	process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
	process.env.PLANNOTATOR_BROWSER = "/usr/bin/true";
	process.env.PLANNOTATOR_REMOTE = remote ? "1" : "0";
	if (remote) {
		const { start, servers } = await occupyConsecutivePorts(1);
		await closeServer(servers[0]);
		process.env.PLANNOTATOR_PORT = String(start);
	}
}

afterEach(() => environment.restore());

const PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
`;

describe("Pi app HTML: remote sessions negotiate compression", () => {
	test("plan server", async () => {
		await isolate(true);
		const html = makeAppHtml("pi-plan");
		const server = await startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: html });
		try {
			await expectAppHtmlNegotiation(`${server.url}/`, html);
			const api = await rawRequest(`${server.url}/api/plan`, { headers: { "accept-encoding": "br, gzip" } });
			expect(api.headers["content-encoding"]).toBeUndefined();
			expect(JSON.parse(api.body.toString("utf8")).plan).toBe("# Plan");
		} finally {
			server.stop();
		}
	});

	test("annotate server, with the framed-embed 404 unchanged", async () => {
		await isolate(true);
		const html = makeAppHtml("pi-annotate");
		const server = await startAnnotateServer({
			markdown: "# Doc",
			filePath: join(tmpdir(), "pi-app-html-doc.md"),
			htmlContent: html,
			mode: "annotate",
		});
		try {
			await expectAppHtmlNegotiation(`${server.url}/`, html);
			const framed = await rawRequest(`${server.url}/missing-embed.html`, {
				headers: { "sec-fetch-dest": "iframe", "accept-encoding": "br, gzip" },
			});
			expect(framed.status).toBe(404);
			expect(framed.headers["content-encoding"]).toBeUndefined();
			expect(framed.body.toString("utf8")).toContain("missing-embed.html");
		} finally {
			server.stop();
		}
	});

	test("review server", async () => {
		await isolate(true);
		const html = makeAppHtml("pi-review");
		const server = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: html });
		try {
			await expectAppHtmlNegotiation(`${server.url}/`, html);
		} finally {
			server.stop();
		}
	});
});

describe("Pi app HTML: local sessions are unchanged", () => {
	test("plan, annotate and review serve the original page", async () => {
		await isolate(false);
		const plan = await startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: makeAppHtml("pl-plan") });
		const annotate = await startAnnotateServer({
			markdown: "# Doc",
			filePath: join(tmpdir(), "pi-app-html-local.md"),
			htmlContent: makeAppHtml("pl-annotate"),
			mode: "annotate",
		});
		const review = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: makeAppHtml("pl-review") });
		try {
			await expectUncompressedLocalPage(`${plan.url}/`, makeAppHtml("pl-plan"));
			await expectUncompressedLocalPage(`${annotate.url}/`, makeAppHtml("pl-annotate"));
			await expectUncompressedLocalPage(`${review.url}/`, makeAppHtml("pl-review"));
		} finally {
			plan.stop();
			annotate.stop();
			review.stop();
		}
	});
});
