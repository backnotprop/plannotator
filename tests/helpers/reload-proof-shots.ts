import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function builtInboxHtml(): { htmlContent?: string } {
  const file = resolve(import.meta.dir, "../../apps/hook/dist/inbox.html");
  return process.env.RELOAD_PROOF_SHOTS && existsSync(file) ? { htmlContent: readFileSync(file, "utf8") } : {};
}

export async function shootAgents(inboxPort: number, name: string, options: { sidebar?: boolean } = {}): Promise<void> {
  const dir = process.env.RELOAD_PROOF_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    for (const [form, viewport] of [
      ["desktop", { width: 1280, height: 900 }],
      ["phone", { width: 390, height: 844 }],
    ] as const) {
      for (const scheme of ["light", "dark"] as const) {
        const page = await browser.newPage({ viewport, colorScheme: scheme, isMobile: form === "phone", hasTouch: form === "phone" });
        await page.goto(`http://127.0.0.1:${inboxPort}/#settings/agents`);
        const box = page.locator("[data-reload-sessions]").first();
        const shown = await box.waitFor({ timeout: 15_000 }).then(
          () => true,
          () => false,
        );
        if (!shown) {
          await page.screenshot({ path: join(dir, `${name}-agents-${form}-${scheme}-MISSING.png`), fullPage: true });
          throw new Error(`Settings → Agents drew no reload box (${name}, ${form}, ${scheme})`);
        }
        await box.scrollIntoViewIfNeeded();
        await page.waitForTimeout(800);
        await page.screenshot({ path: join(dir, `${name}-agents-${form}-${scheme}.png`) });
        if (form === "desktop" && scheme === "light" && options.sidebar !== false) {
          await page.goto(`http://127.0.0.1:${inboxPort}/`);
          await page.locator("[data-restart-sidebar]").waitFor({ timeout: 15_000 });
          await page.waitForTimeout(500);
          await page.screenshot({ path: join(dir, `${name}-sidebar-desktop-light.png`) });
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
