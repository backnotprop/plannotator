import { afterEach, describe, expect, test } from "bun:test";
import {
	getExtraMarkdownExtensions,
	hasLinkedDocExtension,
	setExtraMarkdownExtensions,
} from "./markdownExtensions";

// Module-level registry: every test must leave it empty for the next one.
afterEach(() => {
	setExtraMarkdownExtensions([]);
});

describe("hasLinkedDocExtension", () => {
	test("built-in document extensions are recognized without registration", () => {
		expect(hasLinkedDocExtension("notes.md")).toBe(true);
		expect(hasLinkedDocExtension("guide.mdx")).toBe(true);
		expect(hasLinkedDocExtension("page.html")).toBe(true);
		// Markdown links may carry a fragment; wiki-link targets may not (a
		// fragment-less `[[notes]]` is what gets `.md` appended).
		expect(hasLinkedDocExtension("notes.md#section", { allowFragment: true })).toBe(true);
		expect(hasLinkedDocExtension("notes.md#section")).toBe(false);
		expect(hasLinkedDocExtension("app.ts")).toBe(false);
	});

	// #1307: without this the renderer turns `[tour](tour.livemd)` into a dead
	// external link, and `[[tour.livemd]]` into a request for `tour.livemd.md`.
	test("a registered extension makes sibling docs openable", () => {
		expect(hasLinkedDocExtension("tour.livemd")).toBe(false);
		setExtraMarkdownExtensions([".livemd"]);
		expect(hasLinkedDocExtension("tour.livemd")).toBe(true);
		expect(hasLinkedDocExtension("../notebooks/TOUR.LiveMD")).toBe(true);
		expect(hasLinkedDocExtension("tour.livemd#setup", { allowFragment: true })).toBe(true);
		expect(hasLinkedDocExtension("tour.livemd.bin")).toBe(false);
	});

	test("the payload is normalized, so a malformed or denied entry registers nothing", () => {
		setExtraMarkdownExtensions([".env", "livemd", "*.livemd", ".livemd"]);
		expect(getExtraMarkdownExtensions()).toEqual([".livemd"]);
		expect(hasLinkedDocExtension(".env")).toBe(false);
	});

	test("a missing payload clears the registry rather than throwing", () => {
		setExtraMarkdownExtensions([".livemd"]);
		setExtraMarkdownExtensions(undefined);
		expect(getExtraMarkdownExtensions()).toEqual([]);
		expect(hasLinkedDocExtension("tour.livemd")).toBe(false);
	});
});
