/**
 * The HTML viewer's link guard and no-network policy go first in the frame's
 * document whatever the page contains, read by a spec-compliant parser
 * (parse5, a dependency of this package; the viewer code is in
 * packages/ui/components/html-viewer/srcdoc.ts and linkGuard.ts).
 *
 * Guards: on raw pages that a regex scanner and a browser read differently
 * (`<!-->`, `<!--->`, `--!>`, `</title x>`, `</title/>`), and on pages with a
 * BOM, whitespace or comments or an XML prolog before the doctype, a meta
 * refresh, a `<base href>`, a script ahead of `<html>`, `<plaintext>`, an
 * unclosed `<title>` or comment: the first script the parser builds is the
 * guard, with this load's key; a leading doctype keeps standards mode. A page
 * that reached the rewrite's error path keeps `connect-src 'none'` ahead of
 * every script.
 */
import { describe, expect, test } from "bun:test";
import * as parse5 from "parse5";
import { injectIntoHead, injectLinkGuard, injectNoNetworkCsp, injectPrintDefaults, injectSandboxShim, NO_NETWORK_CSP_META } from "../ui/components/html-viewer/srcdoc";
import { prependNoNetworkMarker } from "./html-assets";

const KEY = "0123456789abcdef0123456789abcdef";
const INJECTION = "<style></style><script>bridge()</script>";

/** The frame's document as HtmlViewer builds it on the inline path. */
function framed(page: string, marked = false): string {
  const built = injectLinkGuard(injectSandboxShim(injectIntoHead(injectPrintDefaults(page), INJECTION)), KEY);
  return marked ? injectNoNetworkCsp(built) : built;
}

type Node = { nodeName: string; attrs?: Array<{ name: string; value: string }>; childNodes?: Node[]; content?: Node; value?: string };

/** Elements in document order, the order parser-inserted scripts run in. */
function elements(doc: Node): Node[] {
  const out: Node[] = [];
  const walk = (node: Node) => {
    if (node.attrs) out.push(node);
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(doc);
  return out;
}

const text = (node: Node) => (node.childNodes ?? []).map((child) => child.value ?? "").join("");

function read(html: string) {
  // A served frame's bytes are decoded, which drops a leading BOM (a srcdoc string keeps it, and a page that
  // starts with one is in quirks mode there with or without the viewer).
  const doc = parse5.parse(html.replace(/^\uFEFF/, '')) as unknown as Node & { mode: string };
  const all = elements(doc);
  const scripts = all.filter((node) => node.nodeName === "script");
  return { mode: doc.mode, all, scripts };
}

function expectGuardFirst(html: string) {
  const { scripts } = read(html);
  expect(scripts.length).toBeGreaterThan(0);
  expect(text(scripts[0]!)).toContain("__plannotatorLinkGuard");
  expect(text(scripts[0]!)).toContain(`('${KEY}')`);
}

describe("the link guard is the first script a browser runs", () => {
  const EVIL = "<script>evil()</script>";
  const tricks: Array<[string, string]> = [
    ["an abrupt comment <!-->", `<!doctype html><!-->${EVIL}<!-- --><html><head><title>x</title></head><body><p>x</p></body></html>`],
    ["an abrupt comment <!--->", `<!doctype html><!--->${EVIL}<!-- --><html><head></head><body></body></html>`],
    ["a comment ended by --!>", `<!doctype html><!-- a --!>${EVIL}<!-- b --><html><head></head><body></body></html>`],
    ["a title ended by </title x>", `<!doctype html><title></title x>${EVIL}</title><head></head><body></body>`],
    ["a title ended by </title/>", `<!doctype html><title></title/>${EVIL}</title><head></head><body></body>`],
    ["a style ended by </style x>", `<!doctype html><style></style x>${EVIL}</style><head></head><body></body>`],
    ["a script before <html>", `${EVIL}<!doctype html><html><head></head><body></body></html>`],
    ["a script right after the doctype", `<!doctype html>${EVIL}<html><head></head><body></body></html>`],
    ["a head script", `<!DOCTYPE html><html><head>${EVIL}</head><body></body></html>`],
    ["a meta refresh", `<!doctype html><head><meta http-equiv="refresh" content="0;url=elsewhere.html">${EVIL}</head><body></body>`],
    ["a base href", `<!doctype html><head><base href="https://elsewhere.example/">${EVIL}</head><body></body>`],
    ["a page that starts with <plaintext>", `<plaintext>${EVIL}`],
    ["a plaintext after the doctype", `<!doctype html><plaintext>${EVIL}`],
    ["an unclosed title", `<!doctype html><title>${EVIL}`],
    ["an unclosed textarea", `<textarea>${EVIL}`],
    ["an unclosed comment before the doctype", `<!-- <!doctype html>${EVIL}`],
    ["a page with no doctype or head", `<p>hi</p>${EVIL}`],
  ];
  for (const [name, page] of tricks) {
    test(name, () => expectGuardFirst(framed(page)));
  }

  test("a BOM, whitespace, comments and an XML prolog before the doctype: after the doctype, standards mode kept", () => {
    for (const lead of ["﻿", " \n\t", "<!-- a --><!-- b --!>\n", "<!---->", "<!-->", '<?xml version="1.0" encoding="utf-8"?>\n']) {
      const html = framed(`${lead}<!DOCTYPE html><html><head><script>evil()</script></head><body></body></html>`);
      expectGuardFirst(html);
      expect(read(html).mode).toBe("no-quirks");
      expect(html.indexOf("<!DOCTYPE html>")).toBeLessThan(html.indexOf("__plannotatorLinkGuard"));
    }
  });

  test("a plain page keeps standards mode", () => {
    expect(read(framed("<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>")).mode).toBe("no-quirks");
  });
});

describe("a marked page keeps connect-src 'none' ahead of every script", () => {
  const firstPolicyThenGuard = (html: string) => {
    const { all } = read(html);
    const policy = all.findIndex((node) => node.nodeName === "meta" && node.attrs!.some((attr) => attr.name === "http-equiv" && /content-security-policy/i.test(attr.value)));
    const script = all.findIndex((node) => node.nodeName === "script");
    expect(policy).toBeGreaterThan(-1);
    expect(policy).toBeLessThan(script);
    expectGuardFirst(html);
  };

  test("on the rewrite's error path, with a comment trick before a late doctype", () => {
    const page = prependNoNetworkMarker("<!--><script>fetch('/x')</script><!-- --><!doctype html><html><head></head><body></body></html>");
    firstPolicyThenGuard(framed(page, true));
  });

  test("with a doctype, a BOM or comments ahead", () => {
    for (const lead of ["", "﻿", "<!-- a --!>"]) {
      const page = prependNoNetworkMarker(`${lead}<!doctype html><html><head><script>fetch('/x')</script></head><body></body></html>`);
      const html = framed(page, true);
      firstPolicyThenGuard(html);
      expect(read(html).mode).toBe("no-quirks");
      expect(html).toContain(NO_NETWORK_CSP_META);
    }
  });
});
