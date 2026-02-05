# UI Feature Testing Checklists

Use these checklists to verify features work correctly before submitting a PR.

## Table of Contents (TOC) Feature

The TOC sidebar provides navigation for long documents.

**Visual & Layout:**

- [ ] TOC visible on left sidebar on desktop (≥1024px width)
- [ ] TOC hidden on mobile/tablet (<1024px)
- [ ] Width is 240px on desktop
- [ ] Background: semi-transparent card with backdrop blur
- [ ] Border on right side separates TOC from content

**Hierarchy & Structure:**

- [ ] Shows H1-H3 headings in hierarchical structure
- [ ] H1 headings have no left indent
- [ ] H2 headings indented one level (pl-4)
- [ ] H3 headings indented two levels (pl-6)
- [ ] Nested items appear under parent headings

**Active Section Highlighting:**

- [ ] Active section highlights as you scroll
- [ ] Highlight uses primary color
- [ ] Left border (2px) appears on active item
- [ ] Background tint (primary/10) on active item
- [ ] Only one item active at a time

**Navigation:**

- [ ] Clicking TOC item scrolls smoothly to that section
- [ ] Scroll accounts for sticky header offset (no overlap)
- [ ] Smooth scroll animation (behavior: smooth)
- [ ] Navigation works for all heading levels

**Annotation Badges:**

- [ ] Annotation count badges show correct numbers
- [ ] Badges only appear when annotations exist in section
- [ ] Badge style: rounded-full with accent color
- [ ] Badge position: right side of TOC item

**Collapse/Expand:**

- [ ] Chevron button appears for headings with children
- [ ] Chevron rotates correctly (down = expanded, right = collapsed)
- [ ] Clicking chevron toggles child visibility
- [ ] Expand/collapse state persists while scrolling
- [ ] Multiple sections can be collapsed independently

**Interactions:**

- [ ] Hover state shows background change
- [ ] Long heading text wraps properly (line-clamp-2)
- [ ] Text remains readable when truncated
- [ ] Hover shows full text via title attribute (if truncated)

**Keyboard Navigation:**

- [ ] Tab key focuses TOC items
- [ ] Enter key navigates to section
- [ ] Space key also navigates to section
- [ ] Focus indicators visible on all items
- [ ] Chevron buttons keyboard accessible

**Scrolling & Performance:**

- [ ] TOC scrolls independently from main content
- [ ] Sticky positioning works (stays visible while scrolling)
- [ ] No horizontal scrollbar appears
- [ ] No lag with 100+ headings
- [ ] Active section updates smoothly while scrolling

## Annotation Features

**Text Selection & Toolbar:**

- [ ] Selecting text shows annotation toolbar
- [ ] Toolbar appears near selection (above or below)
- [ ] Toolbar has correct z-index (above other content)
- [ ] Toolbar shows all annotation type options

**Annotation Types:**

- [ ] **DELETION:** Red highlight, text appears crossed out in export
- [ ] **REPLACEMENT:** Shows old text → new text
- [ ] **COMMENT:** Comment bubble/tooltip appears
- [ ] **INSERTION:** New text shown at cursor position with insertion point
- [ ] **GLOBAL_COMMENT:** Accessible from sticky header button

**Annotation Panel:**

- [ ] Panel lists all annotations
- [ ] Annotations grouped correctly
- [ ] Can click annotation in panel to highlight in document
- [ ] Can edit annotation text
- [ ] Can delete annotations
- [ ] Deletion count shows in panel header

**Export & Formatting:**

- [ ] Export diff shows annotations in readable format
- [ ] Format follows: "- **DELETION** (line X): [original text]"
- [ ] Global comments appear at top of export
- [ ] All annotation types exported correctly

**Code Blocks:**

- [ ] Can annotate text in code blocks
- [ ] Code block annotations use manual mark wrapping
- [ ] Syntax highlighting preserved after annotation
- [ ] Multi-line code annotations work

**Images:**

- [ ] Can attach images to annotations
- [ ] Image annotation tools available (pen, arrow, circle)
- [ ] Annotated images display in review UI
- [ ] Can remove image attachments

