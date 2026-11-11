import type { ReviewPanelView } from '../components/ReviewPanelHeader';

export function resolvePanelView(
  selected: ReviewPanelView,
  capabilities: { sectionsAvailable: boolean; commitsCapable: boolean },
): ReviewPanelView {
  if (selected === 'sections') return capabilities.sectionsAvailable ? 'sections' : 'tree';
  if (selected === 'commits') return capabilities.commitsCapable ? 'commits' : 'tree';
  return 'tree';
}
