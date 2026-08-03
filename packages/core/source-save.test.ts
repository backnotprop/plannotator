import { describe, expect, test } from "bun:test";
import { hasSourceSaveConflictSnapshot, type SourceSaveResponse } from "./source-save";

describe("source-save response guards", () => {
	test("recognizes conflict responses with a complete current-disk snapshot", () => {
		const response: SourceSaveResponse = {
			ok: false,
			code: "conflict",
			message: "changed",
			currentText: "disk\n",
			currentHash: "sha256:disk",
			currentMtimeMs: 1000,
			currentSize: 5,
			currentEol: "lf",
		};

		expect(hasSourceSaveConflictSnapshot(response)).toBe(true);
	});

	test("rejects conflict responses without usable snapshot metadata", () => {
		const response = {
			ok: false,
			code: "conflict",
			message: "changed",
			currentText: "disk\n",
			currentHash: "sha256:disk",
			currentMtimeMs: 1000,
			currentSize: 5,
			currentEol: "unknown",
		} as unknown as SourceSaveResponse;

		expect(hasSourceSaveConflictSnapshot(response)).toBe(false);
	});
});
