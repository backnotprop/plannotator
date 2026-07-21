/**
 * Note-taking app integrations (Obsidian, Bear, Octarine, Notion)
 */

import { $ } from "bun";
import { join } from "path";
import { mkdirSync, existsSync, statSync } from "fs";
import { detectProjectName } from "./project";

import {
	type ObsidianConfig,
	type BearConfig,
	type OctarineConfig,
	type NotionConfig,
	type IntegrationResult,
	extractTitle,
	generateFrontmatter,
	generateFilename,
	generateOctarineFrontmatter,
	stripH1,
	buildHashtags,
	buildBearContent,
	detectObsidianVaults,
} from "@plannotator/shared/integrations-common";
import { resolveUserPath } from "@plannotator/shared/resolve-file";

export type { ObsidianConfig, BearConfig, OctarineConfig, NotionConfig, IntegrationResult };
export { detectObsidianVaults, extractTitle, generateFrontmatter, generateFilename, generateOctarineFrontmatter, stripH1, buildHashtags, buildBearContent };

/**
 * Extract tags from markdown content using simple heuristics
 * Includes project name detection (git repo or directory name)
 */
export async function extractTags(markdown: string): Promise<string[]> {
	const tags = new Set<string>(["plannotator"]);

	// Add project name tag (git repo name or directory fallback)
	const projectName = await detectProjectName();
	if (projectName) {
		tags.add(projectName);
	}

	const stopWords = new Set([
		"the",
		"and",
		"for",
		"with",
		"this",
		"that",
		"from",
		"into",
		"plan",
		"implementation",
		"overview",
		"phase",
		"step",
		"steps",
	]);

	// Extract from first H1 title
	const h1Match = markdown.match(
		/^#\s+(?:Implementation\s+Plan:|Plan:)?\s*(.+)$/im,
	);
	if (h1Match) {
		const titleWords = h1Match[1]
			.toLowerCase()
			.replace(/[^\w\s-]/g, " ")
			.split(/\s+/)
			.filter((word) => word.length > 2 && !stopWords.has(word));
		titleWords.slice(0, 3).forEach((word) => tags.add(word));
	}

	// Extract code fence languages
	const langMatches = markdown.matchAll(/```(\w+)/g);
	const seenLangs = new Set<string>();
	for (const [, lang] of langMatches) {
		const normalizedLang = lang.toLowerCase();
		if (
			!seenLangs.has(normalizedLang) &&
			!["json", "yaml", "yml", "text", "txt", "markdown", "md"].includes(
				normalizedLang,
			)
		) {
			seenLangs.add(normalizedLang);
			tags.add(normalizedLang);
		}
	}

	return Array.from(tags).slice(0, 7);
}

// --- Obsidian Integration ---

/**
 * Save plan to Obsidian vault with cross-platform path handling
 */
export async function saveToObsidian(
	config: ObsidianConfig,
): Promise<IntegrationResult> {
	try {
		const { vaultPath, folder, plan } = config;

		if (!vaultPath?.trim()) {
			return { success: false, error: "Vault path is required" };
		}

		const normalizedVault = resolveUserPath(vaultPath);

		// Validate vault path exists and is a directory
		if (!existsSync(normalizedVault)) {
			return {
				success: false,
				error: `Vault path does not exist: ${normalizedVault}`,
			};
		}

		const vaultStat = statSync(normalizedVault);
		if (!vaultStat.isDirectory()) {
			return {
				success: false,
				error: `Vault path is not a directory: ${normalizedVault}`,
			};
		}

		// Build target folder path
		const folderName = folder.trim() || "plannotator";
		const targetFolder = join(normalizedVault, folderName);

		// Create folder if it doesn't exist (guard for Bun mkdirSync regression)
		if (!existsSync(targetFolder)) {
			mkdirSync(targetFolder, { recursive: true });
		}

		// Generate filename and full path
		const filename = generateFilename(
			plan,
			config.filenameFormat,
			config.filenameSeparator,
		);
		const filePath = join(targetFolder, filename);

		// Generate content with frontmatter and backlink
		const tags = await extractTags(plan);
		const frontmatter = generateFrontmatter(tags);
		const content = `${frontmatter}\n\n[[Plannotator Plans]]\n\n${plan}`;

		// Write file
		await Bun.write(filePath, content);

		return { success: true, path: filePath };
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		return { success: false, error: message };
	}
}

/**
 * Save plan to Bear using x-callback-url
 */
export async function saveToBear(
	config: BearConfig,
): Promise<IntegrationResult> {
	try {
		const { plan, customTags, tagPosition = "append" } = config;

		const title = extractTitle(plan);
		const body = stripH1(plan);

		const tags = customTags?.trim() ? undefined : await extractTags(plan);
		const hashtags = buildHashtags(customTags, tags ?? []);

		const content = buildBearContent(body, hashtags, tagPosition);

		const url = `bear://x-callback-url/create?title=${encodeURIComponent(title)}&text=${encodeURIComponent(content)}&open_note=no`;

		await $`open ${url}`.quiet();

		return { success: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		return { success: false, error: message };
	}
}

/**
 * Save plan to Octarine using octarine:// URI scheme
 */
export async function saveToOctarine(
	config: OctarineConfig,
): Promise<IntegrationResult> {
	try {
		const { plan } = config;
		const workspace = config.workspace.trim();
		if (!workspace) return { success: false, error: "Workspace is required" };
		const folder = config.folder.trim() || "plannotator";

		const filename = generateFilename(plan);
		// Strip .md — Octarine auto-adds it
		const basename = filename.replace(/\.md$/, "");
		const path = folder ? `${folder}/${basename}` : basename;

		const tags = await extractTags(plan);
		const frontmatter = generateOctarineFrontmatter(tags);
		const content = `${frontmatter}\n\n${plan}`;

		const url = `octarine://create?path=${encodeURIComponent(path)}&content=${encodeURIComponent(content)}&workspace=${encodeURIComponent(workspace)}&fresh=true&openAfter=false`;

		await $`open ${url}`.quiet();

		return { success: true, path };
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		return { success: false, error: message };
	}
}

export const NOTION_API_VERSION = "2026-03-11";

/** Save a plan as a child page of a Notion page using the user's local token. */
export async function saveToNotion(
	config: NotionConfig,
): Promise<IntegrationResult> {
	const token = process.env.NOTION_TOKEN?.trim();
	if (!token) {
		return { success: false, error: "Notion is not configured. Set NOTION_TOKEN." };
	}

	const parentPageId = config.parentPageId.trim();
	if (!parentPageId) {
		return { success: false, error: "Notion parent page is required." };
	}

	try {
		const response = await fetch("https://api.notion.com/v1/pages", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"Notion-Version": NOTION_API_VERSION,
			},
			body: JSON.stringify({
				parent: { page_id: parentPageId },
				properties: {
					title: { title: [{ text: { content: extractTitle(config.plan) } }] },
				},
				markdown: config.plan,
			}),
		});

		const data = await response.json().catch(() => null) as { message?: unknown; url?: unknown } | null;
		if (!response.ok) {
			const detail = typeof data?.message === "string" ? ` ${data.message}` : "";
			if (response.status === 401) return { success: false, error: `Notion token is invalid or revoked.${detail}` };
			if (response.status === 403) return { success: false, error: `Notion cannot access this page. Share the parent page with your Notion integration.${detail}` };
			if (response.status === 429) return { success: false, error: `Notion rate limit exceeded.${detail}` };
			return { success: false, error: `Notion export failed (${response.status}).${detail}` };
		}

		return { success: true, ...(typeof data?.url === "string" ? { url: data.url } : {}) };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? `Notion export failed: ${err.message}` : "Notion export failed.",
		};
	}
}
