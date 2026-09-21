import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AGENT_TERMINAL_WEBTUI_VERSION,
  buildAgentTerminalRuntimePackageJson,
  installAgentTerminalRuntime,
  resolveBundledAgentTerminalSidecarPath,
  verifyAgentTerminalNativeBinary,
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

  test("runtime manifest approves node-pty install scripts by name", () => {
    const manifest = buildAgentTerminalRuntimePackageJson() as {
      allowScripts?: Record<string, unknown>;
    };

    // npm 12 blocks dependency install scripts unless the installing project
    // names the package (#1409). Name-only is load-bearing: npm matches these
    // keys as exact strings, so `node-pty@1.1.0` would stop matching as soon
    // as webtui's `^1.1.0` range resolved to a newer patch.
    expect(manifest.allowScripts?.["node-pty"]).toBe(true);
    expect(Object.keys(manifest.allowScripts ?? {})).toEqual(["node-pty"]);
  });

  test("native binary check accepts either a compiled build or a platform prebuild", () => {
    const packageDir = join(tmp, "node_modules", "node-pty");

    const compiled = join(packageDir, "build", "Release");
    mkdirSync(compiled, { recursive: true });
    writeFileSync(join(compiled, "pty.node"), "");
    expect(verifyAgentTerminalNativeBinary(tmp).ok).toBe(true);
    rmSync(join(packageDir, "build"), { recursive: true, force: true });

    const prebuild = join(packageDir, "prebuilds", `${process.platform}-${process.arch}`);
    mkdirSync(prebuild, { recursive: true });
    writeFileSync(join(prebuild, "pty.node"), "");
    expect(verifyAgentTerminalNativeBinary(tmp).ok).toBe(true);
  });

  test("native binary check reports blocked install scripts when node-pty was not built", () => {
    mkdirSync(join(tmp, "node_modules", "node-pty"), { recursive: true });

    const result = verifyAgentTerminalNativeBinary(tmp);
    expect(result.ok).toBe(false);
    // The remedy has to be in the message: npm's blocking is silent, so this
    // is the only place a user learns why an install that exited 0 cannot run.
    const message = result.ok ? "" : result.message;
    expect(message).toContain("install scripts");
    expect(message).toContain("npm rebuild node-pty");
    expect(message).toContain(tmp);
  });

  test("native binary check stays out of the way when node-pty is not in the tree", () => {
    expect(verifyAgentTerminalNativeBinary(tmp).ok).toBe(true);
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
