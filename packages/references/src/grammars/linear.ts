// Source: apps/rooms/src/external-refs/linear.ts (match, parseCanonical) merged with apps/web/src/components/external-refs/match.ts (matchLinear) (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// The server grammar is kept byte for byte; the client copy accepted the same URLs with the same canonicals, so it is retired, not merged in.
//
// HOSTS: fixed to linear.app and www.linear.app. Linear is SaaS only, so no
// `hosts` option is planned here.

import type { ExternalRef } from "../contract.ts";

/** The workspace URL-key (FIRST path segment: it is the workspace, not a team). */
const WORKSPACE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;
/** Issue identifiers: TEAM-123. */
const ISSUE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-[0-9]{1,9}$/;
/** Project/initiative slugIds: the trailing token after the last hyphen. */
const PROJECT_SLUG_ID = /-([a-zA-Z0-9]{6,})$/;
/** Document hex slugIds: the trailing hex token after the last hyphen. */
const DOCUMENT_SLUG_ID = /-([0-9a-f]{8,})$/;

/** First segments that are app chrome, never a workspace. */
const RESERVED_WORKSPACES = new Set(["oauth", "settings", "developers", "docs", "integrations"]);

/**
 * Recognize the three entity grammars (issues, projects, documents).
 * THE SLUG TRAP: the human-readable leading slug rewrites when a title
 * changes; only the stable tail is identity. Keys carry the workspace so
 * two workspaces' ENG-123 can never share a cache entry.
 */
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

	// linear.app/{workspace}/issue/{TEAM}-{n}[/{title-slug}]
	if (form === "issue" && ISSUE_IDENTIFIER.test(entity)) {
		const identifier = entity.toUpperCase();
		return {
			provider: "linear",
			key: `${ws}/${identifier}`,
			url: `https://linear.app/${ws}/issue/${identifier}`,
		};
	}

	// linear.app/{workspace}/project/{title-slug}-{slugId}[/tab]
	if (form === "project") {
		const slugId = PROJECT_SLUG_ID.exec(entity)?.[1];
		if (slugId === undefined) return null;
		return {
			provider: "linear",
			key: `${ws}/project/${slugId}`,
			// Keep the full slug segment: it is the URL Linear itself serves.
			url: `https://linear.app/${ws}/project/${entity}`,
		};
	}

	// linear.app/{workspace}/document/{title-slug}-{hexSlugId}
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

/** A Linear item as the resolve reads it. */
export type LinearItem =
	| { form: "issue"; identifier: string }
	| { form: "project"; slugId: string }
	| { form: "document"; slugId: string };

/** Re-parse the grammar's OWN canonical URL at resolve time. */
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
