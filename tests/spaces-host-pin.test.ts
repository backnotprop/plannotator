/**
 * Nothing in the test suite can reach a Spaces host. What regresses if this fails: a test (or a server a test
 * starts) could send a plan, or a sign-in, to a real machine.
 *
 * Three walls, each checked here:
 * 1. The product's default address resolves nowhere (`.invalid`), and plain http is taken on this computer only.
 * 2. Every test process is pinned to a closed loopback port (the bun preload, the Playwright config and its global
 *    setup), so a server started with the test's environment resolves to it.
 * 3. No test file names another address for it: every `PLANNOTATOR_SPACES_URL` or `spacesUrl` value written in a
 *    test, a spec or a helper is on this computer, or a reserved name that cannot resolve (`.example`, `.invalid`,
 *    `.test`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SPACES_URL, isLoopbackSpacesUrl, normalizeSpacesUrl, resolveSpacesUrl } from "../packages/shared/spaces/url";

const root = join(import.meta.dir, "..");
const DEAD = "http://127.0.0.1:9";

const safe = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return isLoopbackSpacesUrl(url) || /\.(example|invalid|test)$/.test(host);
  } catch {
    return false;
  }
};

/** The addresses a source text gives a Spaces setting, as written. */
export function spacesAddressesIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:PLANNOTATOR_SPACES_URL|spacesUrl)\b[^\n]{0,80}?["'`](https?:\/\/[^"'`\s]+)["'`]/g)) found.push(match[1]!);
  return found;
}

describe("no test reaches a Spaces host", () => {
  test("the default resolves nowhere, and plain http is this computer's only", () => {
    expect(new URL(DEFAULT_SPACES_URL).hostname.endsWith(".invalid")).toBe(true);
    expect(normalizeSpacesUrl("http://spaces.example")).toBeNull();
    expect(normalizeSpacesUrl("http://10.0.0.5:8787")).toBeNull();
  });

  test("this test process is pinned to a closed loopback port", () => {
    expect(process.env.PLANNOTATOR_SPACES_URL).toBe(DEAD);
    expect(resolveSpacesUrl()).toBe(DEAD);
    expect(readFileSync(join(root, "tests/setup/feedback-archive-off.ts"), "utf8")).toContain(`process.env.PLANNOTATOR_SPACES_URL = "${DEAD}"`);
    for (const file of ["tests/e2e/playwright.config.ts", "tests/e2e/global-setup.ts"]) {
      expect(readFileSync(join(root, file), "utf8")).toContain(`process.env.PLANNOTATOR_SPACES_URL = '${DEAD}'`);
    }
  });

  test("no test, spec or helper names an address that is not on this computer", () => {
    const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.test.ts", "*.test.tsx", "*.spec.ts", "tests", "scripts"], { cwd: root });
    const files = new TextDecoder().decode(listed.stdout).split("\0").filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    const reaching: string[] = [];
    for (const file of files) {
      // This file writes such addresses on purpose, for the scan's own test below.
      if (file === "tests/spaces-host-pin.test.ts") continue;
      let text: string;
      try {
        text = readFileSync(join(root, file), "utf8");
      } catch {
        continue;
      }
      if (!text.includes("PLANNOTATOR_SPACES_URL") && !text.includes("spacesUrl")) continue;
      for (const address of spacesAddressesIn(text)) if (!safe(address)) reaching.push(`${file}: ${address}`);
    }
    expect(reaching).toEqual([]);
  });

  test("the scan sees an address that would reach out, and passes one that cannot", () => {
    expect(spacesAddressesIn(`env.PLANNOTATOR_SPACES_URL = "https://spaces.real-host.dev";`).filter((a) => !safe(a))).toHaveLength(1);
    expect(spacesAddressesIn(`{ spacesUrl: 'https://10.1.2.3' }`).filter((a) => !safe(a))).toHaveLength(1);
    expect(spacesAddressesIn(`PLANNOTATOR_SPACES_URL: "http://127.0.0.1:4010", spacesUrl: "https://a.example"`).filter((a) => !safe(a))).toHaveLength(0);
  });
});
