## Keyboard Shortcuts

**Location:** `packages/ui/shortcuts/` (engine + scope data), `packages/editor/shortcuts.ts` and `packages/review-editor/shortcuts.ts` (per-app surfaces).

The shortcut system has three layers:

1. **Engine** (`packages/ui/shortcuts/{core,runtime}.ts`) — parser for declarative bindings (`Mod+Enter`, `Alt Alt` double-tap, `Alt hold`), dispatcher, platform-aware formatter (mac glyphs vs. `Ctrl`), validator, and the `useShortcutScope` / `useDoubleTapShortcuts` React hooks. Truly shared — both apps use it as-is.
2. **Scopes** — `defineShortcutScope({ id, title, shortcuts: { actionId: { bindings, description, section, ... } } })`. One scope per UI surface (annotation toolbar, comment popover, file tree, etc.). App-specific scopes live in `packages/ui/shortcuts/{plan-review,code-review}/` — **the subfolder names which app's UI the scope serves** — while genuinely cross-app scopes such as `history.shortcuts.ts` and `decisionControl.shortcuts.ts` (the header decision control's note-composer chords, mounted identically by both apps) live at the shortcuts root. Components/Apps wire handlers to a scope via `useShortcutScope({ scope, handlers: { actionId: () => ... } })`.
3. **Surfaces** (`packages/editor/shortcuts.ts`, `packages/review-editor/shortcuts.ts`) — each app composes its scopes into a `ShortcutSurface` (`planReviewSurface`, `annotateSurface`, `codeReviewSurface`). Surfaces feed both the in-app help modal and the marketing site's auto-generated docs page.

**Convention for adding new shortcuts:** define the action in the relevant app-specific subfolder (`plan-review/` or `code-review/`), or at the shortcuts root when both apps share the same action and semantics. Declare the binding(s) and description, then wire a handler at the call site with `useShortcutScope`. The marketing docs page picks it up automatically at next build. Unit tests in `packages/ui/shortcuts.test.ts` enforce normalized binding tokens (`Mod`, `Shift`, `Alt`, `A-Z`, `1-0`, named keys, `F1`–`F12`) and unique scope ids.

**Marketing docs auto-generation:** `apps/marketing/src/lib/shortcutReference.ts` reads the three surfaces and `apps/marketing/src/components/ShortcutReference.astro` renders them as tables. The `/docs/reference/keyboard-shortcuts` page is special-cased in `apps/marketing/src/pages/docs/[...slug].astro` to render the component instead of the markdown body.
