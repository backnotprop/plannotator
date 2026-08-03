# tabs

2026-07-07, transformation engine. Verdict: direct part renames, one flagged
behavior delta (activation mode), one flagged default delta (initial tab).

## Changed

- `packages/ui/components/ui/tabs.tsx` — `@radix-ui/react-tabs` →
  `@base-ui/react/tabs`. Part renames: `Trigger` → `Tab`, `Content` → `Panel`
  (public export names `TabsTrigger`/`TabsContent` kept). Active-state classes
  `data-[state=active]:*` → `data-active:*` (Base UI presence attribute).
  `data-[orientation=vertical]:flex-col` kept (same attribute both sides).
  `displayName` assignments switched to string literals (Base UI parts don't
  expose `.displayName`). File shape (forwardRef idiom) untouched.
  Leftover scan clean: `grep -n "radix-ui\|@radix-ui"` — no matches.

## Left alone

- Zero consumers in the repo (published export only); nothing to sweep.

## Behavior changes

- **Activation mode**: Radix activates a tab on arrow-key focus (automatic);
  Base UI 1.6.0 defaults to MANUAL activation (arrow keys move focus, Enter/
  Space activates). Matching the shadcn base registry, `activateOnFocus` was
  NOT added. Consumers wanting the old feel pass `<TabsList activateOnFocus>`.
- **Default active tab**: Radix has no default active tab (none selected until
  `value`/`defaultValue`); Base UI defaults to the first tab (value `0`).
  Only affects usage without `value`/`defaultValue`.
- `value` type widens `string` → `any`.

## Verify by hand

- Render a Tabs group with string values: correct panel shows, active tab gets
  the `bg-primary/10` treatment.
- Keyboard: arrow keys move focus between tabs; Enter/Space activates
  (manual mode — expected new behavior).
- Vertical orientation still stacks the list (`flex-col`).
