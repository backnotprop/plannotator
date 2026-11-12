import type { ExternalRef } from "../contract.ts";

const WORKSPACE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;
const ISSUE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-[0-9]{1,9}$/;
const PROJECT_SLUG_ID = /-([a-zA-Z0-9]{6,})$/;
const DOCUMENT_SLUG_ID = /-([0-9a-f]{8,})$/;

const RESERVED_WORKSPACES = new Set(["oauth", "settings", "developers", "docs", "integrations"]);

export function matchLinearUrl(url: URL): ExternalRef | null {
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	const host = url.hostname.toLowerCase();
	if (host !== "linear.app" && host !== "www.linear.app") return null;
	if (url.port !== "") return null;
	const segments = url.pathname.split("/").filter((s) => s.length > 0);
	if (segments.length < 3) return null;
	const [workspace, form, entity] = segments;
	if (workspace === undefined || form === undefined || entity === undefined) return null;
	if (!WORKSPACE_SEGMENT.test(workspace) || RESERVED_WORKSPACES.has(workspace.toLowerCase())) {
		return null;
	}
	const ws = workspace.toLowerCase();

	if (form === "issue" && ISSUE_IDENTIFIER.test(entity)) {
		const identifier = entity.toUpperCase();
		return {
			provider: "linear",
			key: `${ws}/${identifier}`,
			url: `https://linear.app/${ws}/issue/${identifier}`,
		};
	}

	if (form === "project") {
		const slugId = PROJECT_SLUG_ID.exec(entity)?.[1];
		if (slugId === undefined) return null;
		return {
			provider: "linear",
			key: `${ws}/project/${slugId}`,
			url: `https://linear.app/${ws}/project/${entity}`,
		};
	}

	if (form === "document") {
		const slugId = DOCUMENT_SLUG_ID.exec(entity)?.[1];
		if (slugId === undefined) return null;
		return {
			provider: "linear",
			key: `${ws}/document/${slugId}`,
			url: `https://linear.app/${ws}/document/${entity}`,
		};
	}

	return null;
}

export type LinearItem =
	| { form: "issue"; identifier: string }
	| { form: "project"; slugId: string }
	| { form: "document"; slugId: string };

export function parseLinearCanonical(
	ref: ExternalRef,
): { workspace: string; item: LinearItem } | null {
	let url: URL;
	try {
		url = new URL(ref.url);
	} catch {
		return null;
	}
	const segments = url.pathname.split("/").filter((s) => s.length > 0);
	const [workspace, form, entity] = segments;
	if (workspace === undefined || form === undefined || entity === undefined) return null;
	const ws = workspace.toLowerCase();
	if (form === "issue") return { workspace: ws, item: { form, identifier: entity } };
	if (form === "project") {
		const slugId = PROJECT_SLUG_ID.exec(entity)?.[1];
		return slugId === undefined ? null : { workspace: ws, item: { form, slugId } };
	}
	if (form === "document") {
		const slugId = DOCUMENT_SLUG_ID.exec(entity)?.[1];
		return slugId === undefined ? null : { workspace: ws, item: { form, slugId } };
	}
	return null;
}
