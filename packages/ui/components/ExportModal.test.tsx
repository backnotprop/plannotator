import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { storage } from "../utils/storage";
import { saveRoamSettings } from "../utils/roam";
import { ExportModal } from "./ExportModal";

const keys = [
  "plannotator-obsidian-enabled",
  "plannotator-obsidian-vault-path",
  "plannotator-obsidian-folder",
  "plannotator-obsidian-filename-format",
  "plannotator-obsidian-filename-separator",
  "plannotator-bear-enabled",
  "plannotator-bear-tags",
  "plannotator-bear-tag-position",
  "plannotator-octarine-enabled",
  "plannotator-octarine-workspace",
  "plannotator-octarine-folder",
  "plannotator-roam-enabled",
  "plannotator-roam-graph-name",
  "plannotator-roam-graph-type",
  "plannotator-roam-token",
  "plannotator-roam-port",
  "plannotator-roam-title-format",
  "plannotator-roam-title-separator",
  "plannotator-roam-autosave",
  "plannotator-roam-reference-browser",
];

let cookieStore = new Map<string, string>();

beforeEach(() => {
  cookieStore = new Map();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get cookie() {
        return Array.from(cookieStore.entries())
          .map(([key, value]) => `${key}=${value}`)
          .join("; ");
      },
      set cookie(value: string) {
        const [pair, ...directives] = value.split(";").map((part) => part.trim());
        const [key, rawValue = ""] = pair.split("=");
        if (!key) return;
        if (directives.some((directive) => directive.toLowerCase() === "max-age=0")) {
          cookieStore.delete(key);
          return;
        }
        cookieStore.set(key, rawValue);
      },
    },
  });

  for (const key of keys) {
    storage.removeItem(key);
  }
});

describe("ExportModal", () => {
  test("shows Roam in the Notes tab when Roam is configured", () => {
    saveRoamSettings({
      enabled: true,
      graphName: "my-graph",
      graphType: "hosted",
      token: "secret-token",
      port: 3333,
      titleSeparator: "space",
      saveLocation: "daily-note",
      dailyNoteParent: "[[Plannotator Plans]]",
      autoSave: true,
      referenceBrowserEnabled: true,
    });

    const html = renderToStaticMarkup(
      <ExportModal
        isOpen
        onClose={() => {}}
        shareUrl="https://example.com/share"
        shareUrlSize="1 KB"
        annotationsOutput="No annotations"
        annotationCount={0}
        markdown="# Plan"
        isApiMode
        initialTab="notes"
      />,
    );

    expect(html).toContain("Roam");
    expect(html).toContain("my-graph");
    expect(html).toContain("today&#x27;s Daily Note");
  });
});
