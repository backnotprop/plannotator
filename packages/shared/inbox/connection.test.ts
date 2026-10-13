/**
 * The plannotator_inbox contract's optional project_path: in the agent's
 * schema (optional, never the other filled arguments), and returned apart
 * from the filled working folder so the connection resolves it.
 */
import { expect, test } from "bun:test";
import { INBOX_AGENT_PROJECT_PATH_DESCRIPTION, inboxAgentTool, inboxToolCall, type InboxToolInfo } from "./connection";

const tools: InboxToolInfo[] = [
  {
    name: "send_message",
    description: "Post a message.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string" },
        project_path: { type: "string", description: "The shim fills it." },
        agent_session: { type: "string" },
        agent_host: { type: "string" },
        agent_name: { type: "string" },
      },
    },
  },
  { name: "get_guide_brief", description: "The brief.", inputSchema: { type: "object", properties: {} } },
];
const filled = { project_path: "/work/notes", agent_session: "ses_1", agent_host: "pi", agent_name: "Pi" };

test("the agent's schema offers project_path, optional, and still hides the other filled arguments", () => {
  const spec = inboxAgentTool(tools)!;
  const properties = spec.inputSchema.properties as Record<string, { type: string; description: string }>;
  expect(properties.project_path!.type).toBe("string");
  expect(properties.project_path!.description).toContain(INBOX_AGENT_PROJECT_PATH_DESCRIPTION);
  expect(spec.inputSchema.required).toEqual(["action"]);
  for (const hidden of ["agent_session", "agent_host", "agent_name"]) expect(properties[hidden]).toBeUndefined();
});

test("a call without project_path fills the working folder; with one, it comes back to resolve", () => {
  const plain = inboxToolCall({ action: "send_message", body: "x" }, tools, filled);
  expect(plain).toEqual({ name: "send_message", arguments: { body: "x", project_path: "/work/notes", agent_session: "ses_1", agent_host: "pi", agent_name: "Pi" } });
  const named = inboxToolCall({ action: "send_message", body: "x", project_path: "../api" }, tools, filled);
  expect("error" in named).toBe(false);
  if ("error" in named) return;
  expect(named.projectPath).toBe("../api");
  expect(named.arguments.project_path).toBe("/work/notes");
});

test("a malformed project_path, or one on a tool that takes none, is refused", () => {
  for (const bad of ["", "   ", 7, "a\nb", "a\u0000b", "x".repeat(4097)]) {
    const call = inboxToolCall({ action: "send_message", body: "x", project_path: bad }, tools, filled);
    expect("error" in call && call.error, JSON.stringify(bad)).toContain("project_path");
  }
  const brief = inboxToolCall({ action: "get_guide_brief", project_path: "/work/api" }, tools, filled);
  expect("error" in brief && brief.error).toContain('takes no "project_path"');
  // The other filled arguments stay the connection's.
  const session = inboxToolCall({ action: "send_message", body: "x", agent_session: "someone" }, tools, filled);
  expect("error" in session && session.error).toContain('takes no "agent_session"');
});
