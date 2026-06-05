# SVG Diagram Patterns

Building blocks for creating diagrams in implementation plans. All SVGs are inline — no external dependencies. Compose these patterns to build architecture diagrams, data flow visualizations, flowcharts, and charts.

All colors reference Plannotator theme tokens. In SVG, use the CSS custom property values directly via `style` attributes or the corresponding CSS classes.

## Table of Contents
1. [Arrow Markers](#arrow-markers)
2. [Architecture Diagrams](#architecture-diagrams)
3. [Flowcharts](#flowcharts)
4. [Data Flow](#data-flow)
5. [Bar Charts](#bar-charts)
6. [Positioning & Layout](#positioning--layout)

## Arrow markers

Define reusable markers in `<defs>`. Reference them via `marker-end="url(#arrow)"`.

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

**Note on CSS vars in SVG:** `fill="var(--primary)"` works in inline SVG within an HTML document. For broader compatibility, you can also style via CSS classes instead of inline attributes.

## Architecture diagrams

Box-and-arrow diagrams showing how components connect.

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

<!-- Dashed (async, optional, or secondary) -->
<line x1="240" y1="108" x2="320" y2="108"
      stroke="var(--primary)" stroke-width="1.5"
      stroke-dasharray="5 4"
      marker-end="url(#arrow-primary)"/>
```

### Edge labels

Place at the midpoint of an arrow, offset above:

```svg
<text x="280" y="100" text-anchor="middle"
      font-family="var(--font-mono)" font-size="9.5"
      fill="var(--muted-foreground)">REST</text>
```

### Full architecture example

```svg
<svg viewBox="0 0 720 280" xmlns="http://www.w3.org/2000/svg"
     style="width:100%;max-width:720px">
  <style>
    .box { fill: var(--card); stroke: var(--border); stroke-width: 1.5; }
    .box-new { fill: color-mix(in oklab, var(--primary) 8%, transparent);
               stroke: var(--primary); stroke-width: 1.5; }
    .label { font-family: var(--font-sans); font-size: 13px;
             font-weight: 600; fill: var(--foreground); }
    .sublabel { font-family: var(--font-mono); font-size: 10.5px;
                fill: var(--muted-foreground); }
    .edge { stroke: var(--muted-foreground); stroke-width: 1.5; }
    .edge-label { font-family: var(--font-mono); font-size: 9.5px;
                  fill: var(--muted-foreground); }
  </style>
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--muted-foreground)"/>
    </marker>
  </defs>

  <!-- Browser -->
  <rect x="20" y="100" width="120" height="56" rx="10" class="box"/>
  <text x="80" y="124" text-anchor="middle" class="label">Browser</text>
  <text x="80" y="140" text-anchor="middle" class="sublabel">React SPA</text>

  <!-- Arrow: Browser → API -->
  <line x1="140" y1="128" x2="220" y2="128" class="edge" marker-end="url(#a)"/>
  <text x="180" y="120" text-anchor="middle" class="edge-label">HTTPS</text>

  <!-- API Gateway (new) -->
  <rect x="220" y="100" width="140" height="56" rx="10" class="box-new"/>
  <text x="290" y="124" text-anchor="middle" class="label">API Gateway</text>
  <text x="290" y="140" text-anchor="middle" class="sublabel"
        fill="var(--primary)">new</text>

  <!-- Arrow: API → DB -->
  <line x1="360" y1="128" x2="440" y2="128" class="edge" marker-end="url(#a)"/>

  <!-- Postgres -->
  <rect x="440" y="100" width="120" height="56" rx="10" class="box"/>
  <text x="500" y="124" text-anchor="middle" class="label">Postgres</text>
  <text x="500" y="140" text-anchor="middle" class="sublabel">existing</text>

  <!-- Arrow: API → Cache (vertical) -->
  <line x1="290" y1="156" x2="290" y2="210" class="edge" marker-end="url(#a)"/>

  <!-- Redis -->
  <rect x="220" y="210" width="140" height="48" rx="10" class="box"/>
  <text x="290" y="240" text-anchor="middle" class="label">Redis Cache</text>
</svg>
```

## Flowcharts

### Process box

```svg
<rect x="250" y="80" width="120" height="40" rx="8"
      fill="var(--card)" stroke="var(--border)" stroke-width="1.5"/>
<text x="310" y="105" text-anchor="middle"
      font-family="var(--font-sans)" font-size="12" font-weight="500"
      fill="var(--foreground)">Parse input</text>
```

### Decision diamond

```svg
<path d="M310,262 L352,294 L310,326 L268,294 Z"
      fill="var(--card)" stroke="var(--border)" stroke-width="1.5"/>
<text x="310" y="298" text-anchor="middle"
      font-family="var(--font-sans)" font-size="11" font-weight="500"
      fill="var(--foreground)">Valid?</text>
```

### Terminal / pill node

```svg
<rect x="260" y="20" width="100" height="36" rx="18"
      fill="var(--card)" stroke="var(--border)" stroke-width="1.5"/>
<text x="310" y="43" text-anchor="middle"
      font-family="var(--font-sans)" font-size="12" font-weight="500"
      fill="var(--foreground)">Start</text>
```

### Success / failure endpoints

```svg
<!-- Success -->
<rect x="260" y="400" width="100" height="36" rx="18"
      fill="color-mix(in oklab, var(--success) 12%, transparent)"
      stroke="var(--success)" stroke-width="1.5"/>
<text x="310" y="423" text-anchor="middle"
      font-family="var(--font-sans)" font-size="12" font-weight="600"
      fill="var(--success)">Done</text>

<!-- Failure -->
<rect x="100" y="400" width="100" height="36" rx="18"
      fill="color-mix(in oklab, var(--destructive) 12%, transparent)"
      stroke="var(--destructive)" stroke-width="1.5"/>
<text x="150" y="423" text-anchor="middle"
      font-family="var(--font-sans)" font-size="12" font-weight="600"
      fill="var(--destructive)">Error</text>
```

### Curved branch path

For routing flow from a decision to a side branch:

```svg
<path d="M268,294 C200,294 160,294 160,240"
      fill="none" stroke="var(--destructive)" stroke-width="1.5"
      marker-end="url(#arrow-destructive)"/>
```

## Data flow

### Request / response pair

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
<!-- Source box radiating to multiple targets -->
<line x1="200" y1="100" x2="340" y2="60"
      stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>
<line x1="200" y1="100" x2="340" y2="100"
      stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>
<line x1="200" y1="100" x2="340" y2="140"
      stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>
```

## Bar charts

```svg
<svg viewBox="0 0 400 180" xmlns="http://www.w3.org/2000/svg"
     style="width:100%;max-width:400px">
  <!-- Gridlines -->
  <line x1="40" y1="20" x2="380" y2="20"
        stroke="var(--border)" stroke-width="1" opacity="0.5"/>
  <line x1="40" y1="60" x2="380" y2="60"
        stroke="var(--border)" stroke-width="1" opacity="0.5"/>
  <line x1="40" y1="100" x2="380" y2="100"
        stroke="var(--border)" stroke-width="1" opacity="0.5"/>
  <line x1="40" y1="140" x2="380" y2="140"
        stroke="var(--border)" stroke-width="1"/>

  <!-- Y-axis labels -->
  <text x="35" y="24" text-anchor="end"
        font-family="var(--font-mono)" font-size="9"
        fill="var(--muted-foreground)">30</text>
  <text x="35" y="64" text-anchor="end"
        font-family="var(--font-mono)" font-size="9"
        fill="var(--muted-foreground)">20</text>
  <text x="35" y="104" text-anchor="end"
        font-family="var(--font-mono)" font-size="9"
        fill="var(--muted-foreground)">10</text>

  <!-- Bars (muted default, primary for peak) -->
  <rect x="60" y="60" width="40" height="80" rx="4"
        fill="var(--muted)"/>
  <rect x="120" y="40" width="40" height="100" rx="4"
        fill="var(--primary)"/>
  <rect x="180" y="80" width="40" height="60" rx="4"
        fill="var(--muted)"/>
  <rect x="240" y="100" width="40" height="40" rx="4"
        fill="var(--muted)"/>

  <!-- Value labels -->
  <text x="80" y="55" text-anchor="middle"
        font-family="var(--font-mono)" font-size="10" font-weight="600"
        fill="var(--foreground)">20</text>
  <text x="140" y="35" text-anchor="middle"
        font-family="var(--font-mono)" font-size="10" font-weight="600"
        fill="var(--primary)">25</text>

  <!-- X-axis labels -->
  <text x="80" y="158" text-anchor="middle"
        font-family="var(--font-mono)" font-size="9"
        fill="var(--muted-foreground)">Q1</text>
  <text x="140" y="158" text-anchor="middle"
        font-family="var(--font-mono)" font-size="9"
        fill="var(--muted-foreground)">Q2</text>
  <text x="200" y="158" text-anchor="middle"
        font-family="var(--font-mono)" font-size="9"
        fill="var(--muted-foreground)">Q3</text>
  <text x="260" y="158" text-anchor="middle"
        font-family="var(--font-mono)" font-size="9"
        fill="var(--muted-foreground)">Q4</text>
</svg>
```

## Positioning & layout

### SVG container sizing
- Use `viewBox` with fixed coordinates; set `style="width:100%;max-width:NNNpx"` for responsive scaling
- Standard widths: `720px` full-width, `480px` half-width, `360px` sidebar
- Standard heights: `180–320px` for most diagrams

### Box sizing
- Standard node: `120–160px` wide, `48–56px` tall
- Minimum gap between nodes: `60px` horizontal, `40px` vertical
- Arrow label offset: `8–12px` above the line
- Diagram padding: `20px` inside the viewBox edges

### Color roles in diagrams

| Element | Fill / stroke | Token |
|---------|---------------|-------|
| Box background | fill | `var(--card)` |
| Box stroke | stroke | `var(--border)` |
| Highlighted box bg | fill | `color-mix(in oklab, var(--primary) 8%, transparent)` |
| Highlighted box stroke | stroke | `var(--primary)` |
| Arrow / connector | stroke | `var(--muted-foreground)` |
| Title text | fill | `var(--foreground)` |
| Subtitle / label text | fill | `var(--muted-foreground)` |
| Success path | stroke | `var(--success)` |
| Error path | stroke | `var(--destructive)` |
| Warning | fill | `var(--warning)` |

### Using CSS classes in SVG

For cleaner markup, define reusable classes in a `<style>` block inside the SVG:

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
  <!-- nodes and connectors use class="box", class="title", etc. -->
</svg>
```
