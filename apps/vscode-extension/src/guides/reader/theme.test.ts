import { describe, expect, it } from "bun:test";
import { vscodeThemeOf } from "./theme";

const body = (classes: string[], id?: string) => ({
  classList: { contains: (c: string) => classes.includes(c) },
  getAttribute: (n: string) => (n === "data-vscode-theme-id" ? id ?? null : null),
});

describe("the Guide tab follows VS Code's theme", () => {
  it("takes light or dark from the theme's kind", () => {
    expect(vscodeThemeOf(body(["vscode-dark"], "Default Dark Modern"))).toEqual({ mode: "dark", palette: "dark-plus" });
    expect(vscodeThemeOf(body(["vscode-light"], "Default Light Modern"))).toEqual({ mode: "light", palette: "dark-plus" });
    expect(vscodeThemeOf(body(["vscode-high-contrast-light"]))).toEqual({ mode: "light", palette: "dark-plus" });
    expect(vscodeThemeOf(body(["vscode-high-contrast"]))).toEqual({ mode: "dark", palette: "dark-plus" });
  });

  it("picks the syntax colors of a theme Plannotator knows by name", () => {
    expect(vscodeThemeOf(body(["vscode-dark"], "GitHub Dark Default")).palette).toBe("github");
    expect(vscodeThemeOf(body(["vscode-dark"], "Monokai")).palette).toBe("monokai-pro");
    expect(vscodeThemeOf(body(["vscode-light"], "Solarized Light")).palette).toBe("solarized");
    expect(vscodeThemeOf(body(["vscode-dark"], "Some Custom Theme")).palette).toBe("dark-plus");
  });
});
