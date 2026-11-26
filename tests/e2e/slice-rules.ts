/**
 * Which browser specs a change can break: the rules of the PR slice
 * (scripts/e2e-slice.ts, .github/workflows/e2e-slice.yml, issue #3455).
 *
 * A rule maps changed paths (globs from the repo root) to specs (globs of
 * file names under tests/e2e). A changed path picks every rule it matches;
 * a `fallback` rule counts only for a path no other rule matched. Spec globs
 * that match no spec today are fine: a rule may name a spec a pending PR adds.
 *
 * The slice is a net under a PR, not the proof: the whole suite still runs on
 * main every two hours (inbox-e2e.yml), and its blame job names the merge
 * that turned main red. Keep rules short and by name where the specs are
 * named by area; never list one spec per source file here.
 */

export interface SliceRule {
  /** What the rule covers, as the job summary names it. */
  name: string;
  /** Changed paths, as globs from the repo root. */
  paths: string[];
  /** Specs, as globs of file names under tests/e2e. */
  specs?: string[];
  /** The smoke sets (SLICE_SMOKE keys) this rule adds. */
  smoke?: string[];
  /** Counts only when the path's added or removed lines match this regex (a dependency bump in package.json or bun.lock). */
  lines?: string;
  /** Counts only for a path that no rule without `fallback` matched. */
  fallback?: boolean;
  /** Part of the hand-kept Inbox stopgap list (below). */
  stopgap?: boolean;
}

/**
 * Paths no browser spec can see: they select nothing and raise no notice.
 * Docs and the marketing site; unit and DOM test files (they change neither
 * the binary nor the built apps); the Pi extension and the OpenCode plugin
 * (the specs drive only the compiled Bun binary; test.yml runs the Pi mirrors).
 */
export const SLICE_NO_BROWSER: { paths: string[]; why: string }[] = [
  { paths: ['docs/**', '**/*.md', 'apps/marketing/**'], why: 'docs' },
  { paths: ['**/*.test.ts', '**/*.test.tsx', 'tests/dom-test-list.txt', 'tests/*.json'], why: 'unit and DOM tests' },
  { paths: ['tests/e2e/shard-times.json'], why: 'shard timing data' },
  { paths: ['apps/pi-extension/**', 'apps/opencode-plugin/**'], why: 'the specs drive only the compiled Bun binary' },
];

/**
 * Short, stable specs per app (1 to 3 each, from tests/e2e/shard-times.json),
 * for a change to code every app shares. The Inbox set leaves out
 * SMOKE_SPECS (scripts/ci-e2e-shard.ts): Browser smoke runs those on every PR.
 */
export const SLICE_SMOKE: Record<string, string[]> = {
  inbox: ['inbox-order.spec.ts', 'inbox-thread-foot.spec.ts', 'inbox-new-message.spec.ts'],
  review: ['review-file-list-stays-put.spec.ts', 'review-sidebar.spec.ts'],
  annotate: ['annotate-send-failure.spec.ts', 'config-file-render.spec.ts'],
  plan: ['plan-linked-doc-drafts.spec.ts', 'plan-lazy-chunk-failure.spec.ts'],
};
const ALL_APPS = Object.keys(SLICE_SMOKE);

/** A changed tests/e2e helper imported by more specs than this counts as shared harness: the smoke sets, not every importer. */
export const SLICE_HELPER_FANOUT = 25;

/**
 * Specs the slice leaves out whole, while main still runs them. Each entry
 * names its issue. Single flaky tests belong in tests/e2e/quarantine.json,
 * which CI leaves out everywhere, the slice included; this list is for a
 * spec that is flaky as a whole. Empty today.
 */
export const SLICE_QUARANTINE: { spec: string; issue: number; why: string }[] = [];

const REVIEW_SPECS = ['review-*.spec.ts', 'ref-cards-review.spec.ts', 'packed-page-load.spec.ts'];
const INBOX_REVIEW_SPECS = ['inbox-code-review.spec.ts', 'inbox-pull-requests.spec.ts'];

