import { useTheme } from '../components/ThemeProvider';
import { resolveFenceTheme } from '../utils/syntaxTheme';

/** The Shiki theme name that code snippets should render in right now. */
export function useFenceTheme(): string {
  const { colorTheme, resolvedMode } = useTheme();
  return resolveFenceTheme(colorTheme, resolvedMode ?? 'dark');
}
