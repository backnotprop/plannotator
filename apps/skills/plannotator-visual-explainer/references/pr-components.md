# PR Component Patterns

Component patterns specific to PR explainer documents. For the base design system (colors, typography, layout), see `../../plannotator-visual-plan/references/design-system.md`.

## Table of Contents
1. [PR Header](#pr-header)
2. [TL;DR Box](#tldr-box)
3. [Diff Rendering](#diff-rendering)
4. [Review Comments](#review-comments)
5. [Risk Map](#risk-map)
6. [File Cards](#file-cards)
7. [Before / After](#before--after)
8. [Where to Focus](#where-to-focus)
9. [Test Plan](#test-plan)
10. [File Badges](#file-badges)

## PR header

```html
<header>
  <span class="eyebrow">Pull request · repo-name</span>
  <h1>Add real-time notification system</h1>
  <div class="pr-meta">
    <span>6 files</span>
    <span class="additions">+142</span>
    <span class="deletions">-38</span>
    <span>feature/notifications → main</span>
  </div>
</header>
```

```css
.pr-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--muted-foreground);
  margin-top: 8px;
}

.pr-meta .additions { color: var(--success); }
.pr-meta .deletions { color: var(--destructive); }
```

## TL;DR box

```html
<div class="tldr">
  <h3>TL;DR</h3>
  <p>Adds WebSocket-based notifications with per-user channels. Messages fan out
     from a new NotificationService through Redis pub/sub. Existing REST endpoints
     are unchanged.</p>
</div>
```

```css
.tldr {
  background: var(--card);
  border: 1.5px solid var(--border);
  border-left: 4px solid var(--primary);
  border-radius: var(--radius);
  padding: 20px 24px;
  max-width: 760px;
  margin: 24px 0;
}

.tldr h3 {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--primary);
  margin-bottom: 8px;
}

.tldr p {
  font-size: 0.95rem;
  line-height: 1.6;
  color: var(--muted-foreground);
}
```

## Diff rendering

Three-column grid on a dark background: line number | +/- marker | code.

```html
<div class="diff">
  <div class="diff-row hunk">
    <span class="ln"></span>
    <span class="mark"></span>
    <span class="code">@@ -1,4 +1,6 @@</span>
  </div>
  <div class="diff-row ctx">
    <span class="ln">1</span>
    <span class="mark"></span>
    <span class="code">import { Router } from 'express';</span>
  </div>
  <div class="diff-row add">
    <span class="ln">2</span>
    <span class="mark">+</span>
    <span class="code">import { NotificationService } from './notifications';</span>
  </div>
  <div class="diff-row del">
    <span class="ln">3</span>
    <span class="mark">-</span>
    <span class="code">import { legacyPoll } from './polling';</span>
  </div>
</div>
```

```css
.diff {
  background: var(--code-bg);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.7;
  overflow-x: auto;
  border-radius: var(--radius);
  border: 1.5px solid var(--border);
}

.diff-row {
  display: grid;
  grid-template-columns: 48px 18px 1fr;
  align-items: baseline;
  padding: 0 14px 0 0;
  white-space: pre;
}

.diff-row .ln {
  text-align: right;
  padding-right: 14px;
  color: var(--muted-foreground);
  user-select: none;
  opacity: 0.5;
}

.diff-row .mark {
  text-align: center;
  color: var(--muted-foreground);
}

.diff-row .code {
  color: var(--foreground);
}

/* Context lines — dimmed */
.diff-row.ctx .code {
  opacity: 0.6;
}

/* Added lines — success tint */
.diff-row.add {
  background: color-mix(in oklab, var(--success) 12%, transparent);
}
.diff-row.add .mark {
  color: var(--success);
}

/* Deleted lines — destructive tint */
.diff-row.del {
  background: color-mix(in oklab, var(--destructive) 12%, transparent);
}
.diff-row.del .mark {
  color: var(--destructive);
}

/* Hunk headers */
.diff-row.hunk {
  background: color-mix(in oklab, var(--muted) 30%, transparent);
  color: var(--muted-foreground);
}

/* Syntax tokens inside diff code */
.diff .kw  { color: var(--primary); }
.diff .fn  { color: var(--accent); }
.diff .str { color: var(--success); }
.diff .cm  { color: var(--muted-foreground); font-style: italic; }
```

## Review comments

Speech bubbles with severity-coded left borders, attached below a diff block.

```html
<div class="comments">
  <div class="bubble blocking">
    <span class="anchor">line 11</span>
    <span class="severity">BLOCKING</span>
    <p>This mutation isn't wrapped in a transaction. If the second write
       fails, the first persists — leaving the user in a broken state.</p>
  </div>
  <div class="bubble nit">
    <span class="anchor">line 24</span>
    <span class="severity">NIT</span>
    <p>Prefer <code>const</code> here since <code>config</code> is never reassigned.</p>
  </div>
</div>
```

```css
.comments {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--muted);
  border-top: 1px solid var(--border);
}

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

.bubble::before {
  content: "";
  position: absolute;
  left: -9px;
  top: 16px;
  width: 12px;
  height: 12px;
  background: var(--card);
  border-left: 1.5px solid var(--border);
  border-bottom: 1.5px solid var(--border);
  transform: rotate(45deg);
}

.bubble.blocking::before {
  border-left-color: var(--primary);
  border-bottom-color: var(--primary);
}

.anchor {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--muted-foreground);
}

.severity {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-left: 8px;
}

.bubble.blocking .severity { color: var(--primary); }
.bubble.nit .severity { color: var(--muted-foreground); }
.bubble.suggestion .severity { color: var(--success); }

.bubble p {
  margin-top: 6px;
  font-size: 0.88rem;
  line-height: 1.55;
  color: var(--foreground);
}

.bubble code {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  background: var(--muted);
  padding: 1px 5px;
  border-radius: 3px;
}
```

## Risk map

Chips that give a quick overview of file risk levels.

```html
<div class="risk-map">
  <a href="#file-auth" class="chip attention">
    <span class="dot"></span>
    src/auth/middleware.ts
  </a>
  <a href="#file-db" class="chip medium">
    <span class="dot"></span>
    src/db/migrations/004.sql
  </a>
  <a href="#file-types" class="chip safe">
    <span class="dot"></span>
    src/types/index.ts
  </a>
</div>
```

```css
.risk-map {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 24px 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  padding: 6px 12px;
  border: 1.5px solid var(--border);
  border-radius: 20px;
  text-decoration: none;
  color: var(--foreground);
  transition: box-shadow 0.15s;
}

.chip:hover {
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--primary) 25%, transparent);
}

.chip .dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.chip.attention {
  background: color-mix(in oklab, var(--destructive) 8%, transparent);
  border-color: color-mix(in oklab, var(--destructive) 40%, transparent);
}
.chip.attention .dot { background: var(--destructive); }

.chip.medium {
  background: color-mix(in oklab, var(--warning) 10%, transparent);
  border-color: color-mix(in oklab, var(--warning) 30%, transparent);
}
.chip.medium .dot { background: var(--warning); }

.chip.safe {
  background: color-mix(in oklab, var(--success) 8%, transparent);
  border-color: color-mix(in oklab, var(--success) 35%, transparent);
}
.chip.safe .dot { background: var(--success); }
```

## File cards

Expandable cards grouping a file's diff and review commentary.

```html
<div class="file-card" id="file-auth">
  <div class="file-head">
    <div class="file-info">
      <span class="file-path">src/auth/middleware.ts</span>
      <span class="file-badge mod">MOD</span>
      <span class="file-stats"><span class="additions">+28</span> <span class="deletions">-12</span></span>
    </div>
    <span class="risk-tag attention">ATTENTION</span>
  </div>
  <div class="file-why">
    <p>Replaced session-cookie auth with JWT verification. The trust boundary
       moves from the session store to the token signature check.</p>
  </div>
  <div class="diff"><!-- diff rows --></div>
  <div class="comments"><!-- review bubbles --></div>
</div>

<!-- Safe files: collapsed -->
<details class="file-collapsed">
  <summary>
    <span class="file-path">src/types/index.ts</span>
    <span class="file-badge mod">MOD</span>
    <span class="file-stats"><span class="additions">+4</span> <span class="deletions">-0</span></span>
    <span class="risk-tag safe">SAFE</span>
  </summary>
  <div class="file-why">
    <p>Added NotificationPayload type export.</p>
  </div>
</details>
```

```css
.file-card {
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  overflow: hidden;
  scroll-margin-top: 20px;
  margin: 16px 0;
}

.file-head {
  padding: 16px 20px;
  border-bottom: 1.5px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.file-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.file-path {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  font-weight: 600;
}

.file-stats {
  font-family: var(--font-mono);
  font-size: 0.72rem;
}

.file-stats .additions { color: var(--success); }
.file-stats .deletions { color: var(--destructive); }

.file-why {
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
}

.file-why p {
  font-size: 0.9rem;
  color: var(--muted-foreground);
  line-height: 1.55;
}

/* Collapsed (safe) files */
.file-collapsed {
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  margin: 8px 0;
}

.file-collapsed summary {
  list-style: none;
  cursor: pointer;
  padding: 14px 20px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.file-collapsed summary::after {
  content: '+';
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--muted-foreground);
  margin-left: auto;
}

.file-collapsed[open] summary::after {
  content: '\2212';
}
```

## Before / after

Two-column comparison grid.

```html
<div class="before-after">
  <div class="ba-panel before">
    <h4>Before</h4>
    <p>Auth checked via session cookie on every request.
       Session store hit adds ~15ms latency.</p>
  </div>
  <div class="ba-panel after">
    <h4>After</h4>
    <p>JWT signature verified in-process. No external store hit.
       Latency drops to ~1ms per request.</p>
  </div>
</div>
```

```css
.before-after {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 16px 0;
}

@media (max-width: 640px) {
  .before-after { grid-template-columns: 1fr; }
}

.ba-panel {
  background: var(--card);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
}

.ba-panel.after {
  border-color: var(--success);
}

.ba-panel h4 {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 8px;
}

.ba-panel.before h4 { color: var(--muted-foreground); }
.ba-panel.after h4 { color: var(--success); }

.ba-panel p {
  font-size: 0.9rem;
  line-height: 1.55;
  color: var(--foreground);
}
```

## Where to focus

Numbered callout cards directing reviewers.

```html
<div class="focus-list">
  <div class="focus-item">
    <span class="focus-number">1</span>
    <div>
      <strong>src/auth/middleware.ts:verifyToken()</strong>
      <p>New trust boundary. Verify the JWT validation covers all edge cases:
         expired tokens, malformed signatures, missing claims.</p>
    </div>
  </div>
</div>
```

```css
.focus-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 16px 0;
}

.focus-item {
  background: var(--card);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 20px;
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.focus-number {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--primary-foreground);
  background: var(--primary);
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.focus-item strong {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  display: block;
  margin-bottom: 4px;
}

.focus-item p {
  font-size: 0.88rem;
  color: var(--muted-foreground);
  line-height: 1.5;
}
```

## Test plan

Checkbox-style verification checklist.

```html
<div class="test-list">
  <div class="test-item done">
    <span class="check"></span>
    <span>Expired JWT returns 401 with proper error body</span>
  </div>
  <div class="test-item">
    <span class="check"></span>
    <span>Concurrent WebSocket connections scale to 1000 without memory leak</span>
  </div>
</div>
```

```css
.test-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 16px 0;
}

.test-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: var(--card);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 13px 18px;
  font-size: 0.88rem;
}

.check {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: 1.5px solid var(--border);
  flex-shrink: 0;
  position: relative;
  margin-top: 2px;
}

.test-item.done .check {
  background: var(--success);
  border-color: var(--success);
}

.test-item.done .check::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 2px;
  width: 5px;
  height: 9px;
  border-right: 2px solid var(--card);
  border-bottom: 2px solid var(--card);
  transform: rotate(40deg);
}
```

## File badges

```css
.file-badge {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: calc(var(--radius) - 4px);
}

.file-badge.new {
  background: color-mix(in oklab, var(--success) 15%, transparent);
  color: var(--success);
}

.file-badge.mod {
  background: color-mix(in oklab, var(--warning) 15%, transparent);
  color: var(--warning);
}

.file-badge.del {
  background: color-mix(in oklab, var(--destructive) 15%, transparent);
  color: var(--destructive);
}

.risk-tag {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 3px 8px;
  border-radius: calc(var(--radius) - 4px);
}

.risk-tag.attention {
  background: color-mix(in oklab, var(--destructive) 12%, transparent);
  color: var(--destructive);
}

.risk-tag.medium {
  background: color-mix(in oklab, var(--warning) 12%, transparent);
  color: var(--warning);
}

.risk-tag.safe {
  background: color-mix(in oklab, var(--success) 12%, transparent);
  color: var(--success);
}
```
