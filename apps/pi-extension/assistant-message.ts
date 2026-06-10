import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type AssistantTextBlock = { type?: string; text?: string };

type AssistantMessageLike = {
	role?: unknown;
	content?: unknown;
};

type SessionEntryLike = {
	id: string;
	type: string;
	timestamp?: unknown;
	message?: AssistantMessageLike;
};

export type LastAssistantMessageSnapshot = {
	entryId: string;
	text: string;
};

export type RecentAssistantMessage = {
	messageId: string;
	text: string;
	timestamp?: string;
};

// Pi's SDK currently types `SessionEntryBase.timestamp` as `string`, but the
// picker contract everywhere else is ISO and we don't want a silent drift if
// that ever changes. Accept string/number(ms)/Date; drop anything else.
function normalizeTimestamp(value: unknown): string | undefined {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
	}
	if (typeof value === "string" && value.trim()) {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
	}
	return undefined;
}

function isAssistantMessage(message: AssistantMessageLike): message is { role: "assistant"; content: AssistantTextBlock[] } {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: { content: AssistantTextBlock[] }): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function getAssistantMessageText(message: unknown): string | null {
	if (!isRecord(message)) return null;
	const candidate = { role: message.role, content: message.content };
	if (!isAssistantMessage(candidate)) return null;
	const text = getTextContent(candidate);
	return text.trim() ? text : null;
}

function getCurrentBranch(ctx: ExtensionContext): SessionEntryLike[] {
	return ctx.sessionManager.getBranch() as SessionEntryLike[];
}

export function getLastAssistantMessageSnapshot(ctx: ExtensionContext): LastAssistantMessageSnapshot | null {
	// "Last" means the active conversation branch, not the newest message anywhere
	// in the append-only session file.
	const branch = getCurrentBranch(ctx);
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message) {
			const text = getAssistantMessageText(entry.message);
			if (text) return { entryId: entry.id, text };
		}
	}
	return null;
}

export function getLastAssistantMessageText(ctx: ExtensionContext): string | null {
	return getLastAssistantMessageSnapshot(ctx)?.text ?? null;
}

export function findAssistantMessageByEntryId(
	ctx: ExtensionContext,
	entryId: string,
): LastAssistantMessageSnapshot | null {
	const branch = getCurrentBranch(ctx);
	for (const entry of branch) {
		if (entry.id !== entryId || entry.type !== "message" || !entry.message) continue;
		const text = getAssistantMessageText(entry.message);
		if (text) return { entryId: entry.id, text };
	}
	return null;
}

export function getRecentAssistantMessages(
	ctx: ExtensionContext,
	limit: number,
): RecentAssistantMessage[] {
	const branch = getCurrentBranch(ctx);
	const out: RecentAssistantMessage[] = [];
	for (let i = branch.length - 1; i >= 0 && out.length < limit; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || !entry.message) continue;
		const text = getAssistantMessageText(entry.message);
		if (!text) continue;
		out.push({ messageId: entry.id, text, timestamp: normalizeTimestamp(entry.timestamp) });
	}
	return out;
}

export function hasSessionMovedPastEntry(ctx: ExtensionContext, entryId: string): boolean {
	if (!ctx.isIdle()) return true;

	const branch = getCurrentBranch(ctx);
	const index = branch.findIndex((entry) => entry.id === entryId);
	if (index === -1) return true;

	return branch.slice(index + 1).some((entry) => entry.type === "message");
}
