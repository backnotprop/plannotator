import type { ExternalRefFailure, ReferenceListOrder, ReferenceListQuery } from "./contract.ts";
import type { FetchLike } from "./port.ts";

export const LIST_PAGE_SIZE = 100;

const MAX_LABELS = 20;
const MAX_FILTER = 255;
const CURSOR = /^[A-Za-z0-9+/=_:.-]{1,512}$/;

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

export function hasEveryLabel(have: readonly string[], want: readonly string[]): boolean {
	const lower = new Set(have.map((label) => label.toLowerCase()));
	return want.every((label) => lower.has(label.toLowerCase()));
}

export function labelsComplete(connection: unknown): boolean {
	return objectAt(connection, "pageInfo")?.["hasNextPage"] !== true;
}

export interface ListRow {
	readonly open: boolean;
	readonly labels: readonly string[];
	readonly labelsComplete: boolean;
	readonly milestone: string | undefined;
}

export function keepsRow(query: CheckedListQuery, row: ListRow): boolean {
	if (query.state === "open" && !row.open) return false;
	if (query.state === "closed" && row.open) return false;
	if (row.labelsComplete && !hasEveryLabel(row.labels, query.labels)) return false;
	if (query.milestone !== undefined && row.milestone?.toLowerCase() !== query.milestone.toLowerCase()) {
		return false;
	}
	return true;
}

export type GraphqlPost =
	| { readonly ok: true; readonly data: Record<string, unknown> | null; readonly errors: readonly unknown[] }
	| { readonly ok: false; readonly status: number | null };

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

export function asObject(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function objectAt(value: unknown, key: string): Record<string, unknown> | null {
	return asObject(asObject(value)?.[key]);
}

export function connectionNodes(connection: unknown): Record<string, unknown>[] {
	const nodes = asObject(connection)?.["nodes"];
	if (!Array.isArray(nodes)) return [];
	return nodes.map(asObject).filter((node): node is Record<string, unknown> => node !== null);
}

export function connectionNames(connection: unknown, key: string): string[] {
	const names: string[] = [];
	for (const node of connectionNodes(connection)) {
		const name = node[key];
		if (typeof name === "string" && name.length > 0) names.push(name);
	}
	return names;
}

export function nextCursor(pageInfo: unknown, direction: "forward" | "backward" = "forward"): string | undefined {
	const info = asObject(pageInfo);
	if (info === null) return undefined;
	const more = direction === "forward" ? info["hasNextPage"] : info["hasPreviousPage"];
	const cursor = direction === "forward" ? info["endCursor"] : info["startCursor"];
	return more === true && typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}
