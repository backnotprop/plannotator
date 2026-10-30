import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { closeServer, occupyConsecutivePorts } from "../../tests/helpers/ports";
import { runEmbeddedPlanReview } from "./embedded";

const envKeys = [
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_SKIP_BROWSER_OPEN",
] as const;
const environment = createTestEnvironment(envKeys, "plannotator-opencode-lifecycle-");
const client = {
  app: {
    agents: async () => ({ data: [] }),
  },
};

afterEach(() => environment.restore());

async function useFreeFixedPort(): Promise<number> {
  const { start, servers } = await occupyConsecutivePorts(1);
  await closeServer(servers[0]);
  process.env.PLANNOTATOR_PORT = String(start);
  return start;
}

function prepareEnvironment(): void {
  environment.reset();
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_SKIP_BROWSER_OPEN = "1";
  process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
}

function readyObserver(): {
  ready: Promise<string>;
  logReady: (url: string) => void;
} {
  let resolveReady: (url: string) => void = () => {};
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });
  return { ready, logReady: resolveReady };
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

/** The `plannotator sessions` entries this process's in-process servers hold. */
function listedEntries(): string[] {
  try {
    return readdirSync(join(process.env.PLANNOTATOR_DATA_DIR!, "sessions", "opencode"));
  } catch {
    return [];
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

describe("OpenCode embedded plan-review lifetime", () => {
  test("cancellation releases a fixed port for an immediate denied resubmission", async () => {
    prepareEnvironment();
    const port = await useFreeFixedPort();
    const firstReady = readyObserver();
    const firstController = new AbortController();
    const firstReview = runEmbeddedPlanReview({
      client,
      planContent: "# First plan",
      sharingEnabled: false,
      htmlContent: "<!doctype html><html><body>plan</body></html>",
      timeoutSeconds: null,
      abortSignal: firstController.signal,
      logReady: firstReady.logReady,
    });

    const firstUrl = await firstReady.ready;
    expect(firstUrl).toBe(`http://localhost:${port}`);
    const shownPlan = await fetch(`${firstUrl}/api/plan`);
    expect(shownPlan.status).toBe(200);
    // #1057: submit_plan delivers an approval's notes, so the tab offers them.
    expect(((await shownPlan.json()) as { approvalNotesSupported?: boolean }).approvalNotesSupported).toBe(true);
    for (let i = 0; i < 100 && listedEntries().length === 0; i++) await Bun.sleep(20);
    expect(listedEntries()).toEqual([`${process.pid}-${port}.json`]);
    const abortReason = new DOMException("Cancelled by OpenCode", "AbortError");
    firstController.abort(abortReason);
    await expectRejectedWith(firstReview, abortReason);
    expect(listedEntries()).toEqual([]);

    const secondReady = readyObserver();
    const secondController = new AbortController();
    const secondReview = runEmbeddedPlanReview({
      client,
      planContent: "# Revised plan",
      sharingEnabled: false,
      htmlContent: "<!doctype html><html><body>plan</body></html>",
      timeoutSeconds: null,
      abortSignal: secondController.signal,
      logReady: secondReady.logReady,
    });

    const secondUrl = await secondReady.ready;
    expect(secondUrl).toBe(`http://localhost:${port}`);
    const response = await fetch(`${secondUrl}/api/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feedback: "Revise this plan",
        planSave: { enabled: false },
      }),
    });
    expect(response.status).toBe(200);
    await expect(secondReview).resolves.toEqual({
      approved: false,
      feedback: "Revise this plan",
    });
    await expectPortReusable(port);
  });

  test("keeps an unbounded review alive through normal approval", async () => {
    prepareEnvironment();
    const port = await useFreeFixedPort();
    const observed = readyObserver();
    const controller = new AbortController();
    const review = runEmbeddedPlanReview({
      client,
      planContent: "# Long-running plan",
      sharingEnabled: false,
      htmlContent: "<!doctype html><html><body>plan</body></html>",
      timeoutSeconds: null,
      abortSignal: controller.signal,
      logReady: observed.logReady,
    });

    const url = await observed.ready;
    expect(await Promise.race([
      review.then(() => "settled"),
      Bun.sleep(50).then(() => "waiting"),
    ])).toBe("waiting");
    const response = await fetch(`${url}/api/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planSave: { enabled: false } }),
    });
    expect(response.status).toBe(200);
    await expect(review).resolves.toEqual({ approved: true });
    expect(listedEntries()).toEqual([]);
    await expectPortReusable(port);
  });

  test("configured timeout returns feedback and releases the fixed port", async () => {
    prepareEnvironment();
    const port = await useFreeFixedPort();
    const observed = readyObserver();
    const review = runEmbeddedPlanReview({
      client,
      planContent: "# Timed plan",
      sharingEnabled: false,
      htmlContent: "<!doctype html><html><body>plan</body></html>",
      timeoutSeconds: 0.01,
      abortSignal: new AbortController().signal,
      logReady: observed.logReady,
    });

    await observed.ready;
    await expect(review).resolves.toEqual({
      approved: false,
      feedback: "[Plannotator] No response within 0.01 seconds. Port released automatically. Please call submit_plan again.",
    });
    expect(listedEntries()).toEqual([]);
    await expectPortReusable(port);
  });

  test("ready callback failure releases the server before rejecting", async () => {
    prepareEnvironment();
    const port = await useFreeFixedPort();
    const readyError = new Error("OpenCode ready notification failed");
    const review = runEmbeddedPlanReview({
      client,
      planContent: "# Ready failure",
      sharingEnabled: false,
      htmlContent: "<!doctype html><html><body>plan</body></html>",
      timeoutSeconds: null,
      abortSignal: new AbortController().signal,
      logReady: () => {
        throw readyError;
      },
    });

    await expectRejectedWith(review, readyError);
    await expectPortReusable(port);
  });
});
