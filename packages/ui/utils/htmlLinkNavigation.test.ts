/**
 * What a link click inside a raw-HTML annotate document resolves to.
 *
 * The failure this guards: a srcdoc document's base URL is the PARENT page's,
 * so every unhandled link resolves onto the Plannotator server and the
 * catch-all answers with the app itself — the editor rendered inside the
 * annotated frame. The resolver is what turns each href into "open this local
 * document", "new tab", or "nothing", so a regression here puts the app back
 * inside the frame or starts fetching paths the session never authorized.
 */
import { describe, expect, test } from "bun:test";
import {
	documentRendersHtml,
	MAX_HTML_LINK_HREF_LENGTH,
	resolveHtmlLinkIntent,
} from "./htmlLinkNavigation";

const CTX = {
	baseDir: "/site/sub",
	rootDir: "/site",
	serverOrigin: "http://localhost:19601",
};

describe("resolveHtmlLinkIntent — local documents", () => {
	test("a sibling .html resolves against the CURRENT document's directory", () => {
		expect(resolveHtmlLinkIntent("02-detail.html", CTX)).toEqual({
			kind: "document",
			path: "/site/sub/02-detail.html",
			hash: "",
			rendersHtml: true,
		});
	});

	test("`../` climbs out of the current document's directory", () => {
		// The owner's reported shape: sub/02-detail.html linking back up.
		expect(resolveHtmlLinkIntent("../index.html", CTX)).toMatchObject({
			kind: "document",
			path: "/site/index.html",
		});
		expect(resolveHtmlLinkIntent("./nested/../a.htm", CTX)).toMatchObject({
			kind: "document",
			path: "/site/sub/a.htm",
		});
	});

	test("`..` can never climb past the filesystem root", () => {
		expect(
			resolveHtmlLinkIntent("../../../../../../etc/passwd.html", CTX),
		).toMatchObject({ kind: "document", path: "/etc/passwd.html" });
	});

	test("markdown and text siblings are documents too", () => {
		expect(resolveHtmlLinkIntent("notes.md", CTX)).toMatchObject({
			kind: "document",
			path: "/site/sub/notes.md",
		});
		expect(resolveHtmlLinkIntent("log.txt", CTX)).toMatchObject({ kind: "document" });
	});

	test("a percent-encoded path is decoded before it becomes a path", () => {
		expect(resolveHtmlLinkIntent("my%20page.html", CTX)).toMatchObject({
			kind: "document",
			path: "/site/sub/my page.html",
		});
	});

	test("the query is dropped and the fragment is kept", () => {
		expect(resolveHtmlLinkIntent("a.html?v=2#part-3", CTX)).toEqual({
			kind: "document",
			path: "/site/sub/a.html",
			hash: "part-3",
			rendersHtml: true,
		});
		expect(resolveHtmlLinkIntent("a.html#part-3", CTX)).toMatchObject({ hash: "part-3" });
		expect(resolveHtmlLinkIntent("a.html?v=2", CTX)).toMatchObject({ hash: "" });
	});

	test("root-relative paths resolve against the SITE root, not the current directory", () => {
		expect(resolveHtmlLinkIntent("/01-entry-point.html", CTX)).toMatchObject({
			kind: "document",
			path: "/site/01-entry-point.html",
		});
	});
});

describe("resolveHtmlLinkIntent — absolute URLs", () => {
	test("this server's own origin is treated as a root-relative site path", () => {
		// The owner's example: an author writing http://localhost:<port>/x.html
		// means "x.html of this site". Left as a navigation it hits the
		// catch-all and loads the app into the frame.
		expect(
			resolveHtmlLinkIntent("http://localhost:19601/01-entry-point.html", CTX),
		).toMatchObject({ kind: "document", path: "/site/01-entry-point.html" });
		expect(
			resolveHtmlLinkIntent("http://localhost:19601/sub/02-detail.html#top", CTX),
		).toEqual({
			kind: "document",
			path: "/site/sub/02-detail.html",
			hash: "top",
			rendersHtml: true,
		});
	});

	test("another origin is external, including a different port on localhost", () => {
		expect(resolveHtmlLinkIntent("https://example.com/x", CTX)).toEqual({
			kind: "external",
			url: "https://example.com/x",
		});
		expect(
			resolveHtmlLinkIntent("http://localhost:3000/01-entry-point.html", CTX),
		).toMatchObject({ kind: "external" });
	});

	test("scheme-relative URLs resolve through the server's own protocol", () => {
		expect(resolveHtmlLinkIntent("//example.com/x", CTX)).toMatchObject({
			kind: "external",
			url: "http://example.com/x",
		});
	});
});

