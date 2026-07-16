import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AGENT_TERMINAL_WEBTUI_VERSION,
  installAgentTerminalRuntime,
  resolveBundledAgentTerminalSidecarPath,
} from "./agent-terminal-runtime";

let tmp = "";

beforeEach(() => {
  tmp = join(tmpdir(), `plannotator-agent-runtime-${randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("agent terminal runtime", () => {
  test("uses a bundled sidecar only when it exists next to the module", () => {
    const embeddedUrl = pathToFileURL(join(tmp, "embedded.js")).href;

    expect(resolveBundledAgentTerminalSidecarPath(embeddedUrl)).toBeNull();

    const sidecarPath = join(tmp, "agent-terminal-node-sidecar.mjs");
    writeFileSync(sidecarPath, "export {};\n");

    expect(resolveBundledAgentTerminalSidecarPath(embeddedUrl)).toBe(sidecarPath);
  });

  test("does not treat ordinary paths containing $bunfs as virtual", () => {
    const normalDir = join(tmp, "fixtures", "$bunfs");
    mkdirSync(normalDir, { recursive: true });
    const embeddedUrl = pathToFileURL(join(normalDir, "embedded.js")).href;
    const sidecarPath = join(normalDir, "agent-terminal-node-sidecar.mjs");
    writeFileSync(sidecarPath, "export {};\n");

    expect(resolveBundledAgentTerminalSidecarPath(embeddedUrl)).toBe(sidecarPath);
  });

  test("does not hand Node a Bun virtual sidecar path", () => {
    expect(resolveBundledAgentTerminalSidecarPath("file:///$bunfs/embedded.js")).toBeNull();
    expect(resolveBundledAgentTerminalSidecarPath("file:///B:/~BUN/embedded.js")).toBeNull();
    expect(resolveBundledAgentTerminalSidecarPath("file:///B:/$bunfs/embedded.js")).toBeNull();
  });

  test("install runtime reports filesystem failures instead of throwing", async () => {
    const dataFile = join(tmp, "data-file");
    writeFileSync(dataFile, "not a directory");
    const previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = dataFile;
    try {
      const result = await installAgentTerminalRuntime();
      expect(result.ok).toBe(false);
      expect(result.status).toBe("failed");
    } finally {
      if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
    }
  });

  test("WebTUI vendor version is pinned consistently", () => {
    const repoRoot = join(import.meta.dir, "..", "..");
    const manifests = [
      "packages/server/package.json",
      "packages/editor/package.json",
      "apps/pi-extension/package.json",
    ];

    for (const manifest of manifests) {
      const parsed = JSON.parse(readFileSync(join(repoRoot, manifest), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      expect(parsed.dependencies?.["@plannotator/webtui"]).toBe(AGENT_TERMINAL_WEBTUI_VERSION);
    }

    const releaseWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    const workflowVersions = [...releaseWorkflow.matchAll(/webtui-(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
    expect(workflowVersions.length).toBeGreaterThanOrEqual(2);
    expect(new Set(workflowVersions)).toEqual(new Set([AGENT_TERMINAL_WEBTUI_VERSION]));
  });
});
