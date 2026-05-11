# Extended Patterns

Components that complement visual-explainer's toolkit. These use the same Plannotator theme tokens from `theme-override.md` and can be mixed freely with Nico's `.ve-card`, `.kpi-card`, `.pipeline` patterns.

## Timeline

Vertical timeline showing phases or sequence — without time estimates. Shows ordering and dependencies, not duration.

```html
<div class="timeline">
  <div class="timeline-item">
    <div class="timeline-label">Phase 1</div>
    <div class="timeline-dot-col">
      <div class="timeline-dot active"></div>
      <div class="timeline-line"></div>
    </div>
    <div class="timeline-content">
      <h4>Foundation</h4>
      <p>Set up the core infrastructure and initial integrations.</p>
    </div>
  </div>
  <!-- more items -->
</div>
```

```css
.timeline { display: flex; flex-direction: column; gap: 0; }

.timeline-item {
  display: grid;
  grid-template-columns: 100px 28px 1fr;
  gap: 16px;
  min-height: 80px;
}

.timeline-label {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--muted-foreground);
  text-align: right;
  padding-top: 4px;
}

.timeline-dot-col {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.timeline-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--card);
  border: 3px solid var(--primary);
  flex-shrink: 0;
}

.timeline-dot.active { background: var(--primary); }

.timeline-line {
  width: 2px;
  flex: 1;
  background: var(--border);
}

.timeline-content { padding-bottom: 24px; }

.timeline-content h4 {
  font-family: var(--font-display);
  font-size: 1rem;
  font-weight: 500;
  margin-bottom: 4px;
}

.timeline-content p {
  font-size: 0.88rem;
  color: var(--muted-foreground);
}
```

The last timeline item should hide the line: `style="background: transparent"` on the `.timeline-line`.

## Code Blocks with Syntax Highlighting

Dark-themed code panels showing key interfaces, schemas, or API signatures. Use sparingly — show the 5-10 lines that matter, not full files.

```html
<div class="code-panel">
  <span class="code-file">src/api/handler.ts</span>
  <pre><code><span class="kw">interface</span> <span class="fn">Config</span> {
  <span class="fn">port</span>: <span class="kw">number</span>;
  <span class="fn">host</span>: <span class="kw">string</span>;
}</code></pre>
</div>
```

```css
.code-panel {
  background: var(--code-bg);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 20px 24px;
  overflow-x: auto;
  margin: 16px 0;
}

.code-file {
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
  white-space: pre-wrap;
  word-break: break-word;
}

.code-panel .kw  { color: var(--primary); }
.code-panel .fn  { color: var(--accent); }
.code-panel .str { color: var(--success); }
.code-panel .cm  { color: var(--muted-foreground); font-style: italic; }
.code-panel .num { color: var(--warning); }
```

## Risk Table

Severity-graded risk assessment with colored badges.

```html
<div class="risk-grid">
  <div class="risk-row">
    <div class="risk-name">Database migration on live table</div>
    <div><span class="risk-badge risk-high">HIGH</span></div>
    <div class="risk-mitigation">Run during off-peak with online DDL</div>
  </div>
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

.risk-badge {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.risk-high {
  background: color-mix(in oklab, var(--destructive) 15%, transparent);
  color: var(--destructive);
}
.risk-med {
  background: color-mix(in oklab, var(--warning) 15%, transparent);
  color: var(--warning);
}
.risk-low {
  background: color-mix(in oklab, var(--success) 15%, transparent);
  color: var(--success);
}
```

## Open Questions

Callout cards for unresolved decisions. Each names who can answer.

```html
<div class="question">
  <h3>Should we use WebSockets or SSE?</h3>
  <p>SSE is simpler but unidirectional. WebSockets add infrastructure complexity.</p>
  <span class="question-owner">Decide with: infrastructure team</span>
</div>
```

```css
.question {
  border-left: 3px solid var(--primary);
  padding: 16px 24px;
  margin: 16px 0;
  background: var(--card);
  border-radius: 0 var(--radius) var(--radius) 0;
}

.question h3 {
  font-family: var(--font-display);
  font-size: 1.05rem;
  font-weight: 500;
  margin-bottom: 4px;
}

.question p {
  font-size: 0.9rem;
  color: var(--muted-foreground);
  line-height: 1.55;
}

.question-owner {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--primary);
  font-weight: 500;
  display: block;
  margin-top: 8px;
}
```

