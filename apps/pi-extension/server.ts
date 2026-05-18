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
} from "./generated/review-core.js";
export type { VcsSelection } from "./server/vcs.js";
export {
	type AnnotateServerResult,
	startAnnotateServer,
} from "./server/serverAnnotate.js";
export {
	type PlanServerResult,
	startPlanReviewServer,
} from "./server/serverPlan.js";
export {
	type ReviewServerResult,
	startReviewServer,
} from "./server/serverReview.js";
export {
	canStageFiles,
	detectRemoteDefaultCompareTarget,
	detectVcs,
	getGitContext,
	getVcsContext,
	getVcsFileContentsForDiff,
	prepareLocalReviewDiff,
	resolveInitialDiffType,
	resolveVcsCwd,
	reviewRuntime,
	runGitDiff,
	runVcsDiff,
	stageFile,
	unstageFile,
} from "./server/vcs.js";
