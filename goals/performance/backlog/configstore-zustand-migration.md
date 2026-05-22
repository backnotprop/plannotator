# ConfigStore → Zustand Migration

## Problem

The hand-rolled configStore broadcasts to ALL 63 subscribers when ANY setting changes. When a user changes their display name, 12 hidden code review components re-render to check if their diff style changed. With 5 sessions, that's 52 wasted re-renders from a single setting change.

The configStore is a 129-line singleton with `Map<string, unknown>` for values and `Set<Listener>` for subscribers. The `notify()` method iterates through every listener on every write — no selectivity. `useSyncExternalStore` in the `useConfigValue` hook does compare snapshots, but the notification itself triggers the comparison in every subscriber.

## Current Architecture

```
configStore.set('displayName', 'John')
  → toCookie('John')           // immediate
  → pendingServerWrites.merge() // queue
  → notify()                    // calls ALL 63 listeners
    → 12 hidden review components run getSnapshot()
    → 4 hidden plan components run getSnapshot()
    → 11 active components run getSnapshot()
    → React reconciles 63 components (most bail with same value)
```

## Target Architecture

```
configStore.set('displayName', 'John')
  → Zustand set({ displayName: 'John' })
  → Zustand notifies only subscribers of displayName
    → 2 components subscribed to displayName re-render
    → 61 other components not notified at all
```

## What Stays the Same

- **15 settings** with the same names, types, defaults
- **Cookie persistence** — immediate write on every change
- **Server sync** — debounced POST /api/config at 300ms
- **init(serverConfig)** — server values override cookies on session load
- **All consumer call sites** — `useConfigValue('diffStyle')` becomes `useConfigStore(s => s.diffStyle)`, same usage pattern

## Implementation

### Phase 1: Create Zustand store with middleware

Replace `packages/ui/config/configStore.ts` (129 lines) with a Zustand store:

```typescript
const useConfigStore = create<ConfigState>()(
  immer((set, get) => ({
    // 15 settings as flat properties
    displayName: fromCookieOrDefault('displayName'),
    diffStyle: fromCookieOrDefault('diffStyle'),
    // ...etc

    set: (key, value) => {
      set(state => { state[key] = value; });
      toCookie(key, value);
      queueServerSync(key, value);
    },

    init: (serverConfig) => {
      set(state => {
        // Apply server overrides via immer
        for (const [key, def] of entries) {
          const val = def.fromServer(serverConfig);
          if (val !== undefined) state[key] = val;
        }
      });
    },
  }))
);
```

The `queueServerSync` function maintains the same 300ms debounce + batch merge + `apiFetch('/api/config')` pattern.

### Phase 2: Update useConfigValue hook

```typescript
// Before:
export function useConfigValue<K>(key: K) {
  return useSyncExternalStore(configStore.subscribe, () => configStore.get(key));
}

// After:
export function useConfigValue<K>(key: K) {
  return useConfigStore(s => s[key]);
}
```

Same API, same return type. Consumers don't change their call signature.

### Phase 3: Migrate 17 consumer files

Mechanical find-and-replace:
- `configStore.set('diffStyle', v)` → `useConfigStore.getState().set('diffStyle', v)` (or keep `configStore.set` as an alias)
- `configStore.get('diffStyle')` → `useConfigStore.getState().diffStyle`
- `configStore.init(cfg)` → `useConfigStore.getState().init(cfg)`

Most consumers only use `useConfigValue` (the hook) — those just need the import path updated.

## Files to Touch

**Core (rewrite):**
1. `packages/ui/config/configStore.ts` — full rewrite
2. `packages/ui/config/useConfig.ts` — simplify to Zustand selector
3. `packages/ui/config/index.ts` — update exports

**Consumers (mechanical):**
4-20. 17 files across packages/ui/, plannotator-code-review/, plannotator-plan-review/, review-editor/, editor/ — change import + hook signature

## Effort

| Task | Time |
|------|------|
| Zustand store + cookie middleware + server sync | 2-3 hours |
| useConfigValue hook update | 15 minutes |
| Migrate 17 consumer files | 1 hour |
| Test cookie ↔ server ↔ init round-trip | 1-2 hours |
| **Total** | **5-7 hours** |

## Risk

Low. This is a state management swap with identical external behavior. All 15 settings, cookie persistence, server sync timing, and init() semantics remain the same. The only change is notification granularity — from broadcast-all to selector-based. Zustand is already a dependency in the frontend app (used by appStore, projectStore, eventStore).

## Result

- Setting change notifies only subscribers of that setting, not all 63
- Hidden sessions with 12 subscriptions get zero wasted re-renders
- `immer` middleware eliminates the hand-rolled `deepMerge` helper
- Consistent with the rest of the frontend app (all stores are Zustand)
