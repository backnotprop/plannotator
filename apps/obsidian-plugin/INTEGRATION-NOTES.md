# Plannotator Obsidian Plugin - Integration Notes

This document covers the prep work done for embedding Plannotator in Obsidian.

## 1. Embeddable Mount Function

The React app can now be mounted to any container element:

```typescript
import { mount } from '@plannotator/editor/mount';

const cleanup = mount(container, {
  plan: '# My Plan\n\nContent...',
  theme: 'dark',
  onApprove: () => console.log('Approved'),
  onDeny: (feedback) => console.log('Denied:', feedback),
  apiBaseUrl: null, // Disable API mode
  showUpdateBanner: false,
});

// Later:
cleanup.unmount();
```

### Mount Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `plan` | `string` | Demo content | Initial markdown plan |
| `theme` | `'dark' \| 'light' \| 'system'` | `'dark'` | Theme preference |
| `onApprove` | `() => void` | - | Callback when user approves |
| `onDeny` | `(feedback: string) => void` | - | Callback with formatted annotations |
| `apiBaseUrl` | `string \| null` | Relative URLs | API base URL or null to disable |
| `showUpdateBanner` | `boolean` | `false` | Show GitHub update check banner |
| `className` | `string` | - | Additional CSS class for scoping |

### Mount Result

| Method | Description |
|--------|-------------|
| `unmount()` | Cleanup and remove the app |
| `setPlan(plan)` | Update plan content programmatically |
| `getFeedback()` | Get current annotations as formatted text |

---

## 2. CSS Isolation Analysis

### Global Styles That May Conflict

The current CSS (`packages/editor/index.css`) has these global selectors:

| Selector | Impact | Mitigation |
|----------|--------|------------|
| `body { ... }` | Sets font, background, color | **Needs scoping** - won't affect Obsidian body |
| `* { border-color: ... }` | Sets border color globally | **Needs scoping** - prefix with `.plannotator-root *` |
| `* { transition-property: ... }` | Applies transitions to all elements | **Needs scoping** |
| `::-webkit-scrollbar { ... }` | Custom scrollbars | **Needs scoping** - prefix selectors |
| `::selection { ... }` | Selection highlight color | Minor conflict, can leave |
| `:focus-visible { ... }` | Focus ring styling | Minor conflict, can leave |

### Theme System

The app uses a CSS class toggle system:
- Dark theme: No class (default)
- Light theme: `.light` class added to container

**Current behavior**: ThemeProvider modifies `document.documentElement`
**New behavior**: ScopedThemeProvider modifies the container element

### CSS Variables Required

The app depends on these CSS custom properties:

```css
--background, --foreground, --card, --card-foreground
--popover, --popover-foreground, --primary, --primary-foreground
--secondary, --secondary-foreground, --muted, --muted-foreground
--accent, --accent-foreground, --destructive, --destructive-foreground
--border, --input, --ring
--font-sans, --font-mono, --radius
```

### Font Dependencies

The app expects these fonts (falls back to system fonts):
- **Sans**: Inter, system-ui, sans-serif
- **Mono**: JetBrains Mono, Fira Code, monospace

### Recommended Scoping Strategy

1. **Wrapper class**: All styles scoped under `.plannotator-root`
2. **Theme class**: Apply `.light` or `.dark` to `.plannotator-root` container
3. **CSS-in-JS alternative**: Consider extracting critical styles to a scoped stylesheet

#### Scoped CSS Template

```css
.plannotator-root {
  /* Reset container */
  all: initial;
  font-family: var(--font-sans);
  color: var(--foreground);
  background: var(--background);
}

.plannotator-root * {
  box-sizing: border-box;
  border-color: var(--border);
}

/* Theme variants */
.plannotator-root.dark { /* dark vars */ }
.plannotator-root.light { /* light vars */ }
```

---

## 3. Communication Layer

### Current API Endpoints

The app communicates with a local server via these endpoints:

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/api/plan` | GET | - | `{ plan: string }` |
| `/api/approve` | POST | - | `{ ok: true }` |
| `/api/deny` | POST | `{ feedback: string }` | `{ ok: true }` |

### URL Patterns

All URLs are relative:
```typescript
fetch('/api/plan')
fetch('/api/approve', { method: 'POST' })
fetch('/api/deny', { method: 'POST', body: JSON.stringify({ feedback }) })
```

### For Obsidian Integration

- Set `apiBaseUrl: null` to disable server communication
- Use `onApprove` and `onDeny` callbacks instead
- The app will still work for annotations, just won't hit API endpoints

### External API Calls

| Service | URL | Purpose | Can Disable? |
|---------|-----|---------|--------------|
| GitHub API | `api.github.com/repos/backnotprop/plannotator/releases/latest` | Update check | Yes, via `showUpdateBanner: false` |
| Share service | `share.plannotator.ai` | URL sharing | No - but only triggered by user action |

### CORS Considerations

- In Electron (Obsidian), CORS doesn't apply for same-origin requests
- External API calls (GitHub, share service) should work as Electron doesn't enforce CORS
- No CORS headers are set on the local server (not needed for localhost)

---

## 4. Build Configuration

The esbuild config (`esbuild.config.mjs`) handles:

- **JSX**: `jsx: 'automatic'` for React 17+ JSX transform
- **External**: Obsidian and CodeMirror modules are external (provided at runtime)
- **CSS**: Loaded as text for manual injection
- **Aliases**: Resolves workspace packages

### Build Commands

```bash
bun run dev    # Watch mode
bun run build  # Production build
```

### Output

- `main.js` - Single bundled file
- `manifest.json` - Plugin metadata (already present)
- `styles.css` - (You'll need to create/extract this)

---

## 5. Next Steps for Final Integration

1. **Mount React App**: Uncomment the mount code in `src/view.ts`
2. **CSS Scoping**: Create a scoped version of `packages/editor/index.css`
3. **Theme Detection**: Hook into Obsidian's theme API to match themes
4. **File Integration**: Add commands to open markdown files in Plannotator
5. **Test in Obsidian**: Copy built files to `.obsidian/plugins/plannotator/`

### Obsidian Theme Detection

```typescript
// In main.ts or view.ts
const isDarkMode = document.body.classList.contains('theme-dark');
const theme = isDarkMode ? 'dark' : 'light';
```

### Testing Locally

1. Build the plugin: `bun run build`
2. Create test vault: `mkdir -p ~/test-vault/.obsidian/plugins/plannotator`
3. Copy files: `cp main.js manifest.json styles.css ~/test-vault/.obsidian/plugins/plannotator/`
4. Open vault in Obsidian and enable plugin

---

## 6. File Structure

```
apps/obsidian-plugin/
├── manifest.json         # Obsidian plugin manifest
├── main.ts              # Plugin entry point (stub)
├── package.json         # Dependencies
├── tsconfig.json        # TypeScript config
├── esbuild.config.mjs   # Build configuration
├── INTEGRATION-NOTES.md # This file
└── src/
    ├── view.ts          # Custom view (stub)
    └── index.ts         # Re-exports
```

---

## 7. Known Limitations

1. **Tailwind CSS**: The current setup uses Tailwind 4 which processes at build time. For Obsidian, styles need to be pre-built and extracted.

2. **highlight.js**: Code syntax highlighting is bundled. May conflict with Obsidian's own highlighting.

3. **web-highlighter**: Used for text selection/annotations. Should work in Electron but may need testing.

4. **Cookies**: Storage uses cookies (for port-independence). Will work in Electron but may behave differently.
