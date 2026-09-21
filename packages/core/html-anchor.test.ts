/**
 * Contract for the host-facing raw-HTML anchor helpers.
 *
 * `buildPersistedHtmlAnchor`: a host persists what it gets back, so the
 * failures to catch are (1) an in-bounds anchor being rewritten (a stored
 * anchor that no longer equals the composed one breaks host fingerprints),
 * (2) the product cap and the byte budget being confused for each other in
 * the drop counts, and (3) the budget eating the quote before the extras.
 *
 * `projectHostThreads`: the output order IS the marker numbering, so the
 * failures to catch are a reordered or dropped row, a resolved row painting,
 * and an anchor-only row being demoted to a document-level comment.
 */
import { describe, expect, test } from "bun:test";
import {
  buildPersistedHtmlAnchor,
  DEFAULT_HTML_ANCHOR_MAX_BYTES,
  MAX_ELEMENT_CONTEXT_BYTES,
  MAX_HTML_ADDITIONAL_TARGETS,
  parseHtmlElementContext,
  projectHostThreads,
  type HostThread,
} from "./html-anchor";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("buildPersistedHtmlAnchor", () => {
  test("an anchor already within every bound comes back byte-identical", () => {
    // Kept-target key order is text, label, anchor (the reference host's
    // wire order), so a stored anchor's serialization is stable on adoption.
    const input = {
      originalText: "Quoted text with an emoji \u{1F600}",
      htmlAnchor: { selector: "#hero > p:nth-of-type(2)", tagName: "p", text: "Quoted", point: { x: 0.25, y: 0.75 } },
      htmlAdditionalTargets: [
        { text: "Save", label: "Button", anchor: { selector: "button[data-testid=\"save\"]", tagName: "button", text: "Save" } },
        { text: "[element: img]" },
      ],
    };
    const result = buildPersistedHtmlAnchor(input);
    expect(JSON.stringify(result.anchor)).toBe(JSON.stringify(input));
    expect(result.droppedTargets).toBe(0);
    expect(result.capDroppedTargets).toBe(0);
    expect(result.sizeDroppedTargets).toBe(0);
    // A composer-ordered target (label first) is re-keyed to the wire order.
    const reordered = buildPersistedHtmlAnchor({
      originalText: "q",
      htmlAdditionalTargets: [{ label: "Button", text: "Go", anchor: { selector: "#go", tagName: "button" } }],
    });
    expect(Object.keys(reordered.anchor.htmlAdditionalTargets![0]!)).toEqual(["text", "label", "anchor"]);
  });

  test("rows without elementContext serialize byte-identically and pin wire fingerprint", () => {
    // Failure caught: changing the serialization format or introducing undefined/extra keys
    // for rows that do not carry elementContext, which breaks host wire fingerprints.
    const withoutContext = {
      originalText: "Text quote",
      htmlAnchor: { selector: "p.lead", tagName: "p", text: "Text" },
      htmlAdditionalTargets: [
        { text: "Target", label: "Label", anchor: { selector: "#t1", tagName: "div" } },
      ],
    };
    const result = buildPersistedHtmlAnchor(withoutContext);
    expect(JSON.stringify(result.anchor)).toBe(JSON.stringify(withoutContext));
    expect(Object.keys(result.anchor)).toEqual(["originalText", "htmlAnchor", "htmlAdditionalTargets"]);
    expect("elementContext" in result.anchor).toBe(false);

    // When elementContext IS present, it serializes strictly after htmlAdditionalTargets
    const withContext = {
      ...withoutContext,
      elementContext: { tag: "p", id: "lead-para" },
    };
    const resultWithContext = buildPersistedHtmlAnchor(withContext);
    expect(Object.keys(resultWithContext.anchor)).toEqual([
      "originalText",
      "htmlAnchor",
      "htmlAdditionalTargets",
      "elementContext",
    ]);
  });

  test("shed order: per-target contexts shed first, then primary context, before dropping targets under small maxBytes", () => {
    // Failure caught: dropping targets prematurely while expendable contexts remain,
    // losing user-selected targets instead of shedding descriptive context.
    const targetContext1 = { tag: "button", path: "body > form > button:nth-of-type(1)", outline: "<button>1</button>" };
    const targetContext2 = { tag: "button", path: "body > form > button:nth-of-type(2)", outline: "<button>2</button>" };
    const primaryContext = { tag: "form", path: "body > form#action-form", outline: "<form>…</form>" };

    const source = {
      originalText: "Save changes",
      htmlAnchor: { selector: "form#action-form", tagName: "form" },
      htmlAdditionalTargets: [
        { text: "Btn 1", anchor: { selector: "button.save", tagName: "button" }, context: targetContext1 },
        { text: "Btn 2", anchor: { selector: "button.cancel", tagName: "button" }, context: targetContext2 },
      ],
      elementContext: primaryContext,
    };

    // Full anchor with all contexts
    const full = buildPersistedHtmlAnchor(source);
    const fullBytes = bytes(full.anchor);
    expect(full.anchor.elementContext).toBeDefined();
    expect(full.anchor.htmlAdditionalTargets?.[0]?.context).toBeDefined();
    expect(full.anchor.htmlAdditionalTargets?.[1]?.context).toBeDefined();
    expect(full.anchor.htmlAdditionalTargets?.length).toBe(2);

    // Budget just small enough to force shedding the last target's context
    const budget1 = fullBytes - 30;
    const res1 = buildPersistedHtmlAnchor(source, { maxBytes: budget1 });
    expect(bytes(res1.anchor)).toBeLessThanOrEqual(budget1);
    expect(res1.anchor.htmlAdditionalTargets?.length).toBe(2);
    expect(res1.anchor.htmlAdditionalTargets?.[0]?.context).toBeDefined();
    // Last target's context was shed first
    expect(res1.anchor.htmlAdditionalTargets?.[1]?.context).toBeUndefined();
    expect(res1.anchor.elementContext).toBeDefined();
    expect(res1.droppedTargets).toBe(0);

    // Budget small enough to shed all per-target contexts and primary context, but keep targets
    const baseWithoutContexts = buildPersistedHtmlAnchor({
      originalText: source.originalText,
      htmlAnchor: source.htmlAnchor,
      htmlAdditionalTargets: [
        { text: "Btn 1", anchor: { selector: "button.save", tagName: "button" } },
        { text: "Btn 2", anchor: { selector: "button.cancel", tagName: "button" } },
      ],
    });
    const budgetNoContexts = bytes(baseWithoutContexts.anchor) + 10;
    const res2 = buildPersistedHtmlAnchor(source, { maxBytes: budgetNoContexts });
    expect(bytes(res2.anchor)).toBeLessThanOrEqual(budgetNoContexts);
    // Both target contexts and primary context shed, but targets remain
    expect(res2.anchor.htmlAdditionalTargets?.length).toBe(2);
    expect(res2.anchor.htmlAdditionalTargets?.[0]?.context).toBeUndefined();
    expect(res2.anchor.htmlAdditionalTargets?.[1]?.context).toBeUndefined();
    expect(res2.anchor.elementContext).toBeUndefined();
    expect(res2.droppedTargets).toBe(0);

    // Even smaller budget: now targets are dropped from the end
    const budgetDropTarget = bytes(baseWithoutContexts.anchor) - 20;
    const res3 = buildPersistedHtmlAnchor(source, { maxBytes: budgetDropTarget });
    expect(bytes(res3.anchor)).toBeLessThanOrEqual(budgetDropTarget);
    expect(res3.anchor.htmlAdditionalTargets?.length).toBe(1);
    expect(res3.sizeDroppedTargets).toBe(1);
  });

  test("a drag capture without an element anchor writes exactly the legacy shape", () => {
    const result = buildPersistedHtmlAnchor({ originalText: "plain quote" });
    expect(result.anchor).toEqual({ originalText: "plain quote" });
    expect(Object.keys(result.anchor)).toEqual(["originalText"]);
  });

  test("a malformed element anchor fails closed to the text quote", () => {
    const result = buildPersistedHtmlAnchor({
      originalText: "quote",
      htmlAnchor: { selector: "", tagName: "p" },
    });
    expect(result.anchor).toEqual({ originalText: "quote" });
  });

  test("targets past maxTargets are dropped in draft order and counted against the cap only", () => {
    const targets = Array.from({ length: 10 }, (_, i) => ({ text: `Target ${i}` }));
    const result = buildPersistedHtmlAnchor({ originalText: "q", htmlAdditionalTargets: targets }, { maxTargets: 7 });
    expect(result.anchor.htmlAdditionalTargets?.map((t) => t.text)).toEqual(targets.slice(0, 7).map((t) => t.text));
    expect(result.capDroppedTargets).toBe(3);
    expect(result.sizeDroppedTargets).toBe(0);
  });

  test("the default cap is the viewer's 16", () => {
    const targets = Array.from({ length: 20 }, (_, i) => ({ text: `Target ${i}` }));
    const result = buildPersistedHtmlAnchor({ originalText: "q", htmlAdditionalTargets: targets });
    expect(result.anchor.htmlAdditionalTargets?.length).toBe(MAX_HTML_ADDITIONAL_TARGETS);
    expect(result.capDroppedTargets).toBe(4);
  });

  test("the byte budget truncates the quote to its useful floor before shedding targets", () => {
    // 16 in-bounds targets of 400 chars each (~6.9 KB) plus a 12 KB quote
    // overflow the default 16 KiB budget by well under the quote's slack
    // above the 400-char floor, so the quote alone absorbs the squeeze.
    const targets = Array.from({ length: 16 }, (_, i) => ({
      label: `Target ${i}`,
      text: "t".repeat(400),
      anchor: { selector: `#target-${i}`, tagName: "div", text: "t".repeat(40) },
    }));
    const result = buildPersistedHtmlAnchor({
      originalText: "q".repeat(12_000),
      htmlAdditionalTargets: targets,
    });
    expect(bytes(result.anchor)).toBeLessThanOrEqual(DEFAULT_HTML_ANCHOR_MAX_BYTES);
    expect(result.anchor.htmlAdditionalTargets?.length).toBe(16);
    expect(result.sizeDroppedTargets).toBe(0);
    expect(result.capDroppedTargets).toBe(0);
    // A prefix, so text-search restore still matches it in the document.
    expect(result.anchor.originalText.length).toBeGreaterThanOrEqual(400);
    expect("q".repeat(12_000).startsWith(result.anchor.originalText)).toBe(true);
  });

  test("below the quote floor, targets are shed from the end and counted as size drops", () => {
    const targets = Array.from({ length: 16 }, (_, i) => ({
      label: `Target ${i}`,
      text: "t".repeat(400),
      anchor: { selector: `#target-${i}`, tagName: "div", text: "t".repeat(400) },
    }));
    const result = buildPersistedHtmlAnchor(
      { originalText: "q".repeat(400), htmlAdditionalTargets: targets },
      { maxBytes: 4096 },
    );
    expect(bytes(result.anchor)).toBeLessThanOrEqual(4096);
    // The quote survives at its floor: the squeeze cost targets, not the quote.
    expect(result.anchor.originalText).toBe("q".repeat(400));
    const kept = result.anchor.htmlAdditionalTargets ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(16);
    expect(kept.map((t) => t.label)).toEqual(targets.slice(0, kept.length).map((t) => t.label));
    expect(result.sizeDroppedTargets).toBe(16 - kept.length);
    expect(result.capDroppedTargets).toBe(0);
  });

  test("a cap drop and a size drop are reported separately on the same anchor", () => {
    const targets = Array.from({ length: 12 }, (_, i) => ({
      text: "t".repeat(400),
      anchor: { selector: `#target-${i}`, tagName: "div", text: "t".repeat(400) },
    }));
    const result = buildPersistedHtmlAnchor(
      { originalText: "q".repeat(400), htmlAdditionalTargets: targets },
      { maxTargets: 7, maxBytes: 3000 },
    );
    expect(result.capDroppedTargets).toBe(5);
    expect(result.sizeDroppedTargets).toBeGreaterThan(0);
    expect((result.anchor.htmlAdditionalTargets?.length ?? 0) + result.sizeDroppedTargets).toBe(7);
    expect(result.droppedTargets).toBe(result.capDroppedTargets + result.sizeDroppedTargets);
    expect(bytes(result.anchor)).toBeLessThanOrEqual(3000);
  });

  test("quote truncation never splits a surrogate pair", () => {
    const quote = "\u{1F600}".repeat(9_000); // 18,000 UTF-16 units, 4 bytes each
    const result = buildPersistedHtmlAnchor({ originalText: quote });
    expect(bytes(result.anchor)).toBeLessThanOrEqual(DEFAULT_HTML_ANCHOR_MAX_BYTES);
    const last = result.anchor.originalText.charCodeAt(result.anchor.originalText.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

describe("projectHostThreads", () => {
  const anchor = { selector: "#a", tagName: "p", text: "Alpha" };
  const rows: HostThread[] = [
    { id: "t1", originalText: "Alpha", htmlAnchor: anchor, state: "open", text: "first", createdA: 10 },
    { id: "t2", originalText: "Beta", state: "resolved", text: "second", createdA: 20 },
    { id: "t3", originalText: "", htmlAnchor: { selector: "img#chart", tagName: "img", text: "" }, state: "open", createdA: 30 },
    { id: "t4", originalText: "", state: "open", text: "document-level note", createdA: 40 },
    { id: "t5", originalText: "Gamma", state: "open", htmlAdditionalTargets: [{ label: "Button", text: "Go", anchor: { selector: "#go", tagName: "button", text: "Go" } }] },
  ];

  test("output order is input order, which is the marker numbering", () => {
    expect(projectHostThreads(rows).map((a) => a.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  test("openOnly drops resolved rows and keeps rows without a state", () => {
    const projected = projectHostThreads([...rows, { id: "t6", originalText: "no state" }], { openOnly: true });
    expect(projected.map((a) => a.id)).toEqual(["t1", "t3", "t4", "t5", "t6"]);
  });

  test("an element anchor without quoted text stays a page COMMENT; nothing restorable projects GLOBAL by default", () => {
    const byId = new Map(projectHostThreads(rows).map((a) => [a.id, a]));
    expect(byId.get("t3")?.type).toBe("COMMENT");
    expect(byId.get("t3")?.htmlAnchor).toEqual({ selector: "img#chart", tagName: "img", text: "" });
    expect(byId.get("t4")?.type).toBe("GLOBAL_COMMENT");
    expect(byId.get("t4")?.htmlAnchor).toBeUndefined();
    expect(byId.get("t1")?.type).toBe("COMMENT");
  });

  test("documentLevel: 'unanchored' keeps nothing-restorable rows as textless page COMMENTs", () => {
    // The host that treats a document-level note as a comment that lost its
    // place opts in; the row then has an empty quote and no anchor, which is
    // exactly what the viewer's unanchored union reports.
    const byId = new Map(projectHostThreads(rows, { documentLevel: "unanchored" }).map((a) => [a.id, a]));
    expect(byId.get("t4")).toMatchObject({ type: "COMMENT", originalText: "" });
    expect(byId.get("t4")?.htmlAnchor).toBeUndefined();
    // Anchored and quoted rows are untouched by the mode.
    expect(byId.get("t3")?.type).toBe("COMMENT");
    expect(byId.get("t1")?.type).toBe("COMMENT");
    // The default and the explicit 'global' agree.
    expect(projectHostThreads(rows, { documentLevel: "global" })).toEqual(projectHostThreads(rows));
  });

  test("maxTargets caps additional targets on read; absent applies the viewer's 16", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `T${i}` }));
    const row: HostThread = { id: "m", originalText: "q", htmlAdditionalTargets: many };
    expect(projectHostThreads([row])[0]?.htmlAdditionalTargets?.length).toBe(16);
    expect(projectHostThreads([row], { maxTargets: 7 })[0]?.htmlAdditionalTargets?.map((t) => t.text))
      .toEqual(many.slice(0, 7).map((t) => t.text));
  });

  test("anchors and targets validate fail-closed; presentational fields ride through", () => {
    const projected = projectHostThreads([
      {
        id: "bad",
        originalText: "kept",
        htmlAnchor: { selector: "x".repeat(2000), tagName: "p" },
        htmlAdditionalTargets: [{ text: "" }, { text: "ok", anchor: { selector: "", tagName: "" } }],
        text: "body",
        author: "ramos",
        createdA: 5,
        images: [{ path: "https://x/y.png", name: "y.png" }],
      },
    ]);
    expect(projected[0]).toEqual({
      id: "bad",
      blockId: "",
      startOffset: 0,
      endOffset: 0,
      type: "COMMENT",
      text: "body",
      originalText: "kept",
      createdA: 5,
      author: "ramos",
      images: [{ path: "https://x/y.png", name: "y.png" }],
      htmlAdditionalTargets: [{ text: "ok" }],
    });
    const gamma = projectHostThreads(rows).find((a) => a.id === "t5");
    expect(gamma?.htmlAdditionalTargets).toEqual([{ label: "Button", text: "Go", anchor: { selector: "#go", tagName: "button", text: "Go" } }]);
  });

  test("projection carries validated primary elementContext and target contexts", () => {
    // Failure caught: host panels and copy actions dropping elementContext and per-target
    // context during projection from stored host rows onto viewer annotations.
    const threadWithContext: HostThread = {
      id: "ctx1",
      originalText: "Quoted",
      htmlAnchor: { selector: "#main", tagName: "main" },
      elementContext: {
        tag: "MAIN",
        id: "main-content",
        classes: ["content"],
        role: "main",
      },
      htmlAdditionalTargets: [
        {
          text: "Extra target",
          label: "Section",
          anchor: { selector: "section#s1", tagName: "section" },
          context: { tag: "SECTION", id: "s1" },
        },
      ],
    };
    const projected = projectHostThreads([threadWithContext]);
    expect(projected.length).toBe(1);
    expect(projected[0]?.elementContext).toEqual({
      tag: "main",
      id: "main-content",
      classes: ["content"],
      role: "main",
    });
    expect(projected[0]?.htmlAdditionalTargets?.[0]?.context).toEqual({
      tag: "section",
      id: "s1",
    });

    // Malformed context fails closed to undefined without dropping the annotation
    const threadWithGarbage: HostThread = {
      id: "ctx2",
      originalText: "Quoted 2",
      elementContext: { tag: "" } as any,
      htmlAdditionalTargets: [
        { text: "Extra", context: null as any },
      ],
    };
    const projectedGarbage = projectHostThreads([threadWithGarbage]);
    expect(projectedGarbage[0]?.elementContext).toBeUndefined();
    expect(projectedGarbage[0]?.htmlAdditionalTargets?.[0]?.context).toBeUndefined();
    expect(projectedGarbage[0]?.originalText).toBe("Quoted 2");
  });

  test("is pure: the same input projects the same output and never mutates it", () => {
    const frozen = JSON.stringify(rows);
    const a = projectHostThreads(rows, { openOnly: true });
    const b = projectHostThreads(rows, { openOnly: true });
    expect(a).toEqual(b);
    expect(JSON.stringify(rows)).toBe(frozen);
  });
});

describe("parseHtmlElementContext", () => {
  test("accepts what the bridge builds and fails closed on garbage", () => {
    // Failure caught: forged or malformed bridge context messages crashing the host
    // or injecting unvalidated page-controlled content into storage.
    expect(parseHtmlElementContext(null)).toBeUndefined();
    expect(parseHtmlElementContext(undefined)).toBeUndefined();
    expect(parseHtmlElementContext("not-an-object")).toBeUndefined();
    expect(parseHtmlElementContext({})).toBeUndefined();
    expect(parseHtmlElementContext({ tag: "" })).toBeUndefined();
    expect(parseHtmlElementContext({ tag: "   " })).toBeUndefined();

    // Valid context with lowercased tag and parsed fields
    const valid = parseHtmlElementContext({
      tag: "BUTTON",
      id: "submit-btn",
      classes: ["btn", "btn-primary"],
      path: "body > form > button",
      role: "button",
      name: "Submit form",
      attrs: [["type", "submit"], ["aria-label", "Submit form"], ["onclick", "steal()"]],
      text: "Submit",
      outline: "<button type=\"submit\">\n```\nSubmit\n</button>",
      children: 1.9,
      rect: { x: 10, y: 20, w: 100, h: 40, vw: 1280, vh: 800 },
      landmark: "main",
      heading: "h1 \"Checkout\"",
      component: "data-component=SubmitBtn",
      page: { url: "/checkout?step=2", title: "Checkout" },
    });
    expect(valid).toBeDefined();
    expect(valid?.tag).toBe("button");
    expect(valid?.id).toBe("submit-btn");
    expect(valid?.classes).toEqual(["btn", "btn-primary"]);
    expect(valid?.path).toBe("body > form > button");
    expect(valid?.role).toBe("button");
    expect(valid?.name).toBe("Submit form");
    // Non-allowlisted attribute onclick was dropped
    expect(valid?.attrs).toEqual([["type", "submit"], ["aria-label", "Submit form"]]);
    expect(valid?.text).toBe("Submit");
    // Fenced backticks defused
    expect(valid?.outline).not.toContain("```");
    expect(valid?.outline).toContain("'''");
    // Children floored
    expect(valid?.children).toBe(1);
    expect(valid?.rect).toEqual({ x: 10, y: 20, w: 100, h: 40, vw: 1280, vh: 800 });
    expect(valid?.landmark).toBe("main");
    expect(valid?.heading).toBe("h1 \"Checkout\"");
    expect(valid?.component).toBe("data-component=SubmitBtn");
    expect(valid?.page).toEqual({ url: "/checkout?step=2", title: "Checkout" });

    // Non-finite rect is dropped whole
    const badRect = parseHtmlElementContext({ tag: "div", rect: { x: NaN, y: 0, w: 10, h: 10, vw: 100, vh: 100 } });
    expect(badRect?.rect).toBeUndefined();

    // Unknown keys dropped
    const extraKeys = parseHtmlElementContext({ tag: "div", unknownKey: "evil", innerHTML: "<script>" });
    expect(extraKeys).toEqual({ tag: "div" });
    expect("unknownKey" in (extraKeys ?? {})).toBe(false);

    // Bounds enforced: contextBytes <= MAX_ELEMENT_CONTEXT_BYTES
    const huge = "x".repeat(5000);
    const oversized = parseHtmlElementContext({
      tag: "div",
      text: huge,
      outline: huge,
      path: huge,
      classes: Array(30).fill("c"),
      attrs: Array(30).fill(["title", "t"]),
    });
    expect(oversized).toBeDefined();
    expect(bytes(oversized)).toBeLessThanOrEqual(MAX_ELEMENT_CONTEXT_BYTES);
  });
});
