export function parseExtraOrigins(envValue?: string): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin && origin !== "*");
}

export function isAllowedOrigin(origin: string, allowed: readonly string[] = []): boolean {
  return allowed.includes(origin);
}

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
