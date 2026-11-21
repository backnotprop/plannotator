/**
 * The sidebar peek (packages/inbox/shell/SidebarPeek.tsx) opens when the
 * pointer rests 600 ms on the 20 px strip at a wide window's left edge, and
 * closes only when the pointer leaves the peek itself. Playwright's mouse
 * starts at (0, 0), on that strip, and Chromium sends hover events under a
 * resting pointer after a load or a layout change: the peek comes out on its
 * own and stays over whatever a spec clicks next (its click retries until the
 * test times out). Call this after a goto or reload: it puts the pointer in
 * the middle of the page and, when the peek is already out, passes the
 * pointer through it so it closes. Specs that test the peek move the pointer
 * themselves.
 */
import type { Page } from '@playwright/test';

export async function clearSidebarPeek(page: Page): Promise<void> {
  const size = page.viewportSize();
  // The peek is a large-screen affordance only (>= 1024 px).
  if (!size || size.width < 1024) return;
  const x = size.width / 2;
  const y = size.height / 2;
  await page.mouse.move(x, y);
  const peek = page.locator('[data-sidebar-peek][data-visible]');
  if ((await peek.count()) > 0) {
    // Out already, and the pointer never entered it: enter it, then leave.
    await page.mouse.move(100, y);
    await page.mouse.move(x, y);
  }
  await peek.waitFor({ state: 'detached', timeout: 10_000 });
}
