import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PRODUCT_FEEDBACK_URL, productFeedbackUrl } from "../packages/core/product-feedback";

const repoRoot = resolve(import.meta.dir, "..");
const liveHost = new URL(PRODUCT_FEEDBACK_URL).host;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".wrangler", ".claude", ".turbo"]);

function testFiles(dir: string, inTests = false): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return testFiles(full, inTests || name === "tests" || name === "test");
    if (!/\.(?:[cm]?[jt]sx?)$/.test(name)) return [];
    return inTests || /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ? [full] : [];
  });
}

describe("the live feedback Worker is out of reach of tests", () => {
  test("the preload sends feedback to a closed loopback port", () => {
    expect(process.env.PLANNOTATOR_FEEDBACK_URL).toBe("http://127.0.0.1:9/feedback");
    expect(productFeedbackUrl(process.env)).toBe("http://127.0.0.1:9/feedback");
  });

  const files = () => [...testFiles(join(repoRoot, "apps")), ...testFiles(join(repoRoot, "packages")), ...testFiles(join(repoRoot, "tests"), true), ...testFiles(join(repoRoot, "scripts"))];

  test("no test file names the live host", () => {
    const all = files();
    expect(all.length).toBeGreaterThan(100);
    const naming = all.filter((file) => readFileSync(file, "utf-8").includes(liveHost)).map((file) => relative(repoRoot, file));
    expect(naming).toEqual([]);
  });

  test("a test or spec that drives a Send names where it goes", () => {
    const drives =
      /data-feedback-|data-dialog="feedback"|data-dialog=\\?"feedback|ib-fbk|\/api\/inbox\/feedback|sendFeedback\(|runFeedbackCommand\(|(?:index\.ts|entry|plannotator|bin)["'`)]*\s*,\s*["']feedback["']/;
    const names = /PLANNOTATOR_FEEDBACK_URL|feedbackUrl|globalThis\.fetch\s*=/;
    const self = relative(repoRoot, import.meta.path);
    const driving = files()
      .map((file) => ({ file: relative(repoRoot, file), text: readFileSync(file, "utf-8") }))
      .filter(({ file, text }) => file !== self && drives.test(text));
    expect(driving.map((d) => d.file)).toEqual(expect.arrayContaining(["apps/hook/server/feedback-command.test.ts", "packages/server/inbox-feedback.test.ts", "packages/inbox/feedbackDialog.test.tsx"]));
    expect(driving.filter(({ text }) => !names.test(text)).map((d) => d.file)).toEqual([]);
  });
});
