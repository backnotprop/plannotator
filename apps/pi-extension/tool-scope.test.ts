import { describe, expect, test } from "bun:test";
import {
	getToolsForPhase,
	isPlanWritePathAllowed,
	PLAN_SUBMIT_TOOL,
	stripPlanningOnlyTools,
} from "./tool-scope";

describe("pi plan tool scoping", () => {
	test("planning phase adds the submit tool and discovery helpers", () => {
		expect(getToolsForPhase(["read", "bash", "edit", "write"], "planning")).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
			PLAN_SUBMIT_TOOL,
		]);
	});

	test("idle and executing phases strip the planning-only submit tool", () => {
		const leakedTools = ["read", "bash", "grep", PLAN_SUBMIT_TOOL, "write"];

		expect(getToolsForPhase(leakedTools, "idle")).toEqual([
			"read",
			"bash",
			"grep",
			"write",
		]);
		expect(getToolsForPhase(leakedTools, "executing")).toEqual([
			"read",
			"bash",
			"grep",
			"write",
		]);
	});

	test("stripping planning-only tools preserves unrelated tools", () => {
		expect(stripPlanningOnlyTools([PLAN_SUBMIT_TOOL, "todo", "question", "read"])).toEqual([
			"todo",
			"question",
			"read",
		]);
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
