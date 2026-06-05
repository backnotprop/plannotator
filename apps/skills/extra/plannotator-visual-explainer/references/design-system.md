# Design System Reference

Plan documents use Plannotator's semantic theme tokens. This makes them theme-aware: standalone files render with bundled defaults; embedded in the Plannotator UI, they inherit whatever theme is active (30+ themes, light and dark variants).

## Standalone defaults

Include this `:root` block so the plan works when opened directly in a browser. These are the Plannotator light theme values — they get overridden when embedded.

```css
:root {
  --background: oklch(0.97 0.005 260);
  --foreground: oklch(0.18 0.02 260);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.18 0.02 260);
  --primary: oklch(0.50 0.25 280);
  --primary-foreground: oklch(1 0 0);
  --secondary: oklch(0.50 0.18 180);
  --secondary-foreground: oklch(1 0 0);
  --muted: oklch(0.92 0.01 260);
  --muted-foreground: oklch(0.40 0.02 260);
  --accent: oklch(0.60 0.22 50);
  --accent-foreground: oklch(0.18 0.02 260);
  --destructive: oklch(0.50 0.25 25);
  --destructive-foreground: oklch(1 0 0);
  --success: oklch(0.45 0.20 150);
  --success-foreground: oklch(1 0 0);
  --warning: oklch(0.55 0.18 85);
  --warning-foreground: oklch(0.18 0.02 260);
  --border: oklch(0.88 0.01 260);
  --input: oklch(0.92 0.01 260);
  --ring: oklch(0.50 0.25 280);
  --code-bg: oklch(0.92 0.01 260);

  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
  --font-display: ui-serif, Georgia, 'Times New Roman', serif;
  --radius: 0.625rem;
}
```

`--font-display` is plan-specific — used for headings and titles to create visual contrast with the body. It's not part of the core Plannotator theme, so it won't be overridden when embedded (which is the desired behavior).

## Token usage map

| Role | Token | SVG equivalent |
|------|-------|----------------|
| Page background | `--background` | — |
| Primary text | `--foreground` | `fill` on text |
| Card / panel background | `--card` | `fill` on rects |
| Subdued text, labels, captions | `--muted-foreground` | `fill` on labels |
| Soft backgrounds, secondary fills | `--muted` | `fill` on secondary rects |
| Primary accent (CTA, attention, keywords) | `--primary` | `stroke` / `fill` on highlighted elements |
| Warm accent | `--accent` | — |
| Positive / success | `--success` | `stroke` / `fill` on success paths |
| Caution | `--warning` | `fill` on warning badges |
| Error / destructive | `--destructive` | `stroke` / `fill` on error paths |
| Borders, dividers | `--border` | `stroke` on box outlines |
| Arrow strokes, diagram lines | `--muted-foreground` | `stroke` on connectors |
| Code block background | `--code-bg` | — |
| Body font | `--font-sans` | `font-family` on SVG body text |
| Code / labels font | `--font-mono` | `font-family` on SVG labels |
| Display / heading font | `--font-display` | `font-family` on SVG titles |

## Base styles

```css
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: var(--font-sans);
  background: var(--background);
  color: var(--foreground);
  line-height: 1.65;
  font-size: 15px;
  -webkit-font-smoothing: antialiased;
}

.container {
  max-width: 1080px;
  margin: 0 auto;
  padding: 64px 24px;
}
```

## Typography

**Headings** — `var(--font-display)`, weight 500, `var(--foreground)`.
- H1: `2rem` page title
- H2: `1.4rem` section headers
- H3: `1.15rem` subsection headers

**Body** — `var(--font-sans)`, weight 400, `0.95rem`, line-height `1.65`. Max paragraph width `65ch`.

**Labels & metadata** — `var(--font-mono)`, `0.7–0.8rem`, weight 500, uppercase, letter-spacing `0.06em`, `var(--muted-foreground)`.

**Code** — `var(--font-mono)`, `0.85rem`, line-height `1.55`.

## Component patterns

### Page header

