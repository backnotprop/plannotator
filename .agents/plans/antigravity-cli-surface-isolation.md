# Implementation Plan - Antigravity CLI Surface Isolation & Deterministic Gating

## Overview
Implement strict, unconditional hook runtime gating in `apps/hook/server/antigravity-plan.ts` so that Plannotator operates **exclusively for Antigravity CLI (`agy`)**, immediately and silently abstaining when called from **Antigravity 2.0 Desktop** or **Antigravity IDE**.

This work builds directly on top of the rebased `feat/antigravity-support` branch (tracking `ykalani:agy-support-added` at `c5290254`), with changes cleanly committed as a new commit, verified with unit tests, and installed onto the local system.

---

## 1. Branch & Collaboration Context
- Current branch: `feat/antigravity-support` (identical to `ykalani/agy-support-added` at `c5290254`).
- No branch switching or rebasing needed; we commit directly as the newest commit on this branch.
- Push commands will be provided to the user upon completion:
  ```bash
  git push ykalani feat/antigravity-support:agy-support-added
  git push origin feat/antigravity-support
  ```

---

## 2. Deterministic CLI-Only Gating Mechanism

Plannotator will be strictly and unconditionally exclusive to `antigravity-cli`.

### A. Strict CLI Detection (`apps/hook/server/antigravity-plan.ts`)
```ts
export function isAntigravityCliEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  const artifactDir = typeof event.artifactDirectoryPath === "string" ? event.artifactDirectoryPath : "";
  const transcript = typeof event.transcriptPath === "string" ? event.transcriptPath : "";
  return artifactDir.includes("antigravity-cli") || transcript.includes("antigravity-cli");
}
```

### B. Entrypoint Enforcement
1. **In `getAntigravityPlan(event)`**:
   ```ts
   if (!isAntigravityCliEvent(event)) {
     return null; // Immediately abstain: pass write through without launching Plannotator
   }
   ```
2. **In `getAntigravityPlanningLockDenial(event)`**:
   ```ts
   if (!isAntigravityCliEvent(event)) {
     return null; // Immediately abstain: never block source files in 2.0 or IDE
   }
   ```

### C. Guaranteed Runtime Behavior
- **In Antigravity CLI (`agy`)**: Full Plannotator review experience (browser launch, Mermaid diagrams, clean/raw diffs, line-by-line annotations, deterministic workspace planning lock).
- **In Antigravity 2.0 Desktop & Antigravity IDE**: The hook checks `artifactDirectoryPath` (which contains `antigravity` or `antigravity-ide`), sees it is not `antigravity-cli`, and immediately exits with `{ "decision": "allow" }` (or `{}` abstain) in under 2ms. No browser launches, no planning lock is set, and native planning operates completely untouched.

---

## 3. Test Suite Verification (`apps/hook/server/antigravity-plan.test.ts`)

Add tests verifying strict surface isolation:
1. **Antigravity CLI Event**:
   - Given `artifactDirectoryPath: "C:\\Users\\dell\\.gemini\\antigravity-cli\\brain\\123"`
   - `getAntigravityPlan` returns full plan content for review.
   - `getAntigravityPlanningLockDenial` blocks code file writes when a plan is under review or denied.
2. **Antigravity 2.0 Desktop Event**:
   - Given `artifactDirectoryPath: "C:\\Users\\dell\\.gemini\\antigravity\\brain\\123"`
   - `getAntigravityPlan` returns `null` (abstains).
   - `getAntigravityPlanningLockDenial` returns `null` (abstains).
3. **Antigravity IDE Event**:
   - Given `artifactDirectoryPath: "C:\\Users\\dell\\.gemini\\antigravity-ide\\brain\\123"`
   - `getAntigravityPlan` returns `null` (abstains).
   - `getAntigravityPlanningLockDenial` returns `null` (abstains).

---

## 4. Local Build & System Installation
After tests pass:
1. Rebuild the Plannotator binary and bundle:
   ```bash
   bun run build
   ```
2. Install the updated binary and plugin on the local system:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/install.ps1
   ```
3. Verify installed plugin integrity:
   ```bash
   agy plugin validate apps/antigravity
   ```
4. Commit changes:
   ```bash
   git commit -m "feat(antigravity): isolate planning hook to Antigravity CLI"
   ```
