import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { closeServer, occupyConsecutivePorts } from "../../tests/helpers/ports";
import { runCliPlanReview } from "./cli-bridge";

const envKeys = [
  "PLANNOTATOR_BIN",
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_SKIP_BROWSER_OPEN",
  "PLANNOTATOR_TEST_CLI_MODE",
] as const;
const environment = createTestEnvironment(envKeys, "plannotator-opencode-cli-cancel-");
const fixturePath = fileURLToPath(new URL("./fixtures/test-plan-cli.ts", import.meta.url));

afterEach(() => environment.restore());

async function prepareCliEnvironment(): Promise<number> {
  environment.reset();
  const { start, servers } = await occupyConsecutivePorts(1);
  await closeServer(servers[0]);
  process.env.PLANNOTATOR_BIN = fixturePath;
  process.env.PLANNOTATOR_PORT = String(start);
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_SKIP_BROWSER_OPEN = "1";
  return start;
}

function readyClient(): {
  client: { app: { log: (entry: { message: string }) => void } };
  ready: Promise<string>;
} {
  let resolveReady: (url: string) => void = () => {};
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });
  return {
    client: {
      app: {
        log: (entry) => {
          const url = entry.message.match(/http:\/\/localhost:\d+/)?.[0];
          if (url) resolveReady(url);
        },
      },
    },
    ready,
  };
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Timed out waiting for CLI fixture")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function expectRejectedWith(
  promise: Promise<unknown>,
  expected: unknown,
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    expect(error).toBe(expected);
  }
}

async function expectPortReusable(port: number): Promise<void> {
  const replacement = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => new Response("reused"),
  });
  await replacement.stop(true);
}

describe("OpenCode CLI plan-review lifetime", () => {
  test("cancellation terminates the CLI child before returning", async () => {
    const port = await prepareCliEnvironment();
    const observed = readyClient();
    const controller = new AbortController();
    const review = runCliPlanReview({
      client: observed.client,
      planContent: "# CLI cancellation",
      timeoutSeconds: null,
      abortSignal: controller.signal,
    });

    expect(await waitWithTimeout(observed.ready, 3000)).toBe(`http://localhost:${port}`);
    const abortReason = new DOMException("Cancelled by OpenCode", "AbortError");
    controller.abort(abortReason);
    await expectRejectedWith(review, abortReason);
    await expectPortReusable(port);
  });

  test("a CLI failure after binding still cleans up bridge resources", async () => {
    const port = await prepareCliEnvironment();
    process.env.PLANNOTATOR_TEST_CLI_MODE = "fail-after-ready";
    const review = runCliPlanReview({
      client: { app: { log: () => {} } },
      planContent: "# CLI failure",
      timeoutSeconds: null,
      abortSignal: new AbortController().signal,
    });

    await expect(review).rejects.toThrow("fixture failed after binding");
    await expectPortReusable(port);
  });
});
