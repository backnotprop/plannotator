/**
 * Save to Notion: a plan becomes a child page of a page the user picks.
 *
 * The server holds the token (NOTION_TOKEN in its environment); the browser
 * never sends or receives it. Bun (packages/server) and Pi (vendored into
 * apps/pi-extension/generated) both call this one copy.
 */

import {
	stripH1,
	type IntegrationResult,
	type NotionConfig,
} from "./integrations-common";

export const NOTION_API_VERSION = "2026-03-11";
const NOTION_PAGES_URL = "https://api.notion.com/v1/pages";
/** Plan approve waits for this save, so a stalled network must not hold it. */
const NOTION_TIMEOUT_MS = 15_000;

function notionToken(): string | undefined {
	return process.env.NOTION_TOKEN?.trim() || undefined;
}

/**
 * Notion is offered when NOTION_TOKEN is set and the session is only on this
 * computer. A remote or `--tailscale` session (`exposed`) never gets it: the
 * token would act for whoever opens the page.
 */
export function isNotionAvailable(exposed: boolean): boolean {
	return !exposed && notionToken() !== undefined;
}

/** The page title: the plan's H1 as written, without a "Plan:" prefix (Notion caps text at 2000). */
export function notionPageTitle(plan: string): string {
	const h1 = plan.match(/^#\s+(?:Implementation\s+Plan:|Plan:)?\s*(.+)$/im)?.[1]?.trim();
	return h1 ? h1.slice(0, 2000) : "Plan";
}

/** Create a child page under `parentPageId` with the plan as Markdown. */
export async function saveToNotion(config: NotionConfig): Promise<IntegrationResult> {
	const token = notionToken();
	if (!token) {
		return { success: false, error: "Notion is not configured. Set NOTION_TOKEN." };
	}
	const parentPageId = typeof config.parentPageId === "string" ? config.parentPageId.trim() : "";
	if (!parentPageId) {
		return { success: false, error: "Notion parent page is required." };
	}

	try {
		const response = await fetch(NOTION_PAGES_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"Notion-Version": NOTION_API_VERSION,
			},
			body: JSON.stringify({
				parent: { page_id: parentPageId },
				properties: {
					title: { title: [{ text: { content: notionPageTitle(config.plan) } }] },
				},
				// The H1 is the page title above; keep it out of the body.
				markdown: stripH1(config.plan),
			}),
			signal: AbortSignal.timeout(NOTION_TIMEOUT_MS),
		});

		const data = (await response.json().catch(() => null)) as { message?: unknown; url?: unknown } | null;
		if (!response.ok) {
			const detail = typeof data?.message === "string" ? ` ${data.message}` : "";
			if (response.status === 401) return { success: false, error: `Notion token is invalid or revoked.${detail}` };
			if (response.status === 403 || response.status === 404) {
				return { success: false, error: `Notion cannot reach this page. Share it with your Notion integration.${detail}` };
			}
			if (response.status === 429) return { success: false, error: `Notion rate limit exceeded.${detail}` };
			return { success: false, error: `Notion save failed (${response.status}).${detail}` };
		}
		return { success: true, ...(typeof data?.url === "string" ? { url: data.url } : {}) };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? `Notion save failed: ${err.message}` : "Notion save failed.",
		};
	}
}
