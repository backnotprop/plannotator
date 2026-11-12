import type { ChecklistItem } from "../generated/checklist.ts";

export interface TodoProvider {
	readonly name: string;
	sync(items: ChecklistItem[], planId: string): Promise<void>;
}

export interface TodoProviderEnv {
	cwd: string;
	sessionId?: string;
}
