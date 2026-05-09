import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type SendUserMessageContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];
type SendUserMessageOptions = Parameters<ExtensionAPI["sendUserMessage"]>[1];
type NotificationType = "info" | "warning" | "error";

type CurrentPiSession = {
	token: symbol;
	sendUserMessage: (content: SendUserMessageContent, options?: SendUserMessageOptions) => void;
	notify?: (message: string, type?: NotificationType) => void;
	identity?: PiSessionIdentity;
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

export type PiSessionIdentity = {
	sessionId?: string;
	sessionFile?: string;
	sessionName?: string;
	cwd?: string;
};

const globalStore = globalThis as PlannotatorGlobal;

function getStore(): CurrentPiSessionStore {
	globalStore.__plannotatorCurrentPiSession ??= {};
	return globalStore.__plannotatorCurrentPiSession;
}

function getErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function getPiSessionIdentity(ctx: ExtensionContext): PiSessionIdentity {
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		sessionName: ctx.sessionManager.getSessionName(),
		cwd: ctx.cwd,
	};
}

function isDifferentSession(origin: PiSessionIdentity, current: PiSessionIdentity | undefined): boolean {
	if (!current) return false;
	if (origin.sessionId && current.sessionId) return origin.sessionId !== current.sessionId;
	if (origin.sessionFile && current.sessionFile) return origin.sessionFile !== current.sessionFile;
	return false;
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
		current.identity = getPiSessionIdentity(ctx);
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

export function notifyCurrentPiSession(
	message: string,
	type: NotificationType = "info",
	origin?: PiSessionIdentity,
): boolean {
	const current = getStore().current;
	if (!current?.notify) return false;
	if (origin && !isDifferentSession(origin, current.identity)) return false;
	try {
		current.notify(message, type);
		return true;
	} catch (err) {
		console.error(`Plannotator current-session notification failed: ${getErrorMessage(err)}`);
		return false;
	}
}

export function isCurrentPiSessionDifferentFrom(origin: PiSessionIdentity): boolean {
	return isDifferentSession(origin, getStore().current?.identity);
}

function getCurrentPiSessionLabel(): string {
	const identity = getStore().current?.identity;
	if (!identity) return "unknown";
	return identity.sessionName || identity.sessionFile || identity.sessionId || "current active Pi session";
}

export function withCurrentPiSessionFallbackHeader(content: SendUserMessageContent): SendUserMessageContent {
	if (typeof content !== "string") return content;
	return `This Plannotator feedback was submitted from a browser tab opened before Pi switched sessions. It is being delivered to ${getCurrentPiSessionLabel()} because the original Pi session is no longer active.

${content}`;
}

export function sendUserMessageToCurrentPiSession(
	content: SendUserMessageContent,
	options?: SendUserMessageOptions,
	origin?: PiSessionIdentity,
): { ok: true } | { ok: false; reason: "no-current" | "same-session" | "send-failed"; error: unknown } {
	const current = getStore().current;
	if (!current) {
		return { ok: false, reason: "no-current", error: new Error("No active Pi session is available.") };
	}
	if (origin && !isDifferentSession(origin, current.identity)) {
		return { ok: false, reason: "same-session", error: new Error("No different active Pi session is available.") };
	}
	try {
		current.sendUserMessage(content, options);
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: "send-failed", error: err };
	}
}
