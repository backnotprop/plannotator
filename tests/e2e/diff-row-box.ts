import { expect, type Locator } from '@playwright/test';

type Box = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

/**
 * A diff row's box, once it has one. The guide and review diffs are virtualized and re-tokenized after their first
 * paint, so a row can be detached for a moment, and `boundingBox()` does not wait: it returns null then.
 */
export async function diffRowBox(row: Locator): Promise<Box> {
  let box: Box | null = null;
  await expect.poll(async () => (box = await row.boundingBox())).not.toBeNull();
  return box as unknown as Box;
}
