import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./annotate";

describe("annotate HTML sharing", () => {
  test("/api/plan serves display HTML without building portable share HTML", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-annotate-share-"));
    const htmlPath = join(dir, "page.html");
    const assetDir = join(dir, "assets");
    mkdirSync(assetDir);
    writeFileSync(join(assetDir, "logo.png"), Buffer.from([1, 2, 3]));
    const html = '<!doctype html><html><body><img src="./assets/logo.png"></body></html>';
    writeFileSync(htmlPath, html, "utf-8");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: htmlPath,
      htmlContent: "<!doctype html><html><body>app</body></html>",
      rawHtml: html,
      renderHtml: true,
      sharingEnabled: true,
    });

    try {
      const planResponse = await fetch(`${server.url}/api/plan`);
      expect(planResponse.status).toBe(200);
      const plan = await planResponse.json() as {
        renderAs?: string;
        rawHtml?: string;
        shareHtml?: string;
      };

      expect(plan.renderAs).toBe("html");
      expect(plan.rawHtml).toContain("/api/html-assets/");
      expect(plan.rawHtml).not.toContain("data:image/png");
      expect("shareHtml" in plan).toBe(false);

      const shareResponse = await fetch(
        `${server.url}/api/share-html?path=${encodeURIComponent(htmlPath)}`,
      );
      expect(shareResponse.status).toBe(200);
      const share = await shareResponse.json() as { shareHtml?: string };

      expect(share.shareHtml).toContain('src="data:image/png;base64,AQID"');
      expect(share.shareHtml).not.toContain("/api/html-assets/");
    } finally {
      server.stop();
    }
  });
});
