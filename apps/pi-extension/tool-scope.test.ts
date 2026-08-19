import { describe, expect, test } from "bun:test";
import {
	applyPhaseTools,
	isPlanWritePathAllowed,
	releasePhaseTools,
} from "./tool-scope.ts";

describe("pi plan tool scoping", () => {
	test("adds configured phase tools without replacing the active tools", () => {
		expect(
			applyPhaseTools(["inspect", "search"], [], ["search", "submit_plan"]),
		).toEqual({
			activeTools: ["inspect", "search", "submit_plan"],
			addedTools: ["submit_plan"],
		});
	});

	test("changes phases without restoring tools removed by another extension", () => {
		expect(
			applyPhaseTools(
				["inspect", "external_new", "submit_plan"],
				["submit_plan", "missing_phase_tool"],
				["execution_progress"],
			),
		).toEqual({
			activeTools: ["inspect", "external_new", "execution_progress"],
			addedTools: ["execution_progress"],
		});
	});

	test("releases only tools added by the phase", () => {
		expect(
			releasePhaseTools(
				["inspect", "external_new", "execution_progress"],
				["execution_progress", "already_removed"],
			),
		).toEqual(["inspect", "external_new"]);
	});
});

describe("plan write path gate", () => {
	const cwd = "/r";

	test("allows markdown files anywhere inside cwd", () => {
		expect(isPlanWritePathAllowed("PLAN.md", cwd)).toBe(true);
		expect(isPlanWritePathAllowed("plans/auth.md", cwd)).toBe(true);
		expect(isPlanWritePathAllowed("deeply/nested/dir/notes.mdx", cwd)).toBe(true);
	});

	test("rejects non-markdown extensions", () => {
		expect(isPlanWritePathAllowed("src/app.ts", cwd)).toBe(false);
		expect(isPlanWritePathAllowed("notes.txt", cwd)).toBe(false);
		expect(isPlanWritePathAllowed("config.json", cwd)).toBe(false);
	});

	test("rejects files with no extension or bare directories", () => {
		expect(isPlanWritePathAllowed("plans", cwd)).toBe(false);
		expect(isPlanWritePathAllowed("PLAN", cwd)).toBe(false);
	});

	test("rejects traversal and absolute paths outside cwd", () => {
		expect(isPlanWritePathAllowed("../escape.md", cwd)).toBe(false);
		expect(isPlanWritePathAllowed("../../etc/passwd.md", cwd)).toBe(false);
		expect(isPlanWritePathAllowed("/tmp/leak.md", cwd)).toBe(false);
	});

	test("allows absolute paths that resolve inside cwd", () => {
		expect(isPlanWritePathAllowed("/r/plans/foo.md", cwd)).toBe(true);
	});

	test("rejects empty path and the cwd itself", () => {
		expect(isPlanWritePathAllowed("", cwd)).toBe(false);
		expect(isPlanWritePathAllowed(".", cwd)).toBe(false);
	});

	test("extension check is case-insensitive", () => {
		expect(isPlanWritePathAllowed("PLAN.MD", cwd)).toBe(true);
		expect(isPlanWritePathAllowed("notes.MdX", cwd)).toBe(true);
	});
});
