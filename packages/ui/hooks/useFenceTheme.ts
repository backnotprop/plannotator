import { useTheme } from '../components/ThemeProvider';
import { resolveFenceTheme } from '../utils/syntaxTheme';

/**
 * The Shiki theme name that code snippets should render in right now.
 *
 * Same (colorTheme, mode) resolution the code-review diff pane uses, so fences,
 * suggestion cards and diff hunks all agree. Re-renders on palette or mode
 * change, which is what drives the re-highlight in the components below.
 *
 * `ThemeProvider`'s default context supplies the Plannotator palette in dark
 * mode, so this is safe to call outside a provider.
 */
export function useFenceTheme(): string {
  const { colorTheme, resolvedMode } = useTheme();
  return resolveFenceTheme(colorTheme, resolvedMode ?? 'dark');
}