describe("resolveHtmlLinkIntent — refused", () => {
	test("non-http(s) schemes are dropped rather than followed", () => {
		for (const href of [
			"javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"file:///etc/passwd",
			"mailto:a@b.c",
			"blob:http://localhost:19601/abc",
		]) {
			expect(resolveHtmlLinkIntent(href, CTX)).toEqual({
				kind: "ignored",
				reason: "scheme",
			});
		}
	});

	test("a local file Plannotator cannot render is reported, never fetched", () => {
		expect(resolveHtmlLinkIntent("report.pdf", CTX)).toEqual({
			kind: "unsupported",
			path: "/site/sub/report.pdf",
			label: "report.pdf",
		});
		expect(resolveHtmlLinkIntent("../bundle.zip", CTX)).toMatchObject({
			kind: "unsupported",
			label: "bundle.zip",
		});
	});

	test("an oversized href is dropped without being parsed", () => {
		const huge = `${"a".repeat(MAX_HTML_LINK_HREF_LENGTH)}.html`;
		expect(resolveHtmlLinkIntent(huge, CTX)).toEqual({
			kind: "ignored",
			reason: "too-long",
		});
	});

	test("control characters anywhere in the href are a rejection", () => {
		expect(resolveHtmlLinkIntent("a\u0000.html", CTX)).toMatchObject({ kind: "ignored" });
		expect(resolveHtmlLinkIntent("a\n.html", CTX)).toMatchObject({ kind: "ignored" });
		// …including ones that only appear after decoding.
		expect(resolveHtmlLinkIntent("a%00b.html", CTX)).toEqual({
			kind: "ignored",
			reason: "invalid",
		});
	});

	test("empty, fragment-only and undecodable hrefs do nothing", () => {
		expect(resolveHtmlLinkIntent("   ", CTX)).toMatchObject({ kind: "ignored" });
		expect(resolveHtmlLinkIntent("#section", CTX)).toEqual({
			kind: "ignored",
			reason: "fragment",
		});
		expect(resolveHtmlLinkIntent("?tab=2", CTX)).toMatchObject({ kind: "ignored" });
		expect(resolveHtmlLinkIntent("%E0%A4%A.html", CTX)).toEqual({
			kind: "ignored",
			reason: "invalid",
		});
	});

	test("without a base directory nothing local can be resolved", () => {
		const noBase = { serverOrigin: CTX.serverOrigin };
		expect(resolveHtmlLinkIntent("a.html", noBase)).toEqual({
			kind: "ignored",
			reason: "no-base",
		});
		// …but another origin still opens: it needs no local directory.
		expect(resolveHtmlLinkIntent("https://example.com", noBase)).toMatchObject({
			kind: "external",
		});
	});
});

describe("resolveHtmlLinkIntent — which surface the target opens on", () => {
	// `rendersHtml` is what decides whether the sidebar is revealed on
	// navigation: an HTML target keeps the sidebar exactly as the user left it
	// (the header carries its own Back), a markdown target follows the markdown
	// convention and opens the TOC, where its only way back lives.
	test("an .html/.htm target renders as another HTML surface", () => {
		expect(resolveHtmlLinkIntent("a.html", CTX)).toMatchObject({ rendersHtml: true });
		expect(resolveHtmlLinkIntent("../b.HTM", CTX)).toMatchObject({ rendersHtml: true });
		expect(resolveHtmlLinkIntent("/c.html#x", CTX)).toMatchObject({ rendersHtml: true });
	});

	test("a markdown or text target does not", () => {
		expect(resolveHtmlLinkIntent("notes.md", CTX)).toMatchObject({ rendersHtml: false });
		expect(resolveHtmlLinkIntent("notes.mdx", CTX)).toMatchObject({ rendersHtml: false });
		expect(resolveHtmlLinkIntent("log.txt", CTX)).toMatchObject({ rendersHtml: false });
	});

	test("a --markdown session Turndowns HTML, so its targets are markdown too", () => {
		expect(resolveHtmlLinkIntent("a.html", { ...CTX, convertHtml: true }))
			.toMatchObject({ rendersHtml: false });
	});

	// The annotations panel's cross-file jump asks the same question of an
	// absolute path it never routed through link resolution, and must get the
	// same answer — two spellings of the rule would let a jump pop the sidebar
	// on exactly the surface a link click leaves alone.
	test("documentRendersHtml answers for a bare path the way link resolution does", () => {
		expect(documentRendersHtml("/site/a.html")).toBe(true);
		expect(documentRendersHtml("/site/B.HTM")).toBe(true);
		expect(documentRendersHtml("/site/notes.md")).toBe(false);
		expect(documentRendersHtml("/site/log.txt")).toBe(false);
		expect(documentRendersHtml("/site/a.html", true)).toBe(false);
		for (const link of ["a.html", "../b.HTM", "notes.md", "log.txt"]) {
			const intent = resolveHtmlLinkIntent(link, CTX);
			if (intent.kind !== "document") throw new Error(`expected a document intent for ${link}`);
			expect(documentRendersHtml(intent.path)).toBe(intent.rendersHtml);
		}
	});
});
