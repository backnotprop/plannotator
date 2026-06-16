import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHtmlAssetRegistry, inlineHtmlLocalAssets } from "./html-assets";

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
});
