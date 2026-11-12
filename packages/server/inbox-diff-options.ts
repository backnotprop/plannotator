import type { DiffOptions } from "@plannotator/core/config-types";

export interface InboxDiffOptions {
  diff_style: "split" | "unified" | null;
  overflow: "scroll" | "wrap" | null;
  indicators: "bars" | "classic" | "none" | null;
  line_diff_type: "word-alt" | "word" | "char" | "none" | null;
  line_numbers: boolean | null;
  background: boolean | null;
  background_intensity: "subtle" | "normal" | "strong" | null;
  tab_size: number | null;
}

type WireKey = keyof InboxDiffOptions;

interface Field {
  config: keyof DiffOptions;
  read: (value: unknown) => unknown;
  rule: string;
}

const oneOf = (...values: string[]) => (value: unknown) => (typeof value === "string" && values.includes(value) ? value : undefined);
const bool = (value: unknown) => (typeof value === "boolean" ? value : undefined);

export const INBOX_DIFF_OPTION_FIELDS: Record<WireKey, Field> = {
  diff_style: { config: "diffStyle", read: oneOf("split", "unified"), rule: "split or unified" },
  overflow: { config: "overflow", read: oneOf("scroll", "wrap"), rule: "scroll or wrap" },
  indicators: { config: "diffIndicators", read: oneOf("bars", "classic", "none"), rule: "bars, classic or none" },
  line_diff_type: { config: "lineDiffType", read: oneOf("word-alt", "word", "char", "none"), rule: "word-alt, word, char or none" },
  line_numbers: { config: "showLineNumbers", read: bool, rule: "true or false" },
  background: { config: "showDiffBackground", read: bool, rule: "true or false" },
  background_intensity: { config: "lineBgIntensity", read: oneOf("subtle", "normal", "strong"), rule: "subtle, normal or strong" },
  tab_size: { config: "tabSize", read: (value) => (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 8 ? value : undefined), rule: "a whole number from 1 to 8" },
};

const WIRE_KEYS = Object.keys(INBOX_DIFF_OPTION_FIELDS) as WireKey[];

export function inboxDiffOptionsOf(diffOptions: DiffOptions | undefined): InboxDiffOptions {
  const out = {} as Record<WireKey, unknown>;
  for (const key of WIRE_KEYS) {
    const field = INBOX_DIFF_OPTION_FIELDS[key];
    out[key] = field.read((diffOptions as Record<string, unknown> | undefined)?.[field.config]) ?? null;
  }
  return out as unknown as InboxDiffOptions;
}

export type InboxDiffOptionsParse =
  | { ok: true; diffOptions: Partial<DiffOptions> }
  | { ok: false; field: string; error: string };

export function parseInboxDiffOptionsChange(body: { diff_options?: unknown; diff_style?: unknown }): InboxDiffOptionsParse {
  const out: Partial<DiffOptions> = {};
  if (body.diff_options !== undefined) {
    const input = body.diff_options;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, field: "diff_options", error: `diff_options: an object with any of ${WIRE_KEYS.join(", ")}.` };
    }
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) return { ok: false, field: "diff_options", error: `diff_options: at least one of ${WIRE_KEYS.join(", ")}.` };
    for (const [key, value] of entries) {
      const field = Object.hasOwn(INBOX_DIFF_OPTION_FIELDS, key) ? INBOX_DIFF_OPTION_FIELDS[key as WireKey] : undefined;
      if (!field) return { ok: false, field: `diff_options.${key}`, error: `diff_options.${key}: not a diff option; use ${WIRE_KEYS.join(", ")}.` };
      const valid = field.read(value);
      if (valid === undefined) return { ok: false, field: `diff_options.${key}`, error: `diff_options.${key}: ${field.rule}.` };
      (out as Record<string, unknown>)[field.config] = valid;
    }
  }
  if (body.diff_style !== undefined) {
    const style = INBOX_DIFF_OPTION_FIELDS.diff_style.read(body.diff_style);
    if (style === undefined) return { ok: false, field: "diff_style", error: "diff_style: split or unified." };
    if (out.diffStyle !== undefined && out.diffStyle !== style) {
      return { ok: false, field: "diff_style", error: "diff_style and diff_options.diff_style disagree: send one." };
    }
    out.diffStyle = style as DiffOptions["diffStyle"];
  }
  return { ok: true, diffOptions: out };
}

export function inboxDiffOptionsSaved(change: Partial<DiffOptions>, saved: DiffOptions | undefined): boolean {
  return Object.entries(change).every(([key, value]) => (saved as Record<string, unknown> | undefined)?.[key] === value);
}