## Inline SVG Diagrams

For architecture, data flow, and simple flowcharts where Mermaid is overkill (under 8 nodes, simple topology). These produce crisp, theme-aware vector diagrams drawn directly in the HTML. Use Mermaid for anything with complex edge routing (10+ nodes, many crossing connections).

### Container

```html
<div class="svg-panel">
  <svg viewBox="0 0 720 280" xmlns="http://www.w3.org/2000/svg" style="width:100%">
    <!-- diagram content -->
  </svg>
  <span class="svg-caption">Request flow through the API gateway</span>
</div>
```

```css
.svg-panel {
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
  margin: 24px 0;
  background: var(--card);
}

.svg-caption {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--muted-foreground);
  display: block;
  margin-top: 8px;
  text-align: center;
}
```

### Arrow markers

Define in `<defs>`. Reference via `marker-end="url(#arrow)"`.

```svg
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="var(--muted-foreground)"/>
  </marker>
  <marker id="arrow-primary" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="var(--primary)"/>
  </marker>
  <marker id="arrow-success" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="var(--success)"/>
  </marker>
  <marker id="arrow-destructive" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="var(--destructive)"/>
  </marker>
</defs>
```

### Box node

```svg
<g transform="translate(100, 80)">
  <rect width="140" height="56" rx="10" fill="var(--card)"
        stroke="var(--border)" stroke-width="1.5"/>
  <text x="70" y="24" text-anchor="middle"
        font-family="var(--font-sans)" font-size="13" font-weight="600"
        fill="var(--foreground)">API Server</text>
  <text x="70" y="40" text-anchor="middle"
        font-family="var(--font-mono)" font-size="10.5"
        fill="var(--muted-foreground)">Express + middleware</text>
</g>
```

### Highlighted box (new or hot-path component)

```svg
<g transform="translate(100, 80)">
  <rect width="140" height="56" rx="10"
        fill="color-mix(in oklab, var(--primary) 8%, transparent)"
        stroke="var(--primary)" stroke-width="1.5"/>
  <text x="70" y="24" text-anchor="middle"
        font-family="var(--font-sans)" font-size="13" font-weight="600"
        fill="var(--foreground)">New Service</text>
  <text x="70" y="40" text-anchor="middle"
        font-family="var(--font-mono)" font-size="10.5"
        fill="var(--primary)">to be created</text>
</g>
```

### Connecting arrows

```svg
<!-- Horizontal -->
<line x1="240" y1="108" x2="320" y2="108"
      stroke="var(--muted-foreground)" stroke-width="1.5"
      marker-end="url(#arrow)"/>

<!-- Vertical -->
<line x1="170" y1="136" x2="170" y2="200"
      stroke="var(--muted-foreground)" stroke-width="1.5"
      marker-end="url(#arrow)"/>

<!-- Dashed (async, optional, or secondary path) -->
<line x1="240" y1="108" x2="320" y2="108"
      stroke="var(--primary)" stroke-width="1.5"
      stroke-dasharray="5 4"
      marker-end="url(#arrow-primary)"/>
```

### Edge labels

```svg
<text x="280" y="100" text-anchor="middle"
      font-family="var(--font-mono)" font-size="9.5"
      fill="var(--muted-foreground)">REST</text>
```

### Flowchart elements

