/**
 * Permission requests a host answers without asking: only its OWN MCP tools,
 * on its own server. Everything else the agent asks about is shown to the
 * person with all the options the agent offers, and the choice goes back as
 * it is: the agent's own settings decide what it asks about.
 *
 * A tool is matched by its exact programmatic name or its whole title, bare
 * or with the server's prefix as agents spell it (`mcp__<server>__<tool>`,
 * `<server>.<tool>`, `<server>/<tool>`, `<server>_<tool>`, `<server>__<tool>`
 * (Grok Build), `<server>: <tool>`), never a title that merely mentions one
 * (a shell command can).
 */

import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

export interface OwnTools {
  /** The MCP server's name as the host passed it in `session/new` (`plannotator-inbox`). */
  server: string;
  /** Its tool names. */
  names: ReadonlySet<string>;
  /** Also match a bare tool name with no server prefix (Guides' builder tools). Default false. */
  bare?: boolean;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a tool call is one of the host's own MCP tools. */
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

/**
 * The option to answer with without asking: "allow once" for a request about
 * one of the host's own tools (of kind `other` or no kind), else null (ask
 * the person).
 */
export function ownToolAutoAllow(request: RequestPermissionRequest, own: OwnTools): string | null {
  const kind = request.toolCall.kind;
  if (kind && kind !== "other") return null;
  if (!isOwnToolCall(request.toolCall, own)) return null;
  return request.options.find((o) => o.kind === "allow_once")?.optionId ?? null;
}
