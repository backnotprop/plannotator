import { describe, expect, test } from "bun:test";
import { parseChecklist, renderCompletedChecklist } from "./checklist";

describe("renderCompletedChecklist", () => {
  test("marks completed items without changing other Markdown", () => {
    const content = [
      "# Plan",
      "",
      "- [ ] First step",
      "  Supporting detail",
      "* [x] Second step",
      "- [ ] Third step",
      "",
    ].join("\r\n");
    const items = parseChecklist(content);
    items[0]!.completed = true;
    items[2]!.completed = true;

    expect(renderCompletedChecklist(content, items)).toBe([
      "# Plan",
      "",
      "- [x] First step",
      "  Supporting detail",
      "* [x] Second step",
      "- [x] Third step",
      "",
    ].join("\r\n"));
  });

  test("does not clear existing completed items", () => {
    const content = "- [x] Completed step\n- [ ] Unfinished step\n";
    const items = parseChecklist(content);
    items[0]!.completed = false;

    expect(renderCompletedChecklist(content, items)).toBe(content);
  });
});
