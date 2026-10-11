/**
 * The proof-only host overrides (`APNS_ORIGIN`, `FCM_ORIGIN`,
 * `FCM_OAUTH_ORIGIN`), fenced to loopback: they exist so the relay's own
 * proof under `wrangler dev` can stand local servers in for Apple and Google.
 * A value naming any other host is ignored (logged once per name) and the
 * production host is used, so a misset variable can never send a signed
 * provider token, a JWT or an access token anywhere else.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const logged = new Set<string>();

export function loopbackOverride(name: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (url && (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname)) return value;
  if (!logged.has(name)) console.log(`relay: ${name} ignored (not loopback)`);
  logged.add(name);
  return undefined;
}