```svg
<!-- Decision diamond -->
<path d="M310,262 L352,294 L310,326 L268,294 Z"
      fill="var(--card)" stroke="var(--border)" stroke-width="1.5"/>
<text x="310" y="298" text-anchor="middle"
      font-family="var(--font-sans)" font-size="11" font-weight="500"
      fill="var(--foreground)">Valid?</text>

<!-- Terminal / pill node -->
<rect x="260" y="20" width="100" height="36" rx="18"
      fill="var(--card)" stroke="var(--border)" stroke-width="1.5"/>

<!-- Success endpoint -->
<rect x="260" y="400" width="100" height="36" rx="18"
      fill="color-mix(in oklab, var(--success) 12%, transparent)"
      stroke="var(--success)" stroke-width="1.5"/>

<!-- Failure endpoint -->
<rect x="100" y="400" width="100" height="36" rx="18"
      fill="color-mix(in oklab, var(--destructive) 12%, transparent)"
      stroke="var(--destructive)" stroke-width="1.5"/>

<!-- Curved branch from decision to side -->
<path d="M268,294 C200,294 160,294 160,240"
      fill="none" stroke="var(--destructive)" stroke-width="1.5"
      marker-end="url(#arrow-destructive)"/>
```

### Data flow (request/response)

```svg
<!-- Request (solid) -->
<line x1="140" y1="100" x2="280" y2="100"
      stroke="var(--muted-foreground)" stroke-width="1.5"
      marker-end="url(#arrow)"/>
<text x="210" y="92" text-anchor="middle"
      font-family="var(--font-mono)" font-size="9.5"
      fill="var(--muted-foreground)">POST /api/plan</text>

<!-- Response (dashed) -->
<line x1="280" y1="116" x2="140" y2="116"
      stroke="var(--primary)" stroke-width="1.5" stroke-dasharray="5 4"
      marker-end="url(#arrow-primary)"/>
<text x="210" y="132" text-anchor="middle"
      font-family="var(--font-mono)" font-size="9.5"
      fill="var(--primary)">{ plan, status }</text>
```

### Fan-out pattern

```svg
<line x1="200" y1="100" x2="340" y2="60"
      stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>
<line x1="200" y1="100" x2="340" y2="100"
      stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>
<line x1="200" y1="100" x2="340" y2="140"
      stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>
```

### Bar chart

```svg
<svg viewBox="0 0 400 180" xmlns="http://www.w3.org/2000/svg"
     style="width:100%;max-width:400px">
  <!-- Gridlines -->
  <line x1="40" y1="20" x2="380" y2="20" stroke="var(--border)" stroke-width="1" opacity="0.5"/>
  <line x1="40" y1="60" x2="380" y2="60" stroke="var(--border)" stroke-width="1" opacity="0.5"/>
  <line x1="40" y1="100" x2="380" y2="100" stroke="var(--border)" stroke-width="1" opacity="0.5"/>
  <line x1="40" y1="140" x2="380" y2="140" stroke="var(--border)" stroke-width="1"/>

  <!-- Bars (muted default, primary for peak) -->
  <rect x="60" y="60" width="40" height="80" rx="4" fill="var(--muted)"/>
  <rect x="120" y="40" width="40" height="100" rx="4" fill="var(--primary)"/>
  <rect x="180" y="80" width="40" height="60" rx="4" fill="var(--muted)"/>

  <!-- Value labels above bars -->
  <text x="140" y="35" text-anchor="middle"
        font-family="var(--font-mono)" font-size="10" font-weight="600"
        fill="var(--primary)">25</text>

  <!-- X-axis labels -->
  <text x="80" y="158" text-anchor="middle"
        font-family="var(--font-mono)" font-size="9"
        fill="var(--muted-foreground)">Q1</text>
</svg>
```

### Using CSS classes in SVG

For cleaner markup, define reusable classes inside the SVG:

```svg
<svg viewBox="0 0 720 280" xmlns="http://www.w3.org/2000/svg">
  <style>
    .box   { fill: var(--card); stroke: var(--border); stroke-width: 1.5; }
    .new   { fill: color-mix(in oklab, var(--primary) 8%, transparent);
             stroke: var(--primary); stroke-width: 1.5; }
    .title { font-family: var(--font-sans); font-size: 13px;
             font-weight: 600; fill: var(--foreground); }
    .sub   { font-family: var(--font-mono); font-size: 10.5px;
             fill: var(--muted-foreground); }
    .conn  { stroke: var(--muted-foreground); stroke-width: 1.5; }
  </style>
</svg>
```

### Positioning rules

- `viewBox` with fixed coordinates + `style="width:100%;max-width:720px"` for responsive scaling
- Standard node: `120–160px` wide, `48–56px` tall
- Minimum gap: `60px` horizontal, `40px` vertical
- Arrow label offset: `8–12px` above the line

