/**
 * Note-taking app integrations (Obsidian, Bear, Octarine).
 * Node.js equivalents of packages/server/integrations.ts.
 * Config types, save functions, tag extraction, filename generation
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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
} from "../generated/integrations-common.js";
import { sanitizeTag } from "../generated/project.js";
import { resolveUserPath } from "../generated/resolve-file.js";
import { callRoamLocalApi } from "./roam-client.js";

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
	DEFAULT_ROAM_PARENT_BLOCK,
};

/** Detect project name from git or cwd (sync). Used by extractTags for note integrations. */
function detectProjectNameSync(): string | null {
	try {
		const toplevel = execSync("git rev-parse --show-toplevel", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		if (toplevel) {
			const name = sanitizeTag(basename(toplevel));
			if (name) return name;
		}
	} catch {
		/* not in a git repo */
	}
	try {
		return sanitizeTag(basename(process.cwd())) ?? null;
	} catch {
		return null;
	}
}

export async function extractTags(markdown: string): Promise<string[]> {
	const tags = new Set<string>(["plannotator"]);
	const projectName = detectProjectNameSync();
	if (projectName) tags.add(projectName);
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
	const h1Match = markdown.match(
		/^#\s+(?:Implementation\s+Plan:|Plan:)?\s*(.+)$/im,
	);
	if (h1Match) {
		h1Match[1]
			.toLowerCase()
			.replace(/[^\w\s-]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 2 && !stopWords.has(w))
			.slice(0, 3)
			.forEach((w) => tags.add(w));
	}
	const seenLangs = new Set<string>();
	let langMatch: RegExpExecArray | null;
	const langRegex = /```(\w+)/g;
	while ((langMatch = langRegex.exec(markdown)) !== null) {
		const lang = langMatch[1];
		const n = lang.toLowerCase();
		if (
			!seenLangs.has(n) &&
			!["json", "yaml", "yml", "text", "txt", "markdown", "md"].includes(n)
		) {
			seenLangs.add(n);
			tags.add(n);
		}
	}
	return Array.from(tags).slice(0, 7);
}

export async function saveToObsidian(
	config: ObsidianConfig,
): Promise<IntegrationResult> {
	try {
		const { vaultPath, folder, plan } = config;
		if (!vaultPath?.trim()) {
			return { success: false, error: "Vault path is required" };
		}
		const normalizedVault = resolveUserPath(vaultPath);
		if (!existsSync(normalizedVault))
			return {
				success: false,
				error: `Vault path does not exist: ${normalizedVault}`,
			};
		if (!statSync(normalizedVault).isDirectory())
			return {
				success: false,
				error: `Vault path is not a directory: ${normalizedVault}`,
			};
		const folderName = folder.trim() || "plannotator";
		const targetFolder = join(normalizedVault, folderName);
		if (!existsSync(targetFolder)) mkdirSync(targetFolder, { recursive: true });
		const filename = generateFilename(
			plan,
			config.filenameFormat,
			config.filenameSeparator,
		);
		const filePath = join(targetFolder, filename);
		const tags = await extractTags(plan);
		const frontmatter = generateFrontmatter(tags);
		const content = `${frontmatter}\n\n[[Plannotator Plans]]\n\n${plan}`;
		writeFileSync(filePath, content);
		return { success: true, path: filePath };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

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
		spawn("open", [url], { stdio: "ignore" });
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

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
		return {
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
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

export async function saveToOctarine(
	config: OctarineConfig,
): Promise<IntegrationResult> {
	try {
		const { plan } = config;
		const workspace = config.workspace.trim();
		if (!workspace) return { success: false, error: "Workspace is required" };
		const folder = config.folder.trim() || "plannotator";
		const filename = generateFilename(plan);
		const base = filename.replace(/\.md$/, "");
		const path = folder ? `${folder}/${base}` : base;
		const tags = await extractTags(plan);
		const frontmatter = generateOctarineFrontmatter(tags);
		const content = `${frontmatter}\n\n${plan}`;
		const url = `octarine://create?path=${encodeURIComponent(path)}&content=${encodeURIComponent(content)}&workspace=${encodeURIComponent(workspace)}&fresh=true&openAfter=false`;
		spawn("open", [url], { stdio: "ignore" });
		return { success: true, path };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}