```html
<header>
  <span class="eyebrow">Implementation plan · Project name</span>
  <h1>Plan Title Goes Here</h1>
  <div class="prompt-box">
    <span class="prompt-label">Brief</span>
    <p>The original task or problem statement that motivated this plan.</p>
  </div>
</header>
```

```css
.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted-foreground);
}

header h1 {
  font-family: var(--font-display);
  font-size: 2rem;
  font-weight: 500;
  margin: 8px 0 24px;
  line-height: 1.2;
}

.prompt-box {
  background: var(--muted);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 24px;
}

.prompt-label {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted-foreground);
  display: block;
  margin-bottom: 4px;
}

.prompt-box p {
  font-size: 0.92rem;
  color: var(--muted-foreground);
  line-height: 1.55;
}
```

### Summary strip (stat cards)

```html
<div class="summary-strip">
  <div class="stat-card">
    <span class="stat-value">4</span>
    <span class="stat-label">Components</span>
  </div>
  <!-- more cards -->
</div>
```

```css
.summary-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 16px;
  margin: 32px 0;
}

.stat-card {
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 24px;
  text-align: center;
  background: var(--card);
}

.stat-value {
  font-family: var(--font-display);
  font-size: 1.8rem;
  font-weight: 500;
  display: block;
  color: var(--foreground);
}

.stat-label {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted-foreground);
  margin-top: 4px;
  display: block;
}
```

### Section header

```html
<section>
  <div class="section-header">
    <span class="section-number">01</span>
    <h2>Solution Overview</h2>
  </div>
  <!-- content -->
</section>
```

```css
section { margin-top: 64px; }

.section-header {
  display: flex;
  align-items: baseline;
  gap: 16px;
  margin-bottom: 24px;
  padding-bottom: 8px;
  border-bottom: 1.5px solid var(--border);
}

.section-number {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--primary);
}

.section-header h2 {
  font-family: var(--font-display);
  font-size: 1.4rem;
  font-weight: 500;
}
```

### Code block (dark theme)

```html
<div class="code-panel">
  <span class="code-label">src/api/handler.ts</span>
  <pre><code><span class="kw">interface</span> <span class="fn">PlanRequest</span> {
  <span class="fn">title</span>: <span class="kw">string</span>;
  <span class="fn">sections</span>: <span class="fn">Section</span>[];
}</code></pre>
</div>
```

```css
.code-panel {
  background: var(--code-bg);
  border-radius: var(--radius);
  padding: 24px;
  overflow-x: auto;
  margin: 16px 0;
  border: 1.5px solid var(--border);
}

.code-label {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--muted-foreground);
  display: block;
  margin-bottom: 8px;
}

.code-panel pre {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  line-height: 1.55;
  color: var(--foreground);
}

/* Syntax tokens — these use semantic roles, not fixed colors */
.code-panel .kw  { color: var(--primary); }         /* keywords */
.code-panel .fn  { color: var(--accent); }           /* identifiers, types */
.code-panel .str { color: var(--success); }          /* strings */
.code-panel .cm  { color: var(--muted-foreground); font-style: italic; } /* comments */
.code-panel .num { color: var(--warning); }          /* numbers */
```

### Risk table

```html
<div class="risk-grid">
  <div class="risk-row">
    <div class="risk-name">Database migration on large table</div>
    <div><span class="badge high">HIGH</span></div>
    <div class="risk-mitigation">Run during off-peak with online DDL</div>
  </div>
  <!-- more rows -->
</div>
```

```css
.risk-grid {
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.risk-row {
  display: grid;
  grid-template-columns: 1fr auto 1.5fr;
  gap: 24px;
  padding: 16px 24px;
  align-items: center;
  border-bottom: 1px solid var(--border);
}

.risk-row:last-child { border-bottom: none; }
.risk-name { font-weight: 500; }
.risk-mitigation { font-size: 0.9rem; color: var(--muted-foreground); }

.badge {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: calc(var(--radius) - 4px);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.badge.high {
  background: color-mix(in oklab, var(--destructive) 15%, transparent);
  color: var(--destructive);
}
.badge.med {
  background: color-mix(in oklab, var(--warning) 15%, transparent);
  color: var(--warning);
}
.badge.low {
  background: color-mix(in oklab, var(--success) 15%, transparent);
  color: var(--success);
}
```

