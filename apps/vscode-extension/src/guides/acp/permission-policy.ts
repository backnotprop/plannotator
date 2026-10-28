/**
 * Permission requests. Guides never refuses one on its own: the agent's own
 * settings decide what it asks about, and every request is shown to the user
 * with all the options the agent offers (allow once or always, reject once or
 * always); the user's choice goes back as it is.
 *
 * The one exception is Guides' own MCP tools on the `plannotator-guide`
 * server: the builder's `guide_*` tools, which change nothing but the draft
 * held in the extension (a guide makes dozens of calls to them), and an ask
 * session's `show_answer`, which only hands the answer page to the
 * extension. When an agent asks about one it is allowed once without a
 * prompt. They are matched by
 * their exact programmatic name or whole title, never a title that merely
 * mentions one (a shell command can). The matching is shared with the
 * Inbox's runner (packages/acp-client/permission-policy.ts).
 */

import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { isOwnToolCall, ownToolAutoAllow, type OwnTools } from "@plannotator/acp-client/permission-policy";
import { GUIDE_BUILDER_TOOL_NAMES } from "../core/adapter";

/** The builder's tools on `plannotator-guide`, matched bare too (agents name them either way). */
const BUILDER: OwnTools = { server: "plannotator-guide", names: new Set<string>([...(GUIDE_BUILDER_TOOL_NAMES as readonly string[]), "show_answer"]), bare: true };

/**
 * Whether a tool call is one of the builder's own MCP tools: its programmatic
 * name, or its whole title, is a builder tool name, bare or with the server's
 * prefix as agents spell it (`mcp__plannotator-guide__guide_finish`,
 * `plannotator-guide.guide_finish`, `plannotator-guide/guide_finish`,
 * `plannotator-guide_guide_finish`, `plannotator-guide: guide_finish`).
 */
export function isBuilderToolCall(toolCall: { name?: string | null; title?: string | null }): boolean {
  return isOwnToolCall(toolCall, BUILDER);
}

/**
 * The option to answer with without asking: "allow once" for a request about
 * one of the builder's own tools (of kind `other` or no kind), else null (ask
 * the user).
 */
export function builderAutoAllow(request: RequestPermissionRequest): string | null {
  return ownToolAutoAllow(request, BUILDER);
}
