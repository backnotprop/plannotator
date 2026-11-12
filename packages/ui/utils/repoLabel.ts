export function repoLabel(display: string, hideOwner: boolean): string {
  if (!hideOwner) return display;
  const slash = display.lastIndexOf('/');
  const name = slash === -1 ? display : display.slice(slash + 1);
  return name || display;
}
