import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

export interface OwnTools {
  server: string;
  names: ReadonlySet<string>;
  bare?: boolean;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function isOwnToolCall(toolCall: { name?: string | null; title?: string | null }, own: OwnTools): boolean {
  const prefix = `(?:mcp__)?${escape(own.server)}(?:__|[._/]|: ?)`;
  const pattern = new RegExp(`^${own.bare ? `(?:${prefix})?` : prefix}([A-Za-z0-9_-]+)$`);
  for (const raw of [toolCall.name, toolCall.title]) {
    if (typeof raw !== "string") continue;
    const m = pattern.exec(raw.trim());
    if (m && own.names.has(m[1]!)) return true;
  }
  return false;
}

export function ownToolAutoAllow(request: RequestPermissionRequest, own: OwnTools): string | null {
  const kind = request.toolCall.kind;
  if (kind && kind !== "other") return null;
  if (!isOwnToolCall(request.toolCall, own)) return null;
  return request.options.find((o) => o.kind === "allow_once")?.optionId ?? null;
}
