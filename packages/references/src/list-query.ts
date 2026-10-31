// Source: new in Plannotator after placement, not cut from Workspaces: the `list(query)` read PROVENANCE.md planned against the extract of Workspaces main 7379b0195de140adc00b4496eefe553a3eec803e.
// What the three adapters' `list` share: the query checks, the label rule, and one GraphQL POST.
//
// A list query is checked before any credential is asked: a bad cursor or
// an empty or oversized filter is a `field` answer with no provider call.
// Labels mean "every label" on all three providers. GitHub and GitLab rows
// are re-checked after the read (`keepsRow`: state, labels, milestone), so
// a looser provider filter never widens the answer; the cursor stays the
// provider's, and a page can hold fewer rows than LIST_PAGE_SIZE, even none,
// and still carry a cursor.

import type { ExternalRefFailure, ReferenceListOrder, ReferenceListQuery } from "./contract.ts";
import type { FetchLike } from "./port.ts";

/** One page of a list: the most a single provider call answers. */
export const LIST_PAGE_SIZE = 100;

/** Labels per query: more than a picker sends, and a bound on the size of
 * one provider query (each label is a filter or a search qualifier). */
const MAX_LABELS = 20;
/** Characters per filter value or text: a bound on one value, long enough
 * for any real label, login, milestone title or search phrase. */
const MAX_FILTER = 255;
/** Opaque provider cursors (base64, Relay ids): bounded and plain. */
const CURSOR = /^[A-Za-z0-9+/=_:.-]{1,512}$/;

/** A checked list query: trimmed values, defaults applied. */
export interface CheckedListQuery {
	readonly scope: string | undefined;
	readonly host: string | undefined;
	readonly state: "open" | "closed" | "all";
	readonly labels: readonly string[];
	readonly assignee: string | undefined;
	readonly milestone: string | undefined;
	readonly text: string | undefined;
	readonly cursor: string | undefined;
	readonly order: ReferenceListOrder;
}

function filterValue(value: string | undefined): string | undefined | null {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 || trimmed.length > MAX_FILTER ? null : trimmed;
}

/** The query with defaults, or the `field` answer for an input to fix. */
export function checkListQuery(
	query: ReferenceListQuery,
): { ok: true; query: CheckedListQuery } | ExternalRefFailure {
	if (query.cursor !== undefined && !CURSOR.test(query.cursor)) {
		return { ok: false, reason: "not_resolvable", field: "cursor" };
	}
	const labels: string[] = [];
	for (const raw of query.labels ?? []) {
		const label = filterValue(raw);
		if (label === null || label === undefined) {
			return { ok: false, reason: "not_resolvable", field: "filter" };
		}
		labels.push(label);
	}
	const assignee = filterValue(query.assignee);
	const milestone = filterValue(query.milestone);
	const text = query.text === undefined || query.text.trim() === "" ? undefined : filterValue(query.text);
	if (labels.length > MAX_LABELS || assignee === null || milestone === null || text === null) {
		return { ok: false, reason: "not_resolvable", field: "filter" };
	}
	return {
		ok: true,
		query: {
			scope: query.scope?.trim(),
			host: query.host,
			state: query.state ?? "open",
			labels,
			assignee,
			milestone,
			text,
			cursor: query.cursor,
			order: query.order ?? "updated_desc",
		},
	};
}

/** True when `have` carries every label in `want` (case-insensitive). */
export function hasEveryLabel(have: readonly string[], want: readonly string[]): boolean {
	const lower = new Set(have.map((label) => label.toLowerCase()));
	return want.every((label) => lower.has(label.toLowerCase()));
}

/** False when a row's labels connection says it has more labels than were
 * read (`pageInfo.hasNextPage`). */
export function labelsComplete(connection: unknown): boolean {
	return objectAt(connection, "pageInfo")?.["hasNextPage"] !== true;
}

/** What the re-check reads from one row. */
export interface ListRow {
	readonly open: boolean;
	readonly labels: readonly string[];
	/** False when the row's labels were not all read. */
	readonly labelsComplete: boolean;
	readonly milestone: string | undefined;
}

/** The re-check every forge row passes after the read, so a provider
 * filter that is looser than the query (GitHub's filterBy.labels, a GitLab
 * milestone wildcard such as `Any` or `Started`) never widens the answer:
 * the state, every label (case-insensitive) and the milestone title
 * (case-insensitive). A row whose labels were not all read is never
 * dropped for a label: the provider filtered it, and the missing labels
 * may hold the one asked for. */
export function keepsRow(query: CheckedListQuery, row: ListRow): boolean {
	if (query.state === "open" && !row.open) return false;
	if (query.state === "closed" && row.open) return false;
	if (row.labelsComplete && !hasEveryLabel(row.labels, query.labels)) return false;
	if (query.milestone !== undefined && row.milestone?.toLowerCase() !== query.milestone.toLowerCase()) {
		return false;
	}
	return true;
}

/** A GraphQL answer, before the provider-specific reading. */
export type GraphqlPost =
	| { readonly ok: true; readonly data: Record<string, unknown> | null; readonly errors: readonly unknown[] }
	| { readonly ok: false; readonly status: number | null };

/** POST one GraphQL query. A throw is `status: null`; a non-200 is its
 * status; a 200 answers its `data` and `errors`. Never throws. */
export async function postGraphql(
	fetcher: FetchLike,
	url: string,
	headers: Record<string, string>,
	query: string,
	variables: Record<string, unknown>,
): Promise<GraphqlPost> {
	let response: Response;
	try {
		response = await fetcher(url, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ query, variables }),
		});
	} catch {
		return { ok: false, status: null };
	}
	if (response.status !== 200) return { ok: false, status: response.status };
	const body = (await response.json().catch(() => null)) as {
		data?: unknown;
		errors?: unknown;
	} | null;
	if (body === null || typeof body !== "object") return { ok: false, status: null };
	const data =
		body.data !== null && typeof body.data === "object" ? (body.data as Record<string, unknown>) : null;
	return { ok: true, data, errors: Array.isArray(body.errors) ? body.errors : [] };
}

/** A plain object, or null. */
export function asObject(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** A plain object field, or null. */
export function objectAt(value: unknown, key: string): Record<string, unknown> | null {
	return asObject(asObject(value)?.[key]);
}

/** The nodes of a `{ nodes: [...] }` connection that are objects. */
export function connectionNodes(connection: unknown): Record<string, unknown>[] {
	const nodes = asObject(connection)?.["nodes"];
	if (!Array.isArray(nodes)) return [];
	return nodes.map(asObject).filter((node): node is Record<string, unknown> => node !== null);
}

/** The non-empty strings at `key` of each node of a connection. */
export function connectionNames(connection: unknown, key: string): string[] {
	const names: string[] = [];
	for (const node of connectionNodes(connection)) {
		const name = node[key];
		if (typeof name === "string" && name.length > 0) names.push(name);
	}
	return names;
}

/** `pageInfo` of a connection: the next cursor, if another page exists.
 * `backward` reads a `last`/`before` page (the cursor is its start). */
export function nextCursor(pageInfo: unknown, direction: "forward" | "backward" = "forward"): string | undefined {
	const info = asObject(pageInfo);
	if (info === null) return undefined;
	const more = direction === "forward" ? info["hasNextPage"] : info["hasPreviousPage"];
	const cursor = direction === "forward" ? info["endCursor"] : info["startCursor"];
	return more === true && typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}
