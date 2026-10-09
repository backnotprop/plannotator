import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Client, StreamableHTTPClientTransport, UnauthorizedError,
  type OAuthClientProvider, type OAuthClientMetadata, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

interface Credentials {
  endpoint: string;
  epoch: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
}

export function connectionKey(endpoint: URL, thread = ""): string {
  return createHash("sha256").update(`${endpoint.href}\n${thread}`).digest("hex");
}

export function privateWrite(path: string, value: unknown): void {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export class T3Credentials {
  readonly directory: string;
  readonly path: string;
  constructor(dataDir: string, readonly endpoint: URL) {
    this.directory = join(dataDir, "t3-code", connectionKey(endpoint));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    this.path = join(this.directory, "oauth.json");
  }

  read(): Credentials | undefined {
    if (!existsSync(this.path)) return undefined;
    const value = JSON.parse(readFileSync(this.path, "utf8")) as Credentials;
    if (value.endpoint !== this.endpoint.href || typeof value.epoch !== "string") throw new Error("T3 credential scope does not match this endpoint.");
    if (value.tokens && (typeof value.tokens.access_token !== "string" || typeof value.tokens.token_type !== "string")) throw new Error("Invalid saved T3 credentials; run login again.");
    return value;
  }

  token = (): string | undefined => this.read()?.tokens?.access_token;

  save(value: Credentials): void { privateWrite(this.path, value); }
}

export class T3OAuthProvider implements OAuthClientProvider {
  private credentials: Credentials;
  private verifier = "";
  private discovery: OAuthDiscoveryState | undefined;
  readonly expectedState = randomBytes(32).toString("base64url");

  constructor(readonly store: T3Credentials, readonly redirectUrl: URL, private readonly authorize: (url: URL) => void | Promise<void>) {
    this.credentials = { endpoint: store.endpoint.href, epoch: randomBytes(16).toString("hex") };
  }

  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Plannotator T3 Code", redirect_uris: [this.redirectUrl.href], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state(): string { return this.expectedState; }
  clientInformation(): StoredOAuthClientInformation | undefined { return this.credentials.client; }
  saveClientInformation(client: StoredOAuthClientInformation): void { this.credentials.client = client; }
  tokens(): StoredOAuthTokens | undefined { return this.credentials.tokens; }
  saveTokens(tokens: StoredOAuthTokens): void { this.credentials.tokens = tokens; this.store.save(this.credentials); }
  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string { if (!this.verifier) throw new Error("No pending T3 authorization."); return this.verifier; }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }
  saveDiscoveryState(discovery: OAuthDiscoveryState): void { this.discovery = discovery; }
  redirectToAuthorization(url: URL): void | Promise<void> { return this.authorize(url); }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") delete this.credentials.client;
    if (scope === "all" || scope === "tokens") delete this.credentials.tokens;
    if (scope === "all" || scope === "verifier") this.verifier = "";
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
  }
}

// SDK v2 validates issuer/PKCE; callback state remains the client's responsibility.
// https://github.com/modelcontextprotocol/typescript-sdk/tree/v2.2.0/packages/client
export async function loginT3(store: T3Credentials, authorize: (url: URL) => void | Promise<void>, timeoutMs = 300_000): Promise<void> {
  let provider: T3OAuthProvider;
  let transport: StreamableHTTPClientTransport;
  let used = false;
  let resolveLogin: () => void;
  let rejectLogin: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject; });
  // Attach a handler immediately: startup can fail before the callback is awaited.
  void completed.catch(() => {});
  const callback = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback" || request.method !== "GET") return new Response("Not found", { status: 404 });
      if (url.host !== `127.0.0.1:${callback.port}` || !provider || url.searchParams.get("state") !== provider.expectedState || used) return new Response("Invalid authorization state", { status: 403 });
      used = true;
      try {
        await transport.finishAuth(url.searchParams);
        resolveLogin();
        return new Response("Plannotator connected to T3. You can close this tab.", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
      } catch {
        rejectLogin(new Error("T3 authorization was refused. Run login again to retry."));
        return new Response("Authorization failed", { status: 400 });
      }
    },
  });
  const timer = setTimeout(() => rejectLogin(new Error("T3 login timed out.")), timeoutMs);
  const client = new Client({ name: "plannotator-t3", version: "0.0.1" });
  try {
    provider = new T3OAuthProvider(store, new URL(`http://127.0.0.1:${callback.port}/callback`), authorize);
    transport = new StreamableHTTPClientTransport(store.endpoint, { authProvider: provider, onInsufficientScope: "throw" });
    try { await client.connect(transport); }
    catch (error) { if (!(error instanceof UnauthorizedError)) throw error; await completed; }
    if (!store.token()) throw new Error("T3 did not return an OAuth grant.");
  } finally {
    clearTimeout(timer);
    callback.stop(false);
    await client.close().catch(() => {});
  }
}
