/**
 * Bun adapter for the host-only session control endpoints
 * (`/api/host/status`, `/api/host/close`; packages/shared/host-control.ts).
 * The Pi mirror lives in apps/pi-extension/server/host-control.ts.
 */

import {
  handleHostControlRequest,
  type HostControl,
} from "@plannotator/shared/host-control";
import { takeEnvPullSessionBridgeConfig } from "./ai-runtime";
import { cameThroughTailscale } from "@plannotator/shared/tailnet-audience";
import { isRemoteSession } from "./remote";

export type { HostControl, HostSessionStatus, HostCloseOutcome } from "@plannotator/shared/host-control";

/**
 * The token the host-control endpoints accept: `explicit` (tests, an
 * in-process caller), else the pull-bridge token the host launched this CLI
 * with. Never in remote mode. A `--tailscale` session keeps it, answering this
 * machine only (`fromThisMachine`). Unlike the pull bridge, NOT turned off by
 * `PLANNOTATOR_AI=disabled`: closing a review is not an AI feature.
 */
export function resolveHostControlToken(explicit?: string): string | undefined {
  if (isRemoteSession()) return undefined;
  return explicit ?? takeEnvPullSessionBridgeConfig()?.token;
}

/** The response for a host-control path, or null when the request is not one. */
export function handleHostControl(
  req: Request,
  url: URL,
  route: {
    token: string | undefined;
    getServerPort: () => number | undefined;
    control: HostControl;
    /**
     * A `--tailscale` session (#2166): whether the request came from this
     * machine. A request through `tailscale serve` is answered as if host
     * control were off, whatever Host or token it carries.
     */
    fromThisMachine?: (req: Request) => boolean;
  },
): Response | null {
  // A request through Tailscale is never this machine's, in any session (a
  // serve mapping left behind by a crashed `--tailscale` session can point at
  // a later session on the same port).
  const fromThisMachine = route.fromThisMachine ? route.fromThisMachine(req) : !cameThroughTailscale(req.headers);
  if (!fromThisMachine) route = { ...route, token: undefined };
  const answer = handleHostControlRequest(
    {
      method: req.method,
      pathname: url.pathname,
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      authorization: req.headers.get("authorization"),
    },
    route,
  );
  return answer ? Response.json(answer.body, { status: answer.status }) : null;
}
