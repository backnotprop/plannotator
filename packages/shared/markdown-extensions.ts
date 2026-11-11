/** Configured extra markdown extensions (`markdownExtensions` in config.json), read once per process. */

import {
	buildAnnotatableDocRegex,
	buildAnnotatableExtensionsHint,
	buildAnnotatableTextRegex,
	isAnnotatableDocPath as isAnnotatableDocPathWith,
	isAnnotatableTextPath as isAnnotatableTextPathWith,
	normalizeMarkdownExtensions,
	shouldStripFrontmatter as shouldStripFrontmatterWith,
} from "./annotatable";
import { loadConfig, type PlannotatorConfig } from "./config";

export { normalizeMarkdownExtensions };

export function resolveMarkdownExtensions(config: PlannotatorConfig): string[] {
	return normalizeMarkdownExtensions(config.markdownExtensions);
}

let cached: string[] | null = null;

/** Read from `config.json` on first use and memoized: the accepted set must not change mid-walk. */
export function getExtraMarkdownExtensions(config?: PlannotatorConfig): string[] {
	if (config) return resolveMarkdownExtensions(config);
	if (cached === null) cached = resolveMarkdownExtensions(loadConfig());
	return cached;
}

export function resetMarkdownExtensionsCache(): void {
	cached = null;
}

export function getAnnotatableTextRegex(): RegExp {
	return buildAnnotatableTextRegex(getExtraMarkdownExtensions());
}

export function getAnnotatableDocRegex(): RegExp {
	return buildAnnotatableDocRegex(getExtraMarkdownExtensions());
}

export function getAnnotatableExtensionsHint(): string {
	return buildAnnotatableExtensionsHint(getExtraMarkdownExtensions());
}

export function isAnnotatableTextPath(input: string): boolean {
	return isAnnotatableTextPathWith(input, getExtraMarkdownExtensions());
}

export function isAnnotatableDocPath(input: string): boolean {
	return isAnnotatableDocPathWith(input, getExtraMarkdownExtensions());
}

export function shouldStripFrontmatter(path: string | null | undefined): boolean {
	return shouldStripFrontmatterWith(path, getExtraMarkdownExtensions());
}
