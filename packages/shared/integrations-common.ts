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

export interface RoamConfig {
	graphName: string;
	graphType: "hosted" | "offline";
	token: string;
	port: number;
	plan: string;
	titleFormat?: string;
	titleSeparator?: "space" | "dash" | "underscore";
	saveLocation?: "page" | "daily-note";
	dailyNoteParent?: string;
}

export interface IntegrationResult {
	success: boolean;
	error?: string;
	path?: string;
}

export const ROAM_API_VERSION = "1.1.2";
export const DEFAULT_ROAM_PARENT_BLOCK = "[[Plannotator Plans]]";

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

export function stripFrontmatter(markdown: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) {
		return { frontmatter: {}, body: markdown };
	}

	const frontmatter: Record<string, unknown> = {};
	const lines = match[1].split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const keyValueMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
		if (!keyValueMatch) {
			continue;
		}

		const key = keyValueMatch[1];
		const inlineValue = keyValueMatch[2] ?? "";
		if (inlineValue) {
			frontmatter[key] = parseFrontmatterScalar(inlineValue);
			continue;
		}

		const arrayValues: string[] = [];
		let j = i + 1;
		while (j < lines.length) {
			const listMatch = lines[j].match(/^\s*-\s+(.*)$/);
			if (!listMatch) {
				break;
			}
			arrayValues.push(listMatch[1]);
			j++;
		}

		if (arrayValues.length > 0) {
			frontmatter[key] = arrayValues.map(parseFrontmatterScalar);
			i = j - 1;
			continue;
		}

		frontmatter[key] = "";
	}

	return {
		frontmatter,
		body: markdown.slice(match[0].length).replace(/^(?:\r?\n)+/, ""),
	};
}

function parseFrontmatterScalar(
	value: string,
): string | boolean | number | string[] {
	const trimmed = value.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
	if (/^\[(.*)\]$/.test(trimmed)) {
		const content = trimmed.slice(1, -1).trim();
		if (!content) return [];
		return content
			.split(",")
			.map((item) => item.trim().replace(/^["']|["']$/g, ""))
			.filter((item) => item.length > 0);
	}
	return trimmed;
}

export function frontmatterToAttributeBlocks(
	frontmatter: Record<string, unknown>,
): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(frontmatter)) {
		if (value == null || value === "") continue;
		if (key === "created" && typeof value === "string") {
			lines.push(`created:: ${formatRoamCreatedValue(value)}`);
			continue;
		}
		if (key === "tags") {
			lines.push(`tags:: ${formatRoamTagsValue(value)}`);
			continue;
		}
		lines.push(`${key}:: ${formatRoamAttributeValue(value)}`);
	}

	return lines.join("\n");
}

function formatRoamAttributeValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => formatRoamAttributeValue(item)).join(", ");
	}
	return JSON.stringify(value);
}

export function stripRoamMetadataTags(markdown: string): string {
	return markdown
		.replace(/<roam\b[^>]*\/>/gi, "")
		.replace(/<roam\b[^>]*>([\s\S]*?)<\/roam>/gi, "$1");
}

export function majorMinorMatches(a: string, b: string): boolean {
	const parsedA = parseMajorMinorVersion(a);
	const parsedB = parseMajorMinorVersion(b);
	if (!parsedA || !parsedB) {
		return false;
	}

	return parsedA.major === parsedB.major && parsedA.minor === parsedB.minor;
}

function parseMajorMinorVersion(version: string): { major: number; minor: number } | null {
	const match = version.trim().match(/^(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/);
	if (!match) {
		return null;
	}

	return {
		major: Number(match[1]),
		minor: Number(match[2]),
	};
}

export function generatePageTitle(
	markdown: string,
	format?: string,
	separator?: "space" | "dash" | "underscore",
): string {
	return generateFilename(markdown, format, separator).replace(/\.md$/, "");
}

export function formatRoamDailyNotePage(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const year = String(date.getFullYear());
	return `${month}-${day}-${year}`;
}

export function normalizeRoamDailyNoteParent(value?: string | null): string {
	const trimmed = value?.trim();
	return trimmed ? trimmed : DEFAULT_ROAM_PARENT_BLOCK;
}

export interface RoamSuggestionPage {
	uid: string;
	title: string;
	sortAt: string;
}

export interface RoamEditedPage {
	uid: string;
	title: string;
	editedAt?: string;
}

export interface RoamOpenedPage {
	uid?: string;
	title: string;
	type?: string;
	openedAt?: string;
}

export interface RoamSuggestionsResult {
	recentlyEditedPages?: RoamEditedPage[];
	recentlyOpenedByUser?: RoamOpenedPage[];
}

export function normalizeRoamSuggestionsToPages(
	result: RoamSuggestionsResult,
): RoamSuggestionPage[] {
	const pages = new Map<string, RoamSuggestionPage>();
	for (const page of result.recentlyEditedPages ?? []) {
		if (!page.uid || !page.title) continue;
		pages.set(page.uid, {
			uid: page.uid,
			title: page.title,
			sortAt: page.editedAt ?? "",
		});
	}

	for (const page of result.recentlyOpenedByUser ?? []) {
		if ((page.type && page.type !== "page") || !page.uid || !page.title) continue;
		const existing = pages.get(page.uid);
		if (!existing) {
			pages.set(page.uid, {
				uid: page.uid,
				title: page.title,
				sortAt: page.openedAt ?? "",
			});
			continue;
		}

		pages.set(page.uid, {
			...existing,
			sortAt: getMoreRecentSortAt(existing.sortAt, page.openedAt ?? ""),
		});
	}

	return Array.from(pages.values()).sort((a, b) =>
		b.sortAt.localeCompare(a.sortAt),
	);
}

function formatRoamCreatedValue(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	const month = date.toLocaleString("en-US", { month: "long" });
	const day = date.getDate();
	return `[[${month} ${day}${getOrdinalSuffix(day)}, ${date.getFullYear()}]]`;
}

function formatRoamTagsValue(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map((tag) => `[[${String(tag)}]]`).join(", ");
	}
	return `[[${String(value)}]]`;
}

function getOrdinalSuffix(day: number): string {
	if (day % 10 === 1 && day % 100 !== 11) return "st";
	if (day % 10 === 2 && day % 100 !== 12) return "nd";
	if (day % 10 === 3 && day % 100 !== 13) return "rd";
	return "th";
}

function getMoreRecentSortAt(a: string, b: string): string {
	return a.localeCompare(b) >= 0 ? a : b;
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
