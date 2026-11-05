/**
 * "Ask this session" for a session published with `--tailscale` (#2166).
 *
 * The CLI keeps the host's pull-bridge token under `--tailscale` (it used to
 * discard it), so "Ask this session" answers a tab on this machine as in any
 * local session, and a tab that came through `tailscale serve` only when its
 * `Tailscale-User-Login` is the login that owns this machine, or, when
 * Tailscale names no owner (a tagged machine, or an untagged one whose owner
 * it does not report), a login in config.json `inboxTailscaleAllow`: the rule
 * the Inbox's `isOwnerRequest` follows. Everyone else
 * on the tailnet keeps what a `--tailscale` session always gave them: the
 * review, and Ask AI through the agent SDKs, never the agent session
 * (`createAIRuntime`'s `tailnetAudience`). The bridge's own poll and the
 * host-control routes answer only this machine.
 *
 * One session per CLI process, so the state is the process's (like the served
 * hostname in request-host-guard.ts). Nothing here runs unless the CLI
 * publishes a session over the tailnet. The owners are read for every such
 * session: hover cards (ref-cards.ts) use this gate with or without a bridge.
 */

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
  /** The logins that count as this machine's owner, normalized; empty when nobody does. */
  owners: string[];
  /** The served MagicDNS name and HTTPS port, once serve reported them. */
  hostname: string | null;
  httpsPort: number | null;
}

let state: SessionTailnetState = { owners: [], hostname: null, httpsPort: null };

/** Who counts as this machine's owner over the tailnet, or why nobody does. */
export type TailnetOwners =
  | { logins: string[]; source: "tailscale" | "allowlist" }
  | { logins: []; reason: string };

/**
 * The owner `tailscale status --json` names. When it names none (a tagged
 * machine, or an untagged one whose owner it does not report), the logins in
 * config.json `inboxTailscaleAllow` count as the owner, as they do for the
 * Inbox (`isOwnerRequest` in inbox-tailscale.ts). Nobody when Tailscale does
 * not answer, or names no owner and the allowlist is empty.
 */
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

/** The logins a tailnet tab must be one of, for this process's session. */
export function setSessionTailnetOwners(logins: readonly string[]): void {
  state = { ...state, owners: [...new Set(logins.map(normalizeTailnetLogin))] };
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
  return tailnetAudience(req.headers, state.owners);
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
  state = { owners: [], hostname: null, httpsPort: null };
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
