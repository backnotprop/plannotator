/** An HTML page attached to a message shows pictures from anywhere on this computer or the web; the registry is driven directly, no Inbox started. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHtmlAssetRegistry } from "./html-assets";
import { createInboxHtmlAssets, INBOX_HTML_DOCUMENT_CSP } from "./inbox-attachments";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>fetch("/api/inbox/threads")</script><rect width="4" height="4"/></svg>';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-html-pictures-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 *   <tmp>/work/page/page.html   the attached page
 *   <tmp>/work/page/logo.png    in its folder
 *   <tmp>/work/shots/a.png      one folder up
 *   <tmp>/other/b.png, c.svg    in another folder (named by absolute path)
 */
function layout() {
  const root = mkdtempSync(join(tmp, "case-"));
  const page = join(root, "work", "page");
  mkdirSync(page, { recursive: true });
  mkdirSync(join(root, "work", "shots"));
  mkdirSync(join(root, "other"));
  mkdirSync(join(root, "other", ".cache"));
  mkdirSync(join(page, ".hidden"));
  writeFileSync(join(page, "logo.png"), PNG);
  writeFileSync(join(page, ".hidden", "in.png"), PNG);
  writeFileSync(join(root, "work", "shots", "a.png"), PNG);
  writeFileSync(join(root, "other", "b.png"), PNG);
  writeFileSync(join(root, "other", "c.svg"), SVG);
  writeFileSync(join(root, "other", "notes.txt"), "secret notes");
  writeFileSync(join(root, "other", "fake.png"), "not a picture, just text");
  writeFileSync(join(root, "other", "page.svg"), "<!doctype html><html><body><script>1</script></body></html>");
  writeFileSync(join(root, "other", ".env"), "TOKEN=1");
  writeFileSync(join(root, "other", ".cache", "d.png"), PNG);
  symlinkSync(join(root, "other", ".cache", "d.png"), join(root, "other", "innocent.png"));
  return { root, page, htmlPath: join(page, "page.html"), other: join(root, "other") };
}

async function get(assets: { handle: (req: Request, url: URL) => Promise<Response | null> }, path: string) {
  const url = new URL(path, "http://localhost");
  const response = await assets.handle(new Request(String(url)), url);
  if (!response) throw new Error(`not an asset route: ${path}`);
  return response;
}

function attrOf(html: string, tag: string, id: string, attr = "src"): string {
  const element = new RegExp(`<${tag}[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
  return new RegExp(`\\s${attr}="([^"]*)"`).exec(element)?.[1] ?? "";
}

