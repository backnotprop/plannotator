export interface ScriptedRequest {
  tools: string[];
  toolDefinitions: { name: string; description: string; parameters: unknown }[];
  messages: { role: string; content: unknown; tool_call_id?: string }[];
  bodyBytes: number;
  toolBytes: Record<string, number>;
  toolJson: Record<string, string>;
}

export type ScriptedTurn =
  | { text: string; hold?: Promise<void> }
  | { toolCall: { name: string; arguments: Record<string, unknown> }; hold?: Promise<void> };

export interface ScriptedModel {
  baseUrl: string;
  requests: ScriptedRequest[];
  stop(): void;
}

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : "")).join("");
}

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
      const raw = await req.text();
      const body = JSON.parse(raw) as {
        tools?: { function?: { name?: string; description?: string; parameters?: unknown } }[];
        messages?: ScriptedRequest["messages"];
      };
      const toolDefinitions = (body.tools ?? []).map((tool) => ({
        name: tool.function?.name ?? "",
        description: tool.function?.description ?? "",
        parameters: tool.function?.parameters,
      }));
      const toolJson: Record<string, string> = Object.fromEntries((body.tools ?? []).map((tool) => [tool.function?.name ?? "", JSON.stringify(tool)]));
      const toolBytes = Object.fromEntries(Object.entries(toolJson).map(([name, text]) => [name, Buffer.byteLength(text)]));
      const request: ScriptedRequest = {
        tools: toolDefinitions.map((tool) => tool.name),
        toolDefinitions,
        messages: body.messages ?? [],
        bodyBytes: Buffer.byteLength(raw),
        toolBytes,
        toolJson,
      };
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
