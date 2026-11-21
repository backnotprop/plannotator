/**
 * The Bun review server's guide routes take an id from the path. A malformed
 * escape in it (`/api/guide/%`) once threw a URIError that Bun turned into a
 * plain-text 500; it answers a JSON 400 now, and a well-formed id still
 * reaches the route. The Pi mirror is apps/pi-extension/server/guide-malformed-path.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_BROWSER } from "../../tests/helpers/no-browser.ts";
import { startReviewServer } from "./review";

const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_BROWSER"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir = "";

beforeAll(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-guide-malformed-path-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  delete process.env.PLANNOTATOR_PORT;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

/** Every route that decodes an id from the path, each with a malformed escape. */
const MALFORMED: Array<[method: string, path: string]> = [
  ["GET", "/api/guide/%"],
  ["PUT", "/api/guide/%E0%A4%A/reviewed"],
  ["GET", "/api/guide/%/export"],
  ["GET", "/api/guide/%/export-info"],
  ["GET", "/api/guide/%/share-info"],
  ["POST", "/api/guide/%/share"],
  ["DELETE", "/api/guide/%/share"],
  ["DELETE", "/api/guides/%"],
];

describe("Bun review: a malformed escape in a guide route's id", () => {
  test("answers 400 with a JSON error on every guide route, and a valid id still reaches its route", async () => {
    const server = await startReviewServer({ rawPatch: "", gitRef: "HEAD", origin: "claude-code", htmlContent: "<html></html>" });
    try {
      for (const [method, path] of MALFORMED) {
        const res = await fetch(`${server.url}${path}`, { method, headers: { "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 400 });
        expect(await res.json()).toEqual({ error: "malformed URL encoding" });
      }
      const valid = await fetch(`${server.url}/api/guide/no%20such%20job`);
      expect(valid.status).toBe(404);
      expect(await valid.json()).toEqual({ error: "Guide not found" });
    } finally {
      server.stop();
    }
  });
});
