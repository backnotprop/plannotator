import {
  handleHostControlRequest,
  type HostControl,
} from "@plannotator/shared/host-control";
import { takeEnvPullSessionBridgeConfig } from "./ai-runtime";
import { cameThroughTailscale } from "@plannotator/shared/tailnet-audience";
import { isRemoteSession } from "./remote";

export type { HostControl, HostSessionStatus, HostCloseOutcome } from "@plannotator/shared/host-control";

export function resolveHostControlToken(explicit?: string): string | undefined {
  if (isRemoteSession()) return undefined;
  return explicit ?? takeEnvPullSessionBridgeConfig()?.token;
}

export function handleHostControl(
  req: Request,
  url: URL,
  route: {
    token: string | undefined;
    getServerPort: () => number | undefined;
    control: HostControl;
    fromThisMachine?: (req: Request) => boolean;
  },
): Response | null {
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
