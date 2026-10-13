/**
 * node:http adapter for the host-only session control endpoints
 * (`/api/host/status`, `/api/host/close`; packages/shared/host-control.ts,
 * vendored to generated/host-control.ts). Mirrors packages/server/host-control.ts.
 *
 * Pi itself calls a server's `hostControl` in-process and never needs the
 * HTTP paths; they answer only when a caller started the server with a
 * `hostControlToken`, and never in remote mode, exactly like the Bun servers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHostControlRequest, type HostControl } from "../generated/host-control.ts";
import { json } from "./helpers.ts";
import { isRemoteSession } from "./network.ts";

export type { HostControl } from "../generated/host-control.ts";

/** The token the endpoints accept: the caller's, never in remote mode. */
export function resolveHostControlToken(explicit: string | undefined): string | undefined {
	return isRemoteSession() ? undefined : explicit;
}

/** Answers a host-control path and returns true, or returns false when the request is not one. */
export function handleHostControl(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	route: { token: string | undefined; getServerPort: () => number | undefined; control: HostControl },
): boolean {
	const header = (name: string): string | null => {
		const value = req.headers[name];
		return typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? null) : null;
	};
	const answer = handleHostControlRequest(
		{
			method: req.method ?? "GET",
			pathname: url.pathname,
			host: header("host"),
			origin: header("origin"),
			authorization: header("authorization"),
		},
		route,
	);
	if (!answer) return false;
	json(res, answer.body, answer.status);
	return true;
}
