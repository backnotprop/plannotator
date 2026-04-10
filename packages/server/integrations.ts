/**
 * Note-taking app integrations (Obsidian, Bear)
 */

import { $ } from "bun";
import { join } from "path";
import { mkdirSync, existsSync, statSync } from "fs";
import { detectProjectName } from "./project";

import {
	type ObsidianConfig,
	type BearConfig,
	type OctarineConfig,
	type IntegrationResult,
	type RoamConfig,
	type RoamSuggestionPage,
	type RoamSuggestionsResult,
	extractTitle,
	generateFrontmatter,
	generateFilename,
	generateOctarineFrontmatter,
	generatePageTitle,
	formatRoamDailyNotePage,
	majorMinorMatches,
	normalizeRoamSuggestionsToPages,
	normalizeRoamDailyNoteParent,
	frontmatterToAttributeBlocks,
	stripFrontmatter,
	stripRoamMetadataTags,
	stripH1,
	buildHashtags,
	buildBearContent,
	detectObsidianVaults,
	ROAM_API_VERSION,
	DEFAULT_ROAM_PARENT_BLOCK,
} from "@plannotator/shared/integrations-common";
import { resolveUserPath } from "@plannotator/shared/resolve-file";
import { callRoamLocalApi } from "./roam-client";

export type {
	ObsidianConfig,
	BearConfig,
	OctarineConfig,
	RoamConfig,
	RoamSuggestionPage,
	RoamSuggestionsResult,
	IntegrationResult,
};
export {
	ROAM_API_VERSION,
	detectObsidianVaults,
	extractTitle,
	generateFrontmatter,
	generateFilename,
	generateOctarineFrontmatter,
	generatePageTitle,
	formatRoamDailyNotePage,
	majorMinorMatches,
	normalizeRoamSuggestionsToPages,
	normalizeRoamDailyNoteParent,
	frontmatterToAttributeBlocks,
	stripFrontmatter,
	stripRoamMetadataTags,
	stripH1,
	buildHashtags,
	buildBearContent,
	DEFAULT_ROAM_PARENT_BLOCK,
};

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
 * Save plan to Roam Research via the local API.
 */
export async function saveToRoam(
	config: RoamConfig,
): Promise<IntegrationResult> {
	try {
		const { frontmatter } = stripFrontmatter(config.plan);
		const title = generatePageTitle(
			config.plan,
			config.titleFormat,
			config.titleSeparator,
		);
		const markdownBlock = buildRoamMarkdownBlock(config.plan);
		const contentMarkdown = [
			frontmatterToAttributeBlocks(frontmatter),
			markdownBlock,
		]
			.filter((section) => section.trim().length > 0)
			.join("\n\n");

		if (config.saveLocation === "daily-note") {
			const createPlanBlockResult = await callRoamLocalApi<{ uids?: string[] }>(
				config,
				"data.block.fromMarkdown",
				[
					{
						location: {
							order: "last",
							"page-title": {
								"daily-note-page": formatRoamDailyNotePage(new Date()),
							},
							"nest-under-str": normalizeRoamDailyNoteParent(
								config.dailyNoteParent,
							),
						},
						"markdown-string": title,
					},
				],
			);

			const planBlockUid = createPlanBlockResult.uids?.[0];
			if (!planBlockUid) {
				return {
					success: false,
					error: "Roam did not return a block UID for the saved plan",
				};
			}

			await callRoamLocalApi<{ uids?: string[] }>(
				config,
				"data.block.fromMarkdown",
				[
					{
						location: {
							order: "last",
							"parent-uid": planBlockUid,
						},
						"markdown-string": contentMarkdown,
					},
				],
			);

			return {
				success: true,
				path: `roam:${config.graphType}:${config.graphName}/${planBlockUid}`,
			};
		}

		const markdown = [
			DEFAULT_ROAM_PARENT_BLOCK,
			contentMarkdown,
		]
			.filter((section) => section.trim().length > 0)
			.join("\n\n");

		const result = await callRoamLocalApi<{
			uid?: string;
			title?: string;
			page?: { uid?: string; title?: string };
		}>(
			config,
			"data.page.fromMarkdown",
			[
				{
					page: { title },
					"markdown-string": markdown,
				},
			],
		);

		const pathId = result.page?.uid ?? result.uid ?? result.page?.title ?? result.title ?? title;
		return {
			success: true,
			path: `roam:${config.graphType}:${config.graphName}/${pathId}`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		return { success: false, error: message };
	}
}

function buildRoamMarkdownBlock(markdown: string): string {
	const longestBacktickRun = Math.max(
		0,
		...[...markdown.matchAll(/`+/g)].map((match) => match[0].length),
	);
	const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
	return `${fence}markdown\n${markdown.trimEnd()}\n${fence}`;
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
