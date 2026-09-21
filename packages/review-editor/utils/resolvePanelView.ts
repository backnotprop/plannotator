import type { ReviewPanelView } from '../components/PanelViewToggle';

/**
 * Resolve the SELECTED panel view (session ?? last-used ?? persisted) into
 * the view the session actually renders. A selection the session can't offer
 * falls back to the tree — the only always-available view — so the toggle
 * always highlights the panel on screen: a latent 'sections' memo on a repo
 * with no resolvable base must not leave no segment lit (or, with sections
 * merely unavailable for the active diff, light "Git status" over a rendered
 * tree).
 */
export function resolvePanelView(
  selected: ReviewPanelView,
  capabilities: { sectionsAvailable: boolean; commitsCapable: boolean },
): ReviewPanelView {
  if (selected === 'sections') return capabilities.sectionsAvailable ? 'sections' : 'tree';
  if (selected === 'commits') return capabilities.commitsCapable ? 'commits' : 'tree';
  return 'tree';
}
