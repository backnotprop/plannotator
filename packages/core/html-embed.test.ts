/**
 * The live HTML embed's boundary (approval "inbox-inline-html"), a sandboxed
 * frame as T3 Code draws one. What regresses if these fail:
 * - the frame gains `allow-same-origin` (or another sandbox token): the page
 *   would share the Inbox's origin and could read and write its API;
 * - the document's own policy stops sandboxing it, or lists `'self'` or
 *   plain http (the Inbox on this computer);
 * - the bootstrap takes a theme from any window but the Inbox's, or no longer
 *   runs before the agent's own markup (a page would paint before the theme);
 * - the message reader accepts something other than a height, a web link or
 *   Escape, or an unbounded height.
 */
import { describe, expect, test } from "bun:test";
import { buildEmbedDocument, EMBED_BOOTSTRAP, EMBED_MAX_HEIGHT, EMBED_REMOTE_SOURCES, EMBED_RESPONSE_CSP, EMBED_SANDBOX, embedFragment, readEmbedMessage } from "./html-embed";

const directives = new Map(
  EMBED_RESPONSE_CSP.split(";").map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name!, values] as const;
  }),
);

describe("the embed's sandbox and policy", () => {
  test("the frame's sandbox is allow-scripts allow-forms and nothing else (never widen it)", () => {
    // Pinned on purpose: any added token (allow-same-origin above all) is a security decision, not a refactor.
    expect(EMBED_SANDBOX).toBe("allow-scripts allow-forms");
  });

  test("the response sandboxes the document the same way, so its URL opened as a tab is opaque too", () => {
    expect(directives.get("sandbox")).toEqual(["allow-scripts", "allow-forms"]);
  });

  test("no directive lets the page reach the Inbox: no 'self', no plain http, no wildcard", () => {
    for (const [name, values] of directives) {
      if (name === "frame-ancestors") continue;
      expect(values).not.toContain("'self'");
      expect(values.some((value) => /^http:/i.test(value) || value === "*")).toBe(false);
    }
    // The web over HTTPS is the owner's choice (2026-10-28); `connect-src` is exactly that.
    expect(directives.get("connect-src")).toEqual([EMBED_REMOTE_SOURCES]);
    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'self'"]);
  });
});

describe("the bootstrap takes a theme from the Inbox's window only", () => {
  const run = () => {
    const themed: string[] = [];
    const root = { style: { setProperty: (name: string) => themed.push(name), colorScheme: "" }, setAttribute() {}, getBoundingClientRect: () => ({ height: 0 }) };
    const parent = { postMessage() {} };
    let onMessage: ((event: { source: unknown; data: unknown }) => void) | null = null;
    const listen = (type: string, handler: (event: never) => void) => {
      if (type === "message") onMessage = handler as typeof onMessage;
    };
    new Function("window", "document", "location", "addEventListener", "setTimeout", "ResizeObserver", EMBED_BOOTSTRAP)(
      { parent },
      { documentElement: root, body: null, addEventListener() {} },
      { hash: "" },
      listen,
      () => 0,
      undefined,
    );
    return { parent, themed, send: (source: unknown, data: unknown) => onMessage!({ source, data }) };
  };
  const theme = { pnEmbed: 1, kind: "theme", vars: { "--foreground": "red" }, scheme: "dark" };

  test("a theme from another window (another embed) does nothing; the same from the Inbox's applies", () => {
    const page = run();
    page.send({}, theme);
    expect(page.themed).toEqual([]);
    page.send(page.parent, theme);
    expect(page.themed).toEqual(["--foreground"]);
  });
});

