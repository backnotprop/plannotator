/**
 * Bun test preload — runs in every worker, but only the first one builds
 * the binary. Subsequent workers wait for the marker file then reuse it.
 *
 * This prevents N spec files from each spawning their own full build.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const DIR = join(tmpdir(), "plannotator-e2e");
const LOCK = join(DIR, "build.lock");
const MARKER = join(DIR, "binary.path");
const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const BINARY_INPUTS = [
  "apps/hook",
  "packages/server",
  "packages/ui",
  "packages/editor",
  "packages/review-editor",
  "packages/shared",
  "package.json",
  "bunfig.toml",
];

function newestInputMtimeMs(): number {
  let newest = 0;
  const skipNames = new Set([".git", "dist", "node_modules"]);
  const stack = BINARY_INPUTS.map((relativePath) => join(repoRoot, relativePath)).filter(existsSync);

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const stat = statSync(current);
    newest = Math.max(newest, stat.mtimeMs);
    if (!stat.isDirectory()) {
      continue;
    }

    for (const entry of readdirSync(current)) {
      if (skipNames.has(entry)) {
        continue;
      }
      stack.push(join(current, entry));
    }
  }

  return newest;
}

function isFreshBinary(binaryPath: string): boolean {
  if (!existsSync(binaryPath)) {
    return false;
  }

  return statSync(binaryPath).mtimeMs >= newestInputMtimeMs();
}

async function waitForMarker(timeoutMs = 300_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(MARKER)) {
      const p = readFileSync(MARKER, "utf8").trim();
      if (existsSync(p)) {
        return p;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for plannotator e2e binary to be built (${timeoutMs}ms)`);
}

// Runs before any test in this worker.
const { buildBinary } = await import("./helpers/daemon");

try {
  mkdirSync(DIR, { recursive: true });
} catch {}

// Fast path: already built.
if (existsSync(MARKER)) {
  const cached = readFileSync(MARKER, "utf8").trim();
  if (isFreshBinary(cached)) {
    process.env.PLANNOTATOR_E2E_BINARY = cached;
    // Done — workers proceed immediately.
  } else {
    // Missing or stale marker target, rebuild below.
    process.env.PLANNOTATOR_E2E_BINARY = await buildBinary();
    writeFileSync(MARKER, process.env.PLANNOTATOR_E2E_BINARY, "utf8");
  }
} else if (existsSync(LOCK)) {
  // Another worker is building — wait for it to write the marker.
  // If the lock is stale (builder crashed), waitForMarker will timeout with a clear error.
  process.env.PLANNOTATOR_E2E_BINARY = await waitForMarker();
} else {
  // We are first — claim the lock and build.
  writeFileSync(LOCK, String(process.pid), "utf8");
  const binaryPath = await buildBinary();
  writeFileSync(MARKER, binaryPath, "utf8");
  process.env.PLANNOTATOR_E2E_BINARY = binaryPath;
}
