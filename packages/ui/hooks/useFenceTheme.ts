import { useTheme } from '../components/ThemeProvider';
import { resolveFenceTheme } from '../utils/syntaxTheme';

export function useFenceTheme(): string {
  const { colorTheme, resolvedMode } = useTheme();
  return resolveFenceTheme(colorTheme, resolvedMode ?? 'dark');
}
