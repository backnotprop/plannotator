import { useSyncExternalStore } from 'react';
import { useHasThemeProvider, useTheme } from '../components/ThemeProvider';
import { getPageColorMode, subscribePageColorMode, type PageColorMode } from '../utils/pageColorMode';
import { resolveFenceTheme } from '../utils/syntaxTheme';

const noSubscribe = () => () => {};
const providerMode = (): PageColorMode => 'dark';

/**
 * The Shiki theme name that code snippets should render in right now.
 *
 * Same (colorTheme, mode) resolution the code-review diff pane uses, so fences,
 * suggestion cards and diff hunks all agree. Re-renders on palette or mode
 * change, which is what drives the re-highlight in the components below.
 *
 * Inside a ThemeProvider the mode is the provider's. Outside one the mode is
 * the page's own (`utils/pageColorMode`: `<html class="light">`, the page's
 * `color-scheme`, its background), so a light host page gets light code
 * colours; it used to get the dark palette whatever the page showed.
 */
export function useFenceTheme(): string {
  const { colorTheme, resolvedMode } = useTheme();
  const hasProvider = useHasThemeProvider();
  const pageMode = useSyncExternalStore(
    hasProvider ? noSubscribe : subscribePageColorMode,
    hasProvider ? providerMode : getPageColorMode,
    providerMode,
  );
  return resolveFenceTheme(colorTheme, hasProvider ? (resolvedMode ?? 'dark') : pageMode);
}
