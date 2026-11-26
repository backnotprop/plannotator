/**
 * The former Semantic diffs tab, kept as a public export
 * (`@plannotator/ui/components/settings/SemanticDiffsTab`) for any host that
 * draws it on its own. It renders the same parts Settings → Reviews does
 * (`ReviewSettingsPage`): Show moved & renamed code, then the Power Up
 * section with its provider and key form (`PowerUpSettings.tsx`), in classic
 * code review's controls. Classic code review itself now shows them on
 * Settings → Reviews.
 */
import React from 'react';
import { MovedCodeSwitch, PowerUpSection } from './ReviewSettingsPage';
import { SEM_DIFF_OPINION_SETTINGS_ROUTE } from './PowerUpSettings';
import { CLASSIC_REVIEW_SETTINGS_CONTROLS } from './reviewSettingsControls';
import { SECTION_WORDS } from './reviewSettingsWords';

export { POWER_UP_CHANGED_EVENT, POWER_UP_PROVIDER_NAMES, type PowerUpProvider } from './PowerUpSettings';

export function SemanticDiffsTab({ opinionRoute = SEM_DIFF_OPINION_SETTINGS_ROUTE }: { opinionRoute?: string } = {}) {
  const controls = CLASSIC_REVIEW_SETTINGS_CONTROLS;
  const { Section } = controls;
  return (
    <div className="space-y-4" data-semantic-diffs-settings="">
      <Section id="semantic" first title={SECTION_WORDS.semantic.title} description={SECTION_WORDS.semantic.description}>
        <MovedCodeSwitch controls={controls} />
      </Section>
      <div data-power-up-settings="">
        <PowerUpSection controls={controls} opinionRoute={opinionRoute} />
      </div>
    </div>
  );
}