### Color roles in SVG

| Element | Token |
|---------|-------|
| Box background | `var(--card)` |
| Box stroke | `var(--border)` |
| Highlighted box | `var(--primary)` stroke, `color-mix(in oklab, var(--primary) 8%, transparent)` fill |
| Arrows / connectors | `var(--muted-foreground)` |
| Title text | `var(--foreground)` |
| Subtitle / labels | `var(--muted-foreground)` |
| Success path | `var(--success)` |
| Error path | `var(--destructive)` |
| Warning | `var(--warning)` |

## Section Headers

Numbered sections with display font headings:

```css
.section-header {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-bottom: 24px;
  padding-bottom: 8px;
  border-bottom: 1.5px solid var(--border);
}

.section-num {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--primary);
}

.section-header h2 {
  font-family: var(--font-display);
  font-size: 1.35rem;
  font-weight: 500;
}
```

## Tag Chips

Small inline labels for categorizing items:

```css
.tag {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--muted);
  color: var(--muted-foreground);
}

.tag-highlight {
  background: color-mix(in oklab, var(--primary) 12%, transparent);
  color: var(--primary);
}
```

## Diff Rendering (for PR reviews)

Use Pierre diffs via CDN for syntax-highlighted, theme-aware diff rendering. Pierre renders into shadow DOM (no style conflicts) and supports Plannotator theme tokens via CSS variable injection.

```html
<script type="module">
  import { getSingularPatch, registerDiffsComponent } from 'https://cdn.jsdelivr.net/npm/@pierre/diffs@1.1.21/+esm';

  registerDiffsComponent();

  const patch = `--- a/src/handler.ts
+++ b/src/handler.ts
@@ -1,4 +1,6 @@
 import { Router } from 'express';
+import { NotificationService } from './notifications';
-import { legacyPoll } from './polling';
 
 export function createHandler() {`;

  const fileDiff = getSingularPatch(patch);

  const container = document.querySelector('diffs-container');
  container.fileDiff = fileDiff;
  container.options = {
    themeType: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    diffStyle: 'unified',
    diffIndicators: 'bars',
    lineDiffType: 'word-alt',
    unsafeCSS: `
      :host {
        --diffs-bg: var(--background);
        --diffs-fg: var(--foreground);
        --diffs-dark-bg: var(--background);
        --diffs-light-bg: var(--background);
        --diffs-dark: var(--foreground);
        --diffs-light: var(--foreground);
        border-radius: var(--radius);
        border: 1.5px solid var(--border);
        overflow: hidden;
      }
    `,
  };
</script>

<diffs-container></diffs-container>
```

Pierre handles syntax highlighting (via Shiki), line numbers, add/del coloring, word-level diffs, and split/unified views automatically. The `unsafeCSS` option injects Plannotator theme tokens into the shadow DOM.

For multiple diffs on one page, create one `<diffs-container>` per file and set `fileDiff` + `options` on each.

## Review Comment Bubbles (for PR reviews)

Speech bubbles with severity-coded left borders.

```css
.bubble {
  position: relative;
  background: var(--card);
  border: 1.5px solid var(--border);
  border-left-width: 4px;
  border-radius: 8px;
  padding: 12px 14px 12px 16px;
  max-width: 680px;
}

.bubble.blocking { border-left-color: var(--primary); }
.bubble.nit { border-left-color: var(--border); }
.bubble.suggestion { border-left-color: var(--success); }

.bubble .severity {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.bubble.blocking .severity { color: var(--primary); }
.bubble.nit .severity { color: var(--muted-foreground); }
.bubble.suggestion .severity { color: var(--success); }
```

## File Badges (for PR reviews)

```css
.file-badge {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 4px;
}

.file-badge.new { background: color-mix(in oklab, var(--success) 15%, transparent); color: var(--success); }
.file-badge.mod { background: color-mix(in oklab, var(--warning) 15%, transparent); color: var(--warning); }
.file-badge.del { background: color-mix(in oklab, var(--destructive) 15%, transparent); color: var(--destructive); }
```