## Sticky Header

**Position & Behavior:**

- [ ] Header stays at top while scrolling (position: sticky)
- [ ] Header has proper z-index (z-20)
- [ ] Header appears above content but below annotation toolbar (z-100)
- [ ] Sticky behavior works on all screen sizes

**Buttons & Controls:**

- [ ] Global comment button always accessible
- [ ] Global comment button opens annotation input
- [ ] Theme toggle works (dark/light/system)
- [ ] Mode switcher works (selection mode / redline mode)
- [ ] Share button generates valid URL
- [ ] Settings button opens modal
- [ ] All buttons have proper hover states

**Settings Modal:**

- [ ] Settings modal opens correctly
- [ ] Identity settings save (name/email)
- [ ] Plan save settings persist (enabled/path)
- [ ] Obsidian settings work (vault selection)
- [ ] Bear settings work (enable/disable)
- [ ] Settings persist across sessions (stored in cookies)

**Visual Polish:**

- [ ] Header background: semi-transparent with backdrop blur
- [ ] Border on bottom separates header from content
- [ ] Header height: 48px (h-12)
- [ ] Content doesn't overlap with header when scrolling

## Responsive Design

**Desktop (≥1024px):**

- [ ] TOC visible on left (240px width)
- [ ] Main content area uses remaining width
- [ ] Document centered with max-width constraint
- [ ] All buttons and controls accessible
- [ ] Layout doesn't feel cramped

**Tablet (768-1023px):**

- [ ] TOC hidden completely
- [ ] Document uses full width
- [ ] Touch targets sized appropriately
- [ ] No horizontal scrolling

**Mobile (<768px):**

- [ ] TOC hidden completely
- [ ] Content optimized for small screens
- [ ] Font sizes readable (not too small)
- [ ] Touch targets minimum 44x44px
- [ ] Buttons don't overlap
- [ ] Modal dialogs fit on screen
- [ ] No pinch-zoom required to read text

**General Responsive:**

- [ ] No horizontal scrolling on any screen size
- [ ] Touch gestures work (scroll, tap, swipe)
- [ ] Viewport meta tag configured correctly
- [ ] Layout reflows smoothly when resizing

## Accessibility

**Keyboard Navigation:**

- [ ] All interactive elements keyboard accessible (Tab, Enter, Space)
- [ ] Tab order logical (top to bottom, left to right)
- [ ] Escape key closes modals/dialogs
- [ ] Arrow keys work in appropriate contexts

**Focus Indicators:**

- [ ] Focus indicators visible on all interactive elements
- [ ] Focus indicator has sufficient contrast
- [ ] Focus indicator not hidden by CSS

**Screen Readers:**

- [ ] Headings announce with correct levels (H1, H2, H3)
- [ ] Links and buttons have descriptive labels
- [ ] Icon-only buttons have aria-label
- [ ] Images have alt text or aria-label
- [ ] Form inputs have associated labels

**ARIA Attributes:**

- [ ] `aria-current="location"` on active TOC item
- [ ] `aria-label` on icon-only buttons
- [ ] `aria-expanded` on collapsible elements
- [ ] `role="navigation"` on TOC (implicit with nav element)

**Color & Contrast:**

- [ ] Color contrast meets WCAG AA (4.5:1 for text, 3:1 for UI)
- [ ] Information not conveyed by color alone
- [ ] Links distinguishable from text (not just color)
- [ ] Dark mode has sufficient contrast

## Performance & Browser Compatibility

**Performance:**

- [ ] Large documents (100+ headings, 10+ pages) load quickly (<2s)
- [ ] Scrolling is smooth (60fps)
- [ ] No jank when highlighting active section
- [ ] Annotation creation is instant (no lag)
- [ ] No memory leaks (check DevTools Memory tab)
- [ ] Page load time acceptable (<3s on fast connection)

**Browser Compatibility:**

- [ ] Works in Chrome (latest)
- [ ] Works in Firefox (latest)
- [ ] Works in Safari (latest)
- [ ] Works in Edge (latest)
- [ ] Fallbacks for unsupported features (if any)
