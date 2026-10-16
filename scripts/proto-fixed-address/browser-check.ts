/**
 * PROTOTYPE (proto/inbox-fixed-address): load the fixed address in real
 * browser engines (headless) and check what the plain-HTTP address promises:
 * it answers THIS Inbox, the page is a secure context (http://*.localhost
 * counts as one), and the Notification API is there. Prints one JSON line
 * per engine.
 *
 *   bun scripts/proto-fixed-address/browser-check.ts <expected serverSession> [url]
 *
 * Engines: the installed Google Chrome (channel "chrome") when present, then
 * Playwright's Chromium, WebKit and Firefox when installed
 * (`bunx playwright install chromium webkit firefox`). No certificate is
 * involved anywhere. Exit 0 when at least one Chromium-family engine passed
 * and no engine that loaded the page found it insecure.
 */
import { chromium, firefox, webkit, type BrowserType } from "@playwright/test";

const expected = process.argv[2] ?? "";
const url = (process.argv[3] ?? "http://inbox.plannotator.localhost").replace(/\/$/, "");

interface Outcome {
  engine: string;
  ok: boolean;
  /** The engine is not installed here: reported, not counted. */
  missing?: boolean;
  detail: string;
  secureContext?: boolean;
  notification?: string;
}

async function check(engine: string, type: BrowserType, options: Parameters<BrowserType["launch"]>[0] = {}): Promise<Outcome> {
  let browser;
  try {
    browser = await type.launch({ headless: true, ...options });
  } catch (error) {
    return { engine, ok: false, missing: true, detail: `not available: ${String(error).split("\n")[0]}` };
  }
  try {
    const page = await (await browser.newContext()).newPage();
    const response = await page.goto(`${url}/api/inbox/health`, { timeout: 15_000 });
    const body = JSON.parse((await response?.text()) ?? "{}") as { serverSession?: string };
    if (body.serverSession !== expected) return { engine, ok: false, detail: `answered serverSession ${body.serverSession ?? "(none)"}, expected ${expected}` };
    await page.goto(`${url}/`, { timeout: 15_000 });
    const secureContext = await page.evaluate(() => window.isSecureContext);
    const notification = await page.evaluate(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
    const ok = secureContext && notification !== "unsupported";
    return { engine, ok, detail: `HTTP ${response?.status()} over plain HTTP${ok ? "" : ": not a secure context, notifications would not work"}`, secureContext, notification };
  } catch (error) {
    return { engine, ok: false, detail: String(error).split("\n")[0]! };
  } finally {
    await browser.close().catch(() => {});
  }
}

const outcomes: Outcome[] = [];
outcomes.push(await check("chrome (installed)", chromium, { channel: "chrome" }));
outcomes.push(await check("chromium (playwright)", chromium));
outcomes.push(await check("webkit (playwright, Safari's engine)", webkit));
outcomes.push(await check("firefox (playwright)", firefox));
for (const outcome of outcomes) console.log(JSON.stringify(outcome));
const chromiumPassed = outcomes.some((o) => o.ok && o.engine.startsWith("chrom"));
const anyLoadedBroken = outcomes.some((o) => !o.ok && !o.missing && o.secureContext === false);
process.exit(chromiumPassed && !anyLoadedBroken ? 0 : 1);
