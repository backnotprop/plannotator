import { extname, isAbsolute, relative, resolve } from "node:path";

export type Phase = "idle" | "planning" | "executing";

export const PLAN_SUBMIT_TOOL = "plannotator_submit_plan";
export const PLANNING_DISCOVERY_TOOLS = ["grep", "find", "ls"] as const;

const ALLOWED_PLAN_EXTENSIONS = new Set<string>([".md", ".mdx"]);

export function getToolsForPhase(
	baseTools: readonly string[],
	phase: Phase,
): string[] {
	if (phase !== "planning") return [...new Set(baseTools)];
	return [
		...new Set([...baseTools, ...PLANNING_DISCOVERY_TOOLS, PLAN_SUBMIT_TOOL]),
	];
}

// Used by both the planning-phase write gate and plannotator_submit_plan.
// Path must resolve inside cwd (no traversal, no absolute escape) and end
// in a permitted markdown extension.
export function isPlanWritePathAllowed(inputPath: string, cwd: string): boolean {
	if (!inputPath) return false;
	const targetAbs = resolve(cwd, inputPath);
	const rel = relative(resolve(cwd), targetAbs);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
	const ext = extname(targetAbs).toLowerCase();
	return ALLOWED_PLAN_EXTENSIONS.has(ext);
}
