import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHtmlAssetRegistry, framedDocumentNotFound, inlineHtmlLocalAssets } from "./html-assets";
import { HTML_ASSET_SUBRESOURCE_CSP } from "@plannotator/shared/html-assets";
import { startAnnotateServer } from "./annotate";
import { startAnnotateServer as startPiAnnotateServer } from "../../apps/pi-extension/server/serverAnnotate";

describe("annotate raw HTML assets", () => {
  test("rewrites raw HTML support assets and serves them from the source directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-html-assets-"));
    const htmlPath = join(dir, "page.html");
    const cssPath = join(dir, "style.css");
    const imagePath = join(dir, "logo.png");
    const html = '<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><img src="./logo.png"></body></html>';
    writeFileSync(htmlPath, html, "utf-8");
    writeFileSync(cssPath, "body { color: red; }", "utf-8");
    writeFileSync(imagePath, "png-bytes", "utf-8");

    const assets = createHtmlAssetRegistry();
    const rawHtml = assets.rewriteHtml(html, htmlPath);

    expect(rawHtml).toContain("/api/html-assets/");

    const cssUrl = rawHtml.match(/href="([^"]+style\.css)"/)?.[1];
    const imageUrl = rawHtml.match(/src="([^"]+logo\.png)"/)?.[1];
    expect(cssUrl).toBeTruthy();
    expect(imageUrl).toBeTruthy();

    const cssRequestUrl = new URL(cssUrl!, "http://localhost");
    const cssResponse = await assets.handle(new Request(String(cssRequestUrl)), cssRequestUrl);
    expect(cssResponse?.status).toBe(200);
    expect(cssResponse?.headers.get("content-type")).toContain("text/css");
    expect(cssResponse?.headers.get("access-control-allow-origin")).toBe("*");
    expect(await cssResponse?.text()).toBe("body { color: red; }");

    const imageRequestUrl = new URL(imageUrl!, "http://localhost");
    const imageResponse = await assets.handle(new Request(String(imageRequestUrl)), imageRequestUrl);
    expect(imageResponse?.status).toBe(200);
    expect(imageResponse?.headers.get("content-type")).toBe("image/png");
    expect(await imageResponse?.text()).toBe("png-bytes");
  });

  test("every non-HTML asset carries the sandbox CSP and nosniff: an SVG or XML opened as a document runs no script on the session origin", async () => {
    // A page in a top-level tab has only its response CSP as a sandbox, so it can
    // navigate its own tab to a sibling .svg; without a policy there, that SVG ran
    // script on this origin. As a subresource (<img>, CSS) the policy does not apply.
    const dir = mkdtempSync(join(tmpdir(), "plannotator-html-assets-svg-"));
    const htmlPath = join(dir, "page.html");
    const html = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><img src="chart.svg"></body></html>';
    writeFileSync(htmlPath, html, "utf-8");
    writeFileSync(join(dir, "chart.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/plan")</script></svg>', "utf-8");
    writeFileSync(join(dir, "data.xml"), '<html xmlns="http://www.w3.org/1999/xhtml"><script>1</script></html>', "utf-8");
    writeFileSync(join(dir, "style.css"), "body { color: red; }", "utf-8");
    writeFileSync(join(dir, "app.js"), "1", "utf-8");
    const assets = createHtmlAssetRegistry();
    const base = assets.rewriteHtml(html, htmlPath).match(/<base href="([^"]+)"/)![1]!;
    for (const name of ["chart.svg", "data.xml", "style.css", "app.js"]) {
      const url = new URL(`${base}${name}`, "http://localhost");
      const response = await assets.handle(new Request(String(url)), url);
      expect([name, response?.status, response?.headers.get("content-security-policy")]).toEqual([
        name,
        200,
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
      ]);
      expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    }
    // The page itself keeps its document policy (scripts run, at an opaque origin).
    const page = new URL(`${base}page.html`, "http://localhost");
    expect((await assets.handle(new Request(String(page)), page))?.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals");
    rmSync(dir, { recursive: true, force: true });
  });

  // An SVG (or XML) opened directly in a tab is a scriptable document on the
  // session's origin; the sandbox CSP gives it an opaque origin and no script.
  // As an <img> it never ran script, so it loads exactly as before.
  test("serves SVG, XML and every other asset with the sandbox CSP and nosniff; an <img> still loads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-html-assets-svg-"));
    try {
      const htmlPath = join(dir, "page.html");
      const html = '<!doctype html><html><body><img src="./chart.svg"><img src="./logo.png"></body></html>';
      writeFileSync(htmlPath, html, "utf-8");
      writeFileSync(join(dir, "chart.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', "utf-8");
      writeFileSync(join(dir, "logo.png"), "png-bytes", "utf-8");
      writeFileSync(join(dir, "data.xml"), "<root/>", "utf-8");

      const assets = createHtmlAssetRegistry();
      const rawHtml = assets.rewriteHtml(html, htmlPath);
      const get = async (name: string) => {
        const path = rawHtml.match(new RegExp(`"([^"]+${name.replace(".", "\\.")})"`))?.[1];
        expect(path).toBeTruthy();
        const url = new URL(path!, "http://localhost");
        return assets.handle(new Request(String(url)), url);
      };

      const svg = await get("chart.svg");
      expect(svg?.status).toBe(200);
      expect(svg?.headers.get("content-type")).toBe("image/svg+xml");
      expect(svg?.headers.get("content-security-policy")).toBe(HTML_ASSET_SUBRESOURCE_CSP);
      expect(svg?.headers.get("x-content-type-options")).toBe("nosniff");

      // An XML file in the same folder, reached the way a page's <base href>
      // reaches it: the SVG's token with another name.
      const svgPath = rawHtml.match(/"([^"]+chart\.svg)"/)![1];
      const xmlUrl = new URL(svgPath.replace(/chart\.svg$/, "data.xml"), "http://localhost");
      const xml = await assets.handle(new Request(String(xmlUrl)), xmlUrl);
      expect(xml?.status).toBe(200);
      expect(xml?.headers.get("content-security-policy")).toBe(HTML_ASSET_SUBRESOURCE_CSP);

      const png = await get("logo.png");
      expect(png?.status).toBe(200);
      // Every non-HTML asset, not only the scriptable types (a response CSP never applies to an <img> load).
      expect(png?.headers.get("content-security-policy")).toBe(HTML_ASSET_SUBRESOURCE_CSP);
      expect(png?.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("folder HTML loads parent-relative CSS and scripts and shares their bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-folder-assets-"));
    mkdirSync(join(dir, "lessons"));
    mkdirSync(join(dir, "assets"));
    const htmlPath = join(dir, "lessons", "lesson.html");
    const html = '<html><head><link rel="stylesheet" href="../assets/lesson.css"></head><body><script src="../assets/quiz.js"></script></body></html>';
    writeFileSync(htmlPath, html);
    writeFileSync(join(dir, "assets", "lesson.css"), "body { color: red; }");
    writeFileSync(join(dir, "assets", "quiz.js"), "window.quiz = true;");
    const assets = createHtmlAssetRegistry({ folderPath: dir });
    const rewritten = assets.rewriteHtml(html, htmlPath);
    for (const [name, expected] of [["lesson.css", "body { color: red; }"], ["quiz.js", "window.quiz = true;"]]) {
      const urlPath = rewritten.match(new RegExp('(?:href|src)="([^" ]+' + name.replace(".", "\\.") + ')"'))?.[1];
      expect(urlPath).toStartWith("/api/html-assets/");
      const url = new URL(urlPath!, "http://localhost");
      const response = await assets.handle(new Request(url), url);
      expect(response?.status).toBe(200);
      expect(await response?.text()).toBe(expected);
    }
    expect(rewritten).toMatch(/<base href="\/api\/html-assets\/[^/]+\/lessons\/"/);
    const shared = assets.inlineHtml(html, htmlPath);
    expect(shared).toContain("data:text/css;charset=utf-8;base64,");
    expect(shared).toContain(Buffer.from("window.quiz = true;").toString("base64"));
  });

  test("folder assets preserve literal percent characters in document directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-percent-assets-"));
    try {
      for (const name of ["100%", "a%20b"]) {
        const directory = join(root, name);
        mkdirSync(directory);
        const path = join(directory, "lesson.html");
        const html = '<link rel="stylesheet" href="./lesson.css">';
        writeFileSync(path, html);
        writeFileSync(join(directory, "lesson.css"), "body { color: red; }");
        const assets = createHtmlAssetRegistry({ folderPath: root });
        const rewritten = assets.rewriteHtml(html, path);
        const cssPath = rewritten.match(/href="([^"]+lesson.css)"/)?.[1];
        const url = new URL(cssPath!, "http://localhost");
        const response = await assets.handle(new Request(url), url);
        expect(response?.status).toBe(200);
        expect(await response?.text()).toBe("body { color: red; }");
        const shared = assets.inlineHtml(html, path);
        expect(shared).toContain(Buffer.from("body { color: red; }").toString("base64"));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the share inliner keeps a page's own hidden asset folders in a folder session", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inline-own-hidden-")));
    try {
      mkdirSync(join(root, "site", ".vendor"), { recursive: true });
      mkdirSync(join(root, ".secrets"));
      const pagePath = join(root, "site", "page.html");
      const html = '<link rel="stylesheet" href=".vendor/x.css"><script src="../.secrets/x.js"></script>';
      writeFileSync(pagePath, html);
      writeFileSync(join(root, "site", ".vendor", "x.css"), "VENDOR_STYLE");
      writeFileSync(join(root, ".secrets", "x.js"), "SECRET_SCRIPT");
      const shared = inlineHtmlLocalAssets(html, pagePath, root);
      expect(shared).toContain(Buffer.from("VENDOR_STYLE").toString("base64"));
      expect(shared).not.toContain(Buffer.from("SECRET_SCRIPT").toString("base64"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the share inliner keeps a hidden-folder page's own assets in a folder session", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inline-hidden-doc-")));
    try {
      mkdirSync(join(root, ".drafts"));
      const pagePath = join(root, ".drafts", "page.html");
      const html = '<link rel="stylesheet" href="style.css">';
      writeFileSync(pagePath, html);
      writeFileSync(join(root, ".drafts", "style.css"), "DRAFT_STYLE");
      expect(inlineHtmlLocalAssets(html, pagePath, root)).toContain(Buffer.from("DRAFT_STYLE").toString("base64"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inlines raw HTML support assets for portable share payloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-html-share-"));
    const htmlPath = join(dir, "page.html");
    const cssDir = join(dir, "styles");
    const imageDir = join(dir, "images");
    mkdirSync(cssDir);
    mkdirSync(imageDir);
    writeFileSync(join(imageDir, "bg.png"), Buffer.from([1, 2, 3]));
    writeFileSync(join(cssDir, "style.css"), 'body { background: url("../images/bg.png"); }', "utf-8");
    const html = '<!doctype html><html><head><link rel="stylesheet" href="./styles/style.css?v=1"></head><body><img src="./images/bg.png?cache=1"></body></html>';
    writeFileSync(htmlPath, html, "utf-8");

    const shareHtml = inlineHtmlLocalAssets(html, htmlPath);

    expect(shareHtml).not.toContain("/api/html-assets/");
    expect(shareHtml).toContain('href="data:text/css;charset=utf-8;base64,');
    expect(shareHtml).toContain('src="data:image/png;base64,AQID"');
    expect(shareHtml).not.toContain("base64,AQID?cache=1");

    const cssBase64 = shareHtml.match(/href="data:text\/css;charset=utf-8;base64,([^"]+)"/)?.[1];
    expect(cssBase64).toBeTruthy();
    const css = Buffer.from(cssBase64!, "base64").toString("utf-8");
    expect(css).toContain('url("data:image/png;base64,AQID")');
  });

  test("does not serve a symlinked asset that escapes the source directory", async () => {
    // Attacker bundle: a symlink inside the HTML's dir pointing at a secret outside it.
    const base = mkdtempSync(join(tmpdir(), "plannotator-html-symlink-"));
    const htmlDir = join(base, "site");
    mkdirSync(htmlDir);
    const secretPath = join(base, "secret.css");
    writeFileSync(secretPath, "SECRET_OUTSIDE_CONTENT", "utf-8");
    symlinkSync(secretPath, join(htmlDir, "evil.css"));
    const htmlPath = join(htmlDir, "page.html");
    const html = '<!doctype html><html><head><link rel="stylesheet" href="./evil.css"></head><body></body></html>';
    writeFileSync(htmlPath, html, "utf-8");

    const assets = createHtmlAssetRegistry();
    const rawHtml = assets.rewriteHtml(html, htmlPath);
    const cssUrl = rawHtml.match(/href="([^"]+evil\.css)"/)?.[1];
    expect(cssUrl).toBeTruthy();

    const requestUrl = new URL(cssUrl!, "http://localhost");
    const response = await assets.handle(new Request(String(requestUrl)), requestUrl);
    expect(response?.status).toBe(403);
    expect(await response?.text()).not.toContain("SECRET_OUTSIDE_CONTENT");
  });

  test("does not inline a symlinked asset that escapes the source directory", () => {
    const base = mkdtempSync(join(tmpdir(), "plannotator-html-symlink-inline-"));
    const htmlDir = join(base, "site");
    mkdirSync(htmlDir);
    const secretPath = join(base, "secret.css");
    writeFileSync(secretPath, "SECRET_OUTSIDE_CONTENT", "utf-8");
    symlinkSync(secretPath, join(htmlDir, "evil.css"));
    const htmlPath = join(htmlDir, "page.html");
    const html = '<!doctype html><html><head><link rel="stylesheet" href="./evil.css"></head><body></body></html>';
    writeFileSync(htmlPath, html, "utf-8");

    const shareHtml = inlineHtmlLocalAssets(html, htmlPath);
    // The symlinked secret must not be base64-embedded into the portable share.
    expect(shareHtml).not.toContain("base64");
    expect(Buffer.from(shareHtml).toString("utf-8")).not.toContain("SECRET_OUTSIDE_CONTENT");
    expect(shareHtml).not.toContain(Buffer.from("SECRET_OUTSIDE_CONTENT").toString("base64"));
  });
});

describe("annotate embedded local documents", () => {
  // realpath: containment realpaths the root but keeps a MISSING target's
  // lexical path, which on macOS's symlinked tmpdir would never match — the
  // "file is absent" cases would read as "escapes the root".
  function site(label: string): string {
    return realpathSync(mkdtempSync(join(tmpdir(), `plannotator-html-embed-${label}-`)));
  }

  function registerPage(dir: string, html: string) {
    const htmlPath = join(dir, "page.html");
    writeFileSync(htmlPath, html, "utf-8");
    const assets = createHtmlAssetRegistry();
    const rewritten = assets.rewriteHtml(html, htmlPath);
    const base = rewritten.match(/<base href="([^"]+)"/)?.[1];
    return { assets, rewritten, base: base! };
  }

  const get = (assets: ReturnType<typeof createHtmlAssetRegistry>, path: string, headers?: HeadersInit) => {
    const url = new URL(path, "http://localhost");
    return assets.handle(new Request(String(url), { headers }), url);
  };

  // The document is a srcdoc with no URL of its own, so relative resolution —
  // including a src a script assigns from data-src at runtime — only reaches
  // the right directory because of the <base href> the rewrite installs.
  test("anchors the served page at its own asset directory and serves sibling documents from it", async () => {
    const dir = site("serve");
    writeFileSync(join(dir, "embed.html"), "<html><body>EMBEDDED_SIBLING</body></html>", "utf-8");
    const { assets, base } = registerPage(
      dir,
      '<!doctype html><html><head></head><body><iframe data-src="embed.html"></iframe></body></html>',
    );
    expect(base).toMatch(/^\/api\/html-assets\/[0-9a-f]{16}\/$/);

    const response = await get(assets, `${base}embed.html?step=result`, { "sec-fetch-dest": "iframe" });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/html");
    // Defense in depth for a reviewer who opens the asset URL in a top-level
    // tab: no allow-same-origin means an opaque origin there too.
    expect(response?.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals");
    expect(response?.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response?.text()).toContain("EMBEDDED_SIBLING");
  });

  test("keeps a document in a subdirectory inside the token's root and lets it reach ../ assets", async () => {
    const dir = site("nested");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "deep.html"), "<html><body>DEEP</body></html>", "utf-8");
    writeFileSync(join(dir, "shared.css"), "body{color:red}", "utf-8");
    const { assets, base } = registerPage(dir, '<html><head></head><body><iframe src="sub/deep.html"></iframe></body></html>');

    expect((await get(assets, `${base}sub/deep.html`))?.status).toBe(200);
    // sub/deep.html loads at <base>/sub/deep.html, so its own ../shared.css
    // resolves back inside the same token root.
    expect((await get(assets, `${base}shared.css`))?.status).toBe(200);
  });

  test("refuses a document that climbs out of the annotated file's directory", async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-html-embed-escape-")));
    const dir = join(outer, "site");
    mkdirSync(dir);
    writeFileSync(join(outer, "secret.html"), "SECRET_OUTSIDE_CONTENT", "utf-8");
    const { assets, base } = registerPage(dir, "<html><head></head><body></body></html>");

    // Both spellings: URL parsing collapses the dot segments out of the path
    // before the route sees them (which is itself a guard), and the route's own
    // normalizer refuses whatever survives. Neither may reach the file.
    for (const spelling of ["../secret.html", "%2e%2e/secret.html"]) {
      const response = await get(assets, `${base}${spelling}`, { "sec-fetch-dest": "iframe" });
      expect(response?.status).toBeGreaterThanOrEqual(400);
      expect(await response?.text()).not.toContain("SECRET_OUTSIDE_CONTENT");
    }
  });

  test("a missing embed gets a small HTML document naming the file, never JSON", async () => {
    const dir = site("missing");
    const { assets, base } = registerPage(dir, "<html><head></head><body></body></html>");

    const response = await get(assets, `${base}gone.html`, { "sec-fetch-dest": "iframe" });
    expect(response?.status).toBe(404);
    expect(response?.headers.get("content-type")).toContain("text/html");
    const body = await response?.text();
    expect(body).toContain("gone.html");
    expect(body?.startsWith("<!doctype html>")).toBe(true);
    expect(body).not.toContain('"error"');
  });

  test("a non-framed asset miss keeps the JSON error shape", async () => {
    const dir = site("json");
    const { assets, base } = registerPage(dir, "<html><head></head><body></body></html>");
    const response = await get(assets, `${base}missing.css`);
    expect(response?.headers.get("content-type")).toContain("application/json");
  });

  test("an embedded document over the 2MB annotate cap is refused", async () => {
    const dir = site("large");
    writeFileSync(join(dir, "huge.html"), "x".repeat(2 * 1024 * 1024 + 1), "utf-8");
    const { assets, base } = registerPage(dir, "<html><head></head><body></body></html>");
    expect((await get(assets, `${base}huge.html`, { "sec-fetch-dest": "iframe" }))?.status).toBe(413);
  });

  // The bug this whole change is about: the catch-all rendering the editor app
  // inside an annotated page's embed.
  test("framedDocumentNotFound answers a framed request instead of letting the app be served", () => {
    const url = new URL("http://localhost/prototype-slash.html");
    const framed = framedDocumentNotFound(new Request(String(url), { headers: { "sec-fetch-dest": "iframe" } }), url);
    expect(framed?.status).toBe(404);
    expect(framed?.headers.get("content-type")).toContain("text/html");
    expect(framedDocumentNotFound(new Request(String(url)), url)).toBeNull();
    // ...but never for the app document itself, which is how the VS Code
    // extension loads a session (#1561 regression).
    const root = new URL("http://localhost/");
    expect(
      framedDocumentNotFound(new Request(String(root), { headers: { "sec-fetch-dest": "iframe" } }), root),
    ).toBeNull();
    expect(
      framedDocumentNotFound(new Request(String(url), { headers: { "sec-fetch-dest": "document" } }), url),
    ).toBeNull();
  });

  // A portable share carries one file: an embed must render empty rather than
  // resolve onto the share portal's own catch-all.
  test("portable share HTML gives embeds a base nothing resolves against", () => {
    const dir = site("share");
    const htmlPath = join(dir, "page.html");
    const html = '<html><head></head><body><iframe data-src="embed.html"></iframe></body></html>';
    writeFileSync(htmlPath, html, "utf-8");
    writeFileSync(join(dir, "embed.html"), "<html><body>EMBEDDED_SIBLING</body></html>", "utf-8");

    const shared = inlineHtmlLocalAssets(html, htmlPath);
    expect(shared).toContain('<base href="about:blank">');
    expect(shared).not.toContain("EMBEDDED_SIBLING");
  });
});

