import { describe, expect, test } from "bun:test";
import { openInMenuFor } from "./openIn";

describe("openInMenuFor", () => {
  test("installed JetBrains IDEs sit with the other editors, in catalog order", () => {
    const detected = [
      { id: "reveal", label: "Files", kind: "file-manager" as const, icon: "finder" },
      { id: "vscode", label: "VS Code", kind: "editor" as const, icon: "vscode" },
      { id: "webstorm", label: "WebStorm", kind: "editor" as const, icon: "jetbrains" },
      { id: "rider", label: "Rider", kind: "editor" as const, icon: "jetbrains" },
    ];
    const menu = openInMenuFor(
      { kind: "code", path: "src/retry.ts" },
      detected,
      "linux",
      null,
      null,
      false,
    );
    expect(menu.items.map((item) => item.id)).toEqual(["vscode", "webstorm", "rider", "reveal"]);
    expect(menu.items.filter((item) => item.kind === "app" && item.icon === "jetbrains").map((item) => item.label)).toEqual([
      "WebStorm",
      "Rider",
    ]);
  });
});
