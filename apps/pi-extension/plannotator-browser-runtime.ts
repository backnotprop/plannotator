import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PlannotatorBrowserModule = typeof import("./plannotator-browser.js");

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const planHtmlPath = resolve(moduleDirectory, "plannotator.html");
const reviewHtmlPath = resolve(moduleDirectory, "review-editor.html");

let browserModulePromise: Promise<PlannotatorBrowserModule> | undefined;
let planHtmlContent: string | undefined;
let reviewHtmlContent: string | undefined;

function hasReadableAsset(path: string, cachedContent: string | undefined): boolean {
	if (cachedContent) return true;
	try {
		const stats = statSync(path);
		return stats.isFile() && stats.size > 0;
	} catch {
		return false;
	}
}

function readBrowserAsset(path: string, cachedContent: string | undefined): string {
	if (cachedContent !== undefined) return cachedContent;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

/** Return whether the built plan/annotation/archive UI is available without reading it into memory. */
export function hasPlanBrowserHtml(): boolean {
	return hasReadableAsset(planHtmlPath, planHtmlContent);
}

/** Return whether the built code-review UI is available without reading it into memory. */
export function hasReviewBrowserHtml(): boolean {
	return hasReadableAsset(reviewHtmlPath, reviewHtmlContent);
}

/** Read and cache the built plan/annotation/archive UI on first use. */
export function getPlanBrowserHtml(): string {
	const content = readBrowserAsset(planHtmlPath, planHtmlContent);
	if (content) planHtmlContent = content;
	return content;
}

/** Read and cache the built code-review UI on first use. */
export function getReviewBrowserHtml(): string {
	const content = readBrowserAsset(reviewHtmlPath, reviewHtmlContent);
	if (content) reviewHtmlContent = content;
	return content;
}

/** Convert a startup failure into the stable user-facing message used by Pi commands and events. */
export function getStartupErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}

/**
 * Load the browser/server graph on first use.
 *
 * Concurrent callers share one import, while a failed import is cleared so a
 * later invocation can retry instead of retaining a permanently rejected promise.
 */
export function loadPlannotatorBrowser(): Promise<PlannotatorBrowserModule> {
	if (!browserModulePromise) {
		browserModulePromise = import("./plannotator-browser.js").catch((error: unknown) => {
			browserModulePromise = undefined;
			throw error;
		});
	}
	return browserModulePromise;
}
