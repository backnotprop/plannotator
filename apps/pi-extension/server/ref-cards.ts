/**
 * node:http adapter for `GET /api/ref`: the hover cards for issue, PR and MR
 * links on the plan, annotate and review servers (packages/shared/ref-cards.ts,
 * vendored to generated/ref-cards.ts). Mirrors `refCardRouteResponse` in
 * packages/server/ref-cards.ts; the CLIs run through the Node runner
 * (generated/ref-cards-node.ts) with the Bun runner's time limit and cache.
 *
 * Off in remote mode: anyone who reaches the URL could otherwise make this
 * computer run the user's gh / glab. Pi has no `--tailscale`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createRefCards, handleRefCardRoute, REF_CARD_ROUTE, type RefCards, type RefRunner } from "../generated/ref-cards.ts";
import { nodeRefCliRunner } from "../generated/ref-cards-node.ts";
import { isRemoteSession } from "./network.ts";

export type { RefRunner } from "../generated/ref-cards.ts";

/** One cache per server; `run` is for tests (default: the real gh / glab through Node). */
export function createPiRefCards(run?: RefRunner): RefCards {
	return createRefCards({ run: run ?? nodeRefCliRunner });
}

/** Answers `/api/ref` and returns true, or returns false for any other path. */
export async function handleRefCards(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	cards: RefCards,
	serverSession: string,
): Promise<boolean> {
	if (url.pathname !== REF_CARD_ROUTE) return false;
	const header = (name: string): string | null => {
		const value = req.headers[name];
		return typeof value === "string" ? value : null;
	};
	const answer = await handleRefCardRoute(
		{
			method: req.method ?? "GET",
			href: url.searchParams.get("url"),
			origin: header("origin"),
			host: header("host") ?? "",
			secFetchSite: header("sec-fetch-site"),
			enabled: !isRemoteSession(),
		},
		cards,
	);
	const body = answer.status === 200 ? { serverSession, ...answer.body } : answer.body;
	res.writeHead(answer.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
	return true;
}
