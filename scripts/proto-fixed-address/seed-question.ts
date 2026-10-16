/**
 * PROTOTYPE (proto/inbox-fixed-address): send one question to the SCRATCH
 * Inbox over its loopback MCP endpoint, the way an agent would, so the
 * window on the new origin raises its notification ask (and, once allowed,
 * a notification).
 *
 *   bun scripts/proto-fixed-address/seed-question.ts <scratch inbox port> <project folder>
 *
 * Refuses the real Inbox's port (59812).
 */
const port = Number(process.argv[2]);
const project = process.argv[3];
if (!Number.isInteger(port) || port <= 0 || !project) {
  console.error("usage: seed-question.ts <scratch inbox port> <project folder>");
  process.exit(2);
}
if (port === Number(process.env.REAL_INBOX_PORT ?? 59812)) {
  console.error("refusing: that is the real Inbox's port");
  process.exit(2);
}

const call = await fetch(`http://127.0.0.1:${port}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "send_message",
      arguments: {
        project_path: project,
        agent_session: "proto-fixed-address-checklist",
        agent_host: "checklist",
        agent_name: "Fixed-address checklist",
        subject: "Does the fixed address keep notifications?",
        body: [
          "The checklist sent this to the scratch Inbox at its fixed address.",
          "",
          ":::question",
          "Did the browser ask to allow notifications for inbox.plannotator.localhost?",
          "- Yes",
          "- No",
          ":::",
        ].join("\n"),
        idempotency_key: `proto-fixed-address-${Date.now()}`,
      },
    },
  }),
});
const text = await call.text();
const ok = call.ok && !/"isError"\s*:\s*true/.test(text);
console.log(ok ? "sent" : `failed: HTTP ${call.status} ${text.slice(0, 400)}`);
process.exit(ok ? 0 : 1);
export {};
