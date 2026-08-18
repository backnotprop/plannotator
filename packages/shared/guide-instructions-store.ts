/**
 * Guided Review standing instructions (#1265), persisted server-side in the
 * data dir (like review-skills.json) rather than a browser cookie: the text
 * is consumed by the SERVER at guide-launch time, a disk file has no
 * per-cookie size ceiling or encoding inflation, and the preference follows
 * the machine rather than one browser profile.
 */
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

/** Stored standing instructions, or "" when none are set or unreadable. */
export function readGuideInstructions(): string {
  try {
    return bound(readFileSync(instructionsPath(), "utf8"));
  } catch {
    return "";
  }
}

/**
 * Persist the instructions (trimmed, bounded) and return what was stored.
 * Blank input deletes the file entirely rather than persisting whitespace.
 */
export function writeGuideInstructions(value: string): string {
  const bounded = bound(value);
  const path = instructionsPath();
  if (bounded === "") {
    try {
      unlinkSync(path);
    } catch {
      // Already absent: deleting nothing is the desired end state.
    }
    return "";
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bounded + "\n", "utf8");
  return bounded;
}

/**
 * The instructions a guide launch should use: explicit launch-body text wins
 * (the launch page sends its live textarea value, so a just-typed preference
 * can never race the persistence write), otherwise the stored standing
 * instructions. Undefined when neither yields text, keeping instruction-less
 * launches byte-identical to pre-feature prompts.
 */
export function resolveGuideLaunchInstructions(explicit?: unknown): string | undefined {
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit;
  const stored = readGuideInstructions();
  return stored === "" ? undefined : stored;
}
