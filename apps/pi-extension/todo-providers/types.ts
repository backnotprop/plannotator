import type { ChecklistItem } from "../generated/checklist.ts";

/**
 * An editable todo backend that mirrors an approved plan's checklist.
 *
 * Sync is one-way (Plannotator -> provider). Plannotator remains the source of
 * truth for step state: it parses `[DONE:n]` markers out of the plan file and
 * pushes the resulting status. Edits made inside the provider are never read
 * back, so a user reordering or rewording a todo cannot desync plan execution.
 */
export interface TodoProvider {
	/** Stable identifier, surfaced in notifications. */
	readonly name: string;
	/**
	 * Make the provider match `items` for the given plan.
	 *
	 * Implementations MUST be idempotent: repeated calls with the same arguments
	 * converge on the same provider state instead of creating duplicates. This
	 * runs once on plan approval and again whenever a `[DONE:n]` marker lands,
	 * so it covers both the initial push and later status reflection. An empty
	 * `items` is not a no-op: it still reconciles against `planId`'s previously
	 * synced state, closing any todos this call no longer lists.
	 */
	sync(items: ChecklistItem[], planId: string): Promise<void>;
}

/** Host facts a provider needs. Kept narrow so providers stay testable. */
export interface TodoProviderEnv {
	cwd: string;
	/** Session id, recorded as the owning session when available. */
	sessionId?: string;
}
