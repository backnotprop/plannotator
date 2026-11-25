/**
 * The former Semantic diffs tab is now part of Settings → Reviews
 * (`ReviewSettingsPage`); its Power Up form lives in `PowerUpSettings.tsx`.
 * This path keeps the names other modules (and `@plannotator/ui` hosts)
 * import from it.
 */
export { POWER_UP_CHANGED_EVENT, POWER_UP_PROVIDER_NAMES, type PowerUpProvider } from './PowerUpSettings';
