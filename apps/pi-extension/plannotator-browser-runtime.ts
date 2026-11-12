import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importFresh } from "./package-version.ts";

type PlannotatorBrowserModule = typeof import("./plannotator-browser.ts");

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

export function hasPlanBrowserHtml(): boolean {
	return hasReadableAsset(planHtmlPath, planHtmlContent);
}

export function hasReviewBrowserHtml(): boolean {
	return hasReadableAsset(reviewHtmlPath, reviewHtmlContent);
}

export function setPlanBrowserHtmlForTests(html: string | undefined): void {
	planHtmlContent = html;
}

export function getPlanBrowserHtml(): string {
	const content = readBrowserAsset(planHtmlPath, planHtmlContent);
	if (content) planHtmlContent = content;
	return content;
}

export const reviewDiagramEngineDirectory = resolve(moduleDirectory, "diagram-engine");

export function getReviewBrowserHtml(): string {
	const content = readBrowserAsset(reviewHtmlPath, reviewHtmlContent);
	if (content) reviewHtmlContent = content;
	return content;
}

export function getStartupErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}

export function loadPlannotatorBrowser(): Promise<PlannotatorBrowserModule> {
	if (!browserModulePromise) {
		browserModulePromise = importFresh(() => import("./plannotator-browser.ts")).catch((error: unknown) => {
			browserModulePromise = undefined;
			throw error;
		});
	}
	return browserModulePromise;
}
