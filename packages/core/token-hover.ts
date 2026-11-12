export type TokenHoverTrigger = "hover" | "modifier" | "off";

export const TOKEN_HOVER_TRIGGERS = [
  "hover",
  "modifier",
  "off",
] as const satisfies readonly TokenHoverTrigger[];

export function isTokenHoverTrigger(value: unknown): value is TokenHoverTrigger {
  return value === "hover" || value === "modifier" || value === "off";
}

export type TokenHoverDelay = 150 | 300 | 700;

export const DEFAULT_TOKEN_HOVER_DELAY_MS = 300 satisfies TokenHoverDelay;

export const TOKEN_HOVER_DELAYS = [
  150,
  300,
  700,
] as const satisfies readonly TokenHoverDelay[];

export function isTokenHoverDelay(value: unknown): value is TokenHoverDelay {
  return value === 150 || value === 300 || value === 700;
}

export function resolveStoredTokenHoverTrigger(
  stored: string | null | undefined,
  legacyEnabled: string | null | undefined,
): TokenHoverTrigger | undefined {
  if (isTokenHoverTrigger(stored)) return stored;
  if (legacyEnabled === "false") return "off";
  if (legacyEnabled === "true") return "hover";
  return undefined;
}
