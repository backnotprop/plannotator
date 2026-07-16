import { describe, expect, test } from "bun:test";
import {
  buildAnnotateAgentTerminalTheme,
  resolveAnnotateAgentTerminalMode,
  resolveAnnotateAgentTerminalTheme,
} from "./annotateAgentTerminalTheme";

const palette = {
  background: "rgb(40, 44, 52)",
  foreground: "rgb(245, 245, 245)",
  card: "rgb(40, 44, 52)",
  muted: "rgb(62, 68, 81)",
  mutedForeground: "rgb(166, 173, 186)",
  border: "rgb(82, 90, 106)",
  primary: "rgb(129, 162, 190)",
  secondary: "rgb(138, 190, 183)",
  accent: "rgb(178, 148, 187)",
  destructive: "rgb(204, 102, 102)",
  success: "rgb(181, 189, 104)",
  warning: "rgb(240, 198, 116)",
  focus: "rgb(112, 192, 177)",
  fontMono: "ui-monospace",
};

describe("buildAnnotateAgentTerminalTheme", () => {
  test("uses a dark terminal buffer with theme accents", () => {
    const theme = buildAnnotateAgentTerminalTheme(palette, "dark");

    expect(theme.background).toBe(palette.background);
    expect(theme.foreground).toBe(palette.foreground);
    expect(theme.black).toBe(palette.background);
    expect(theme.blue).toBe(palette.primary);
    expect(theme.green).toBe(palette.success);
    expect(theme.yellow).toBe(palette.warning);
    expect(theme.red).toBe(palette.destructive);
  });
});

describe("resolveAnnotateAgentTerminalTheme", () => {
  test("uses the active Plannotator palette instead of a separate terminal preset", () => {
    const theme = resolveAnnotateAgentTerminalTheme("plannotator", "dark", palette);

    expect(theme.background).toBe(palette.background);
    expect(theme.background).not.toBe("#282c34");
    expect(theme.foreground).toBe(palette.foreground);
    expect(theme.blue).toBe(palette.primary);
    expect(theme.cyan).toBe(palette.secondary);
  });

  test("does not let curated terminal presets override the active app palette", () => {
    const theme = resolveAnnotateAgentTerminalTheme("catppuccin", "dark", palette);

    expect(theme.background).toBe(palette.background);
    expect(theme.foreground).toBe(palette.foreground);
    expect(theme.blue).toBe(palette.primary);
  });

  test("does not fall back to a dark preset when a theme has no curated light terminal palette", () => {
    const lightPalette = {
      ...palette,
      background: "rgb(250, 244, 237)",
      foreground: "rgb(87, 82, 121)",
      primary: "rgb(144, 122, 169)",
    };
    const theme = resolveAnnotateAgentTerminalTheme("rose-pine", "light", lightPalette);

    expect(theme.background).toBe(lightPalette.background);
    expect(theme.background).not.toBe("#191724");
    expect(theme.foreground).toBe(lightPalette.foreground);
    expect(theme.blue).toBe(lightPalette.primary);
  });

  test("keeps dark-only app themes in dark terminal mode", () => {
    expect(resolveAnnotateAgentTerminalMode("dracula", "light")).toBe("dark");
  });
});
