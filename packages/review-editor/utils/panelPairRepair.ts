export function shouldRepairPanelPair(session: {
  openStatePinned: boolean;
  sectionsCapable: boolean;
  persistedPanelView?: string;
  defaultDiffType?: string;
}): boolean {
  if (session.openStatePinned) return false;
  if (!session.sectionsCapable) return false;
  if (session.persistedPanelView !== 'sections') return false;
  return session.defaultDiffType !== 'since-base';
}
