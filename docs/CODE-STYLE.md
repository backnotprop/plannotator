# Code Style Guide

This guide documents the coding standards and conventions used in Plannotator. Following these guidelines ensures consistency and maintainability.

## Table of Contents

1. [TypeScript Guidelines](#typescript-guidelines)
2. [React Patterns](#react-patterns)
3. [Tailwind CSS](#tailwind-css)
4. [File Naming Conventions](#file-naming-conventions)
5. [Component Structure Template](#component-structure-template)
6. [Commit Message Format](#commit-message-format)

---

## TypeScript Guidelines

### Strict Mode

TypeScript strict mode is enabled in this project. Always use explicit types.

### Type Annotations

**Do:** Provide explicit types for function parameters and return values

```typescript
function calculateAnnotationCount(blocks: Block[]): number {
  return blocks.filter(b => b.type === 'heading').length;
}
```

**Don't:** Rely on type inference for function signatures

```typescript
function calculateAnnotationCount(blocks) {  // ❌ No type
  return blocks.filter(b => b.type === 'heading').length;
}
```

### Avoid `any`

**Do:** Use specific types or `unknown` when type is truly unknown

```typescript
interface ApiResponse {
  data: unknown;
  error?: string;
}
```

**Don't:** Use `any` as a shortcut

```typescript
function handleData(data: any) {  // ❌ Avoid any
  // ...
}
```

### Interface Usage

**Do:** Define interfaces for component props and complex data structures

```typescript
interface TableOfContentsProps {
  blocks: Block[];
  annotations: Annotation[];
  activeId: string | null;
  onNavigate: (blockId: string) => void;
}
```

**Do:** Use `type` for unions, intersections, and utility types

```typescript
type AnnotationType = 'DELETION' | 'REPLACEMENT' | 'COMMENT' | 'INSERTION';
type BlockWithAnnotations = Block & { annotationCount: number };
```

### Null vs Undefined

**Prefer:** `null` for intentional absence, `undefined` for uninitialized

```typescript
const [activeId, setActiveId] = useState<string | null>(null);  // ✓
const [data, setData] = useState<Data>();  // undefined initially ✓
```

---

## React Patterns

### Functional Components

Use functional components with hooks exclusively. Class components are not used in this codebase.

```typescript
export function MyComponent({ prop1, prop2 }: MyComponentProps) {
  // Component logic
  return <div>...</div>;
}
```

### Props Interface Naming

Name props interfaces with the pattern `ComponentNameProps`:

```typescript
interface TableOfContentsProps {
  blocks: Block[];
  onNavigate: (blockId: string) => void;
}

export function TableOfContents({ blocks, onNavigate }: TableOfContentsProps) {
  // ...
}
```

### Hook Ordering

Order hooks consistently:

1. Context hooks (`useContext`)
2. State hooks (`useState`)
3. Ref hooks (`useRef`)
4. Effect hooks (`useEffect`)
5. Memoization (`useMemo`, `useCallback`)
6. Custom hooks

```typescript
export function MyComponent({ data }: MyComponentProps) {
  const theme = useContext(ThemeContext);        // 1. Context
  const [count, setCount] = useState(0);         // 2. State
  const inputRef = useRef<HTMLInputElement>(null); // 3. Refs
  
  useEffect(() => {                              // 4. Effects
    // Side effect
  }, [data]);
  
  const processedData = useMemo(() => {          // 5. Memoization
    return data.map(item => transform(item));
  }, [data]);
  
  const handleClick = useCallback(() => {
    setCount(c => c + 1);
  }, []);
  
  return <div>...</div>;
}
```

### Memoization

**Use `useMemo`** for expensive computations:

```typescript
const tocHierarchy = useMemo(
  () => buildTocHierarchy(blocks, annotationCounts),
  [blocks, annotationCounts]
);
```

**Use `useCallback`** for event handlers passed as props:

```typescript
const handleNavigate = useCallback(
  (blockId: string) => {
    onNavigate(blockId);
    scrollToBlock(blockId);
  },
  [onNavigate]
);
```

**Don't overuse:** Only memoize when there's a clear performance benefit.

### Conditional Rendering

**Prefer:** Ternary or logical AND for simple conditions

```typescript
// Ternary for if/else
{isLoading ? <Spinner /> : <Content />}

// Logical AND for conditional render
{error && <ErrorMessage error={error} />}
```

**Use early returns** for complex conditions:

```typescript
function MyComponent({ data }: Props) {
  if (!data) {
    return <EmptyState />;
  }
  
  if (data.length === 0) {
    return <EmptyList />;
  }
  
  return <DataList items={data} />;
}
```

---

## Tailwind CSS

### Utility-First Approach

Use Tailwind utility classes directly in JSX:

```typescript
<div className="flex items-center justify-between p-4 bg-card rounded-lg border border-border">
  <span className="text-sm font-medium">Title</span>
  <button className="px-3 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90">
    Action
  </button>
</div>
```

### Responsive Modifiers

Use responsive prefixes for breakpoint-specific styles:

```typescript
<aside className="
  hidden           
  lg:block         
  lg:w-60          
  sticky           
  top-12           
  h-[calc(100vh-3rem)]
">
  {/* Sidebar content */}
</aside>
```

**Breakpoints:**
- `sm:` - 640px
- `md:` - 768px
- `lg:` - 1024px
- `xl:` - 1280px
- `2xl:` - 1536px

### Dark Mode

Use the `dark:` prefix for dark mode styles:

```typescript
<div className="bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">
  Dark mode ready!
</div>
```

### State Variants

Use state variants for interactive elements:

```typescript
<button className="
  bg-primary 
  hover:bg-primary/90 
  active:bg-primary/80
  focus:ring-2 
  focus:ring-primary 
  focus:ring-offset-2
  disabled:opacity-50 
  disabled:cursor-not-allowed
">
  Click me
</button>
```

### Custom CSS (Use Sparingly)

**Prefer Tailwind** utilities over custom CSS. Only use custom CSS for:
- Complex animations
- Global styles
- Patterns not expressible with utilities

If you must use custom CSS, use `@apply` in CSS files:

```css
.custom-button {
  @apply px-4 py-2 bg-primary text-white rounded hover:bg-primary/90;
}
```

### Conditional Classes

Use template literals for conditional classes:

```typescript
<div className={`
  p-4 rounded
  ${isActive ? 'bg-primary text-white' : 'bg-muted text-foreground'}
  ${isDisabled && 'opacity-50 cursor-not-allowed'}
`}>
  Content
</div>
```

Or use a helper function for complex logic:

```typescript
import { clsx } from 'clsx';

<div className={clsx(
  'p-4 rounded',
  isActive && 'bg-primary text-white',
  !isActive && 'bg-muted text-foreground',
  isDisabled && 'opacity-50'
)}>
  Content
</div>
```

---

## File Naming Conventions

### Components

Use **PascalCase** for component files:

```
TableOfContents.tsx
AnnotationPanel.tsx
ConfirmDialog.tsx
```

### Utilities

Use **camelCase** for utility files:

```
annotationHelpers.ts
parser.ts
storage.ts
sharing.ts
```

### Hooks

Use **camelCase** with `use` prefix:

```
useActiveSection.ts
useSharing.ts
useAgents.ts
```

### Types

Type-only files use **camelCase** with `.d.ts` or placed in main file:

```
types.ts
index.d.ts
```

### Constants

Use **UPPER_SNAKE_CASE** for constant values:

```typescript
export const MAX_ANNOTATION_LENGTH = 1000;
export const DEFAULT_PORT = 19432;
export const CUSTOM_PATH_SENTINEL = '__CUSTOM__';
```

### Test Files

Use `.test.ts` or `.spec.ts` suffix:

```
annotationHelpers.test.ts
parser.spec.ts
```

---

## Component Structure Template

Use this template for new components:

```typescript
// 1. Imports - External libraries first, then internal
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { Block, Annotation } from '../types';
import { buildHierarchy } from '../utils/helpers';

// 2. Props interface - Define props type
interface MyComponentProps {
  blocks: Block[];
  annotations: Annotation[];
  onNavigate: (id: string) => void;
  className?: string;  // Optional props use ?
}

// 3. Helper interfaces/types (if needed)
interface InternalState {
  expanded: boolean;
  selectedId: string | null;
}

// 4. Main component - Named export
export function MyComponent({ 
  blocks, 
  annotations, 
  onNavigate,
  className = ''  // Default values in destructure
}: MyComponentProps) {
  // 5. Hooks - Ordered by type (state, refs, effects, memoization)
  const [state, setState] = useState<InternalState>({
    expanded: true,
    selectedId: null,
  });
  
  const containerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    // Side effects
  }, [blocks]);
  
  const hierarchy = useMemo(
    () => buildHierarchy(blocks, annotations),
    [blocks, annotations]
  );
  
  // 6. Event handlers - Use useCallback for handlers passed as props
  const handleClick = useCallback((id: string) => {
    setState(prev => ({ ...prev, selectedId: id }));
    onNavigate(id);
  }, [onNavigate]);
  
  // 7. Helper functions - Local functions don't need useCallback
  const isSelected = (id: string) => state.selectedId === id;
  
  // 8. Early returns for special cases
  if (blocks.length === 0) {
    return <div>No content</div>;
  }
  
  // 9. Main render
  return (
    <div ref={containerRef} className={`container ${className}`}>
      {hierarchy.map(item => (
        <div 
          key={item.id}
          onClick={() => handleClick(item.id)}
          className={isSelected(item.id) ? 'selected' : ''}
        >
          {item.content}
        </div>
      ))}
    </div>
  );
}

// 10. Sub-components (if small and only used here)
function SubComponent({ data }: { data: string }) {
  return <span>{data}</span>;
}
```

### Key Points

- **Named exports** for components (not default exports)
- **Props destructuring** in function signature
- **Optional props** use `?` and provide defaults
- **Memoization** only when needed for performance
- **Event handlers** use arrow functions or useCallback
- **Early returns** for edge cases before main render

---

## Commit Message Format

### Conventional Commits

Use conventional commits format when possible:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only
- `style:` - Code style (formatting, missing semicolons, etc.)
- `refactor:` - Code refactoring
- `perf:` - Performance improvement
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks (build, deps, etc.)

### Examples

**Feature:**
```
feat: add table of contents sidebar

- Shows H1-H3 headings hierarchically
- Active section highlighting with scroll tracking
- Smooth scroll navigation
- Annotation count badges per section
```

**Bug Fix:**
```
fix: correct TOC scroll offset for sticky header

Previously TOC navigation would scroll sections under the sticky header.
Now accounts for 80px offset to show section at proper position.
```

**Documentation:**
```
docs: add UI testing guide

Includes:
- Development setup instructions
- Feature testing checklists
- Common debugging tips
```

**Refactor:**
```
refactor: extract annotation counting logic

Move annotation count calculation to annotationHelpers.ts for reuse
in TOC and annotation panel components.
```

### Guidelines

**Do:**
- Use present tense ("add feature" not "added feature")
- Use imperative mood ("move cursor" not "moves cursor")
- Keep first line under 72 characters
- Capitalize first letter after type
- No period at end of first line
- Add body for complex changes

**Don't:**
- Don't use vague descriptions ("fix bug", "update code")
- Don't include issue numbers in first line (put in body/footer)
- Don't make massive commits (break into logical pieces)

---

## Questions?

If something isn't covered here:

1. Look at existing code for patterns
2. Check `CLAUDE.md` for architecture details
3. Ask in your PR for clarification
4. Suggest updates to this guide via PR
