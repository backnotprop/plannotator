import { describe, expect, test } from "bun:test";
import { parseMarkdownToBlocks } from "./parser";
import { extractPlanContextFiles, inferPlanContextStatusFromHeading } from "./planContext";

function extract(markdown: string) {
  return extractPlanContextFiles(parseMarkdownToBlocks(markdown));
}

describe("inferPlanContextStatusFromHeading", () => {
  test("recognizes explicit file-change headings", () => {
    expect(inferPlanContextStatusFromHeading("Modified files")).toBe("modified");
    expect(inferPlanContextStatusFromHeading("Files to update")).toBe("modified");
    expect(inferPlanContextStatusFromHeading("New files")).toBe("created");
    expect(inferPlanContextStatusFromHeading("Files to create")).toBe("created");
    expect(inferPlanContextStatusFromHeading("Deleted files")).toBe("deleted");
    expect(inferPlanContextStatusFromHeading("Files to remove")).toBe("deleted");
  });

  test("does not treat generic file-change headings as status", () => {
    expect(inferPlanContextStatusFromHeading("Phase 4: File Changes")).toBeNull();
  });
});

describe("extractPlanContextFiles", () => {
  test("extracts backticked and bare prose code paths", () => {
    const files = extract([
      "# Plan",
      "",
      "Update `packages/editor/App.tsx`.",
      "",
      "Then touch packages/ui/components/Viewer.tsx.",
    ].join("\n"));

    expect(files.map((file) => file.path)).toEqual([
      "packages/editor/App.tsx",
      "packages/ui/components/Viewer.tsx",
    ]);
  });

  test("ignores paths inside fenced code blocks and html comments", () => {
    const files = extract([
      "# Plan",
      "",
      "```ts",
      "import './src/hidden.ts';",
      "```",
      "",
      "<!-- packages/ui/secret.ts -->",
    ].join("\n"));

    expect(files).toEqual([]);
  });

  test("maps the first mention to the correct block id", () => {
    const blocks = parseMarkdownToBlocks([
      "# Plan",
      "",
      "Intro mentions packages/ui/first.ts.",
      "",
      "- Later mentions packages/ui/first.ts again.",
    ].join("\n"));

    const files = extractPlanContextFiles(blocks);
    const firstParagraph = blocks.find((block) => block.content.includes("Intro mentions"))!;
    expect(files[0]).toMatchObject({
      path: "packages/ui/first.ts",
      firstBlockId: firstParagraph.id,
      mentionCount: 2,
    });
  });

  test("groups line-range references by file path", () => {
    const files = extract([
      "# Plan",
      "",
      "See packages/ui/components/Viewer.tsx:140-180.",
      "",
      "Also revisit `packages/ui/components/Viewer.tsx#L200`.",
    ].join("\n"));

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "packages/ui/components/Viewer.tsx",
      mentionCount: 2,
    });
  });

  test("uses the nearest explicit status heading", () => {
    const files = extract([
      "# Plan",
      "",
      "## Phase 1",
      "",
      "### Modified files",
      "",
      "- `packages/ui/context.ts`",
      "",
      "#### Client",
      "",
      "- packages/editor/App.tsx",
      "",
      "### Created files",
      "",
      "- packages/ui/new-widget.tsx",
      "",
      "### Deleted files",
      "",
      "- packages/ui/old-widget.tsx",
    ].join("\n"));

    expect(files.find((file) => file.path === "packages/ui/context.ts")?.status).toBe("modified");
    expect(files.find((file) => file.path === "packages/editor/App.tsx")?.status).toBe("modified");
    expect(files.find((file) => file.path === "packages/ui/new-widget.tsx")?.status).toBe("created");
    expect(files.find((file) => file.path === "packages/ui/old-widget.tsx")?.status).toBe("deleted");
  });

  test("falls back to mentioned when explicit statuses conflict", () => {
    const files = extract([
      "# Plan",
      "",
      "## Modified files",
      "",
      "- packages/ui/conflict.ts",
      "",
      "## Deleted files",
      "",
      "- packages/ui/conflict.ts",
    ].join("\n"));

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "packages/ui/conflict.ts",
      status: "mentioned",
      mentionCount: 2,
    });
  });
});
