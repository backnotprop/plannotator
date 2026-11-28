/**
 * `plannotator theme …`: a person's own themes, from a shell (an agent's most of the time).
 *
 *   plannotator theme add <file> [--id <id>] [--name <name>]
 *       Read a theme file (Plannotator's format, a base16 scheme, or a VS Code colour theme; detected),
 *       validate it, and keep it as <data dir>/themes/<id>.json. Same id again: replaced.
 *   plannotator theme list [--json]       the custom themes, which half each is used for, and the built-ins
 *   plannotator theme remove <id>         move the file to themes/removed/; a half that used it goes back to Plannotator
 *   plannotator theme use <id> [--light | --dark]
 *       Assign a theme (custom or built-in) to the halves it has, or to one half, in config.json `theme`.
 *
 * Works with nothing running: it reads and writes the data dir. A page reads the themes when it loads
 * (`/plannotator-themes.js`, packages/shared/theme-files.ts) and config.json `theme` when it opens, so a new
 * review shows the change at once and an open window on reload.
 *
 * One line per result on stdout; a refusal is one line on stderr, `<code>: <message>`, naming the field that is
 * wrong. Exit 0 done, 1 refused, 2 bad usage.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BODY_TEXT_CONTRAST_NOTE_BELOW,
  CUSTOM_THEME_LIMIT,
  BUILT_IN_THEME_IDS,
  builtInThemeModeSupport,
  bodyTextContrast,
  missingThemeTokens,
  THEME_ID_PATTERN,
  themeFileModeSupport,
  validateThemeFile,
  type ThemeFile,
} from "@plannotator/core/theme-file";
import { importThemeText, type ThemeSourceFormat } from "@plannotator/core/theme-import";
import { customThemesDir, listCustomThemes, readCustomTheme, removeCustomTheme, saveCustomTheme } from "@plannotator/shared/theme-files";
import type { ThemeConfig } from "@plannotator/core/config-types";
import { THEME_COMMAND_USAGE } from "./cli";

export { THEME_COMMAND_USAGE };

/** The largest file `theme add` reads (a VS Code theme carries its syntax colours too). */
export const THEME_SOURCE_MAX_BYTES = 1024 * 1024;

