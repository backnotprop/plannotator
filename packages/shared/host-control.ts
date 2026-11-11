/** Host-only session control (`GET /api/host/status`, `POST /api/host/close`). Guarded by a loopback Host header naming this port, no Origin header, and the per-launch bearer token. Status carries counts, never comment text. */

import { isLoopbackHostHeader } from "./loopback-host";

export const HOST_STATUS_PATH = "/api/host/status";
export const HOST_CLOSE_PATH = "/api/host/close";
export const HOST_CONTROL_DISABLED_CODE = "host_control_disabled";

export type HostSessionKind = "plan" | "annotate" | "annotate-last" | "review";

export interface HostSessionStatus {
	kind: HostSessionKind;
	documents: string[];
	unsentAnnotations: number;
	decided: boolean;
}

export type HostCloseOutcome =
	| { closed: true; unsentAnnotations: number }
	| { closed: false; reason: "decided" | "not-closable" };

export interface HostControl {
	status(): HostSessionStatus;
	close?: () => HostCloseOutcome;
}

/** Counts only what the reviewer wrote: entries carrying a `source` (review agents, browser agents, linters) are not theirs. */
export function countUnsentDraftComments(draft: unknown): number {
	if (!draft || typeof draft !== "object") return 0;
	const value = draft as Record<string, unknown>;
	const count = (list: unknown) =>
		Array.isArray(list)
			? list.filter((entry) => {
					if (!entry || typeof entry !== "object") return false;
					const source = (entry as { source?: unknown }).source;
					return typeof source !== "string" || source.length === 0;
				}).length
			: 0;
	return (
		count(value.annotations) +
		count(value.codeAnnotations) +
		count(value.descriptionAnnotations) +
		count(value.commentAnnotations)
	);
}

function tokensEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}

export interface HostControlRequest {
	method: string;
	pathname: string;
	host: string | null;
	origin: string | null;
	authorization: string | null;
}

export interface HostControlAnswer {
	status: number;
	body: unknown;
}

export interface HostControlRoute {
	token: string | undefined;
	getServerPort: () => number | undefined;
	control: HostControl;
}

export function isHostControlPath(pathname: string): boolean {
	return pathname === HOST_STATUS_PATH || pathname === HOST_CLOSE_PATH;
}

/** Guard order: off (404), Host (403), Origin (403), token (401), method (405). */
export function handleHostControlRequest(request: HostControlRequest, route: HostControlRoute): HostControlAnswer | null {
	if (!isHostControlPath(request.pathname)) return null;
	// Off is a coded 404, so a host can tell it from an older Plannotator and not fall back to signalling the process.
	if (!route.token) return { status: 404, body: { error: "Not found", code: HOST_CONTROL_DISABLED_CODE } };
	if (!isLoopbackHostHeader(request.host, route.getServerPort())) {
		return { status: 403, body: { error: "Host control answers only this machine.", code: "host_control_forbidden_host" } };
	}
	if (request.origin) {
		return { status: 403, body: { error: "Browser requests are not accepted here.", code: "host_control_forbidden_origin" } };
	}
	const match = /^Bearer\s+(\S+)$/i.exec((request.authorization ?? "").trim());
	if (!match || !tokensEqual(match[1] as string, route.token)) {
		return { status: 401, body: { error: "Missing or wrong host token.", code: "host_control_unauthorized" } };
	}

	if (request.pathname === HOST_STATUS_PATH) {
		if (request.method !== "GET") return { status: 405, body: { error: "Use GET." } };
		return { status: 200, body: route.control.status() };
	}

	if (request.method !== "POST") return { status: 405, body: { error: "Use POST." } };
	const close = route.control.close;
	if (!close) {
		return { status: 409, body: { error: "This session ends only with the reviewer's decision.", code: "not_closable" } };
	}
	const outcome = close();
	if (!outcome.closed) {
		return outcome.reason === "decided"
			? { status: 409, body: { error: "This session has already been decided.", code: "already_decided" } }
			: { status: 409, body: { error: "This session ends only with the reviewer's decision.", code: "not_closable" } };
	}
	return { status: 200, body: { unsentAnnotations: outcome.unsentAnnotations } };
}

export interface HostSessionClosedEvent {
	type: "session-closed";
	by: "agent" | "session";
	unsentAnnotations: number;
}

export function hostSessionClosedEvent(
	unsentAnnotations: number,
	by: HostSessionClosedEvent["by"] = "agent",
): HostSessionClosedEvent {
	return { type: "session-closed", by, unsentAnnotations };
}

export interface HostHttpAnswer {
	status: number;
	text: string;
}

export type HostCloseAnswer =
	| { kind: "closed"; unsent: number }
	/** The reviewer (or an earlier close) decided first; that decision is on its way. */
	| { kind: "decided" }
	/** A Plannotator without the endpoint answered: a JSON 404 (0.24+) or its app page (0.19.24 to 0.23.x). */
	| { kind: "older" }
	/** A Plannotator WITH the endpoint, turned off (remote mode, launched without a token). */
	| { kind: "disabled" }
	| { kind: "refused"; status: number }
	/** Nothing answered on the port. */
	| { kind: "unreachable" };

function jsonObjectOf(text: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Only a JSON body with a numeric `unsentAnnotations` is a close: an older CLI serves its app page with 200 for any path, which must not read as closed. Only `older` justifies stopping the process. */
export function classifyHostCloseAnswer(answer: HostHttpAnswer | null): HostCloseAnswer {
	if (!answer) return { kind: "unreachable" };
	const ok = answer.status >= 200 && answer.status < 300;
	const body = jsonObjectOf(answer.text);
	if (body) {
		if (ok && typeof body.unsentAnnotations === "number") return { kind: "closed", unsent: body.unsentAnnotations };
		if (answer.status === 409 && body.code === "already_decided") return { kind: "decided" };
		if (answer.status === 404 && body.code === HOST_CONTROL_DISABLED_CODE) return { kind: "disabled" };
		if (answer.status === 404 && typeof body.error === "string") return { kind: "older" };
		return { kind: "refused", status: answer.status };
	}
	if (answer.status === 200 && /<html|<!doctype html/i.test(answer.text)) return { kind: "older" };
	return { kind: "refused", status: answer.status };
}

export function readHostStatusAnswer(answer: HostHttpAnswer | null): { unsent: number; decided: boolean } | null {
	if (!answer || answer.status < 200 || answer.status >= 300) return null;
	const body = jsonObjectOf(answer.text);
	if (!body || typeof body.unsentAnnotations !== "number") return null;
	return { unsent: body.unsentAnnotations, decided: body.decided === true };
}
