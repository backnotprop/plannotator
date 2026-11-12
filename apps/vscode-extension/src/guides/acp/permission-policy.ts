import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { isOwnToolCall, ownToolAutoAllow, type OwnTools } from "@plannotator/acp-client/permission-policy";
import { GUIDE_BUILDER_TOOL_NAMES } from "../core/adapter";

const BUILDER: OwnTools = { server: "plannotator-guide", names: new Set<string>([...(GUIDE_BUILDER_TOOL_NAMES as readonly string[]), "show_answer"]), bare: true };

export function isBuilderToolCall(toolCall: { name?: string | null; title?: string | null }): boolean {
  return isOwnToolCall(toolCall, BUILDER);
}

export function builderAutoAllow(request: RequestPermissionRequest): string | null {
  return ownToolAutoAllow(request, BUILDER);
}
