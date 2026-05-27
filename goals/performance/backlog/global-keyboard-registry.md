# Global Keyboard Shortcut Registry

## Problem

Every session surface registers its own keyboard listeners on `window`. With 5 sessions mounted (4 hidden via keep-alive), every keystroke fires 32 handlers. Most bail out early via `isVisible()` checks, but the function call overhead accumulates and causes input lag.

There are two categories of keyboard handlers:
- **38 bindings in the shortcut registry** (`packages/ui/shortcuts/`) — already structured, but each surface creates its own `useShortcutScope` listener on `window`
- **10 raw `window.addEventListener('keydown')` calls** — bypass the registry entirely, inlined in the two 2500-line App.tsx files

## Current Architecture

```
Session A (visible)
  ├── useShortcutScope('plan-editor') → window.addEventListener
  ├── window.addEventListener('keydown') × 4 (raw)
  └── window.addEventListener('paste') × 1

Session B (hidden)
  ├── useShortcutScope('review-editor') → window.addEventListener
  ├── window.addEventListener('keydown') × 6 (raw)
  └── window.addEventListener('keyup') × 1

Session C (hidden)
  └── ... same as above
```

Every keystroke → dispatches to ALL listeners across ALL sessions.

## Target Architecture

```
App Shell (Layout.tsx)
  └── ONE window.addEventListener('keydown')
      ├── Checks activeSessionId
      ├── Looks up active surface's scope + handlers
      └── Dispatches to ONE surface only

Session A (visible)
  └── Registers handlers with the global registry (no window listener)

Session B (hidden)
  └── Handlers registered but never dispatched (not active)
```

Every keystroke → dispatches to ONE handler set.

## Implementation

### Phase 1: Global dispatcher in app shell

Create `apps/frontend/src/keyboard/global-dispatcher.ts`:
- One `window.addEventListener('keydown')` registered in `Layout.tsx`
- Maintains a map of `sessionId → { scope, handlers }`
- On keydown: look up `activeSessionId`, dispatch to that session's handlers only
- Surfaces call `registerSessionShortcuts(sessionId, scope, handlers)` on mount and `unregister` on unmount

### Phase 2: Move raw handlers into scopes

The 10 raw handlers in the two App.tsx files need to become scope bindings:

**Code Review (`plannotator-code-review/App.tsx`):**

| Line | Keys | Complexity |
|------|------|-----------|
| 651 | Mod+Shift+T (dev tour) | Trivial |
| 759 | Mod+F, Enter/F3, Escape, Mod+B, Mod+. (search/nav) | Complex — 5 keys, state-dependent |
| 1099 | V, A (file viewed/stage) | Medium |
| 1710-1711 | Alt Alt (double-tap destination toggle) | Tricky — partially in registry |
| 1762 | Mod+Enter (approve/feedback) | Medium |

**Plan Review (`plannotator-plan-review/App.tsx`):**

| Line | Keys | Complexity |
|------|------|-----------|
| 322 | Escape (close plan diff) | Trivial |
| 941 | Paste (image handling) | Different event, stays raw |
| 1211 | Mod+Enter (approve/feedback) | Medium |
| 1553 | Mod+S (quick save) | Trivial |
| 1579 | Mod+P (print) | Trivial |

### Phase 3: Remove per-surface window listeners

Each surface stops calling `window.addEventListener` directly. Instead they pass their handlers to the global dispatcher via a prop or context. The `useShortcutScope` hook gets deprecated for the embedded case — surfaces use the global registry instead.

## Effort

- Phase 1 (global dispatcher): ~1 hour
- Phase 2 (move 10 handlers): ~2 hours  
- Phase 3 (cleanup): ~30 minutes
- Testing: ~1 hour

**Total: ~4-5 hours**

## Risk

Low. The shortcut engine's `dispatchShortcutEvent` already handles matching and preventDefault. We're changing WHERE it's called (app shell vs surface), not HOW. The paste handler stays raw (different event type). The double-tap Alt handler needs special attention since `useDoubleTapShortcuts` uses keyup, not keydown.

## Result

- 1 keyboard listener instead of 32
- Zero handlers fire on hidden sessions
- All shortcuts centrally defined and discoverable
- The unified settings Shortcuts tab already shows all bindings — this makes the runtime match
