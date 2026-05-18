/**
 * Runtime Route Ownership Test
 *
 * The Bun server is now the only Plannotator UI server runtime. This test
 * keeps coverage that the canonical server still exposes routes while proving
 * Pi no longer ships a mirrored node:http route implementation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");

// --- Route extraction ---

/** Extract url.pathname === "/path" and url.pathname.startsWith("/path") */
function extractInlineRoutes(filePath: string): string[] {
  const src = readFileSync(filePath, "utf-8");
  const routes: string[] = [];
  const re = /url\.pathname\s*(?:===|\.startsWith\()\s*["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    routes.push(m[1]);
  }
  return routes;
}

/** Extract AI endpoint object keys: "/api/ai/foo": async ... */
function extractAIEndpointKeys(filePath: string): string[] {
  const src = readFileSync(filePath, "utf-8");
  const routes: string[] = [];
  const re = /"(\/api\/ai\/[^"]+)"\s*:\s*async/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    routes.push(m[1]);
  }
  return routes;
}

function unique(routes: string[]): string[] {
  return [...new Set(routes)].sort();
}

// --- File paths ---

const bun = {
  plan: join(ROOT, "packages/server/index.ts"),
  review: join(ROOT, "packages/server/review.ts"),
  annotate: join(ROOT, "packages/server/annotate.ts"),
  editorAnnotations: join(ROOT, "packages/server/editor-annotations.ts"),
};

const pi = {
  plan: join(ROOT, "apps/pi-extension/server/serverPlan.ts"),
  review: join(ROOT, "apps/pi-extension/server/serverReview.ts"),
  annotate: join(ROOT, "apps/pi-extension/server/serverAnnotate.ts"),
  editorAnnotations: join(ROOT, "apps/pi-extension/server/annotations.ts"),
  serverDir: join(ROOT, "apps/pi-extension/server"),
  serverBarrel: join(ROOT, "apps/pi-extension/server.ts"),
};

const aiEndpointsFile = join(ROOT, "packages/ai/endpoints.ts");

// --- Tests ---

describe("route ownership: Bun server only", () => {
  test("canonical Bun route files still expose API routes", () => {
    expect(unique(extractInlineRoutes(bun.plan)).length).toBeGreaterThan(0);
    expect(unique(extractInlineRoutes(bun.review)).length).toBeGreaterThan(0);
    expect(unique(extractInlineRoutes(bun.annotate)).length).toBeGreaterThan(0);
    expect(unique(extractInlineRoutes(bun.editorAnnotations)).length).toBeGreaterThan(0);
  });

  test("Pi mirrored route files are absent", () => {
    expect(existsSync(pi.serverDir)).toBe(false);
    expect(existsSync(pi.serverBarrel)).toBe(false);
    expect(existsSync(pi.plan)).toBe(false);
    expect(existsSync(pi.review)).toBe(false);
    expect(existsSync(pi.annotate)).toBe(false);
    expect(existsSync(pi.editorAnnotations)).toBe(false);
  });

  test("AI endpoint keys are present (shared file)", () => {
    const routes = extractAIEndpointKeys(aiEndpointsFile);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes).toContain("/api/ai/capabilities");
    expect(routes).toContain("/api/ai/session");
    expect(routes).toContain("/api/ai/query");
    expect(routes).toContain("/api/ai/abort");
    expect(routes).toContain("/api/ai/permission");
    expect(routes).toContain("/api/ai/sessions");
  });

  test("canonical Bun routes cover all server surfaces", () => {
    const bunAll = unique([
      ...extractInlineRoutes(bun.plan),
      ...extractInlineRoutes(bun.review),
      ...extractInlineRoutes(bun.annotate),
      ...extractInlineRoutes(bun.editorAnnotations),
      ...extractAIEndpointKeys(aiEndpointsFile),
    ]);

    expect(bunAll).toContain("/api/plan");
    expect(bunAll).toContain("/api/diff");
    expect(bunAll).toContain("/api/feedback");
    expect(bunAll).toContain("/api/ai/query");
  });
});
