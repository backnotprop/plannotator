/**
 * Node-compatible servers for Plannotator Pi extension.
 *
 * Pi loads extensions via jiti (Node.js), so we can't use Bun.serve().
 * These are lightweight node:http servers implementing just the routes
 * each UI needs — plan review, code review, and markdown annotation.
 */

export type {
	DiffOption,
	DiffType,
	GitContext,
} from "./generated/review-core.ts";
export type { WorkspaceDiffType } from "./generated/review-workspace.ts";
export type { VcsSelection } from "./server/vcs.ts";
export {
	type AnnotateServerResult,
	startAnnotateServer,
} from "./server/serverAnnotate.ts";
export {
	type PlanServerResult,
	startPlanReviewServer,
} from "./server/serverPlan.ts";
export {
	type ReviewServerResult,
	startReviewServer,
} from "./server/serverReview.ts";
export {
	canStageFiles,
	detectManagedVcs,
	detectRemoteDefaultCompareTarget,
	detectVcs,
	getGitContext,
	getVcsContext,
	getVcsDiffFingerprint,
	getVcsFileContentsForDiff,
	prepareLocalReviewDiff,
	resolveInitialDiffType,
	resolveVcsCwd,
	reviewRuntime,
	runGitDiff,
	runVcsDiff,
	stageFile,
	unstageFile,
} from "./server/vcs.ts";
