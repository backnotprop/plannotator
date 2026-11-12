import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPlannotatorDataDir } from "./data-dir";
import { GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS } from "./guide";

function instructionsPath(): string {
  return join(getPlannotatorDataDir(), "guide-instructions.md");
}

function bound(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS
    ? trimmed.slice(0, GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS)
    : trimmed;
}

export function readGuideInstructions(): string {
  try {
    return bound(readFileSync(instructionsPath(), "utf8"));
  } catch {
    return "";
  }
}

export function writeGuideInstructions(value: string): string {
  const bounded = bound(value);
  const path = instructionsPath();
  if (bounded === "") {
    try {
      unlinkSync(path);
    } catch {
    }
    return "";
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bounded + "\n", "utf8");
  return bounded;
}

export function resolveGuideLaunchInstructions(explicit?: unknown): string | undefined {
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit;
  const stored = readGuideInstructions();
  return stored === "" ? undefined : stored;
}
