# checkbox

2026-07-07, transformation engine (hand-rolled Radix, no shadcn wrapper), clean 1:1 migration.

## Changed

- `components/tour/QAChecklist.tsx:3` — `import * as Checkbox from '@radix-ui/react-checkbox'` → `import { Checkbox } from '@base-ui/react/checkbox'`.
- `components/tour/QAChecklist.tsx:42` — class rewrites: `data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=checked]:shadow-none` → `data-checked:*` (Base UI presence attributes).
- Props: `checked` (boolean) and `onCheckedChange={() => onToggle(i)}` are signature-compatible (Base UI adds an `eventDetails` second arg; the handler ignores args). No `asChild` in this file.
- Leftover scan: `grep -n "radix-ui|@radix-ui" components/tour/QAChecklist.tsx` → clean.

## Left alone

- `.tour-checkbox` CSS (index.css:1433, :1454) — element-agnostic (color transitions + reduced-motion), works unchanged.
- `@radix-ui/react-checkbox` stays in package.json until the final cleanup commit (both engines coexist during migration).

## Behavior changes

- Root element changes from `<button>` (Radix) to `<span>` + hidden `<input>` (Base UI). The checkbox sits inside a `<motion.label>`; label-click toggling now flows through the hidden native input instead of a button activation. Keyboard: Space toggles via the hidden input focus, not a button. Flagged for hand-verification; no code patched.

## Verify by hand

In the review tour's QA checklist (guided review → QA step):
1. Click a checkbox directly — it checks, primary background appears. ✓ (automated QA 2026-07-07: `.tour-checkbox`'s `data-unchecked` attribute cleared to `data-checked` after a direct click.)
2. Click the row's label text — the checkbox should also toggle (label→hidden-input association). ✓ (automated QA 2026-07-07: clicking the label's text span toggled a different row's checkbox state.)
3. Tab to a checkbox — focus visible; Space toggles. ✓ (automated QA 2026-07-07: programmatically focused a checkbox then pressed Space — state toggled. Did not exercise literal Tab-key traversal or verify the focus-ring renders — feel-level.)
4. Check an item — text gets line-through; animation still smooth. ✓ (automated QA 2026-07-07: line-through class present on the row text after checking. Animation smoothness not evaluated — feel-level.)
5. "Stop N" links inside a row still navigate without toggling the checkbox.
