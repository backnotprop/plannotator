/**
 * Cutting text never breaks a character. A derived Inbox subject is cut at
 * 120 code units; a prompt with an emoji across that point drew "�…" (the
 * stress test of 2026-10-12, row 26), because `slice` kept half of the
 * emoji's surrogate pair.
 */
import { describe, expect, test } from "bun:test";
import { cutText, sliceText } from "./text-cut";

const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("sliceText", () => {
  test("never ends on half a surrogate pair", () => {
    const text = `${"a".repeat(118)}😀 and more`;
    expect(text.slice(0, 119)).toMatch(lone);
    const cut = sliceText(text, 119);
    expect(cut).not.toMatch(lone);
    expect(cut).toBe("a".repeat(118));
  });

  test("keeps a joined emoji (a family, a flag) whole or drops it whole", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `ab${family}cd`;
    for (let max = 2; max < 2 + family.length; max++) expect(sliceText(text, max)).toBe("ab");
    expect(sliceText(text, 2 + family.length)).toBe(`ab${family}`);
    expect(sliceText("🇯🇵🇫🇷", 3)).toBe("");
    expect(sliceText("🇯🇵🇫🇷", 6)).toBe("🇯🇵");
  });

  test("keeps a letter with its combining marks", () => {
    // "e" + combining acute, twice.
    expect(sliceText("éé", 3)).toBe("é");
  });

  test("text that fits is returned as it is, at any length", () => {
    expect(sliceText("hello", 5)).toBe("hello");
    expect(sliceText("", 3)).toBe("");
    expect(sliceText("hello", 0)).toBe("");
  });

  test("the work does not grow with the text", () => {
    const long = "x".repeat(2_000_000);
    expect(sliceText(long, 10)).toBe("xxxxxxxxxx");
  });
});

describe("cutText", () => {
  test("adds the ellipsis within the limit, as the old slice did for plain text", () => {
    const plain = "b".repeat(200);
    expect(cutText(plain, 120)).toBe(`${plain.slice(0, 119)}…`);
    expect(cutText(plain, 120).length).toBe(120);
    expect(cutText("short", 120)).toBe("short");
  });

  test("an emoji at the cut is dropped whole, never drawn as �", () => {
    const text = `${"q".repeat(118)}🧾 receipts and invoices`;
    const cut = cutText(text, 120);
    expect(cut).not.toMatch(lone);
    expect(cut).toBe(`${"q".repeat(118)}…`);
  });

  test("Arabic, Japanese and Vietnamese are cut between characters", () => {
    for (const text of ["مرحبا بالعالم ".repeat(20), "日本語のテキスト".repeat(20), "Tiếng Việt có dấu ".repeat(20)]) {
      const cut = cutText(text, 50);
      expect(cut.length).toBeLessThanOrEqual(50);
      expect(cut.endsWith("…")).toBe(true);
      expect(text.startsWith(cut.slice(0, -1))).toBe(true);
    }
  });
});
