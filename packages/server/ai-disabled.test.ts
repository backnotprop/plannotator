import { expect, test } from "bun:test";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";

const SPA_HTML = "<!doctype html><html><body>test</body></html>";

interface RunningServer {
  readonly url: string;
  stop(): void;
}

async function verifyDisabledReviewServer(server: RunningServer): Promise<void> {
  const diffResponse = await fetch(`${server.url}/api/diff`);
  expect(diffResponse.status).toBe(200);
  const diff = await diffResponse.json() as Record<string, unknown>;
  expect(diff.aiEnabled).toBe(false);
  expect("aiReviewContext" in diff).toBe(false);

  const aiCapabilitiesResponse = await fetch(`${server.url}/api/ai/capabilities`);
  expect(aiCapabilitiesResponse.status).toBe(200);
  expect(await aiCapabilitiesResponse.json()).toEqual({
    available: false,
    providers: [],
  });

  const aiQueryResponse = await fetch(`${server.url}/api/ai/query`, { method: "POST" });
  expect(aiQueryResponse.status).toBe(503);
  expect(await aiQueryResponse.json()).toEqual({
    error: "AI backend not available",
  });

  const agentCapabilitiesResponse = await fetch(`${server.url}/api/agents/capabilities`);
  expect(agentCapabilitiesResponse.status).toBe(200);
  expect(await agentCapabilitiesResponse.json()).toEqual({
    mode: "review",
    providers: [],
    available: false,
  });

  const launchResponse = await fetch(`${server.url}/api/agents/jobs`, { method: "POST" });
  expect(launchResponse.status).toBe(503);
  expect(await launchResponse.json()).toEqual({
    error: "AI features disabled",
  });
}

test("PLANNOTATOR_AI=disabled disables review AI and agent-job endpoints", async () => {
  const previousAI = process.env.PLANNOTATOR_AI;
  const previousRemote = process.env.PLANNOTATOR_REMOTE;
  const previousPort = process.env.PLANNOTATOR_PORT;

  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_REMOTE = "0";
  delete process.env.PLANNOTATOR_PORT;

  const servers: RunningServer[] = [];
  try {
    servers.push(await startBunReviewServer({
      rawPatch: "",
      gitRef: "HEAD",
      origin: "claude-code",
      htmlContent: SPA_HTML,
    }));
    servers.push(await startPiReviewServer({
      rawPatch: "",
      gitRef: "HEAD",
      origin: "pi",
      htmlContent: SPA_HTML,
    }));

    for (const server of servers) {
      await verifyDisabledReviewServer(server);
    }
  } finally {
    for (const server of servers) server.stop();
    if (previousAI === undefined) delete process.env.PLANNOTATOR_AI;
    else process.env.PLANNOTATOR_AI = previousAI;
    if (previousRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = previousRemote;
    if (previousPort === undefined) delete process.env.PLANNOTATOR_PORT;
    else process.env.PLANNOTATOR_PORT = previousPort;
  }
}, 20_000);
