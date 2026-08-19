import { extname, isAbsolute, relative, resolve } from "node:path";

export type Phase = "idle" | "planning" | "executing";

export const PLAN_SUBMIT_TOOL = "plannotator_submit_plan";

const ALLOWED_PLAN_EXTENSIONS = new Set<string>([".md", ".mdx"]);

export function stripPlanningOnlyTools(tools: readonly string[]): string[] {
	return tools.filter((tool) => tool !== PLAN_SUBMIT_TOOL);
}

export function applyPhaseTools(
	activeTools: readonly string[],
	previouslyAddedTools: readonly string[],
	configuredTools: readonly string[],
): { activeTools: string[]; addedTools: string[] } {
	const previousAdditions = new Set(previouslyAddedTools);
	const baseTools = activeTools.filter((tool) => !previousAdditions.has(tool));
	const baseToolSet = new Set(baseTools);
	const addedTools = [...new Set(configuredTools)].filter(
		(tool) => !baseToolSet.has(tool),
	);

	return {
		activeTools: [...baseTools, ...addedTools],
		addedTools,
	};
}

export function releasePhaseTools(
	activeTools: readonly string[],
	addedTools: readonly string[],
): string[] {
	const additions = new Set(addedTools);
	return activeTools.filter((tool) => !additions.has(tool));
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
