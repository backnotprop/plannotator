import { describe, expect, test } from "bun:test";
import {
	applyPhaseTools,
	isPlanWritePathAllowed,
	isPlannotatorSubmitDevicePath,
	PLAN_MARK_DONE_TOOL,
	PLAN_SUBMIT_DEVICE_URI,
	PLAN_SUBMIT_TOOL,
	releasePhaseTools,
	stripPlanningOnlyTools,
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

test("removes plan-only tools on phase exit", () => {
	expect(stripPlanningOnlyTools(["read", PLAN_SUBMIT_TOOL, PLAN_MARK_DONE_TOOL])).toEqual([
		"read",
	]);
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

describe("plannotator submit device path gate", () => {
	test("recognizes the exact submit device URI", () => {
		expect(isPlannotatorSubmitDevicePath("xd://plannotator_submit_plan")).toBe(true);
		expect(isPlannotatorSubmitDevicePath(PLAN_SUBMIT_DEVICE_URI)).toBe(true);
	});

	test("rejects lookalikes: suffix, subpath, or wrong case", () => {
		// Suffix
		expect(isPlannotatorSubmitDevicePath("xd://plannotator_submit_plan2")).toBe(false);
		expect(isPlannotatorSubmitDevicePath("xd://plannotator_submit_plans")).toBe(false);
		expect(isPlannotatorSubmitDevicePath("xd://plannotator_submit_plan_extra")).toBe(false);
		// Subpath
		expect(isPlannotatorSubmitDevicePath("xd://plannotator_submit_plan/")).toBe(false);
		expect(isPlannotatorSubmitDevicePath("xd://plannotator_submit_plan/extra")).toBe(false);
		expect(isPlannotatorSubmitDevicePath("xd://plannotator_submit_plan/sub/path")).toBe(false);
		// Wrong scheme case
		expect(isPlannotatorSubmitDevicePath("XD://plannotator_submit_plan")).toBe(false);
		expect(isPlannotatorSubmitDevicePath("Xd://plannotator_submit_plan")).toBe(false);
		// Wrong tool name case
		expect(isPlannotatorSubmitDevicePath("xd://PLANNOTATOR_SUBMIT_PLAN")).toBe(false);
		expect(isPlannotatorSubmitDevicePath("xd://Plannotator_Submit_Plan")).toBe(false);
		// Surrounding whitespace
		expect(isPlannotatorSubmitDevicePath(" xd://plannotator_submit_plan")).toBe(false);
		expect(isPlannotatorSubmitDevicePath("xd://plannotator_submit_plan ")).toBe(false);
	});

	test("rejects other device URIs", () => {
		expect(isPlannotatorSubmitDevicePath("xd://report_issue")).toBe(false);
		expect(isPlannotatorSubmitDevicePath("xd://plannotator_mark_done")).toBe(false);
		expect(isPlannotatorSubmitDevicePath("xd://eval")).toBe(false);
		expect(isPlannotatorSubmitDevicePath("xd://bash")).toBe(false);
		expect(isPlannotatorSubmitDevicePath("xd://browse")).toBe(false);
	});

	test("rejects non-string and empty inputs", () => {
		expect(isPlannotatorSubmitDevicePath(undefined)).toBe(false);
		expect(isPlannotatorSubmitDevicePath(null)).toBe(false);
		expect(isPlannotatorSubmitDevicePath(123)).toBe(false);
		expect(isPlannotatorSubmitDevicePath({})).toBe(false);
		expect(isPlannotatorSubmitDevicePath([])).toBe(false);
		expect(isPlannotatorSubmitDevicePath(true)).toBe(false);
		expect(isPlannotatorSubmitDevicePath("")).toBe(false);
	});

	test("isPlanWritePathAllowed still rejects device URIs as plan file paths", () => {
		const cwd = "/r";
		expect(isPlanWritePathAllowed("xd://plannotator_submit_plan", cwd)).toBe(false);
		expect(isPlanWritePathAllowed(PLAN_SUBMIT_DEVICE_URI, cwd)).toBe(false);
		expect(isPlanWritePathAllowed("xd://report_issue", cwd)).toBe(false);
	});
});
