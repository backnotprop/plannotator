import type { CatalogModel } from "./model-catalog";

export const MODEL_FALLBACKS_CHECKED = "2026-11-13";

export const CLAUDE_EFFORT_IDS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface FallbackModelRow {
  id: string;
  label: string;
  default?: boolean;
  efforts?: readonly string[];
  defaultEffort?: string;
  fastMode?: boolean;
}

export const CLAUDE_FALLBACK_ROWS: readonly FallbackModelRow[] = [
  { id: "opus", label: "Opus (latest)", efforts: CLAUDE_EFFORT_IDS, defaultEffort: "high" },
  { id: "sonnet", label: "Sonnet (latest)", efforts: CLAUDE_EFFORT_IDS, defaultEffort: "high", default: true },
  { id: "fable", label: "Fable (latest)", efforts: CLAUDE_EFFORT_IDS, defaultEffort: "high" },
  { id: "haiku", label: "Haiku (latest)", efforts: CLAUDE_EFFORT_IDS, defaultEffort: "high" },
  { id: "claude-fable-5-2", label: "Fable 5.2", efforts: CLAUDE_EFFORT_IDS, defaultEffort: "high" },
  { id: "claude-opus-5-5", label: "Opus 5.5", efforts: CLAUDE_EFFORT_IDS, defaultEffort: "high" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: CLAUDE_EFFORT_IDS, defaultEffort: "high" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: CLAUDE_EFFORT_IDS, defaultEffort: "high" },
];

const CODEX_TO_ULTRA = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const CODEX_TO_MAX = ["low", "medium", "high", "xhigh", "max"] as const;

export const CODEX_FALLBACK_ROWS: readonly FallbackModelRow[] = [
  { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: CODEX_TO_ULTRA, defaultEffort: "medium", fastMode: true, default: true },
  { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: CODEX_TO_ULTRA, defaultEffort: "medium", fastMode: true },
  { id: "gpt-6.1-terra", label: "GPT-6.1-Terra", efforts: CODEX_TO_ULTRA, defaultEffort: "medium", fastMode: true },
  { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: CODEX_TO_MAX, defaultEffort: "medium", fastMode: true },
  { id: "gpt-6-sol", label: "GPT-6-Sol", efforts: CODEX_TO_ULTRA, defaultEffort: "medium", fastMode: true },
];

const EFFORT_WORDS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
};

export function catalogFromRows(rows: readonly FallbackModelRow[]): CatalogModel[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    ...(row.default ? { default: true } : {}),
    ...(row.efforts?.length
      ? {
          reasoningEfforts: row.efforts.map((id) => ({ id, label: EFFORT_WORDS[id] ?? id })),
          ...(row.defaultEffort ? { defaultReasoningEffort: row.defaultEffort } : {}),
        }
      : {}),
    ...(row.fastMode ? { fastMode: true } : {}),
  }));
}
