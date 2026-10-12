/**
 * Telling Oh My Pi from Pi by the ExtensionAPI object (pi-host.ts). Getting it
 * wrong flips the `plannotator` tool's default: on in plain Pi (a full tool
 * definition in every request) or off in Oh My Pi.
 */
import { describe, expect, test } from "bun:test";
import { detectPiHost } from "./pi-host.ts";

describe("detectPiHost", () => {
	test("Pi's ExtensionAPI (methods only) is Pi", () => {
		expect(detectPiHost({ on: () => undefined, registerTool: () => undefined })).toBe("pi");
		expect(detectPiHost(undefined)).toBe("pi");
	});

	test("Oh My Pi's ExtensionAPI (its schema builder and SDK module) is Oh My Pi", () => {
		expect(detectPiHost({ on: () => undefined, arktype: () => undefined, pi: {} })).toBe("oh-my-pi");
	});

	test("one of the two names alone is not enough", () => {
		expect(detectPiHost({ arktype: () => undefined })).toBe("pi");
		expect(detectPiHost({ pi: {} })).toBe("pi");
		expect(detectPiHost({ arktype: () => undefined, pi: null })).toBe("pi");
	});
});
