// Source: new for @plannotator/references; replaces AdapterEnv and OrgConnectionHandle of apps/rooms/src/external-refs/adapter.ts (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// The one seam: the package never sees a client secret, an app origin, env, or a stored row; each product backs this port.
//
// "Give me a credential for provider P on host H." Workspaces backs it with
// its connection store and its GitHub App (it mints the installation token,
// refreshes Linear, unseals GitLab's token). The local Inbox backs it with
// tokens borrowed from gh and glab, and enforces its own host gate: it
// hands out a credential only for a host the CLI is signed in to, and the
// port's fetch is bound to that host. The adapters add two guards of their
// own (credentialFor below): a credential for another host, or of a kind
// the adapter cannot send, is never used.

import type { ProviderId } from "./contract.ts";

/** The fetch shape the adapters call. Any platform `fetch` satisfies it. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** How the token rides the request.
 *  - `installation`: a GitHub App installation token (`Authorization: Bearer`).
 *    Only this kind can list an installation's repositories (GitHub scopes).
 *  - `bearer`: an OAuth or personal token sent as `Authorization: Bearer`
 *    (a GitHub user token from gh, a GitLab OAuth token from glab, a Linear
 *    OAuth access token).
 *  - `private-token`: a GitLab personal, group or project access token sent
 *    as `PRIVATE-TOKEN`.
 *  - `linear-api-key`: a Linear personal API key, sent as the bare
 *    `Authorization: <key>` with no `Bearer` prefix (Linear refuses a
 *    prefixed personal key). Like `bearer` on Linear, it needs `account`. */
export type ReferenceCredentialKind = "bearer" | "private-token" | "installation" | "linear-api-key";

export interface ReferenceCredential {
	readonly kind: ReferenceCredentialKind;
	readonly token: string;
	/** The ITEM host this credential belongs to: lowercase hostname, no port
	 * ("github.com", "gitlab.com", "linear.app"), the host of the canonical
	 * URL the adapter asked about. An adapter uses a credential only when
	 * this equals the host it asked for. */
	readonly host: string;
	/** Provider-owned account fact the adapter binds reads to. Linear: the
	 * workspace urlKey the token belongs to (REQUIRED: a Linear credential
	 * without it reads nothing, because Linear answers `issue(id: "ENG-1")`
	 * inside the token's own workspace). Unused by GitHub and GitLab. */
	readonly account?: string;
}

/** A credential exists but cannot be used right now. `credentialDead` is
 * true only when the failure PROVES it dead (a GitHub App installation that
 * answers 404 on mint, a Linear refresh refused with 400/401, a stored
 * secret that no longer parses); a network blip or a 5xx is false. */
export interface ReferenceCredentialUnavailable {
	readonly kind: "unavailable";
	readonly credentialDead: boolean;
}

/** null = no credential for this provider and host: GitHub and GitLab read
 * their public rung unauthenticated, Linear answers not_linked. */
export type ReferenceCredentialAnswer = ReferenceCredential | ReferenceCredentialUnavailable | null;

/** The fields of the one log line per provider call: host, status and
 * duration only, never a path, query, header, body or credential. `status`
 * is undefined when the call threw before a response. */
export interface ProviderCallFields {
	readonly host: string;
	readonly status: number | undefined;
	readonly duration_ms: number;
}

/** Where the per-call log line goes. The event is always
 * `"external_ref_provider_call"`. */
export type ProviderCallLog = (event: "external_ref_provider_call", fields: ProviderCallFields) => void;

export interface ReferencePort {
	/** The outbound fetch. Adapters wrap it (fetch.ts): ten-second deadline,
	 * same-origin redirects only, one host-only log line. */
	readonly fetch: FetchLike;
	credential(provider: ProviderId, host: string): Promise<ReferenceCredentialAnswer>;
	/** The `user-agent` sent on GitHub and GitLab calls. Default
	 * `"plannotator-workspaces"` (DEFAULT_USER_AGENT in fetch.ts). */
	readonly userAgent?: string;
	/** Receives the one log line per provider call. Default `console.info`. */
	readonly log?: ProviderCallLog;
}

/** The port's answer, narrowed for one adapter call. A credential for
 * another host, of a kind the adapter cannot send, or with an empty token
 * reads as null (never used). A port that throws reads as a transient
 * unavailable answer: adapters answer, they never throw. */
export async function credentialFor(
	port: ReferencePort,
	provider: ProviderId,
	host: string,
	kinds: readonly ReferenceCredentialKind[],
): Promise<ReferenceCredential | ReferenceCredentialUnavailable | null> {
	let answer: ReferenceCredentialAnswer;
	try {
		answer = await port.credential(provider, host);
	} catch {
		return { kind: "unavailable", credentialDead: false };
	}
	if (answer === null || answer.kind === "unavailable") return answer;
	if (answer.host.toLowerCase() !== host.toLowerCase()) return null;
	if (!kinds.includes(answer.kind)) return null;
	if (answer.token.length === 0) return null;
	return answer;
}
