import { describe, expect, test } from "bun:test";
import {
	getToolsForPhase,
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
