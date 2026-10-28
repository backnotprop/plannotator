import { describe, expect, it } from "bun:test";
import type { PermissionOption, RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";
import { builderAutoAllow, isBuilderToolCall } from "./permission-policy";

const OPTIONS: PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  { optionId: "reject-always", name: "Never", kind: "reject_always" },
];
const KINDS: ToolKind[] = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"];

function request(kind: ToolKind | null, extra: Partial<RequestPermissionRequest["toolCall"]> = {}): RequestPermissionRequest {
  return { sessionId: "s", toolCall: { toolCallId: "t1", title: "A tool", ...(kind && { kind }), ...extra }, options: OPTIONS };
}

describe("permission requests", () => {
  it("answers nothing on its own for any tool kind: every request goes to the user", () => {
    for (const kind of [...KINDS, null]) expect(builderAutoAllow(request(kind))).toBeNull();
  });

  it("allows the builder's own tools once without a prompt", () => {
    for (const t of [{ name: "guide_set_header" }, { title: "mcp__plannotator-guide__guide_finish" }, { title: "plannotator-guide.guide_place_file" }, { title: "plannotator-guide/guide_read" }, { title: "plannotator-guide_guide_add_chapter" }, { title: "guide_set_overview" }]) {
      expect(builderAutoAllow(request("other", t))).toBe("allow-once");
      expect(builderAutoAllow(request(null, t))).toBe("allow-once");
    }
  });

  it("never treats a command that only mentions a builder tool as one", () => {
    expect(isBuilderToolCall({ title: "echo guide_finish && rm -rf ~" })).toBe(false);
    expect(isBuilderToolCall({ title: "mcp__evil__guide_finish" })).toBe(false);
    expect(isBuilderToolCall({ title: "guide_not_a_tool" })).toBe(false);
    expect(builderAutoAllow(request("execute", { name: "guide_finish" }))).toBeNull();
  });
});