describe("the bootstrap loads the page again for a link or a GET form to itself", () => {
  // An agent's ```html page with its own switcher (`<a href="?view=2">`) or a search form: in a tab both load the
  // page again with the query. The embed is served at /api/inbox/embeds/<id>, so the same works there, in place
  // (location.replace: no history entry), keeping the theme's fragment the page was first given.
  type Handler = (event: Record<string, unknown>) => void;
  const run = (hash = "#pn=%7B%7D") => {
    const replaced: string[] = [];
    const onDocument: Record<string, Handler> = {};
    const onWindow: Record<string, Handler> = {};
    const location = { hash, pathname: "/api/inbox/embeds/abc", replace: (url: string) => replaced.push(url) };
    const root = { style: { setProperty() {}, colorScheme: "" }, setAttribute() {}, getBoundingClientRect: () => ({ height: 0 }) };
    /** The fields a fake form holds, read by `new FormData(form, submitter)`. */
    class FakeFormData {
      private entries: [string, unknown][];
      constructor(form: { fields: [string, unknown][] }, submitter?: { field?: [string, unknown] } | null) {
        this.entries = [...form.fields, ...(submitter?.field ? [submitter.field] : [])];
      }
      forEach(fn: (value: unknown, key: string) => void) {
        for (const [key, value] of this.entries) fn(value, key);
      }
    }
    new Function("window", "document", "location", "addEventListener", "setTimeout", "ResizeObserver", "FormData", EMBED_BOOTSTRAP)(
      { parent: { postMessage() {} } },
      { documentElement: root, body: null, addEventListener: (type: string, fn: Handler) => (onDocument[type] = fn) },
      location,
      (type: string, fn: Handler) => (onWindow[type] = fn),
      () => 0,
      undefined,
      FakeFormData,
    );
    const click = (href: string, isTrusted = true) => {
      const event = { target: { closest: () => ({ getAttribute: () => href }) }, defaultPrevented: false, isTrusted, preventDefault() {} };
      onDocument.click!(event);
    };
    const attr = (values: Record<string, string>) => (name: string) => values[name] ?? null;
    const submit = (form: Record<string, string>, fields: [string, unknown][], submitter: Record<string, string> | null = null) => {
      let prevented = false;
      onWindow.submit!({
        target: { tagName: "FORM", getAttribute: attr(form), fields },
        submitter: submitter ? { getAttribute: attr(submitter), field: submitter.name ? [submitter.name, submitter.value] : undefined } : null,
        defaultPrevented: false,
        preventDefault: () => (prevented = true),
      });
      return prevented;
    };
    return { replaced, click, submit };
  };

  test("a link that is only a query loads this page with it, the theme's fragment kept unless the link has one", () => {
    const page = run();
    page.click("?view=2&n=3");
    page.click("?x=1#top");
    expect(page.replaced).toEqual(["/api/inbox/embeds/abc?view=2&n=3#pn=%7B%7D", "/api/inbox/embeds/abc?x=1#top"]);
  });

  test("another page's address, a web link or a script's click does not reload", () => {
    const page = run();
    for (const href of ["other.html?x=1", "https://example.com/?x=1", "/api/inbox/threads?x=1", "javascript:void(0)"]) page.click(href);
    page.click("?x=1", false);
    expect(page.replaced).toEqual([]);
  });

  test("a GET form with no action, or only a query, loads this page with its fields; text fields only", () => {
    const page = run();
    expect(page.submit({}, [["q", "a b"], ["file", { name: "x.png" }]], { name: "view", value: "grid" })).toBe(true);
    page.submit({ action: "?old=1" }, [["q", "c"]]);
    expect(page.replaced).toEqual(["/api/inbox/embeds/abc?q=a+b&view=grid#pn=%7B%7D", "/api/inbox/embeds/abc?q=c#pn=%7B%7D"]);
  });

  test("a POST form, or one with an address of its own, is left alone (the frame's policy refuses it)", () => {
    const page = run();
    expect(page.submit({ method: "post" }, [["q", "1"]])).toBe(false);
    expect(page.submit({ action: "https://example.com/search" }, [["q", "1"]])).toBe(false);
    expect(page.submit({}, [["q", "1"]], { formmethod: "post" })).toBe(false);
    expect(page.replaced).toEqual([]);
  });
});

describe("buildEmbedDocument", () => {
  const ourHead = (doc: string) => doc.indexOf(EMBED_BOOTSTRAP);

  test("a fragment lands after the bootstrap", () => {
    const doc = buildEmbedDocument('<div id="chart"></div><script>draw()</script>');
    expect(ourHead(doc)).toBeGreaterThan(0);
    expect(doc.indexOf('<div id="chart">')).toBeGreaterThan(ourHead(doc));
  });

  test("a whole document's doctype is replaced by ours, and its own head comes after the bootstrap", () => {
    const page = "<!-- chart -->\n<!DOCTYPE html>\n<html lang=\"en\"><head><script>early()</script></head><body>x</body></html>";
    const doc = buildEmbedDocument(page);
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc.indexOf("early()")).toBeGreaterThan(ourHead(doc));
  });

  test("the page's own markup is kept as written", () => {
    const page = "<style>.bar{fill:var(--chart-1)}</style><svg><rect class=bar /></svg>";
    expect(buildEmbedDocument(page).endsWith(page)).toBe(true);
  });
});

describe("the theme fragment", () => {
  test("round-trips the theme and mode the bootstrap reads", () => {
    const fragment = embedFragment({ vars: { "--foreground": "oklch(0.2 0 0)", "--font-sans": '"Inter", sans-serif' }, scheme: "dark" }, "full");
    const raw = /^#pn=(.*)$/.exec(fragment)![1]!;
    expect(raw).not.toMatch(/[#&\s]/);
    expect(JSON.parse(decodeURIComponent(raw))).toEqual({
      vars: { "--foreground": "oklch(0.2 0 0)", "--font-sans": '"Inter", sans-serif' },
      scheme: "dark",
      mode: "full",
    });
  });
});

describe("readEmbedMessage", () => {
  test("a height is rounded and kept within bounds", () => {
    expect(readEmbedMessage({ pnEmbed: 1, kind: "height", height: 212.4 })).toEqual({ kind: "height", height: 212 });
    expect(readEmbedMessage({ pnEmbed: 1, kind: "height", height: 1e9 })).toEqual({ kind: "height", height: EMBED_MAX_HEIGHT });
    expect(readEmbedMessage({ pnEmbed: 1, kind: "height", height: -5 })).toEqual({ kind: "height", height: 0 });
    expect(readEmbedMessage({ pnEmbed: 1, kind: "height", height: Number.NaN })).toBeNull();
  });

  test("only web links are handed over", () => {
    expect(readEmbedMessage({ pnEmbed: 1, kind: "link", url: "https://example.com/a" })).toEqual({ kind: "link", url: "https://example.com/a" });
    for (const url of ["javascript:alert(1)", "/api/inbox/threads", "file:///etc/passwd", "https://a b", `https://x/${"a".repeat(5000)}`]) {
      expect(readEmbedMessage({ pnEmbed: 1, kind: "link", url })).toBeNull();
    }
  });

  test("anything else is ignored", () => {
    expect(readEmbedMessage({ pnEmbed: 1, kind: "escape" })).toEqual({ kind: "escape" });
    for (const data of [null, "height", { kind: "height", height: 10 }, { pnEmbed: 2, kind: "escape" }, { pnEmbed: 1, kind: "navigate", url: "https://x" }, { pnEmbed: 1, kind: "focus" }]) {
      expect(readEmbedMessage(data)).toBeNull();
    }
  });
});
