// An author's colours under Pele (`peleAuthorTheme.ts`). What regresses: a
// diagram that names a theme or theme variables is drawn in the person's
// palette instead, a value that could fetch or reach a variable gets into the
// drawing, a diagram that gives nothing loses the person's palette, or the
// base theme's derived colours drift from Mermaid's.
import { describe, expect, test } from 'bun:test';
import { parseCssColor } from './cssColor';
import { deriveBaseColors, MERMAID_THEMES, peleAuthorThemeVariables, readPeleAuthorTheme } from './peleAuthorTheme';

const person = { '--pele-bg': '#101010', '--pele-fg': '#eeeeee', '--pele-muted': '#aaaaaa', '--pele-surface': '#202020', '--pele-font': 'Inter' } as const;

describe("reading the author's theme", () => {
  test('an init directive in any of the forms Mermaid reads, and front matter config', () => {
    expect(readPeleAuthorTheme("%%{init: {'theme': 'forest'}}%%\nflowchart LR\n  A --> B")).toEqual({ theme: 'forest', themeVariables: {} });
    expect(readPeleAuthorTheme('%%{ initialize: { "theme": "base", "themeVariables": { "primaryColor": "#ff00aa", } } }%%\nflowchart LR\n  A')).toEqual({
      theme: 'base',
      themeVariables: { primaryColor: '#ff00aa' },
    });
    expect(readPeleAuthorTheme("%%{init: {theme: 'dark', themeVariables: {lineColor: 'rgb(1, 2, 3)'}}}%%\nflowchart LR\n  A")).toEqual({ theme: 'dark', themeVariables: { lineColor: 'rgb(1, 2, 3)' } });
    const front = '---\ntitle: Release\nconfig:\n  theme: neutral\n  themeVariables:\n    primaryColor: "#ffcc00"\n    lineColor: navy\n---\nflowchart LR\n  A --> B';
    expect(readPeleAuthorTheme(front)).toEqual({ theme: 'neutral', themeVariables: { primaryColor: '#ffcc00', lineColor: 'navy' } });
  });

  test('a source that gives no theme gives nothing, and an unknown theme name is no theme', () => {
    expect(readPeleAuthorTheme('flowchart LR\n  A --> B')).toBeNull();
    expect(readPeleAuthorTheme("%%{init: {'flowchart': {'curve': 'basis'}}}%%\nflowchart LR\n  A")).toBeNull();
    expect(readPeleAuthorTheme("%%{init: {'theme': 'midnight'}}%%\nflowchart LR\n  A")).toBeNull();
  });

  test('only safe colours: nothing that can fetch, reach a variable or end a declaration; themeCSS is not read', () => {
    const source =
      "%%{init: {'theme': 'base', 'themeCSS': '.node rect { fill: url(https://x) }', 'themeVariables': {'primaryColor': 'url(https://x/y.png)', 'lineColor': 'var(--secret)', 'background': 'red; background-image: url(x)', 'mainBkg': '#00ff00', 'fontFamily': 'Comic Sans'}}}%%\nflowchart LR\n  A";
    expect(readPeleAuthorTheme(source)).toEqual({ theme: 'base', themeVariables: { mainBkg: '#00ff00' } });
  });
});

describe("Pele's colours from the author's theme", () => {
  test("a named theme is Mermaid's colours for it, the person's font kept", () => {
    const vars = peleAuthorThemeVariables("%%{init: {'theme': 'forest'}}%%\nflowchart LR\n  A", person)!;
    expect(vars['--pele-surface']).toBe(MERMAID_THEMES.forest.mainBkg);
    expect(vars['--pele-border']).toBe(MERMAID_THEMES.forest.nodeBorder);
    expect(vars['--pele-line']).toBe(MERMAID_THEMES.forest.lineColor);
    expect(vars['--pele-series-3']).toBe(MERMAID_THEMES.forest.cScale2);
    expect(vars['--pele-font']).toBe('Inter');
  });

  test('theme variables with no theme go over the person\'s palette, each replacing its own', () => {
    const vars = peleAuthorThemeVariables("%%{init: {'themeVariables': {'primaryColor': '#ffcc00'}}}%%\nflowchart LR\n  A", person)!;
    expect(vars['--pele-surface']).toBe('#ffcc00');
    expect(vars['--pele-bg']).toBe(person['--pele-bg']);
    expect(vars['--pele-fg']).toBe(person['--pele-fg']);
    expect(vars['--pele-muted']).toBe(person['--pele-muted']);
  });

  test('a source that gives nothing keeps the person\'s palette', () => {
    expect(peleAuthorThemeVariables('flowchart LR\n  A --> B', person)).toBeNull();
  });

  test('a muted colour the theme makes unreadable on its own fills is moved toward the text until it reads', () => {
    const vars = peleAuthorThemeVariables("%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#222222', 'background': '#222222', 'primaryTextColor': '#ffffff', 'titleColor': '#2a2a2a', 'tertiaryColor': '#222222'}}}%%\nflowchart LR\n  A", person)!;
    expect(vars['--pele-muted']).not.toBe('#2a2a2a');
  });

  test("under base, the colours an author does not give follow the one they give, as Mermaid's base theme derives them", () => {
    const pink = deriveBaseColors({ primaryColor: '#ff00aa' });
    expect(pink.mainBkg).toBe('#ff00aa');
    expect(pink.nodeBorder).not.toBe(MERMAID_THEMES.base.nodeBorder);
    // With nothing given, the base theme itself (khroma rounds its HSL steps; within one step per channel).
    const derived = deriveBaseColors({});
    for (const [key, value] of Object.entries(MERMAID_THEMES.base)) {
      const [a, b] = [parseCssColor(value)!, parseCssColor(derived[key as keyof typeof derived])!];
      expect(Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)), key).toBeLessThanOrEqual(2 / 255);
    }
  });
});
