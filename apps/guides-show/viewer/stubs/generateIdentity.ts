/** Build-time stand-in — the portable viewer never mints a reviewer identity. */
export function generateIdentity(): string {
  return 'reader';
}
