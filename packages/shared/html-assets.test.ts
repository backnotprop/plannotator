import { describe, expect, test } from "bun:test";
import {
  buildHtmlAssetErrorDocument,
  encodeHtmlAssetPath,
  htmlAssetContentType,
  isFramedFetchDest,
  rewriteCssAssetReferences,
  normalizeHtmlAssetRoutePath,
  resolveHtmlAssetRoute,
  rewriteHtmlAssetReferences,
  HTML_ASSET_DOCUMENT_CONTENT_TYPE,
  HTML_ASSET_DOCUMENT_CSP,
  INERT_HTML_BASE_HREF,
  MAX_HTML_ASSET_DOCUMENT_BYTES,
} from "./html-assets";

describe("rewriteHtmlAssetReferences", () => {
  const rewrite = (html: string) =>
    rewriteHtmlAssetReferences(html, (assetPath) => `/api/html-assets/t/${encodeHtmlAssetPath(assetPath)}`);

  test("rewrites direct local support assets", () => {
    const html = `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="./style.css?v=1">
    <link rel="icon" href="icons/app icon.png">
    <style>.hero { background: url("./hero.png#cover"); }</style>
    <script src="app.js"></script>
  </head>
  <body>
    <img src="./images/logo.png" srcset="./small.png 1x, ./large.png 2x" style="background-image: url('./inline-bg.webp')">
    <video src="movie.mp4" poster="poster.jpg"></video>
    <audio src="intro.mp3"></audio>
  </body>
</html>`;

    const out = rewrite(html);

    expect(out).toContain('href="/api/html-assets/t/style.css?v=1"');
    expect(out).toContain('href="/api/html-assets/t/icons/app%20icon.png"');
    expect(out).toContain('background: url("/api/html-assets/t/hero.png#cover")');
    expect(out).toContain('src="/api/html-assets/t/app.js"');
    expect(out).toContain('src="/api/html-assets/t/images/logo.png"');
    expect(out).toContain('srcset="/api/html-assets/t/small.png 1x, /api/html-assets/t/large.png 2x"');
    expect(out).toContain('background-image: url(&quot;/api/html-assets/t/inline-bg.webp&quot;)');
    expect(out).toContain('src="/api/html-assets/t/movie.mp4"');
    expect(out).toContain('poster="/api/html-assets/t/poster.jpg"');
    expect(out).toContain('src="/api/html-assets/t/intro.mp3"');
  });

  test("leaves external, root-relative, data, anchors, and navigation links alone", () => {
    const html = `
<link rel="stylesheet" href="https://cdn.example.com/app.css">
<link rel="stylesheet" href="/site.css">
<a href="other.html">Other page</a>
<a href="#section">Section</a>
<img src="data:image/png;base64,abc">
<img src="//cdn.example.com/image.png">
`;

    const out = rewrite(html);

    expect(out).toContain('href="https://cdn.example.com/app.css"');
    expect(out).toContain('href="/site.css"');
    expect(out).toContain('href="other.html"');
    expect(out).toContain('href="#section"');
    expect(out).toContain('src="data:image/png;base64,abc"');
    expect(out).toContain('src="//cdn.example.com/image.png"');
  });

  test("does not rewrite traversal or unknown extension asset refs", () => {
    const out = rewrite('<img src="../secret.png"><script src="server"></script>');

    expect(out).toContain('src="../secret.png"');
    expect(out).toContain('src="server"');
  });
});

describe("rewriteCssAssetReferences", () => {
  test("rewrites local url() references relative to the stylesheet path", () => {
    const css = `
body { background: url("../images/bg.png?v=1"); }
@font-face { src: url("./font.woff2") format("woff2"); }
@import "./theme.css";
.remote { background: url("https://example.test/a.png"); }
`;

    const out = rewriteCssAssetReferences(
      css,
      (assetPath) => `/assets/${encodeHtmlAssetPath(assetPath)}`,
      "styles",
    );

    expect(out).toContain('url("/assets/images/bg.png?v=1")');
    expect(out).toContain('url("/assets/styles/font.woff2")');
    expect(out).toContain('@import url("/assets/styles/theme.css")');
    expect(out).toContain('url("https://example.test/a.png")');
  });
});

describe("html asset route helpers", () => {
  test("normalizes valid route paths", () => {
    expect(normalizeHtmlAssetRoutePath("assets/logo%20small.png")).toBe("assets/logo small.png");
    expect(normalizeHtmlAssetRoutePath("./assets/../logo.svg")).toBe("logo.svg");
    expect(normalizeHtmlAssetRoutePath("assets/100%2525%20done.png")).toBe("assets/100%25 done.png");
  });

  test("rejects traversal and invalid encodings", () => {
    expect(normalizeHtmlAssetRoutePath("../logo.png")).toBeNull();
    expect(normalizeHtmlAssetRoutePath("..%2Flogo.png")).toBeNull();
    expect(normalizeHtmlAssetRoutePath("%E0%A4%A")).toBeNull();
  });

  test("returns expected content types", () => {
    expect(htmlAssetContentType("style.css")).toBe("text/css; charset=utf-8");
    expect(htmlAssetContentType("font.woff2")).toBe("font/woff2");
    expect(htmlAssetContentType("site.webmanifest")).toBe("application/manifest+json; charset=utf-8");
    expect(htmlAssetContentType("image.unknown")).toBeNull();
  });
});

