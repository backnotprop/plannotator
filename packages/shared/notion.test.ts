import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isNotionAvailable, NOTION_API_VERSION, notionPageTitle, saveToNotion } from "./notion";

// Never reaches the real Notion API: fetch is stubbed in every test.
const originalToken = process.env.NOTION_TOKEN;
const originalFetch = globalThis.fetch;
let requests: Request[] = [];
let reply: () => Response = () => Response.json({ url: "https://www.notion.so/test-page" });

beforeEach(() => {
	requests = [];
	reply = () => Response.json({ url: "https://www.notion.so/test-page" });
	process.env.NOTION_TOKEN = "secret-token";
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		requests.push(new Request(input, init));
		return reply();
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalToken === undefined) delete process.env.NOTION_TOKEN;
	else process.env.NOTION_TOKEN = originalToken;
});

describe("isNotionAvailable", () => {
	test("is on only with a token and a session on this computer", () => {
		expect(isNotionAvailable(false)).toBe(true);
		expect(isNotionAvailable(true)).toBe(false);
		process.env.NOTION_TOKEN = "  ";
		expect(isNotionAvailable(false)).toBe(false);
		delete process.env.NOTION_TOKEN;
		expect(isNotionAvailable(false)).toBe(false);
	});
});

describe("saveToNotion", () => {
	test("requires a token without making a request", async () => {
		delete process.env.NOTION_TOKEN;
		const result = await saveToNotion({ plan: "# Test Plan", parentPageId: "page-id" });
		expect(result).toEqual({ success: false, error: "Notion is not configured. Set NOTION_TOKEN." });
		expect(requests).toHaveLength(0);
	});

	test("creates a child page titled by the H1, with the rest as markdown", async () => {
		const result = await saveToNotion({
			plan: "# Implementation Plan: Test Export\n\nContent",
			parentPageId: "parent-page-id",
		});

		expect(result).toEqual({ success: true, url: "https://www.notion.so/test-page" });
		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request.method).toBe("POST");
		expect(request.url).toBe("https://api.notion.com/v1/pages");
		expect(request.headers.get("Authorization")).toBe("Bearer secret-token");
		expect(request.headers.get("Notion-Version")).toBe(NOTION_API_VERSION);
		expect(await request.json()).toEqual({
			parent: { page_id: "parent-page-id" },
			properties: { title: { title: [{ text: { content: "Test Export" } }] } },
			markdown: "Content",
		});
	});

	test("explains a page the integration cannot reach, without the token", async () => {
		reply = () => Response.json({ message: "Could not find page" }, { status: 404 });
		const result = await saveToNotion({ plan: "# Test Plan", parentPageId: "page-id" });
		expect(result.success).toBe(false);
		expect(result.error).toContain("Share it with your Notion integration");
		expect(result.error).not.toContain("secret-token");
	});

	test("gives up on a stalled request instead of holding plan approve", async () => {
		globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("The operation timed out.")));
			})) as unknown as typeof fetch;
		const originalTimeout = AbortSignal.timeout;
		AbortSignal.timeout = () => originalTimeout.call(AbortSignal, 10);
		try {
			const result = await saveToNotion({ plan: "# Test Plan", parentPageId: "page-id" });
			expect(result.success).toBe(false);
			expect(result.error).toContain("Notion save failed");
		} finally {
			AbortSignal.timeout = originalTimeout;
		}
	});
});

describe("notionPageTitle", () => {
	test("keeps the H1 as written, without the Plan prefix", () => {
		expect(notionPageTitle("# Implementation Plan: Add `foo()` support: phase 1 / API\n\nBody")).toBe(
			"Add `foo()` support: phase 1 / API",
		);
		expect(notionPageTitle("No heading here")).toBe("Plan");
	});
});
