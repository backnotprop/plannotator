import type { BrowserContext, Page } from '@playwright/test';

export const FILE_VIEW_COOKIE = 'plannotator-inbox-file-view';

export async function forgetFileViewChoice(target: Page | BrowserContext | undefined | null): Promise<void> {
  if (!target) return;
  const page = 'mainFrame' in target ? target : null;
  const context = page ? page.context() : (target as BrowserContext);
  await context.clearCookies({ name: FILE_VIEW_COOKIE });
  if (!page || page.isClosed()) return;
  const dismiss = page.locator('.ib-toast [data-toast-dismiss]');
  if ((await dismiss.count()) > 0) await dismiss.first().click({ timeout: 2_000 }).catch(() => {});
}
