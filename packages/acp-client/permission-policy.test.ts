import { describe, expect, test } from "bun:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { isOwnToolCall, ownToolAutoAllow, type OwnTools } from "./permission-policy";

const INBOX: OwnTools = { server: "plannotator-inbox", names: new Set(["send_message", "read_thread"]) };
const OPTIONS = [
  { optionId: "always-allow", name: "always allow", kind: "allow_always" },
  { optionId: "allow-once", name: "allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "reject once", kind: "reject_once" },
];
const request = (toolCall: Record<string, unknown>) => ({ sessionId: "s", toolCall: { toolCallId: "t1", ...toolCall }, options: OPTIONS }) as unknown as RequestPermissionRequest;

describe("the host's own MCP tools", () => {
  test("Grok Build's title for an MCP tool (`<server>__<tool>`, seen live) is allowed once without a prompt", () => {
    expect(ownToolAutoAllow(request({ title: "plannotator-inbox__send_message", kind: "other" }), INBOX)).toBe("allow-once");
    for (const title of ["mcp__plannotator-inbox__read_thread", "plannotator-inbox.read_thread", "plannotator-inbox/read_thread", "plannotator-inbox: send_message"]) {
      expect(isOwnToolCall({ title }, INBOX)).toBe(true);
    }
  });

  test("anything else asks the person: another server, another tool, a bare name, a title that merely mentions one, another kind", () => {
    expect(ownToolAutoAllow(request({ title: "github__send_message", kind: "other" }), INBOX)).toBeNull();
    expect(ownToolAutoAllow(request({ title: "plannotator-inbox__resolve_message", kind: "other" }), INBOX)).toBeNull();
    expect(ownToolAutoAllow(request({ title: "send_message", kind: "other" }), INBOX)).toBeNull();
    expect(ownToolAutoAllow(request({ title: "echo plannotator-inbox__send_message", kind: "execute" }), INBOX)).toBeNull();
    expect(ownToolAutoAllow(request({ title: "plannotator-inbox__send_message", kind: "execute" }), INBOX)).toBeNull();
    // A bare name counts only for a host that asks for it (Guides' builder tools).
    expect(isOwnToolCall({ title: "send_message" }, { ...INBOX, bare: true })).toBe(true);
  });
});
