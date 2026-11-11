import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface ObsidianConfig {
	vaultPath: string;
	folder: string;
	plan: string;
	filenameFormat?: string;
	filenameSeparator?: "space" | "dash" | "underscore";
}

export interface BearConfig {
	plan: string;
	customTags?: string;
	tagPosition?: "prepend" | "append";
}

export interface OctarineConfig {
	plan: string;
	workspace: string;
	folder: string;
}

export interface NotionConfig {
	plan: string;
	parentPageId: string;
}

export interface IntegrationResult {
	success: boolean;
	error?: string;
	path?: string;
	url?: string;
}

/** A `..` segment (either separator) would leave the vault: the folder is a path inside it. A leading separator is harmless (`join` keeps it inside). */
export function obsidianFolderEscapesVault(folder: string): boolean {
	return folder.split(/[\\/]+/).some((segment) => segment.trim() === "..");
}

export function detectObsidianVaults(): string[] {
	try {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		let configPath: string;

		if (process.platform === "darwin") {
			configPath = join(
				home,
				"Library/Application Support/obsidian/obsidian.json",
			);
		} else if (process.platform === "win32") {
			const appData = process.env.APPDATA || join(home, "AppData/Roaming");
			configPath = join(appData, "obsidian/obsidian.json");
		} else {
			configPath = join(home, ".config/obsidian/obsidian.json");
		}

		if (!existsSync(configPath)) {
			return [];
		}

		const configContent = readFileSync(configPath, "utf-8");
		const config = JSON.parse(configContent);

		if (!config.vaults || typeof config.vaults !== "object") {
			return [];
		}

		const vaults: string[] = [];
		for (const vaultId of Object.keys(config.vaults)) {
			const vault = config.vaults[vaultId];
			if (vault.path && existsSync(vault.path)) {
				vaults.push(vault.path);
			}
		}

		return vaults;
	} catch {
		return [];
	}
}

export function generateFrontmatter(tags: string[]): string {
	const now = new Date().toISOString();
	const tagList = tags.map((t) => t.toLowerCase()).join(", ");
	return `---
created: ${now}
source: plannotator
tags: [${tagList}]
---`;
}

export function extractTitle(markdown: string): string {
	const h1Match = markdown.match(
		/^#\s+(?:Implementation\s+Plan:|Plan:)?\s*(.+)$/im,
	);
	if (h1Match) {
		return h1Match[1]
			.trim()
			.replace(/[<>:"/\\|?*(){}\[\]#~`]/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 50);
	}
	return "Plan";
}

export const DEFAULT_FILENAME_FORMAT =
	"{title} - {Mon} {D}, {YYYY} {h}-{mm}{ampm}";

/** Filename from a format string. Variables: {title}, {YYYY}, {MM}, {DD}, {Mon}, {D}, {HH}, {h}, {hh}, {mm}, {ss}, {ampm}. */
export function generateFilename(
	markdown: string,
	format?: string,
	separator?: "space" | "dash" | "underscore",
): string {
	const title = extractTitle(markdown);
	const now = new Date();

	const months = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	];

	const hour24 = now.getHours();
	const hour12 = hour24 % 12 || 12;
	const ampm = hour24 >= 12 ? "pm" : "am";

	const vars: Record<string, string> = {
		title,
		YYYY: String(now.getFullYear()),
		MM: String(now.getMonth() + 1).padStart(2, "0"),
		DD: String(now.getDate()).padStart(2, "0"),
		Mon: months[now.getMonth()],
		D: String(now.getDate()),
		HH: String(hour24).padStart(2, "0"),
		h: String(hour12),
		hh: String(hour12).padStart(2, "0"),
		mm: String(now.getMinutes()).padStart(2, "0"),
		ss: String(now.getSeconds()).padStart(2, "0"),
		ampm,
	};

	const template = format?.trim() || DEFAULT_FILENAME_FORMAT;
	const result = template.replace(
		/\{(\w+)\}/g,
		(match, key) => vars[key] ?? match,
	);

	let sanitized = result
		.replace(/[<>:"/\\|?*]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (separator === "dash") {
		sanitized = sanitized.replace(/ /g, "-");
	} else if (separator === "underscore") {
		sanitized = sanitized.replace(/ /g, "_");
	}

	return sanitized.endsWith(".md") ? sanitized : `${sanitized}.md`;
}

export function stripH1(plan: string): string {
	return plan.replace(/^#\s+.+\n?/m, "").trimStart();
}

export function buildHashtags(
	customTags: string | undefined,
	autoTags: string[],
): string {
	if (customTags?.trim()) {
		return customTags
			.split(",")
			.map((t) => `#${t.trim()}`)
			.filter((t) => t !== "#")
			.join(" ");
	}
	return autoTags.map((t) => `#${t}`).join(" ");
}

export function buildBearContent(
	body: string,
	hashtags: string,
	tagPosition: "prepend" | "append",
): string {
	return tagPosition === "prepend"
		? `${hashtags}\n\n${body}`
		: `${body}\n\n${hashtags}`;
}

export function generateOctarineFrontmatter(tags: string[]): string {
	const now = new Date().toISOString().slice(0, 16);
	const tagLines = tags.map((t) => `  - ${t.toLowerCase()}`).join("\n");
	return `---\ntags:\n${tagLines}\nStatus: Draft\nAuthor: plannotator\nLast Edited: ${now}\n---`;
}
