/**
 * The `/api/doc` containment gate. Normalization has to be two-sided: macOS
 * `tmpdir()` is a symlink, so
 * realpath containment against a non-realpathed root would deny legitimate
 * reads for anyone whose root sits under one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPlanFile, getAllowedRootPaths, isPathAllowed, planLinkTargets, resolvePlanLinkedDoc } from "./doc-resolve";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("isPathAllowed", () => {
	test("serves a file inside the root and denies one outside it", () => {
		const root = makeTempDir("plannotator-gate-root-");
		const outside = makeTempDir("plannotator-gate-outside-");
		writeFileSync(join(root, "note.md"), "note\n");
		writeFileSync(join(outside, "secret.md"), "secret\n");
		const roots = getAllowedRootPaths({ rootPaths: [root] });

		expect(isPathAllowed(join(root, "note.md"), roots)).toBe(true);
		expect(isPathAllowed(join(outside, "secret.md"), roots)).toBe(false);
	});

	test("denies a symlink that escapes the root, and a file reached through a symlinked directory", () => {
		const root = makeTempDir("plannotator-gate-link-root-");
		const outside = makeTempDir("plannotator-gate-link-outside-");
		writeFileSync(join(outside, "secret.md"), "secret\n");
		symlinkSync(join(outside, "secret.md"), join(root, "link.md"));
		symlinkSync(outside, join(root, "linkdir"));
		const roots = getAllowedRootPaths({ rootPaths: [root] });

		expect(isPathAllowed(join(root, "link.md"), roots)).toBe(false);
		expect(isPathAllowed(join(root, "linkdir", "secret.md"), roots)).toBe(false);
	});

	test("allows a symlinked root under either spelling", () => {
		const realFolder = makeTempDir("plannotator-gate-real-");
		const linkParent = makeTempDir("plannotator-gate-linkparent-");
		const linkFolder = join(linkParent, "docs");
		writeFileSync(join(realFolder, "note.md"), "note\n");
		symlinkSync(realFolder, linkFolder);
		const roots = getAllowedRootPaths({ rootPaths: [linkFolder] });

		expect(isPathAllowed(join(linkFolder, "note.md"), roots)).toBe(true);
		expect(isPathAllowed(realpathSync(join(realFolder, "note.md")), roots)).toBe(true);
	});

	test("judges a path whose leaf does not exist by its deepest existing ancestor", () => {
		const root = makeTempDir("plannotator-gate-missing-root-");
		const outside = makeTempDir("plannotator-gate-missing-outside-");
		symlinkSync(outside, join(root, "linkdir"));
		mkdirSync(join(root, "real"), { recursive: true });
		const roots = getAllowedRootPaths({ rootPaths: [root] });

		expect(isPathAllowed(join(root, "real", "absent.md"), roots)).toBe(true);
		expect(isPathAllowed(join(root, "absent", "deeper", "absent.md"), roots)).toBe(true);
		expect(isPathAllowed(join(root, "linkdir", "absent.md"), roots)).toBe(false);
	});
});

describe("readPlanFile", () => {
	const plan = "# Plan\n\nSee [evidence](evidence.md).\n";

	test("trusts a plan file whose contents match the plan under review", () => {
		const dir = realpathSync(makeTempDir("plannotator-plan-file-"));
		const planPath = join(dir, "plan.md");
		writeFileSync(planPath, plan);

		expect(readPlanFile(planPath, plan)).toEqual({ dir, plan });
	});

	test("refuses a path whose file holds something other than the plan", () => {
		const dir = makeTempDir("plannotator-plan-file-mismatch-");
		const planPath = join(dir, "plan.md");
		writeFileSync(planPath, "# Another plan\n");

		expect(readPlanFile(planPath, plan)).toBeNull();
		expect(readPlanFile(join(dir, "missing.md"), plan)).toBeNull();
		expect(readPlanFile("plan.md", plan)).toBeNull();
		expect(readPlanFile(42, plan)).toBeNull();
	});
});

describe("resolvePlanLinkedDoc", () => {
	function setup() {
		const dir = realpathSync(makeTempDir("plannotator-plan-docs-"));
		const outside = makeTempDir("plannotator-plan-docs-outside-");
		const plan = "# Plan\n\n[evidence](evidence.md), [[notes]], [up](../up.md), [link](linked.md)\n";
		writeFileSync(join(dir, "plan.md"), plan);
		writeFileSync(join(dir, "evidence.md"), "evidence\n");
		writeFileSync(join(dir, "notes.md"), "notes\n");
		writeFileSync(join(dir, "other-plan.md"), "other\n");
		writeFileSync(join(outside, "secret.md"), "secret\n");
		symlinkSync(join(outside, "secret.md"), join(dir, "linked.md"));
		const planFile = readPlanFile(join(dir, "plan.md"), plan);
		if (!planFile) throw new Error("plan did not match");
		return { dir, planFile };
	}

	test("serves a sibling the plan links, including by wikilink", () => {
		const { dir, planFile } = setup();

		expect(resolvePlanLinkedDoc("evidence.md", dir, planFile)).toBe(join(dir, "evidence.md"));
		expect(resolvePlanLinkedDoc("notes.md", dir, planFile)).toBe(join(dir, "notes.md"));
	});

	test("keeps the rest of the plan directory unreachable", () => {
		const { dir, planFile } = setup();

		expect(resolvePlanLinkedDoc("other-plan.md", dir, planFile)).toBeNull();
		expect(resolvePlanLinkedDoc("../up.md", dir, planFile)).toBeNull();
		expect(resolvePlanLinkedDoc("linked.md", dir, planFile)).toBeNull();
		expect(resolvePlanLinkedDoc(join(dir, "evidence.md"), dir, planFile)).toBeNull();
	});

	test("a mention or a longer link that contains a sibling's name does not unlock it", () => {
		const dir = realpathSync(makeTempDir("plannotator-plan-docs-substring-"));
		const plan = "# Plan\n\nSee [evidence](evidence.md) and [[notes-extended]]. Also other-plan.md in prose.\n";
		writeFileSync(join(dir, "plan.md"), plan);
		for (const name of ["evidence.md", "e.md", "notes.md", "notes-extended.md", "other-plan.md"]) {
			writeFileSync(join(dir, name), `${name}\n`);
		}
		const planFile = readPlanFile(join(dir, "plan.md"), plan);
		if (!planFile) throw new Error("plan did not match");

		expect(resolvePlanLinkedDoc("e.md", dir, planFile)).toBeNull();
		expect(resolvePlanLinkedDoc("notes.md", dir, planFile)).toBeNull();
		expect(resolvePlanLinkedDoc("other-plan.md", dir, planFile)).toBeNull();
		expect(resolvePlanLinkedDoc("evidence.md", dir, planFile)).toBe(join(dir, "evidence.md"));
		expect(resolvePlanLinkedDoc("notes-extended.md", dir, planFile)).toBe(join(dir, "notes-extended.md"));
	});

	test("a query or fragment suffix cannot walk from a linked target to an unlinked sibling", () => {
		const { dir, planFile } = setup();

		for (const path of [
			"evidence.md?/../other-plan.md",
			"evidence.md#/../other-plan.md",
			"evidence.md%3F/../other-plan.md",
		]) {
			expect(resolvePlanLinkedDoc(path, dir, planFile)).not.toBe(join(dir, "other-plan.md"));
		}
		// The suffix is dropped, so the linked target itself is what is served.
		expect(resolvePlanLinkedDoc("evidence.md?/../other-plan.md", dir, planFile)).toBe(join(dir, "evidence.md"));
	});

	test("a percent-encoded link opens the decoded file name", () => {
		const dir = realpathSync(makeTempDir("plannotator-plan-docs-encoded-"));
		const plan = "# Plan\n\n[doc](my%20doc.md)\n";
		writeFileSync(join(dir, "plan.md"), plan);
		writeFileSync(join(dir, "my doc.md"), "doc\n");
		const planFile = readPlanFile(join(dir, "plan.md"), plan);
		if (!planFile) throw new Error("plan did not match");

		expect(resolvePlanLinkedDoc("my%20doc.md", dir, planFile)).toBe(join(dir, "my doc.md"));
	});

	test("applies only when the request's base is the plan directory", () => {
		const { planFile } = setup();
		const elsewhere = makeTempDir("plannotator-plan-docs-base-");

		expect(resolvePlanLinkedDoc("evidence.md", elsewhere, planFile)).toBeNull();
		expect(resolvePlanLinkedDoc("evidence.md", null, planFile)).toBeNull();
		expect(resolvePlanLinkedDoc("evidence.md", planFile.dir, null)).toBeNull();
	});
});

describe("planLinkTargets", () => {
	test("collects the targets the renderer makes clickable, normalized", () => {
		const plan = [
			"[a](./a.md#section) [b](b%20c.md?x=1) [[wiki]] [[page.html|Page]] [[guide.txt]]",
			'<a href="h.html">h</a> [paren](fn_(x).md) ![img](pic.png)',
		].join("\n");

		expect([...planLinkTargets(plan)].sort()).toEqual(
			["a.md", "b c.md", "fn_(x).md", "guide.txt", "h.html", "page.html", "pic.png", "wiki.md"].sort(),
		);
	});

	test("links written inside code are not link targets", () => {
		const plan = "```md\n[a](a.md)\n```\n\n~~~\n[[b]]\n~~~\n\nInline `[c](c.md)` and [d](d.md)\n";

		expect([...planLinkTargets(plan)]).toEqual(["d.md"]);
	});

	test("plain mentions are not link targets", () => {
		expect(planLinkTargets("Read evidence.md and [not a link] too").size).toBe(0);
	});
});
