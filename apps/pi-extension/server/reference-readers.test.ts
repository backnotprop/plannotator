/**
 * Pi plan and annotate servers: who may list and read through the Files
 * sidebar and Obsidian routes. Same scenarios as the Bun servers
 * (packages/server/reference-readers.scenarios.ts), so the mirror cannot drift.
 */
import { defineReferenceReaderScenarios } from "../../../packages/server/reference-readers.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { startPlanReviewServer } from "./serverPlan.ts";

defineReferenceReaderScenarios("pi", async (kind, { docPath, htmlContent }) => {
	if (kind === "plan") return startPlanReviewServer({ plan: "# Plan\n\nSteps", htmlContent, origin: "pi" });
	return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
});
