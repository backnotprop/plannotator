import { expect, type Locator } from '@playwright/test';

type Box = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

export async function diffRowBox(row: Locator): Promise<Box> {
  let box: Box | null = null;
  await expect.poll(async () => (box = await row.boundingBox())).not.toBeNull();
  return box as unknown as Box;
}