describe("Inbox: an attached page's pictures from anywhere", () => {
  test("a png one folder up, in another folder by absolute path or file: URL, in srcset and CSS, loads as the image it is", async () => {
    const { htmlPath, other } = layout();
    const html = `<!doctype html><html><head></head><body>
      <img id="up" src="../shots/a.png">
      <img id="abs" src="${other}/b.png?v=2">
      <img id="file" src="file://${other}/b.png">
      <img id="set" srcset="../shots/a.png 1x, ${other}/b.png 2x">
      <div id="bg" style="background-image: url('../shots/a.png')"></div>
      <style>.hero { background: url(${other}/b.png) }</style>
      <img id="web" src="https://avatars.githubusercontent.com/u/1?v=4">
    </body></html>`;
    const assets = createInboxHtmlAssets();
    const out = assets.rewriteHtml(html, htmlPath);

    const up = attrOf(out, "img", "up");
    expect(up).toMatch(/^\/api\/html-assets\/[0-9a-f]{16}\/a\.png$/);
    expect(attrOf(out, "img", "abs")).toMatch(/^\/api\/html-assets\/[0-9a-f]{16}\/b\.png\?v=2$/);
    expect(attrOf(out, "img", "file")).toBe(attrOf(out, "img", "abs").replace("?v=2", ""));
    expect(attrOf(out, "img", "set", "srcset")).toBe(`${up} 1x, ${attrOf(out, "img", "file")} 2x`);
    expect(out).toContain(`url(&quot;${up}&quot;)`);
    expect(out).toContain(`url("${attrOf(out, "img", "file")}")`);
    expect(attrOf(out, "img", "web")).toBe("https://avatars.githubusercontent.com/u/1?v=4");

    for (const path of [up, attrOf(out, "img", "abs")]) {
      const response = await get(assets, path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
    }
  });

  test("an SVG from outside the folder is served as image/svg+xml under a sandbox CSP, so opened directly it runs no script", async () => {
    const { htmlPath, other } = layout();
    const assets = createInboxHtmlAssets();
    const out = assets.rewriteHtml(`<img id="svg" src="${other}/c.svg">`, htmlPath);
    const response = await get(assets, attrOf(out, "img", "svg"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp.split(";")[0]!.trim()).toBe("sandbox");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
  });

  test("everything else outside the folder stays out: a text file, a .txt named .png, an HTML page named .svg, .env, a dot-folder, a link into one", async () => {
    const { htmlPath, other } = layout();
    const assets = createInboxHtmlAssets();
    const html = `<!doctype html><html><head><link rel="stylesheet" href="${other}/x.css"><script src="../shots/app.js"></script></head><body>
      <img id="txt" src="${other}/notes.txt">
      <img id="env" src="${other}/.env">
      <img id="dot" src="${other}/.cache/d.png">
      <img id="fake" src="${other}/fake.png">
      <img id="html" src="${other}/page.svg">
      <img id="link" src="${other}/innocent.png">
    </body></html>`;
    const out = assets.rewriteHtml(html, htmlPath);
    expect(attrOf(out, "img", "txt")).toBe(`${other}/notes.txt`);
    expect(attrOf(out, "img", "env")).toBe(`${other}/.env`);
    expect(attrOf(out, "img", "dot")).toBe(`${other}/.cache/d.png`);
    expect(out).toContain(`href="${other}/x.css"`);
    expect(out).toContain('src="../shots/app.js"');
    for (const id of ["fake", "html", "link"]) {
      const path = attrOf(out, "img", id);
      expect(path).toMatch(/^\/api\/html-assets\/[0-9a-f]{16}\//);
      const response = await get(assets, path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("not a picture");
    }
    const token = /^\/api\/html-assets\/([0-9a-f]{16})\//.exec(attrOf(out, "img", "fake"))![1];
    expect((await get(assets, `/api/html-assets/${token}/notes.txt`)).status).toBe(404);
  });

  test("a file inside the folder behaves as today: the folder's token, a <base href>, hidden paths refused", async () => {
    const { htmlPath } = layout();
    const html = '<!doctype html><html><head></head><body><img id="in" src="logo.png"><img id="hid" src=".hidden/in.png"></body></html>';
    const inbox = createInboxHtmlAssets();
    const out = inbox.rewriteHtml(html, htmlPath);
    const base = /<base href="([^"]+)"/.exec(out)![1]!;
    expect(attrOf(out, "img", "in")).toBe(`${base}logo.png`);
    expect(attrOf(out, "img", "hid")).toBe(`${base}.hidden/in.png`);
    expect((await get(inbox, `${base}logo.png`)).status).toBe(200);
    expect((await get(inbox, `${base}.hidden/in.png`)).status).toBe(404);
  });

  test("a nested page of the folder is served with its outside pictures pointed at their tokens, and byte for byte when it names none", async () => {
    const { htmlPath, page, root } = layout();
    writeFileSync(join(page, "frame.html"), '<!doctype html><html><head></head><body><img src="../shots/a.png"><img src="logo.png"></body></html>');
    const plain = '<!doctype html>\n<p>Only <img src="logo.png"> here.</p>';
    writeFileSync(join(page, "plain.html"), plain);
    writeFileSync(join(page, "style.css"), `.a { background: url(../shots/a.png) } .b { background: url(logo.png) }`);
    const inbox = createInboxHtmlAssets();
    const base = /<base href="([^"]+)"/.exec(inbox.rewriteHtml("<p>x</p>", htmlPath))![1]!;

    const frame = await (await get(inbox, `${base}frame.html`)).text();
    const picture = /src="(\/api\/html-assets\/[0-9a-f]{16}\/a\.png)"/.exec(frame)?.[1];
    expect(picture).toBeTruthy();
    expect(frame).toContain('src="logo.png"');
    expect((await get(inbox, picture!)).status).toBe(200);

    expect(await (await get(inbox, `${base}plain.html`)).text()).toBe(plain);

    const css = await (await get(inbox, `${base}style.css`)).text();
    expect(css).toMatch(/\.a \{ background: url\("\/api\/html-assets\/[0-9a-f]{16}\/a\.png"\) \}/);
    expect(css).toContain(".b { background: url(logo.png) }");
    expect(readFileSync(join(root, "work", "shots", "a.png")).equals(PNG)).toBe(true);
  });
});

describe("annotate keeps serving only the page's folder", () => {
  test("outside references are left as written and nested pages are served as they are", async () => {
    const { htmlPath, page, other } = layout();
    const html = `<!doctype html><html><head></head><body><img id="up" src="../shots/a.png"><img id="abs" src="${other}/b.png"><img id="in" src="logo.png"></body></html>`;
    const annotate = createHtmlAssetRegistry();
    const out = annotate.rewriteHtml(html, htmlPath);
    expect(attrOf(out, "img", "up")).toBe("../shots/a.png");
    expect(attrOf(out, "img", "abs")).toBe(`${other}/b.png`);
    const base = /<base href="([^"]+)"/.exec(out)![1]!;
    expect(attrOf(out, "img", "in")).toBe(`${base}logo.png`);

    const frame = '<!doctype html><html><head></head><body><img src="../shots/a.png"></body></html>';
    writeFileSync(join(page, "frame.html"), frame);
    expect(await (await get(annotate, `${base}frame.html`)).text()).toBe(frame);
  });
});

describe("the attached page's policies", () => {
  const directives = (csp: string) => new Map(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));

  test("a nested or new-tab page reaches no network but names no image source, so its web pictures load", () => {
    const document = directives(INBOX_HTML_DOCUMENT_CSP);
    expect(document.get("connect-src")).toEqual(["'none'"]);
    expect(document.get("sandbox")).toEqual(["allow-scripts", "allow-modals"]);
    expect(document.has("img-src")).toBe(false);
    expect(document.has("default-src")).toBe(false);
  });
});
