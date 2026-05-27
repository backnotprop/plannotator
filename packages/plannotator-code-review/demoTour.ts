/**
 * Demo tour data for development mode.
 *
 * Loaded by useTourData when jobId === DEMO_TOUR_ID, so the dialog renders
 * with realistic content without needing an agent run. Toggle via the dev-only
 * floating button in App.tsx (only shown when import.meta.env.DEV is true).
 */

import type { CodeTourData } from './hooks/tour/useTourData';

export const DEMO_TOUR_ID = 'demo-tour';

const buttonHunk = `@@ -1,15 +1,22 @@
-import React from 'react';
+import React, { useCallback } from 'react';

 interface ButtonProps {
   label: string;
   onClick: () => void;
+  disabled?: boolean;
+  variant?: 'primary' | 'secondary';
 }

-export const Button = ({ label, onClick }: ButtonProps) => {
+export const Button = ({ label, onClick, disabled, variant = 'primary' }: ButtonProps) => {
+  const handleClick = useCallback(() => {
+    if (!disabled) onClick();
+  }, [disabled, onClick]);
+
   return (
-    <button onClick={onClick}>
+    <button onClick={handleClick} disabled={disabled} className={variant}>
       {label}
     </button>
   );
 };`;

const authHunk = `@@ -42,7 +42,7 @@ export class AuthService {
   async createSession(userId: string): Promise<Session> {
     const token = await generateToken(userId);
-    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
+    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
     return this.store.create({ userId, token, expiresAt });
   }`;

const retryHunk = `@@ -1,5 +1,18 @@
 export async function fetchWithRetry(url: string, opts?: RequestInit) {
-  return fetch(url, opts);
+  let attempt = 0;
+  let lastErr: unknown;
+  while (attempt < 3) {
+    try {
+      const res = await fetch(url, opts);
+      if (res.ok || res.status < 500) return res;
+      lastErr = new Error(\`HTTP \${res.status}\`);
+    } catch (err) {
+      lastErr = err;
+    }
+    await new Promise(r => setTimeout(r, 200 * 2 ** attempt));
+    attempt++;
+  }
+  throw lastErr;
 }`;

