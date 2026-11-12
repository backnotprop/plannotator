import type { ProviderId } from "./contract.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ReferenceCredentialKind = "bearer" | "private-token" | "installation" | "linear-api-key";

export interface ReferenceCredential {
	readonly kind: ReferenceCredentialKind;
	readonly token: string;
	readonly host: string;
	readonly account?: string;
}

export interface ReferenceCredentialUnavailable {
	readonly kind: "unavailable";
	readonly credentialDead: boolean;
}

export type ReferenceCredentialAnswer = ReferenceCredential | ReferenceCredentialUnavailable | null;

export interface ProviderCallFields {
	readonly host: string;
	readonly status: number | undefined;
	readonly duration_ms: number;
}

export type ProviderCallLog = (event: "external_ref_provider_call", fields: ProviderCallFields) => void;

export interface ReferencePort {
	readonly fetch: FetchLike;
	credential(provider: ProviderId, host: string): Promise<ReferenceCredentialAnswer>;
	readonly userAgent?: string;
	readonly log?: ProviderCallLog;
}

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
