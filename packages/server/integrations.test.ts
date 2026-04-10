/**
 * Bear Integration Tests
 *
 * Run: bun test packages/server/integrations.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  extractTitle,
  extractTags,
  stripH1,
  buildHashtags,
  buildBearContent,
  generateFilename,
  stripFrontmatter,
  frontmatterToAttributeBlocks,
  stripRoamMetadataTags,
  majorMinorMatches,
  generatePageTitle,
  normalizeRoamSuggestionsToPages,
} from "./integrations";

describe("extractTitle", () => {
  test("extracts plain H1", () => {
    expect(extractTitle("# My Plan\n\nContent")).toBe("My Plan");
  });

  test("strips Implementation Plan: prefix", () => {
    expect(extractTitle("# Implementation Plan: Auth Flow\n\nContent")).toBe("Auth Flow");
  });

  test("strips Plan: prefix", () => {
    expect(extractTitle("# Plan: Database Migration\n\nContent")).toBe("Database Migration");
  });

  test("falls back to 'Plan' when no H1", () => {
    expect(extractTitle("No heading here")).toBe("Plan");
  });

  test("truncates to 50 chars", () => {
    const long = "A".repeat(60);
    expect(extractTitle(`# ${long}`).length).toBe(50);
  });

  test("removes special characters", () => {
    expect(extractTitle("# Fix [bug] #123")).toBe("Fix bug 123");
  });
});

describe("stripH1", () => {
  test("strips first H1 line", () => {
    expect(stripH1("# My Plan\n\n## Section\nContent")).toBe("## Section\nContent");
  });

  test("strips H1 with any wording", () => {
    expect(stripH1("# Whatever Title Here\nBody")).toBe("Body");
  });

  test("only strips first H1, not subsequent ones", () => {
    const input = "# First\n\n# Second\nBody";
    expect(stripH1(input)).toBe("# Second\nBody");
  });

  test("handles plan with no H1", () => {
    expect(stripH1("Just text\nMore text")).toBe("Just text\nMore text");
  });

  test("does not strip ## H2 headings", () => {
    expect(stripH1("## Not H1\nBody")).toBe("## Not H1\nBody");
  });
});

describe("buildHashtags", () => {
  test("uses custom tags when provided", () => {
    expect(buildHashtags("plan, work", ["plannotator"])).toBe("#plan #work");
  });

  test("falls back to auto tags when custom is empty", () => {
    expect(buildHashtags("", ["plannotator", "myproject"])).toBe("#plannotator #myproject");
  });

  test("falls back to auto tags when custom is undefined", () => {
    expect(buildHashtags(undefined, ["plannotator"])).toBe("#plannotator");
  });

  test("filters empty tags from trailing comma", () => {
    expect(buildHashtags("plan, work,", ["plannotator"])).toBe("#plan #work");
  });

  test("handles whitespace-only custom tags as empty", () => {
    expect(buildHashtags("   ", ["auto"])).toBe("#auto");
  });

  test("preserves slashes in nested Bear tags", () => {
    expect(buildHashtags("plannotator/plans, work/code", [])).toBe("#plannotator/plans #work/code");
  });

  test("preserves slashes in auto tags with nested paths", () => {
    expect(buildHashtags(undefined, ["plannotator/plans", "work"])).toBe("#plannotator/plans #work");
  });
});

describe("buildBearContent", () => {
  test("appends tags by default", () => {
    const result = buildBearContent("Body text", "#plan #work", "append");
    expect(result).toBe("Body text\n\n#plan #work");
  });

  test("prepends tags when configured", () => {
    const result = buildBearContent("Body text", "#plan #work", "prepend");
    expect(result).toBe("#plan #work\n\nBody text");
  });
});

describe("full Bear content pipeline", () => {
  const plan = "# Add user authentication flow\n\n## Context\nSome content here";

  test("no double title — H1 stripped from body", () => {
    const body = stripH1(plan);
    expect(body).not.toContain("# Add user");
    expect(body).toStartWith("## Context");
  });

  test("custom tags prepended after title removal", () => {
    const body = stripH1(plan);
    const hashtags = buildHashtags("plan, work", []);
    const content = buildBearContent(body, hashtags, "prepend");
    expect(content).toStartWith("#plan #work");
    expect(content).toContain("## Context");
    expect(content).not.toContain("# Add user");
  });

  test("auto tags appended when no custom tags", () => {
    const body = stripH1(plan);
    const hashtags = buildHashtags("", ["plannotator", "dev"]);
    const content = buildBearContent(body, hashtags, "append");
    expect(content).toEndWith("#plannotator #dev");
    expect(content).toStartWith("## Context");
  });
});

describe("extractTags", () => {
  test("always includes plannotator tag", async () => {
    const tags = await extractTags("# Simple Plan\n\nContent");
    expect(tags).toContain("plannotator");
  });

  test("extracts words from title", async () => {
    const tags = await extractTags("# Authentication Service Refactor\n\nContent");
    expect(tags).toContain("authentication");
    expect(tags).toContain("service");
    expect(tags).toContain("refactor");
  });

  test("filters stop words from title", async () => {
    const tags = await extractTags("# Implementation Plan for the System\n\nContent");
    expect(tags).not.toContain("implementation");
    expect(tags).not.toContain("plan");
    expect(tags).not.toContain("the");
    expect(tags).not.toContain("for");
  });

  test("extracts code fence languages", async () => {
    const tags = await extractTags("# Plan\n\n```typescript\ncode\n```\n\n```rust\ncode\n```");
    expect(tags).toContain("typescript");
    expect(tags).toContain("rust");
  });

  test("skips generic languages", async () => {
    const tags = await extractTags("# Plan\n\n```json\n{}\n```\n\n```yaml\nfoo\n```");
    expect(tags).not.toContain("json");
    expect(tags).not.toContain("yaml");
  });

  test("limits to 7 tags", async () => {
    const tags = await extractTags("# One Two Three Four\n\n```go\n```\n```python\n```\n```ruby\n```\n```swift\n```");
    expect(tags.length).toBeLessThanOrEqual(7);
  });
});

describe("Roam helpers", () => {
  test("stripFrontmatter returns parsed frontmatter and body", () => {
    const input = [
      "---",
      "created: 2026-04-09T14:30:00.000Z",
      "source: plannotator",
      "tags: [plannotator, auth]",
      "---",
      "",
      "# Implementation Plan: Auth Flow",
      "",
      "Body",
    ].join("\n");
    const result = stripFrontmatter(input);

    expect(result.frontmatter).toEqual({
      created: "2026-04-09T14:30:00.000Z",
      source: "plannotator",
      tags: ["plannotator", "auth"],
    });
    expect(result.body).toBe("# Implementation Plan: Auth Flow\n\nBody");
  });

  test("stripFrontmatter handles CRLF line endings", () => {
    const input = [
      "---",
      "created: 2026-04-09T14:30:00.000Z",
      "source: plannotator",
      "tags: [plannotator, auth]",
      "---",
      "",
      "# Implementation Plan: Auth Flow",
      "",
      "Body",
    ].join("\r\n");
    const result = stripFrontmatter(input);

    expect(result.frontmatter).toEqual({
      created: "2026-04-09T14:30:00.000Z",
      source: "plannotator",
      tags: ["plannotator", "auth"],
    });
    expect(result.body).toBe("# Implementation Plan: Auth Flow\r\n\r\nBody");
  });

  test("frontmatterToAttributeBlocks renders Roam attributes", () => {
    expect(
      frontmatterToAttributeBlocks({
        created: "2026-04-09T14:30:00.000Z",
        source: "plannotator",
        tags: ["plannotator", "auth"],
        owner: "alice",
      }),
    ).toBe(
      [
        "created:: [[April 9th, 2026]]",
        "source:: plannotator",
        "tags:: [[plannotator]], [[auth]]",
        "owner:: alice",
      ].join("\n"),
    );
  });

  test("stripRoamMetadataTags removes wrappers but preserves content", () => {
    expect(
      stripRoamMetadataTags('<roam uid="abc123">## Heading\n\nBody</roam>'),
    ).toBe("## Heading\n\nBody");
  });

  test("generatePageTitle keeps the Obsidian format but drops .md", () => {
    const markdown = "# Implementation Plan: Auth Flow\n\nBody";
    const filename = generateFilename(markdown, "{title} - {Mon} {D}, {YYYY} {h}-{mm}{ampm}");
    const title = generatePageTitle(markdown, "{title} - {Mon} {D}, {YYYY} {h}-{mm}{ampm}");
    expect(title).toBe(filename.replace(/\.md$/, ""));
    expect(title.endsWith(".md")).toBe(false);
  });

  test("majorMinorMatches ignores patch versions only", () => {
    expect(majorMinorMatches("1.2.3", "1.2.9")).toBe(true);
    expect(majorMinorMatches("1.2.3", "1.3.0")).toBe(false);
    expect(majorMinorMatches("1.2.3", "2.2.3")).toBe(false);
  });

  test("normalizeRoamSuggestionsToPages keeps stable uid/title pairs", () => {
    const result = normalizeRoamSuggestionsToPages({
      recentlyEditedPages: [
        { uid: "edit-1", title: "Edited Page", editedAt: "2026-04-09T19:00:00.000Z" },
      ],
      recentlyOpenedByUser: [
        {
          uid: "open-1",
          title: "Working Set",
          type: "page",
          openedAt: "2026-04-09T18:00:00.000Z",
        },
        {
          uid: "open-ignored",
          title: "Block Result",
          type: "block",
          openedAt: "2026-04-09T17:00:00.000Z",
        },
      ],
    });

    expect(result).toEqual([
      { uid: "edit-1", title: "Edited Page", sortAt: "2026-04-09T19:00:00.000Z" },
      { uid: "open-1", title: "Working Set", sortAt: "2026-04-09T18:00:00.000Z" },
    ]);
  });

  test("normalizeRoamSuggestionsToPages keeps the newest timestamp for duplicate pages", () => {
    const result = normalizeRoamSuggestionsToPages({
      recentlyEditedPages: [
        { uid: "same-1", title: "Edited Page", editedAt: "2026-04-09T18:00:00.000Z" },
      ],
      recentlyOpenedByUser: [
        {
          uid: "same-1",
          title: "Edited Page",
          openedAt: "2026-04-09T19:00:00.000Z",
        },
      ],
    });

    expect(result).toEqual([
      { uid: "same-1", title: "Edited Page", sortAt: "2026-04-09T19:00:00.000Z" },
    ]);
  });
});
