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
import { createRefCards, handleRefCardRoute, REF_CARD_ROUTE, type ForgejoRefReader, type RefCards, type RefRunner } from "../generated/ref-cards.ts";
import { loadConfig, resolveForgejoHosts } from "../generated/config.ts";
import { learnForgejoHosts } from "../generated/forge-refs.ts";
import { fetchFjCard } from "../generated/pr-provider.ts";
import { nodeRefCliRunner } from "../generated/ref-cards-node.ts";
import { isRemoteSession } from "./network.ts";
import { prCommandRuntime } from "./pr.ts";
import { isSshTunnelRequest } from "./this-machine.ts";

export type { ForgejoRefReader, RefRunner } from "../generated/ref-cards.ts";

/**
 * One cache per server; `run` is for tests (default: the real gh / glab through Node). With no `run` (a real session) a
 * Forgejo / Gitea link is read too, with the person's token for its host and only on a host they named; a test that
 * hands its own runner gets no Forgejo reader unless it passes `forgejo`, so no test reaches a real instance.
 */
export function createPiRefCards(run?: RefRunner, forgejo?: ForgejoRefReader): RefCards {
	return createRefCards({ run: run ?? nodeRefCliRunner, forgejo: run ? forgejo : (ref, signal) => fetchFjCard(prCommandRuntime, ref, signal) });
}

/** The Forgejo hosts the person named, read from config at most every few seconds, so one named later shows on the next hover. */
const FORGEJO_HOSTS_REFRESH_MS = 5_000;
let forgejoHostsAt = -Infinity;
function refreshForgejoHosts(): void {
	const now = Date.now();
	if (now - forgejoHostsAt < FORGEJO_HOSTS_REFRESH_MS) return;
	forgejoHostsAt = now;
	try {
		learnForgejoHosts(resolveForgejoHosts(loadConfig({ quiet: true })));
	} catch {
		// An unreadable config leaves what was learned.
	}
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
	refreshForgejoHosts();
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
			// Remote mode: only an SSH session's own tunnel (isSshTunnelRequest) may drive gh / glab here.
			enabled: !isRemoteSession() || isSshTunnelRequest(req),
		},
		cards,
	);
	const body = answer.status === 200 ? { serverSession, ...answer.body } : answer.body;
	res.writeHead(answer.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
	return true;
}
