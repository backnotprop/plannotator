import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DirState } from "../../hooks/useFileBrowser";
import { FileBrowser } from "./FileBrowser";

describe("FileBrowser", () => {
  test("renders a readable Roam source section while keeping page titles and uid keys distinct", () => {
    const html = renderToStaticMarkup(
      <FileBrowser
        dirs={[
          {
            path: "roam:hosted:work-notes",
            name: "work-notes",
            tree: [
              {
                name: "Daily Notes",
                path: "abc123",
                type: "file",
              },
            ],
            isLoading: false,
            error: null,
            source: "roam",
            roamMeta: {
              graphName: "work-notes",
              graphType: "hosted",
              token: "secret-token",
              port: 3333,
            },
          },
        ] as unknown as DirState[]}
        expandedFolders={new Set()}
        onToggleFolder={() => {}}
        collapsedDirs={new Set()}
        onToggleCollapse={() => {}}
        onSelectFile={() => {}}
        activeFile={null}
        onFetchAll={() => {}}
      />,
    );

    expect(html).toContain("Roam");
    expect(html).toContain("work-notes");
    expect(html).toContain("Daily Notes");
    expect(html).toContain('title="abc123"');
  });
});
