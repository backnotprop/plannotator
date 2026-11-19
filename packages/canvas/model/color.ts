/**
 * Colour on any object. A person or an agent can set either a named colour
 * (it follows the theme, light and dark) or any CSS colour they like.
 *
 * A custom colour is a string an agent can send, so it is checked against a
 * closed grammar before it reaches a style attribute (`isCustomColor`).
 *
 * The six names below are the canvas's own and win: `blue` is the theme's
 * blue. Any other CSS colour name, and any other colour, is a custom one.
 * Whatever is chosen stays readable: the stylesheet takes the ink that goes
 * on a custom fill, and the shade a custom line or text is drawn in, from
 * the colour's own lightness (`canvas.css`, "Custom colours").
 */

export const NAMED_COLORS = ['neutral', 'blue', 'green', 'amber', 'red', 'violet'] as const;
export type NamedColor = (typeof NAMED_COLORS)[number];

/** A named colour, or `{ custom }` holding a checked CSS colour. */
export type CanvasColor = NamedColor | { custom: string };

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION_RE = /^(?:rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch|color)\(\s*[-+0-9.%a-z/,\s]{1,96}\)$/i;
/** The only words that may appear inside a colour function: units, `none`, and `color()`'s colour spaces. */
const FUNCTION_WORDS_RE = /[a-z][a-z0-9-]*/gi;
const ALLOWED_WORDS = new Set([
  'deg', 'rad', 'turn', 'grad', 'none', 'e',
  'srgb', 'srgb-linear', 'display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020', 'xyz', 'xyz-d50', 'xyz-d65',
]);

/** The colour names CSS knows (CSS Color 4). `transparent` and `currentcolor` are not colours to give an object. */
const CSS_NAMES = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral ' +
    'cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick ' +
    'floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender ' +
    'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid ' +
    'mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy ' +
    'oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

/**
 * Whether a string is a CSS colour this canvas will put in a style: hex, a
 * CSS colour name, or one colour function holding only numbers, units and
 * colour-space names. No parentheses inside, no quotes, no semicolons, no
 * `url()`, no `var()`: nothing that can load, run or end the declaration.
 */
export function isCustomColor(value: string): boolean {
  if (typeof value !== 'string' || value.length > 112) return false;
  const v = value.trim();
  if (HEX_RE.test(v)) return true;
  if (CSS_NAMES.has(v.toLowerCase())) return true;
  if (!FUNCTION_RE.test(v)) return false;
  const inner = v.slice(v.indexOf('(') + 1, -1);
  for (const word of inner.match(FUNCTION_WORDS_RE) ?? []) {
    if (!ALLOWED_WORDS.has(word.toLowerCase())) return false;
  }
  return true;
}

export const isNamedColor = (value: unknown): value is NamedColor =>
  typeof value === 'string' && (NAMED_COLORS as readonly string[]).includes(value);

/** Null when the value is not a colour this canvas takes. */
export function parseColor(value: unknown): CanvasColor | null {
  if (isNamedColor(value)) return value;
  if (typeof value === 'string') return isCustomColor(value) ? { custom: value.trim() } : null;
  if (value && typeof value === 'object' && 'custom' in value) {
    const custom = (value as { custom: unknown }).custom;
    return typeof custom === 'string' && isCustomColor(custom) ? { custom: custom.trim() } : null;
  }
  return null;
}

export function colorsEqual(a: CanvasColor | undefined, b: CanvasColor | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a === 'object' && typeof b === 'object') return a.custom === b.custom;
  return false;
}
