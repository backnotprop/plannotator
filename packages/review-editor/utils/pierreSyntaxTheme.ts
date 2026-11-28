/**
 * The theme pair for Pierre's diff views (`syntaxTheme.ts`), with a custom
 * theme's code colours registered with Pierre first (customSyntaxThemes.ts).
 * Every diff view in the review editor (the diff pane, the PR comments' hunk
 * previews) takes its names from this, through usePierreTheme.ts's
 * `resolveSyntaxTheme`, so Pierre never gets a name it cannot load.
 */
import { registerCustomTheme, resolveTheme } from '@pierre/diffs';
import { connectCustomSyntaxThemes, type CustomSyntaxPierre } from '@plannotator/ui/utils/customSyntaxThemes';
import { resolveSyntaxTheme } from '@plannotator/ui/utils/syntaxTheme';

export function resolvePierreSyntaxTheme(colorTheme: string, mode: 'dark' | 'light'): { dark: string; light: string } | undefined {
  connectCustomSyntaxThemes({ registerCustomTheme, resolveTheme } as unknown as CustomSyntaxPierre);
  return resolveSyntaxTheme(colorTheme, mode);
}