export const SLICE_RULES: SliceRule[] = [
  // --- Code review (the code review session's rows on #3455) ---
  {
    name: 'code review window',
    paths: [
      'packages/review-editor/**',
      'apps/review/**',
      'packages/shared/sem-diff*',
      'packages/shared/diff-*',
      'apps/hook/server/sem-diff.ts',
      'packages/server/review*.ts',
      'packages/server/git.ts',
      'packages/server/gitbutler.ts',
    ],
    specs: REVIEW_SPECS,
  },
  {
    name: 'code review window (a diff dependency bump)',
    paths: ['**/package.json', 'bun.lock'],
    lines: '@pierre/diffs|@pierre/trees|@plannotator/sem-jiff',
    specs: REVIEW_SPECS,
  },
  {
    // Not in the session's rows: the semantic diff engine and the vendored Pierre fork feed the same window.
    name: 'code review window (semantic diff engine, Pierre fork)',
    paths: ['packages/sem-diff/**', 'vendor/pierre-diffs/**', 'patches/@pierre*'],
    specs: REVIEW_SPECS,
  },
  {
    name: 'code review inside the Inbox',
    paths: [
      'packages/inbox/pulls/**',
      'packages/inbox/review-drawing/**',
      'packages/inbox/guide/**',
      'packages/inbox/diffOptions.ts',
      'packages/inbox/components/ReviewAnchorLine.tsx',
      'packages/server/inbox-code-review*',
      'packages/server/inbox-live-review*',
      'packages/server/inbox-diff-options.ts',
      'packages/shared/pr-*.ts',
    ],
    specs: INBOX_REVIEW_SPECS,
  },
  {
    name: 'pull request providers (Inbox pull request pages)',
    paths: ['packages/shared/pr-*.ts'],
    specs: ['inbox-pull-*.spec.ts'],
  },

  // --- Annotate and plan review ---
  {
    name: 'annotate',
    paths: ['packages/server/annotate*', 'packages/shared/annotate*', 'apps/hook/server/annotate*'],
    specs: ['annotate-*.spec.ts', 'config-file-render.spec.ts', 'session-title.spec.ts', 'folder-session-header.spec.ts', 'doc-badges-fit.spec.ts'],
  },
  {
    name: 'plan review and the document editor',
    paths: ['packages/editor/**', 'packages/shared/plan-review*', 'packages/server/draft.ts', 'packages/shared/draft.ts'],
    specs: ['plan-*.spec.ts', 'grid-paper-fill.spec.ts', 'image-region-comments.spec.ts', 'toolstrip-*.spec.ts', 'doc-badges-fit.spec.ts'],
  },

  // --- Smaller areas named by their specs ---
  { name: 'ref cards', paths: ['packages/server/ref-cards*', 'packages/shared/ref-cards*', 'packages/core/forge-ref*', 'packages/ui/components/RefHoverCard*', 'packages/ui/utils/refCard*', 'packages/inbox/pulls/refCardReviews*'], specs: ['ref-cards-review.spec.ts', 'inbox-ref-cards.spec.ts', 'inbox-open-in-refs.spec.ts', 'ref-card-click.spec.ts'] },
  { name: 'question card', paths: ['packages/ui/components/blocks/Question*', 'packages/ui/components/Question*'], specs: ['question-*.spec.ts'] },
  { name: 'chat window and Ask AI', paths: ['packages/ui/components/chat/**', 'packages/ai/**'], specs: ['chat-window.spec.ts', 'ask-ai-sanitize.spec.ts', 'annotate-ai-history.spec.ts'] },
  { name: 'Pele diagram labels', paths: ['packages/ui/utils/pele*', 'packages/ui/utils/diagram-anchor-pele.ts', 'packages/ui/utils/diagram-engine.ts', 'packages/ui/utils/diagram-render.ts'], specs: ['pele-labels.spec.ts'] },
  {
    // The switch decides which engine draws a fence in the built apps; these specs expect Pele where it draws and Mermaid where a fence falls back.
    name: 'diagram engine switch',
    paths: ['packages/ui/utils/diagram-engine.ts', 'packages/ui/utils/pele.ts'],
    specs: ['review-diagrams.spec.ts', 'inbox-mermaid-failure-webkit.spec.ts', 'inbox-thread-diagram-comments.spec.ts', 'vscode-guides-sanitize.spec.ts'],
  },
  { name: 'phone surface', paths: ['packages/inbox/surface/**'], specs: ['surface.spec.ts'] },
  {
    name: 'VS Code Guides webview',
    paths: ['apps/vscode-extension/src/guides/**', 'apps/vscode-extension/scripts/esbuild.config.ts', 'apps/vscode-extension/package.json'],
    specs: ['vscode-guides-*.spec.ts'],
  },
  {
    name: 'diagram engine (Mermaid, its math labels, the label sanitizer)',
    paths: ['packages/ui/utils/diagram-render.ts', 'packages/ui/utils/mermaid*.ts', 'packages/ui/utils/math*.ts'],
    specs: ['diagram-*.spec.ts', 'vscode-guides-sanitize.spec.ts'],
  },
  {
    name: 'packed pages and the build',
    paths: ['build/**', 'packages/shared/packed-app.ts', 'apps/hook/vite.config.ts'],
    specs: ['packed-page-*.spec.ts', 'plan-lazy-chunk-failure.spec.ts'],
    smoke: ALL_APPS,
  },
  {
    name: 'browser test harness',
    paths: [
      'tests/e2e/playwright.config.ts',
      'tests/e2e/global-setup.ts',
      'tests/e2e/agent-cli-stubs.ts',
      'tests/e2e/quarantine.ts',
      'tests/e2e/quarantine.json',
      'tests/e2e/slice-rules.ts',
      'scripts/e2e-slice.ts',
      'scripts/ci-e2e-*',
      '.github/workflows/e2e-slice.yml',
      '.github/workflows/inbox-e2e.yml',
      '.github/workflows/browser-smoke.yml',
    ],
    smoke: ALL_APPS,
  },

  // --- STOPGAP: the Inbox, by hand ---
  // The ten or so busiest areas of packages/inbox and packages/server/inbox*
  // (by commits since mid-October), each mapped to the specs that drive it,
  // read from the specs. Step 2 of #3455 replaces this list with a map the full
  // run on main derives from the source files each spec's page loads. Until
  // then keep it short; do not grow it into one row per file.
  {
    name: 'Inbox: agents, sessions and the reply recipient',
    stopgap: true,
    paths: [
      'packages/inbox/agents/**',
      'packages/inbox/agentsList.ts',
      'packages/inbox/sessionLabels.ts',
      'packages/inbox/sessionTitles.ts',
      'packages/inbox/components/*ReplyRecipient*',
      'packages/inbox/thread/recipientNames.ts',
      'packages/inbox/thread/useThreadSessions.ts',
      'packages/server/inbox-agents*',
      'packages/server/inbox-sessions*',
      'packages/server/inbox-first-seen*',
      'packages/server/inbox-agent-mark*',
      'packages/server/inbox-agent-status*',
      'packages/inbox/agents/agentStatus*',
      'packages/inbox/agents/AgentStatus*',
    ],
    specs: [
      'inbox-ended-session.spec.ts',
      'inbox-thread-sessions.spec.ts',
      'inbox-session-*.spec.ts',
      'inbox-agents.spec.ts',
      'inbox-agent-rename.spec.ts',
      'inbox-agent-status.spec.ts',
      'inbox-reply-foot-phone.spec.ts',
      'inbox-sidebar-spacing.spec.ts',
    ],
  },
  {
    name: 'Inbox: pull request pages',
    stopgap: true,
    paths: ['packages/inbox/prs/**', 'packages/inbox/threadPulls/**', 'packages/server/inbox-pull*', 'packages/server/inbox-machine-pulls*'],
    specs: ['inbox-pull-*.spec.ts', 'inbox-thread-pulls-*.spec.ts', 'inbox-bitbucket-pulls.spec.ts'],
  },
  {
    name: 'Inbox: compose and new message',
    stopgap: true,
    paths: ['packages/inbox/compose/**', 'packages/server/inbox-compose*'],
    specs: ['inbox-compose*.spec.ts', 'inbox-new-message.spec.ts', 'inbox-phone-compose-send.spec.ts', 'inbox-fullscreen-composer.spec.ts'],
  },
  {
    name: 'Inbox: launching agents',
    stopgap: true,
    paths: ['packages/server/inbox-launch*', 'packages/inbox/components/Launch*'],
    specs: ['inbox-launch-*.spec.ts', 'inbox-remote-launch-picker.spec.ts'],
  },
  { name: 'Inbox: board', stopgap: true, paths: ['packages/inbox/board/**'], specs: ['inbox-board*.spec.ts'] },
  {
    name: 'Inbox: machines, phones and accounts',
    stopgap: true,
    paths: [
      'packages/server/inbox-devices*',
      'packages/server/inbox-machines*',
      'packages/server/inbox-peer*',
      'packages/server/inbox-accounts*',
      'packages/server/inbox-cloud*',
      'packages/server/inbox-far-read*',
      'packages/server/inbox-machine-agent-read*',
      'packages/server/inbox-mcp-far-read*',
      'packages/server/inbox-machine-drafts*',
      'packages/server/inbox-reply-drafts-linked*',
      'packages/inbox/machineDrafts*',
      'packages/server/inbox-machine-fetch-file*',
      'apps/hook/server/inbox-call-far-fetch*',
      'packages/shared/inbox/saved-file*',
      'packages/inbox/data/machineViews*',
      'packages/inbox/cloud/**',
      'packages/server/inbox-scheduled-machines*',
      'packages/server/inbox-capability-set*',
      'packages/server/inbox-artifacts-merged*',
      'packages/server/inbox-machine-files*',
      'packages/inbox/linkedReads*',
    ],
    specs: ['inbox-machines.spec.ts', 'inbox-machine-update.spec.ts', 'inbox-phones.spec.ts', 'inbox-accounts*.spec.ts', 'inbox-snooze-machines.spec.ts', 'inbox-reply-drafts-machines.spec.ts', 'inbox-machines-agent-read.spec.ts', 'inbox-cloud-*.spec.ts', 'inbox-routines-machines.spec.ts', 'inbox-artifact-pins-machines.spec.ts', 'inbox-linked-reads-machines.spec.ts'],
  },
  { name: 'Inbox: guided reviews', stopgap: true, paths: ['packages/inbox/guide/**', 'packages/server/inbox-guides*'], specs: ['inbox-guides.spec.ts', 'inbox-request-guide.spec.ts'] },
  { name: 'Inbox: Ask window', stopgap: true, paths: ['packages/inbox/ask/**', 'packages/server/inbox-ask*'], specs: ['inbox-ask-window.spec.ts', 'inbox-reask.spec.ts'] },
  { name: 'Inbox: search', stopgap: true, paths: ['packages/inbox/search/**'], specs: ['inbox-search*.spec.ts', 'inbox-feedback-search*.spec.ts'] },
  {
    // Every Inbox spec reads the store and the server; these are the short ones that walk a message's life
    // (an agent writes through `plannotator inbox mcp`, the window shows, reads, archives, acks, replies, restarts).
    name: 'Inbox: the store, the server and the agents\' write path',
    stopgap: true,
    paths: ['packages/shared/inbox/**', 'packages/server/inbox.ts', 'packages/server/inbox-mcp*'],
    specs: [
      'inbox-order.spec.ts',
      'inbox-thread-foot.spec.ts',
      'inbox-refresh.spec.ts',
      'inbox-reply-drafts.spec.ts',
      'inbox-writes-after-restart.spec.ts',
      'inbox-archived.spec.ts',
      'inbox-mark-read.spec.ts',
      'inbox-ack.spec.ts',
      'inbox-new-message.spec.ts',
      'inbox-undelivered.spec.ts',
    ],
  },

  // --- Shared code: the smoke sets, for a path no rule above matched ---
  {
    name: 'Inbox (no closer rule)',
    fallback: true,
    paths: ['packages/inbox/**', 'apps/inbox/**', 'packages/server/inbox*', 'packages/shared/inbox/**', 'packages/core/inbox*', 'apps/hook/server/inbox*'],
    smoke: ['inbox'],
  },
  {
    name: 'shared code (no closer rule)',
    fallback: true,
    paths: [
      'packages/ui/**',
      'packages/shared/**',
      'packages/server/**',
      'packages/core/**',
      'packages/guide-viewer/**',
      // The system pane and CLI commands (packages/inbox/api.ts, apps/hook/server/cli.ts) and the T3 Code host.
      'packages/system/**',
      'packages/t3-code/**',
      'apps/hook/**',
      'package.json',
      'bun.lock',
      'patches/**',
    ],
    smoke: ALL_APPS,
  },
];
