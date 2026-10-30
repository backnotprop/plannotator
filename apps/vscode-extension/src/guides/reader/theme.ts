/**
 * VS Code's theme, as the reader's theme pair: light or dark from the theme's
 * kind (the class VS Code puts on a webview's body), and a Plannotator
 * palette whose syntax colors match the theme's name where one does (a
 * webview cannot read a theme's token colors). Everything else the reader
 * draws takes VS Code's own colors (`reader.css` maps `--vscode-*`).
 */

const NAMED: Array<[RegExp, string]> = [
  [/github/i, "github"],
  [/monokai/i, "monokai-pro"],
  [/dracula/i, "dracula"],
  [/one dark|atom one/i, "one-dark-pro"],
  [/one light/i, "one-light"],
  [/nord/i, "nord"],
  [/night owl/i, "night-owl"],
  [/solarized/i, "solarized"],
  [/catppuccin/i, "catppuccin"],
  [/tokyo ?night/i, "tokyo-night"],
  [/ros[eé] ?pine/i, "rose-pine"],
  [/gruvbox/i, "gruvbox"],
  [/kanagawa/i, "kanagawa-wave"],
  [/everforest/i, "everforest"],
  [/vitesse/i, "vitesse"],
  [/ayu/i, "ayu-dark"],
  [/material/i, "material"],
  [/poimandres/i, "poimandres"],
  [/synthwave/i, "synthwave-84"],
];

export interface VsCodeTheme {
  mode: "light" | "dark";
  palette: string;
}

export function vscodeThemeOf(body: { classList: { contains(c: string): boolean }; dataset?: Record<string, string | undefined>; getAttribute?(n: string): string | null }): VsCodeTheme {
  const light = body.classList.contains("vscode-light") || body.classList.contains("vscode-high-contrast-light");
  const mode = light ? "light" : "dark";
  const name = body.getAttribute?.("data-vscode-theme-id") ?? body.dataset?.vscodeThemeId ?? "";
  for (const [re, palette] of NAMED) if (re.test(name)) return { mode, palette };
  return { mode, palette: "dark-plus" };
}