export const DEMO_TOUR: CodeTourData = {
  title: 'Tighten auth + harden network calls',
  greeting:
    "Hey — okay, so this PR does three related things: it tightens the auth session lifetime from a week down to 24 hours, gives every network call a retry budget with exponential backoff, and finally fixes that Button component that's been silently ignoring its disabled prop for the last six months. Grab a coffee — I'll walk you through it in the order I'd actually want to read it.",
  intent:
    'Closes SEC-412, the overly-permissive session TTL flagged by the security team during the Q1 audit. Also lays groundwork for the offline-first work shipping next sprint, which depends on the network layer being resilient to transient failures. The Button fix is opportunistic — once we were touching the auth refresh flow, we noticed the Button on the login page had been masking its disabled state, which is how we ended up with the duplicate-submit bug from #412.',
  before:
    'Sessions lasted 7 days with no refresh contract, network calls failed hard on the first 5xx, and the Button component would happily fire onClick even when disabled was true at the prop level.',
  after:
    'Sessions expire in 24h with a clean refresh path, network calls retry up to 3 times with exponential backoff (200ms, 400ms, 800ms), and Button now respects disabled at both the prop and the underlying DOM element so the browser also blocks the click.',
  key_takeaways: [
    {
      text: 'Session TTL dropped from 7 days to 24 hours — every active session pre-deploy will be invalidated. Coordinate the deploy with a maintenance window or expect a flood of re-auth events at deploy time.',
      severity: 'warning',
    },
    {
      text: 'Mobile clients that polled session/refresh every 6 hours need to drop to every 15 minutes. The mobile team has a separate PR (#418) that ships at the same time. Do NOT merge this without that one.',
      severity: 'warning',
    },
    {
      text: 'New retry logic uses exponential backoff (200ms, 400ms, 800ms). Worst-case latency for a fully-failing endpoint is now ~1.4s before throwing instead of immediate failure — make sure no UI is blocking on these calls without a loading state.',
      severity: 'important',
    },
    {
      text: 'Retries happen on 5xx and thrown network errors only. 4xx responses still return immediately because they represent client errors, not transient failures.',
      severity: 'important',
    },
    {
      text: 'Button now memoizes its click handler with useCallback and respects disabled at the DOM level. Existing callsites are source-compatible — no migration needed.',
      severity: 'info',
    },
    {
      text: 'The auth.ts changes touch the same lines as the in-flight refactor on PR #401. Expect a merge conflict; the resolution is mechanical (both branches just renamed the constant).',
      severity: 'info',
    },
    {
      text: 'No new dependencies. No schema changes. No new feature flags. Pure behavior + API tightening.',
      severity: 'info',
    },
  ],
  stops: [
    {
      title: 'Auth session lifetime cut from 7 days to 24 hours',
      gist: 'Single line change in AuthService.createSession — but every active session gets invalidated on deploy.',
      detail: `The session TTL is now 86,400,000 ms (24h) instead of 604,800,000 ms (7 days). This is the line the security audit flagged.

> [!IMPORTANT]
> Every existing session token in the database has a stored expiresAt based on the old 7-day window. New sessions issued after deploy will use the 24h window. We are NOT retroactively shortening existing tokens — we're letting them expire naturally.

### What to verify
- The session refresh flow handles the shorter window gracefully (users on the app continuously for >24h need a silent re-auth)
- Mobile clients should already poll \`/api/session/refresh\` every 15 min; confirm that's still the case`,
      transition: 'With shorter sessions, clients refresh more often — which makes the network layer the next thing to harden.',
      anchors: [
        {
          file: 'src/services/auth.ts',
          line: 42,
          end_line: 48,
          hunk: authHunk,
          label: 'TTL constant change in createSession',
        },
      ],
    },
    {
      title: 'Network calls now retry on 5xx and network errors',
      gist: 'fetchWithRetry wraps fetch with up to 3 attempts and exponential backoff (200ms, 400ms, 800ms).',
      detail: `Before, any 5xx or thrown error bubbled up immediately. Now we retry up to 3 times with exponential backoff before giving up.

### Behavior matrix
- 2xx / 4xx → return immediately (no retry on client errors)
- 5xx → retry up to 3x
- Thrown errors (network down) → retry up to 3x
- All retries exhausted → throw the last error

### Worst case
A consistently failing endpoint takes 1.4s before throwing (200 + 400 + 800 = 1400ms of backoff). Make sure no UI is blocking on these calls without a loading state.`,
      transition: 'The retry budget makes the auth refresh more reliable — closing the loop on the shorter session window.',
      anchors: [
        {
          file: 'src/lib/fetchWithRetry.ts',
          line: 1,
          end_line: 18,
          hunk: retryHunk,
          label: 'Retry loop with exponential backoff',
        },
      ],
    },
    {
      title: 'Button component: disabled, variant, memoized handler',
      gist: 'Pure additive API change — existing callsites unchanged, but Button now respects disabled at both prop and DOM level.',
      detail: `Three things happen here:

- New optional \`disabled\` prop, applied to both the underlying \`<button>\` element and gated in the click handler
- New optional \`variant\` prop (\`'primary' | 'secondary'\`, defaults to \`'primary'\`)
- Click handler wrapped in useCallback with proper dependency array

> [!NOTE]
> The double-gating on disabled (both DOM attribute AND handler check) is intentional — it prevents a click that lands during the brief window between disabled becoming true and React flushing the DOM update.`,
      transition: '',
      anchors: [
        {
          file: 'src/components/Button.tsx',
          line: 1,
          end_line: 22,
          hunk: buttonHunk,
          label: 'Button props + memoized handler',
        },
      ],
    },
  ],
  qa_checklist: [
    {
      question: 'Does the session refresh flow handle the new 24h window without forcing users to re-login mid-session?',
      stop_indices: [0],
    },
    {
      question: 'Are all network call sites resilient to the new 1.4s worst-case latency (no UI blocking without loading state)?',
      stop_indices: [1],
    },
    {
      question: 'Is the deploy coordinated with a maintenance window or comms to active users?',
      stop_indices: [0],
    },
    {
      question: 'Does Button still render correctly at every existing callsite (no breaking prop changes)?',
      stop_indices: [2],
    },
    {
      question: 'Are there metrics/alerts in place to detect if the retry budget is being exhausted in production?',
      stop_indices: [1],
    },
  ],
  checklist: [],
};
