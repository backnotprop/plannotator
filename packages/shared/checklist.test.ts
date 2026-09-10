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

  test("a whitespace-only checkbox line never receives another step's marker", () => {
    // Degenerate plan: blank checkbox placeholders sit between the real
    // steps. Before hardening, the shared pattern's \s+ crossed the newline,
    // pairing the blank line's marker with the next real line, and the
    // first-occurrence `replace("[ ]", ...)` then wrote the [x] into the
    // blank placeholder instead of the real step's box.
    const content = [
      "# Plan",
      "",
      "- [ ]",
      "- [ ] Step one",
      "- [ ]   ",
      "- [ ] Step two",
      "",
    ].join("\n");
    const items = parseChecklist(content);
    expect(items.map((item) => item.text)).toEqual(["Step one", "Step two"]);

    items[0]!.completed = true;
    expect(renderCompletedChecklist(content, items)).toBe([
      "# Plan",
      "",
      "- [ ]",
      "- [x] Step one",
      "- [ ]   ",
      "- [ ] Step two",
      "",
    ].join("\n"));

    items[1]!.completed = true;
    expect(renderCompletedChecklist(content, items)).toBe([
      "# Plan",
      "",
      "- [ ]",
      "- [x] Step one",
      "- [ ]   ",
      "- [x] Step two",
      "",
    ].join("\n"));
  });

  test("does not clear existing completed items", () => {
    const content = "- [x] Completed step\n- [ ] Unfinished step\n";
    const items = parseChecklist(content);
    items[0]!.completed = false;

    expect(renderCompletedChecklist(content, items)).toBe(content);
  });
});
