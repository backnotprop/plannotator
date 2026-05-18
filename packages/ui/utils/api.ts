declare global {
  interface Window {
    __PLANNOTATOR_API_BASE__?: string;
  }
}

function normalizeBase(base: string | undefined): string {
  if (!base) return "/api";
  const trimmed = base.trim();
  if (!trimmed) return "/api";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function normalizePath(path: string): string {
  if (!path) return "";
  const prefixed = path.startsWith("/") ? path : `/${path}`;
  return prefixed.length > 1 && prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

export function getApiBase(): string {
  if (typeof window === "undefined") return "/api";
  return normalizeBase(window.__PLANNOTATOR_API_BASE__);
}

export function apiPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/api") return getApiBase();
  if (normalized.startsWith("/api/")) {
    return `${getApiBase()}${normalized.slice("/api".length)}`;
  }
  return `${getApiBase()}${normalized}`;
}

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(apiPath(input), init);
}

export function apiEventSource(path: string, init?: EventSourceInit): EventSource {
  return new EventSource(apiPath(path), init);
}

export function getApiOriginAndBase(): string {
  if (typeof window === "undefined") return "/api";
  return `${window.location.origin}${getApiBase()}`;
}
