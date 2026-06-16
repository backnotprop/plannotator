import { describe, expect, test } from "bun:test";
import {
  encodeHtmlAssetPath,
  htmlAssetContentType,
  rewriteCssAssetReferences,
  normalizeHtmlAssetRoutePath,
  rewriteHtmlAssetReferences,
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
