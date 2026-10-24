import { describe, expect, it } from "bun:test";
import { MAX_ANSWER_HTML_BYTES, SHOW_ANSWER_TOOL, answerLinks, checkShowAnswer, type AnswerLinkHooks } from "./answer-tool";

const files = new Set(["src/webhooks/deliver.ts", "src/queue/worker.ts"]);
const hooks: AnswerLinkHooks = {
  chapterCount: 5,
  fileExists: async (p) => files.has(p),
  resolveSymbol: async (name) => (name === "computeBackoff" || name === "deliverWebhook" ? { status: "found" } : { status: "missing" }),
};

describe("show_answer", () => {
  it("is offered with a strict schema and the answer guide as its description", () => {
    expect(SHOW_ANSWER_TOOL.name).toBe("show_answer");
    expect((SHOW_ANSWER_TOOL.inputSchema as { required: string[]; additionalProperties: boolean }).required).toEqual(["title", "html"]);
    expect((SHOW_ANSWER_TOOL.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    expect(SHOW_ANSWER_TOOL.description).toContain("code:");
    expect(SHOW_ANSWER_TOOL.description).toContain("--chart-1");
  });

  it("takes a page with scripts, inline SVG and resolving links as it is", async () => {
    const html = `<style>.box{fill:var(--card)}</style>
<p>Before, <a href="symbol:deliverWebhook">deliverWebhook</a> threw. Lines <a href="code:src/webhooks/deliver.ts#L25-L31">25–31</a> decide.</p>
<svg><g data-link="code:src/queue/worker.ts#L12"><rect class="box"/></g></svg>
<pre class="mermaid">flowchart LR
 a-->b
 click b "chapter:4"</pre>
<script>document.querySelector('p').dataset.ran = '1'</script>`;
    const r = await checkShowAnswer({ title: "  Failures   used to loop back. ", html }, hooks);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.title).toBe("Failures used to loop back.");
    expect(r.html).toBe(html);
    expect(r.html).toContain("<script>");
    expect(r.links).toBe(4);
    expect(r.text).toContain("End your turn");
  });

  it("names every problem at once: missing title, a chapter past the end, a missing file and symbol, a bad path", async () => {
    const r = await checkShowAnswer({
      html: `<a href="chapter:9">x</a> <a href="code:src/gone.ts#L3">y</a> <a href="symbol:nope">z</a> <a href="code:/abs/path.ts">w</a> <a href="https://example.com">ok</a>`,
    }, hooks);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.text).toContain("call show_answer again");
    expect(r.text).toContain("title is missing");
    expect(r.text).toContain("chapter:9: the guide has 5 chapters");
    expect(r.text).toContain("code:src/gone.ts#L3: no such file");
    expect(r.text).toContain("symbol:nope: no such symbol");
    expect(r.text).toContain("`code:/abs/path.ts`: use the repo-relative path");
    expect(r.text).not.toContain("example.com");
  });

  it("refuses a page over the size cap and an empty page", async () => {
    const big = await checkShowAnswer({ title: "t", html: "x".repeat(MAX_ANSWER_HTML_BYTES + 1) }, hooks);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.text).toContain("the limit is 128 KB");
    const empty = await checkShowAnswer({ title: "t", html: "   " }, hooks);
    expect(empty.ok).toBe(false);
  });

  it("finds links in hrefs, data-link attributes and Mermaid click lines, once each, entities decoded", () => {
    const links = answerLinks(`<a href='code:a.ts#L1'>a</a><a href="code:a.ts#L1">again</a><div data-link="symbol:x&amp;y"></div><a href="mailto:x">m</a>
<div class="mermaid">graph LR
 n-->m
 click m &quot;chapter:2&quot;</div>`);
    expect(links).toEqual(["code:a.ts#L1", "symbol:x&y", "chapter:2"]);
  });

  it("accepts a symbol link unchecked when no symbol hook is given", async () => {
    const r = await checkShowAnswer({ title: "t", html: `<a href="symbol:anything">a</a>` }, { chapterCount: 1, fileExists: async () => false });
    expect(r.ok).toBe(true);
  });
});