/**
 * The catch-all's framed guard, over a real server.
 *
 * #1561 scoped the guard to `Sec-Fetch-Dest` alone, so it also answered 404 for
 * the APP document — and the VS Code extension frames the session URL
 * (`panel-manager.ts` puts it in an `<iframe src>`, and every subcommand
 * launched from a VS Code terminal is routed there by `PLANNOTATOR_BROWSER`),
 * so an annotate session opened from the editor showed "404 Not found".
 */
describe("annotate catch-all: framed requests", () => {
  const APP_SHELL = "<html><body>PLANNOTATOR_APP_SHELL</body></html>";
  let savedPort: string | undefined;
  let savedRemote: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    delete process.env.PLANNOTATOR_PORT;
    process.env.PLANNOTATOR_REMOTE = "0";
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
    else process.env.PLANNOTATOR_PORT = savedPort;
    if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = savedRemote;
  });

  async function withServer(run: (url: string) => Promise<void>): Promise<void> {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-framed-catchall-")));
    const filePath = join(dir, "notes.md");
    writeFileSync(filePath, "# Notes", "utf-8");
    const server = await startAnnotateServer({
      markdown: "# Notes",
      filePath,
      htmlContent: APP_SHELL,
    });
    try {
      await run(server.url);
    } finally {
      server.stop();
    }
  }

  const framed = (url: string, path: string) =>
    fetch(`${url}${path}`, { headers: { "sec-fetch-dest": "iframe" } });

  test("serves the app to a framed request for the app document", async () => {
    await withServer(async (url) => {
      for (const path of ["/", "/?x=1"]) {
        const response = await framed(url, path);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(await response.text()).toContain("PLANNOTATOR_APP_SHELL");
      }
    });
  });

  test("answers a framed file reference with the 404 document", async () => {
    await withServer(async (url) => {
      const response = await framed(url, "/prototype-slash.html");
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toContain("prototype-slash.html");
      expect(body).not.toContain("PLANNOTATOR_APP_SHELL");
    });
  });

  test("a framed path under a directory is a file reference; a bare word is not", async () => {
    await withServer(async (url) => {
      // Only a root-relative embed is spelled with a directory segment; the app
      // has no nested routes, so this is a miss worth naming.
      expect((await framed(url, "/assets/frame")).status).toBe(404);
      // One bare segment stays with the app, so a future SPA route cannot 404
      // inside a frame.
      const bare = await framed(url, "/settings");
      expect(bare.status).toBe(200);
      expect(await bare.text()).toContain("PLANNOTATOR_APP_SHELL");
    });
  });

  test("a plain request for a missing path still gets the app, as before #1561", async () => {
    await withServer(async (url) => {
      // (Not under /assets/: that prefix is the packed chunks route, where a miss is 404.)
      for (const path of ["/prototype-slash.html", "/docs/frame", "/"]) {
        const response = await fetch(`${url}${path}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("PLANNOTATOR_APP_SHELL");
      }
    });
  });
});

for (const [runtime, startServer] of [["Bun", startAnnotateServer], ["Pi", startPiAnnotateServer]] as const) {
  test(`${runtime} folder API resolves shared assets within the selected folder`, async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-folder-api-")));
    const root = join(parent, "course");
    mkdirSync(join(root, "lessons"), { recursive: true });
    mkdirSync(join(root, "assets"));
    const filePath = join(root, "lessons", "lesson.html");
    writeFileSync(filePath, '<html><head><link rel="stylesheet" href="../assets/lesson.css"></head><body><script src="../assets/quiz.js"></script></body></html>');
    writeFileSync(join(root, "assets", "lesson.css"), "body { color: red; }");
    writeFileSync(join(root, "assets", "quiz.js"), "window.quiz = true;");
    writeFileSync(join(parent, "outside.css"), "SECRET");
    symlinkSync(join(parent, "outside.css"), join(root, "assets", "escape.css"));
    const alias = join(parent, "alias");
    symlinkSync(root, alias);
    const server = await startServer({ markdown: "", filePath: alias, folderPath: alias, mode: "annotate-folder", htmlContent: "<html></html>" });
    try {
      const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(filePath)}`);
      expect(response.status).toBe(200);
      const doc = await response.json() as { rawHtml: string };
      const cssPath = doc.rawHtml.match(/href="([^"]+lesson.css)"/)?.[1];
      expect(cssPath).toStartWith("/api/html-assets/");
      const cssResponse = await fetch(new URL(cssPath!, server.url));
      expect(cssResponse.status).toBe(200);
      expect(await cssResponse.text()).toBe("body { color: red; }");
      const jsPath = doc.rawHtml.match(/src="([^"]+quiz.js)"/)?.[1];
      expect(await (await fetch(new URL(jsPath!, server.url))).text()).toBe("window.quiz = true;");
      const escape = await fetch(new URL(cssPath!.replace("lesson.css", "escape.css"), server.url));
      expect(escape.status).toBe(403);
      const share = await fetch(`${server.url}/api/share-html?path=${encodeURIComponent(filePath)}`);
      expect(share.status).toBe(200);
      const shared = await share.json() as { shareHtml: string };
      expect(shared.shareHtml).toContain(Buffer.from("body { color: red; }").toString("base64"));
      expect(shared.shareHtml).not.toContain("SECRET");
    } finally {
      server.stop();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test(`${runtime} folder session refuses hidden files and folders, served and shared`, async () => {
    // The widened root hands the untrusted page the whole folder, so anything
    // hidden in it (a .secrets/ folder, a dotfile, an innocent name linked to
    // one) must stay out of reach, on the route and in a share link.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-folder-hidden-")));
    mkdirSync(join(root, "lessons"));
    mkdirSync(join(root, "assets"));
    mkdirSync(join(root, ".secrets"));
    const filePath = join(root, "lessons", "lesson.html");
    writeFileSync(
      filePath,
      '<html><head><link rel="stylesheet" href="../assets/lesson.css"><link rel="stylesheet" href="../.hidden.css"><link rel="stylesheet" href="../assets/innocent.css"></head><body><script src="../.secrets/creds.js"></script></body></html>',
    );
    writeFileSync(join(root, "assets", "lesson.css"), "body { color: red; }");
    writeFileSync(join(root, ".hidden.css"), "HIDDEN_FILE_SECRET");
    writeFileSync(join(root, ".secrets", "creds.json"), "HIDDEN_FOLDER_SECRET");
    writeFileSync(join(root, ".secrets", "creds.js"), "HIDDEN_FOLDER_SCRIPT");
    writeFileSync(join(root, ".secrets", "linked.css"), "LINKED_SECRET");
    symlinkSync(join(root, ".secrets", "linked.css"), join(root, "assets", "innocent.css"));
    const server = await startServer({ markdown: "", filePath: root, folderPath: root, mode: "annotate-folder", htmlContent: "<html></html>" });
    try {
      const doc = await (await fetch(`${server.url}/api/doc?path=${encodeURIComponent(filePath)}`)).json() as { rawHtml: string };
      const cssPath = doc.rawHtml.match(/href="([^"]+assets\/lesson\.css)"/)?.[1];
      expect(cssPath).toStartWith("/api/html-assets/");
      const tokenRoot = cssPath!.slice(0, -"assets/lesson.css".length);
      expect((await fetch(new URL(cssPath!, server.url))).status).toBe(200);
      for (const hidden of [".hidden.css", ".secrets/creds.json", ".secrets/creds.js", "assets/innocent.css"]) {
        const response = await fetch(new URL(`${tokenRoot}${hidden}`, server.url));
        expect(response.status, hidden).toBe(404);
        expect(await response.text()).not.toContain("SECRET");
      }
      const shared = await (await fetch(`${server.url}/api/share-html?path=${encodeURIComponent(filePath)}`)).json() as { shareHtml: string };
      expect(shared.shareHtml).toContain(Buffer.from("body { color: red; }").toString("base64"));
      for (const secret of ["HIDDEN_FILE_SECRET", "HIDDEN_FOLDER_SCRIPT", "LINKED_SECRET"]) {
        expect(shared.shareHtml).not.toContain(Buffer.from(secret).toString("base64"));
      }
    } finally {
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${runtime} folder session: a page inside a hidden folder keeps its own assets`, async () => {
    // `.drafts/page.html` is not widened to the folder root (its base would be
    // `.drafts/`, which the hidden rule refuses): its own folder is its root,
    // as on main, while pages outside hidden folders keep the refusal.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-folder-hidden-doc-")));
    mkdirSync(join(root, ".drafts"));
    mkdirSync(join(root, "lessons"));
    const draftPath = join(root, ".drafts", "page.html");
    writeFileSync(draftPath, '<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>');
    writeFileSync(join(root, ".drafts", "style.css"), "DRAFT_STYLE");
    const lessonPath = join(root, "lessons", "lesson.html");
    writeFileSync(lessonPath, '<html><head><link rel="stylesheet" href="../.drafts/style.css"></head><body></body></html>');
    const server = await startServer({ markdown: "", filePath: root, folderPath: root, mode: "annotate-folder", htmlContent: "<html></html>" });
    try {
      const draft = await (await fetch(`${server.url}/api/doc?path=${encodeURIComponent(draftPath)}`)).json() as { rawHtml: string };
      const cssPath = draft.rawHtml.match(/href="([^"]+style\.css)"/)?.[1];
      expect(cssPath).toMatch(/^\/api\/html-assets\/[0-9a-f]{16}\/style\.css$/);
      const css = await fetch(new URL(cssPath!, server.url));
      expect(css.status).toBe(200);
      expect(await css.text()).toBe("DRAFT_STYLE");
      const sharedDraft = await (await fetch(`${server.url}/api/share-html?path=${encodeURIComponent(draftPath)}`)).json() as { shareHtml: string };
      expect(sharedDraft.shareHtml).toContain(Buffer.from("DRAFT_STYLE").toString("base64"));

      const lesson = await (await fetch(`${server.url}/api/doc?path=${encodeURIComponent(lessonPath)}`)).json() as { rawHtml: string };
      const hiddenPath = lesson.rawHtml.match(/href="([^"]+\.drafts\/style\.css)"/)?.[1];
      expect(hiddenPath).toStartWith("/api/html-assets/");
      const hidden = await fetch(new URL(hiddenPath!, server.url));
      expect(hidden.status).toBe(404);
      expect(await hidden.text()).not.toContain("DRAFT_STYLE");
      const sharedLesson = await (await fetch(`${server.url}/api/share-html?path=${encodeURIComponent(lessonPath)}`)).json() as { shareHtml: string };
      expect(sharedLesson.shareHtml).not.toContain(Buffer.from("DRAFT_STYLE").toString("base64"));
    } finally {
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${runtime} folder session: a page keeps the hidden folders in its own directory`, async () => {
    // v0.28.18 served `site/.vendor/x.css` to `site/page.html` (its folder was
    // its root). The page's own directory keeps that rule, hidden segments and
    // all; the rest of the selected folder is reachable minus hidden paths.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-folder-own-hidden-")));
    for (const dir of ["site/.vendor", "lessons", "assets", ".secrets"]) mkdirSync(join(root, dir), { recursive: true });
    const pagePath = join(root, "site", "page.html");
    writeFileSync(pagePath, '<html><head><link rel="stylesheet" href=".vendor/x.css"><link rel="stylesheet" href="linked.css"></head><body></body></html>');
    writeFileSync(join(root, "site", ".vendor", "x.css"), "VENDOR_STYLE");
    writeFileSync(join(root, ".secrets", "linked.css"), "LINKED_SECRET");
    // In the page's directory, but it leads into a hidden folder elsewhere in
    // the selected folder: judged by the folder rule on its real path.
    symlinkSync(join(root, ".secrets", "linked.css"), join(root, "site", "linked.css"));
    const lessonPath = join(root, "lessons", "lesson.html");
    writeFileSync(lessonPath, '<html><head><link rel="stylesheet" href="../assets/lesson.css"></head><body><script src="../.secrets/x.json"></script></body></html>');
    writeFileSync(join(root, "assets", "lesson.css"), "LESSON_STYLE");
    writeFileSync(join(root, ".secrets", "x.json"), "SECRET_JSON");
    const server = await startServer({ markdown: "", filePath: root, folderPath: root, mode: "annotate-folder", htmlContent: "<html></html>" });
    const docOf = async (path: string) =>
      (await (await fetch(`${server.url}/api/doc?path=${encodeURIComponent(path)}`)).json() as { rawHtml: string }).rawHtml;
    const sharedOf = async (path: string) =>
      (await (await fetch(`${server.url}/api/share-html?path=${encodeURIComponent(path)}`)).json() as { shareHtml: string }).shareHtml;
    const assetUrl = (html: string, name: string) => {
      const path = html.match(new RegExp(`(?:href|src)="([^"]+${name.replace(/\./g, "\\.")})"`))?.[1];
      expect(path, name).toStartWith("/api/html-assets/");
      return new URL(path!, server.url);
    };
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    try {
      const page = await docOf(pagePath);
      const vendor = await fetch(assetUrl(page, ".vendor/x.css"));
      expect(vendor.status).toBe(200);
      expect(await vendor.text()).toBe("VENDOR_STYLE");
      const linked = await fetch(assetUrl(page, "site/linked.css"));
      expect(linked.status).toBe(404);
      expect(await linked.text()).not.toContain("LINKED_SECRET");
      const sharedPage = await sharedOf(pagePath);
      expect(sharedPage).toContain(b64("VENDOR_STYLE"));
      expect(sharedPage).not.toContain(b64("LINKED_SECRET"));

      const lesson = await docOf(lessonPath);
      const css = await fetch(assetUrl(lesson, "assets/lesson.css"));
      expect(css.status).toBe(200);
      expect(await css.text()).toBe("LESSON_STYLE");
      const secret = await fetch(assetUrl(lesson, ".secrets/x.json"));
      expect(secret.status).toBe(404);
      expect(await secret.text()).not.toContain("SECRET_JSON");
      const sharedLesson = await sharedOf(lessonPath);
      expect(sharedLesson).toContain(b64("LESSON_STYLE"));
      expect(sharedLesson).not.toContain(b64("SECRET_JSON"));
    } finally {
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${runtime} single-file session still does not serve ../ assets`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-single-parent-")));
    mkdirSync(join(root, "lessons"));
    mkdirSync(join(root, "assets"));
    const filePath = join(root, "lessons", "lesson.html");
    const html = '<html><head><link rel="stylesheet" href="../assets/lesson.css"></head><body></body></html>';
    writeFileSync(filePath, html);
    writeFileSync(join(root, "assets", "lesson.css"), "PARENT_CSS");
    const server = await startServer({ markdown: "", filePath, htmlContent: "<html></html>", rawHtml: html, renderHtml: true });
    try {
      const plan = await (await fetch(`${server.url}/api/plan`)).json() as { rawHtml: string };
      const base = plan.rawHtml.match(/<base href="([^"]+)"/)?.[1];
      expect(base).toMatch(/^\/api\/html-assets\/[0-9a-f]{16}\/$/);
      expect(plan.rawHtml).not.toMatch(/\/api\/html-assets\/[^"]*assets\/lesson\.css/);
      for (const spelling of ["../assets/lesson.css", "%2e%2e/assets/lesson.css"]) {
        const response = await fetch(new URL(`${base}${spelling}`, server.url));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(await response.text()).not.toContain("PARENT_CSS");
      }
      const shared = await (await fetch(`${server.url}/api/share-html`)).json() as { shareHtml: string };
      expect(shared.shareHtml).not.toContain(Buffer.from("PARENT_CSS").toString("base64"));
    } finally {
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
