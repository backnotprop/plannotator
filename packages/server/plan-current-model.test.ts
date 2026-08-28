import { afterEach, describe, expect, test } from "bun:test";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { startPlannotatorServer } from "./index";

const envKeys = [
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_DATA_DIR",
] as const;
const environment = createTestEnvironment(envKeys, "plannotator-current-model-");

afterEach(() => environment.restore());

describe("/api/plan currentModel", () => {
  test("includes currentModel when the caller supplies it", async () => {
    environment.reset();
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();

    const server = await startPlannotatorServer({
      plan: "# Current model test",
      origin: "opencode",
      htmlContent: "<!doctype html><html><body>plan</body></html>",
      currentModel: { providerID: "openai", modelID: "gpt-5.6-terra" },
    });

    try {
      const response = await fetch(`${server.url}/api/plan`);
      expect(response.status).toBe(200);
      const body = await response.json() as { currentModel?: unknown };
      expect(body.currentModel).toEqual({ providerID: "openai", modelID: "gpt-5.6-terra" });
    } finally {
      await server.stop();
    }
  });

  test("omits currentModel when the caller does not supply it", async () => {
    environment.reset();
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();

    const server = await startPlannotatorServer({
      plan: "# Current model test",
      origin: "opencode",
      htmlContent: "<!doctype html><html><body>plan</body></html>",
    });

    try {
      const response = await fetch(`${server.url}/api/plan`);
      expect(response.status).toBe(200);
      const body = await response.json() as { currentModel?: unknown };
      expect(body.currentModel).toBeUndefined();
    } finally {
      await server.stop();
    }
  });
});
