import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type SendUserMessageContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];
type SendUserMessageOptions = Parameters<ExtensionAPI["sendUserMessage"]>[1];
type NotificationType = "info" | "warning" | "error";

type CurrentPiSession = {
	token: symbol;
	sendUserMessage: (content: SendUserMessageContent, options?: SendUserMessageOptions) => void;
	notify?: (message: string, type?: NotificationType) => void;
	sessionId?: string;
	sessionFile?: string;
	sessionName?: string;
	cwd?: string;
};

type CurrentPiSessionStore = {
	current?: CurrentPiSession;
};

type PlannotatorGlobal = typeof globalThis & {
	__plannotatorCurrentPiSession?: CurrentPiSessionStore;
};

export type CurrentPiSessionRegistration = {
	token: symbol;
	update: (ctx: ExtensionContext) => void;
	clear: () => void;
};

const globalStore = globalThis as PlannotatorGlobal;

function getStore(): CurrentPiSessionStore {
	globalStore.__plannotatorCurrentPiSession ??= {};
	return globalStore.__plannotatorCurrentPiSession;
}

function getErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function isStalePiContextError(err: unknown): boolean {
	return getErrorMessage(err).includes("This extension ctx is stale after session replacement or reload");
}

function setCurrentPiSession(token: symbol, pi: ExtensionAPI, ctx?: ExtensionContext): void {
	const current: CurrentPiSession = {
		token,
		sendUserMessage: (content, options) => {
			pi.sendUserMessage(content, options);
		},
	};
	if (ctx) {
		current.notify = (message, type = "info") => {
			ctx.ui.notify(message, type);
		};
		current.sessionId = ctx.sessionManager.getSessionId();
		current.sessionFile = ctx.sessionManager.getSessionFile();
		current.sessionName = ctx.sessionManager.getSessionName();
		current.cwd = ctx.cwd;
	}
	getStore().current = current;
}

export function registerCurrentPiSession(pi: ExtensionAPI): CurrentPiSessionRegistration {
	const token = Symbol("plannotator-current-pi-session");
	setCurrentPiSession(token, pi);
	return {
		token,
		update: (ctx) => {
			setCurrentPiSession(token, pi, ctx);
		},
		clear: () => {
			const store = getStore();
			if (store.current?.token === token) {
				store.current = undefined;
			}
		},
	};
}

export function notifyCurrentPiSession(message: string, type: NotificationType = "info"): boolean {
	const current = getStore().current;
	if (!current?.notify) return false;
	try {
		current.notify(message, type);
		return true;
	} catch (err) {
		console.error(`Plannotator current-session notification failed: ${getErrorMessage(err)}`);
		return false;
	}
}

function getCurrentPiSessionLabel(): string {
	const current = getStore().current;
	if (!current) return "unknown";
	return current.sessionName || current.sessionFile || current.sessionId || "current active Pi session";
}

export function withCurrentPiSessionFallbackHeader(content: SendUserMessageContent): SendUserMessageContent {
	if (typeof content !== "string") return content;
	return `This Plannotator feedback was submitted from a browser tab opened before Pi switched sessions. It is being delivered to ${getCurrentPiSessionLabel()} because the original Pi session is no longer active.

${content}`;
}

export function sendUserMessageToCurrentPiSession(
	content: SendUserMessageContent,
	options?: SendUserMessageOptions,
): { ok: true } | { ok: false; error: unknown } {
	const current = getStore().current;
	if (!current) {
		return { ok: false, error: new Error("No active Pi session is available.") };
	}
	try {
		current.sendUserMessage(content, options);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err };
	}
}