describe("embedded local documents", () => {
  const rewriteBase = (html: string, baseHref = "/api/html-assets/tok/") =>
    rewriteHtmlAssetReferences(html, () => null, { baseHref });

  // The whole point of the base: it changes RESOLUTION, so a src a script
  // assigns at runtime from data-src is covered too. A serve-time attribute
  // rewrite could never reach that markup.
  test("anchors the document at its own asset directory with a <base href> first in head", () => {
    const out = rewriteBase('<!doctype html><html><head><title>x</title></head><body></body></html>');
    expect(out).toContain('<head><base href="/api/html-assets/tok/"><title>');
  });

  test("inserts the base even when the document declares no head", () => {
    expect(rewriteBase("<html><body><p>hi</p></body></html>")).toContain('<base href="/api/html-assets/tok/">');
  });

  test("re-anchors a relative author base onto the asset directory", () => {
    const out = rewriteBase('<!doctype html><html><head><base href="sub/"></head><body></body></html>');
    expect(out).toContain('<base href="/api/html-assets/tok/sub/">');
  });

  // An author who wrote an absolute or root-relative base pinned an origin on
  // purpose; silently retargeting it would change what their page loads.
  test("leaves an absolute or root-relative author base untouched", () => {
    expect(rewriteBase('<html><head><base href="https://cdn.example/"></head></html>')).toContain(
      '<base href="https://cdn.example/">',
    );
    expect(rewriteBase('<html><head><base href="/assets/"></head></html>')).toContain('<base href="/assets/">');
  });

  test("a rewrite with no base option is byte-identical to the unoptioned rewrite", () => {
    const html = '<!doctype html><html><head><title>x</title></head><body><img src="a.png"></body></html>';
    const mapper = (p: string) => `/api/html-assets/t/${p}`;
    expect(rewriteHtmlAssetReferences(html, mapper, {})).toBe(rewriteHtmlAssetReferences(html, mapper));
  });

  // Portable exports carry one file: an embed must render EMPTY rather than
  // resolve onto the share portal's catch-all (the same bug, elsewhere).
  test("inertBase neutralizes relative resolution only for documents that embed frames", () => {
    const withFrame = rewriteHtmlAssetReferences(
      '<html><head></head><body><iframe src="sib.html"></iframe></body></html>',
      () => null,
      { inertBase: true },
    );
    expect(withFrame).toContain(`<base href="${INERT_HTML_BASE_HREF}">`);
    const withoutFrame = rewriteHtmlAssetReferences(
      "<html><head></head><body><p>hi</p></body></html>",
      () => null,
      { inertBase: true },
    );
    expect(withoutFrame).not.toContain("<base");
  });
});

describe("resolveHtmlAssetRoute", () => {
  const roots = (token: string) => (token === "tok" ? "/site" : undefined);
  const resolve = (pathname: string, secFetchDest?: string) =>
    resolveHtmlAssetRoute({ pathname, secFetchDest }, roots);

  test("serves a sibling HTML file as a sandboxed document under the annotate cap", () => {
    expect(resolve("/api/html-assets/tok/prototype.html")).toMatchObject({
      kind: "serve",
      root: "/site",
      assetPath: "prototype.html",
      contentType: HTML_ASSET_DOCUMENT_CONTENT_TYPE,
      document: true,
      maxBytes: MAX_HTML_ASSET_DOCUMENT_BYTES,
    });
    // No allow-same-origin: an embedded document must never reach this
    // session's API as a same-origin caller.
    expect(HTML_ASSET_DOCUMENT_CSP).not.toContain("allow-same-origin");
  });

  test("refuses a path that climbs out of the token's directory", () => {
    expect(resolve("/api/html-assets/tok/../secret.html")).toMatchObject({ kind: "error", status: 400 });
    expect(resolve("/api/html-assets/tok/%2e%2e/secret.html")).toMatchObject({ kind: "error", status: 400 });
  });

  test("a framed request gets an HTML error document; a plain asset request keeps JSON", () => {
    expect(resolve("/api/html-assets/nope/page.css", "iframe")).toMatchObject({ asDocument: true });
    expect(resolve("/api/html-assets/nope/page.css")).toMatchObject({ asDocument: false });
    // An .html path is a document however it was requested — a reviewer
    // pasting the URL into a tab must not get JSON either.
    expect(resolve("/api/html-assets/nope/page.html")).toMatchObject({ asDocument: true });
  });

  test("still refuses asset types it has no content type for", () => {
    expect(resolve("/api/html-assets/tok/notes.pdf")).toMatchObject({ kind: "error", status: 415 });
  });

  test("ignores everything outside the asset prefix", () => {
    expect(resolve("/api/plan")).toEqual({ kind: "not-asset-route" });
  });
});

describe("buildHtmlAssetErrorDocument", () => {
  test("names the missing file and escapes it", () => {
    const doc = buildHtmlAssetErrorDocument(404, "Not found", "<img>.html");
    expect(doc).toContain("&lt;img&gt;.html");
    expect(doc).not.toContain("<img>");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
  });
});

describe("isFramedFetchDest", () => {
  test("recognizes every nested-document destination and nothing else", () => {
    for (const dest of ["iframe", "frame", "embed", "object", "IFRAME"]) {
      expect(isFramedFetchDest(dest)).toBe(true);
    }
    for (const dest of ["document", "script", "image", "empty", "", null, undefined]) {
      expect(isFramedFetchDest(dest)).toBe(false);
    }
  });
});
