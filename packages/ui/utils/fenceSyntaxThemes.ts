/**
 * The code colours a markdown fence draws in when its palette has no code
 * theme of its own: Pierre's default pair (`pierre-light`, `pierre-dark`)
 * with every colour that read below 4.5:1 on a code block made darker (light)
 * or lighter (dark). Only the OKLCH lightness moves; the hue stays, and the
 * chroma only drops where the darker colour would leave sRGB. Every other
 * colour, font style and scope is Pierre's.
 *
 * Why: in `pierre-light` 12 of its 17 colours were under 4.5:1 on a white
 * block (the operator cyan `#08c0ef` 2.1:1, the constant yellow `#d5a910`
 * 2.2:1), lower still on Plannotator's light code block (`bg-muted/50`,
 * `#eaedf2`); in `pierre-dark` the comment grey was 3.8:1 and punctuation
 * 3.0:1 on the dark block. Each colour below now reads at least 4.5:1 on the
 * theme's own background AND on Plannotator's code block in that mode
 * (`fenceSyntaxThemes.test.ts` computes it for every token of both themes).
 * Where two colours of one hue would have met (dark comment and
 * punctuation; light number and operator), the one that was darker or
 * lighter stays so.
 *
 * Only fences resolve these names (`resolveFenceTheme`); the code review diff
 * pane and its worker pool keep Pierre's pair. The themes are registered with
 * Pierre by name beside the custom themes (`connectCustomSyntaxThemes`, which
 * every place that loads Pierre calls first), so the shared highlighter, the
 * Inbox's fence worker and the diff views all resolve them the same way.
 */

export type FenceHalf = 'light' | 'dark';

/** The Shiki theme names fences draw in when no palette names one. */
export const FENCE_SYNTAX_THEME: Readonly<Record<FenceHalf, string>> = {
  light: 'plannotator-fence-light',
  dark: 'plannotator-fence-dark',
};

/** The Pierre theme each fence theme is made from. */
export const FENCE_BASE_THEME: Readonly<Record<FenceHalf, string>> = {
  light: 'pierre-light',
  dark: 'pierre-dark',
};

/**
 * Pierre's colour (lower-case `#rrggbb`) -> the colour the fence draws it in.
 * Generated once from Pierre 2.0.0's themes: OKLCH lightness only (chroma
 * eased only where the darker colour leaves the sRGB gamut), to 4.6:1 against
 * the worse of the theme's own background (`#ffffff`, `#0a0a0a`) and the
 * default palette's `--muted` (themes/plannotator.css: oklch(0.92 0.01 260)
 * light, oklch(0.26 0.02 260) dark). A code block draws `bg-muted/50` over the
 * page, so it is never darker (light) or lighter (dark) than `--muted` itself.
 * Where two colours of one hue had an order, it is kept (light number vs
 * operator, dark comment vs punctuation), so those two aim higher.
 * `fenceSyntaxThemes.test.ts` measures every token against `--muted` read from
 * the theme file.
 */
export const FENCE_COLOR_FIXES: Readonly<Record<FenceHalf, Readonly<Record<string, string>>>> = {
  light: {
    '#737373': '#656565', // comment
    '#199f43': '#01762c', // string
    '#1ca1c7': '#046079', // number, language constant
    '#d5a910': '#7d6201', // constant
    '#d5901c': '#8b5b05', // other constant, namespace
    '#d32a61': '#c51556', // keyword
    '#d47628': '#9e5000', // variable
    '#a631be': '#a22cba', // type, class
    '#08c0ef': '#006e8b', // operator
    '#1a85d4': '#0169ad', // decorator
    '#d5512f': '#b93610', // magic variable
    '#18a46c': '#03744a', // attribute name
    '#17a5af': '#017078', // regular expression
    '#16a994': '#077263', // escape
  },
  dark: {
    '#737373': '#989898', // comment
    '#636363': '#8b8b8b', // operator, punctuation
    '#9d6afb': '#a16ffe', // function
  },
};

/** `#rgb`, `#rrggbb` or `#rrggbbaa` with its fix applied (the alpha kept); anything else as it was. */
export function fixFenceColor(color: unknown, half: FenceHalf): unknown {
  if (typeof color !== 'string') return color;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (!match) return color;
  let rgb = match[1]!.toLowerCase();
  if (rgb.length === 3) rgb = [...rgb].map((c) => c + c).join('');
  const fixed = FENCE_COLOR_FIXES[half][`#${rgb}`];
  return fixed === undefined ? color : `${fixed}${match[2] ?? ''}`;
}

type Rule = { settings?: Record<string, unknown> } & Record<string, unknown>;

function fixRules(rules: unknown, half: FenceHalf): unknown {
  if (!Array.isArray(rules)) return rules;
  return rules.map((rule: Rule) => {
    if (!rule || typeof rule !== 'object' || !rule.settings || typeof rule.settings !== 'object') return rule;
    const settings = { ...rule.settings };
    if ('foreground' in settings) settings.foreground = fixFenceColor(settings.foreground, half);
    return { ...rule, settings };
  });
}

/**
 * The fence theme made from Pierre's resolved TextMate theme, named `name`.
 * A copy: Pierre's own theme object is never changed.
 */
export function fenceThemeFromBase(base: unknown, half: FenceHalf, name: string = FENCE_SYNTAX_THEME[half]): Record<string, unknown> {
  const theme = { ...(base && typeof base === 'object' ? (base as Record<string, unknown>) : {}) };
  theme.name = name;
  if ('fg' in theme) theme.fg = fixFenceColor(theme.fg, half);
  if (theme.colors && typeof theme.colors === 'object') {
    const colors = { ...(theme.colors as Record<string, unknown>) };
    if ('editor.foreground' in colors) colors['editor.foreground'] = fixFenceColor(colors['editor.foreground'], half);
    theme.colors = colors;
  }
  if ('settings' in theme) theme.settings = fixRules(theme.settings, half);
  if ('tokenColors' in theme) theme.tokenColors = fixRules(theme.tokenColors, half);
  return theme;
}

/** Pierre's two calls this needs (`@pierre/diffs`), as `customSyntaxThemes` takes them. */
interface FencePierre {
  registerCustomTheme: (name: string, loader: () => Promise<never>) => void;
  resolveTheme: (name: never) => Promise<{ textmate?: unknown }>;
}

const registered = new WeakSet<object>();

/** Register both fence themes with Pierre (once per Pierre module: a second registration logs an error there). */
export function connectFenceSyntaxThemes(pierre: FencePierre): void {
  if (typeof pierre?.registerCustomTheme !== 'function' || typeof pierre.resolveTheme !== 'function') return;
  const key = pierre.registerCustomTheme as unknown as object;
  if (registered.has(key)) return;
  registered.add(key);
  for (const half of ['light', 'dark'] as const) {
    pierre.registerCustomTheme(FENCE_SYNTAX_THEME[half], (async () => {
      const base = await pierre.resolveTheme(FENCE_BASE_THEME[half] as never);
      return fenceThemeFromBase(base.textmate, half);
    }) as () => Promise<never>);
  }
}
