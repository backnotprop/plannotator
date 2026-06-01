# Plannotator Theme Override

When visual-explainer's workflow says to pick a palette and font pairing, use these Plannotator tokens instead. Everything else — layout, structure, components, anti-slop rules — stays as visual-explainer prescribes.

## CSS Custom Properties

Replace visual-explainer's `--bg`, `--surface`, `--border`, `--text`, `--accent` variables with Plannotator's semantic tokens. Include these as `:root` defaults so the file works standalone. When embedded in the Plannotator UI via `--render-html`, these get overridden by the active theme.

```css
:root {
  /* Surfaces */
  --background: oklch(0.97 0.005 260);
  --foreground: oklch(0.18 0.02 260);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.18 0.02 260);
  --muted: oklch(0.92 0.01 260);
  --muted-foreground: oklch(0.40 0.02 260);

  /* Accents */
  --primary: oklch(0.50 0.25 280);
  --primary-foreground: oklch(1 0 0);
  --secondary: oklch(0.50 0.18 180);
  --accent: oklch(0.60 0.22 50);
  --accent-foreground: oklch(0.18 0.02 260);

  /* Semantic */
  --destructive: oklch(0.50 0.25 25);
  --success: oklch(0.45 0.20 150);
  --warning: oklch(0.55 0.18 85);

  /* Structure */
  --border: oklch(0.88 0.01 260);
  --code-bg: oklch(0.92 0.01 260);
  --ring: oklch(0.50 0.25 280);
  --radius: 0.625rem;

  /* Typography */
  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
  --font-display: ui-serif, Georgia, 'Times New Roman', serif;
}
```

## Mapping visual-explainer variables to Plannotator tokens

When visual-explainer references or templates use these variables, substitute:

| visual-explainer | Plannotator | Notes |
|-----------------|-------------|-------|
| `--bg` | `var(--background)` | Page background |
| `--surface` | `var(--card)` | Card/panel surfaces |
| `--border` | `var(--border)` | Borders and dividers |
| `--text` | `var(--foreground)` | Primary text |
| `--text-dim` | `var(--muted-foreground)` | Secondary/subdued text |
| `--accent` (primary) | `var(--primary)` | Primary accent |
| `--accent-dim` | `color-mix(in oklab, var(--primary) 15%, transparent)` | Accent backgrounds |
| `--accent-2` | `var(--accent)` | Secondary accent (warm) |
| `--accent-3` | `var(--secondary)` | Tertiary accent |
| `--success` | `var(--success)` | Positive indicators |
| `--warning` | `var(--warning)` | Caution indicators |
| `--error` / `--danger` | `var(--destructive)` | Error/destructive indicators |
| `--font-body` | `var(--font-sans)` | Body text font |
| `--font-mono` | `var(--font-mono)` | Code and labels |
| `--font-heading` | `var(--font-display)` | Headings (serif) |

## Typography exception

Visual-explainer forbids Inter as `--font-body`. Plannotator uses Inter as its default sans-serif. This is intentional — Plannotator's identity is defined by its theme tokens, not font novelty. When using this skill, Inter is permitted as the body font because the output is meant to look like part of Plannotator, not like an independent design piece.

The `--font-display` (serif) is still used for headings to create visual contrast, matching the visual-explainer's emphasis on distinctive typography.

## Mermaid theming

When visual-explainer instructs you to set `themeVariables` in Mermaid config, use Plannotator tokens:

```javascript
mermaid.initialize({
  theme: 'base',
  themeVariables: {
    primaryColor: 'oklch(0.50 0.25 280)',         // --primary
    primaryTextColor: 'oklch(1 0 0)',              // --primary-foreground
    primaryBorderColor: 'oklch(0.88 0.01 260)',    // --border
    lineColor: 'oklch(0.40 0.02 260)',             // --muted-foreground
    secondaryColor: 'oklch(0.92 0.01 260)',        // --muted
    tertiaryColor: 'oklch(0.92 0.01 260)',         // --muted
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSize: '14px',
  }
});
```

## Dark mode

Plannotator handles dark/light via theme classes, not `prefers-color-scheme`. The standalone defaults above are the light theme. When embedded via `--render-html`, the active theme's tokens override automatically — no media query needed in the generated HTML.

For standalone viewing, you may optionally add a `prefers-color-scheme: dark` block with the Plannotator dark theme values:

```css
@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(0.15 0.02 260);
    --foreground: oklch(0.90 0.01 260);
    --card: oklch(0.22 0.02 260);
    --card-foreground: oklch(0.90 0.01 260);
    --muted: oklch(0.26 0.02 260);
    --muted-foreground: oklch(0.72 0.02 260);
    --primary: oklch(0.75 0.18 280);
    --primary-foreground: oklch(0.15 0.02 260);
    --accent: oklch(0.70 0.20 60);
    --border: oklch(0.35 0.02 260);
    --code-bg: oklch(0.26 0.02 260);
    --destructive: oklch(0.65 0.20 25);
    --success: oklch(0.72 0.17 150);
    --warning: oklch(0.75 0.15 85);
  }
}
```

## Depth tiers

Visual-explainer defines depth tiers (hero, elevated, default, recessed). Map them using Plannotator tokens:

```css
/* Hero — elevated, accent-tinted */
.ve-card--hero {
  background: color-mix(in oklab, var(--primary) 5%, var(--card));
  border-color: var(--primary);
  box-shadow: 0 4px 24px color-mix(in oklab, var(--primary) 10%, transparent);
}

/* Default — standard card */
.ve-card {
  background: var(--card);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
}

/* Recessed — subdued */
.ve-card--recessed {
  background: var(--muted);
  border-color: transparent;
}
```

## Code blocks

```css
.code-block {
  background: var(--code-bg);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-mono);
  color: var(--foreground);
}

/* Syntax tokens */
.code-block .kw  { color: var(--primary); }
.code-block .fn  { color: var(--accent); }
.code-block .str { color: var(--success); }
.code-block .cm  { color: var(--muted-foreground); font-style: italic; }
.code-block .num { color: var(--warning); }
```