export interface ThemeCommandDeps {
  dataDir: string;
  cwd: string;
  loadTheme: () => ThemeConfig | undefined;
  saveTheme: (theme: ThemeConfig) => boolean;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

const FORMAT_NAMES: Record<ThemeSourceFormat, string> = {
  plannotator: "a Plannotator theme",
  base16: "a base16 scheme",
  vscode: "a VS Code theme",
};

const halvesOf = (theme: Pick<ThemeFile, "dark" | "light">): ("dark" | "light")[] =>
  (["dark", "light"] as const).filter((half) => theme[half]);

const halvesText = (halves: string[]) => (halves.length === 2 ? "dark and light" : `${halves[0]} only`);

/** Take `--flag value` out of args; undefined when absent, null when given without a value. */
function takeValue(args: string[], flag: string): string | undefined | null {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = args[at + 1];
  args.splice(at, value === undefined || value.startsWith("--") ? 1 : 2);
  return value === undefined || value.startsWith("--") ? null : value;
}

function takeFlag(args: string[], flag: string): boolean {
  const at = args.indexOf(flag);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

export async function runThemeCommand(argv: string[], deps: ThemeCommandDeps): Promise<number> {
  const out = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const err = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const say = (line: string) => out(`${line}\n`);
  const refuse = (code: string, message: string) => {
    err(`${code}: ${message}\n`);
    return 1;
  };
  const usage = (message: string) => {
    err(`usage: ${message}\n\n${THEME_COMMAND_USAGE}\n`);
    return 2;
  };

  const args = [...argv];
  const sub = args.shift();
  if (sub === undefined) {
    err(`${THEME_COMMAND_USAGE}\n`);
    return 2;
  }
  if (sub === "--help" || sub === "-h" || args.includes("--help") || args.includes("-h")) {
    say(THEME_COMMAND_USAGE);
    return 0;
  }

  if (sub === "add") {
    const id = takeValue(args, "--id");
    const name = takeValue(args, "--name");
    if (id === null) return usage("--id needs a value.");
    if (name === null) return usage("--name needs a value.");
    const unknown = args.find((arg) => arg.startsWith("-"));
    if (unknown) return usage(`theme add does not take ${unknown}.`);
    if (args.length !== 1) return usage("theme add takes one file.");
    const file = resolve(deps.cwd, args[0]!);
    let text: string;
    try {
      const stat = statSync(file);
      if (!stat.isFile()) return refuse("unreadable", `${args[0]}: not a file.`);
      if (stat.size > THEME_SOURCE_MAX_BYTES) return refuse("unreadable", `${args[0]}: larger than ${THEME_SOURCE_MAX_BYTES / 1024} KB; a theme file is far smaller.`);
      text = readFileSync(file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return refuse("unreadable", `${args[0]}: ${code === "ENOENT" ? "no such file" : e instanceof Error ? e.message : String(e)}.`);
    }
    const imported = importThemeText(text);
    if (!imported.ok) return refuse("invalid_theme", `${args[0]}: ${imported.field}: ${imported.message}`);
    // --id and --name replace what the file says (a converted theme's id comes from its name).
    const candidate = { ...(imported.theme as Record<string, unknown>) };
    if (id !== undefined) candidate.id = id;
    if (name !== undefined) candidate.name = name;
    const checked = validateThemeFile(candidate);
    if (!checked.ok) {
      const flag = (checked.problem.field === "id" && id !== undefined) || (checked.problem.field === "name" && name !== undefined);
      return refuse("invalid_theme", `${flag ? `--${checked.problem.field}` : `${args[0]}: ${checked.problem.field}`}: ${checked.problem.message}`);
    }
    let theme = checked.theme;
    // A converted theme's id comes from its name, not from the person: it never replaces a different theme.
    // Re-adding the same theme (same name) replaces it; another one takes the next free id (-2, -3, ...).
    if (id === undefined && imported.format !== "plannotator") theme = { ...theme, id: freeDerivedId(deps.dataDir, theme) };
    const saved = saveCustomTheme(deps.dataDir, theme);
    if (!saved.ok) return refuse(saved.code, saved.message);
    const from = imported.format === "plannotator" ? "" : `, converted from ${FORMAT_NAMES[imported.format]}`;
    say(`${saved.replaced ? "Replaced" : "Added"} theme "${theme.name}" (${theme.id})${from}: ${halvesText(halvesOf(theme))}. Use it: plannotator theme use ${theme.id}`);
    for (const half of halvesOf(theme)) {
      const missing = missingThemeTokens(theme[half]);
      if (missing.length > 0 && imported.format === "plannotator") {
        say(`Note: the ${half} half does not set ${missing.join(", ")}; those take Plannotator's own colours.`);
      }
    }
    if (imported.syntaxLeftOut) {
      say(`Note: ${imported.syntaxLeftOut} of the file's code colour rules were left out (a scope, colour or font style Plannotator does not take); the rest are kept.`);
    }
    for (const { half, ratio } of bodyTextContrast(theme)) {
      if (ratio < BODY_TEXT_CONTRAST_NOTE_BELOW) {
        say(`Note: in the ${half} half, body text on the background is ${ratio.toFixed(1)}:1, under the ${BODY_TEXT_CONTRAST_NOTE_BELOW}:1 most people need to read comfortably. Added as it is.`);
      }
    }
    return 0;
  }

  if (sub === "list") {
    const json = takeFlag(args, "--json");
    if (args.length > 0) return usage(`theme list does not take ${args[0]}.`);
    const { themes, skipped } = listCustomThemes(deps.dataDir);
    const inUse = deps.loadTheme() ?? {};
    const usedFor = (id: string) => (["light", "dark"] as const).filter((half) => inUse[half] === id);
    if (json) {
      say(JSON.stringify({
        custom: themes.map((theme) => ({ id: theme.id, name: theme.name, halves: halvesOf(theme), in_use: usedFor(theme.id) })),
        built_in: BUILT_IN_THEME_IDS,
        in_use: { mode: inUse.mode ?? null, light: inUse.light ?? null, dark: inUse.dark ?? null },
        skipped,
      }));
      return 0;
    }
    if (themes.length === 0) say("No custom themes. Add one: plannotator theme add <file>");
    for (const theme of themes) {
      const used = usedFor(theme.id);
      say(`${theme.id}  "${theme.name}"  ${halvesText(halvesOf(theme))}${used.length > 0 ? `  (in use: ${used.join(", ")})` : ""}`);
    }
    for (const { file, reason } of skipped) say(`Skipped themes/${file}: ${reason}`);
    say(`${BUILT_IN_THEME_IDS.length} built-in themes: ${BUILT_IN_THEME_IDS.join(", ")}`);
    return 0;
  }

  if (sub === "remove") {
    if (args.length !== 1 || args[0]!.startsWith("-")) return usage("theme remove takes one theme id.");
    const id = args[0]!;
    if (BUILT_IN_THEME_IDS.includes(id)) return refuse("built_in", `"${id}" is a built-in theme; only themes you added can be removed.`);
    const theme = readCustomTheme(deps.dataDir, id);
    let movedTo: string | null;
    try {
      movedTo = removeCustomTheme(deps.dataDir, id);
    } catch (err) {
      return refuse("not_removed", `could not move themes/${id}.json to themes/removed/ (${err instanceof Error ? err.message : String(err)}); nothing changed.`);
    }
    if (!movedTo) return refuse("not_found", `no custom theme "${id}" (plannotator theme list shows them).`);
    const inUse = deps.loadTheme() ?? {};
    const halves = (["dark", "light"] as const).filter((half) => inUse[half] === id);
    let back = "";
    if (halves.length > 0) {
      const reset: ThemeConfig = {};
      for (const half of halves) reset[half] = "plannotator";
      back = deps.saveTheme(reset)
        ? ` The ${halves.join(" and ")} ${halves.length === 2 ? "halves are" : "half is"} back on Plannotator.`
        : " config.json could not be saved, so it still names this theme; pages draw Plannotator in its place.";
    }
    say(`Removed theme ${theme ? `"${theme.name}" ` : ""}(${id}); its file is kept at ${movedTo}.${back}`);
    return 0;
  }

  if (sub === "use") {
    const light = takeFlag(args, "--light");
    const dark = takeFlag(args, "--dark");
    if (light && dark) return usage("--light or --dark, not both (with neither, every half the theme has).");
    if (args.length !== 1 || args[0]!.startsWith("-")) return usage("theme use takes one theme id.");
    const id = args[0]!;
    if (!THEME_ID_PATTERN.test(id)) return refuse("not_found", `"${id.slice(0, 64)}" is not a theme id (plannotator theme list shows them).`);
    const builtIn = BUILT_IN_THEME_IDS.includes(id);
    const custom = builtIn ? null : readCustomTheme(deps.dataDir, id);
    if (!builtIn && !custom) return refuse("not_found", `no theme "${id}" (plannotator theme list shows them).`);
    // A built-in draws the halves the registry says (27 are one mode); a custom theme, the halves its file has.
    const support = custom ? themeFileModeSupport(custom) : builtInThemeModeSupport(id)!;
    const has: ("dark" | "light")[] = support === "dark-only" ? ["dark"] : support === "light-only" ? ["light"] : ["dark", "light"];
    const asked = light ? ["light" as const] : dark ? ["dark" as const] : has;
    const missing = asked.find((half) => !has.includes(half));
    if (missing) return refuse("no_such_half", `"${id}" has no ${missing} half (it is ${support.replace("-", " ")}).`);
    const next: ThemeConfig = {};
    for (const half of asked) next[half] = id;
    if (!deps.saveTheme(next)) return refuse("not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix it first.");
    const mode = deps.loadTheme()?.mode;
    const label = custom ? `"${custom.name}" (${id})` : id;
    say(`Using ${label} for the ${asked.join(" and ")} ${asked.length === 2 ? "halves" : "half"}${mode ? ` (mode: ${mode})` : ""}. New pages show it now; open windows on reload.`);
    return 0;
  }

  return usage(`unknown theme command "${sub}".`);
}

/** The id a converted theme takes: its own, unless a different theme (another name, or a file that does not read) holds it. */
function freeDerivedId(dataDir: string, theme: ThemeFile): string {
  for (let n = 1; n <= CUSTOM_THEME_LIMIT + 1; n++) {
    const candidate = n === 1 ? theme.id : `${theme.id.slice(0, 60).replace(/-+$/, "")}-${n}`;
    if (!existsSync(join(customThemesDir(dataDir), `${candidate}.json`))) return candidate;
    if (readCustomTheme(dataDir, candidate)?.name === theme.name) return candidate;
  }
  return theme.id;
}
