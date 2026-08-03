import { describe, expect, test } from "bun:test";
import { isFileBrowserExcludedPath } from "./reference-common";

describe("isFileBrowserExcludedPath", () => {
	test("matches excluded folders at any path depth", () => {
		expect(isFileBrowserExcludedPath("node_modules")).toBe(true);
		expect(isFileBrowserExcludedPath("node_modules/pkg/readme.md")).toBe(true);
		expect(isFileBrowserExcludedPath("docs/node_modules")).toBe(true);
		expect(isFileBrowserExcludedPath("docs/node_modules/pkg/readme.md")).toBe(true);
		expect(isFileBrowserExcludedPath("docs/dist")).toBe(true);
		expect(isFileBrowserExcludedPath("docs/dist/generated.md")).toBe(true);
		expect(isFileBrowserExcludedPath(".claude/worktrees/session/plan.md")).toBe(true);
		expect(isFileBrowserExcludedPath("packages/app/.agents/skills/review/SKILL.md")).toBe(true);
	});

	test("matches exact path segments only", () => {
		expect(isFileBrowserExcludedPath("docs/node_modules_backup/readme.md")).toBe(false);
		expect(isFileBrowserExcludedPath("docs/build-notes/plan.md")).toBe(false);
		expect(isFileBrowserExcludedPath("docs/plan.md")).toBe(false);
	});

	test("normalizes windows separators and leading slashes", () => {
		expect(isFileBrowserExcludedPath("\\repo\\docs\\node_modules")).toBe(true);
		expect(isFileBrowserExcludedPath("/repo/docs/node_modules/pkg/readme.md")).toBe(true);
	});
});
