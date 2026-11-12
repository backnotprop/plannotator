import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");

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
};

const aiEndpointsFile = join(ROOT, "packages/ai/endpoints.ts");

describe("route parity: Bun ↔ Pi", () => {
  test("plan server routes match", () => {
    const bunRoutes = unique(extractInlineRoutes(bun.plan));
    const piRoutes = unique(extractInlineRoutes(pi.plan));
    expect(piRoutes).toEqual(bunRoutes);
  });

  test("review server routes match", () => {
    const bunRoutes = unique(extractInlineRoutes(bun.review));
    const piRoutes = unique(extractInlineRoutes(pi.review));
    expect(piRoutes).toEqual(bunRoutes);
  });

  test("annotate server routes match", () => {
    const bunRoutes = unique(extractInlineRoutes(bun.annotate));
    const piRoutes = unique(extractInlineRoutes(pi.annotate));
    expect(piRoutes).toEqual(bunRoutes);
  });

  test("editor annotation routes match", () => {
    const bunRoutes = unique(extractInlineRoutes(bun.editorAnnotations));
    const piRoutes = unique(extractInlineRoutes(pi.editorAnnotations));
    expect(piRoutes).toEqual(bunRoutes);
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

  test("all routes across all servers match", () => {
    const bunAll = unique([
      ...extractInlineRoutes(bun.plan),
      ...extractInlineRoutes(bun.review),
      ...extractInlineRoutes(bun.annotate),
      ...extractInlineRoutes(bun.editorAnnotations),
      ...extractAIEndpointKeys(aiEndpointsFile),
    ]);

    const piAll = unique([
      ...extractInlineRoutes(pi.plan),
      ...extractInlineRoutes(pi.review),
      ...extractInlineRoutes(pi.annotate),
      ...extractInlineRoutes(pi.editorAnnotations),
      ...extractAIEndpointKeys(aiEndpointsFile),
    ]);

    expect(piAll).toEqual(bunAll);
  });
});