### Callout / open question

```html
<div class="callout">
  <h3>Should we use WebSockets or SSE?</h3>
  <p>SSE is simpler but unidirectional. WebSockets add infrastructure complexity.</p>
  <span class="decide-with">Decide with: infrastructure team</span>
</div>
```

```css
.callout {
  border-left: 3px solid var(--primary);
  padding: 16px 24px;
  margin: 16px 0;
  background: var(--card);
  border-radius: 0 var(--radius) var(--radius) 0;
}

.callout h3 {
  font-family: var(--font-display);
  font-size: 1.05rem;
  font-weight: 500;
  margin-bottom: 4px;
}

.callout p {
  font-size: 0.9rem;
  color: var(--muted-foreground);
  line-height: 1.55;
}

.decide-with {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--primary);
  font-weight: 500;
  display: block;
  margin-top: 8px;
}
```

### Tag chips

```html
<div class="tags">
  <span class="tag">packages/server</span>
  <span class="tag highlight">new endpoint</span>
</div>
```

```css
.tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }

.tag {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  padding: 2px 8px;
  border-radius: calc(var(--radius) - 4px);
  background: var(--muted);
  color: var(--muted-foreground);
}

.tag.highlight {
  background: color-mix(in oklab, var(--primary) 12%, transparent);
  color: var(--primary);
}
```

### Diagram panel

Wraps SVG diagrams in a bordered container:

```html
<div class="diagram-panel">
  <svg viewBox="0 0 720 280" xmlns="http://www.w3.org/2000/svg" style="width:100%">
    <!-- diagram content -->
  </svg>
  <span class="diagram-caption">Request flow through the API gateway</span>
</div>
```

```css
.diagram-panel {
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
  margin: 24px 0;
  background: var(--card);
}

.diagram-caption {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--muted-foreground);
  display: block;
  margin-top: 8px;
  text-align: center;
}
```

### Two-column grid

```css
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
}

@media (max-width: 720px) {
  .two-col { grid-template-columns: 1fr; }
}
```

### Collapsible details

```html
<details>
  <summary>Implementation details</summary>
  <div class="details-body"><!-- content --></div>
</details>
```

```css
details {
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  margin: 16px 0;
}

summary {
  font-family: var(--font-sans);
  font-weight: 500;
  padding: 16px 24px;
  cursor: pointer;
  list-style: none;
}

summary::before {
  content: '▸';
  display: inline-block;
  margin-right: 8px;
  transition: transform 0.2s;
}

details[open] summary::before { transform: rotate(90deg); }

.details-body { padding: 0 24px 24px; }
```

### Milestone timeline

Vertical timeline showing phases without time estimates.

```html
<div class="milestones">
  <div class="milestone">
    <div class="when">Phase 1</div>
    <div class="dot-col"><span class="dot done"></span><span class="line"></span></div>
    <div class="body">
      <h3>Foundation</h3>
      <p>Set up core infrastructure and initial integrations.</p>
      <div class="tags"><span class="tag">packages/server</span></div>
    </div>
  </div>
</div>
```

```css
.milestones { display: flex; flex-direction: column; gap: 0; }

.milestone {
  display: grid;
  grid-template-columns: 120px 28px 1fr;
  gap: 0 18px;
}

.milestone .when {
  text-align: right;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--muted-foreground);
  padding-top: 4px;
}

.milestone .dot-col { display: flex; flex-direction: column; align-items: center; }

.milestone .dot {
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--card);
  border: 3px solid var(--primary);
  flex-shrink: 0;
}

.milestone .dot.done { background: var(--success); border-color: var(--success); }

.milestone .line { width: 2px; flex: 1; background: var(--border); margin: 4px 0; }
.milestone:last-child .line { display: none; }

.milestone .body { padding-bottom: 36px; }

.milestone .body h3 {
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 500;
  margin-bottom: 4px;
}

.milestone .body p {
  font-size: 0.88rem;
  color: var(--muted-foreground);
  max-width: 620px;
  margin-bottom: 10px;
}
```
