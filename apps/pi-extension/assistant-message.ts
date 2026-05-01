import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

type AssistantTextBlock = { type?: string; text?: string };

type AssistantMessageLike = {
	role?: unknown;
	content?: unknown;
};

type SessionEntryLike = {
	id: string;
	type: string;
	message?: AssistantMessageLike;
};

export type LastAssistantMessageSnapshot = {
	entryId: string;
	text: string;
};

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

export function hasSessionMovedPastEntry(ctx: ExtensionContext, entryId: string): boolean {
	if (!ctx.isIdle()) return true;

	const branch = getCurrentBranch(ctx);
	const index = branch.findIndex((entry) => entry.id === entryId);
	if (index === -1) return true;

	return branch.slice(index + 1).some((entry) => entry.type === "message");
}
