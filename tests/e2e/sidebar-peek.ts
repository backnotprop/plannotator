import type { Page } from '@playwright/test';

export async function clearSidebarPeek(page: Page): Promise<void> {
  const size = page.viewportSize();
  if (!size || size.width < 1024) return;
  const x = size.width / 2;
  const y = size.height / 2;
  await page.mouse.move(x, y);
  const peek = page.locator('[data-sidebar-peek][data-visible]');
  if ((await peek.count()) > 0) {
    await page.mouse.move(100, y);
    await page.mouse.move(x, y);
  }
  await peek.waitFor({ state: 'detached', timeout: 10_000 });
}
