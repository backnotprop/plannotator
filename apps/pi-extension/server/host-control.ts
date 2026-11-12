import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHostControlRequest, type HostControl } from "../generated/host-control.ts";
import { json } from "./helpers.ts";
import { isRemoteSession } from "./network.ts";

export type { HostControl } from "../generated/host-control.ts";

export function resolveHostControlToken(explicit: string | undefined): string | undefined {
	return isRemoteSession() ? undefined : explicit;
}

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
