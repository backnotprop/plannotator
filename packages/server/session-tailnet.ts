/** "Ask this session" gate for a `--tailscale` session: this machine's tabs, plus the owner's tab through `tailscale serve`. State is per process (one session per CLI process). */

import {
  describeTailscaleFailure,
  parseTailscaleSelfIdentity,
  runTailscale,
  TAILSCALE_CLI_TIMEOUT_MS,
  type TailscaleRunner,
} from "@plannotator/shared/tailscale";
import { isServedTailnetHost, normalizeTailnetLogin } from "@plannotator/shared/inbox/tailnet";
import { loadConfig, resolveInboxTailscaleAllow } from "@plannotator/shared/config";
import { tailnetAudience, type TailnetAudience } from "@plannotator/shared/tailnet-audience";

export type { TailnetAudience } from "@plannotator/shared/tailnet-audience";

interface SessionTailnetState {
  owners: string[];
  hostname: string | null;
  httpsPort: number | null;
}

let state: SessionTailnetState = { owners: [], hostname: null, httpsPort: null };

export type TailnetOwners =
  | { logins: string[]; source: "tailscale" | "allowlist" }
  | { logins: []; reason: string };

/** The owner `tailscale status --json` names; when it names none, config.json `inboxTailscaleAllow` logins count as the owner, as for the Inbox. Nobody if Tailscale does not answer. */
export function readTailnetOwners(
  run: TailscaleRunner = runTailscale,
  allowlist: () => readonly string[] = () => resolveInboxTailscaleAllow(loadConfig()),
): TailnetOwners {
  const status = run(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS);
  if (status.error || status.status !== 0) return { logins: [], reason: describeTailscaleFailure(status) };
  const identity = parseTailscaleSelfIdentity(status.stdout);
  if (!identity) return { logins: [], reason: "could not read `tailscale status --json`" };
  if (identity.login) return { logins: [normalizeTailnetLogin(identity.login)], source: "tailscale" };
  const allowed = [...new Set(allowlist().map(normalizeTailnetLogin))];
  if (allowed.length > 0) return { logins: allowed, source: "allowlist" };
  const why = identity.tagged ? "this machine is a tagged Tailscale device, so it has no owner" : "Tailscale did not say who owns this machine";
  return { logins: [], reason: `${why}; add your Tailscale login to inboxTailscaleAllow in config.json` };
}

export function setSessionTailnetOwners(logins: readonly string[]): void {
  state = { ...state, owners: [...new Set(logins.map(normalizeTailnetLogin))] };
}

export function setSessionTailnetServedUrl(url: string): void {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : 443;
    state = { ...state, hostname: parsed.hostname.toLowerCase(), httpsPort: port };
  } catch {
    // An unparsable URL leaves no served name: owners' tabs are refused.
  }
}

/** The Host an owner's tab sends: the served name with the HTTPS port, or the name alone on 443 (a browser omits the default port). */
function isServedHost(hostHeader: string | null, hostname: string, httpsPort: number): boolean {
  if (isServedTailnetHost(hostHeader, hostname, httpsPort)) return true;
  if (httpsPort !== 443 || !hostHeader) return false;
  return hostHeader.trim().toLowerCase().replace(/\.$/, "") === hostname.toLowerCase();
}

export function sessionTailnetAudience(req: Request): TailnetAudience {
  return tailnetAudience(req.headers, state.owners);
}

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

export function resetSessionTailnetForTests(): void {
  state = { owners: [], hostname: null, httpsPort: null };
}

export interface SessionTailnetGate {
  audience(req: Request): TailnetAudience;
  askAllowed(req: Request, localAllowed: (req: Request) => boolean): boolean;
}

export const sessionTailnetGate: SessionTailnetGate = {
  audience: sessionTailnetAudience,
  askAllowed: sessionTailnetAskAllowed,
};
