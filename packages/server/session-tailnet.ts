/**
 * "Ask this session" for a session published with `--tailscale` (#2166).
 *
 * The CLI keeps the host's pull-bridge token under `--tailscale` (it used to
 * discard it), so "Ask this session" answers a tab on this machine as in any
 * local session, and a tab that came through `tailscale serve` only when its
 * `Tailscale-User-Login` is the login that owns this machine. Everyone else
 * on the tailnet keeps what a `--tailscale` session always gave them: the
 * review, and Ask AI through the agent SDKs, never the agent session
 * (`createAIRuntime`'s `tailnetAudience`). The bridge's own poll and the
 * host-control routes answer only this machine.
 *
 * One session per CLI process, so the state is the process's (like the served
 * hostname in request-host-guard.ts). Nothing here runs unless the CLI
 * publishes a session over the tailnet AND a host handed it a bridge.
 */

import {
  describeTailscaleFailure,
  parseTailscaleSelfIdentity,
  runTailscale,
  TAILSCALE_CLI_TIMEOUT_MS,
  type TailscaleRunner,
} from "@plannotator/shared/tailscale";
import { isServedTailnetHost, normalizeTailnetLogin } from "@plannotator/shared/inbox/tailnet";
import { tailnetAudience, type TailnetAudience } from "@plannotator/shared/tailnet-audience";

export type { TailnetAudience } from "@plannotator/shared/tailnet-audience";

interface SessionTailnetState {
  /** The login that owns this machine, normalized; null when nobody could say. */
  owner: string | null;
  /** The served MagicDNS name and HTTPS port, once serve reported them. */
  hostname: string | null;
  httpsPort: number | null;
}

let state: SessionTailnetState = { owner: null, hostname: null, httpsPort: null };

/** The owner `tailscale status --json` names, or why there is none (a tagged device, Tailscale not answering). */
export function readTailnetOwner(run: TailscaleRunner = runTailscale): { login: string } | { login: null; reason: string } {
  const status = run(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS);
  if (status.error || status.status !== 0) return { login: null, reason: describeTailscaleFailure(status) };
  const identity = parseTailscaleSelfIdentity(status.stdout);
  if (!identity) return { login: null, reason: "could not read `tailscale status --json`" };
  if (identity.login) return { login: normalizeTailnetLogin(identity.login) };
  return {
    login: null,
    reason: identity.tagged ? "this machine is a tagged Tailscale device, so it has no owner" : "Tailscale did not say who owns this machine",
  };
}

/** The owner a tailnet tab must be, for this process's session. */
export function setSessionTailnetOwner(login: string | null): void {
  state = { ...state, owner: login ? normalizeTailnetLogin(login) : null };
}

/** The served address (the URL `tailscale serve` reported), for the Host an owner's tab must send. */
export function setSessionTailnetServedUrl(url: string): void {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : 443;
    state = { ...state, hostname: parsed.hostname.toLowerCase(), httpsPort: port };
  } catch {
    // An unparsable URL leaves no served name: owners' tabs are refused.
  }
}

/**
 * The Host an owner's tab sends: the served name with the HTTPS port, or the
 * name alone when that port is 443 (a browser omits the default port).
 */
function isServedHost(hostHeader: string | null, hostname: string, httpsPort: number): boolean {
  if (isServedTailnetHost(hostHeader, hostname, httpsPort)) return true;
  if (httpsPort !== 443 || !hostHeader) return false;
  return hostHeader.trim().toLowerCase().replace(/\.$/, "") === hostname.toLowerCase();
}

/** Who sent a request to this process's tailnet-published session. */
export function sessionTailnetAudience(req: Request): TailnetAudience {
  return tailnetAudience(req.headers, state.owner);
}

/**
 * Whether a request may ask the agent session: a loopback tab (the Host check
 * every local session runs, `localAllowed`), or the owner's tab through serve
 * with the served name and port as Host.
 */
export function sessionTailnetAskAllowed(req: Request, localAllowed: (req: Request) => boolean): boolean {
  switch (sessionTailnetAudience(req)) {
    case "local":
      return localAllowed(req);
    case "owner":
      return state.hostname !== null && state.httpsPort !== null && isServedHost(req.headers.get("host"), state.hostname, state.httpsPort);
    case "peer":
      return false;
  }
}

/** Test-only: forget the owner and served address. */
export function resetSessionTailnetForTests(): void {
  state = { owner: null, hostname: null, httpsPort: null };
}

/** What `createAIRuntime` takes for a tailnet-published session (`tailnet`). */
export interface SessionTailnetGate {
  audience(req: Request): TailnetAudience;
  askAllowed(req: Request, localAllowed: (req: Request) => boolean): boolean;
}

/** This process's gate: the servers pass it to `createAIRuntime` when `tailnetPublished` is set. */
export const sessionTailnetGate: SessionTailnetGate = {
  audience: sessionTailnetAudience,
  askAllowed: sessionTailnetAskAllowed,
};
