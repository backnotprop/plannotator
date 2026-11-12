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
