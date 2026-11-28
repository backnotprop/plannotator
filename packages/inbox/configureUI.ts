/**
 * The window's settings for the document UI it reuses (@plannotator/ui), set once when the window loads, before the
 * first render. Imported by App.tsx for this alone.
 */
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { inboxApi, REF_CARD_READ_MS, signalWithin } from './api';
import { createInboxCodeHighlightWorker } from './codeHighlightWorker';
import { inboxImageSrcResolver } from './images';
import { inboxUrl } from './inboxUrl';
import { installLinearCards } from './linearCards';
import { inboxRefTransport } from './refTransport';
import { applyRememberedTextSize } from './textSize';
import { inboxServerSync } from './theme';

// The Inbox has no /api/config and no browser-agent tools: settings stay in
// the page's own cookies, except the theme, which goes to config.json `theme`
// through the Inbox's settings route so plan review follows it (theme.ts).
// WebMCP is off.
// No image uploads either: a comment's image would need an upload route the
// Inbox does not have, so the composer says so instead of posting nowhere.
// The text size this browser last showed, on the document before the first render (textSize.ts).
applyRememberedTextSize();

configurePlannotatorUI({
  serverSync: inboxServerSync,
  // ui's own hover text (annotation panel and toolbar, question cards, links to attachments) as ui's Tooltip,
  // never a native title (the owner, 2026-10-17).
  componentTooltips: true,
  // A digit-only #186379 in a message is a PR or issue of the project's repo, not a colour (#1932).
  digitHexIssueRefs: true,
  // An owner/repo#123 links even in a project with no git origin (no repo of its own to link bare #123 into):
  // agents are told to write that form for another repo's PR or issue. github.com until the first list read, then
  // the host most projects use (defaultRefHost.ts, from api.ts).
  crossRepoRefsWithoutRepo: true,
  // ui marks <body data-pn-popout> while a popout is open and <html data-pn-selection-chooser> while the diff's
  // selection chooser shows; the window's build keys theme.css's and comments.css's body:has() / html:has() on them
  // (build/inbox-page-marks.ts: each such :has() cost a style pass over the whole page on every DOM change).
  pageMarks: true,
  // The selection toolbar's Copy copies rich text, in messages and attached files (#1972).
  richCopy: true,
  // The comment box is the small card by the words (approval "inbox-comment-box", round 3; apps/inbox/index.css
  // imports its sheet). Docked, it spans the pane the words are in and never covers the pane's reply bar or box.
  commentCard: { pane: '.ib-fullview, [data-attachment-pane], section.ib-pane', foot: '.ib-pfoot, .ib-fcomp, [data-file-foot]' },
  // A comment closed with words keeps them highlighted, with a "Draft" badge that opens it again.
  visibleCommentDrafts: true,
  // On a phone the selection toolbar sits below the selection, clear of iOS's own edit menu, inside the screen,
  // with thumb-sized buttons (utils/touchToolbarPlacement).
  touchSelectionToolbar: true,
  // Hover cards for issue, PR and MR links: the server fetches with this computer's gh or glab, and Bitbucket Cloud
  // pull requests with the review app's Bitbucket token (ref-cards.ts). Given up after REF_CARD_READ_MS (the card then shows what the Inbox knows), so no read holds a connection for good.
  refCardBitbucket: true,
  // A click on a #12, an owner/repo#12 or a pasted PR / issue URL in the words opens its card pinned (utils/refCardClick).
  refCardClick: true,
  refCardTransport: inboxRefTransport((href, signal) => {
    const within = signalWithin(REF_CARD_READ_MS, signal);
    return fetch(inboxUrl(`/ref?url=${encodeURIComponent(href)}`), { signal: within.signal, headers: { accept: 'application/json' } }).finally(within.done);
  }),
  // Images in a message load from the Inbox's per-message route (#1813).
  imageSrcResolver: inboxImageSrcResolver,
  // A long thread can hold hundreds of code fences: each is highlighted when it comes near the screen (before it
  // shows) and the rest in idle time, not all at once when the thread opens (utils/codeHighlight).
  deferOffscreenCodeHighlight: true,
  // Their tokens are made in a Web Worker; the page only writes the markup (codeHighlightWorker.ts).
  codeHighlightWorker: createInboxCodeHighlightWorker(() => import('./codeHighlight.worker?worker&inline').then((module) => new module.default())),
  webmcp: { enabled: false, namePrefix: 'plannotator.' },
  // The `/` and `$` skill picker (composers and comments on attached files)
  // lists this computer's global skills (approval "inbox-skill-references").
  skillCatalogTransport: async () => {
    const { skills } = await inboxApi.skills();
    return Array.isArray(skills) ? (skills as SkillCatalogEntry[]) : [];
  },
  // A Send composes ONE skills block for the whole message (skills.ts), so a
  // comment's `$name` stays plain text in the attachments' feedback.
  skillReferenceExport: false,
  // A comment on an attached file rides the person's next reply.
  skillInstructionsDestination: 'your reply',
  uploadTransport: {
    upload: async () => {
      throw new Error('Images cannot be added to a comment in the Inbox.');
    },
  },
});

// Hover cards for Linear issue links, and bare identifiers of the workspace's teams as links (linearCards.tsx).
if (typeof window !== 'undefined') installLinearCards();
