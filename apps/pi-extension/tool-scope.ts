export type Phase = "idle" | "planning" | "executing";

export const PLAN_SUBMIT_TOOL = "plannotator_submit_plan";
export const PLANNING_DISCOVERY_TOOLS = ["grep", "find", "ls"] as const;

const PLANNING_ONLY_TOOLS = new Set<string>([PLAN_SUBMIT_TOOL]);

export function stripPlanningOnlyTools(tools: readonly string[]): string[] {
	return tools.filter((tool) => !PLANNING_ONLY_TOOLS.has(tool));
}

export function getToolsForPhase(
	baseTools: readonly string[],
	phase: Phase,
): string[] {
	const tools = stripPlanningOnlyTools(baseTools);
	if (phase !== "planning") {
		return [...new Set(tools)];
	}

	return [
		...new Set([...tools, ...PLANNING_DISCOVERY_TOOLS, PLAN_SUBMIT_TOOL]),
	];
}
