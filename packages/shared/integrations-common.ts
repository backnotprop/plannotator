import { existsSync, readFileSync } from "fs";
import { join } from "path";

// --- Types ---

export interface ObsidianConfig {
	vaultPath: string;
	folder: string;
	plan: string;
	filenameFormat?: string; // Custom format string, e.g. '{YYYY}-{MM}-{DD} - {title}'
	filenameSeparator?: "space" | "dash" | "underscore"; // Replace spaces in filename
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

/**
 * Detect Obsidian vaults by reading Obsidian's config file
 * Returns array of vault paths found on the system
 */
export function detectObsidianVaults(): string[] {
	try {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		let configPath: string;

		// Platform-specific config locations
		if (process.platform === "darwin") {
			configPath = join(
				home,
				"Library/Application Support/obsidian/obsidian.json",
			);
		} else if (process.platform === "win32") {
			const appData = process.env.APPDATA || join(home, "AppData/Roaming");
			configPath = join(appData, "obsidian/obsidian.json");
		} else {
			// Linux
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

		// Extract vault paths, filter to ones that exist
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

// --- Frontmatter and Filename Generation ---

/**
 * Generate frontmatter for the note
 */
export function generateFrontmatter(tags: string[]): string {
	const now = new Date().toISOString();
	const tagList = tags.map((t) => t.toLowerCase()).join(", ");
	return `---
created: ${now}
source: plannotator
tags: [${tagList}]
---`;
}

/**
 * Extract title from markdown (first H1 heading)
 */
export function extractTitle(markdown: string): string {
	const h1Match = markdown.match(
		/^#\s+(?:Implementation\s+Plan:|Plan:)?\s*(.+)$/im,
	);
	if (h1Match) {
		// Clean up the title for use as filename
		return h1Match[1]
			.trim()
			.replace(/[<>:"/\\|?*(){}\[\]#~`]/g, "") // Remove invalid/problematic filename chars
			.replace(/\s+/g, " ") // Normalize whitespace
			.trim() // Re-trim after stripping
			.slice(0, 50); // Limit length
	}
	return "Plan";
}

/** Default filename format matching original behavior */
export const DEFAULT_FILENAME_FORMAT =
	"{title} - {Mon} {D}, {YYYY} {h}-{mm}{ampm}";

/**
 * Generate filename from a format string with variable substitution.
 *
 * Supported variables:
 *   {title}  - Plan title from first H1 heading
 *   {YYYY}   - 4-digit year
 *   {MM}     - 2-digit month (01-12)
 *   {DD}     - 2-digit day (01-31)
 *   {Mon}    - Abbreviated month name (Jan, Feb, ...)
 *   {D}      - Day without leading zero
 *   {HH}     - 2-digit hour, 24h (00-23)
 *   {h}      - Hour without leading zero, 12h
 *   {hh}     - 2-digit hour, 12h (01-12)
 *   {mm}     - 2-digit minutes (00-59)
 *   {ss}     - 2-digit seconds (00-59)
 *   {ampm}   - am/pm
 *
 * Default format: '{title} - {Mon} {D}, {YYYY} {h}-{mm}{ampm}'
 * Example output: 'User Authentication - Jan 2, 2026 2-30pm.md'
 */
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

	// Sanitize: remove characters invalid in filenames
	let sanitized = result
		.replace(/[<>:"/\\|?*]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	// Apply separator preference (replace spaces with dash or underscore)
	if (separator === "dash") {
		sanitized = sanitized.replace(/ /g, "-");
	} else if (separator === "underscore") {
		sanitized = sanitized.replace(/ /g, "_");
	}

	return sanitized.endsWith(".md") ? sanitized : `${sanitized}.md`;
}

// --- Bear Integration ---

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

// --- Octarine Integration ---

/**
 * Generate YAML frontmatter for an Octarine note.
 * Uses Octarine's property format (list-style tags, Status, Author, Last Edited).
 */
export function generateOctarineFrontmatter(tags: string[]): string {
	const now = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
	const tagLines = tags.map((t) => `  - ${t.toLowerCase()}`).join("\n");
	return `---\ntags:\n${tagLines}\nStatus: Draft\nAuthor: plannotator\nLast Edited: ${now}\n---`;
}
