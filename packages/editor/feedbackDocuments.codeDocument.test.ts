import { describe, expect, test } from "bun:test";
import { blocksForDocument, blocksForRenderAs } from "./feedbackDocuments";
import { CODE_DOCUMENT_HIGHLIGHT_LIMIT } from "@plannotator/ui/utils/parser";

const TOML = [
  "# Config for the notes-api service (version 1): one file for every environment,",
  "# each key named after its variable (`server.port` is `NOTES_SERVER_PORT`).",
  "",
  "[database]",
  'url = "postgres://localhost:5432/notes"',
  "",
].join("\n");

describe("config files as code documents", () => {
  test("a .toml is one code block in its own language, comments and all", () => {
    const blocks = blocksForDocument("/repo/config.toml", TOML);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "code", language: "toml", content: TOML, startLine: 1 });
    expect(blocks[0]?.sourceLineCount).toBe(5);
  });

  test("the markdown parse of the same text is what this replaces", () => {
    const markdown = blocksForRenderAs(TOML, "markdown", false);
    expect(markdown.some((b) => b.type === "heading")).toBe(true);
  });

  test("the path picks the grammar, and .conf stays plain", () => {
    expect(blocksForRenderAs("a: 1\n", "code", false, "ci.yml")[0]?.language).toBe("yaml");
    expect(blocksForRenderAs("listen 80;\n", "code", false, "nginx.conf")[0]?.language).toBeUndefined();
    expect(blocksForRenderAs("a: 1\n", "code", false)[0]?.language).toBeUndefined();
  });

  test("a file past the highlight limit shows as plain monospace text, still one block", () => {
    const big = "x = 1\n".repeat(Math.ceil(CODE_DOCUMENT_HIGHLIGHT_LIMIT / 6) + 1);
    const [block] = blocksForDocument("big.toml", big);
    expect(block).toMatchObject({ type: "code", content: big });
    expect(block?.language).toBeUndefined();
  });

  test("markdown and .txt keep the markdown parse", () => {
    expect(blocksForDocument("notes.txt", "# Title\n")[0]?.type).toBe("heading");
    expect(blocksForDocument("notes.md", "# Title\n")[0]?.type).toBe("heading");
  });
});
