/**
 * A scripted model endpoint for host proofs: an OpenAI-compatible
 * `/v1/chat/completions` server (streamed) that the REAL agent host (the Pi
 * binary in RPC mode, the installed OpenCode 2) is pointed at in place of a
 * provider. The host, the plugin and the Inbox under proof are all real; only
 * the model's words come from the test's script. Every request is kept, so a
 * proof can read what the host sent the model (its tool list, the turn's
 * text) exactly as a provider would have received it.
 */

export interface ScriptedRequest {
  /** The tool names offered with the request. */
  tools: string[];
  /** The tool definitions as sent. */
  toolDefinitions: { name: string; description: string; parameters: unknown }[];
  messages: { role: string; content: unknown; tool_call_id?: string }[];
}

export type ScriptedTurn =
  | { text: string; hold?: Promise<void> }
  | { toolCall: { name: string; arguments: Record<string, unknown> }; hold?: Promise<void> };

export interface ScriptedModel {
  baseUrl: string;
  requests: ScriptedRequest[];
  stop(): void;
}

/** The text of a chat message's content (a string, or text parts). */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : "")).join("");
}

/** The last message of a request that is not the system prompt. */
export function lastMessage(request: ScriptedRequest): { role: string; text: string } {
  const last = request.messages[request.messages.length - 1];
  return { role: last?.role ?? "", text: messageText(last?.content) };
}

export function startScriptedModel(script: (request: ScriptedRequest) => ScriptedTurn): ScriptedModel {
  const requests: ScriptedRequest[] = [];
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "scripted", object: "model" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const body = (await req.json()) as {
        tools?: { function?: { name?: string; description?: string; parameters?: unknown } }[];
        messages?: ScriptedRequest["messages"];
      };
      const toolDefinitions = (body.tools ?? []).map((tool) => ({
        name: tool.function?.name ?? "",
        description: tool.function?.description ?? "",
        parameters: tool.function?.parameters,
      }));
      const request: ScriptedRequest = { tools: toolDefinitions.map((tool) => tool.name), toolDefinitions, messages: body.messages ?? [] };
      requests.push(request);
      const turn = script(request);
      const id = `chatcmpl-${++calls}`;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finish: string | null) =>
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`),
            );
          send({ role: "assistant", content: "" }, null);
          if (turn.hold) await turn.hold;
          if ("text" in turn) {
            send({ content: turn.text }, null);
            send({}, "stop");
          } else {
            send({ tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: turn.toolCall.name, arguments: JSON.stringify(turn.toolCall.arguments) } }] }, null);
            send({}, "tool_calls");
          }
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "scripted", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}
