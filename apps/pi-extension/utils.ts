/**
 * Plannotator Pi extension utilities.
 *
 * Inlined versions of bash safety checks and checklist parsing.
 * (No access to pi-mono's plan-mode/utils at runtime.)
 */

// ── Bash Safety ──────────────────────────────────────────────────────────

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i,
  /\btouch\b/i, /\bchmod\b/i, /\bchown\b/i, /\bchgrp\b/i, /\bln\b/i,
  /\btee\b/i, /\btruncate\b/i, /\bdd\b/i, /\bshred\b/i,
  /(^|[^<])>(?!>)/, />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i, /\bsu\b/i, /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
  /\breboot\b/i, /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
  /^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
  /^\s*grep\b/, /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/,
  /^\s*printf\b/, /^\s*wc\b/, /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/,
  /^\s*file\b/, /^\s*stat\b/, /^\s*du\b/, /^\s*df\b/, /^\s*tree\b/,
  /^\s*which\b/, /^\s*whereis\b/, /^\s*type\b/, /^\s*env\b/,
  /^\s*printenv\b/, /^\s*uname\b/, /^\s*whoami\b/, /^\s*id\b/,
  /^\s*date\b/, /^\s*cal\b/, /^\s*uptime\b/, /^\s*ps\b/,
  /^\s*top\b/, /^\s*htop\b/, /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i, /^\s*python\s+--version/i,
  /^\s*curl\s/i, /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/, /^\s*sed\s+-n/i, /^\s*awk\b/,
  /^\s*rg\b/, /^\s*fd\b/, /^\s*bat\b/, /^\s*exa\b/,
];

export function isSafeCommand(command: string): boolean {
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
  const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
  return !isDestructive && isSafe;
}

// ── Checklist Parsing ────────────────────────────────────────────────────

export interface ChecklistItem {
  /** 1-based step number, compatible with markCompletedSteps/extractDoneSteps. */
  step: number;
  text: string;
  completed: boolean;
}

/**
 * Parse standard markdown checkboxes from file content.
 *
 * Matches lines like:
 *   - [ ] Step description
 *   - [x] Completed step
 *   * [ ] Alternative bullet
 */
export function parseChecklist(content: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const pattern = /^[-*]\s*\[([ xX])\]\s+(.+)$/gm;

  for (const match of content.matchAll(pattern)) {
    const completed = match[1] !== " ";
    const text = match[2].trim();
    if (text.length > 0) {
      items.push({ step: items.length + 1, text, completed });
    }
  }
  return items;
}

// ── Progress Tracking ────────────────────────────────────────────────────

export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

export function markCompletedSteps(text: string, items: ChecklistItem[]): number {
  const doneSteps = extractDoneSteps(text);
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item) item.completed = true;
  }
  return doneSteps.length;
}
