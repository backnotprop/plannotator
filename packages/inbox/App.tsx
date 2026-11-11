/**
 * The Plannotator Inbox window (`plannotator inbox`), built to its design of
 * record (kept privately, not in this repo). A mail client for
 * what agents send: the list in the approved sections (a row is a thread),
 * the thread read as an email with Plannotator's question cards, pick then
 * Send, and Settings.
 *
 * Routing is the URL hash (`#thread=msg_…`, `#project=prj_…`, `#settings`),
 * the same `#thread=` the MCP tools hand agents. An older link to the removed
 * Decisions page (`#decisions=…`) opens the list.
 */

import { threadPullsBus } from './threadPulls/model';
import { inboxRefTransport } from './refTransport';
import { markInboxPage } from './pageMarks';
import { perfFirstList, perfStart, perfThreadOpenDropped, perfThreadOpenStart, perfThreadReadLanded, perfUntilNextFrame } from './perfMarks';
import { createInboxCodeHighlightWorker } from './codeHighlightWorker';
import { inboxUrl, machineOf, selfMachineId } from './inboxUrl';
import type { ActionMark } from './components/ActionChecklist';
import { isMootNoteRefusal } from './actionSaves';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { ThemeProvider, useTheme } from '@plannotator/ui/components/ThemeProvider';
import { WarmCodeHighlight } from './components/WarmCodeHighlight';
import { threadDrawReady } from './threadDrawReady';
import { shareUnchanged } from './shareUnchanged';
import { WarmWindowParts } from './lazyParts';
import { TooltipProvider, TOOLTIP_SKIP_DELAY_MS } from '@plannotator/ui/components/Tooltip';
import { TIP_DELAY_MS } from './components/Tip';
import { configStore } from '@plannotator/ui/config';
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import { selectionToolbarShowing } from './selectionToolbar';
import { storage } from '@plannotator/ui/utils/storage';
import { setSidebarSectionOpen } from './sidebarSections';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { reloadSkillCatalog } from '@plannotator/ui/utils/skillCatalog';
import type { InboxCardWire, InboxDecision, InboxHealth, InboxListRow, InboxListSection, InboxQuestion, InboxReplyDraftRow, InboxRun, InboxThread } from '@plannotator/core/inbox-types';
import { DecisionMode } from './decisions/DecisionMode';
import { DecisionPill, decideEntryShown } from './decisions/entry';
import { threadDecisions } from './decisions/model';
import {
  InboxApiError,
  inboxApi,
  onReplySent,
  adoptPageSession,
  pageServerSession,
  setPageSession,
  subscribeInboxEvents,
  tailnetGuest,
  inboxAskOn,
  REF_CARD_READ_MS,
  signalWithin,
  type AgentToolHost,
  type InboxEvent,
  type ListModel,
  type MachineView,
  type OutboxView,
  type SettingsModel,
  type UpdateDetails,
  type WhatsNewModel,
  type WhatsNewReleasesModel,
} from './api';
import { listReadRefused, readFirstList } from './firstListRead';
import { adoptRestartedInbox, type RestartHello } from './sessionAdopt';
import { listsThread, newRecordBatch, noteOwnRecord, noteRecord, openThreadRead } from './openThreadReads';
import { createOwnSaves } from './ownSaves';
import { createSignal } from './signal';
import { onlyQuestionsChanged } from './pickQueue';
import { keepSame, sameListModel } from './listSame';
import { draftsReadOwed, replyDraftsDiffer, unsentThreads } from './draftsReads';
import { filterMachineRows, machineCounts, machineProjectNames, machinesModel, rowSnoozes, snoozeBlockedBy, threadAwayLine, threadOutbox } from './machines';
import { ASK_AGENT_TO_UPDATE, ASK_AGENT_TO_UPDATE_THREAD, MachineUpdateDialog } from './components/MachineUpdate';
import { discardPreparedInboxEvents, prepareInboxEvents } from './sharedEvents';
import { flatRows, readListView, useListView, type ListSort } from './listView';
import { useShowLight, type ListEdge } from './showLight';
import { appliedFilter, filterListSections, localDay, pickCount, useListFilter } from './listFilter';
import { ListFilterEmpty, clearedFrom } from './components/ListFilter';
import { addOwnThreads, adoptKeepingOpen, drawnSection, filterSections, heldNews as heldNewsOf, heldNotice, listGroups, lookedRow, markHeldRowArchived, markHeldRowLooked, putReadRowBack, putRowBack, refreshHeldRows, replaceHeldRow, settleOwn, settlesOnBack, settleThread, showBroughtIn, showLandsIn, snoozeChangedRows, waitingCount, type OpenThread } from './held';
import { inboxSnoozeDelay, inboxSnoozeRunning, inboxSnoozeWhen, type InboxRowSnooze } from '@plannotator/core/inbox-snooze';
import { deliveriesReadList } from './rowDelivery';
import { inboxAgentsWatched, setInboxAgents, useAgentListFilter } from './agentsList';
import { filterAgentRows } from './agents/model';
import {
  captureSettle,
  COVERED_LIST_SETTLES,
  listBody,
  playSettle,
  prefersReducedMotion,
  rowInSlot,
  SETTLE_AFTER_SIDEBAR_MS,
  SETTLE_BEAT_MS,
  SHOW_LIT_AFTER_SLIDE_MS,
  stopSettle,
  type SettleSnapshot,
} from './settle';
import { formatCount, plural, shortAgentName, tildePath } from './format';
import { copyMarkdown, threadMarkdown } from './copyMarkdown';
import { inboxImageSrcResolver } from './images';
import { shellLine, type ConnectContext } from './harnesses';
import { Sidebar } from './components/Sidebar';
import { UsagePeek } from './components/Usage';
import { ActivityChart } from './components/ActivityChart';
import { AccountsProvider, useAccounts } from './useAccounts';
import { InitiativeTagsContext, type InitiativeTags } from './hashtags';
import { SidebarShell } from './shell/SidebarShell';
import { InboxList } from './components/InboxList';
import { useTidy } from './components/Tidy';
import { ThreadPane } from './components/Thread';
import { openPaneUnsaved } from './components/AttachmentPane';
import { isNewTabClick } from '@plannotator/ui/components/LocalLinkContext';
import { inboxLinkHash } from './links';
import { SearchHost, type SearchLanding } from './components/SearchHost';
import { onOpenSearchKey } from './search/searchShortcut';
import { useShortcutScope } from '@plannotator/ui/shortcuts';
import { inboxThreadShortcuts } from './shortcuts/thread.shortcuts';
import { bareKeyAllowed, inOverlay, isComposingKey, isEditableTarget, isRepeatKey, keyboardFocused, keyTarget, modalOpen, singleKeysLive } from './shortcuts/guards';
import { appKeyAllowed as appKeyAllowedOn, archiveTarget, newPageKeys, refreshAction, refreshKey, refreshKind } from './keyboard/appKeys';
import { inboxAppShortcuts } from './shortcuts/app.shortcuts';
import { ShortcutMap } from './components/ShortcutMap';
import { EmptyState } from './components/EmptyState';
import { Icon } from './icons';
import { TourBar, TourCoach, TourLoading, TourMain, TourNavigation, loadTour, tourComposeBody, tourComposeTransport, tourView, useReducedMotion, useTourFixture, useTourReplay } from './tour/Tour';
import { TourEntry, tourEntryModel } from './tour/TourEntry';
import { TOUR_FIT_LINES, TOUR_FIT_TITLE, TourIntro } from './tour/Fit';
import { TOUR_COMPOSE_STEP, TOUR_FIRST_QUESTION_PROMPT, TOUR_PROJECT_ID, TOUR_SETTINGS_STEP, TOUR_START, TOUR_STEPS, TOUR_THREAD, tourCanBack, tourCanForward, tourCoach, tourCoachSpeech, tourReducer, tourStepOf, type TourAction, type TourDegraded, type TourUi } from './tour/model';
import { ThreadWait } from './components/ThreadWait';
import { EmptyThreadPanel } from './components/EmptyThreadPanel';
import { AgentNoteDialog } from './components/AgentNoteDialog';
import { ConnectLine } from './components/ConnectLine';
import { FeedbackDialog } from './components/FeedbackDialog';
import { SystemSetupHost } from './system/SetupHost';
import { systemShown } from './system/gate';
import { useSystemProjects } from './system/projects';
import { systemDropped, systemEscapeTo, systemHashOf, systemKept, systemRouteOf } from './system/route';
import { feedbackCopiedToast, feedbackPrompt } from './feedbackPrompt';
import { connectLineNews, noteQuestionRows } from './agents';
import type { InboxAgentRow, InboxAgentsModel, InboxTourChange, InboxTourState } from '@plannotator/core/inbox-types';
import { SettingsPage } from './components/Settings';
import { createStepsBus } from './steps/useThreadSteps';
import { threadBoardCard } from './steps/model';
import { ArchivedBlock } from './components/Archived';
import { NotificationAsk, TabSleptLine } from './components/NotificationAsk';
import { useInboxNotifications } from './notify';
import { snoozeBackAfter, type SnoozeBack } from './snoozeBack';
import { pageInFront, useInboxSound } from './sound';
import { notificationLine, SoundIntroDialog } from './components/SoundIntro';
import { ListLookIntro, type ListIntroGroup } from './components/ListLookIntro';
import { LIST_INTRO_SETTLED_MS, listIntroMayAsk, listIntroPageClear, listIntroWanted, type ListIntroLoad } from './listIntro';
import { VoiceIntro } from './components/VoiceIntro';
import { adoptVoiceSettings } from './voice';
import { useVoiceIntro, VOICE_INTRO_MIN_WORDS, VOICE_INTRO_MOMENT_MS } from './voiceIntro';
import { SnoozeIntro } from './components/SnoozeIntro';
import { oneTimeDialogShownThisLoad, snoozeIntroBlockedBy, useSnoozeIntro } from './snoozeIntro';
import { useLineLatch, claimRevealOnce, listTallerThanScreen, listViewRevealClear, listViewRevealLeaveCounts, listViewRevealMayClaim, idleClockArmed, noteRevealThread, openThreadAsks, revealArmed, broRevealIdleCounts, broRevealLeaveCounts, grillMeTipIdleCounts, grillMeTipLeaveCounts, useBoardReveal, useLineReveal, useStepsReveal, useStarReveal } from './reveal';
import { useIdleClock } from './idleClock';
import { launchTipDue } from './compose/launchTip';
import type { InboxRevealId } from './api';
import { type RevealFeature, turnOnFromReveal as turnOnRevealFeature } from './revealTurnOn';
import { namesCapability, withCapabilities } from './capabilities';
import { openSnoozeMenu } from './snoozeIntroTry';
import { adoptSavedRows, hearRowsEvent, listLookReadMark, readListLook, writeListLookOptions } from './listLook';
import { adoptSavedSidebar, hearSidebarEvent, sidebarLayoutReadMark, useSidebarCustomizerOpen } from './sidebarLayout';
import { sidebarTipDue, useSidebarTip } from './sidebarTip';
import { SidebarTipCard } from './components/SidebarTipCard';
import { SidebarCustomizer } from './components/SidebarCustomizer';
import { drawnSidebarItems } from './sidebarItems';
import { ReviewPane } from './components/ReviewPane';
import { AboutBlock, FailedDialog, GeneralUpdateRow, RestartDialog, UpdateDialog, WhatsNewPage, type WhatsNewError } from './components/Updates';
import { leaveOnPurpose, replyBeingWritten, unsentReply } from './unsent';
import { reloadOntoInbox, STALE_HEALTH_MS, useStalePage } from './stalePage';
import { StalePageNotice } from './components/StalePageNotice';
import { InboxToast, type InboxToastModel, toastSpeech } from './components/Toast';
import { errorToast } from './toastError';
import { pictureFromFile } from './projectPictures';
import { canToggleRead, confirmSetAside, MARK_READ_LOOK_WAIT_MS, MARK_READ_UNDO_MS, MARK_UNREAD_RETRY_WAIT_MS, markReadToast, markUnreadToast, offersRowMarkRead, seenHeldInNew, setAsideCount, type SetAsideAnswer, type SetAsideCount } from './markRead';
import { MarkReadWarning } from './components/MarkReadWarning';
import { summarizeInboxQuestions } from '@plannotator/core/inbox-questions';
import { threadLink, type RowMenuAction } from './rowMenu';
import { movePin, unpinnedWhere } from './pins';
import { noteStarred } from './starPop';
import type { PinnedAction } from './components/PinnedRow';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { newBatchId, projectAllArchived, projectBatchToast, projectsWithReadable, shownProjects, type ProjectAction } from './projectMenu';
import { projectActivity } from './projectSort';
import { lookBoundary } from './folding';
import { latestAgentSeq } from './seenOnSight';
import { isPhone, isTouchPhone, trackKeyboard, usePhone } from './phone';
import { installPasteFollowsField } from './pasteTarget';
import { installPlainTextPaste } from '@plannotator/ui/utils/pasteInsert';
import { LIST_MIN_WIDTH, THREAD_BESIDE_FILE_WIDTH, paneGutters, useStack } from './stack';
import { threadPanelShows, useThreadPanel } from './threadPanel';
import { ListColumnEdge } from './shell/ListColumnEdge';
import { backBy, backTo, pushScreen, settleLanding, whileWritingRoute, withoutClickSignal } from './history';
import { parseFileView, sameScreenAnyView } from './fileView';
import { fileEntryOp, fullExitFile, fullFromSide, pageBackPastSwitch, withFullMark, type FrameMove, type FullMark } from './fullScreenOrigin';
import { adoptSavedTheme, inboxServerSync, useInboxThemePick } from './theme';
import { adoptSavedDiffOptions } from './diffOptions';
import { adoptSavedTextSize, applyRememberedTextSize } from './textSize';
import { adoptSavedFavicon, chooseFavicon, useInboxFavicon, useInboxFaviconBadgeHref, useInboxFaviconHref } from './faviconChoice';
import { adoptSavedReactions, hearReactionsEvent, onSavedReactionsFailed, reactionsReadMark } from './reactions';
import { movedSettingsHash, parseSettingsHash, settingsHash, type SettingsSection } from './settingsRoute';
import { hiddenKnownAnswers } from './feedbackKnown';
import { ComposeDialog, type ComposeHeld, type ComposeJoined, type ComposeRequest, type ComposeSent } from './compose/ComposeDialog';
import { heldLaunchToast } from './compose/heldLaunch';
import { ArtifactsWall } from './components/ArtifactsWall';
import { readArtifactPins } from './artifactPins';
import { hearAgentFacesEvent, readAgentFaces } from './agents/agentFaces';
import { DraftsPage } from './compose/DraftsPage';
import { BoardPage, type BoardMove } from './board/BoardPage';
import { PullsPage, ReviewsOff } from './pulls/PullsPage';
import { PullReview } from './pulls/PullReview';
import { usePulls } from './pulls/usePulls';
import { SheetPage, type SheetView } from './prs/SheetPage';
import { sheetModel } from './prs/sheetModel';
import { StackPage } from './prs/StackPage';
import { useSheetPulls } from './prs/useSheetPulls';
import { inboxPullIsOpen, inboxPullStacks } from '@plannotator/core/inbox-types';
import { repoLabels } from './pulls/labels';
import { pullFilterOf, type PullFilter } from './pulls/model';
import { reviewRowProject, reviewViewOf } from './pulls/reviewsModel';
import { reviewsAlias } from './reviewsRoute';
import { BoardOff } from './board/BoardOff';
import { BoardIntro } from './board/BoardIntro';
import { BroIntro } from './components/BroIntro';
import { GrillMeTip } from './components/GrillMeTip';
import { ListViewIntro } from './components/ListViewIntro';
import { ChecklistIntro } from './steps/ChecklistIntro';
import { StarAskCard } from '@plannotator/ui/components/StarAskCard';
import { CodeReviewOffer } from './components/CodeReviewOffer';
import { useCodeReviewOffer } from './codeReviewOffer';
import { TabIconChoice } from './components/TabIconChoice';
import { useTabIconChoice } from './tabIconChoice';
import { ThemeChooser } from './components/ThemeChooser';
import { openThemeSettings, useThemeChooser } from './themeChooser';
import { CardChip } from './board/CardChip';
import { boardFilterHash, boardInitiativeOf, boardViewOf, cardsInInitiative, liveInitiatives, newCardProject, type BoardView } from './board/model';
import { useComposeSessions } from './compose/useComposeSessions';
import { useComposerOpener } from './compose/openComposer';
import { COMPOSE_CLONE_EVENT, composeActions, composeTargets, hostLabel, lastLaunchAgent, launchHistory, projectCanStart, projectPlusOn, SCRATCH_PICK, type ComposeAction, type ComposeCloneRequest } from './compose/model';
import { machineLaunchesKept } from './compose/useMachineLaunches';
import { reviewBoxPulls } from './compose/reviewBox';
import type { CardsModel, DraftView, InboxStorageModel, UpdateCheckFailing } from './api';
import { NO_RESTART_AGENTS, restartAgentsOf } from './restartAgents';
import type { InboxComposeLaunch, InboxReaction, InboxRestartAgents } from '@plannotator/core/inbox-types';
import { reactionSpeech } from './components/ReactionTray';
import { inboxTabCount, useTabCount } from './tabCount';
import { pageOffersUpdates, pageOffersWhatsNew, sidebarUpdateNotice, updateForPage } from './updateNotice';
import { actedSince, inputMark, lastInput } from './lastInput';
import { backFocusTargets, focusKept, focusLost } from './backFocus';
import { askArrivalFocus, listOrder as drawnOrder, threadStep } from './threadStep';
import { LIST_STOPS, listKeyTarget } from './listKeys';
import { emitAskChange } from './ask/askEvents';
import { useInboxAsk } from './ask/useInboxAsk';
import { SideButtonContext } from './ask/sideButton';
import { useReplyFloaters } from './floaters/useReplyFloaters';
import { emitFloaterEvent } from './floaters/model';
import { setSessionLabels } from './sessionLabels';
import { createInboxShapeHost } from './shape/inboxShapeHost';
import { ShapeGridPage, ShapePebbleButton } from './shape/ShapeParts';
import { ThreadShapeLayer, ThreadShowMeBox, useThreadShowMe } from './shape/ThreadShapeLayer';
import { setReviewSkillsDiagrams, setReviewSkillsShape } from './skills';
import { showMeBoardOpensIn } from './shape/showMeOpensIn';
import { shapeReplyPart, type ShapeReplyPart } from './shape/addToReply';
import type { ShapeBoxSelection } from '@plannotator/ui/components/shape';
import { useBoardPlaces } from './shape/boardPlace';
import { useInboxShapes } from './shape/useInboxShapes';
import { shapeReviewAtOf, writeShapeReviewAt, type ReviewAt } from './shape/review';
import { filterShapeItems, shapeAgo } from '@plannotator/ui/components/shape/ShapeGrid';
import type { SearchShape } from './search/model';
import { connectCommand } from './connectPrompt';

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
  // Hover cards for issue, PR and MR links: the server fetches with this computer's gh or glab (ref-cards.ts).
  // Given up after REF_CARD_READ_MS (the card then shows what the Inbox knows), so no read holds a connection for good.
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

const SIDEBAR_OPEN_COOKIE = 'plannotator-inbox-sidebar-open';
/** The list's ⋯ "Hide offline machines" (linked machines): kept in this browser, like the sidebar's state. */
const HIDE_AWAY_MACHINES_COOKIE = 'plannotator-inbox-hide-offline-machines';
/** The session the person last sent a new message to: first in the To picker and the palette's "Message <host>" while it is live; never put in To by itself. */
const COMPOSE_LAST_COOKIE = 'plannotator-inbox-compose-last';
/** How often the Drafts page reads its drafts again, so each chip follows its session. */
const DRAFTS_REFRESH_MS = 10_000;
/** No cards handled yet (the Board before its first read of a visit). */
const EMPTY_SET: ReadonlySet<string> = new Set();
/** How long the refresh icon shows after a click on Inbox: one turn (inbox.css `ib-refresh-turn`, 500 ms), then back to the inbox icon. */
const REFRESH_SPIN_MS = 600;
/** Who hears the event stream's `event: shapes` (the window has one stream; useInboxShapes listens here). */
const shapeFrameListeners = new Set<(ids: string[]) => void>();
const subscribeShapeFrames = (listener: (ids: string[]) => void) => {
  shapeFrameListeners.add(listener);
  return () => {
    shapeFrameListeners.delete(listener);
  };
};
/** After the live region said "Reconnecting…", it says it again only past this (a network that comes and goes). */
const RECONNECT_SAY_GAP_MS = 10 * 60_000;
/** How long a page over the tailnet says that a restart has not come back: long enough to read away from the computer. */
const RESTART_NOT_BACK_MS = 20_000;
/** How long "Not reloaded: something you wrote is not saved yet" stays, with its Reload anyway (the stale page notice). */
const STALE_NOT_SAVED_MS = 12_000;
/** Settings → Agents re-reads the agents this often while open, so "Open sessions" follows the sessions as they restart. */
const AGENTS_SESSIONS_REFRESH_MS = 5_000;
/** A look seen on sight that the server did not take is sent again this many times, 1 s, 2 s, 4 s… apart. */
const SEEN_RETRIES = 5;
const SEEN_RETRY_MS = 1000;
/** The What's new page asks again this often while the server fetches the notes (its request gives up after 10 s). */
const WHATS_NEW_RETRIES = 15;
const WHATS_NEW_RETRY_MS = 1000;
/** The releases panel asks again this often while the server fetches the release list (once a day at most). */
const WHATS_NEW_RELEASES_RETRIES = 6;
const WHATS_NEW_RELEASES_RETRY_MS = 1500;
/**
 * Opening a thread whose read failed (a dropped connection, a 5xx; not a 404): read it again after
 * these waits, then every last one, while it stays open. Before this the pane stayed blank until some
 * agent wrote anywhere in the Inbox (the event stream re-reads the open thread), seconds or forever.
 * A failed re-read of a thread already on screen waits the same (liveThreadRetry).
 */
export const THREAD_READ_RETRY_MS = [250, 1000, 2000, 4000, 5000] as const;
/**
 * A read of the open thread with no answer by then (a connection held behind
 * the browser's six per host, a stalled server) fails and is read again, as
 * a dropped one is; before this it waited for good.
 */
export const THREAD_READ_TIMEOUT_MS = 8000;
/** How long a fresh load's 404 waits for the first merged list before it says the thread is not here. */
const FIRST_LIST_WAIT_MS = 10_000;
/** How long "Not sent to MacBook: it is no longer linked." stays: long enough to read and go to Settings. */
const UNSENT_TOAST_MS = 12_000;
/**
 * How long a 404 waits, after a start, for linked machines whose lists this Inbox has not read yet (one asleep may hold
 * the thread). After that it says the thread is not here; a later list that names its machine opens it there.
 */
const UNLISTED_WAIT_MS = 120_000;
/** Why the open thread is not on screen yet: its read failed (read again soon), or the server has no such thread. */
interface ThreadLoad {
  threadId: string;
  state: 'failed' | 'missing' | 'refused';
  error: string;
  /** Failed only because linked machines have not sent their lists yet: what it waits for, said in place of the error. */
  waiting?: string | null;
}

interface Route {
  page: 'inbox' | 'settings' | 'whats-new' | 'drafts' | 'tour' | 'board' | 'reviews' | 'shapes' | 'prs' | 'artifacts';
  /**
   * Pull requests (`#prs`, Code review on; approval "inbox-pr-dashboard"): Open or Merged (`&state=merged`), a stack's
   * page (`&stack=`, a layer's key), a PR opened from it (`&layer=`, `&scope=stack`), and `&from=sheet` when the PR was
   * opened from a tile (its Back is the Sheet, not the stack's page), `&from=reviews` when it was opened from the board in
   * Reviews' right pane (its Back is Reviews). On a desktop the board lives in Reviews' pane: a Back that would go to
   * the Sheet goes to Reviews there; `#prs` itself is a phone's way in (Reviews' "Pull requests" row).
   */
  prsView?: SheetView;
  prsFrom?: 'sheet' | 'stack' | 'reviews';
  /** The Artifacts wall on Pinned (`#artifacts=pinned`; approval "inbox-artifact-stars"); All is `#artifacts`. */
  pinned?: boolean;
  /**
   * Reviews (`#reviews`, Code review on; `#pulls` is its permanent alias): the stack open beside the list (`&stack=`, its top layer's key),
   * and the layer under review (`&layer=`, with `&scope=stack` for the whole stack up to it).
   */
  stack?: string | null;
  layer?: string | null;
  scope?: 'layer' | 'stack';
  /**
   * A thread opened from Reviews (`#reviews&thread=…`): the same thread and pane as the Inbox's (`page: 'inbox'`), with
   * Reviews' list beside it and its filter kept. It doesn't move threads: a different list on the same thread.
   */
  reviews?: { project: string | null; view: PullFilter } | null;
  /** `#reviews&new`: open the New review box (a link from outside, Workspaces among them). Taken off the address as it opens. */
  new?: boolean;
  /** Reviews' view (`&view=mine|review|others`; absent: All), beside `project`. */
  view?: PullFilter;
  /**
   * System in Reviews (approval "system-inbox", screens 4a and 4b): the project whose drawing is open in the pane
   * (`&system=prj_…`), the sheet on screen (`&sheet=C-001`) and the full window (`&full=1`). A stack opened over it
   * (`&stack=`) closes back to it.
   */
  system?: string | null;
  sheet?: string | null;
  full?: boolean;
  /**
   * Shape (approval "shape-inbox-placement"): the board open over its thread (`#thread=…&shape=shp_…`), or over
   * the grid for a board with no thread (`#shapes&shape=shp_…`). The grid alone is `#shapes`.
   */
  shape?: string | null;
  /** The Board's list (`#board`, `#board=done`, `#board=cancelled`; `#board=shipped` before the rename opens Done, `#board=icebox` from before v2 Cancelled). */
  board?: BoardView;
  /** The opened Board card (`#board&card=crd_…`), or on a thread the card it was opened from (its "‹ Board" way back). */
  card?: string | null;
  /**
   * On a thread opened from a Board card: the project the Board was filtered to (`&board-project=prj_…`), so its
   * way back lands on the same filtered Board. On the Board itself the filter is `project` (`#board&project=prj_…`).
   */
  boardProject?: string | null;
  /**
   * The Board's initiative filter (approval "board-initiatives"): on the Board `#board&initiative=ini_…` (or
   * `none`, the cards in none), beside `project`; on a thread opened from a card, `&board-initiative=`, so its
   * way back lands on the same filtered Board.
   */
  initiative?: string | null;
  boardInitiative?: string | null;
  /** The onboarding tour's step (`#tour=3`, approval "inbox-onboarding-tour"): 1 to 6. */
  step?: number;
  /** The release whose notes the What's new page shows (`#whats-new=0.28.12`). */
  version?: string | null;
  project: string | null;
  /**
   * Linked machines: the list shows one machine's threads (`#machine=ibx_…`), the sidebar's Machines filter. Beside
   * `project`, never instead of it.
   */
  machine?: string | null;
  /**
   * The sidebar's Agents section: the list shows one agent's threads (`#agent=<InboxAgent.id>`), every thread its
   * session (and the sessions its conversation had before) wrote in, was addressed in or took part in. Picked in
   * place of a project or a machine, never beside them.
   */
  agent?: string | null;
  thread: string | null;
  /**
   * An attachment open beside the thread: `file=att_…`, `v=sent` for the version the agent sent, `at=` an annotation to show,
   * `linked=` a page the attached HTML page links to, shown read-only over it (its path in the page's folder, `#fragment` kept),
   * `view=full|side` the view it is shown in (fileView.ts; absent: the remembered choice, then the rule by kind),
   * `set=<message id>:<question key>` a question's picture choices the viewer steps through (optionSets.ts; absent: every file of the thread).
   */
  file?: { id: string; version: 'current' | 'sent'; focus: string | null; linked?: string | null; view?: 'full' | 'side' | null; set?: string | null } | null;
  /** The message whose guided review is open over the window (`#thread=…&guide=msg_…`). */
  guide?: string | null;
  /**
   * Where that review opens (a Shape board's place in code, such as a drawn part's `data-code`): `&code=path:line`,
   * `&step=N` or `&files` (a context note's lines on the removed side add `&side=old`). Dropped from the address once
   * the review is there.
   */
  guideAt?: ReviewAt | null;
  /**
   * The thread's Artifacts view (`#thread=…&artifacts`, approval "inbox-thread-artifacts"): the grid of every
   * artifact in place of the messages. A file or a guided review opened from it keeps it, so their Back returns to it.
   */
  artifacts?: boolean;
  /** The Artifacts view on its links (`#thread=…&artifacts&links`). Means nothing without `artifacts`. */
  links?: boolean;
  /**
   * A message to land on (`#thread=…&msg=msg_…`, a search result): the thread
   * opens there, the message unfolded, centred, focused and ringed. Dropped
   * from the hash once landed, so a reload does not jump again.
   */
  msg?: string | null;
  /** Settings' section (`#settings/<section>`); null is `#settings` alone (settingsRoute.ts). */
  section?: SettingsSection | null;
  /** `#settings/devices/pair`: Pair a phone is open. */
  pair?: boolean;
  /** `#settings/experimental` (an old link): Capabilities, landing on its Experimental group. Never written to the address. */
  experimental?: boolean;
}

function readRoute(): Route {
  return routeOf(window.location.hash);
}

function routeOf(fullHash: string): Route {
  const hash = withoutClickSignal(fullHash).replace(/^#/, '');
  const settingsAt = parseSettingsHash(hash);
  if (settingsAt) return { page: 'settings', project: null, thread: null, section: settingsAt.section, pair: settingsAt.pair, experimental: settingsAt.experimental };
  const params = new URLSearchParams(hash);
  if (params.has('whats-new')) return { page: 'whats-new', project: null, thread: null, version: params.get('whats-new') };
  if (params.has('tour')) return { page: 'tour', project: null, thread: null, step: tourStepOf(params.get('tour')) };
  if (params.has('drafts')) return { page: 'drafts', project: null, thread: null };
  // The Artifacts wall (the sidebar's Artifacts row). `#thread=…&artifacts` is a thread's own grid, below.
  if (params.has('artifacts') && !params.get('thread')) return { page: 'artifacts', project: null, thread: null, pinned: params.get('artifacts') === 'pinned' };
  if (params.has('shapes')) return { page: 'shapes', project: null, thread: null, shape: params.get('shape') };
  if (params.has('prs')) {
    const stack = params.get('stack') || null;
    const layer = stack ? params.get('layer') || null : null;
    return {
      page: 'prs',
      project: null,
      thread: null,
      prsView: params.get('state') === 'merged' ? 'merged' : 'open',
      stack,
      layer,
      scope: layer && params.get('scope') === 'stack' ? 'stack' : 'layer',
      prsFrom: layer && params.get('from') === 'sheet' ? 'sheet' : layer && params.get('from') === 'reviews' ? 'reviews' : 'stack',
    };
  }
  // The Board's project filter rides the list's own key (`#board&project=prj_…`).
  // `#pulls…` is rewritten to this address on arrival (reviewsAlias): it may still be read here in the same breath.
  const fromReviews = params.has('reviews') || params.has('pulls');
  if (fromReviews && !params.get('thread')) {
    const stack = params.get('stack') || null;
    const layer = stack ? params.get('layer') || null : null;
    return {
      page: 'reviews',
      project: params.get('project') || null,
      view: pullFilterOf(params.get('view')),
      thread: null,
      stack,
      layer,
      scope: layer && params.get('scope') === 'stack' ? 'stack' : 'layer',
      new: params.has('new'),
      ...systemRouteOf(params),
    };
  }
  if (params.has('board'))
    return {
      page: 'board',
      project: params.get('project') || null,
      initiative: boardInitiativeOf(params.get('initiative'), null),
      thread: null,
      board: boardViewOf(params.get('board')),
      card: params.get('card'),
    };
  const thread = params.get('thread');
  const fileId = thread ? params.get('file') : null;
  return {
    page: 'inbox',
    reviews: fromReviews ? { project: params.get('project') || null, view: pullFilterOf(params.get('view')) } : null,
    project: fromReviews ? null : params.get('project'),
    machine: params.get('machine'),
    agent: fromReviews ? null : params.get('agent'),
    thread,
    file: fileId ? { id: fileId, version: params.get('v') === 'sent' ? 'sent' : 'current', focus: params.get('at'), linked: params.get('linked'), view: parseFileView(params.get('view')), set: params.get('set') } : null,
    guide: thread ? params.get('guide') : null,
    guideAt: thread && params.get('guide') ? shapeReviewAtOf(params) : null,
    shape: thread ? params.get('shape') : null,
    msg: thread ? params.get('msg') : null,
    artifacts: thread ? params.has('artifacts') : false,
    links: thread ? params.has('artifacts') && params.has('links') : false,
    card: thread ? params.get('card') : null,
    // The Board list the card was opened from (Done, Cancelled): the way back goes there.
    board: thread && params.get('card') ? boardViewOf(params.get('from')) : undefined,
    boardProject: thread && params.get('card') ? params.get('board-project') || null : null,
    boardInitiative: thread && params.get('card') ? boardInitiativeOf(params.get('board-initiative'), null) : null,
  };
}

/** The route's hash, `#thread=…` (empty for the list at rest). */
function hashOf(route: Route): string {
  let hash = '';
  if (route.page === 'settings') hash = settingsHash({ section: route.section ?? null, pair: route.pair });
  else if (route.page === 'whats-new') hash = new URLSearchParams({ 'whats-new': route.version ?? '' }).toString();
  else if (route.page === 'drafts') hash = 'drafts';
  else if (route.page === 'artifacts') hash = route.pinned ? 'artifacts=pinned' : 'artifacts';
  else if (route.page === 'shapes') hash = route.shape ? `shapes&shape=${encodeURIComponent(route.shape)}` : 'shapes';
  else if (route.page === 'board')
    hash =
      (route.board && route.board !== 'lanes' ? `board=${route.board}` : 'board') +
      boardFilterHash({ project: route.project, initiative: route.initiative }) +
      (route.card ? `&card=${encodeURIComponent(route.card)}` : '');
  else if (route.page === 'reviews')
    hash =
      'reviews' +
      (route.project ? `&project=${encodeURIComponent(route.project)}` : '') +
      (route.view && route.view !== 'all' ? `&view=${route.view}` : '') +
      (route.stack ? `&stack=${encodeURIComponent(route.stack)}` : '') +
      (route.stack && route.layer ? `&layer=${encodeURIComponent(route.layer)}${route.scope === 'stack' ? '&scope=stack' : ''}` : '') +
      systemHashOf(route) +
      (route.new ? '&new' : '');
  else if (route.page === 'prs')
    hash =
      'prs' +
      (route.prsView === 'merged' ? '&state=merged' : '') +
      (route.stack ? `&stack=${encodeURIComponent(route.stack)}` : '') +
      (route.stack && route.layer ? `&layer=${encodeURIComponent(route.layer)}${route.scope === 'stack' ? '&scope=stack' : ''}${route.prsFrom === 'sheet' ? '&from=sheet' : route.prsFrom === 'reviews' ? '&from=reviews' : ''}` : '');
  else if (route.page === 'tour') hash = `tour=${route.step ?? 1}`;
  else {
    const params = new URLSearchParams();
    if (route.reviews) {
      if (route.reviews.project) params.set('project', route.reviews.project);
      if (route.reviews.view !== 'all') params.set('view', route.reviews.view);
    }
    if (route.machine) params.set('machine', route.machine);
    if (route.agent) params.set('agent', route.agent);
    if (route.project) params.set('project', route.project);
    if (route.thread) params.set('thread', route.thread);
    if (route.thread && route.msg) params.set('msg', route.msg);
    if (route.thread && route.artifacts) params.set('artifacts', '');
    if (route.thread && route.artifacts && route.links) params.set('links', '');
    if (route.thread && route.file) {
      params.set('file', route.file.id);
      if (route.file.version === 'sent') params.set('v', 'sent');
      if (route.file.focus) params.set('at', route.file.focus);
      if (route.file.linked) params.set('linked', route.file.linked);
      // The view rides the address (fileView.ts), so a reload or a shared link opens the same way.
      if (route.file.view) params.set('view', route.file.view);
      // A question's picture choices (optionSets.ts): a reload and Back keep stepping through them.
      if (route.file.set) params.set('set', route.file.set);
    }
    if (route.thread && route.guide) params.set('guide', route.guide);
    if (route.thread && route.guide) writeShapeReviewAt(params, route.guideAt);
    if (route.thread && route.shape) params.set('shape', route.shape);
    // A thread opened from a Board card: its way back is the card (`&card=crd_…`).
    if (route.thread && route.card) params.set('card', route.card);
    if (route.thread && route.card && route.board && route.board !== 'lanes') params.set('from', route.board);
    if (route.thread && route.card && route.boardProject) params.set('board-project', route.boardProject);
    if (route.thread && route.card && route.boardInitiative) params.set('board-initiative', route.boardInitiative);
    // `&artifacts`, `&links` and `&files`, flags: written without their empty `=`.
    hash = params.toString().replace(/(^|&)(artifacts|links|files)=(?=&|$)/g, '$1$2');
    if (route.reviews) hash = hash ? `reviews&${hash}` : 'reviews';
  }
  return hash ? `#${hash}` : '';
}

/** The hash the page shows now, in hashOf's spelling (`#` alone reads as none). */
function currentHash(): string {
  return window.location.hash === '#' ? '' : window.location.hash;
}

/**
 * Write the route to the hash. `replace` swaps the current history entry
 * instead of adding one: stepping between a thread's attachments, so one
 * Back returns to the thread rather than through every file. The entry keeps
 * its state (the screen it was opened from, history.ts), so that Back is still
 * the browser's Back on a phone.
 */
function writeRoute(route: Route, options: { replace?: boolean; fullMark?: FullMark | null } = {}): void {
  // The Artifacts view belongs to the thread it was opened in: another thread, or a message to land on, opens on the messages.
  if (route.artifacts && (route.thread !== readRoute().thread || route.msg)) route = { ...route, artifacts: false };
  const hash = hashOf(route);
  const next = hash || window.location.pathname + window.location.search;
  // Leaving the tour takes the tour's own entry, whatever leads out of it (a sidebar row, a search result, a link),
  // so the browser's Back never reopens #tour=N.
  const leavingTour = readRoute().page === 'tour' && route.page !== 'tour';
  // `fullMark`: the entry's full-screen mark (fullScreenOrigin.ts). Absent: a replace keeps the one on screen, a push sets none.
  const mark = options.fullMark;
  if (options.replace || leavingTour) {
    const state = mark === undefined ? window.history.state : withFullMark(window.history.state, mark);
    if (hash !== currentHash() || state !== window.history.state) window.history.replaceState(state, '', next);
  } else {
    // Each entry remembers the one it was opened from, so a phone's way back can be the browser's own Back (closeTo).
    pushScreen(hash, currentHash(), next, window.history, mark ? withFullMark(null, mark) : undefined);
  }
  // Its own hashchange: a Back still on its way does not land in it (history.ts settleLanding).
  whileWritingRoute(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
}

/** The history-entry mark an ended tour leaves on its own entry: the hash it went back to (approval "inbox-onboarding-tour"). */
const TOUR_ENDED_STATE = 'ibTourEnded';

/**
 * A tour address, settled before the window reads it:
 * - an entry the tour ended from (Exit or Finish went back from it, leaving it
 *   ahead in history) is replaced by the screen the tour went back to, so the
 *   browser's Forward, or a reload of that entry, never reopens the tour;
 * - an odd step (`#tour=`, `0`, `abc`, `99`, `2.5`) is written as the step it reads as.
 */
function settleTourEntry(): void {
  if (routeOf(window.location.hash).page !== 'tour') return;
  const state = window.history.state as Record<string, unknown> | null;
  if (state && typeof state[TOUR_ENDED_STATE] === 'string') {
    const { [TOUR_ENDED_STATE]: to, ...rest } = state;
    window.history.replaceState(rest, '', (to as string) || window.location.pathname + window.location.search);
    return;
  }
  const canonical = `#tour=${tourStepOf(new URLSearchParams(window.location.hash.replace(/^#/, '')).get('tour'))}`;
  if (window.location.hash !== canonical) window.history.replaceState(window.history.state, '', canonical);
}

/**
 * Set when a tour decision (finished, skipped) could not be saved on the server
 * (config.json unreadable, the server stopped): this browser remembers it, so
 * Two paths does not come back here. A cookie, so a port change keeps it.
 */
const TOUR_DECIDED_COOKIE = 'plannotator-inbox-tour-decided';

/**
 * `#settings/experimental`, Experimental's own page before it moved into
 * Capabilities (the owner, 2026-10-27): the address becomes
 * `#settings/capabilities` in place (no new history entry). True when it
 * did, so the route keeps landing on the Experimental group.
 */
function settleOldExperimental(): boolean {
  if (!parseSettingsHash(window.location.hash.replace(/^#/, ''))?.experimental) return false;
  window.history.replaceState(window.history.state, '', `#${settingsHash({ section: 'capabilities' })}`);
  return true;
}

/**
 * `#settings/decision-data`, Decision data's own page before it joined Activity (approval
 * "settings-storage-activity", 2026-11-08): the address becomes `#settings/activity` in place (no new history entry).
 */
function settleMovedSettings(): void {
  const moved = movedSettingsHash(window.location.hash.replace(/^#/, ''));
  if (moved) window.history.replaceState(window.history.state, '', `#${moved}`);
}

/** A `msg=` with no thread to land in (a hand-edited or truncated link) leaves the address bar; the route already ignores it. */
function stripStrayMsg(): void {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (!params.has('msg') || params.get('thread')) return;
  const hash = hashOf(readRoute());
  window.history.replaceState(window.history.state, '', hash || window.location.pathname + window.location.search);
}

/** A notification click's `click=` come back from the browser's own history (history.ts) leaves the address bar. */
function stripClickSignal(): void {
  const clean = withoutClickSignal(window.location.hash);
  if (clean !== window.location.hash) window.history.replaceState(window.history.state, '', clean || window.location.pathname + window.location.search);
}

/** How long after the store changed Reviews' rows are read again (a burst of messages is one read). */
const REVIEWS_AFTER_STORE_MS = 800;
const REVIEWS_AFTER_STORE_MAX_MS = 4000;

/** `#pulls…` becomes `#reviews…` in place: the entry is kept, and every old link goes on working (reviewsRoute.ts). */
function settleReviewsAlias(): void {
  const hash = reviewsAlias(window.location.hash);
  if (hash) window.history.replaceState(window.history.state, '', hash);
}

/**
 * Leave the screen on top for the one under it (a thread for the list, a
 * file for its thread). On a phone that is the browser's Back when this
 * screen was opened from there (history.ts), so the swipe back and the Back
 * button agree. On a desktop, and for a screen reached any other way, it is
 * a new entry, so the browser's Back reopens what was just closed.
 */
function closeTo(route: Route): void {
  if (!((isPhone() || leavesCoveringPane(route)) && backTo(hashOf(route)))) writeRoute(route);
}

/**
 * Which panes cover their list now (a window too narrow for both, stack.ts),
 * kept in step by the window. Closing a covering thread back to the list is
 * then the browser's Back, as on a phone, so an iPad's swipe back and
 * `‹ Inbox` agree.
 * Every other close, and every close beside the list, stays a new entry, as on
 * a desktop.
 */
const covering = { thread: false };

function leavesCoveringPane(route: Route): boolean {
  const from = readRoute();
  if (covering.thread && route.page === 'inbox' && !route.thread) {
    return from.page === 'inbox' && !!from.thread && !from.file && !from.guide;
  }
  return false;
}

/** The thread covers the list (a phone, a stacked window): the list is out of sight while a thread is open. */
function listCovered(): boolean {
  return isPhone() || covering.thread;
}

/** A row of the list on screen, by its thread (one element per row: the wide, three-line or phone row). */
function rowElement(body: ParentNode, threadId: string): HTMLElement | null {
  // The one on screen: a list draws some rows twice (one hidden), and a row in folded Quiet is not drawn at all.
  return [...body.querySelectorAll<HTMLElement>(`[data-thread-id="${CSS.escape(threadId)}"]`)].find((el) => el.getClientRects().length > 0) ?? null;
}

/** The tab is visible and has focus: what the tour's replay needs to stand in for notifications with its chip. */
function tourPageInFront(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** Focus the first element on screen that matches one of `selectors`, in order (a list draws some rows twice, one hidden). */
function focusFirst(selectors: readonly string[]): boolean {
  for (const selector of selectors) {
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find((candidate) => candidate.getClientRects().length > 0);
    if (el) {
      // Inside a thread's messages (its subject heading): focus never moves the thread's scroll, the place the
      // person was in (closing a file with `‹ Inbox` put the thread back at its top).
      el.focus(el.closest('.ib-pbody') ? { preventScroll: true } : undefined);
      return true;
    }
  }
  return false;
}

/**
 * A search result or a link just opened a screen: one with nothing to land on (a reply box already open with a
 * draft, no Reply to focus) leaves focus nowhere, so the thread's subject takes it, never the page. Not once the
 * person has acted since (a Send closing the box leaves focus nowhere for a moment too).
 */
function focusAfterOpen(): void {
  const mark = inputMark();
  setTimeout(() => {
    if (!actedSince(mark) && focusLost(document.activeElement) && !modalOpen()) focusFirst(['section.ib-pane [data-reply-button]', 'section.ib-pane h2.ib-subject', '.ib-main h1']);
  }, 400);
}

/** A tour setting that did not save is tried again after these waits (ms), then said. */
const TOUR_SAVE_RETRY_MS = [1000, 4000];
/** How long the first-run screen waits for the settings before it draws without them. */
const SETTINGS_LATE_MS = 1500;

/** How often the first-run screen reads the agents again while it shows, and the least gap between two reads (focus and the timer). */
const FIRST_RUN_AGENTS_REFRESH_MS = 8_000;
const FIRST_RUN_AGENTS_MIN_GAP_MS = 2_000;

function platformOf(): ConnectContext['platform'] {
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'mac';
  return 'linux';
}

/** A reply is being typed: the box holds unsent text, or a text field has focus. The sound dialog waits. */
function replyInProgress(): boolean {
  if (unsentReply()) return true;
  const active = document.activeElement as HTMLElement | null;
  return !!active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
}

/**
 * The list options dialog waits (its claim unspent, or a claimed one unopened) while anything else is over the page or
 * a reply is under way: another dialog, a modal panel ui draws (`aria-modal`), an image opened full size, a pinned
 * reference card, a reply being typed, or a reply box left open with words or files in it, wherever focus is.
 */
function listIntroHeldBack(): boolean {
  if (modalOpen() || replyInProgress() || replyBeingWritten()) return true;
  return document.querySelector('[role="dialog"][aria-modal="true"], [data-image-lightbox], [data-ref-card-pinned]') !== null;
}

/** Rows the person reads in place: the folded Snoozed band alone holds nothing still, so a read is adopted whole. */
function hasRows(sections: readonly InboxListSection[] | null): boolean {
  return !!sections && sections.some((s) => s.id !== 'snoozed' && s.threads.length > 0);
}

function Inbox() {
  const [route, setRoute] = useState<Route>(() => {
    settleTourEntry();
    return readRoute();
  });
  // Open or closed as the person left it (⌘B or the toggle): a cookie of the Inbox's own, open when absent.
  const [sidebarOpen, setSidebarOpen] = useState(() => storage.getItem(SIDEBAR_OPEN_COOKIE) !== 'false');
  const changeSidebar = useCallback((next: boolean) => {
    setSidebarOpen(next);
    storage.setItem(SIDEBAR_OPEN_COOKIE, String(next));
  }, []);
  const [latest, setLatest] = useState<ListModel | null>(null);
  /**
   * Linked machines (docs/agent-guides/inbox-machines.md): every machine and its state, from the merged list and
   * the stream's `machines` frames. Nothing draws from it while no machine is linked (machines.ts).
   */
  const [machineViews, setMachineViewsNow] = useState<MachineView[] | null>(null);
  // Every list read carries the machines; the same ones keep the same model, so a list read rebuilds nothing.
  const setMachineViews = useCallback(
    (next: MachineView[]) => setMachineViewsNow((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next)),
    [],
  );
  const machines = useMemo(() => machinesModel(machineViews), [machineViews]);
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  /** Writes held for other machines, by key (the outbox's own frames keep it): "Sending…" until their machine answers. */
  const [outbox, setOutbox] = useState<ReadonlyMap<string, OutboxView>>(() => new Map());
  /** The list's ⋯ menu "Hide offline machines": this browser's choice, like the sidebar's open sections. */
  const [hideAway, setHideAwayState] = useState(() => storage.getItem(HIDE_AWAY_MACHINES_COOKIE) === 'true');
  const setHideAway = useCallback((next: boolean) => {
    setHideAwayState(next);
    storage.setItem(HIDE_AWAY_MACHINES_COOKIE, String(next));
  }, []);
  // Once a machine is linked: the writes this Inbox holds for one, and the notices about ones that did not land. The
  // `outbox` frames keep them; every `machines` snapshot (sent when the stream opens, so after each reconnect) reads
  // them again whole, so a frame lost in a reconnect never leaves "Will send when … is back" beside a delivered reply.
  const anyMachineLinked = machines.linked.length > 0;
  const outboxRead = useRef(0);
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;
  /** Read the held writes again; answers the machines whose pending writes settled meanwhile. */
  const reloadOutbox = useCallback(async (): Promise<Set<string>> => {
    const mine = ++outboxRead.current;
    try {
      const { waiting, notices } = await inboxApi.outbox();
      if (mine !== outboxRead.current) return new Set();
      const next = new Map([...waiting, ...notices].map((entry) => [entry.key, entry] as const));
      // A frame that landed while this read was out may be newer: an entry settled here never goes back to waiting.
      const pendingState = (entry: OutboxView) => entry.state === 'queued' || entry.state === 'sending';
      for (const [key, entry] of next) {
        const current = outboxRef.current.get(key);
        if (current && !pendingState(current) && pendingState(entry)) next.set(key, current);
      }
      const settled = new Set<string>();
      for (const entry of outboxRef.current.values()) {
        const now = next.get(entry.key);
        if ((entry.state === 'queued' || entry.state === 'sending') && (!now || (now.state !== 'queued' && now.state !== 'sending'))) settled.add(entry.machine);
      }
      setOutbox(next);
      return settled;
    } catch {
      return new Set();
    }
  }, []);
  useEffect(() => {
    if (anyMachineLinked) void reloadOutbox();
  }, [anyMachineLinked, reloadOutbox]);
  const dismissOutbox = useCallback((key: string) => {
    setOutbox((current) => {
      const entry = current.get(key);
      return entry ? new Map(current).set(key, { ...entry, dismissed: true }) : current;
    });
    void inboxApi.dismissOutbox(key).catch(() => {});
  }, []);
  /**
   * Decision mode (experimental, approval "inbox-decision-mode"): the
   * projection while the feature is on, and the sitting (open, or tucked
   * into its pill behind a thread). Off, nothing of it renders. Thread only
   * (owner, 2026-10-27): a sitting is one thread's decisions (`thread`), opened
   * from that thread's open-questions list; there is no global way in.
   */
  const [decisions, setDecisions] = useState<InboxDecision[] | null>(null);
  // `startNonce`: a new start while the sitting is open moves it to that card.
  const [decide, setDecide] = useState<{ thread: string; title: string | null; tucked: boolean; start: string | null; startNonce: number } | null>(null);
  /** What opened decision mode: focus goes back there when the sitting ends. */
  const decideOpener = useRef<HTMLElement | null>(null);
  const [decideLeft, setDecideLeft] = useState(0);
  const [decidePaused, setDecidePaused] = useState(0);
  const decisionModeOnRef = useRef(false);
  const questionListeners = useRef(new Set<(question: InboxQuestion) => void>());
  /**
   * Thread steps' changes (approval "inbox-thread-steps"): a `steps` record names its thread; presence moving
   * (`event: deliveries`), a reconnect and a catch-up name every thread. The open thread's steps read again.
   */
  const [stepsBus] = useState(createStepsBus);
  /**
   * The questions the open thread is saving, whether one's record came meanwhile (`held`: those records), and the
   * reads they owe (`onPickSaves`): `read` everything, as for a record no one placed; `readHeld` what the held
   * records owe, at once; `readOwn` what a run with no record held owes (the list, the decisions, the drafts).
   */
  const pickSaves = useRef({ saving: new Set<string>() as ReadonlySet<string>, owed: false, held: [] as InboxEvent[], read: () => {}, readOwn: () => {}, readHeld: (_held: InboxEvent[]) => {} });
  /** What this window's own question saves brought back: their records are echoes, not news (ownSaves.ts). */
  const [ownSaves] = useState(createOwnSaves);
  const subscribeQuestions = useCallback((listener: (question: InboxQuestion) => void) => {
    questionListeners.current.add(listener);
    return () => void questionListeners.current.delete(listener);
  }, []);
  const refreshDecisions = useCallback(async () => {
    if (!decisionModeOnRef.current) return;
    try {
      const next = await inboxApi.decisions();
      // A read that brought nothing new keeps the decisions drawn (listSame.ts `keepSame`): nothing is drawn again.
      if (decisionModeOnRef.current) setDecisions((current) => keepSame(current, next.decisions));
    } catch {
      // Off on the server (another window turned it off): the next settings read says so.
    }
  }, []);
  /** The latest list read's sections, for the event stream's `deliveries` (which reads again only while a delivery can move). */
  const latestSectionsRef = useRef<ListModel['sections'] | null>(null);
  latestSectionsRef.current = latest?.sections ?? null;
  // The tab's count (tabCount.ts): every thread with news the person has not looked at, from the
  // latest read (not the held list on screen, and not the sidebar's project filter).
  const faviconHref = useInboxFaviconHref();
  const faviconBadgeHref = useInboxFaviconBadgeHref();
  const faviconInUse = useInboxFavicon();
  useTabCount(useMemo(() => (latest ? inboxTabCount(latest.sections) : 0), [latest]), faviconHref, faviconBadgeHref);
  /** The list on screen: held until the person acts (the "N new" notice). */
  const [shown, setShown] = useState<InboxListSection[] | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  /**
   * When the list on screen was last sorted whole (listView.ts `ListSort`): every settle and adopt moves it on, a
   * row shown in place or one row moved alone does not. The List view keeps each row's place until it moves.
   */
  const [listSort, setListSort] = useState<ListSort>({ epoch: 0, keep: null });
  const sortedWhole = useCallback((keep: string | null = null) => setListSort((last) => ({ epoch: last.epoch + 1, keep })), []);
  /**
   * The threads whose opening look is on its way (sent, the list not read
   * again since): their rows on screen and the header read them as looked at
   * (held.ts `lookedRow`), so both offer Mark unread at once. A set: opening
   * A then B before A's look lands keeps A read too.
   */
  const [looking, setLooking] = useState<ReadonlySet<string>>(() => new Set());
  const stopLooking = useCallback((threadId: string) => {
    setLooking((current) => {
      if (!current.has(threadId)) return current;
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
  }, []);
  const [thread, setThread] = useState<InboxThread | null>(null);
  /** The open thread's files as its pane read them, for New message over it (null: no thread, or another machine's). */
  /** The open thread's own list row, from its read: an archived thread has none in the list. */
  const [threadRow, setThreadRow] = useState<InboxListRow | null>(null);
  // A launched thread's run line (the thread route's `run`; launch only): null while the agent rests.
  const [threadRun, setThreadRun] = useState<{ threadId: string; run: InboxRun | null; attach: string | null } | null>(null);
  /** The open thread's read when it has not landed: failed (read again soon) or missing (a 404). */
  const [threadLoad, setThreadLoadState] = useState<ThreadLoad | null>(null);
  const threadLoadRef = useRef<ThreadLoad | null>(null);
  const setThreadLoad = useCallback((next: ThreadLoad | null) => {
    const current = threadLoadRef.current;
    // The same failure again (a retry): nothing changes on screen, so nothing is said again.
    if (current && next && current.threadId === next.threadId && current.state === next.state && current.error === next.error) return;
    threadLoadRef.current = next;
    setThreadLoadState(next);
  }, []);
  /** Each read of a thread is numbered; an older one never overwrites a newer one that landed (A, then B, then A again). */
  const threadReadSeq = useRef(0);
  /**
   * The first merged list, read: until then the window does not know which machine owns an id, so a fresh load of
   * another machine's thread (`#thread=` after a reload, in a new tab) first reads it here and gets a 404. That 404
   * waits for this list and, when the list names another machine as the owner, reads the thread there.
   */
  const firstList = useRef<{ done: boolean; promise: Promise<void>; resolve: () => void } | null>(null);
  if (!firstList.current) {
    let resolve = () => {};
    const promise = new Promise<void>((r) => (resolve = r));
    firstList.current = { done: false, promise, resolve };
  }
  const threadReadApplied = useRef(0);
  /**
   * The open thread's first read numbered after its open (`after`: the last number before it), and the ids of the
   * messages that read had. Until it lands, the thread on screen may be a copy from an earlier visit (App keeps
   * `thread` while another thread's read is out): a permission card is counted as arrived only against this read.
   */
  const openRead = useRef<{ threadId: string; after: number } | null>(null);
  /** The thread the open effect last opened: Try again on the same thread is not a new open. */
  const openedFor = useRef<string | null>(null);
  const [openedWith, setOpenedWith] = useState<{ threadId: string; ids: ReadonlySet<string> } | null>(null);
  /** The open thread as last read, for the open effect when another read (the event stream's) landed first. */
  const threadLoaded = useRef<InboxThread | null>(null);
  /** When `threadLoaded` landed (Date.now()): an old read is read again on the next record (openThreadReads.ts). */
  const threadLoadedAt = useRef(0);
  /** Wakes the open effect's wait between retries when another read lands the thread. */
  const wakeThreadRetry = useRef<(() => void) | null>(null);
  /**
   * A re-read of the thread already on screen (a record's, a catch-up's) that failed: read again after
   * THREAD_READ_RETRY_MS, until one lands or the thread closes or changes. `attempt`: the failures so far.
   */
  const liveThreadRetry = useRef<{ threadId: string; attempt: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const stopLiveThreadRetry = useCallback(() => {
    if (liveThreadRetry.current) clearTimeout(liveThreadRetry.current.timer);
    liveThreadRetry.current = null;
  }, []);
  /** Focus was in the thread's place when it gave way to the thread: it goes to the thread's subject. */
  const focusThreadSubject = useRef(false);
  /** Try again on the placeholder: the open effect reads the thread at once. */
  const [threadRetry, setThreadRetry] = useState(0);
  /** When the open thread's first 404 waited for linked machines' lists (UNLISTED_WAIT_MS); cleared as it opens or closes. */
  const unlistedSince = useRef<{ threadId: string; at: number } | null>(null);
  useEffect(() => {
    unlistedSince.current = null;
  }, [route.thread]);
  /**
   * The open thread's "new since you looked" boundary (folding.ts), from
   * before this look, and `through`: what the window's looks this visit cover
   * (the newest agent message of the first read, raised as messages that
   * arrive while it is open are seen on sight, seenOnSight.ts). Null when the
   * thread carries no seqs (an older Inbox).
   */
  const [look, setLook] = useState<{ threadId: string; seq: number | null; through: number | null } | null>(null);
  const [settings, setSettings] = useState<SettingsModel | null>(null);
  /** The agents on this computer (GET /api/inbox/agents): the agent-note dialog and Settings → Agents. Null on an older Inbox. */
  const [agents, setAgentsState] = useState<InboxAgentsModel | null>(null);
  // Every read and every save of the agents takes a number; a read answered after a newer read or save
  // started (a re-read in flight while Turn on saved) never replaces the newer model.
  const agentsSeq = useRef(0);
  const setAgents = useCallback((next: InboxAgentsModel) => {
    agentsSeq.current += 1;
    setAgentsState(next);
  }, []);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  /** The first read of the agents is done (a run that opened the window has finished connecting): the agent-note dialog may decide. */
  const [agentsSettled, setAgentsSettled] = useState(false);
  /**
   * The one-time agent-note dialog: open on this load (with the agents it
   * asks about, fixed when it opens), or shown on it. Decided once per load,
   * after the sound dialog and never on a load that showed it. Since the note
   * is written by itself for the agents proven to load it (approval
   * "inbox-agent-note-auto"), it asks only about the others (Qwen Code,
   * Cursor's copy by hand).
   */
  const [agentNote, setAgentNote] = useState<'none' | 'shown' | { rows: InboxAgentRow[] }>('none');
  /**
   * The connect line above the list (ConnectLine: the last run's news and the
   * notes written by themselves), fixed when it first shows on this load; the
   * Inbox is told at once that it was said, so the next load is clear.
   */
  const [connectLine, setConnectLine] = useState<ReturnType<typeof connectLineNews> | 'gone'>(null);
  const agentNoteDecided = useRef(false);
  /** The note dialog was decided on this load (shown or not): state, so the notification lines re-render when it is. */
  const [agentNoteSettled, setAgentNoteSettled] = useState(false);
  /** The sound dialog's claim has answered on this load (or it was never due). */
  const [soundClaimed, setSoundClaimed] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  /** The last settings read failed (kept apart from settingsError, which a failed save also sets). */
  const [settingsReadFailed, setSettingsReadFailed] = useState(false);
  /** The first settings read is late: the first-run screen draws without it rather than wait blank. */
  const [settingsLate, setSettingsLate] = useState(false);
  const [update, setUpdate] = useState<InboxHealth['update']>(null);
  const [restarting, setRestarting] = useState(false);
  // What this page may offer: nothing to a tailnet guest, whom the update routes refuse.
  const pageUpdate = updateForPage(update, settings);
  // What's new only reads release notes: this computer's pages and the owner's over the tailnet, never a guest's.
  const pageWhatsNew = pageOffersWhatsNew(settings);
  // Checking for updates has failed for hours (packages/server/inbox-updates.ts): the sidebar's quiet row,
  // About's dot and the General row's line. Not on a tailnet guest's page.
  const [checkFailing, setCheckFailing] = useState<UpdateCheckFailing | null>(null);
  const pageCheckFailing = pageOffersUpdates(settings) ? checkFailing : null;
  // The sidebar toggle's dot while the sidebar is closed: an update the Update button offers, or checking failing.
  const updateState = pageUpdate?.state ?? null;
  const sidebarToggleNotice = useMemo(
    () => sidebarUpdateNotice(updateState, restarting, !!pageCheckFailing),
    [updateState, restarting, pageCheckFailing],
  );
  /** This run started on a newer version: the sidebar's "What's new in X" link. */
  const [updated, setUpdated] = useState<string | null>(null);
  // Claude Code sessions a /reload-plugins would bring up to date: the sidebar's "Reload Claude Code N" (owner approval "restart-warning").
  const [restartAgents, setRestartAgents] = useState<InboxRestartAgents>(NO_RESTART_AGENTS);
  /** The update control's dialogs and what they read (GET /api/inbox/update). */
  const [updateDialog, setUpdateDialog] = useState<null | 'update' | 'restart' | 'failed'>(null);
  /** The warning before a Mark read that sets questions aside, while it is up (`warnSetAside`). */
  const [readWarning, setReadWarning] = useState<{ count: SetAsideCount; bulk: boolean; answer: (answer: SetAsideAnswer) => void } | null>(null);
  /** The update dialog for a linked machine (approval "inbox-machine-update"), and whether Snooze opened it. */
  const [machineUpdateOpen, setMachineUpdateOpen] = useState<{ id: string; snooze: boolean } | null>(null);
  const [updateDetails, setUpdateDetails] = useState<UpdateDetails | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  /** The person pressed Update now in this tab: once the new binary is in, the Inbox restarts itself. */
  const restartWhenReady = useRef(false);
  const [whatsNew, setWhatsNew] = useState<WhatsNewModel | null>(null);
  const [whatsNewError, setWhatsNewError] = useState<WhatsNewError | null>(null);
  /** What's new's releases panel: loaded once per visit to the page, kept across switches between releases (no flash). */
  const [whatsNewReleases, setWhatsNewReleases] = useState<WhatsNewReleasesModel | null>(null);
  /** The person's Try again on What's new (each press asks GitHub once more, for the release it was pressed on). */
  const [whatsNewRetry, setWhatsNewRetry] = useState(0);
  const whatsNewRetryFor = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The one-time sound dialog: open on this load, or shown on it (then the notification ask line waits for another load). */
  const [soundDialog, setSoundDialog] = useState<'none' | 'open' | 'shown'>('none');
  /**
   * The one-time list options dialog (approval "inbox-list-options-intro") on this load: not shown, claimed (the
   * Inbox gave it to this page; it opens once the page is free), open, or closed. `listIntroDecided`: this load
   * asked the Inbox and has its answer. `listIntroLatch`: the list as this load began with it, read once when
   * the first list and settings are in (a list that grows later never brings it up mid-session); whether the Inbox has
   * it due for this load follows the line (`lineLatch`).
   * `tourThisLoad`: the tour was on screen in this load, so the dialog never shows on it. `listIntroSettled`: the
   * Inbox page (the list, a thread open or not) has been clear for `LIST_INTRO_SETTLED_MS` since it last came back.
   */
  const [listIntro, setListIntro] = useState<'none' | 'claimed' | 'open' | 'shown'>('none');
  const [listIntroDecided, setListIntroDecided] = useState(false);
  const listIntroAsked = useRef(false);
  const listIntroLatch = useRef<{ owner: boolean; firstRun: boolean; rows: number } | null>(null);
  const [listIntroSettled, setListIntroSettled] = useState(false);
  /**
   * A one-time dialog of the line is claimed or open now (a reveal's, voice's, the star ask's, Code review's offer):
   * with the dialogs App keeps itself, the load arms nothing else meanwhile (`lineLatch`). Set from the hooks' stages.
   */
  const [lineStagesBusy, setLineStagesBusy] = useState(false);
  /** The Sidebar tip is claimed or up now (its hook comes after the others'). */
  const [lineTipBusy, setLineTipBusy] = useState(false);
  /** When a date can next change the line, on this page's clock (settings `reveal.again_in` at its read), or null. */
  const [lineAgainAt, setLineAgainAt] = useState<number | null>(null);
  /** The list's rows, for "a question waits in the open thread" (`openThreadAsks`) in checks that run on a timer. */
  const oneTimeRows = useRef<readonly InboxListRow[]>([]);
  /** An update dialog or a restart was on screen in this load: no Snooze announcement on it. */
  const updatingThisLoad = useRef(false);
  /** This page snoozed something in this load: the announcement would tell the person what they just did. */
  const snoozedThisLoad = useRef(false);
  const tourThisLoad = useRef(false);
  /** Sidebar → Feedback (components/FeedbackDialog.tsx): open only on the person's click. */
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const soundDialogAsked = useRef(false);
  /** Voice's moment (approval "inbox-one-time-dialogs"): when this page last sent a reply of 40 words or more, for a minute. */
  const [voiceMomentAt, setVoiceMomentAt] = useState<number | null>(null);
  const voiceMoment = voiceMomentAt !== null;
  useEffect(() => onReplySent((reply) => reply.words >= VOICE_INTRO_MIN_WORDS && setVoiceMomentAt(reply.at)), []);
  useEffect(() => {
    if (voiceMomentAt === null) return;
    const timer = setTimeout(() => setVoiceMomentAt(null), Math.max(0, voiceMomentAt + VOICE_INTRO_MOMENT_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [voiceMomentAt]);
  // What a dialog's moment reads about a thread the person had open (reveal.ts): kept as each thread loads.
  useEffect(() => {
    if (thread) noteRevealThread(thread);
  }, [thread]);
  const routeRef = useRef(route);
  routeRef.current = route;
  // The full-window review is open (set where it is worked out, below), for the Escape ladder.
  const reviewPaneOpenRef = useRef(false);
  // The review a link on a Shape board opened (approval "review-show-me", q-db7db55f): with Code review on it shows the
  // code and the board rides along as its corner card. Let go once that review closes.
  const [boardLink, setBoardLink] = useState<string | null>(null);
  useEffect(() => {
    if (!route.guide) setBoardLink(null);
  }, [route.guide]);
  // The view and panel a link left the board on: the review's board (the corner card's Grow) and Back open there.
  const boardPlaces = useBoardPlaces(route.shape ?? null);
  /**
   * Real messages that reached the person's Inbox while the tour ran (choice
   * 7): a chip in the tour bar, never an interruption. The tour is in front,
   * so they raise no notification and no sound; both resume when it ends.
   */
  const [tourArrivals, setTourArrivals] = useState<{ count: number; thread: string | null }>({ count: 0, thread: null });
  const sound = useInboxSound({
    settings: settings?.sound,
    onSettings: (next) => setSettings((current) => (current ? { ...current, sound: next } : current)),
  });
  /**
   * Search (the approved "inbox-search" design): the palette's code loads on
   * the first open and stays mounted after. It opens from the sidebar's
   * Search entry (and a phone's list header); no key opens it.
   */
  const [searchMounted, setSearchMounted] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpener = useRef<HTMLElement | null>(null);
  /** The landing a search result asked for: the query's words to highlight in that message, a question's card to focus. */
  const searchLanding = useRef<SearchLanding | null>(null);
  /** Decision mode's "Open the thread" (thread only): the question to land on, its prompt focused. */
  const decideLanding = useRef<{ messageId: string; questionKey: string } | null>(null);
  /**
   * Compose (a new message to a connected agent): open with what it starts
   * from (a draft, a session), and the drafts not sent (the sidebar's Drafts
   * row, the Drafts page).
   */
  const [compose, setCompose] = useState<ComposeRequest | null>(null);
  const composeOpener = useRef<HTMLElement | null>(null);
  /** New message opened from an older machine's Update ("Start an agent on <machine>"): its Send tells that machine's row it was asked. */
  const machineAskCompose = useRef<{ request: ComposeRequest; machine: string } | null>(null);
  /** Where focus goes once compose closes or a draft row goes: the opener, else `focusFallback(next)`. */
  const pendingFocus = useRef<{ opener: HTMLElement | null; next: string | null } | null>(null);
  const [drafts, setDrafts] = useState<DraftView[] | null>(null);
  /** Open threads holding unsent work (approval "inbox-reply-drafts"): the Drafts row counts them, its page lists them. */
  const [replyDrafts, setReplyDrafts] = useState<InboxReplyDraftRow[]>([]);
  /** The reply drafts as last read, for the reads that run outside a render (draftsReads.ts). */
  const replyDraftsRef = useRef(replyDrafts);
  replyDraftsRef.current = replyDrafts;
  /**
   * The open thread's reply draft and its files read again (signal.ts): a draft saved or discarded (`event: drafts`),
   * records that need only the files, a re-read of the thread. Signals draw nothing: a read that brings nothing new
   * leaves the window as it is.
   */
  const [draftSignal] = useState(createSignal);
  const [filesSignal] = useState(createSignal);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(() => storage.getItem(COMPOSE_LAST_COOKIE));
  /** The one toast (Mark read, Archive) with its Undo, and what the live region last said. */
  const [toast, setToast] = useState<InboxToastModel | null>(null);
  // The toast showing now, for a pane taking down only its own (`onToastGone`).
  const toastNow = useRef(toast);
  toastNow.current = toast;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When the toast's timer ends, and what was left of it while a swipe holds it. */
  const toastDeadline = useRef(0);
  const toastLeft = useRef<number | null>(null);
  const [said, setSaid] = useState('');
  /**
   * The live stream is dead (liveStream.ts: silent past its window, and a reconnect brought nothing): the list's
   * quiet "Reconnecting…" line, until the stream is heard again.
   */
  const [streamDead, setStreamDead] = useState(false);
  /** When the live region last said "Reconnecting…": said once, and not again for a while (a flaky network). */
  const reconnectSaidAt = useRef<number | null>(null);
  /**
   * This page is older than the Inbox it talks to (stalePage.ts): "Inbox updated to X · Reload". Checked with the
   * first list, on every (re)connect, and when the tab comes back (useStalePage).
   */
  /** The person's own Restart is on its way (it reloads the page by itself): the notice neither shows nor reads. */
  const stalePaused = useRef(false);
  stalePaused.current = restarting;
  const stalePage = useStalePage(undefined, () => stalePaused.current);
  const stalePageRef = useRef(stalePage);
  stalePageRef.current = stalePage;
  /** Reload was pressed: what the person wrote is being saved first. */
  const [staleReloading, setStaleReloading] = useState(false);
  /** The thread whose reply box opens once it is on screen (the warning toast's Reply). */
  const [replyFor, setReplyFor] = useState<string | null>(null);
  /** The thread pane on screen and whether anything covers it (ThreadPane's `onScreenChange`). */
  const threadOnScreenRef = useRef<{ threadId: string; covered: boolean } | null>(null);
  const [openThreadCovered, setOpenThreadCovered] = useState(false);
  const notifications = useInboxNotifications({
    settings: settings?.notifications ?? null,
    // New questions ring the doorbell on their own rules (sound.ts), whatever notifications say.
    onQuestions: sound.questionsArrived,
    // The bell owns a question's sound when it is on and armed and no other Inbox tab is in front (notify.ts adds: this tab away).
    bellCovers: () => sound.settings.enabled && sound.armed && !sound.otherTabInFront(),
    // Another Inbox tab in front raises what arrives; this one stays quiet.
    otherTabInFront: () => sound.otherTabInFront(),
    // A question in the thread the person has open and visible raises nothing (the tab in front is notify.ts's check).
    threadOnScreen: (threadId) => {
      const pane = threadOnScreenRef.current;
      return pane !== null && pane.threadId === threadId && !pane.covered && routeRef.current.thread === threadId;
    },
    onSettings: (next) => setSettings((current) => (current ? { ...current, notifications: next } : current)),
    // A click on a notification: the thread opens, and the list on screen catches up, even with a
    // thread open. The one exception to "the list holds still while a thread is open" (settle.ts):
    // the person was away, and the thread notified may not be on screen at all.
    // Decision mode is thread only (owner, 2026-10-27): a Stopped notification opens its thread too, never the dialog.
    openThread: (threadId) => {
      writeRoute({ page: 'inbox', project: null, thread: threadId });
      void refreshList(true);
    },
    // A click on a burst's notice: the list at rest, as it now is.
    openList: () => {
      writeRoute({ page: 'inbox', project: null, thread: null });
      void refreshList(true);
    },
  });
  const { observe: observeEvent, flush: flushNotifications, setReach: setNotifyReach, windowReport, reportWindow } = notifications;

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  /**
   * How a link to this Inbox opens in this window (links.ts), or null when it does not: the same history as a row or
   * a search result, so Back and a phone's stack treat it as one. The thread already open replaces its entry (once
   * `msg=` drops, a new one would equal the last and the first Back would do nothing).
   */
  const inboxLink = useCallback((href: string): (() => void) | null => {
    const now = settingsRef.current;
    const hash = inboxLinkHash(href, { origin: window.location.origin, addresses: [now?.url, now?.tailscale?.url] });
    if (hash === null) return null;
    return () => {
      searchLanding.current = null;
      const from = routeRef.current;
      const next = routeOf(hash);
      const beside = !!(from.file || from.guide || next.file || next.guide);
      if (from.page === 'inbox' && from.thread && from.thread === next.thread && !beside) writeRoute({ ...from, msg: next.msg }, { replace: true });
      // As a row click does (openRow): the list stays the one on screen, unless the link names its own.
      else if (from.page === 'inbox' && next.page === 'inbox' && next.thread) writeRoute({ ...next, project: next.project ?? from.project, machine: next.machine ?? from.machine, agent: next.agent ?? from.agent });
      else writeRoute(next);
      focusAfterOpen();
    };
  }, []);
  // Capture: ui's anchors would use the click first. They draw every full URL as a new tab, and a bare `#thread=` as a
  // heading link that finds no heading.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const link = event.target.closest('a[href]');
      // `data-local-link`: a link to an attached file, whose own click opens it as its tile does.
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute('download') || link.hasAttribute('data-local-link')) return;
      const open = inboxLink(link.getAttribute('href') ?? '');
      if (!open) return;
      if (isNewTabClick(event) || event.altKey) {
        // The browser's own new tab, which ui's handler on a bare `#thread=` link would cancel.
        event.stopPropagation();
        return;
      }
      // Over a dialog the screen would change out of sight, and a comment not saved yet would go with its file: a new tab keeps both.
      // The pane's own question (saved words compared), so a comment opened for editing and not changed is not unsaved.
      // Here a new tab keeps the comment; a link inside an attached HTML page goes through the pane, which keeps the words as the file's draft.
      if (link.closest('dialog') || inOverlay(link) || openPaneUnsaved()) {
        if (link.target) return;
        event.preventDefault();
        event.stopPropagation();
        window.open(link.href, '_blank', 'noopener,noreferrer');
        return;
      }
      event.preventDefault();
      open();
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, [inboxLink]);

  useEffect(() => {
    const onHash = () => {
      // A Back this window started: its rewrite of the entry it landed on comes first (history.ts settleLanding).
      settleLanding();
      stripClickSignal();
      settleReviewsAlias();
      stripStrayMsg();
      settleTourEntry();
      settleMovedSettings();
      const oldExperimental = settleOldExperimental();
      setRoute(oldExperimental ? { ...readRoute(), experimental: true } : readRoute());
    };
    // Back and Forward (finding F1): once the page they landed on has drawn, focus goes where its key would put
    // it, if the traversal took focus away. Not after a pointer (a mouse's Back button, a swipe): a row given
    // focus the person never chose is a row `E` would mark read.
    const onTraverse = () => {
      const from = routeRef.current;
      onHash();
      if (lastInput() === 'pointer') return;
      // A traversal that lands on the screen already shown (the same address) replaced nothing, so it took no focus
      // away: focus that is on the page stays there, as the person left it (opening a thread puts none in it). Moving
      // it here put keyboard focus on the thread's row, whose card then opened over a list the thread was covering.
      if (hashOf(from) === hashOf(readRoute())) return;
      const mark = inputMark();
      // Focus left in what the traversal replaced moves too (focusKept says what stays). Checked again a beat later: a thread drawn again may drop it then.
      // On a slow machine the page may not have drawn its targets by the first check: until one has taken focus,
      // each later check places it as the first would have.
      let placed = false;
      const place = (always: boolean) => {
        // A click or a key since this traversal (a timer left from an earlier Back can fire after one): focus stays
        // where that put it (a key's own move, an Escape's close, may not have landed yet).
        if (lastInput() === 'pointer' || actedSince(mark)) return;
        const active = document.activeElement;
        const to = readRoute();
        if (modalOpen()) return;
        if (!focusLost(active) && (!(always || !placed) || focusKept(active, to, from))) {
          placed = true;
          return;
        }
        if (focusFirst(backFocusTargets(to, from))) placed = true;
      };
      requestAnimationFrame(() => requestAnimationFrame(() => place(true)));
      setTimeout(() => place(false), 300);
      setTimeout(() => place(false), 1000);
    };
    stripClickSignal();
    settleReviewsAlias();
    stripStrayMsg();
    settleOldExperimental();
    settleMovedSettings();
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onTraverse);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onTraverse);
    };
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  // `.pn-inbox` in the page: html and body carry `data-pn-inbox` (pageMarks.ts). The root is drawn on every render.
  useLayoutEffect(() => markInboxPage(rootRef.current), []);
  const latestRef = useRef(latest);
  /** Why the last list read failed (null: it landed): the first read is tried again unless the Inbox refused it (firstListRead.ts). */
  const listReadFailure = useRef<unknown>(null);
  latestRef.current = latest;
  /**
   * The threads opened in this tab (a row, a link, a notification, Settings'
   * Unarchive). One not on screen whose messages are all seen came in by the
   * person's own hand, not an agent's (held.ts).
   */
  const openedHere = useRef(new Set<string>());
  if (route.thread) openedHere.current.add(route.thread);
  /** The rows as they were just before the list on screen changes, when that change slides (settle.ts). */
  const slideFrom = useRef<SettleSnapshot | null>(null);
  /** Measure the rows now, so the next change of the list on screen slides from here. Nothing under reduced motion. */
  const armSlide = useCallback(() => {
    const body = prefersReducedMotion() ? null : listBody(rootRef.current);
    slideFrom.current = body ? captureSettle(body) : null;
  }, []);
  /**
   * Show's brief light (design record "inbox-polish", item 6): the list on
   * screen when Show was pressed, until the list it brings in is drawn; then
   * the rows it brought in (held.ts showBroughtIn) light up where they landed,
   * once they have slid into place, and the light is taken off after it fades.
   * Only Show lights rows: not a thread's close, not the first load.
   */
  const showFrom = useRef<InboxListSection[] | null>(null);
  const { lit, unseen: unseenNew, light, go: goToNew } = useShowLight();
  /** The thread a compose send just started, to light once its row is drawn (see the layout effect on the list order). One-shot: taken on the next commit, found or not. */
  const [sentLight, setSentLight] = useState<{ thread: string } | null>(null);
  /** Clicking Inbox with a thread open: the close adopts the refresh's read instead of settling (refreshInbox). */
  const refreshPending = useRef(false);
  /** The refresh signal: the Inbox row's (or the list title's) refresh icon turns once. */
  const [refreshSpin, setRefreshSpin] = useState<{ key: number; scope: string | null } | null>(null);
  /** The settle waiting out its beat after a thread closed (settle.ts). */
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The thread just closed, until the list settles: like the open thread, it
   * is never held (held.ts): never in "N new", its row kept as it now is, and
   * it settles where its state puts it (design record "inbox-new-in-open-thread").
   */
  const closing = useRef<OpenThread | null>(null);
  /**
   * Rows this window's own snooze moved while the list held (`moveSnoozedRow`),
   * each with the list as drawn before it: an Unsnooze puts the row back there.
   * Emptied whenever the list settles or adopts, since the slots are gone then.
   */
  const snoozeMoved = useRef(new Map<string, InboxListSection[]>());
  /**
   * The thread the held list treats as open: the route's, else the one
   * closing (with its row as it stood at the close, so an agent message after
   * the close waits behind "N new" like any other); the close's own render
   * reads the route it leaves.
   */
  const heldOpen = (): OpenThread | null => {
    const open = routeRef.current.thread ?? (closing.current ? null : lastRoute.current.thread);
    return open ? { threadId: open } : closing.current;
  };
  const cancelSettle = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
  }, []);
  /**
   * The list on screen catches up: with the person's own reads and actions
   * (`own`: closing a thread; agent activity still waits behind "N new"), or
   * with everything (`all`: Show, another folder or page). `opening`: the
   * thread a covered list settles behind (a phone, a stacked window), which
   * settles as it now is, like the thread just closed.
   */
  const settleList = useCallback(
    (what: 'own' | 'all', slide: boolean, opening?: OpenThread) => {
      cancelSettle();
      // The thread just closed settles as it now is, an arrival there included (held.ts settleOwn).
      const closed = opening ?? closing.current;
      closing.current = null;
      const next = latestRef.current;
      if (!next) return;
      if (slide) armSlide();
      snoozeMoved.current.clear();
      const groups = listGroups(next);
      setShown((current) => (what === 'all' || current === null || !hasRows(current) ? groups : settleOwn(current, groups, openedHere.current, closed)));
      sortedWhole();
    },
    [armSlide, cancelSettle, sortedWhole],
  );
  useEffect(() => cancelSettle, [cancelSettle]);

  /** The newest list cursor taken, by Inbox run: a list read that brings nothing new keeps the list held, with its older cursor. */
  const listCursor = useRef<{ session: string; cursor: number } | null>(null);
  /** The Inbox's release at the page's first list read: a restarted Inbox on another one is never adopted (sessionAdopt.ts). */
  const loadedVersion = useRef<string | null>(null);
  /** The list header's Tidy hears a list read that brought nothing new (useTidy's `listRead`). */
  const listTidyRead = useRef<(() => void) | null>(null);
  /** The open thread was not here, and the list names the machine that holds it: open it there. */
  const retryMissingThread = () => {
    const open = routeRef.current.thread;
    const load = threadLoadRef.current;
    if (open && machineOf(open) && load?.threadId === open && load.state === 'missing') setThreadRetry((n) => n + 1);
  };
  /**
   * Read the list; `adopt` puts it on screen (an action, Show, or nothing on
   * screen yet), sliding the rows to their places when `slide` says so.
   */
  const refreshList = useCallback(async (adopt: boolean, slide = false, refresh?: { light?: boolean; keepOpen?: boolean }) => {
    try {
      const next = await inboxApi.list();
      const failedBefore = listReadFailure.current !== null;
      listReadFailure.current = null;
      // A read that lands after a newer one (a slow answer on a bad network, a catch-up's): the newer list stays.
      // Only an older cursor of the same Inbox run counts; an equal one may carry a delivery, a draft or a pin.
      const held = latestRef.current;
      // The newest cursor taken (a read with nothing new keeps the list held, and that list's older cursor).
      const newest = held && listCursor.current?.session === held.serverSession ? Math.max(listCursor.current.cursor, held.cursor) : held?.cursor;
      if (held && next.serverSession === held.serverSession && next.cursor < newest!) return held;
      listCursor.current = { session: next.serverSession, cursor: next.cursor };
      // Each machine's agents (agentsList.ts): their own store, so a read that moved only them never draws the list.
      setInboxAgents(next.agents);
      // Nothing new (listSame.ts): the list held stays, and nothing is drawn again. A row's own state shows in place
      // as before (an own write's row put back by the read, the open thread's row).
      if (!adopt && held && firstList.current!.done && sameListModel(held, next, { cursor: routeRef.current.page === 'settings' })) {
        // Only what moved is set. A set that changes nothing still draws the whole window once whenever the window's
        // last draw came from its own state (React draws it again to find out), so a read with nothing new drew it
        // now and then.
        const drawn = shownRef.current;
        if (drawn !== null && hasRows(drawn) && refreshHeldRows(drawn, listGroups(held), heldOpen()) !== drawn) {
          setShown((current) => (current === null || !hasRows(current) ? current : refreshHeldRows(current, listGroups(held), heldOpen())));
        }
        if (failedBefore) setLoadError(null);
        retryMissingThread();
        listTidyRead.current?.();
        return held;
      }
      // The release the Inbox ran at the page's first list read, the one its session is from (sessionAdopt.ts).
      if (!firstList.current!.done) loadedVersion.current = typeof next.version === 'string' ? next.version : null;
      setPageSession(next.serverSession);
      // Before the render: what waits on this read (Mark read after a look, markRead) reads the rows it brought.
      latestRef.current = next;
      setLatest(next);
      // The sessions' labels (issue #2450): every row's agents and the open thread's authors read them.
      setSessionLabels(next.session_labels);
      if (!firstList.current!.done) {
        firstList.current!.done = true;
        firstList.current!.resolve();
        perfFirstList(next.sections);
      }
      // Linked machines: the merged list names every machine and its state (an older Inbox names none).
      if (next.machines) setMachineViews(next.machines);
      retryMissingThread();
      if (adopt && slide) armSlide();
      // Show's light for a refresh (clicking Inbox): the rows it brings in, against the list on screen now.
      if (adopt && refresh?.light) showFrom.current = shownRef.current;
      // A refresh beside an open thread keeps that thread's row where it is on screen (held.ts adoptKeepingOpen).
      const keep = adopt && refresh?.keepOpen ? routeRef.current.thread : null;
      if (adopt) snoozeMoved.current.clear();
      setUpdate(next.update);
      setUpdated(next.updated ?? null);
      setRestartAgents(restartAgentsOf(next.restart_agents, next.restart_claude_code));
      setCheckFailing(next.update_check_failing ?? null);
      // Held: the order waits for an action, but each row's own state (a delivery, an agent's read) follows at once.
      const groups = listGroups(next);
      setShown((current) =>
        current === null || !hasRows(current)
          ? groups
          : adopt
            ? keep
              ? adoptKeepingOpen(current, groups, keep)
              : groups
            : refreshHeldRows(current, groups, heldOpen()),
      );
      if (adopt) sortedWhole(keep);
      setLoadError(null);
      return next;
    } catch (cause) {
      listReadFailure.current = cause;
      setLoadError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [armSlide, sortedWhole]);
  /**
   * The list read again after a snooze changed or ran out, whichever said so first (`event: snoozes`, or this
   * window's clock). With no thread open only the rows whose snooze changed move (held.ts `snoozeChangedRows`), each
   * alone and with the settle's slide; nothing is sorted whole, so the person's pending reads and archives keep their
   * places (approval "inbox-list-view", R7) and a return by the clock waits behind "N new".
   */
  const refreshSnoozes = useCallback(async () => {
    const next = await refreshList(false);
    if (next) flushNotifications(next);
    void refreshDecisions();
    const drawn = shownRef.current;
    if (routeRef.current.thread || !next || !drawn) return;
    const groups = listGroups(next);
    const moving = snoozeChangedRows(drawn, groups);
    if (moving.length === 0) return;
    armSlide();
    setShown((current) => (current ? moving.reduce((list, threadId) => settleThread(list, groups, threadId), current) : current));
  }, [refreshList, flushNotifications, refreshDecisions, armSlide]);

  /**
   * Seen on sight (seenOnSight.ts): messages that arrived in the open thread
   * have been on screen; record the look up to `through` (never past it) and
   * let the row unbold in place. `look.through` rises only once the server
   * took the look; a look that failed is sent again (a few times, waiting
   * longer each time) unless a later one covers it.
   */
  const lookRef = useRef(look);
  lookRef.current = look;
  /** Per thread, the furthest look on its way to the server. */
  const seenPosting = useRef(new Map<string, number>());
  /**
   * Per thread, the looks this tab has sent (the open look, seen on sight) and
   * the list read after each, until they land. Mark read waits for them, so it
   * decides on the state the look gives the thread whenever it is pressed
   * (markRead.ts `seenHeldInNew`).
   */
  const looksInFlight = useRef(new Map<string, Set<Promise<unknown>>>());
  const trackLook = useCallback((threadId: string, look: Promise<unknown>) => {
    const looks = looksInFlight.current;
    const mine = looks.get(threadId) ?? new Set<Promise<unknown>>();
    looks.set(threadId, mine);
    mine.add(look);
    const done = () => {
      mine.delete(look);
      if (mine.size === 0 && looks.get(threadId) === mine) looks.delete(threadId);
    };
    look.then(done, done);
  }, []);
  const seenRetries = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const retries = seenRetries.current;
    return () => {
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
    };
  }, []);
  const seenOnSight = useCallback(
    (threadId: string, through: number) => {
      const current = lookRef.current;
      if (!current || current.threadId !== threadId || (current.through !== null && current.through >= through)) return;
      if ((seenPosting.current.get(threadId) ?? -1) >= through) return;
      seenPosting.current.set(threadId, through);
      const attempt = (tries: number) => {
        const look = inboxApi
          .seen(threadId, through)
          .then(() => {
            if (seenPosting.current.get(threadId) === through) seenPosting.current.delete(threadId);
            const now = lookRef.current;
            if (now && now.threadId === threadId && (now.through === null || now.through < through)) {
              const next = { ...now, through };
              lookRef.current = next;
              setLook(next);
            }
            return refreshList(false);
          })
          .catch(() => {
            // A later look on its way covers this one.
            if (seenPosting.current.get(threadId) !== through) return;
            if (tries >= SEEN_RETRIES) {
              seenPosting.current.delete(threadId);
              return;
            }
            const timer = setTimeout(() => {
              seenRetries.current.delete(timer);
              attempt(tries + 1);
            }, SEEN_RETRY_MS * 2 ** tries);
            seenRetries.current.add(timer);
          });
        trackLook(threadId, look);
      };
      attempt(0);
    },
    [refreshList, trackLook],
  );

  const refreshThread = useCallback(async (threadId: string) => {
    const mine = ++threadReadSeq.current;
    // A thread being opened (not a re-read of the one on screen): pn:thread-open runs until its messages are drawn.
    if (threadLoaded.current?.thread_id !== threadId) perfThreadOpenStart(threadId);
    // The machine this read goes to: null is this Inbox (or an owner not learned yet).
    const askedOwner = machineOf(threadId);
    try {
      const next = await inboxApi.thread(threadId, THREAD_READ_TIMEOUT_MS);
      // Its code fences' grammars and KaTeX are chunks loaded on first use (#2593): the thread draws once
      // they are in, so its code paints highlighted and its math typeset, never plain first.
      await threadDrawReady(next.thread);
      if (unlistedSince.current?.threadId === threadId) unlistedSince.current = null;
      if (routeRef.current.thread === threadId && mine > threadReadApplied.current) {
        threadReadApplied.current = mine;
        // A re-read of the thread on screen keeps what did not change as the same objects (shareUnchanged.ts):
        // a window left open on a busy thread no longer holds a full copy of it per message that came in.
        const before = threadLoaded.current;
        const reread = before?.thread_id === threadId;
        const read = reread ? shareUnchanged(before, next.thread) : next.thread;
        // Every real read reads the thread's files again too (pickQueue.ts's onlyQuestionsChanged counts on a read's
        // objects being new): a read that brought nothing new keeps the thread object (and one that changed only
        // questions keeps the pane's files revision), so it says so here. Any other change reads them by itself.
        if (reread && onlyQuestionsChanged(before, read)) filesSignal.emit();
        threadLoaded.current = read;
        threadLoadedAt.current = Date.now();
        wakeThreadRetry.current?.();
        stopLiveThreadRetry();
        setThread(read);
        // The row and the run line as drawn when this read brought them unchanged: nothing is drawn again for them.
        setThreadRow((current) => keepSame(current, next.row ?? null));
        setThreadRun((current) => keepSame(current, next.run === undefined ? null : { threadId, run: next.run, attach: next.attach_command ?? null }));
        setThreadLoad(null);
        perfThreadReadLanded(threadId, next.thread.messages.length, true);
        // The open's first fresh read: what the thread opened with (never a stale copy shown before it landed).
        const opening = openRead.current;
        if (opening?.threadId === threadId && mine > opening.after) {
          openRead.current = null;
          setOpenedWith({ threadId, ids: new Set(next.thread.messages.map((m) => m.id)) });
        }
        // What is new since the last look, from the first read of this thread:
        // it lands before the window records the look, and is kept until the person leaves the thread.
        setLook((current) => (current?.threadId === threadId ? current : { threadId, seq: lookBoundary(next.thread), through: latestAgentSeq(next.thread) }));
      } else perfThreadReadLanded(threadId, null, routeRef.current.thread === threadId);
      return next.thread;
    } catch (cause) {
      perfThreadOpenDropped(threadId);
      // Not on this Inbox, asked before the list named each id's machine: once the first list is read (it may have landed
      // while this read was out; else wait a few seconds at most), read the thread on the machine it names.
      let waiting: string | null = null;
      if (cause instanceof InboxApiError && cause.status === 404 && !askedOwner) {
        if (!machineOf(threadId) && !firstList.current!.done) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([firstList.current!.promise, new Promise((r) => (timer = setTimeout(r, FIRST_LIST_WAIT_MS)))]);
          clearTimeout(timer);
        }
        if (machineOf(threadId) && routeRef.current.thread === threadId) return refreshThread(threadId);
        // Just started (a restart, an update): a linked machine whose list this Inbox has not read yet may hold it.
        // Not "deleted" then: read again on the usual schedule, and the thread opens once that list names it. Only a
        // machine that can still send one counts (one that needs an update or removed the link never will), and only
        // for UNLISTED_WAIT_MS; after that it is missing, and a later list naming its machine opens it there (refreshList).
        const unread = (latestRef.current?.machines ?? []).filter((m) => !m.self && m.list_cursor === null && m.state !== 'needs_update' && m.state !== 'revoked');
        const since = unlistedSince.current?.threadId === threadId ? unlistedSince.current.at : Date.now();
        unlistedSince.current = { threadId, at: since };
        if (unread.length > 0 && Date.now() - since < UNLISTED_WAIT_MS) {
          waiting = unread.length === 1 ? `Waiting for ${unread[0]!.name}: this thread may be there.` : 'Waiting for linked machines: this thread may be on one of them.';
        }
      }
      if (routeRef.current.thread === threadId && mine > threadReadApplied.current) {
        const missing = cause instanceof InboxApiError && cause.status === 404 && !waiting;
        // Two linked machines claim it: it opens on neither, and says so (no retry would change that).
        const refused = cause instanceof InboxApiError && cause.code === 'machine_conflict';
        if (missing) setThread(null);
        setThreadLoad({ threadId, state: refused ? 'refused' : missing ? 'missing' : 'failed', error: cause instanceof Error ? cause.message : String(cause), waiting });
        // The thread is on screen already (the open effect retries a first read itself): this re-read is tried again,
        // or what it would have brought (an agent's new message) waits until some other record re-reads the thread.
        if (!missing && !refused && threadLoaded.current?.thread_id === threadId) {
          const attempt = liveThreadRetry.current?.threadId === threadId ? liveThreadRetry.current.attempt : 0;
          stopLiveThreadRetry();
          const timer = setTimeout(() => {
            if (routeRef.current.thread === threadId) void refreshThread(threadId);
            else stopLiveThreadRetry();
          }, THREAD_READ_RETRY_MS[Math.min(attempt, THREAD_READ_RETRY_MS.length - 1)]!);
          liveThreadRetry.current = { threadId, attempt: attempt + 1, timer };
        }
      }
      return null;
    }
  }, [setThreadLoad, stopLiveThreadRetry]);

  /** A settings read arrived: the moment the Inbox named for the line, kept on this page's clock (`useLineLatch`). */
  const noteLineAgain = useCallback((reveal: SettingsModel['reveal']) => {
    setLineAgainAt(typeof reveal?.again_in === 'number' ? Date.now() + reveal.again_in : null);
  }, []);
  /**
   * The line of one-time dialogs, read again (reveal.ts `useLineLatch`: once, at the moment the Inbox named, and after
   * a dialog of this load is claimed): only what the line says moves (which dialog is next, the list options and voice
   * dialogs' `due`), so nothing else on the page changes. Quiet: a read that fails waits for the next settings read.
   */
  const rereadLine = useCallback(() => {
    void inboxApi
      .settings()
      .then((next) => {
        noteLineAgain(next.reveal);
        setSettings((current) =>
          current
            ? {
                ...current,
                reveal: next.reveal,
                list_intro: next.list_intro,
                snooze_intro: next.snooze_intro,
                voice: current.voice && next.voice ? { ...current.voice, intro_due: next.voice.intro_due } : current.voice,
              }
            : current,
        );
      })
      .catch(() => {});
  }, [noteLineAgain]);

  const refreshSettings = useCallback(async () => {
    // The agent icons' faces ride with every settings read: on load, and after the stream was away.
    void readAgentFaces();
    try {
      const mark = listLookReadMark();
      const reactionsMark = reactionsReadMark();
      const sidebarMark = sidebarLayoutReadMark();
      const next = await inboxApi.settings();
      adoptSavedTheme(next.theme);
      adoptSavedTextSize(next.text_size);
      adoptSavedFavicon(next.favicon);
      adoptSavedReactions(next.reactions, next.reactions_rev, reactionsMark);
      adoptSavedRows(next.rows, next.rows_rev, mark);
      adoptSavedSidebar(next.sidebar, next.sidebar_rev, sidebarMark);
      adoptSavedDiffOptions(next.diff_options, next.diff_style);
      // The name on the person's comments on the PR page and the review, as plan and code review read it; nothing posted
      // carries it. Only with Code review on: off, every comment reads as on main.
      if (next.display_name && next.code_review?.on) configStore.init({ displayName: next.display_name });
      adoptVoiceSettings(next.voice);
      noteLineAgain(next.reveal);
      setSettings(next);
      setSettingsReadFailed(false);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
      setSettingsReadFailed(true);
    }
  }, []);

  // Settings → Storage's sizes (GET /api/inbox/settings/storage): the server walks every file for them, so only that
  // panel asks, each time it is shown. Kept for the visit. One read at a time, given up after STORAGE_READ_MS so a
  // held connection never locks Storage; a Delete's answer carries fresh sizes and wins over a read that started
  // before it. A read starting clears the last error, so Try again shows the wait again. A failed refresh of sizes
  // already kept leaves them on screen without a word: they are this visit's numbers, read again on the next open.
  const [store, setStore] = useState<InboxStorageModel | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const storeReading = useRef(false);
  const storeTurn = useRef(0);
  const adoptStore = useCallback((next: InboxStorageModel) => {
    storeTurn.current += 1;
    setStore(next);
    setStoreError(null);
  }, []);
  const readStore = useCallback(() => {
    if (storeReading.current) return;
    storeReading.current = true;
    setStoreError(null);
    const turn = storeTurn.current;
    inboxApi
      .storage()
      .then(
        (next) => {
          if (turn === storeTurn.current) adoptStore(next);
        },
        (cause) => setStoreError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => {
        storeReading.current = false;
      });
  }, [adoptStore]);

  const refreshDrafts = useCallback(async () => {
    try {
      const next = await inboxApi.drafts();
      // A read that brought nothing new keeps the drafts drawn (listSame.ts `keepSame`): nothing is drawn again.
      setDrafts((current) => keepSame(current, next.drafts));
      setReplyDrafts((current) => keepSame(current, next.replies ?? []));
      setDraftsError(null);
    } catch (cause) {
      setDraftsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);
  /**
   * The Board's cards (approval "inbox-board", step 2): read only while the
   * person has the Board on, once it is known to be on and again when a card
   * line arrives on the event stream, so the Board updates in place. With the
   * Board off nothing reads them (a card line on the stream is skipped too).
   */
  const [cards, setCards] = useState<CardsModel | null>(null);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const cardsSeq = useRef(0);
  /** Whether the Board is on (`boardEnabled` below), for the reads that run outside a render. */
  const boardOnRef = useRef(false);
  /** When the last cards read started: an opened `#` preview reads them only when that is older than 5 s. */
  const cardsReadAt = useRef(0);
  const refreshCards = useCallback(async (): Promise<CardsModel | null> => {
    if (!boardOnRef.current) return null;
    const mine = ++cardsSeq.current;
    cardsReadAt.current = Date.now();
    try {
      const next = await inboxApi.cards();
      // An older read never replaces a newer one that landed first.
      if (mine === cardsSeq.current) {
        setCards(next);
        setCardsError(null);
      }
      return next;
    } catch (cause) {
      if (mine === cardsSeq.current) setCardsError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, []);
  /**
   * A visit to the Board: the person's look as it stood when the visit began
   * (cards an agent wrote to after it are bold for the whole visit, as a
   * thread keeps "New since you looked"), and the cards they opened or moved
   * since (no longer bold). Opening the Board records a new look through the
   * newest card it read, so the next visit is bold only for what came after.
   */
  const [boardVisit, setBoardVisit] = useState<{ look: number | null; handled: ReadonlySet<string> } | null>(null);
  /**
   * The Board is something the person turns on (config.json `inboxBoard`,
   * approval "inbox-board" 2026-10-26): null until the settings are read; an
   * Inbox that predates the switch always has it.
   */
  const boardEnabled = settings ? (settings.board ? settings.board.on : true) : null;
  boardOnRef.current = boardEnabled === true;
  // Shape (approval "shape-inbox-placement"): only while the person turned it on. Off, nothing is read and nothing shows.
  // A tailnet guest never: the server refuses it the routes. The owner over the tailnet has it, as at the desk.
  const shapeOn = settings?.shape?.on === true && settings.guest !== true;
  const codeReviewOn = settings?.code_review?.on === true;
  // The boards, and every Shape piece in a review (Show me, the Overview's picture, boards over it), ride Shape's own
  // switch: Code review on brings none of them (approval "code-review-029-shape-off"). With both on, as before.
  const boardsOn = shapeOn;
  // The review skills a Send pastes carry their drawing lines only while Shape is on.
  setReviewSkillsShape(shapeOn);
  // Chapter diagrams (Settings → Capabilities, under Code review; on unless turned off): off, the review skills a Send
  // pastes carry no diagram line, and a guide that still has a chapter diagram draws it folded.
  const chapterDiagramsOn = settings?.chapter_diagrams?.on !== false;
  setReviewSkillsDiagrams(chapterDiagramsOn);
  const shapes = useInboxShapes(boardsOn, subscribeShapeFrames);
  const wakeOnChange = useRef(codeReviewOn);
  wakeOnChange.current = codeReviewOn;
  const shapeHost = useMemo(
    () => createInboxShapeHost({
      subscribe: shapes.subscribe,
      command: connectCommand(settings?.mcp_command ?? null),
      wakeOnChange: () => wakeOnChange.current,
      openIn: settings?.code_review?.on === true,
    }),
    [shapes.subscribe, settings?.mcp_command, settings?.code_review?.on],
  );
  // A `#shapes` link while Shape is off (or never on): the list, in its place.
  useEffect(() => {
    if (settings && !shapeOn && route.page === 'shapes') writeRoute({ page: 'inbox', project: null, thread: null }, { replace: true });
  }, [settings, shapeOn, route.page]);
  useEffect(() => {
    if (boardEnabled !== true) {
      // Off (or not known yet): no card is read, and none kept from before it was turned off.
      cardsSeq.current++;
      setCards(null);
      return;
    }
    void refreshCards();
  }, [boardEnabled, refreshCards]);
  const onBoard = route.page === 'board' && boardEnabled === true;
  /**
   * The project the Board is filtered to (`#board&project=prj_…`). A project the Inbox does not
   * know (a stale or hand-edited link) is no filter once the projects have loaded; before that the
   * id filters as it stands, so a filtered link never flashes every card.
   */
  const boardFilter =
    route.page === 'board' && route.project && (latest === null || latest.projects.some((p) => p.id === route.project)) ? route.project : null;
  /**
   * The initiative the Board is filtered to (`#board&initiative=ini_…`, or `none`; approval
   * "board-initiatives"). One the Inbox does not hold (deleted, a stale link) is no filter once the
   * cards have loaded; before that the id filters as it stands.
   */
  // `#` in a composer names these (approval "board-hashtags"): the Board's live initiatives, with their cards counted.
  // The live initiatives, the same array while their ids and names stay: every message's tag links
  // (`linkHashtags`) follow it, so a list or cards read that changes neither redraws no message.
  const initiativesKey = liveInitiatives(cards?.initiatives)
    .map((i) => `${i.id}\u0000${i.name}`)
    .join('\u0001');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ids and names, on purpose
  const tagInitiatives = useMemo(() => liveInitiatives(cards?.initiatives), [initiativesKey]);
  // An opened preview reads the cards again (a tag written since in a thread no card links), at most once in 5 s.
  const refreshForPeek = useCallback(() => {
    if (Date.now() - cardsReadAt.current < 5_000) return;
    void refreshCards();
  }, [refreshCards]);
  const initiativeTags = useMemo<InitiativeTags>(() => {
    const counts = new Map<string, number>();
    const live = (cards?.cards ?? []).filter((card) => card.column !== 'dropped');
    for (const card of live) if (card.initiative) counts.set(card.initiative, (counts.get(card.initiative) ?? 0) + 1);
    const rows = new Map<string, InboxListRow>();
    for (const row of [...(latest?.sections.flatMap((s) => s.threads) ?? []), ...(latest?.snoozed ?? []), ...(latest?.pins ?? [])]) if (!rows.has(row.thread_id)) rows.set(row.thread_id, row);
    // A thread the list leaves out (archived) still has its row in the cards payload.
    for (const [id, row] of Object.entries(cards?.threads ?? {})) if (row && !rows.has(id)) rows.set(id, row);
    const projects = new Map((latest?.projects ?? []).map((p) => [p.id, p.name] as const));
    const mentions = new Map(Object.entries(cards?.initiative_threads ?? {}));
    return { initiatives: tagInitiatives, counts, cards: live, rows, projects, mentions, refresh: refreshForPeek };
  }, [cards, latest, tagInitiatives, refreshForPeek]);
  const boardInitiative = route.page === 'board' ? boardInitiativeOf(route.initiative, cards ? liveInitiatives(cards.initiatives) : null) : null;
  useEffect(() => {
    if (!onBoard) {
      setBoardVisit(null);
      return;
    }
    let live = true;
    void refreshCards().then((model) => {
      if (!live || !model) return;
      setBoardVisit({ look: model.seen_seq ?? null, handled: new Set() });
    });
    return () => {
      live = false;
    };
  }, [onBoard, refreshCards]);
  /**
   * The look is recorded once per visit, and only while the Board shows every project: a visit
   * filtered to one project never had the others' cards on screen, so their news stays bold (review
   * of #2284). A visit that starts filtered and then shows every project records it then, through
   * the latest read's cursor (every line up to it is on the page). An Inbox before step 2 has no
   * look to record (no `seen_seq`): nothing is bold beyond this visit there.
   */
  const lookRecorded = useRef(false);
  const boardShowsAll = onBoard && boardFilter === null && boardInitiative === null;
  useEffect(() => {
    if (!boardVisit) {
      lookRecorded.current = false;
      return;
    }
    if (lookRecorded.current || !boardShowsAll || !cards || cards.seen_seq === undefined) return;
    lookRecorded.current = true;
    void inboxApi.seeBoard(cards.cursor).catch(() => {});
  }, [boardVisit, boardShowsAll, cards]);
  const handleCard = (id: string) =>
    setBoardVisit((visit) => (visit && !visit.handled.has(id) ? { ...visit, handled: new Set([...visit.handled, id]) } : visit));
  const moveCard = async (card: InboxCardWire, change: BoardMove): Promise<InboxCardWire | null> => {
    handleCard(card.id);
    try {
      const { card: moved } = await inboxApi.moveCard(card.id, change);
      setCards((model) => (model ? { ...model, cards: model.cards.map((c) => (c.id === moved.id ? moved : c)) } : model));
      void refreshCards();
      return moved;
    } catch {
      void refreshCards();
      return null;
    }
  };
  const seeDrops = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    void inboxApi
      .seeDrops(ids)
      .then(() => refreshCards())
      .catch(() => {});
  }, [refreshCards]);

  // The Drafts page follows each draft's session (live, ended) while it is open.
  useEffect(() => {
    if (route.page !== 'drafts') return;
    void refreshDrafts();
    const timer = setInterval(() => void refreshDrafts(), DRAFTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [route.page, refreshDrafts]);

  /** Read the agents; while `plannotator inbox` is still connecting them, read again until it is done. */
  const refreshAgents = useCallback(async () => {
    try {
      const mine = ++agentsSeq.current;
      const next = await inboxApi.agents();
      if (mine === agentsSeq.current) setAgentsState(next);
      return next;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The page can load before the run that opened it starts connecting, so read once more a moment later.
    let extra = 1;
    const read = async () => {
      const next = await refreshAgents();
      if (cancelled) return;
      if (next?.connecting || extra-- > 0) timer = setTimeout(() => void read(), next?.connecting ? 1500 : 2500);
      else setAgentsSettled(true);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshAgents]);
  // Settings → Agents reads them again each time it opens: an agent installed meanwhile shows at once.
  const agentsSection = route.page === 'settings' && route.section === 'agents';
  // While it is open it follows the agent sessions too: a session that restarts leaves "Open sessions" by itself.
  useEffect(() => {
    if (!agentsSection) return;
    void refreshAgents();
    const timer = setInterval(() => void refreshAgents(), AGENTS_SESSIONS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [agentsSection, refreshAgents]);

  const loadUpdateDetails = useCallback(async () => {
    try {
      const next = await inboxApi.updateDetails();
      setUpdateDetails(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  // First read, then the event stream keeps the counts, the open thread and the notice live.
  useEffect(() => {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    let draftsTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * One list read for the events of a short pause that only move rows (pins, deliveries, a draft saved), however
     * many came (#2593). A record's read, which starts after them, covers it: it is dropped then.
     */
    let eventListTimer: ReturnType<typeof setTimeout> | null = null;
    const listAfterEvents = (delay: number) => {
      if (eventListTimer) clearTimeout(eventListTimer);
      eventListTimer = setTimeout(() => {
        eventListTimer = null;
        void refreshList(false);
      }, delay);
    };
    let snoozesTimer: ReturnType<typeof setTimeout> | null = null;
    let cardsTimer: ReturnType<typeof setTimeout> | null = null;
    let machinesTimer: ReturnType<typeof setTimeout> | null = null;
    let machineThreadTimer: ReturnType<typeof setTimeout> | null = null;
    /** The machines as last read (state and list cursor each), and whether one was linked. */
    let machinesSignature = '';
    let machinesLinked = false;
    // Which machines are linked: a link made or removed changes what the list is, not only its rows' states.
    let machinesSet = '';
    let machinesAdopt = false;
    let cancelled = false;
    /** The records since the last read: the open thread is read again only when they can change it (openThreadReads.ts). */
    let batch = newRecordBatch();
    /**
     * `own`: the record only echoes this window's own question save (ownSaves.ts): it owes the list, the decisions and
     * the drafts, never the open thread or its files, which the pane drew from the save's answer. `now`: read at
     * once, the records still waiting their pause too (a run of saves that just ended: its reads were held already).
     */
    const readAfterRecord = (event: InboxEvent | null, how: { own?: string; now?: boolean } = {}) => {
      // Every answer this window's saves brought back so far is covered by the read about to start (ownSaves.ts).
      if (how.now) ownSaves.readsStarted();
      if (how.own) noteOwnRecord(batch, how.own);
      else noteRecord(batch, event);
      if (timer) clearTimeout(timer);
      // Debug log on only (perfMarks.ts): when the event was heard, for pn:record-refresh.
      const heard = perfStart();
      const readNow = () => {
        timer = null;
        const records = batch;
        batch = newRecordBatch();
        // This read starts after every event that asked for one meanwhile: it is theirs too.
        if (eventListTimer) clearTimeout(eventListTimer);
        eventListTimer = null;
        const listRead = refreshList(false);
        void listRead.then((next) => next && flushNotifications(next));
        void refreshDecisions();
        const open = routeRef.current.thread;
        let threadRead: Promise<unknown> = Promise.resolve(null);
        if (open) {
          const load = threadLoadRef.current;
          const read = openThreadRead(records, {
            threadId: open,
            remote: machineOf(open) !== null,
            loaded: threadLoaded.current,
            loadedAt: threadLoadedAt.current,
            now: Date.now(),
            settled: load === null || load.threadId !== open,
            listed: listsThread(latestRef.current, open),
          });
          if (read === 'thread') threadRead = refreshThread(open);
          else {
            // What a read that brought nothing new did besides: the thread's files are read again. Not for an echo
            // of the window's own saves alone: a pick moves no file.
            if (read === 'files') filesSignal.emit();
            // Gone from the list this read brought (deleted elsewhere, which no record says): read it, as before.
            void listRead.then((next) => {
              if (routeRef.current.thread === open && !listsThread(next, open)) void refreshThread(open);
            });
          }
        }
        // pn:record-refresh: the event heard → the list and the open thread read again and drawn.
        if (heard !== null) void Promise.allSettled([listRead, threadRead]).then(() => perfUntilNextFrame('record-refresh', heard));
        // Picks and comments are unsent work too: the Drafts row follows them. Read only when these records can change
        // the drafts (draftsReads.ts): of a thread holding unsent work now, or after them (the list read says), or not
        // placed, or when the list read's rows holding unsent work are not the reply drafts shown (a deleted thread or
        // project, which no record says). The Drafts page, which shows each draft's session too, reads after every record, as before.
        const holding = new Set([...replyDraftsRef.current.map((row) => row.thread_id), ...unsentThreads(latestRef.current)]);
        if (routeRef.current.page === 'drafts' || draftsReadOwed(records, holding)) void refreshDrafts();
        else
          void listRead.then((next) => {
            // A failed list read says nothing: the drafts are read, as before.
            if (!next || draftsReadOwed(records, unsentThreads(next)) || replyDraftsDiffer(replyDraftsRef.current, next)) void refreshDrafts();
          });
      };
      if (how.now) readNow();
      else timer = setTimeout(readNow, 80);
    };
    /** The question record's thread, when this window's own save explains it (ownSaves.ts); null: news. */
    const ownEcho = (event: InboxEvent): string | null =>
      event.kind === 'question' && typeof event.thread_id === 'string' && event.thread_id !== '' && ownSaves.explains(event.question) ? event.thread_id : null;
    // The window's own pick saves owe a read with no record of their own: everything is read, the open thread too.
    pickSaves.current.read = () => readAfterRecord(null);
    // A run of saves on the open thread ended with no record held: what shows the pick besides the pane, at once.
    pickSaves.current.readOwn = () => {
      const open = routeRef.current.thread;
      // No thread open (a save that landed after its pane closed): the list, as before.
      if (open) readAfterRecord(null, { own: open, now: true });
      else void refreshList(false);
    };
    // A run of saves ended with their records held: one read for them all, at once. An echo of the window's own save
    // reads what shows the pick besides the pane (the list, the decisions, the drafts); anything else, what it owes.
    pickSaves.current.readHeld = (held) => {
      if (held.length === 0) return readAfterRecord(null, { now: true });
      held.forEach((event, i) => {
        const own = ownEcho(event);
        readAfterRecord(own ? null : event, { ...(own ? { own } : {}), now: i === held.length - 1 });
      });
    };
    let adopting = false;
    /** A `hello` from a run that is not the page's: take its session when it is the same Inbox, data and release (sessionAdopt.ts). */
    const adoptAfterRestart = async (hello: RestartHello) => {
      if (adopting || cancelled) return;
      adopting = true;
      try {
        const result = await adoptRestartedInbox(hello, {
          pageSession: pageServerSession,
          loadedVersion: () => loadedVersion.current,
          pageCursor: () => listCursor.current?.cursor ?? null,
          readHealth: () => inboxApi.healthWithin(STALE_HEALTH_MS),
          // What a reload would bring, before any write carries the new session.
          catchUp: async () => {
            const open = routeRef.current.thread;
            const [list] = await Promise.all([refreshList(false), open ? refreshThread(open) : null, refreshDrafts(), refreshSettings()]);
            // The run the read came from (a read that changed nothing answers the list held, which names the old run).
            return cancelled || !list ? null : (listCursor.current?.session ?? null);
          },
          adopt: adoptPageSession,
        });
        // The open thread's look was refused while the page carried the old session: recorded now, once.
        const open = routeRef.current.thread;
        // A browser proof's log (sharedEvents.ts `trace`): what the page decided, and why not.
        const log = (globalThis as { __plannotatorInboxEventLog?: unknown }).__plannotatorInboxEventLog;
        if (Array.isArray(log) && result.state !== 'same') log.push({ type: 'session', ...result, at: Date.now() });
        if (result.state === 'adopted' && !cancelled && open && threadLoaded.current?.thread_id === open) {
          await inboxApi.seen(open, latestAgentSeq(threadLoaded.current)).catch(() => {});
          void refreshList(false);
        }
      } finally {
        adopting = false;
      }
    };
    // Listen to the tabs' shared stream before the first read, so nothing passed on between the read and the subscription is lost (sharedEvents.ts).
    prepareInboxEvents();
    let settingsAsked = false;
    let firstListTimer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      // A first read that fails is read again until it lands (firstListRead.ts): the page listens only from then on.
      const first = await readFirstList({
        read: async () => {
          const next = await refreshList(true);
          // As before, right after the first try, landed or not.
          if (!settingsAsked) void refreshSettings();
          settingsAsked = true;
          return next;
        },
        landed: () => latestRef.current,
        refused: () => listReadRefused(listReadFailure.current),
        cancelled: () => cancelled,
        wait: (ms) =>
          new Promise<void>((done) => {
            firstListTimer = setTimeout(done, ms);
          }),
        // The settings read went out with the read that failed, and most likely failed with it.
        onLateLanding: () => void refreshSettings(),
      });
      if (cancelled || !first) {
        // No subscription follows (the effect ended, or the Inbox refused the first read): close the early channel.
        discardPreparedInboxEvents();
        return;
      }
      // The threads already here: a later line of one of their roots is never a new thread (notify.ts).
      flushNotifications(first);
      // A page older than this Inbox (a phone's tab restored from its cache): the stale page notice.
      stalePageRef.current.saw(first.version);
      unsubscribe = subscribeInboxEvents(first.cursor, {
        onRecord: (event) => {
          // A Board card (approval "inbox-board"): only the Board reads it; it never changes the list or a thread.
          // A Board initiative (approval "board-initiatives") reaches the Board through its cards' read too.
          if (event?.kind === 'card' || event?.kind === 'initiative') {
            if (cardsTimer) clearTimeout(cardsTimer);
            cardsTimer = setTimeout(() => void refreshCards(), 60);
            return;
          }
          // A thread's steps (approval "inbox-thread-steps"): silent. Never a notification, unread, or a list or thread
          // read: only the open thread's checklist reads them again. The checklist lives only in its thread (owner,
          // 2026-11-09): no list row or Board card shows it.
          if (event?.kind === 'steps') {
            stepsBus.emit(event.thread_id);
            return;
          }
          // A thread's PRs (approval "inbox-pr-binding"): silent, like steps. The thread's button and an open card
          // read them again, and the list (its rows' marks).
          if (event?.kind === 'thread_pull') {
            threadPullsBus.emit(event.thread_id);
            listAfterEvents(120);
            return;
          }
          // Any other record may be a message that tags a thread (the person's own send too): the next `#`
          // preview reads the cards again, whatever the 5 s guard says.
          cardsReadAt.current = 0;
          const now = routeRef.current;
          if (now.page === 'tour' && event?.kind === 'message' && event.first && event.message.author.kind === 'agent') {
            const threadId = event.message.thread_id;
            setTourArrivals((current) => ({ count: current.count + 1, thread: threadId }));
          }
          // The tour's cards (steps 1 to 10) in front: the chip says it, nothing rings. Everywhere else, step 11
          // included (it sends the person to get their first question), and with the tab in the background,
          // notifications and the sound work as always, so nothing is ever passed over unseen.
          if (!(now.page === 'tour' && (now.step ?? 1) < TOUR_STEPS && tourPageInFront())) observeEvent(event);
          if (event?.kind === 'question') for (const listener of questionListeners.current) listener(event.question);
          // The record of a question this window is saving: read once, when the last of them lands (onPickSaves).
          if (event?.kind === 'question' && pickSaves.current.saving.has(`${event.question.message_id}/${event.question.key}`)) {
            pickSaves.current.owed = true;
            pickSaves.current.held.push(event);
            return;
          }
          // The record of a save of this window that already landed (it came after the save's answer): it owes what
          // shows the pick besides the pane, never the open thread or its files; nothing once that read started after
          // the save's answer (the run's end read it).
          const own = event ? ownEcho(event) : null;
          if (own && event?.kind === 'question' && ownSaves.covered(event.question)) {
            emitFloaterEvent('record', null);
            return;
          }
          readAfterRecord(event, own ? { own } : {});
          // A floating draft's window reads its thread again (a new message, a hand-off).
          emitFloaterEvent('record', null);
        },
        // A reply draft was saved or discarded (here or in another window): the rows' `unsent` and the Drafts row.
        // Its own timer: sharing the record timer let a draft save cancel a record's pending reads (the open thread's).
        // A compose draft (null) was saved, deleted or sent: only the drafts read; it changes no list row (a Send's
        // new thread comes with its own record).
        onDrafts: (threadId) => {
          // The open thread's own copy of its draft follows at once (the foot's Send carries those words).
          if (threadId !== null && threadId === routeRef.current.thread) draftSignal.emit();
          // A floating draft's window follows, and a draft set aside floats once its save landed.
          emitFloaterEvent('draft', threadId);
          if (draftsTimer) clearTimeout(draftsTimer);
          draftsTimer = setTimeout(() => void refreshDrafts(), 80);
          if (threadId !== null) listAfterEvents(80);
        },
        // An Ask AI chat changed; the window reads it, and nothing else on the page depends on it.
        onAsk: emitAskChange,
        // The sidebar's pins changed (here, in another window, or a deleted thread left them): read `pins` again.
        onPins: () => listAfterEvents(60),
        // The pinned artifacts changed (another window, a phone): read them again (artifactPins.ts).
        onArtifactPins: () => void readArtifactPins(),
        // `plannotator inbox --open <thread>` (a tool on this computer): the window the person used last shows the
        // thread as a row click would. A new history entry, so Back returns; the reply being typed is kept as its draft.
        onShow: (threadId, target) => {
          if (target !== windowReport().id) return;
          const now = routeRef.current;
          if (now.page === 'inbox' && now.thread === threadId && !now.file && !now.guide) return;
          writeRoute({ page: 'inbox', project: now.page === 'inbox' && !now.machine ? now.project : null, thread: threadId });
        },
        // A snooze changed (another window, a phone, a linked machine) or ran out: read the list. It is the person's
        // own act, so with no thread open the row goes to its place, as it does in the window they did it in; a return
        // waits behind "N new" (held.ts). A return may ask something: notifications read this list too.
        onSnoozes: () => {
          if (snoozesTimer) clearTimeout(snoozesTimer);
          snoozesTimer = setTimeout(() => void refreshSnoozes(), 60);
        },
        // A thread's PRs read behind the window's answer changed their checks or review: the cards showing them read again.
        onThreadPulls: (threadIds) => {
          for (const id of threadIds) threadPullsBus.emit(id);
        },
        // How the rows look was saved (here, another window, a phone): every list takes it at once.
        // One at or below the last event's count (the count gone back, or a late copy): the settings read decides.
        onRows: (rows, rev, last) => hearRowsEvent(rows, rev, () => void refreshSettings(), last),
        onSidebar: (sidebar, rev) => hearSidebarEvent(sidebar, rev, () => void refreshSettings()),
        // An agent icon's face was saved (here, another window, a phone): every icon of that agent redraws at once.
        onAgentFaces: (data) => hearAgentFacesEvent(data),
        onReactions: (reactions, rev) => hearReactionsEvent(reactions, rev),
        // A capability switch saved here or in another window (approval "inbox-thread-steps"; the Board too): every window follows.
        onCapabilities: (capabilities) => {
          // Code review and Shape move the "/" list: the next box reads the catalog again.
          if (capabilities.code_review || capabilities.shape) reloadSkillCatalog();
          // The Board too (its sidebar row; capabilities.ts): settings sync everywhere.
          if (namesCapability(capabilities)) setSettings((current) => (current ? withCapabilities(current, capabilities) : current));
          else void refreshSettings();
        },
        onStatus: (next, nextUpdated, nextRestart, nextAgents, nextFailing) => {
          setUpdate(next);
          if (nextUpdated !== undefined) setUpdated(nextUpdated);
          if (nextAgents !== undefined || nextRestart !== undefined) setRestartAgents(restartAgentsOf(nextAgents, nextRestart));
          if (nextFailing !== undefined) setCheckFailing(nextFailing);
        },
        // Whether any open Inbox tab can show a notification (Settings → General).
        onReach: setNotifyReach,
        // The live sessions moved (approval "inbox-row-delivery"): read the list again while a row's
        // delivery can still change (queued, sending, saved, not delivered), so its glyph follows.
        onDeliveries: (change) => {
          // A launched thread's run line moves with the same signature: the open one is read again.
          const open = routeRef.current.thread;
          if (open && threadLoaded.current?.thread_id === open && threadLoaded.current.messages[0]?.launch) void refreshThread(open);
          // Whether a thread's agent can answer Ask AI moves with them.
          emitAskChange(null);
          // So does each steps list's presence (the in-progress mark turns only while its session works): read
          // again only where a list shows.
          stepsBus.emit('presence');
          // A session's label changed (issue #2450), or one ended or came back: the list carries both, so it is read again.
          if (!deliveriesReadList(change, latestSectionsRef.current, inboxAgentsWatched())) return;
          listAfterEvents(80);
        },
        // Every (re)connect: the permission now, since a reconnect's URL may be stale.
        // Shape's boards changed (only sent while Shape is on).
        onShapes: (ids) => {
          for (const listener of shapeFrameListeners) listener(ids);
        },
        onConnect: (hello) => {
          // The Inbox restarted under this page: when it is provably the same one, writes go on without a reload.
          if (hello) void adoptAfterRestart(hello);
          // A reconnect may have missed `event: shapes`: the boards are read again.
          for (const listener of shapeFrameListeners) listener([]);
          reportWindow();
          emitAskChange(null);
          stepsBus.emit('*');
          threadPullsBus.emit('*');
          // The Inbox may have restarted onto a newer release while this page stayed open.
          stalePageRef.current.recheck();
        },
        // The stream went silent past its window (or the tab came back after it): read what a record would make the
        // page read, once, so a message that arrived meanwhile is on screen. Never while the stream is heard.
        onCatchUp: () => {
          emitAskChange(null);
          void refreshList(false).then((next) => next && flushNotifications(next));
          void refreshDecisions();
          const open = routeRef.current.thread;
          if (open) void refreshThread(open);
          void refreshDrafts();
          // A steps line meanwhile (a record, so replayed too, but read once here like the thread).
          stepsBus.emit('*');
          threadPullsBus.emit('*');
          // A card record reads the Board: while it is open, it is read again too.
          if (routeRef.current.page === 'board') void refreshCards();
          // The rows' look another window saved meanwhile (`event: rows` is not replayed): the settings read has it.
          void refreshSettings();
        },
        onLive: (live) => setStreamDead(!live),
        // Linked machines. A record from another machine: a live one rings like this Inbox's own (a resync after a
        // reconnect never does), and the open thread follows when it is that machine's. Its row moves once this Inbox
        // has read that machine's list again, which the `machines` frame says.
        onMachine: (frame) => {
          if (frame.live && frame.record) observeEvent(frame.record);
          const open = routeRef.current.thread;
          if (!open || machineOf(open) !== frame.machine) return;
          if (machineThreadTimer) clearTimeout(machineThreadTimer);
          machineThreadTimer = setTimeout(() => void refreshThread(open), 80);
        },
        onMachines: (next) => {
          setMachineViews(next);
          // A machine's state or its list moved: read the merged list. Only while a machine is (or just was) linked,
          // so an Inbox that never links reads nothing more than before.
          const linked = next.some((m) => !m.self);
          if (linked) {
            // The held writes, whole: a snapshot follows every reconnect, and an `outbox` frame may have been missed. One
            // that settled meanwhile is in its thread now: the open thread of that machine is read again.
            void reloadOutbox().then((settled) => {
              const open = routeRef.current.thread;
              const owner = open ? machineOf(open) : null;
              if (open && owner && settled.has(owner)) void refreshThread(open);
            });
          }
          const signature = next.map((m) => `${m.id}:${m.state}:${m.list_cursor ?? ''}`).join('|');
          if ((!linked && !machinesLinked) || signature === machinesSignature) return;
          machinesLinked = linked;
          machinesSignature = signature;
          // Each linked machine, and whether its list has been read yet (its rows arrive with that first read).
          const set = next.filter((m) => !m.self).map((m) => `${m.id}:${m.list_cursor === null ? 0 : 1}`).sort().join('|');
          // A machine linked (its first rows) or unlinked (here, or from its side): the list on screen takes the new one at once, so an
          // unlinked machine's rows go with it (the open thread keeps its place). Otherwise its rows follow as any agent's do.
          // Sticky until the read: a frame right after must not turn an adopting read back into a held one.
          machinesAdopt ||= set !== machinesSet;
          machinesSet = set;
          if (machinesTimer) clearTimeout(machinesTimer);
          machinesTimer = setTimeout(() => {
            const adopt = machinesAdopt;
            machinesAdopt = false;
            void refreshList(adopt, false, adopt ? { keepOpen: true } : undefined).then((list) => list && flushNotifications(list));
          }, 60);
        },
        onOutbox: (entry) => {
          setOutbox((current) => new Map(current).set(entry.key, entry));
          // Delivered: the reply is in that machine's thread now; the open thread shows it there.
          const open = routeRef.current.thread;
          if (entry.state === 'delivered' && open && machineOf(open) === entry.machine) void refreshThread(open);
          // Its machine's link went (here, or on that machine): what waited for it was not sent, and its thread is gone
          // from this list. Said at once; Settings → Machines keeps the words to copy.
          if (entry.state === 'dropped' && entry.machine_name && entry.notice && !entry.dismissed) {
            showToast(
              {
                icon: 'warn',
                lead: `Not sent to ${entry.machine_name}: it is no longer linked.`,
                detail: 'Settings → Machines keeps the words.',
                wrap: true,
              },
              UNSENT_TOAST_MS,
            );
          }
        },
      }, windowReport());
    })();
    return () => {
      cancelled = true;
      pickSaves.current.read = () => {};
      pickSaves.current.readOwn = () => {};
      pickSaves.current.readHeld = () => {};
      if (firstListTimer) clearTimeout(firstListTimer);
      discardPreparedInboxEvents();
      unsubscribe();
      if (timer) clearTimeout(timer);
      if (eventListTimer) clearTimeout(eventListTimer);
      if (draftsTimer) clearTimeout(draftsTimer);
      if (cardsTimer) clearTimeout(cardsTimer);
      if (snoozesTimer) clearTimeout(snoozesTimer);
      if (machinesTimer) clearTimeout(machinesTimer);
      if (machineThreadTimer) clearTimeout(machineThreadTimer);
    };
  }, [refreshList, refreshSnoozes, refreshSettings, refreshThread, refreshDrafts, refreshCards, refreshDecisions, observeEvent, flushNotifications, setNotifyReach, windowReport, reportWindow]);

  // Opening a thread: read it, record the look, and update its row in place.
  // While any thread is open the list holds still (settle.ts): the look
  // unbolds the row where it is and does not re-sort the list. Where the
  // thread covers the list, the list catches up now, out of sight, before the
  // look (so the row being opened keeps its place): Back shows it as left.
  useEffect(() => {
    const threadId = route.thread;
    if (!threadId) {
      setThread(null);
      setThreadRow(null);
      setThreadRun(null);
      setLook(null);
      setThreadLoad(null);
      openRead.current = null;
      openedFor.current = null;
      setOpenedWith(null);
      return;
    }
    // A new open (not Try again on the same thread): what it opened with comes from its first read numbered after now.
    if (openedFor.current !== threadId) {
      openedFor.current = threadId;
      openRead.current = { threadId, after: threadReadSeq.current };
      setOpenedWith(null);
    }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    threadLoaded.current = null;
    // The thread's place, if it held focus, gives it to this thread's subject (ThreadWait's onFocusLeaving).
    focusThreadSubject.current = false;
    /** Another read (the event stream's) already put this thread on screen. */
    const landed = () => (threadLoaded.current?.thread_id === threadId ? threadLoaded.current : null);
    void (async () => {
      let opened: InboxThread | null = null;
      // A read that fails (or has no answer in THREAD_READ_TIMEOUT_MS) is read again (THREAD_READ_RETRY_MS)
      // while the thread stays open; a 404 is not.
      for (let attempt = 0; !opened; attempt++) {
        opened = (await refreshThread(threadId)) ?? landed();
        if (cancelled) return;
        if (opened) break;
        // Another thread opened meanwhile, or the server said this one is not there.
        if (routeRef.current.thread !== threadId || (threadLoadRef.current?.threadId === threadId && (threadLoadRef.current.state === 'missing' || threadLoadRef.current.state === 'refused'))) return;
        const waitMs = THREAD_READ_RETRY_MS[Math.min(attempt, THREAD_READ_RETRY_MS.length - 1)]!;
        await new Promise<void>((done) => {
          retry = setTimeout(done, waitMs);
          wakeThreadRetry.current = done;
        });
        retry = null;
        wakeThreadRetry.current = null;
        if (cancelled) return;
        opened = landed();
      }
      closing.current = null;
      // The thread opening settles as it now is too: an agent message the list
      // held there is the person's to read now, not news for "N new". Held,
      // its row kept the state the list showed (Quiet, say) and Back, which
      // settles nothing when every message is seen, left it there with its
      // questions open.
      if (listCovered() && COVERED_LIST_SETTLES === 'while-covered') settleList('own', false, { threadId });
      // The look covers what this read showed, not a message that lands before the server takes it.
      // Until it lands and the list is read again, the row and the header read it as looked at (`looking`).
      setLooking((current) => (current.has(threadId) ? current : new Set(current).add(threadId)));
      const look = (async () => {
        try {
          await inboxApi.seen(threadId, latestAgentSeq(opened)).catch(() => {});
          // Read the list even when another thread opened meanwhile: this row leaves `looking` next, and must
          // then show the server's row (read), not the one from before the look (bold).
          await refreshList(false);
        } finally {
          stopLooking(threadId);
        }
      })();
      trackLook(threadId, look);
      await look;
    })();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      wakeThreadRetry.current = null;
      // Closed or changed: a failed re-read of this thread is not tried again.
      stopLiveThreadRetry();
    };
  }, [route.thread, threadRetry, refreshThread, refreshList, settleList, trackLook, stopLiveThreadRetry, stopLooking]);
  // The thread landed while focus was in its place: focus goes to its subject, never to the page.
  useLayoutEffect(() => {
    if (!focusThreadSubject.current || !thread || thread.thread_id !== route.thread) return;
    focusThreadSubject.current = false;
    rootRef.current?.querySelector<HTMLElement>(`section.ib-pane[data-thread-id="${CSS.escape(thread.thread_id)}"] .ib-subject`)?.focus();
  }, [thread, route.thread]);

  // When the list on screen catches up as the route changes (settle.ts).
  // Another page or folder: the list there is drawn as it is now. A thread
  // opening, or replacing another: nothing moves (a slide still playing
  // stops). The thread closing: the person's own reads and actions settle, a
  // beat after the list has widened (at once under reduced motion, with no
  // slide); where the thread covered the list, COVERED_LIST_SETTLES decides.
  // After a keyboard close, focus that the closed pane took with it goes to
  // the thread's row.
  const lastRoute = useRef({ page: route.page, project: route.project ?? null, machine: route.machine ?? null, agent: route.agent ?? null, thread: route.thread });
  /** The docked sidebar is held closed beside a file (#1871); the close gives it back, so the settle waits for its spring. */
  const sidebarHeldNow = useRef(false);
  useLayoutEffect(() => {
    const before = lastRoute.current;
    const now = { page: route.page, project: route.project ?? null, machine: route.machine ?? null, agent: route.agent ?? null, thread: route.thread };
    lastRoute.current = now;
    if (before.page === now.page && before.project === now.project && before.machine === now.machine && before.agent === now.agent && before.thread === now.thread) return;
    // Another project, machine or agent (the sidebar's filters) is another list: it shows whole.
    if (!(before.page === 'inbox' && now.page === 'inbox' && before.project === now.project && before.machine === now.machine && before.agent === now.agent)) {
      settleList('all', false);
      return;
    }
    const body = listBody(rootRef.current);
    if (now.thread) {
      // A thread opens: the list holds still, so a settle waiting out its beat
      // never comes, and one still sliding stops where the rows belong.
      cancelSettle();
      if (body) stopSettle(body);
      return;
    }
    const closed = before.thread;
    if (!closed) return;
    // Closed by clicking Inbox: the refresh's read is adopted whole (refreshInbox), so nothing settles here.
    if (refreshPending.current) {
      closing.current = null;
      return;
    }
    closing.current = { threadId: closed, asOf: (latestRef.current ? listGroups(latestRef.current) : []).flatMap((section) => section.threads).find((row) => row.thread_id === closed) ?? null };
    // A thread opened from search or a link may have no row on screen (Quiet folded, another project): the
    // Quiet band, else the first row, so focus is never left on the page. Checked now and once the thread's pane
    // has gone (what had focus in it may outlive this commit by a frame).
    const keepFocus = () => {
      const active = document.activeElement;
      if (!body || lastInput() !== 'keyboard' || (active && active !== document.body && active.isConnected && active.getClientRects().length > 0)) return;
      if (routeRef.current.thread || routeRef.current.page !== 'inbox') return;
      // The list draws some rows twice (the wide and the three-line row), one hidden: the one on screen.
      const shown = (selector: string) => [...body.querySelectorAll<HTMLElement>(selector)].find((el) => el.getClientRects().length > 0);
      const target = shown(`[data-thread-id="${CSS.escape(closed)}"]`) ?? shown('[data-section-id="quiet"] button.ib-band') ?? shown('[data-thread-id]');
      target?.focus({ preventScroll: true });
    };
    keepFocus();
    requestAnimationFrame(() => requestAnimationFrame(keepFocus));
    if (listCovered() && COVERED_LIST_SETTLES === 'while-covered') {
      // The list as the person left it, except the thread they just closed
      // when a message arrived there that they did not see, or when it now
      // waits on them and is drawn in another group (an agent asked while it
      // was open): it takes the section its state gives it (held.ts
      // settlesOnBack, settleThread).
      closing.current = null;
      const groups = latestRef.current ? listGroups(latestRef.current) : [];
      const next = groups.flatMap((section) => section.threads).find((row) => row.thread_id === closed);
      if (next && shownRef.current && settlesOnBack(shownRef.current, next)) {
        // Back put focus on the row; the settle redraws it in another group, so focus goes with it ([shown] layout effect):
        // after a key, and after a stacked window's Back by mouse (#1866 hands that focus to the row too); never after a phone's tap.
        if (lastInput() === 'keyboard' || !isPhone()) refocusRow.current = closed;
        setShown((current) => (current ? settleThread(current, groups, closed) : current));
      }
      return;
    }
    if (prefersReducedMotion()) settleList('own', false);
    else settleTimer.current = setTimeout(() => settleList('own', true), sidebarHeldNow.current ? SETTLE_AFTER_SIDEBAR_MS : SETTLE_BEAT_MS);
  }, [route.page, route.project, route.machine, route.agent, route.thread, settleList, cancelSettle]);

  useEffect(() => {
    if (route.page === 'settings') {
      void refreshSettings();
      void loadUpdateDetails();
    }
  }, [route.page, refreshSettings, loadUpdateDetails]);
  // While Settings shows, General's and About's version rows follow the update control as it moves
  // (available, installing, failed, checking failing), not only what they read when Settings opened.
  // Only when the key changes: opening Settings already reads them (the effect above).
  const updateKey = `${update?.state ?? ''}:${update?.version ?? ''}:${checkFailing?.since ?? ''}`;
  const seenUpdateKey = useRef(updateKey);
  useEffect(() => {
    if (seenUpdateKey.current === updateKey) return;
    seenUpdateKey.current = updateKey;
    if (route.page === 'settings') void loadUpdateDetails();
  }, [route.page, updateKey, loadUpdateDetails]);

  // Settings' Archived count in its nav: read while Settings is open, again whenever the store moves.
  const [archivedTotal, setArchivedTotal] = useState<number | null>(null);
  const storeCursor = latest?.cursor ?? null;
  useEffect(() => {
    if (route.page !== 'settings') return;
    let cancelled = false;
    inboxApi
      .archived({ limit: 1 })
      .then((model) => !cancelled && setArchivedTotal(model.total))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [route.page, storeCursor]);

  // "← Inbox" returns to where the person was before Settings: the last hash that was not a Settings page,
  // so moving between sections never changes where Back goes (Workspaces' BackLink).
  // The tour is never a place to come back to (every way out of it replaces its entry), so a tour step
  // is never recorded here or in whatsNewReturn: both keep the screen from before the tour.
  const settingsReturn = useRef('');
  if (route.page !== 'settings' && route.page !== 'tour') settingsReturn.current = hashOf(route);
  // What's new's "‹ Inbox" returns to the last Inbox screen (not Settings, not another What's new page):
  // the browser's Back when the page was opened from there (history.ts), a new entry otherwise.
  const whatsNewReturn = useRef('');
  if (route.page !== 'settings' && route.page !== 'whats-new' && route.page !== 'tour') whatsNewReturn.current = hashOf(route);
  /**
   * Back from Settings or What's new to where the person was (‹ Inbox, Escape), focus on what is there: an open
   * file's pane, else the open thread's row, else its subject, else the first row (never left on the page as the
   * sidebar slides back).
   */
  const pageBackRef = useRef(() => {});
  pageBackRef.current = () => {
    const hash = route.page === 'whats-new' ? whatsNewReturn.current : settingsReturn.current;
    const to = routeOf(hash);
    if (route.page === 'whats-new') {
      if (!backTo(hash)) go(to);
    } else go(to);
    focusSoon([
      // A file was open (beside the thread or full screen): its pane, which may cover the row.
      ...(to.file ? ['[data-attachment-pane]'] : []),
      ...(to.thread ? [`.ib-main .ib-lbody [data-thread-id="${CSS.escape(to.thread)}"]`, 'section.ib-pane h2.ib-subject'] : []),
      '.ib-main .ib-lbody [data-thread-id]',
      '.ib-bpage h1',
      '.ib-main h1',
    ]);
    // The thread draws again under Settings' way back and puts focus on its subject as it opens; a file that was
    // open is where the person was, so it has focus once the thread has drawn.
    if (to.file) {
      const mark = inputMark();
      setTimeout(() => {
        if (!actedSince(mark) && !document.activeElement?.closest('[data-attachment-pane], .ib-side')) focusFirst(['[data-attachment-pane]']);
      }, 300);
    }
  };

  // Settings is a focused page (design of record inbox-settings-tabs): the sidebar slides away while it
  // is open and comes back on leaving, without writing the person's stored choice. ⌘B there opens it
  // for this visit only.
  const [settingsSidebar, setSettingsSidebar] = useState(false);
  // The thread in full screen (`full` below) and its one way out (`leaveFull` below): Escape's ladder reads them.
  const threadFullRef = useRef(false);
  const leaveFullRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (route.page !== 'settings') setSettingsSidebar(false);
  }, [route.page]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Settings and What's new are focused pages: Escape goes back to where the person was ("‹ Inbox"), unless
      // something on the page used it (a dialog, a menu, a field).
      if (event.key === 'Escape' && (routeRef.current.page === 'settings' || routeRef.current.page === 'whats-new')) {
        const from = keyTarget(event);
        if (event.defaultPrevented || isComposingKey(event) || modalOpen() || (from && (isEditableTarget(from) || inOverlay(from) || from.closest('[role="menu"], [role="listbox"], [aria-expanded="true"]')))) return;
        // A touch phone has its own way back (‹ Inbox); a narrow desktop window keeps Escape, as it keeps its keys.
        if (isTouchPhone()) return;
        pageBackRef.current();
        return;
      }
      // System's drawing in Reviews (approval "system-inbox", 4b: "Reviews, top left, or Esc goes back"): one layer per
      // press, the full window, then the drawing. The drawing's own Escape (a card, a sheet inside) runs first and marks
      // the key used. A PR's pane open over it owns the screen.
      // While System does not show, a leftover `&system=` is not on the ladder: Escape is today's.
      const systemBack = event.key === 'Escape' ? systemEscapeTo(routeRef.current, systemShown(settingsRef.current) && !tailnetGuest(settingsRef.current)) : null;
      if (systemBack) {
        const from = keyTarget(event);
        if (event.defaultPrevented || isComposingKey(event) || modalOpen() || (from && (isEditableTarget(from) || inOverlay(from) || from.closest('[role="menu"], [role="listbox"]')))) return;
        closeTo(systemBack);
        return;
      }
      // Shape's grid and a board open over it (approval "shape-landing-grid": Esc returns). The board's own Escape
      // (its panel, its draw-in) runs first and marks the key used.
      if (event.key === 'Escape' && routeRef.current.page === 'shapes') {
        const from = keyTarget(event);
        if (event.defaultPrevented || isComposingKey(event) || modalOpen() || (from && (isEditableTarget(from) || inOverlay(from)))) return;
        closeTo(routeRef.current.shape ? { ...routeRef.current, shape: null } : { page: 'inbox', project: null, thread: null });
        return;
      }
      // An open file owns Escape (the HTML viewer's ladder, the composers).
      if (event.key !== 'Escape' || !routeRef.current.thread || routeRef.current.file) return;
      // Something inside the thread already used this Escape (the reply's choice at Send goes back to the reply).
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
      // The Ask AI window is not on the ladder: Escape in it never closes the thread under it.
      if (target?.closest?.('[data-chat-window]')) return;
      // Words selected in a message (approval "inbox-message-comments"): its selection toolbar or label picker owns this Escape.
      if (selectionToolbarShowing()) return;
      // An open guided review closes first, back to its thread; then the Artifacts view, back to the messages
      // (approval "inbox-thread-artifacts": one more rung before Escape closes the thread).
      // A thread in full screen leaves it before it closes (the sidebar and the list come back, the thread stays).
      const now = routeRef.current;
      // The full-window review holds the board itself (over it, or as its corner card): Escape closes the board and the
      // review stays. A review not drawn yet (its thread still reading) closes first, back to the board.
      if (now.shape && now.guide && !reviewPaneOpenRef.current) {
        closeTo({ ...now, guide: null, guideAt: null });
        return;
      }
      if (now.shape) {
        closeTo({ ...now, shape: null });
        return;
      }
      if (!now.guide && !now.artifacts && threadFullRef.current) {
        leaveFullRef.current();
        return;
      }
      closeTo(now.guide ? { ...now, guide: null } : now.artifacts ? { ...now, artifacts: false } : { ...now, thread: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The one-time sound dialog: due when the Inbox says so (the first start of
  // this version found someone who used an earlier Inbox; kept until claimed),
  // never on a page that came through the tailnet, never before the list has
  // loaded. It waits while a reply is being typed and while an update dialog
  // is open, then asks the Inbox, which says yes to the first page only (a
  // compare-and-set).
  // The line of one-time dialogs (approval "inbox-one-time-dialogs"): an Inbox that keeps one (`reveal.line`, a release
  // build) says which dialog this load may arm (`reveal.next`); a dev build or an older Inbox keeps none, and each
  // dialog goes by its own `due`.
  const lineArms = (id: InboxRevealId) => settings?.reveal?.line !== true || settings.reveal.next === id;
  // Never while a question waits in the open thread (approval "inbox-one-time-dialogs"), nor while a reply is typed.
  const openQuestionHere = () => {
    const now = routeRef.current;
    return openThreadAsks(oneTimeRows.current, now.page === 'inbox' ? (now.thread ?? null) : null);
  };
  const soundDialogDue = latest !== null && settings?.sound?.dialog_due === true && !tailnetGuest(settings) && lineArms('sound');
  // Not during the tour: one-time dialogs never open over it (they wait for its end).
  const soundDialogBlocked = updateDialog !== null || restarting || route.page === 'tour';
  useEffect(() => {
    if (!soundDialogDue || soundDialogBlocked || soundDialogAsked.current) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (cancelled || soundDialogAsked.current || replyInProgress() || openQuestionHere()) return;
      soundDialogAsked.current = true;
      clearInterval(timer);
      inboxApi
        .claimSoundDialog()
        .then((answer) => {
          setSettings((current) => (current ? { ...current, sound: answer.sound } : current));
          if (answer.show && !cancelled) setSoundDialog('open');
        })
        .catch(() => {})
        .finally(() => setSoundClaimed(true));
    }, 700);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [soundDialogDue, soundDialogBlocked]);

  // The one-time agent-note dialog (the approved "inbox-agent-note-dialog"
  // design): asks about each agent that can take a note and was never asked.
  // Decided once per load, once the agents are read (the run that opened the
  // window has finished connecting) and the list has loaded; after the sound
  // dialog, and never on a load that showed it. On the owner's other devices too
  // (owner ruling 2026-11-11), never on a tailnet guest's page (like the other one-time
  // dialogs; Settings → Agents asks the same thing), never while an update
  // dialog is open or a reply is being typed, and it waits while Settings is open.
  const soundSettled = settings !== null && (!(settings.sound?.dialog_due === true && !tailnetGuest(settings) && lineArms('sound')) || soundClaimed);
  const agentNoteOpen = typeof agentNote === 'object';
  // The notification lines (the ask, "tab slept") wait until this load's
  // one-time dialogs are decided (the sound claim settled, the note dialog
  // shown or not), so a dialog never opens over a line the person may be
  // pressing (Turn on would stack the browser's prompt on the dialog), and
  // stand down while one is open. After the agent-note dialog closes they come
  // back on the same load: the first question usually lands on the load that
  // showed the note dialog, and waiting for a reload meant it could never
  // notify. A load that showed the sound dialog keeps them for the next load:
  // that dialog already said what notifications need (and the note dialog is
  // never decided on that load).
  const askLinesFree = soundSettled && agentNoteSettled && soundDialog === 'none' && !agentNoteOpen;


  // The list on screen catches up as the route changes (the layout effect above), not here.
  const go = (next: Route) => writeRoute(next);
  /** Back to the screen under this one (closeTo): a thread's list, a file's thread. */
  const close = (next: Route) => closeTo(next);

  const openSearch = (opener?: HTMLElement | null) => {
    // Not over the tour’s cards (steps 1 to 10): search shows the person's own threads, which the tour keeps out of sight.
    if (routeRef.current.page === 'tour' && (routeRef.current.step ?? 1) < TOUR_STEPS) return;
    searchOpener.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setSearchMounted(true);
    setSearchOpen(true);
  };
  const openSearchRef = useRef(openSearch);
  openSearchRef.current = openSearch;
  // ⌘K / Ctrl+K opens search: the Inbox's one shortcut, an owner exception (approval amendment 2026-10-14;
  // search/searchShortcut.ts). Capture phase, so it also reaches the open palette, whose keys stop at its dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => onOpenSearchKey(event, (opener) => openSearchRef.current(opener));
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const closeSearch = (reason: 'dismissed' | 'opened') => {
    setSearchOpen(false);
    if (reason !== 'dismissed') return;
    // Focus back to what opened it, else the Search entry on screen (a phone's sheet has closed).
    const opener = searchOpener.current;
    searchOpener.current = null;
    requestAnimationFrame(() => {
      if (opener && opener.isConnected && opener.getClientRects().length > 0) opener.focus();
      else focusFirst(['[data-open-search]']);
    });
  };
  const openSearchResult = (hash: string, land: SearchLanding | null) => {
    searchLanding.current = land;
    const now = routeRef.current;
    const next = routeOf(hash);
    // As a row click does (openRow): searched from a project's list, the list stays that project's.
    if (now.page === 'inbox' && next.page === 'inbox' && next.thread) next.project = now.project;
    // Landing in the thread already open (nothing beside it) replaces the entry: once `msg=` drops,
    // a new one would equal the last and the first Back would do nothing.
    const sameThread = now.page === 'inbox' && !!now.thread && now.thread === next.thread && !now.file && !now.guide;
    // Otherwise a new history entry: Back returns to where the search started (on a phone, the list).
    writeRoute(next, sameThread ? { replace: true } : {});
    focusAfterOpen();
  };
  // ── Compose: a new message to a connected agent (compose/ComposeDialog.tsx) ──
  // The Launch tip (compose/launchTip.ts): this page spends its claim once, with its own key (a retry after a lost
  // answer is shown it again); the Inbox keeps it seen for every window and the phone. A plain New message that never
  // reached the tip (To opened first) leaves it for the next one.
  const launchTipSpent = useRef(false);
  const launchTipKey = useRef(`lt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const launchTip = useMemo(
    () => ({
      claim: async () => {
        launchTipSpent.current = true;
        return (await claimRevealOnce('launch_tip', launchTipKey.current)).show;
      },
    }),
    [],
  );
  const openCompose = (request: ComposeRequest, opener?: HTMLElement | null) => {
    composeOpener.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setCompose(request);
  };
  // A failed clone's Change the URL (E5, from its run line): New message with the URL in the folder menu's filter.
  useEffect(() => {
    const onClone = (event: Event) => {
      const detail = (event as CustomEvent<ComposeCloneRequest>).detail;
      if (!detail?.url) return;
      composeOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setCompose({ clone: detail, body: detail.body });
    };
    window.addEventListener(COMPOSE_CLONE_EVENT, onClone);
    return () => window.removeEventListener(COMPOSE_CLONE_EVENT, onClone);
  }, []);
  /**
   * The draft after this one in the Drafts list (else the one before), for
   * focus once it leaves the list: sent, deleted or discarded.
   */
  const draftNeighbour = (draftId: string): string | null => {
    const list = drafts ?? [];
    const index = list.findIndex((d) => d.id === draftId);
    if (index < 0) return null;
    return (list[index + 1] ?? list[index - 1])?.id ?? null;
  };
  /**
   * Focus somewhere real once what had it is gone: the draft row named, else
   * the Drafts heading, else a New message button. Never left on the page.
   */
  const focusFallback = (draftId: string | null) => {
    // The Drafts page is the page on screen when it has these; the New message
    // buttons are several (sidebar, a phone's list header), so the shown one.
    const row = draftId ? document.querySelector<HTMLElement>(`[data-draft-id="${CSS.escape(draftId)}"] .ib-draft-open`) : null;
    if (row) return row.focus();
    const heading = document.querySelector<HTMLElement>('[data-drafts-page] h1');
    if (heading) return heading.focus();
    for (const button of document.querySelectorAll<HTMLElement>('[data-open-compose]')) {
      button.focus();
      if (document.activeElement === button) return;
    }
  };
  // Runs after the render that closed compose or dropped a draft row, so the DOM is the new one.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || compose) return;
    pendingFocus.current = null;
    const { opener, next } = pending;
    // A hidden opener (a closed phone sheet) does not take focus; then the fallback.
    if (opener?.isConnected) opener.focus();
    if (opener && document.activeElement === opener) return;
    focusFallback(next);
  });
  /** Close compose; focus goes back to what opened it, or, when that is gone (a draft row), `focusFallback(next)`. */
  const closeCompose = (next: string | null = null) => {
    setCompose(null);
    // After the render that closes it (and drops a sent draft's row): see the effect below.
    pendingFocus.current = { opener: composeOpener.current, next };
    composeOpener.current = null;
  };
  const composeSent = (sent: ComposeSent) => {
    // A draft sent leaves the list now; focus goes to the next one.
    const next = sent.draftId ? draftNeighbour(sent.draftId) : null;
    if (sent.draftId) setDrafts((current) => (current ?? []).filter((d) => d.id !== sent.draftId));
    closeCompose(next);
    // The list holds still, a thread open or none (a write never brings in what waits behind "N new"; approval
    // "inbox-list-view", R7), but the thread the person just started is their own action: it goes into Sent now
    // (held.ts addOwnThreads), the other rows sliding to make room, never behind "N new".
    const at = routeRef.current;
    void refreshList(false).then((next) => {
      if (!next) return;
      // The new row may only be drawn by this read: the light starts in the commit that carries it. A person who went elsewhere meanwhile gets none.
      const cur = routeRef.current;
      const stayed = cur.page === at.page && cur.project === at.project && cur.thread === at.thread;
      if (stayed) setSentLight({ thread: sent.threadId });
      armSlide();
      const groups = listGroups(next);
      setShown((current) => (current === null ? groups : addOwnThreads(current, groups, [sent.threadId])));
    });
    if (sent.draftId) void refreshDrafts();
    showToast(
      {
        icon: 'check',
        // A launch (New <agent> session) starts the agent; its thread's run line says the rest.
        lead: sent.launched ? `Starting ${hostLabel(sent.host)}` : `Sent to ${hostLabel(sent.host)}`,
        // The thread's own line says Queued / Sending / Delivered. A long project name is cut on screen (Toast.tsx), never in speech.
        detail: `in ${sent.projectName}`,
        speech: sent.launched
          ? `Starting ${hostLabel(sent.host)} in ${sent.projectName}. Your message is its first turn.`
          : `Sent to ${hostLabel(sent.host)} in ${sent.projectName}. It takes it as its next turn.`,
        action: { label: 'Open', onPress: () => {
          dismissToast();
          go({ page: 'inbox', project: routeRef.current.page === 'inbox' ? routeRef.current.project : null, thread: sent.threadId });
        } },
      },
      7000,
    );
  };
  /** "Send to that thread": compose's message went into the open thread that had the typed name; that thread opens. */
  const composeJoined = (joined: ComposeJoined) => {
    if (joined.draftId) setDrafts((current) => (current ?? []).filter((d) => d.id !== joined.draftId));
    closeCompose(joined.draftId ? draftNeighbour(joined.draftId) : null);
    void refreshList(false);
    if (joined.draftId) void refreshDrafts();
    go({ page: 'inbox', project: routeRef.current.page === 'inbox' ? routeRef.current.project : null, thread: joined.threadId });
    showToast({ icon: 'check', lead: `Sent to ${joined.agent}`, detail: `in ${joined.threadName}`, speech: `Sent to ${joined.agent} in the thread ${joined.threadName}.` }, 5000);
  };
  /**
   * Remote launch: a new session for a linked machine waits in this Inbox's outbox (the machine is asleep, or slow to
   * answer). Compose has closed; the toast says it starts when that machine is back, and Cancel takes it back while it
   * has not left (`POST /api/inbox/outbox/:key/cancel`) and puts its words back in Drafts.
   */
  const composeHeld = (held: ComposeHeld) => {
    if (held.draftId) setDrafts((current) => (current ?? []).filter((d) => d.id !== held.draftId));
    closeCompose(held.draftId ? draftNeighbour(held.draftId) : null);
    if (held.draftId) void refreshDrafts();
    const { toast: heldToast, ms } = heldLaunchToast(held, showToast, dismissToast, () => void refreshDrafts());
    showToast(heldToast, ms);
  };
  const lastSentRef = useRef(lastSent);
  const rememberSent = (session: string) => {
    lastSentRef.current = session;
    setLastSent(session);
    storage.setItem(COMPOSE_LAST_COOKIE, session);
  };
  const composeSaved = (draft: DraftView) => {
    // What opened compose: a reopened draft hands focus back to it when it closes again.
    const opener = composeOpener.current;
    closeCompose();
    setDrafts((current) => [draft, ...(current ?? []).filter((d) => d.id !== draft.id)]);
    void refreshDrafts();
    showToast({
      icon: 'check',
      lead: 'Draft saved',
      // Closing compose keeps what was written (approval "inbox-compose-escape-keeps"): Reopen brings it back as it
      // was. One line on a phone too (design record "inbox-toasts-break-fixes").
      detail: 'It never sends itself',
      speech: 'Draft saved. It waits under Drafts and never sends itself.',
      action: { label: 'Reopen', onPress: () => {
        dismissToast();
        openCompose({ draft }, opener?.isConnected ? opener : null);
      } },
    });
  };
  /** Delete a draft, with Undo: the window re-creates it from what it still holds (no soft delete on the server). */
  const deleteDraft = async (draft: DraftView, alreadyDeleted = false) => {
    const next = draftNeighbour(draft.id);
    const hadFocus = document.activeElement instanceof HTMLElement && !!document.activeElement.closest(`[data-draft-id="${CSS.escape(draft.id)}"]`);
    if (!alreadyDeleted) {
      try {
        await inboxApi.deleteDraft(draft.id);
      } catch (cause) {
        showToast(errorToast(cause, 'The draft was not deleted.'));
        return;
      }
    }
    setDrafts((current) => (current ?? []).filter((d) => d.id !== draft.id));
    // The row held focus (its delete button): the next row takes it.
    if (hadFocus) pendingFocus.current = { opener: null, next };
    void refreshDrafts();
    showToast({
      icon: 'check',
      lead: 'Draft deleted',
      onUndo: () => {
        dismissToast();
        void inboxApi
          // Everything the draft kept: its typed thread name and the Board card it was started for (Create thread).
          .saveDraft(draft.id, {
            body: draft.body,
            to: draft.to,
            project: draft.project,
            files: draft.files.map((f) => f.upload_id),
            base: null,
            ...(draft.thread_name ? { thread_name: draft.thread_name } : {}),
            ...(draft.card ? { card: draft.card } : {}),
          })
          .then(() => refreshDrafts())
          .then(() => say('Draft restored.'))
          .catch(() => showToast({ icon: 'warn', lead: 'The draft could not be restored.', wrap: true }));
      },
    });
  };
  // The palette's Actions group reads the live sessions while it is open.
  const { model: paletteSessions } = useComposeSessions(searchOpen);
  // "New review…" is offered with Code review on (as `pullsShown` below). A dependency, not a ref: the palette's
  // Actions are worked out when its words are answered, and the settings can land after that (⌘K just after a
  // load), so the actions must change with them or "review" never offers New review… until the words change.
  const paletteReviews = codeReviewOn && !tailnetGuest(settings);
  const paletteActions = useCallback(
    (q: string): ComposeAction[] => composeActions(q, composeTargets(paletteSessions?.projects ?? []), lastSentRef.current, paletteReviews),
    [paletteSessions, paletteReviews],
  );

  /** The thread landed on the message `msg=` named: drop it from the hash, so a reload does not jump again. */
  const landed = () => {
    searchLanding.current = null;
    decideLanding.current = null;
    if (routeRef.current.msg) writeRoute({ ...routeRef.current, msg: null }, { replace: true });
  };

  // A phone shows one screen at a time (phone.ts, inbox.css), and its keyboard shrinks the window.
  const phone = usePhone();
  const { read: readAccounts } = useAccounts();
  /** The Usage row the peek hangs from; null is closed. */
  const [usageRow, setUsageRow] = useState<HTMLElement | null>(null);
  useEffect(() => (phone ? trackKeyboard() : undefined), [phone]);
  // A ⌘V with focus on something that takes no text (a question's choice, the page) goes to the text
  // field the person was writing in: dictation apps paste with a synthetic ⌘V (pasteTarget.ts).
  useEffect(() => installPasteFollowsField(), []);
  // ...and the page inserts that plain-text paste itself: Chrome 155-156 on macOS drops dictated
  // (synthetic ⌘V) text otherwise. Remove once Chrome 157 is stable (pasteInsert.ts).
  useEffect(() => installPlainTextPaste(), []);
  // A window too narrow for two panes (an iPad in portrait, a narrow desktop window): the pane on top covers the one under it (stack.ts).
  // `‹ Inbox` from a file beside the thread in a window with room for the list and the thread but not for
  // the sidebar too (about 920 to 1050 px): the sidebar stays closed on screen so the list shows beside the
  // thread, as the open file kept it, without writing the person's choice. It comes back once there is room,
  // when the thread closes, or when the person opens it.
  const [sidebarHeld, setSidebarHeld] = useState(false);
  // The thread in full screen (a click on the list column's edge, or Enter on it): the sidebar and the list hide, without
  // writing the person's sidebar choice. A reading mode: it stays on when the person opens another thread (search, a
  // notification, a pin), and ends when no thread is open, with "‹ Inbox", Escape or ⌘B. A stacked window never counts
  // as full screen (`full` below), so widening it again returns to full screen.
  const [threadFull, setThreadFull] = useState(false);
  useEffect(() => {
    if (!route.thread) setThreadFull(false);
  }, [route.thread]);
  sidebarHeldNow.current = sidebarHeld;
  // Full screen changes the sidebar's and the list's room without a route change: measured again too.
  const stack = useStack(rootRef, phone, [hashOf(route), sidebarOpen, sidebarHeld, threadFull]);
  // The thread panel view (threadPanel.ts): the list stays at its short width and the thread's pane stays drawn with
  // no thread open. Off by default, and never on a phone or in a window that stacks.
  const [threadPanelOn, setThreadPanelOn] = useThreadPanel();
  const panelView = threadPanelShows(threadPanelOn, { phone, stacked: stack.thread });
  useEffect(() => {
    if (!sidebarHeld) return;
    const check = () => {
      const now = routeRef.current;
      if (now.page !== 'inbox' || !now.thread) {
        setSidebarHeld(false);
        return;
      }
      const root = rootRef.current;
      if (!root) return;
      const sidebar = root.querySelector('.ib-sb-inner')?.getBoundingClientRect().width ?? 0;
      if (root.getBoundingClientRect().width - sidebar >= LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH + paneGutters(root)) setSidebarHeld(false);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [sidebarHeld, route]);
  useLayoutEffect(() => {
    covering.thread = stack.thread;
  }, [stack.thread]);

  const openRow = (row: InboxListRow) => go({ page: 'inbox', project: route.project, machine: route.machine, agent: route.agent, thread: row.thread_id });

  const patchQuestions = (messageId: string, questions: InboxQuestion[]) => {
    ownSaves.saved(questions);
    setThread((current) =>
      current
        ? { ...current, messages: current.messages.map((m) => (m.id === messageId ? { ...m, questions } : m)) }
        : current,
    );
  };

  /**
   * The questions the open thread is saving answers to (a card saves on every
   * change). Each save's answer already brought its questions, so what the
   * reads show waits for the last one: one read for the lot. Only the records
   * of those questions wait, and only while the pane is open, so a save that
   * never answers holds back nothing else; any other record is read as it comes.
   * `paneClosed` only ends the hold: nothing landed, and a read here would put
   * the list on screen ahead of the close's own settle (settle.ts).
   */
  const onPickSaves = useCallback((saving: ReadonlySet<string>, paneClosed = false) => {
    pickSaves.current.saving = saving;
    if (saving.size > 0) return;
    // While a thread is open the person's own writes never reorder the list
    // (owner ruling 2026-10-11): each row shows its new state in place, and
    // the list catches up when the thread closes (settle.ts).
    // With none open the same (approval "inbox-list-view", R7): a save shows on its row in place and never brings in
    // what waits behind "N new".
    const held = pickSaves.current.held;
    pickSaves.current.held = [];
    if (!pickSaves.current.owed) {
      // The records of these saves are still to come: read now what they will owe, so they owe nothing then.
      if (!paneClosed) pickSaves.current.readOwn();
      return;
    }
    pickSaves.current.owed = false;
    // The held records' read starts now and reads the list: it is this list read too.
    if (paneClosed) pickSaves.current.read();
    else pickSaves.current.readHeld(held);
  }, [refreshList]);

  /**
   * The list and the open thread read again after the person's own write. The list never adopts (approval
   * "inbox-list-view", R7: a hover Mark read with nothing open used to bring in everything behind "N new" and slide
   * another row under the pointer): every row shows its own state in place (held.ts `refreshHeldRows`), and the rows
   * written (`written`) take the server's row in place even where an agent's message there waits behind "N new", so
   * the write always shows. A written row the list on screen lost (Undo of an Archive after the list settled
   * without it) goes back in at its place (held.ts `addOwnThreads`), never behind "N new". Agent activity anywhere
   * else keeps waiting for Show.
   */
  const afterWrite = async (written: readonly string[] = []) => {
    const open = routeRef.current.thread;
    if (open) await refreshThread(open);
    const next = await refreshList(false);
    if (!next || written.length === 0) return;
    const groups = listGroups(next);
    const rows = new Map(groups.flatMap((section) => section.threads).map((row) => [row.thread_id, row] as const));
    const fresh = written.flatMap((id) => rows.get(id) ?? []);
    if (fresh.length > 0) setShown((current) => (current ? addOwnThreads(fresh.reduce(replaceHeldRow, current), groups, written) : current));
  };

  const rowOf = (threadId: string): InboxListRow | undefined =>
    (latestRef.current ? listGroups(latestRef.current) : []).flatMap((section) => section.threads).find((row) => row.thread_id === threadId);

  const say = (text: string) => {
    setSaid('');
    setTimeout(() => setSaid(text), 30);
  };
  // The live region says "Reconnecting…" once when the stream dies, never its return, and not again within
  // RECONNECT_SAY_GAP_MS (a network that comes and goes would say it over and over).
  useEffect(() => {
    if (!streamDead) {
      // Live again: the region drops the words, saying nothing new (a screen reader that reads it later finds no stale state).
      setSaid((current) => (current === 'Reconnecting…' ? '' : current));
      return;
    }
    const at = reconnectSaidAt.current;
    if (at !== null && Date.now() - at < RECONNECT_SAY_GAP_MS) return;
    reconnectSaidAt.current = Date.now();
    say('Reconnecting…');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `say` is a fresh closure each render; only the change matters.
  }, [streamDead]);
  // The stale page notice is said as it shows (again after a dismiss), never as it goes.
  useEffect(() => {
    if (stalePage.inbox && !restarting) say(`Inbox updated to ${stalePage.inbox}. Reload the page to use it.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `say` is a fresh closure each render; only the change matters.
  }, [stalePage.inbox]);
  /**
   * Click Inbox to refresh (the owner, 2026-10-20: "Just click inbox, it
   * refreshes"): clicking Inbox, or the project folder the list shows, or the
   * list header's title, while that list is on screen reads the list again and
   * adopts it as Show does (held rows settle, new rows come in and light up,
   * "N new · Show" goes away), with the drafts, settings and the open thread
   * read again too: what a page reload would bring, and nothing more (no look
   * is recorded, so the tab's count and the rows' New stay as the server says).
   * `closeThread`: the sidebar's row with a thread open keeps today's behaviour
   * (the thread closes) and refreshes as well; the list adopts what it reads
   * instead of settling the person's own reads a beat later.
   */
  const refreshSpinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (refreshSpinTimer.current) clearTimeout(refreshSpinTimer.current);
  }, []);
  /** A refresh is reading: another click waits for it (a second read would light nothing and take the first one's light). */
  const refreshing = useRef(false);
  const refreshInbox = async (scope: string | null, closeThread: boolean) => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      await refreshInboxNow(scope, closeThread);
    } finally {
      refreshing.current = false;
    }
  };
  const refreshInboxNow = async (scope: string | null, closeThread: boolean) => {
    const label = scope ? (projects.find((p) => p.id === scope)?.name ?? 'Project') : 'Inbox';
    // The brief signal plays whether or not anything changed: the icon turns once.
    setRefreshSpin((last) => ({ key: (last?.key ?? 0) + 1, scope }));
    if (refreshSpinTimer.current) clearTimeout(refreshSpinTimer.current);
    refreshSpinTimer.current = setTimeout(() => setRefreshSpin(null), REFRESH_SPIN_MS);
    if (closeThread) {
      refreshPending.current = true;
      go({ page: 'inbox', project: scope, thread: null });
    }
    cancelSettle();
    closing.current = null;
    // After a key, focus stays where it is (the row or title pressed); Show's own focus move is not wanted here.
    focusAfterShow.current = false;
    listOrder.current = [...(listBody(rootRef.current)?.querySelectorAll('[data-thread-id]') ?? [])].map((el) => el.getAttribute('data-thread-id')!);
    const next = await refreshList(true, true, { light: true, keepOpen: true });
    refreshPending.current = false;
    if (!next) {
      say(`${label} could not refresh`);
      return;
    }
    void refreshDrafts();
    void refreshSettings();
    const open = routeRef.current.thread;
    if (open) void refreshThread(open);
    say(`${label} refreshed`);
  };
  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
    toastLeft.current = null;
    setToast(null);
  }, []);
  /** The window's one toast: a new one replaces the last, so two never stack. */
  const armToastTimer = (ms: number) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastDeadline.current = Date.now() + ms;
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, ms);
  };
  const showToast = (next: Omit<InboxToastModel, 'id'>, ms = MARK_READ_UNDO_MS) => {
    // An unseen toast (a reaction's Undo for `Z`) never takes the place of one on screen (an error, another Undo): the
    // live region still says it.
    if (next.hidden && toastNow.current && !toastNow.current.hidden) {
      say(toastSpeech(next, isTouchPhone()));
      return;
    }
    toastLeft.current = null;
    const model = { ...next, id: Date.now() };
    toastNow.current = model;
    setToast(model);
    // A narrow desktop window (the phone layout, a mouse and keys) keeps Z, so it hears "Press Z to undo".
    say(toastSpeech(next, isTouchPhone()));
    armToastTimer(ms);
  };
  /** A swipe in progress pauses the toast's timer; a spring-back resumes it (at least 1.5 s more, so it never vanishes on release). */
  const holdToast = useCallback((held: boolean) => {
    if (held) {
      if (!toastTimer.current) return;
      clearTimeout(toastTimer.current);
      toastTimer.current = null;
      toastLeft.current = Math.max(0, toastDeadline.current - Date.now());
      return;
    }
    if (toastLeft.current === null) return;
    const left = toastLeft.current;
    toastLeft.current = null;
    armToastTimer(Math.max(left, 1500));
    // armToastTimer reads only refs and setToast, so the first render's copy serves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /**
   * A write that failed: the Inbox's own words, or plain ones (toastError.ts); what to do always shows whole. A write
   * held for another machine (linked machines) did not fail: it waits in this Inbox's outbox and applies when that
   * machine takes it, and says so, without the warning.
   */
  const showError = (cause: unknown) => showToast(errorToast(cause, 'The thread did not change.'));
  // A tray change the server refused (approval "inbox-reaction-tray"): already taken back on screen; the toast says why.
  useEffect(() => {
    onSavedReactionsFailed((cause) => showToast(errorToast(cause, 'Your saved emoji did not change.')));
    return () => onSavedReactionsFailed(null);
  });
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  /**
   * Send now from a list row (approval "inbox-busy-agent-reply"): the reply
   * waiting on a busy agent goes into its running turn now, as the thread's
   * Send now does. No toast: the row's tick and badge say it.
   */
  const sendNowFromRow = async (row: InboxListRow) => {
    const id = row.delivery?.message_id;
    if (!id) return;
    try {
      await inboxApi.sendNow(id);
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite([row.thread_id]);
    say('Sending it now.');
  };

  /**
   * The looks this tab sent on the thread and the server has not taken yet,
   * waited for (never longer than MARK_READ_LOOK_WAIT_MS), so Mark read and
   * Mark unread decide on the state the look gives the thread whenever they
   * are pressed. Undefined: none was on its way.
   */
  const awaitLooks = async (threadId: string): Promise<Set<Promise<unknown>> | undefined> => {
    const looks = looksInFlight.current.get(threadId);
    if (!looks) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(looks), new Promise<void>((done) => (timer = setTimeout(done, MARK_READ_LOOK_WAIT_MS)))]);
    clearTimeout(timer);
    return looks;
  };

  /**
   * The warning before a Mark read that sets questions aside (the owner's ask, 2026-11-10; markRead.ts
   * `confirmSetAside`, components/MarkReadWarning.tsx). Resolves true to go on. A second ask while one is up cancels
   * the first, so no Mark read waits forever.
   */
  const askingSetAside = useRef<((answer: SetAsideAnswer) => void) | null>(null);
  const warnSetAside = (count: SetAsideCount, bulk: boolean): Promise<boolean> =>
    confirmSetAside(
      count,
      // On by default on the server; absent (settings not read yet, an older Inbox): no warning.
      settings?.mark_read_warning?.on === true,
      (asked) =>
        new Promise<SetAsideAnswer>((resolve) => {
          askingSetAside.current?.({ go: false });
          const answer = (value: SetAsideAnswer) => {
            if (askingSetAside.current === answer) askingSetAside.current = null;
            resolve(value);
          };
          askingSetAside.current = answer;
          setReadWarning({ count: asked, bulk, answer });
        }),
      () => void toggleMarkReadWarning(false),
    );

  /** What Mark read would set aside on a thread the list has no row for (the open thread's own questions). */
  const openThreadSetAside = (threadId: string): SetAsideCount => {
    const open = thread?.thread_id === threadId ? thread : null;
    if (!open) return setAsideCount([]);
    const asked = open.messages.filter((m) => m.author.kind === 'agent').flatMap((m) => [...(m.questions ?? []), ...(m.actions ?? [])]);
    return setAsideCount([{ questions: summarizeInboxQuestions(asked) }]);
  };

  /**
   * Mark read, or move it back (the pressed button, `E` again, Undo). The
   * thread leaves the top for Quiet with its waiting questions closed; Undo
   * reopens them as they were. An agent stopped or held up on it makes the
   * toast a warning with Reply. `drawnBefore` (the Undo): the list as drawn
   * when Mark read was pressed; a settle that moved the row since (into folded
   * Quiet) is undone for it, so it comes back where it was (held.ts
   * `putReadRowBack`).
   */
  const markRead = async (threadId: string, read: boolean, drawnBefore: InboxListSection[] | null = null) => {
    const listAtPress = read ? shownRef.current : null;
    // A look this tab sent and the server has not taken yet: decide on what it gives (a seen update held in New
    // moves locally), whether Mark read came before the look landed or after. Never longer than
    // MARK_READ_LOOK_WAIT_MS: a look that stalls leaves the thread New on the server, so Mark read writes.
    const looks = read ? await awaitLooks(threadId) : undefined;
    const before = rowOf(threadId);
    if (read && before) {
      const drawn = drawnSection(shownRef.current, threadId);
      if (seenHeldInNew(before, drawn)) return routeRef.current.thread ? moveSeenToQuiet(threadId, before) : seenStaysPut(before);
      // Once the look landed nothing waits here any more (the thread closed and the list settled, say).
      if (looks && !canToggleRead(before, drawn)) return;
    }
    // Questions this Mark read would close unanswered (and tell the agent about): the warning asks first.
    if (read && !(await warnSetAside(before ? setAsideCount([before]) : openThreadSetAside(threadId), false))) return;
    // The list holds still, a thread open or not (approval "inbox-list-view", R7): the row stays where it is, not
    // bold, and moves to Quiet when the list next settles.
    const open = routeRef.current.thread;
    const place = threadId === open ? 'open' : 'held';
    try {
      await inboxApi.markRead(threadId, read);
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite([threadId]);
    if (!read) {
      const now = rowOf(threadId);
      if (drawnBefore && now && shownRef.current && putReadRowBack(shownRef.current, drawnBefore, now)) {
        armSlide();
        setShown((current) => (current ? (putReadRowBack(current, drawnBefore, now) ?? current) : current));
      }
      dismissToast();
      // The row has not left its place, so it has nowhere to come back from.
      say('Moved back.');
      return;
    }
    if (!before) return;
    const { warn, ...copy } = markReadToast(before, place);
    // A Mark read that stood (Mark unread took its look back) only got its look back: Undo takes it again, never a Move back.
    const stood = (before.read_at ?? null) !== null;
    showToast({
      ...copy,
      icon: warn ? 'warn' : 'check',
      onUndo: () => {
        // Mark read ended the snooze: its Undo puts that back too.
        const restoring = restoreSnooze(threadId, before.snoozed);
        if (!stood) return void restoring.then(() => markRead(threadId, false, listAtPress));
        dismissToast();
        void restoring.then(() => markUnread(threadId));
      },
      ...(warn
        ? {
            onReply: () => {
              void (async () => {
                await markRead(threadId, false, listAtPress);
                if (routeRef.current.thread !== threadId) go({ page: 'inbox', project: routeRef.current.project, machine: routeRef.current.machine, agent: routeRef.current.agent, thread: threadId });
                setReplyFor(threadId);
              })();
            },
          }
        : {}),
    });
  };

  /**
   * Mark read on a seen update the list still holds in New (markRead.ts `seenHeldInNew`) with no thread open: the
   * thread is already Quiet on the server and its row already reads as read, so nothing is written and nothing moves
   * (the list holds still, approval "inbox-list-view", R7); it goes to Quiet when the list next settles. The toast
   * names it, as any row's Mark read does. Nothing to undo.
   */
  const seenStaysPut = (row: InboxListRow) => {
    const { lead, detail } = markReadToast(row, 'held');
    showToast({ lead, detail, icon: 'check' });
  };

  /**
   * Mark read on a seen update the list still holds in New (markRead.ts
   * `seenHeldInNew`) beside an open thread: the thread is already Quiet on the
   * server, so nothing is written; its row moves to Quiet now, with the
   * settle's slide. Undo puts it back where it was drawn.
   */
  const moveSeenToQuiet = (threadId: string, row: InboxListRow) => {
    const before = shownRef.current;
    const sections = latestRef.current ? listGroups(latestRef.current) : null;
    if (!before || !sections) return;
    armSlide();
    setShown((current) => (current ? settleThread(current, sections, threadId) : current));
    // "Moved to Quiet · “<subject>”": the row has moved, wherever focus is.
    const { lead, detail } = markReadToast(row, 'list');
    showToast({
      lead,
      detail,
      icon: 'check',
      onUndo: () => {
        dismissToast();
        armSlide();
        setShown((current) => (current ? putRowBack(current, before, threadId) : current));
        say('Moved back.');
      },
    });
  };

  /**
   * Mark unread (the owner's ask, 2026-10-31; markRead.ts `canMarkUnread`):
   * the thread's latest agent message is new again, so its row is New and
   * bold, as if the person had not opened it. Nothing is sent to the agent,
   * and a Mark read stands, so Move back still reopens what it closed. From
   * the open thread the thread closes, as a mail app's Mark unread does: left
   * open, its next look would read it again, and the list shows the row back
   * in New. Undo is a look capped at the message Mark unread took back, so it
   * puts back exactly what was there and leaves anything that arrived since
   * new. When the server wrote nothing (a stale row: the thread was new
   * already, an agent having written there behind "N new") the row on screen
   * takes the server's row in place, bold with Mark read: no toast, nothing to
   * undo, and no dead click left behind.
   */
  const markUnread = async (threadId: string) => {
    // The row and the header read as looked at from the moment the look goes out (`looking`), so Mark unread can come
    // first: the server would find the message new still and write nothing, and the look landing after would read
    // the thread again.
    await awaitLooks(threadId);
    const before = rowOf(threadId);
    let written: Awaited<ReturnType<typeof inboxApi.markUnread>>;
    try {
      written = await inboxApi.markUnread(threadId);
      // The look was slower than the wait (a slow network, a linked machine), so the server had nothing to make
      // unread yet: once the look lands, try once more, or the click is lost and the look reads the thread anyway.
      const slowLooks = written.wrote ? undefined : looksInFlight.current.get(threadId);
      if (slowLooks) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.all(slowLooks), new Promise<void>((done) => (timer = setTimeout(done, MARK_UNREAD_RETRY_WAIT_MS)))]);
        clearTimeout(timer);
        const stalled = looksInFlight.current.has(threadId);
        written = await inboxApi.markUnread(threadId);
        if (!written.wrote && stalled) {
          await afterWrite();
          showToast({ lead: 'Not marked unread', detail: 'This thread’s read has not reached the Inbox yet. Try again in a moment.', icon: 'warn' });
          return;
        }
      }
    } catch (cause) {
      showError(cause);
      return;
    }
    if (!written.wrote) {
      // Nothing to make unread: the thread is new already. The row and the header show that, not a look.
      stopLooking(threadId);
      await afterWrite();
      // The held list may keep the old row (an agent wrote there: its news waits behind "N new"): show the server's
      // row in its place, bold with Mark read, so the click is not offered again for nothing.
      const now = rowOf(threadId) ?? written.thread;
      setShown((current) => (current ? replaceHeldRow(current, now) : current));
      say('Already unread.');
      return;
    }
    await afterWrite([threadId]);
    // The open thread closes and the list settles with its row in New; any other row is bold where it is (R7).
    const wasOpen = routeRef.current.thread === threadId;
    if (wasOpen) {
      if (fromCard) backToCard();
      else close({ ...routeRef.current, thread: null, file: null });
    }
    showToast({
      ...markUnreadToast(before ?? { subject: null }, wasOpen),
      icon: 'unread',
      onUndo: () => {
        dismissToast();
        void (async () => {
          try {
            await inboxApi.seen(threadId, written.through_seq);
          } catch (cause) {
            showError(cause);
            return;
          }
          await afterWrite([threadId]);
          say('Read again.');
        })();
      },
    });
  };

  /**
   * 👍 Looks good (design record "inbox-acknowledge", approved 2026-10-15,
   * amended 2026-10-16), or take it back (the toast's Undo, `Z`, the pressed
   * button). The ack is recorded on the agent's latest message and the thread
   * is marked read; once the Undo window passes the Inbox sends it to the
   * agent. The held-order rules of Mark read apply: with the thread open its
   * row changes in place.
   *
   * `reaction` (approval "inbox-reaction-tray"): the emoji picked in the 👍's
   * tray, null for 👍 Looks good, undefined for the plain button (today's call).
   * The agent gets the one the Undo window closes on. A reaction draws no toast: the
   * emoji flies to the message; the toast is kept unseen, so `Z` still undoes it
   * and the live region still says it. Taking one back, `reaction` is the one
   * taken back, for the words only.
   *
   * `was` (defined only when the message already had the person's mark): the
   * reaction it had (null: 👍 Looks good). Then only the emoji changes (the
   * store keeps the ack, its time and whether it went), so `Z` puts the one it
   * had back, never takes the mark away, and nothing says it goes in 10 s.
   */
  const acknowledge = async (threadId: string, messageId: string, on: boolean, agent: string, reaction?: InboxReaction | null, was?: InboxReaction | null) => {
    try {
      await inboxApi.ack(messageId, on, reaction);
    } catch (cause) {
      showError(cause);
      await afterWrite();
      return;
    }
    await afterWrite([threadId]);
    if (!on) {
      // Only a 👍's own toast goes with it; an error or another Undo on screen stays.
      if (toastNow.current && (toastNow.current.hidden || toastNow.current.icon === 'thumb')) dismissToast();
      say(`${reaction ? reactionSpeech(reaction) : 'Looks good'} taken back.`);
      return;
    }
    if (was !== undefined && reaction !== undefined) {
      const words = reaction ? reactionSpeech(reaction) : 'Looks good';
      const before = was ? reactionSpeech(was) : 'Looks good';
      showToast({
        hidden: true,
        icon: 'thumb',
        lead: words,
        speech: `Changed to ${words}.`,
        onUndo: () =>
          void (async () => {
            try {
              await inboxApi.ack(messageId, true, was);
            } catch (cause) {
              showError(cause);
              await afterWrite();
              return;
            }
            await afterWrite([threadId]);
            say(`Back to ${before}.`);
          })(),
      });
      return;
    }
    if (reaction !== undefined) {
      const words = reaction ? reactionSpeech(reaction) : 'Looks good';
      showToast({
        hidden: true,
        icon: 'thumb',
        lead: words,
        speech: `${words}. Goes to ${agent} in 10 seconds and moves to Quiet.`,
        onUndo: () => void acknowledge(threadId, messageId, false, agent, reaction),
      });
      return;
    }
    // Only the open thread's foot offers 👍, so the toast always speaks of that thread.
    showToast({
      icon: 'thumb',
      lead: 'Looks good',
      // One line at 520 px with Undo and its Z for a name up to 40 characters (longer ones are cut, shortAgentName).
      detail: `Goes to ${shortAgentName(agent)} in 10 s · Moves to Quiet`,
      // A phone: the news first and the name last, so a cut with "…" only ever eats the name. "Read" is the phone's word
      // for Marked read (the thread moves to Quiet), short enough that the news fits whole at 320 px beside Undo and the ×.
      phoneDetail: `Read · Sends in 10 s · ${shortAgentName(agent)}`,
      speech: `Looks good. Goes to ${agent} in 10 seconds and moves to Quiet.`,
      onUndo: () => void acknowledge(threadId, messageId, false, agent),
    });
  };

  /**
   * An action item's Done or Can't do it (approval "inbox-action-items-in-reply"):
   * into the reply draft, like a pick, sent only with the person's Send. No
   * toast and no timer; `null` takes it back out of the draft. A note typed
   * under the marked row saves quietly. Resolves the message's action items as
   * saved, or null when it was refused.
   */
  const markAction = async (messageId: string, key: string, mark: ActionMark | null): Promise<InboxQuestion[] | null> => {
    let actions: InboxQuestion[];
    try {
      ({ actions } = await inboxApi.markAction(messageId, key, mark, true));
    } catch (cause) {
      // A note typed while the item was sent elsewhere or replaced: the thread redraws it as it is now.
      if (!isMootNoteRefusal(mark, cause)) showError(cause);
      await afterWrite();
      return null;
    }
    await afterWrite();
    if (!mark) say('Taken out of your draft.');
    else if (!mark.quiet) say(mark.outcome === 'done' ? 'Done. It goes with your reply.' : "Can't do it. It goes with your reply.");
    return actions;
  };

  /** Archive (the MCP's resolve) or Unarchive, with Undo. */
  const archive = async (threadId: string, rootId: string, next: boolean) => {
    const before = rowOf(threadId);
    const open = routeRef.current.thread;
    try {
      await inboxApi.resolve(rootId, next);
    } catch (cause) {
      showError(cause);
      return;
    }
    // The list leaves archived threads out (Settings lists them). While the
    // thread is open its row stays where it is, shown archived; it goes when
    // the person leaves the thread.
    // A row archived from its menu does the same, another thread open or none (the list holds still; approval
    // "inbox-list-view", R7): it goes when the list next settles.
    if (next) {
      const at = new Date().toISOString();
      setShown((current) => (current ? markHeldRowArchived(current, threadId, at) : current));
    }
    await afterWrite([threadId]);
    if (next) {
      // The thread's foot says the next message starts a new thread.
      // From a row's menu, a thread that is not the open one: the subject says which (as Mark read's toast).
      const detail = threadId !== open && before ? `“${before.subject ?? '(no subject)'}”` : undefined;
      const snoozed = before?.snoozed;
      showToast({
        icon: 'archive',
        lead: 'Archived',
        ...(detail ? { detail } : {}),
        // Archive ended the snooze: Undo unarchives first, since an archived thread takes none.
        onUndo: () => void archive(threadId, rootId, false).then(() => restoreSnooze(threadId, snoozed)),
      });
    } else {
      dismissToast();
      say('Unarchived.');
    }
  };

  /**
   * Put a snooze back as it was, its own time included, when its time is still
   * ahead: the Undo of Mark read and Archive, which ended it. Past its time
   * there is nothing to put back. Asks nothing of the list: the caller reads it.
   */
  const restoreSnooze = async (threadId: string, snooze: InboxRowSnooze | null | undefined) => {
    if (!snooze || !inboxSnoozeRunning(snooze.until)) return;
    try {
      await inboxApi.snooze(threadId, snooze.until, snooze.at);
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite([threadId]);
  };

  /**
   * Snooze a thread, from its row's menu, the thread header's clock or a
   * phone's ⋯ (approval "inbox-snooze"). The row leaves its section at once
   * (the owner, 2026-11-03: "ideally when snoozing they would move in the list
   * after i snooze it"): only this row moves (`moveSnoozedRow`), a thread open
   * beside the list or none, and the rest of the list holds still. The toast says
   * when it comes back; its Undo puts back exactly what was there, an earlier
   * snooze included, and the row with it.
   */
  const snooze = async (row: Pick<InboxListRow, 'thread_id' | 'subject'>, until: string) => {
    const threadId = row.thread_id;
    const earlier = (rowOf(threadId) ?? (threadRow?.thread_id === threadId ? threadRow : null))?.snoozed ?? null;
    snoozedThisLoad.current = true;
    let answer: Awaited<ReturnType<typeof inboxApi.snooze>>;
    try {
      answer = await inboxApi.snooze(threadId, until);
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite();
    // A home machine whose clock is ahead of this one: the time has passed there, so the thread is not snoozed.
    if (answer.snoozed === null) {
      showError(new InboxApiError(409, 'snooze_past', 'That time has passed.'));
      return;
    }
    const drawnBefore = moveSnoozedRow(threadId);
    if (drawnBefore) snoozeMoved.current.set(threadId, drawnBefore);
    const when = inboxSnoozeWhen(until);
    showToast({
      icon: 'clock',
      lead: 'Snoozed',
      detail: when,
      speech: `Snoozed “${row.subject ?? '(no subject)'}” until ${when}.`,
      onUndo: () => void putSnooze(threadId, earlier, drawnBefore),
    });
  };
  /**
   * The person's own snooze while the list is on screen (a thread open beside
   * it, or none): that one row goes to the Snoozed band now (held.ts
   * `settleThread`), fading from its place while the rows below slide up
   * (settle.ts; nothing moves under reduced motion). Every other row holds,
   * and agent activity stays behind "N new" (a write's read never adopts,
   * approval "inbox-list-view", R7). Nothing to do where the thread covers
   * the list (Back moves it, `settlesOnBack`).
   * Only a row the read shows snoozed moves: a write a linked machine's outbox
   * holds has not snoozed anything yet. Returns the list as drawn before, for
   * Undo, or null when nothing moved.
   */
  const moveSnoozedRow = (threadId: string): InboxListSection[] | null => {
    const drawn = shownRef.current;
    // With no thread open the list is on screen and a write's read never moves a row (R7), so this one moves here.
    if ((routeRef.current.thread && listCovered()) || !drawn || !latestRef.current) return null;
    if (drawnSection(drawn, threadId) === null || !rowOf(threadId)?.snoozed) return null;
    const groups = listGroups(latestRef.current);
    armSlide();
    setShown((current) => (current ? settleThread(current, groups, threadId) : current));
    return drawn;
  };
  /**
   * Snooze's Undo: the snooze it replaced, or none. A row the snooze moved
   * while a thread is open goes back where it was drawn, between the same
   * neighbours (held.ts `putRowBack`), in its state as it is now.
   */
  const putSnooze = async (threadId: string, earlier: InboxRowSnooze | null, drawnBefore: InboxListSection[] | null = null) => {
    snoozeMoved.current.delete(threadId);
    try {
      await inboxApi.snooze(threadId, earlier && inboxSnoozeRunning(earlier.until) ? earlier.until : null, earlier?.at);
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite();
    putSnoozedRowBack(threadId, drawnBefore);
    dismissToast();
    say(earlier ? 'Snooze moved back.' : 'Unsnoozed.');
  };
  /**
   * A row this window's own snooze moved (`moveSnoozedRow`) whose snooze then
   * changed, the list still on screen: unsnoozed, it goes back between the
   * neighbours it had (held.ts `putRowBack`), in its state as it is now;
   * snoozed again, it takes its place in the band. Nothing once the list has
   * settled since (`snoozeMoved` is emptied then) or where a thread covers it.
   */
  const putSnoozedRowBack = (threadId: string, drawnBefore: InboxListSection[] | null) => {
    const now = rowOf(threadId);
    if (!drawnBefore || !now || (routeRef.current.thread && listCovered()) || drawnSection(shownRef.current, threadId) !== 'snoozed') return;
    armSlide();
    setShown((current) => (current ? (now.snoozed ? settleThread(current, listGroups(latestRef.current!), threadId) : putRowBack(replaceHeldRow(current, now), drawnBefore, threadId)) : current));
  };
  /**
   * One row to where the latest read puts it, the rest of the list held (held.ts `settleThread`), with the settle's
   * slide. False when the list on screen has no row for it.
   */
  const moveRowAlone = (threadId: string): boolean => {
    if (!latestRef.current || drawnSection(shownRef.current, threadId) === null) return false;
    const groups = listGroups(latestRef.current);
    armSlide();
    setShown((current) => (current ? settleThread(current, groups, threadId) : current));
    return true;
  };
  /**
   * Unsnooze: the thread is back in its section now. A row this window's own
   * snooze moved comes back at once, as Snooze's Undo brings it (the person's
   * own snooze undone); any other held row waits for the list to settle. Undo
   * snoozes it again, to the same time, and sends a row that came back to the
   * band again.
   */
  const unsnooze = async (row: Pick<InboxListRow, 'thread_id' | 'subject'>) => {
    const threadId = row.thread_id;
    const earlier = (rowOf(threadId) ?? (threadRow?.thread_id === threadId ? threadRow : null))?.snoozed ?? null;
    const drawnBefore = snoozeMoved.current.get(threadId) ?? null;
    try {
      await inboxApi.snooze(threadId, null);
    } catch (cause) {
      showError(cause);
      return;
    }
    snoozeMoved.current.delete(threadId);
    await afterWrite([threadId]);
    putSnoozedRowBack(threadId, drawnBefore);
    // With no thread open the row comes back to its section now (a write's read no longer adopts the list, R7).
    const cameBack = !drawnBefore && !routeRef.current.thread && moveRowAlone(threadId);
    showToast({
      icon: 'clock',
      lead: 'Unsnoozed',
      speech: `Unsnoozed “${row.subject ?? '(no subject)'}”.`,
      onUndo: earlier
        ? () => {
            dismissToast();
            void restoreSnooze(threadId, earlier).then(() => {
              if (!drawnBefore && !cameBack) return;
              const moved = moveSnoozedRow(threadId);
              if (moved) snoozeMoved.current.set(threadId, moved);
            });
          }
        : undefined,
    });
  };

  /**
   * Pin a thread to the sidebar, or unpin it (approval "inbox-pinned-threads"),
   * from the row menu, the thread header or the pinned row's menu. A pin is the
   * person's own write and moves no row. Pin says so in the live region only
   * (the row appears in Pinned); Unpin shows the toast "Unpinned · Still in
   * <section>" with Undo, which puts the pin back at its old place.
   */
  const setPin = async (row: Pick<InboxListRow, 'thread_id' | 'subject'>, pinned: boolean) => {
    // Unpin's Undo puts this one thread back where it was, with the time it was first pinned.
    const pinsNow = latestRef.current?.pins ?? [];
    const index = pinsNow.findIndex((pin) => pin.thread_id === row.thread_id);
    const pinnedAt = index >= 0 ? (pinsNow[index]!.pinned_at ?? null) : null;
    // Where it still is, from the pinned row (an archived thread has none in the list) or the list.
    const listed = (latestRef.current?.pins ?? []).find((pin) => pin.thread_id === row.thread_id) ?? rowOf(row.thread_id) ?? (threadRow?.thread_id === row.thread_id ? threadRow : null);
    if (pinned) noteStarred(row.thread_id);
    try {
      await inboxApi.pin(row.thread_id, pinned);
    } catch (cause) {
      if (pinned) noteStarred(null);
      showError(cause);
      return;
    }
    // A new pin is seen: pinning while Pinned is closed opens it (owner's call, direction C).
    if (pinned) setSidebarSectionOpen('pinned', true);
    await refreshList(false);
    const subject = row.subject ?? '(no subject)';
    if (pinned) {
      say(`Starred “${subject}”`);
      return;
    }
    const canUndo = index >= 0 && pinnedAt !== null;
    showToast({
      icon: 'unpin',
      lead: 'Unstarred',
      detail: unpinnedWhere(listed),
      speech: `Unstarred “${subject}”. ${unpinnedWhere(listed)}.`,
      onUndo: canUndo ? () => void restorePin({ thread_id: row.thread_id, index, pinned_at: pinnedAt! }, subject) : undefined,
    });
  };
  /**
   * Unpin's Undo: that one thread pinned again at its old place with its
   * original `pinned_at`. Never a whole remembered order, which would bring
   * back a pin another tab removed meanwhile.
   */
  const restorePin = async (restore: { thread_id: string; index: number; pinned_at: string }, subject: string) => {
    noteStarred(restore.thread_id);
    try {
      await inboxApi.pinRestore(restore);
    } catch (cause) {
      noteStarred(null);
      showError(cause);
      return;
    }
    setSidebarSectionOpen('pinned', true);
    await refreshList(false);
    dismissToast();
    say(`Starred “${subject}” again.`);
  };
  /**
   * A press on the star a list row shows (the owner, 2026-11-05): Unstar, with what the menus' item does (the toast and
   * `Z`). It opens nothing and marks nothing read. One press at a time per thread: a double click is one unstar.
   */
  const unstarring = useRef(new Set<string>());
  const unstarRow = (row: InboxListRow) => {
    if (unstarring.current.has(row.thread_id)) return;
    unstarring.current.add(row.thread_id);
    void setPin(row, false).finally(() => unstarring.current.delete(row.thread_id));
  };
  /** A pinned row's menu: Unpin, Move up, Move down, Copy link. */
  const pinAction = async (row: InboxListRow, action: PinnedAction, pills = false) => {
    if (action === 'unpin') return void setPin(row, false);
    if (action === 'copy-link') return void rowAction(row, 'copy-link');
    const order = (latestRef.current?.pins ?? []).map((pin) => pin.thread_id);
    const next = movePin(order, row.thread_id, action === 'up' ? -1 : 1);
    if (next.every((id, i) => id === order[i])) return;
    try {
      await inboxApi.pinOrder(next);
    } catch (cause) {
      showError(cause);
      return;
    }
    await refreshList(false);
    // The list's pills run sideways: their menu says Move left and Move right for the same two moves.
    say(pills ? (action === 'up' ? 'Moved left.' : 'Moved right.') : action === 'up' ? 'Moved up.' : 'Moved down.');
  };
  /**
   * A pinned row opens its thread and leaves the list as it is (the project
   * filter and the sections), as a search result does; an archived thread
   * opens as a deep link to it does. The open thread's pinned row does nothing.
   */
  const openPinned = (row: InboxListRow) => {
    const now = routeRef.current;
    if (now.page === 'inbox' && now.thread === row.thread_id) return;
    go({ page: 'inbox', project: now.page === 'inbox' ? now.project : null, thread: row.thread_id });
  };

  /**
   * The row menu's Copy thread (copyMarkdown.ts): the open thread as it is on
   * screen, any other read first (one clipboard item with promised parts, so
   * the write still starts inside the click).
   */
  const copyThreadOf = (row: InboxListRow) => {
    let count = 0;
    const read = thread?.thread_id === row.thread_id ? Promise.resolve(thread) : inboxApi.thread(row.thread_id).then((model) => model.thread);
    const markdown = read.then((open) => {
      count = open.messages.length;
      return threadMarkdown(open);
    });
    void copyMarkdown(markdown).then((ok) =>
      showToast(ok ? { icon: 'check', lead: 'Thread copied', detail: plural(count, 'message') } : { icon: 'warn', lead: "Couldn't copy" }, 4200),
    );
  };
  /**
   * A thread row's right-click menu. Copy link and Copy thread ID say so in
   * the window's one toast; Mark read, Move back and Archive are the row's
   * hover action and the header's, with their toasts.
   */
  const rowAction = (row: InboxListRow, action: RowMenuAction) => {
    if (action === 'pin' || action === 'unpin') return void setPin(row, action === 'pin');
    if (action === 'read' || action === 'unread') return void markRead(row.thread_id, action === 'read');
    if (action === 'mark-unread') return void markUnread(row.thread_id);
    if (action === 'unsnooze') return void unsnooze(row);
    if (action === 'archive') return void archive(row.thread_id, row.thread_id, true);
    if (action === 'copy-thread') return void copyThreadOf(row);
    const text = action === 'copy-link' ? threadLink(row.thread_id, settings, window.location.origin) : row.thread_id;
    void copyTextToClipboard(text).then((ok) =>
      showToast(
        ok
          ? { icon: 'check', lead: action === 'copy-link' ? 'Link copied' : 'Thread ID copied', detail: `“${row.subject ?? '(no subject)'}”` }
          : { icon: 'warn', lead: "Couldn't copy" },
        4200,
      ),
    );
  };

  /**
   * The project menu (design record "inbox-project-menu", approved
   * 2026-10-14): Mark all as read and Archive all on one project, each one
   * batch on the server, with one Undo for the batch (the toast, `Z`). The
   * same held-order rules as the single actions: the rows show their new
   * state in place, a thread open or none, and take their places when the
   * list next settles (approval "inbox-list-view", R7). A project left with
   * nothing listed leaves the sidebar (the one the list shows stays until
   * the person leaves it).
   */
  const projectAction = async (projectId: string, action: ProjectAction) => {
    const name = latestRef.current?.projects.find((p) => p.id === projectId)?.name ?? 'the project';
    const before = (latestRef.current?.sections ?? []).flatMap((section) => section.threads).filter((row) => row.project.id === projectId);
    let taken: string[];
    let undo: () => Promise<unknown>;
    /** The batch stopped partway: Undo still covers what it changed, and the toast says the rest did not change. */
    let incomplete: string | null = null;
    try {
      if (action === 'read') {
        // The rows Mark all as read takes (single Mark read's rule; never a snoozed one): the warning asks first when it
        // would close questions.
        if (!(await warnSetAside(setAsideCount(before.filter((row) => offersRowMarkRead(row)), { skipSnoozed: true }), true))) return;
        const answer = await inboxApi.markProjectRead(projectId, newBatchId());
        const looked = answer.batch.looked ?? [];
        taken = [...answer.batch.read, ...looked];
        incomplete = answer.error?.message ?? null;
        undo = () => inboxApi.unmarkProjectRead(projectId, answer.batch.read, looked);
      } else {
        const answer = await inboxApi.archiveProject(projectId, newBatchId());
        taken = [...answer.batch.resolved, ...answer.batch.read];
        incomplete = answer.error?.message ?? null;
        undo = () => inboxApi.unarchiveProject(projectId, answer.batch);
        // The list leaves archived threads out; each taken row stays where it is, shown archived, and goes when the
        // list next settles (as the single Archive does, a thread open or none).
        const at = new Date().toISOString();
        setShown((current) => (current ? taken.reduce((sections, id) => markHeldRowArchived(sections, id, at), current) : current));
      }
    } catch (cause) {
      showToast(errorToast(cause, 'The project did not change.'));
      return;
    }
    await afterWrite(taken);
    if (taken.length === 0) {
      if (incomplete) showToast({ icon: 'warn', lead: `${name} did not change`, detail: incomplete, wrap: true });
      else say(action === 'read' ? `Nothing in ${name} waits on you.` : `Nothing in ${name} to archive.`);
      return;
    }
    const copy = projectBatchToast(action, name, taken.length, before.filter((row) => taken.includes(row.thread_id)));
    showToast({
      ...copy,
      // Stopped partway: the warning, and why, whole (it may wrap); Undo still covers what did apply.
      // The project is on screen (its menu was just used) and in what the live region says.
      ...(incomplete ? { icon: 'warn' as const, detail: incomplete, phoneDetail: undefined, speech: `${copy.lead} in ${name}. ${incomplete}`, wrap: true } : {}),
      onUndo: () => {
        void (async () => {
          try {
            await undo();
          } catch (cause) {
            showToast(errorToast(cause, 'The project did not change.'));
            return;
          }
          await afterWrite(taken);
          dismissToast();
          say('Moved back.');
        })();
      },
    });
  };

  /**
   * The project menu's Rename… (a name) and Reset name (null): the project's
   * `display_name` on the server, then the list read again, so the sidebar,
   * the rows, search and the project's list all read the new name before the
   * field closes. A refused name keeps the field open, with the toast.
   */
  const renameProject = async (projectId: string, name: string | null): Promise<boolean> => {
    try {
      await inboxApi.renameProject(projectId, name);
    } catch (cause) {
      showToast(errorToast(cause, 'The name did not change.'));
      return false;
    }
    await refreshList(false);
    const now = latestRef.current?.projects.find((p) => p.id === projectId)?.name;
    say(name === null ? `Name reset${now ? ` to ${now}` : ''}.` : `Renamed to ${name}.`);
    return true;
  };

  /**
   * The project menu's Set picture… (approval "inbox-letter-marks"): the picture kept by the Inbox, then the list read
   * again, so every project mark shows it. A refused picture (not an image, too big) says why in the toast.
   */
  const setProjectPicture = async (projectId: string, file: File | null): Promise<boolean> => {
    try {
      const read = file ? await pictureFromFile(file) : { picture: null };
      if ('refused' in read) {
        showToast({ icon: 'warn', lead: read.refused, wrap: true });
        return false;
      }
      await inboxApi.setProjectPicture(projectId, read.picture);
    } catch (cause) {
      showToast(errorToast(cause, 'The picture did not change.'));
      return false;
    }
    await refreshList(false);
    return true;
  };

  /**
   * Combine projects (approval "project-combine"): each `from` goes into its
   * `into`. One toast with one Undo for the whole step (the button and `Z`),
   * whichever of the rename warning or Tidy took it. Pairs that went through
   * stay, and Undo takes them back, even when a later one was refused.
   */
  const combineProjects = async (pairs: readonly { from: string; into: string; intoName: string }[]): Promise<string | null> => {
    const write = async (steps: readonly { project: string; into: string | null }[]) => {
      const done: { project: string; into: string | null }[] = [];
      for (const step of steps) {
        try {
          await inboxApi.combineProject(step.project, step.into);
          done.push(step);
        } catch (cause) {
          return { done, failed: cause };
        }
      }
      return { done, failed: null };
    };
    const { done, failed } = await write(pairs.map((pair) => ({ project: pair.from, into: pair.into })));
    await refreshList(false);
    const failure = failed === null ? null : failed instanceof Error ? failed.message : 'The projects did not change.';
    if (done.length === 0) {
      showToast(errorToast(failed, 'The projects did not change.'));
      return failure;
    }
    const lead = done.length === 1 ? `Combined into ${pairs[0]!.intoName}` : `Combined ${formatCount(done.length)} projects`;
    const undo = done.map((step) => ({ project: step.project, into: null }));
    showToast({
      icon: 'check',
      lead,
      onUndo: () => {
        void (async () => {
          const back = await write(undo);
          await refreshList(false);
          if (back.failed !== null) {
            showToast(errorToast(back.failed, 'The projects did not change.'));
            return;
          }
          dismissToast();
          say('Combine undone.');
        })();
      },
    });
    say(`${lead}.`);
    return failure;
  };

  /**
   * Settings' Unarchive: the thread goes back to the list, in whatever
   * section its state puts it, and opens there (owner ruling 2026-10-12).
   */
  const unarchiveFromSettings = async (row: InboxListRow): Promise<boolean> => {
    try {
      await inboxApi.resolve(row.thread_id, false);
    } catch (cause) {
      showError(cause);
      return false;
    }
    go({ page: 'inbox', project: null, thread: row.thread_id });
    await refreshList(true);
    showToast({
      icon: 'check',
      lead: 'Back in your Inbox',
      detail: `“${row.subject ?? '(no subject)'}”`,
      onUndo: () => void archive(row.thread_id, row.thread_id, true),
    });
    return true;
  };

  // E marks the open thread (or the focused row) read, and again moves it
  // back; Z undoes while the toast is up. Never while typing, never with a
  // modifier (so the reply box keeps its own ⌘Z).
  // An open file (its viewer, the stepping bar, the guard row) and a guided
  // review own the keyboard: E and Z stand down there, and while the sound
  // dialog is up.
  const keysRef = useRef({ markRead, toast, thread, soundDialog, agentNoteOpen: false, feedbackOpen: false });
  keysRef.current = { markRead, toast, thread, soundDialog, agentNoteOpen: typeof agentNote === 'object', feedbackOpen };
  /**
   * What E or Z does now, or null when it stands down (the rules: guards.ts
   * for typing, composition and repeat; the rest is the thread's own).
   */
  const threadKeyAction = (event: KeyboardEvent, key: 'e' | 'z' | 'archive'): (() => void) | null => {
    if (event.defaultPrevented || isRepeatKey(event) || isComposingKey(event) || !singleKeysLive()) return null;
    if (keysRef.current.soundDialog === 'open' || keysRef.current.agentNoteOpen || keysRef.current.feedbackOpen || routeRef.current.guide) return null;
    // Under a dialog (Decide opens over the thread it came from) the letters are the dialog's.
    if (modalOpen()) return null;
    // Words selected in a message: its toolbar takes the letters (a comment starting with them).
    if (selectionToolbarShowing()) return null;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target) {
      if (isEditableTarget(target)) return null;
      if (target.closest('dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], iframe, .ib-view, [data-step-guard]')) return null;
    }
    // With a file open beside the thread, only a key aimed at the thread or the list counts.
    if (routeRef.current.file && !target?.closest('section.ib-pane, .ib-listcol')) return null;
    const { markRead: toggle, toast: current, thread: open } = keysRef.current;
    // Never over the tour: its screens are a replay, and an undo would write to the Inbox underneath.
    if (key === 'z') return routeRef.current.page === 'tour' ? null : (current?.onUndo ?? null);
    if (routeRef.current.page !== 'inbox') return null;
    // A row the keyboard is on wins over the thread open beside the list; a
    // row that merely holds focus (clicked, or put there after a mouse close) does not.
    const rowEl = target?.closest('.ib-listcol [data-row]') ?? null;
    const rowId = rowEl && target && keyboardFocused(target) ? rowEl.getAttribute('data-row') : null;
    if (key === 'archive') {
      // Shift+E (approval "inbox-keyboard-keys-2026-11-07", item 2): Archive, as the menus' item, Z undoing it.
      const to = archiveTarget({ keyRow: rowId, open, routeThread: routeRef.current.thread, resolvedOf: (id) => rowOf(id)?.resolved_at });
      return to ? () => void archive(to.threadId, to.messageId, true) : null;
    }
    const threadId = rowId ?? (open && open.thread_id === routeRef.current.thread ? open.thread_id : null);
    if (!threadId) return null;
    const row = rowOf(threadId);
    if (!row || !canToggleRead(row, drawnSection(shownRef.current, threadId))) return null;
    return () => void toggle(threadId, !(row.read_at ?? null));
  };
  const threadKey = useRef<(() => void) | null>(null);
  /**
   * J / K (approval "inbox-keyboard-shortcuts", J/K swap addendum 2026-10-27): the next or previous thread in the
   * list as it shows (threadStep.ts), opened as Enter opens a row, replacing the open one in history so Back still
   * goes to the list. From the thread focus lands where N puts it (Thread.tsx takes it); from the list it stays on
   * the rows, on the new one. Not from a file, a guided review or the Artifacts view. With no thread open, on the
   * list's rows, they move along the threads: the next one there, past the groups' headers, nothing opened (`listKeyTarget`, no wrap).
   */
  const threadStepKey = (dir: 1 | -1) => ({
    when: (event: KeyboardEvent) => {
      if (!bareKeyAllowed(event)) return false;
      const now = routeRef.current;
      if (now.page !== 'inbox' || now.file || now.guide || now.artifacts) return false;
      const target = keyTarget(event);
      if (!now.thread) return !!target?.closest('.ib-main .ib-lbody') && target.matches(LIST_STOPS);
      return !target || target === document.body || !!target.closest('section.ib-pane, .ib-main .ib-lbody');
    },
    handle: (event: KeyboardEvent) => {
      const now = routeRef.current;
      const body = listBody(rootRef.current);
      if (!body) return;
      if (!now.thread) {
        // Threads only: J K pass over the groups' headers (listKeys.ts), as they step threads with one open.
        const next = listKeyTarget(body, keyTarget(event), dir > 0 ? 'j' : 'k');
        next?.focus({ preventScroll: true });
        next?.scrollIntoView?.({ block: 'nearest' });
        return;
      }
      // The open thread's row may have left the list (E moved it to folded Quiet): step from the slot it had.
      const slot = openSlot.current?.thread === now.thread ? openSlot.current.order : [];
      const step = threadStep(drawnOrder(body), now.thread, dir, slot);
      if (!step) return say('This thread is not in the list on screen.');
      if ('end' in step) return say(step.end === 'last' ? 'Last thread' : 'First thread');
      const fromList = !!keyTarget(event)?.closest('.ib-main .ib-lbody');
      // Into another section: its name, as the eye sees the band.
      const section = (id: string) => rowElement(body, id)?.closest('[role="group"]')?.getAttribute('aria-label') ?? null;
      const into = section(step.to);
      const from = section(now.thread);
      if (into && from && into !== from) say(into);
      askArrivalFocus(fromList ? null : step.to);
      writeRoute({ page: 'inbox', reviews: now.reviews, project: now.project, machine: now.machine, agent: now.agent, thread: step.to }, { replace: true });
      if (fromList) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const list = listBody(rootRef.current);
          if (list) rowElement(list, step.to)?.focus({ preventScroll: true });
        }));
      }
    },
  });
  useShortcutScope({
    scope: inboxThreadShortcuts,
    handlers: {
      markRead: {
        when: (event) => (threadKey.current = threadKeyAction(event, 'e')) !== null,
        handle: () => threadKey.current?.(),
      },
      undo: {
        when: (event) => (threadKey.current = threadKeyAction(event, 'z')) !== null,
        handle: () => threadKey.current?.(),
      },
      archive: {
        when: (event) => (threadKey.current = threadKeyAction(event, 'archive')) !== null,
        handle: () => threadKey.current?.(),
      },
      nextThread: threadStepKey(1),
      previousThread: threadStepKey(-1),
    },
  });

  // The window's keys (shortcuts/app.shortcuts.ts; approval "inbox-keyboard-shortcuts"): `?` opens the shortcut
  // map; G then I, B or S go to the Inbox, the Board, Settings, focus landing on what is there (never on the page).
  // Single keys, so none while typing or under a dialog (guards.ts), nor over the tour's replay, nor on a touch
  // phone, except `?`: a phone with a hardware keyboard still opens the map (design §5.4).
  const [mapOpen, setMapOpen] = useState(false);
  /** What G P, G D and C need from later in the render: whether Reviews and Drafts show, and whether compose is up. */
  const pagesRef = useRef({ pulls: false, drafts: false, composing: false });
  /** What Shift+R runs: the refresh of the page on screen, set as the page is drawn; null where it has none. */
  const refreshRef = useRef<(() => void) | null>(null);
  const appKeyAllowed = (event: KeyboardEvent, onTouchPhone = false) => appKeyAllowedOn(event, routeRef.current.page, onTouchPhone);
  /** Focus the first of `selectors` on screen once the page it is on has drawn (two frames: the route, then its layout). */
  const focusSoon = (selectors: readonly string[]) => requestAnimationFrame(() => requestAnimationFrame(() => focusFirst(selectors)));
  /**
   * Focus on the list: the open thread's row, else the first row (G I, and the "Skip to the list" link). The list is
   * hidden under a thread in full screen: it comes back first, so its row can take focus.
   */
  const focusTheList = () => {
    const now = routeRef.current;
    if (threadFullRef.current) leaveFullRef.current();
    const open = now.page === 'inbox' ? now.thread : null;
    focusSoon([...(open ? [`.ib-main .ib-lbody [data-thread-id="${CSS.escape(open)}"]`] : []), '.ib-main .ib-lbody [data-thread-id]', '.ib-main .ib-lbody button.ib-band', '.ib-main .ib-empty h2', '.ib-main h1']);
  };
  useShortcutScope({
    scope: inboxAppShortcuts,
    handlers: {
      openMap: { when: (event) => appKeyAllowed(event, true), handle: () => setMapOpen(true) },
      goInbox: {
        when: (event) => appKeyAllowed(event),
        handle: () => {
          if (routeRef.current.page !== 'inbox') leave({ page: 'inbox', project: null, thread: null });
          focusTheList();
        },
      },
      goBoard: {
        when: (event) => appKeyAllowed(event) && boardOnRef.current,
        handle: () => {
          if (routeRef.current.page !== 'board') leave({ page: 'board', project: null, thread: null });
          focusSoon(['.ib-bpage h1']);
        },
      },
      // G P and G D (approval "inbox-keyboard-keys-2026-11-07", item 5): only while the sidebar shows their row.
      goSettings: {
        when: (event) => appKeyAllowed(event),
        handle: () => {
          if (routeRef.current.page !== 'settings') leave({ page: 'settings', project: null, thread: null });
          else focusSoon(['.ib-spage h1']);
        },
      },
      // C (item 4): the sidebar pencil's New message; focus goes back to where it was when it closes.
      // G P, G D and C (keyboard/appKeys.ts has their gates).
      ...newPageKeys(() => ({ page: routeRef.current.page, ...pagesRef.current }), {
        goPulls: () => {
          if (routeRef.current.page !== 'reviews') leave({ page: 'reviews', project: null, thread: null });
          focusSoon(['[data-pulls-heading]', '.ib-prlist h1']);
        },
        goDrafts: () => {
          if (routeRef.current.page !== 'drafts') leave({ page: 'drafts', project: null, thread: null });
          focusSoon(['[data-drafts-page] h1']);
        },
        compose: () => openCompose({}),
      }),
      // Shift+R (approval "inbox-refresh-key"): what the page's own refresh does (keyboard/appKeys.ts has its gate).
      ...refreshKey(() => ({ page: routeRef.current.page, run: refreshRef.current })),
    },
  });

  const restart = async () => {
    setRestarting(true);
    const before = latest?.serverSession;
    /** Over the tailnet nobody is at the computer to see why: the window says what it knows. */
    const notBack = () => {
      setRestarting(false);
      if (settings?.via === 'tailnet') showToast({ icon: 'warn', lead: 'The Inbox hasn’t come back yet. If it stays away, start it on the computer.', wrap: true }, RESTART_NOT_BACK_MS);
    };
    try {
      await inboxApi.restart();
    } catch {
      notBack();
      return;
    }
    // The new Inbox comes up on the same port: reload once it answers.
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const health = await inboxApi.health();
        if (health.serverSession !== before) {
          // The person already chose to restart (asked first when a reply would be lost): no second question.
          leaveOnPurpose();
          window.location.reload();
          return;
        }
      } catch {
        // Not up yet.
      }
    }
    notBack();
  };

  /**
   * The stale page notice's Reload: what the person wrote is saved first (stalePage.ts flushBeforeReload), then the
   * page reloads onto the Inbox's own. Anything not saved stops it, said in a toast that offers to reload anyway.
   */
  const reloadOntoUpdate = async () => {
    if (staleReloading) return;
    setStaleReloading(true);
    // Saves first (the running Inbox's session for them only, when it restarted under this page), then reloads.
    if (await reloadOntoInbox()) return;
    setStaleReloading(false);
    showToast(
      {
        icon: 'warn',
        lead: 'Not reloaded: something you wrote is not saved yet.',
        wrap: true,
        action: {
          label: 'Reload anyway',
          onPress: () => {
            leaveOnPurpose();
            window.location.reload();
          },
        },
      },
      STALE_NOT_SAVED_MS,
    );
  };

  /** Restart onto the binary on disk, after saying what an unsent reply would lose. */
  const requestRestart = () => {
    if (unsentReply()) setUpdateDialog('restart');
    else void restart();
  };

  /** The sidebar button (and What's new's Update): what a press does depends on the state. */
  const pressUpdate = () => {
    if (!update || restarting) return;
    setUpdateError(null);
    if (update.state === 'ready') requestRestart();
    else if (update.state === 'available') {
      setUpdateDialog('update');
      void loadUpdateDetails();
    } else if (update.state === 'failed') {
      setUpdateDialog('failed');
      void loadUpdateDetails();
    }
  };

  /** Update now: the install script runs on the server; the button shows Updating… until the binary is in. */
  const updateNow = async () => {
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      const result = await inboxApi.updateNow();
      restartWhenReady.current = true;
      setUpdate(result.update);
      setUpdateDialog(null);
    } catch (cause) {
      setUpdateError(cause instanceof Error ? cause.message : 'The update could not start.');
    } finally {
      setUpdateBusy(false);
    }
  };

  // The update the person started is in: restart onto it (asking first when a reply would be lost).
  useEffect(() => {
    if (update?.state !== 'ready' || !restartWhenReady.current) return;
    restartWhenReady.current = false;
    if (unsentReply()) setUpdateDialog('restart');
    else void restart();
    // restart() reads only refs and setters it closes over each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update?.state]);

  const remindTomorrow = async () => {
    try {
      const result = await inboxApi.snoozeUpdate();
      setUpdate(result.update);
    } catch {
      // Nothing changes; the button stays.
    }
    setUpdateDialog(null);
  };

  const saveUpdateSwitches = async (change: { update_check?: boolean; auto_update?: boolean }) => {
    setSettingsError(null);
    setUpdateError(null);
    try {
      const saved = await inboxApi.saveUpdateSwitches(change);
      setSettings((current) => (current ? { ...current, updates: saved.updates } : current));
      setUpdateDetails((current) =>
        current ? { ...current, auto_update: { ...current.auto_update, on: saved.updates.auto_update.on }, check: { ...current.check, on: saved.updates.update_check.on } } : current,
      );
      void refreshList(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The setting was not saved.';
      setSettingsError(message);
      setUpdateError(message);
    }
  };

  const checkNow = async () => {
    setChecking(true);
    setSettingsError(null);
    try {
      const result = await inboxApi.checkForUpdate();
      setUpdateDetails(result);
      setUpdate(result.update);
      if (!result.checked.ok) setSettingsError(`Couldn't check for updates: ${result.checked.error ?? 'the check failed'}.`);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The check failed.');
    } finally {
      setChecking(false);
    }
  };

  const openWhatsNew = (version: string) => {
    setUpdateDialog(null);
    go({ page: 'whats-new', project: null, thread: null, version });
  };

  const whatsNewVersion = route.page === 'whats-new' ? (route.version ?? null) : null;
  const onWhatsNewPage = route.page === 'whats-new';
  // The releases panel: once per visit (switching releases keeps it), asked again while the server fetches the list.
  const [whatsNewReleasesNonce, setWhatsNewReleasesNonce] = useState(0);
  useEffect(() => {
    if (!onWhatsNewPage) {
      setWhatsNewReleases(null);
      return;
    }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      inboxApi
        .whatsNewReleases()
        .then((model) => {
          if (cancelled) return;
          setWhatsNewReleases(model);
          if (model.refreshing && attempt < WHATS_NEW_RELEASES_RETRIES) retry = setTimeout(() => load(attempt + 1), WHATS_NEW_RELEASES_RETRY_MS);
        })
        // No panel: the notes still read on their own.
        .catch(() => {});
    };
    load(0);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [onWhatsNewPage, whatsNewReleasesNonce]);
  const whatsNewReleasesRef = useRef(whatsNewReleases);
  whatsNewReleasesRef.current = whatsNewReleases;
  useEffect(() => {
    if (!whatsNewVersion) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setWhatsNew(null);
    setWhatsNewError(null);
    const retried = whatsNewRetryFor.current === whatsNewVersion;
    whatsNewRetryFor.current = null;
    // Notes this machine never saved are fetched from GitHub by the server,
    // which answers `notes_loading` while that takes longer than it waits.
    const load = (attempt: number) => {
      inboxApi
        .whatsNew(whatsNewVersion, attempt === 0 && retried)
        .then((model) => {
          if (cancelled) return;
          setWhatsNew(model);
          // Notes the panel did not have yet (fetched just now): its row gets their TL;DR.
          const row = whatsNewReleasesRef.current?.releases.find((r) => r.version === model.version);
          if (row && !row.saved) setWhatsNewReleasesNonce((n) => n + 1);
        })
        .catch((cause) => {
          if (cancelled) return;
          if (cause instanceof InboxApiError && cause.code === 'notes_loading' && attempt < WHATS_NEW_RETRIES) {
            retry = setTimeout(() => load(attempt + 1), WHATS_NEW_RETRY_MS);
            return;
          }
          setWhatsNewError({ message: cause instanceof Error ? cause.message : String(cause), code: cause instanceof InboxApiError ? cause.code : null });
        });
    };
    load(0);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [whatsNewVersion, whatsNewRetry]);

  const toggleTool = async (host: AgentToolHost, next: boolean) => {
    setSettingsError(null);
    setSettings((current) =>
      current ? { ...current, inbox_tool: { ...current.inbox_tool, hosts: { ...current.inbox_tool.hosts, [host]: next } } } : current,
    );
    try {
      const saved = await inboxApi.saveInboxTool({ [host]: next });
      setSettings((current) => (current ? { ...current, inbox_tool: saved.inbox_tool } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  // Settings → General: "Open Plannotator at plannotator.localhost" (#2184), saved to config.json; applies from the next start.
  const toggleCookieHost = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current?.cookie_host ? { ...current, cookie_host: { ...current.cookie_host, on: next } } : current));
    try {
      const saved = await inboxApi.saveCookieHost(next);
      setSettings((current) => (current ? { ...current, cookie_host: saved.cookie_host } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  // Settings → Capabilities → Experimental: decision mode, saved to config.json and applied at once.
  // The Board's switch: saved to config.json; the page and the sidebar row follow at once, agents at their next session.
  const toggleBoard = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current ? { ...current, board: { on: next } } : current));
    try {
      const saved = await inboxApi.saveBoard(next);
      setSettings((current) => (current ? { ...current, board: saved.board } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  // Bro mode (approval "bro-mode"): every other window hears `event: capabilities`.
  const toggleBro = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current ? { ...current, bro: { on: next } } : current));
    try {
      const saved = await inboxApi.saveBro(next);
      setSettings((current) => (current ? { ...current, bro: saved.bro } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  // Floating reply drafts (approval "inbox-reply-floaters", off by default): every other window hears `event: capabilities`.
  const toggleFloatDrafts = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current ? { ...current, float_drafts: { on: next } } : current));
    try {
      const saved = await inboxApi.saveFloatDrafts(next);
      setSettings((current) => (current ? { ...current, float_drafts: saved.float_drafts } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  // The Mark read warning (Settings, and the warning's "Don't show this again"): every other window hears `event: capabilities`.
  const toggleMarkReadWarning = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current ? { ...current, mark_read_warning: { on: next } } : current));
    try {
      const saved = await inboxApi.saveMarkReadWarning(next);
      setSettings((current) => (current ? { ...current, mark_read_warning: saved.mark_read_warning } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  // Thread steps (approval "inbox-thread-steps"): every other window hears `event: capabilities`.
  const toggleSteps = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current ? { ...current, steps: { on: next } } : current));
    try {
      const saved = await inboxApi.saveSteps(next);
      setSettings((current) => (current ? { ...current, steps: saved.steps } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  // Code review (approval "inbox-code-review-direction"): every other window hears `event: capabilities`.
  const toggleCodeReview = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current ? { ...current, code_review: { on: next } } : current));
    try {
      const saved = await inboxApi.saveCodeReview(next);
      reloadSkillCatalog();
      setSettings((current) => (current ? { ...current, code_review: saved.code_review } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  // System (approval "system-inbox", screen 1): under Code review; every other window hears `event: capabilities`.
  const toggleSystem = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current ? { ...current, system: { on: next } } : current));
    try {
      const saved = await inboxApi.saveSystem(next);
      setSettings((current) => (current ? { ...current, system: saved.system ?? { on: next } } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  // Chapter diagrams, under Code review: every other window hears `event: capabilities`.
  const toggleChapterDiagrams = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current ? { ...current, chapter_diagrams: { on: next } } : current));
    try {
      const saved = await inboxApi.saveChapterDiagrams(next);
      setSettings((current) => (current ? { ...current, chapter_diagrams: saved.chapter_diagrams ?? { on: next } } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  const toggleShape = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current ? { ...current, shape: { on: next } } : current));
    try {
      const saved = await inboxApi.saveShape(next);
      reloadSkillCatalog();
      setSettings((current) => (current ? { ...current, shape: saved.shape } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  const toggleExperimental = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current ? { ...current, experimental: { decision_mode: { on: next, env: current.experimental?.decision_mode.env ?? null } } } : current));
    try {
      const saved = await inboxApi.saveExperimental({ decision_mode: next });
      setSettings((current) => (current ? { ...current, experimental: saved.experimental } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  // "Over your tailnet": saved to config.json and applied at once; the answer carries the address or why not.
  const [tailscaleBusy, setTailscaleBusy] = useState(false);
  const toggleTailscale = async (next: boolean, replaceExposed = false) => {
    setSettingsError(null);
    setTailscaleBusy(true);
    try {
      const saved = await inboxApi.saveTailscale(next, replaceExposed);
      setSettings((current) => (current ? { ...current, tailscale: saved.tailscale } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    } finally {
      setTailscaleBusy(false);
    }
  };

  // Settings' Delete thread / Delete project: the answer carries the sizes counted after it; the list is read again.
  const deleteThread = async (threadId: string) => {
    setSettingsError(null);
    try {
      adoptStore((await inboxApi.deleteThread(threadId)).store);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The thread was not deleted.');
      readStore();
    }
    await refreshList(true);
  };
  const deleteProject = async (projectId: string) => {
    setSettingsError(null);
    try {
      adoptStore((await inboxApi.deleteProject(projectId)).store);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The project was not deleted.');
      readStore();
    }
    await refreshList(true);
  };

  const projects = latest?.projects ?? [];
  /** Settings → Activity reads this Inbox's own store: its own projects only (not a linked machine's). */
  const activityProjects = useMemo(() => projects.filter((p) => !p.machine || p.machine === selfMachineId()), [projects]);
  // A project that was combined (here, in another window, by an agent) has no page of its own: its link opens the project it went into.
  const combinedHead = route.project ? projects.find((project) => project.combined?.some((member) => member.id === route.project))?.id : undefined;
  useEffect(() => {
    if (combinedHead) writeRoute({ ...route, project: combinedHead }, { replace: true });
  }, [combinedHead]);
  const latestSections = latest?.sections ?? [];
  // Every row the list knows, the Snoozed band's too: only counts read `latestSections`, which has none of those.
  const latestGroups = useMemo(() => (latest ? listGroups(latest) : []), [latest]);
  const latestRows = useMemo(() => new Map(latestGroups.flatMap((section) => section.threads).map((row) => [row.thread_id, row] as const)), [latestGroups]);
  // Decision mode is on only while settings say so; with it off, nothing of it renders and nothing is read.
  const decisionModeOn = settings?.experimental?.decision_mode.on === true;
  decisionModeOnRef.current = decisionModeOn;
  useEffect(() => {
    if (decisionModeOn) void refreshDecisions();
    else {
      setDecisions(null);
      setDecide(null);
    }
  }, [decisionModeOn, refreshDecisions]);
  /** A thread's "Decide these N": decision mode on, no sitting going, and two or more of its decisions waiting. */
  const decideInThread = (threadId: string) => {
    if (!decisionModeOn || !decisions || decide) return null;
    const count = threadDecisions(decisions, threadId).length;
    return decideEntryShown(count) ? { count, onDecide: () => openDecide(threadId) } : null;
  };
  /** The sitting's queue: its thread's decisions only. */
  const sittingDecisions = useMemo(() => (decisions && decide ? threadDecisions(decisions, decide.thread) : null), [decisions, decide?.thread]);
  const openDecide = (threadId: string) => {
    // Opened from the open-questions list, whose row goes with the list: focus comes back to its button.
    decideOpener.current = document.querySelector<HTMLElement>('section.ib-pane [data-open-questions]');
    const first = decisions ? threadDecisions(decisions, threadId)[0] : undefined;
    setDecide((current) => ({ thread: threadId, title: first ? (first.thread.subject ?? first.thread.thread_name) : null, tucked: false, start: null, startNonce: (current?.startNonce ?? 0) + 1 }));
    void refreshDecisions();
  };
  /** The sitting ended: focus back on what opened it, else on the thread's open-questions button. */
  const closeDecide = () => {
    setDecide(null);
    void refreshList(true);
    const opener = decideOpener.current;
    decideOpener.current = null;
    requestAnimationFrame(() => {
      const target = (opener?.isConnected ? opener : null) ?? document.querySelector<HTMLElement>('section.ib-pane [data-open-questions]');
      target?.focus({ preventScroll: true });
    });
  };
  // Pins (approval "inbox-pinned-threads"): an older Inbox sends no `pins`, so no Pinned section and no pin anywhere.
  const pinsOn = latest?.pins !== undefined;
  const pinRows = latest?.pins;
  const pinnedIds = useMemo(() => new Set((pinRows ?? []).map((pin) => pin.thread_id)), [pinRows]);
  // The open thread's row: the list's, else its own read's (an archived thread is not in the list).
  const listedOpenRow = thread
    ? (latestRows.get(thread.thread_id) ?? (threadRow?.thread_id === thread.thread_id ? threadRow : null))
    : null;
  // Its opening look on its way: read as looked at, as its row on the list is (`listShown`).
  const openThreadRow = listedOpenRow && looking.has(listedOpenRow.thread_id) ? lookedRow(listedOpenRow) : listedOpenRow;
  // "Back from snooze" (snoozeBack.ts): set while rendering, so the thread's first draw has the line and can open at it.
  const openThreadId = thread && thread.thread_id === route.thread ? thread.thread_id : null;
  const [keptBack, setKeptBack] = useState<SnoozeBack | null>(null);
  const snoozeBack = snoozeBackAfter(keptBack, openThreadId, listedOpenRow);
  if (snoozeBack !== keptBack) setKeptBack(snoozeBack);
  // The return under a thread already open (the opening look is on its way otherwise): the look comes once the window
  // is in front and nothing covers the thread (seen on sight's rule), so until then the row keeps its clock.
  const backUnderOpen = openThreadId && listedOpenRow?.snooze_back && !looking.has(openThreadId) && !openThreadCovered ? openThreadId : null;
  useEffect(() => {
    if (!backUnderOpen) return;
    let taken = false;
    const take = () => {
      if (taken || !pageInFront()) return;
      taken = true;
      // Up to what this window has looked at: a message waiting below the view stays unseen (seenOnSight.ts).
      const through = lookRef.current?.threadId === backUnderOpen ? lookRef.current.through : null;
      trackLook(
        backUnderOpen,
        inboxApi
          .seen(backUnderOpen, through)
          .then(() => refreshList(false))
          .catch(() => {
            taken = false;
          }),
      );
    };
    take();
    window.addEventListener('focus', take);
    document.addEventListener('visibilitychange', take);
    return () => {
      window.removeEventListener('focus', take);
      document.removeEventListener('visibilitychange', take);
    };
  }, [backUnderOpen, refreshList, trackLook]);
  /** The list on screen as drawn: the held list, the row whose look is on its way read as looked at. */
  const listShown = useMemo(() => (shown && looking.size > 0 ? markHeldRowLooked(shown, looking) : shown), [shown, looking]);
  // Snoozes: an older Inbox sends no `snoozed`, so no Snooze anywhere. Pins' rule for another machine does not apply:
  // a snooze lives on the thread's home machine and goes there through the forward and the outbox, so a linked
  // machine's row offers it only when that machine keeps snoozes too (`rowSnoozes`).
  const snoozeOn = latest?.snoozed !== undefined;
  // The list reads again at the nearest return, by this window's clock (api.ts runs the rule on what it reads): a
  // linked machine asleep past a thread's time sends no event, and the row still comes back.
  useEffect(() => {
    const delay = inboxSnoozeDelay((latest?.snoozed ?? []).flatMap((row) => (row.snoozed ? [row.snoozed.until] : [])));
    if (delay === null) return;
    const timer = setTimeout(() => void refreshSnoozes(), delay);
    return () => clearTimeout(timer);
  }, [latest?.snoozed, refreshSnoozes]);
  /** The projects where Mark all as read has something to do. */
  const projectsReadable = useMemo(() => projectsWithReadable(latestSections), [latestSections]);
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) counts.set(project.id, waitingCount(latestSections, project.id));
    return counts;
  }, [projects, latestSections]);
  const latestProjectActivity = useMemo(() => projectActivity(latestGroups), [latestGroups]);

  const context: ConnectContext | null = settings
    ? { command: settings.mcp_command, mcpUrl: settings.mcp_url, platform: platformOf() }
    : null;

  const filterProject = route.page === 'inbox' && route.project ? projects.find((p) => p.id === route.project) ?? null : null;
  // The project the sidebar keeps while its list shows (Sidebar's `held`: its page is the Inbox, not a card's thread).
  const sidebarKeeps = (route.page === 'inbox' || route.page === 'tour') && !(route.page === 'inbox' && route.thread && route.card) ? route.project : null;
  // One name per project for the whole window (windowProjectNames): the sidebar, the rows, the pins, the list's
  // title and "N new in …" all read it, so the held list and the live sidebar never name a project two ways.
  // Linked machines: the machine the list shows (the sidebar's Machines filter), and a project of another machine
  // named with that machine ("billing-svc · MacBook") wherever the list shows more than one machine.
  const filterMachine = route.page === 'inbox' && route.machine ? (machines.all.find((m) => m.id === route.machine) ?? null) : null;
  /** Every row the window has (every section, the snoozed too): where an agent's threads are found. */
  const windowRows = useMemo(() => (latest ? [...latest.sections.flatMap((section) => section.threads), ...(latest.snoozed ?? [])] : []), [latest]);
  // The Agents section's filter (`#agent=<id>`): one agent's threads, named by its row's name.
  const filterAgent = useAgentListFilter(route.page === 'inbox' ? (route.agent ?? null) : null, machines, windowRows);
  const projectNames = useMemo(
    () => machineProjectNames({ projects, sidebar: shownProjects(projects, sidebarKeeps), sections: shown ?? [], pins: pinRows }, machines, !filterMachine),
    [projects, sidebarKeeps, shown, pinRows, machines, filterMachine],
  );
  /** The sidebar's Machines counts: rows waiting on the person per machine, as Projects counts them. */
  const sidebarMachineCounts = useMemo(() => machineCounts(latestSections, machines), [latestSections, machines]);
  /** One project's rows, then one machine's, then one agent's, then without the machines the person hid while away. */
  const filterList = useCallback(
    (sections: readonly InboxListSection[]) => filterAgentRows(filterMachineRows(filterSections(sections, route.project), machines, filterMachine?.id ?? null, hideAway), filterAgent, machines.self),
    [route.project, machines, filterMachine, filterAgent, hideAway],
  );
  // The list's filter (listFilter.ts): this browser's picks; on a project's page its Project picks step aside. The
  // day is in the keys so Today and the last N days move on at midnight.
  const [listFilterPicks, setListFilter] = useListFilter();
  const listFilterScoped = route.project !== null;
  const listFilterDay = localDay(Date.now());
  const listFilterApplied = useMemo(() => appliedFilter(listFilterPicks, listFilterScoped), [listFilterPicks, listFilterScoped]);
  /** The list as the person reads it: `filterList`, then the filter. "N new" and the rows read this. */
  const filterShown = useCallback(
    (sections: readonly InboxListSection[]) => filterListSections(filterList(sections), listFilterApplied, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the day: a new one reads the spans again.
    [filterList, listFilterApplied, listFilterDay],
  );
  /** The rows before the filter: its menu's counts and choices. */
  const listFilterRows = useMemo(() => {
    const drawn = listShown ?? shown;
    return drawn ? filterList(drawn).flatMap((section) => section.threads) : [];
  }, [listShown, shown, filterList]);
  /** The list's sections as drawn, kept between renders that change none of it (InboxList's List memo reads them). */
  const listSections = useMemo(() => {
    const drawn = listShown ?? shown;
    return drawn ? filterShown(drawn) : null;
  }, [listShown, shown, filterShown]);
  /** The filter left no row where the list holds some (the Snoozed band aside): "No threads match". */
  const listFilterEmpty =
    pickCount(listFilterApplied) > 0 &&
    listSections !== null &&
    listSections.every((section) => section.id === 'snoozed' || section.threads.length === 0) &&
    listFilterRows.some((row) => !row.snoozed);
  // The list's name: Inbox, or the project's window name (or the machine's, or the agent's); its back buttons read the same.
  const listTitle = filterProject ? (projectNames.get(filterProject.id) ?? filterProject.name) : filterMachine ? filterMachine.name : filterAgent ? filterAgent.name : 'Inbox';
  const heldNews = shown && latest ? heldNotice(filterShown(shown), filterShown(latestGroups), openedHere.current, heldOpen(), projectNames) : null;
  // Show opens the groups the rows it brings in land in (held.ts showLandsIn), so they are on screen.
  // `news`: the same threads, for the pill at the list's edge while the line is out of view (ListNewPill.tsx).
  const notice =
    heldNews?.text && shown
      ? {
          count: heldNews.count,
          project: heldNews.project ?? null,
          lands: showLandsIn(filterShown(shown), filterShown(latestGroups)),
          news: heldNewsOf(filterShown(shown), filterShown(latestGroups), openedHere.current, heldOpen()),
        }
      : null;
  // "Inbox updated to X · Reload": at the list's top, and at the open thread's when no list is beside it.
  const staleNotice = stalePage.inbox && !restarting ? (
    <StalePageNotice version={stalePage.inbox} busy={staleReloading} onReload={() => void reloadOntoUpdate()} onDismiss={stalePage.dismiss} />
  ) : null;
  const firstRun = latest !== null && projects.length === 0;

  // The one-time "Choose how your list looks" dialog (listIntro.ts): after this load's sound and agent-note dialogs are
  // decided, never on a load that showed either or the tour, only with five threads or more and only once the Inbox page (the list, a
  // thread open or not) has been settled for a moment with no file, document, guided review, Artifacts view, search or
  // new message over it (each keeps the claim waiting, unspent); opening another thread, project or machine starts the
  // wait again. It waits while a reply is typed or left open with words or files, or another dialog, an image opened
  // full size or a pinned reference card is over the page (listIntroHeldBack), then claims it from the Inbox (only
  // the first claim ever shows it).
  if (route.page === 'tour') tourThisLoad.current = true;
  if (updateDialog !== null || restarting) updatingThisLoad.current = true;
  if (listIntroLatch.current === null && settings && latest !== null && shown !== null) {
    listIntroLatch.current = {
      owner: !tailnetGuest(settings),
      firstRun,
      rows: filterList(shown).reduce((n, section) => n + section.threads.length, 0),
    };
  }
  const listIntroAtLoad = listIntroLatch.current;
  // What this load arms of the line (reveal.ts `useLineLatch`): the dialog that is next (settings `reveal.next`), the
  // `ahead` offers and the ones beside it, and whether the list options and voice dialogs are due and next, as the
  // newest settings read has them. Held as it is while a one-time dialog of this load is claimed or open (the others
  // are blocked meanwhile, `revealBlocked`; the Inbox's gap starts with the claim, and the line is read again then, so
  // what follows is armed only once the Inbox names it). A load that had the tour or an update keeps its first read. A tab left loaded since before the line was free used
  // to arm nothing for the rest of its life; and since 2026-11-09 the same tab may show the next dialog once the gap
  // has passed (the owner: "after 40 minutes, the same tab (or a fresh load) can show the next one").
  /** The Inbox keeps a line (a release build): its gap, not the page load, paces the dialogs. */
  const lineKept = settings?.reveal?.line === true;
  const lineBusy =
    soundDialog === 'open' || typeof agentNote === 'object' || listIntro === 'claimed' || listIntro === 'open' || (listIntroAsked.current && !listIntroDecided) || lineStagesBusy || lineTipBusy;
  const lineLatch = useLineLatch({
    read:
      settings && latest !== null
        ? { ...revealArmed(settings), listIntroDue: settings.list_intro?.due === true && lineArms('list_intro'), voiceDue: settings.voice?.intro_due === true && lineArms('voice') }
        : null,
    // With no line, a load that showed or claimed a dialog keeps what it held, as before.
    frozen: tourThisLoad.current || updatingThisLoad.current || lineBusy || (!lineKept && (soundDialog !== 'none' || agentNote !== 'none' || listIntro !== 'none' || listIntroAsked.current)),
    againAt: lineKept ? lineAgainAt : null,
    reread: rereadLine,
  });
  // A dialog of this load was just claimed: the line as the Inbox has it now (nothing next, and when to ask again).
  useEffect(() => {
    if (lineBusy) rereadLine();
  }, [lineBusy, rereadLine]);
  const listIntroClear = listIntroPageClear(route, { search: searchOpen, compose: compose !== null });
  // Every one-time dialog's hold: something typed or open over the page, or a question waiting in the open thread.
  const oneTimeHeldBack = () => listIntroHeldBack() || openQuestionHere();
  // Nothing typed or open: the list intro's rule, and no menu open (a row's, a header's, a sheet) and no toast.
  const revealHeldBack = () => oneTimeHeldBack() || document.querySelector('.ib-pm-pos:not(.ib-zx-pos), [data-inbox-toast]') !== null;
  // The idle clock (idleClock.ts): a calm moment for the dialogs whose own moment is "back on the list", which a person
  // who keeps a thread open beside the list never reaches (the owner, 2026-11-08). Counts only while one of them is
  // armed, on the Inbox page, the tab in front and nothing typed or open.
  const sidebarTipSpent = useRef(false);
  const idleArmedNow = settings && latest !== null && !firstRun && route.page === 'inbox' ? revealArmed(settings) : null;
  const pageIdle = useIdleClock({
    // The Sidebar tip (sidebarTip.ts) takes the idle moment too.
    enabled: idleClockArmed(idleArmedNow, settings?.list_intro?.due === true && lineArms('list_intro')) || (idleArmedNow !== null && !phone && !sidebarTipSpent.current && sidebarTipDue(settings)),
    busy: () => revealHeldBack() || !listIntroClear,
  });
  // The list options' moment (approval "inbox-one-time-dialogs"): back on the list, no thread open, or the page idle.
  const listOptionsClear = listIntroClear && (!route.thread || pageIdle);
  // Grouping before Rows (the owner's order, 2026-11-10): the Inbox arms List view beside the Rows dialog (`reveal.ahead`,
  // it never holds the line); while List view's own need holds on this page (Smart groups, the list taller than the
  // screen), Rows waits for it. When it does not hold, Rows goes as before.
  const groupingFirst = lineLatch?.listIntroDue === true && lineLatch.ahead.includes('list_view') && readListView() === 'grouped' && listTallerThanScreen(listBody(rootRef.current));
  const listIntroLoad: ListIntroLoad = {
    due: listIntroAtLoad !== null && lineLatch?.listIntroDue === true && !groupingFirst,
    owner: listIntroAtLoad?.owner ?? false,
    listLoaded: listIntroAtLoad !== null,
    firstRun: listIntroAtLoad?.firstRun ?? false,
    rows: listIntroAtLoad?.rows ?? 0,
    // Read with the page as it is now: the wait's flag clears an effect later, never a render late.
    settled: listIntroSettled && listOptionsClear,
    tourThisLoad: tourThisLoad.current,
    // With a line: on screen now (one that closed no longer holds this load; the gap is the Inbox's). An Inbox that
    // keeps no line (a dev build, an older one) has no gap, so there a load that showed one still shows no other.
    otherDialogThisLoad: lineKept ? soundDialog === 'open' || typeof agentNote === 'object' || lineStagesBusy : soundDialog !== 'none' || agentNote !== 'none',
    othersSettled: soundSettled && agentNoteSettled,
    updating: updateDialog !== null || restarting,
  };
  const listIntroWant = listIntroWanted(listIntroLoad);
  // Watched only while the dialog may still show on this load: each time the Inbox page is clear again, the same wait.
  const listIntroWatch = listIntroWant && (!listIntroDecided || listIntro === 'claimed');
  useEffect(() => {
    setListIntroSettled(false);
    if (!listIntroWatch || !listOptionsClear) return;
    const timer = setTimeout(() => setListIntroSettled(true), LIST_INTRO_SETTLED_MS);
    return () => clearTimeout(timer);
    // Another thread, project or machine opened: the same wait again from there, so it never lands as a page changes.
  }, [listIntroWatch, listOptionsClear, route.thread, route.project, route.machine]);
  const listIntroReady = listIntroMayAsk(listIntroLoad, { modal: false, replying: false });
  useEffect(() => {
    if (!listIntroReady || listIntroAsked.current) return;
    const ask = () => {
      if (listIntroAsked.current || oneTimeHeldBack()) return false;
      listIntroAsked.current = true;
      // Claimed: the Inbox has retired it, so this page shows it, but only once the page is free again (below).
      inboxApi
        .claimListIntro()
        .then((answer) => answer.show && setListIntro('claimed'))
        .catch(() => {})
        .finally(() => setListIntroDecided(true));
      return true;
    };
    if (ask()) return;
    const timer = setInterval(() => {
      if (ask()) clearInterval(timer);
    }, 700);
    return () => clearInterval(timer);
  }, [listIntroReady]);
  // A claim answered after the person opened Settings, the Board, a file, a guided review, the Artifacts view, a
  // search, a new message or an update, began a reply
  // or opened another dialog: it opens when they are back on the Inbox page for a moment with nothing open or typed
  // (never dropped: it is spent).
  const listIntroClaimed = listIntro === 'claimed';
  const listIntroPlaceFree = listIntroLoad.settled && !listIntroLoad.updating;
  useEffect(() => {
    if (!listIntroClaimed || !listIntroPlaceFree) return;
    const open = () => {
      if (oneTimeHeldBack()) return false;
      setListIntro('open');
      return true;
    };
    if (open()) return;
    const timer = setInterval(() => {
      if (open()) clearInterval(timer);
    }, 700);
    return () => clearInterval(timer);
  }, [listIntroClaimed, listIntroPlaceFree]);
  // The one-time voice announcement (voiceIntro.ts): last in the queue, so voice waits a load if another is due.
  const voiceIntro = useVoiceIntro(
    {
      due: lineLatch?.voiceDue === true,
      owner: listIntroLoad.owner,
      listLoaded: listIntroLoad.listLoaded,
      firstRun: listIntroLoad.firstRun,
      listIntroDue: listIntroLoad.due,
      tourThisLoad: listIntroLoad.tourThisLoad,
      otherDialogThisLoad: listIntroLoad.otherDialogThisLoad,
      othersSettled: listIntroLoad.othersSettled,
      updating: listIntroLoad.updating,
      moment: voiceMoment,
    },
    listIntroClear,
    `${route.thread}|${route.project}|${route.machine}`,
    oneTimeHeldBack,
  );
  // The one-time Snooze announcement (snoozeIntro.ts): never at load, never with another one-time dialog, the tour or
  // an update on this load; at a calm moment right after the person leaves a thread that still waits on them.
  // Only `reveal.next` is armed (`lineLatch`); an older Inbox reports no queue: its Snooze rule alone (reveal.ts `revealArmed`).
  const snoozeIntroRows = useMemo(() => latestSections.flatMap((section) => section.threads), [latestSections]);
  oneTimeRows.current = snoozeIntroRows;
  const revealBlocked = snoozeIntroBlockedBy({
    tour: tourThisLoad.current,
    updating: updatingThisLoad.current,
    // With a line, each as it is now: a dialog that closed ('shown') no longer holds the rest of the load (the gap is
    // the Inbox's). With no line (no gap), a load that showed one still shows no other.
    sound: lineKept && soundDialog === 'shown' ? 'none' : soundDialog,
    agentNote: lineKept && agentNote === 'shown' ? 'none' : agentNote,
    listIntroWant: listIntroWant && !(lineKept && listIntro === 'shown'),
    listIntro: lineKept && listIntro === 'shown' ? 'none' : listIntro,
    voiceWanted: voiceIntro.wanted && !(lineKept && voiceIntro.stage === 'shown'),
    voiceStage: lineKept && voiceIntro.stage === 'shown' ? 'none' : voiceIntro.stage,
    // Another dialog of the line is claimed or open now, or one outside its hooks (the Board's welcome, the star
    // ask's card, the Sidebar tip) showed within the gap.
    board: oneTimeDialogShownThisLoad() || lineStagesBusy || lineTipBusy,
  });
  const snoozeIntro = useSnoozeIntro({
    due: lineLatch?.snoozeDue ?? false,
    listLoaded: lineLatch !== null,
    firstRun,
    blocked: revealBlocked,
    snoozedHere: snoozedThisLoad.current,
    rows: snoozeIntroRows,
    toast: toast !== null,
    thread: route.page === 'inbox' ? (route.thread ?? null) : null,
    clear: listIntroClear,
    place: `${route.thread}|${route.project}|${route.machine}`,
    heldBack: revealHeldBack,
  });
  // The Board reveal (reveal.ts): the same calm moment, back on the list; the claim only stamps it, and the Board's own
  // first-visit dialog (BoardIntro) offers it: "Turn it on" turns it on (its sidebar row appears), "Not now" leaves it.
  const boardReveal = useBoardReveal({
    due: lineLatch?.next === 'board',
    listLoaded: lineLatch !== null,
    firstRun,
    blocked: revealBlocked,
    rows: snoozeIntroRows,
    toast: toast !== null,
    thread: route.page === 'inbox' ? (route.thread ?? null) : null,
    clear: listIntroClear,
    place: `${route.thread}|${route.project}|${route.machine}`,
    heldBack: revealHeldBack,
    idle: pageIdle,
    on: settings?.board?.on === true,
    onBoardOn: () => setSettings((current) => (current ? { ...current, board: { on: true } } : current)),
  });
  // The Checklist reveal (approval "inbox-checklist-reveal"): the Board's moment; the claim only stamps it, then
  // ChecklistIntro offers it.
  const stepsReveal = useStepsReveal({
    due: lineLatch?.next === 'steps',
    listLoaded: lineLatch !== null,
    firstRun,
    blocked: revealBlocked,
    rows: snoozeIntroRows,
    toast: toast !== null,
    thread: route.page === 'inbox' ? (route.thread ?? null) : null,
    clear: listIntroClear,
    place: `${route.thread}|${route.project}|${route.machine}`,
    heldBack: revealHeldBack,
    idle: pageIdle,
    on: settings?.steps?.on === true,
    onStepsOn: () => setSettings((current) => (current ? { ...current, steps: { on: true } } : current)),
  });
  // The Bro mode offer (approval "bro-mode"), registered with the line (approval "inbox-one-time-dialogs"; reveal.ts
  // `useLineReveal`): the queue gives it to heavy use only, never on day 0 or 1. Its moment: back on the list from a
  // thread whose last agent message has 150 words or more, after 20 s or more on it (`broRevealLeaveCounts`). The claim
  // only stamps it; BroIntro offers it.
  const broReveal = useLineReveal({
    id: 'bro',
    due: lineLatch?.next === 'bro',
    blocked: revealBlocked,
    rows: snoozeIntroRows,
    toast: toast !== null,
    thread: route.page === 'inbox' ? (route.thread ?? null) : null,
    clear: listIntroClear,
    place: `${route.thread}|${route.project}|${route.machine}`,
    heldBack: revealHeldBack,
    leaveCounts: (visit, now, _row, next) => broRevealLeaveCounts(visit, now, next),
    // Or the page idle on such a thread (a thread kept open beside the list never goes back to it).
    idle: pageIdle,
    idleCounts: broRevealIdleCounts,
    mayClaim: () => true,
    // Turned on meanwhile (Settings, another window): nothing to offer.
    holds: () => settingsRef.current?.bro?.on !== true,
  });
  // The grill-me tip (shared/inbox/grill-me-tip.ts), beside the line (settings `reveal.aside`; reveals.ts `lastResort`:
  // only when the line has nothing else, so it moves no one): the Inbox gives it to someone who answered 3 question
  // cards but never ran grill-me. Its moment, Bro mode's two keyed to answering: back on the list from
  // a thread where the person answered a question block (`grillMeTipLeaveCounts`), or the page idle on one. Nothing to
  // turn on: the claim stamps it and GrillMeTip says it once.
  const grillMeTipReveal = useLineReveal({
    id: 'grill_me_tip',
    due: lineLatch?.aside.includes('grill_me_tip') === true,
    blocked: revealBlocked,
    rows: snoozeIntroRows,
    toast: toast !== null,
    thread: route.page === 'inbox' ? (route.thread ?? null) : null,
    clear: listIntroClear,
    place: `${route.thread}|${route.project}|${route.machine}`,
    heldBack: revealHeldBack,
    leaveCounts: (visit, now, _row, next) => grillMeTipLeaveCounts(visit, now, next),
    idle: pageIdle,
    idleCounts: grillMeTipIdleCounts,
    mayClaim: () => true,
    holds: () => true,
  });
  // The List view's choice, registered with the line (approval "inbox-one-time-dialogs", the change; reveal.ts
  // `useLineReveal`): armed while it is `reveal.next`, or in `reveal.ahead` (it goes at its own moment, ahead of the
  // other offers), back on the list with no thread open or the page idle (any layout), once the list is taller than the
  // screen, on Smart groups.
  const [listView, setListView] = useListView();
  const listViewThread = route.page === 'inbox' ? (route.thread ?? null) : null;
  const listViewReveal = useLineReveal({
    id: 'list_view',
    due: lineLatch?.next === 'list_view' || (lineLatch?.ahead.includes('list_view') ?? false),
    blocked: revealBlocked,
    rows: snoozeIntroRows,
    toast: toast !== null,
    thread: listViewThread,
    // On the list itself, or over a thread while the page is idle (the thread kept open beside the list).
    clear: listViewRevealClear(listIntroClear, listViewThread, pageIdle),
    place: `${route.thread}|${route.project}|${route.machine}`,
    heldBack: revealHeldBack,
    leaveCounts: (_visit, _now, _row, next) => listViewRevealLeaveCounts(next),
    idle: pageIdle,
    mayClaim: (pageAge) =>
      listViewRevealMayClaim(
        {
          listLoaded: lineLatch !== null,
          firstRun,
          grouped: listView === 'grouped',
          taller: listTallerThanScreen(listBody(rootRef.current)),
        },
        pageAge,
      ),
    // Simple list picked meanwhile (the ⋮ menu): nothing to offer.
    holds: () => listView === 'grouped',
  });
  const listViewIntroOpen = listViewReveal.stage === 'open';
  const listViewChoiceOpen = listViewIntroOpen && shown !== null;
  // The choice's two pictures: the person's own list as the groups draw it, and as the Simple list draws it.
  const listViewChoiceGroups: ListIntroGroup[] = listViewChoiceOpen && shown ? filterList(shown).flatMap((section) => (section.id !== 'snoozed' && section.threads.length > 0 ? [{ id: section.id, label: section.label, count: section.threads.length, rows: section.threads.slice(0, 8) }] : [])) : [];
  const listViewChoiceFlat = listViewChoiceOpen && shown ? flatRows(filterList(shown), null, { epoch: 0, keep: null }).rows.slice(0, 10) : [];
  // The tab icon dialog ("Which favicon do you prefer?"; tabIconChoice.ts): an update-day dialog of the line, armed
  // while it is `reveal.next`, 15 s into the page (the owner, 2026-11-10; reveal.ts `soonMayClaim`): no leave and no
  // stillness, only Code review's guards (the page clear, nothing typed or open, no toast, settled).
  const tabIconThread = route.page === 'inbox' ? (route.thread ?? null) : null;
  const tabIconChoice = useTabIconChoice({
    due: lineLatch?.next === 'tab_icon',
    blocked: revealBlocked,
    listLoaded: lineLatch !== null,
    firstRun,
    thread: tabIconThread,
    rows: snoozeIntroRows,
    // Code review's own guard: the Inbox page with nothing over it (a thread open or not), no update on screen.
    clear: listIntroClear && updateDialog === null && !restarting,
    place: `${route.thread}|${route.project}|${route.machine}`,
    heldBack: revealHeldBack,
    toast: toast !== null,
  });
  // The "themes" dialog (approval "inbox-theme-chooser"; themeChooser.ts): right after the tab icon dialog in the line,
  // for someone still on the default theme, armed while it is `reveal.next`, at the same 15 s moment.
  const themeNow = useTheme();
  const pickTheme = useInboxThemePick();
  const themeChooser = useThemeChooser({
    due: lineLatch?.next === 'theme_chooser',
    blocked: revealBlocked,
    listLoaded: lineLatch !== null,
    firstRun,
    thread: tabIconThread,
    rows: snoozeIntroRows,
    // Code review's own guard: the Inbox page with nothing over it (a thread open or not), no update on screen.
    clear: listIntroClear && updateDialog === null && !restarting,
    place: `${route.thread}|${route.project}|${route.machine}`,
    heldBack: revealHeldBack,
    toast: toast !== null,
    light: themeNow.lightTheme,
    dark: themeNow.darkTheme,
  });
  // The "Star the repo" ask (approval "star-ask"): beside the line, never in its order (settings `reveal.aside`), at the
  // same calm moment (a thread read and left, 60 s into the page) while no other reveal is showing or claiming; its
  // claim runs the already-starred check, then the corner card shows.
  const otherRevealActive = [snoozeIntro.stage, boardReveal.stage, stepsReveal.stage, broReveal.stage, grillMeTipReveal.stage, listViewReveal.stage, tabIconChoice.stage, themeChooser.stage].some((stage) => stage === 'open' || stage === 'claimed');
  const starReveal = useStarReveal({
    due: lineLatch?.aside.includes('star') === true,
    listLoaded: lineLatch !== null,
    firstRun,
    blocked: revealBlocked || otherRevealActive,
    rows: snoozeIntroRows,
    toast: toast !== null,
    thread: route.page === 'inbox' ? (route.thread ?? null) : null,
    clear: listIntroClear,
    place: `${route.thread}|${route.project}|${route.machine}`,
    heldBack: revealHeldBack,
  });
  /** A reveal's "Turn it on" (revealTurnOn.ts): Settings' own save; not saved, the switch goes back off and a toast says so. */
  const turnOnFromReveal = (feature: RevealFeature, close: () => void) =>
    void turnOnRevealFeature(feature, close, {
      save:
        feature === 'board'
          ? () => inboxApi.saveBoard(true).then((saved) => saved.board)
          : feature === 'steps'
            ? () => inboxApi.saveSteps(true).then((saved) => saved.steps)
            : feature === 'bro'
              ? () => inboxApi.saveBro(true).then((saved) => saved.bro)
              : () =>
                inboxApi.saveCodeReview(true).then((saved) => {
                  // As Settings' switch: the "/" list gains the review skills.
                  reloadSkillCatalog();
                  return saved.code_review;
                }),
      setSettings,
      showToast,
      dismissToast,
      refreshSettings,
      openSettings: () => {
        window.location.hash = '#settings/capabilities';
      },
    });
  /** Try it: the dialog closes, then the real Snooze menu opens (snoozeIntroTry.ts); it never snoozes anything itself. */
  const trySnoozeIntro = () => {
    const left = snoozeIntro.target;
    snoozeIntro.close();
    setTimeout(() => {
      const now = routeRef.current;
      void openSnoozeMenu({
        root: document.querySelector('.pn-inbox') ?? document,
        phone,
        openThread: now.page === 'inbox' ? (now.thread ?? null) : null,
        left,
        openLeft: (threadId) => go({ page: 'inbox', project: now.project ?? null, machine: now.machine, agent: now.agent, thread: threadId }),
      });
    }, 0);
  };
  /**
   * The picture's two rows: a neighbour (the row above it in the list, or below when it is the top row), then the thread
   * just left, last, where the menu is aimed (the approved picture's order).
   */
  const snoozeIntroPicture = useMemo(() => {
    if (snoozeIntro.stage !== 'open') return [];
    const index = snoozeIntroRows.findIndex((row) => row.thread_id === snoozeIntro.target);
    if (index < 0) return snoozeIntroRows.slice(0, 2);
    const neighbour = snoozeIntroRows[index > 0 ? index - 1 : index + 1];
    return neighbour ? [neighbour, snoozeIntroRows[index]!] : [snoozeIntroRows[index]!];
  }, [snoozeIntro.stage, snoozeIntro.target, snoozeIntroRows]);
  // The notification lines wait for it too, as for the other one-time dialogs, and stand down while it is due here.
  const linesFree =
    askLinesFree &&
    // The list options and voice wait for their own moments (back on the list; a long reply sent): the lines wait for
    // their answer only while that moment is here.
    (!listIntroWant || listIntroDecided || !listOptionsClear) &&
    listIntro !== 'open' &&
    listIntro !== 'claimed' &&
    (!voiceIntro.wanted || voiceIntro.decided || !voiceMoment) &&
    voiceIntro.stage !== 'open' &&
    voiceIntro.stage !== 'claimed' &&
    snoozeIntro.stage !== 'open' &&
    snoozeIntro.stage !== 'claimed' &&
    boardReveal.stage !== 'open' &&
    boardReveal.stage !== 'claimed' &&
    stepsReveal.stage !== 'open' &&
    stepsReveal.stage !== 'claimed' &&
    broReveal.stage !== 'open' &&
    broReveal.stage !== 'claimed' &&
    grillMeTipReveal.stage !== 'open' &&
    grillMeTipReveal.stage !== 'claimed' &&
    starReveal.stage !== 'open' &&
    starReveal.stage !== 'claimed' &&
    listViewReveal.stage !== 'open' &&
    listViewReveal.stage !== 'claimed' &&
    tabIconChoice.stage !== 'open' &&
    tabIconChoice.stage !== 'claimed' &&
    themeChooser.stage !== 'open' &&
    themeChooser.stage !== 'claimed';
  // Settings → Rows' "Your list" (approval "inbox-rows-settings-page"): the person's newest rows, whatever their group.
  const rowsPageOpen = route.page === 'settings' && route.section === 'rows';
  const rowsPagePreview = useMemo(() => {
    if (!rowsPageOpen || !shown) return undefined;
    const rows = shown.flatMap((section) => (section.id === 'snoozed' ? [] : section.threads.map((row) => ({ row, drawn: section.id }))));
    return { rows: rows.sort((a, b) => b.row.last_at.localeCompare(a.row.last_at)).slice(0, 6), projectNames, awayMachines: machines.away };
  }, [rowsPageOpen, shown, projectNames, machines.away]);
  const listIntroGroups: ListIntroGroup[] =
    listIntro === 'open' && shown
      ? filterList(shown).flatMap((section) => (section.id !== 'snoozed' && section.threads.length > 0 ? [{ id: section.id, label: section.label, count: section.threads.length, rows: section.threads.slice(0, 12) }] : []))
      : [];
  // Tidy (2026-10-28): the list header's and the Board's ⋮ menu, each reading who it would ask in its scope.
  // Its plan goes stale with every list read: one that moved the latest list but kept the list drawn (a row held
  // behind "N new") counts, and one that brought nothing new says so itself (`listRead`, refreshList).
  const listReadToken = useMemo(() => ({ shown, latest }), [shown, latest]);
  const listTidy = useTidy(route.page === 'inbox' ? (route.project ?? null) : null, 'list', listReadToken, route.page === 'inbox' && !firstRun);
  listTidyRead.current = listTidy.listRead ?? null;
  const boardTidy = useTidy(boardFilter, 'board', cards, route.page === 'board');
  // The first-run screen shows who is running now ("Message Claude Code") and moves on by itself
  // once an agent is installed or turned on: it reads the agents again when the window comes back
  // into focus (the person ran the install command in a terminal) and every few seconds while shown.
  const { model: firstRunSessions } = useComposeSessions(firstRun);
  // For a tailnet guest the agents route is local only: nothing to read again.
  const guestPage = tailnetGuest(settings);
  // Pull requests (approval "inbox-code-review-direction", items 4 and 5): only with Code review on, read while the
  // page is open, and for the sidebar's count once at start and on focus; never from a tailnet guest's page (it runs
  // this computer's gh / glab).
  const pullsShown = codeReviewOn && !guestPage;
  pagesRef.current = { pulls: pullsShown, drafts: (drafts?.length ?? 0) + replyDrafts.length > 0, composing: compose !== null };
  const onReviews = route.page === 'reviews' || !!route.reviews;
  const pulls = usePulls(onReviews && pullsShown, pullsShown, (route.reviews?.view ?? route.view) === 'others');
  // The Pull requests board's own list (everywhere, mine): read only while Reviews (its right pane, a phone's row), the
  // board's page, a stack's page or a PR opened from it shows.
  const sheetPulls = useSheetPulls((route.page === 'prs' || route.page === 'reviews') && pullsShown);
  // The board in Reviews' pane: Open or Merged, kept while the Inbox is open (Reviews' address has no room for it).
  const [paneView, setPaneView] = useState<SheetView>('open');
  const sheetHead = useMemo(() => (sheetPulls.model ? sheetModel(sheetPulls.model, Date.now(), {}).head : null), [sheetPulls.model]);
  // The list a thread from the box opens beside: the one the box opened over.
  const reviewsScope = () => (route.page === 'reviews' ? { project: route.project, view: route.view ?? pullFilterOf(null) } : (route.reviews ?? { project: null, view: pullFilterOf(null) }));
  const reviewPulls = useMemo(() => reviewBoxPulls(pulls.reviews, new Map((projects ?? []).map((p) => [p.id, p.name]))), [pulls.reviews, projects]);
  // A review arrived, a verdict went: the rows and the sidebar's count follow the store, a moment after it changed.
  const pullsReloadRows = pulls.reloadRows;
  const rowsWaitingSince = useRef<number | null>(null);
  useEffect(() => {
    if (!pullsShown) return;
    // A moment after the store settles, but a steady stream of messages never holds it off for long.
    const since = (rowsWaitingSince.current ??= Date.now());
    const timer = setTimeout(() => {
      rowsWaitingSince.current = null;
      pullsReloadRows();
    }, Math.min(REVIEWS_AFTER_STORE_MS, Math.max(0, since + REVIEWS_AFTER_STORE_MAX_MS - Date.now())));
    return () => clearTimeout(timer);
  }, [shown, thread?.messages.length, pullsShown, pullsReloadRows]);
  // System in Reviews and in Settings (approval "system-inbox"): only while it shows (System on, Code review on).
  const systemOnHere = systemShown(settings) && !guestPage;
  const systemProjects = useSystemProjects(systemOnHere && (route.page === 'reviews' || (route.page === 'settings' && route.section === 'capabilities')));
  // A drawing's address while System does not show (turned off, Code review off, a guest's page): dropped in place,
  // so Reviews is today's. Not before the settings are read: System may be on.
  useEffect(() => {
    if (settings === null) return;
    const clean = systemDropped(route, systemOnHere);
    if (clean) writeRoute(clean, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings === null, systemOnHere, route.page, route.system, route.sheet, route.full]);
  // A #reviews link on a guest's page (it could not turn Code review on): the Inbox, as if the page were not there.
  useEffect(() => {
    // In place: Back from the Inbox must not land on #reviews and be sent back again.
    if (onReviews && guestPage) writeRoute({ page: 'inbox', project: null, thread: null }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReviews, guestPage]);
  // Pull requests lives under Code review: off (or a guest's page), `#prs` goes where `#reviews` does, in place.
  useEffect(() => {
    if (route.page !== 'prs' || settings === null) return;
    if (guestPage) writeRoute({ page: 'inbox', project: null, thread: null }, { replace: true });
    else if (!codeReviewOn) writeRoute({ page: 'reviews', project: null, thread: null }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.page, settings === null, guestPage, codeReviewOn]);
  // Code review turned off (from another window, say): nothing starts a review from here, and the box says why it went.
  // Its words stay in memory for when it's back.
  const reviewBoxOpen = !!compose?.review;
  useEffect(() => {
    if (settings === null || pullsShown) return;
    if (reviewBoxOpen) {
      closeCompose();
      showToast({ icon: 'warn', lead: 'Code review is off', detail: 'no review was started', wrap: true });
    }
    if (route.page === 'reviews' && route.new) writeRoute({ ...route, new: false }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings === null, pullsShown, reviewBoxOpen, route.page, route.new]);
  // `#reviews&new`: the box opens once, over the page, and the address goes back to the page (Back and a reload do not reopen it).
  useEffect(() => {
    if (route.page !== 'reviews' || !route.new || !pullsShown) return;
    writeRoute({ ...route, new: false }, { replace: true });
    openCompose({ review: {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.page, route.new, pullsShown]);
  useEffect(() => {
    if (!firstRun || guestPage) return;
    let last = Date.now();
    const again = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < FIRST_RUN_AGENTS_MIN_GAP_MS) return;
      last = Date.now();
      void refreshAgents();
    };
    const timer = setInterval(again, FIRST_RUN_AGENTS_REFRESH_MS);
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [firstRun, guestPage, refreshAgents]);
  // ── The onboarding tour (approval "inbox-onboarding-tour") ──────────────
  // A replay of a real thread from building Plannotator, drawn with the
  // window's own list, thread and question card over the tour's fixture
  // (tour/model.ts). Steps 1 to 9 never touch the person's store; step 10,
  // "Make it yours", sets their theme and text size; step 11 is their own
  // first-run screen. The person's Inbox stays loaded underneath
  // and comes back as it was.
  const tourOn = route.page === 'tour';
  // Ask AI, on in every Inbox but the tour's and a tailnet guest's (off, this reads nothing and draws nothing), and
  // only once the settings say which this page is. A linked machine's thread has no chat here.
  const [askReply, setAskReply] = useState<{ threadId: string; words: string } | null>(null);
  // A board's Add to reply: its words and picture, on their way to the reply of the thread the board hangs off.
  const [shapeReply, setShapeReply] = useState<(ShapeReplyPart & { threadId: string }) | null>(null);
  // The thread the open board hangs off (read when its Add to reply is pressed: one callback, so the board keeps its options).
  const shapeReplyThread = useRef<string | null>(null);
  shapeReplyThread.current = route.page === 'inbox' && thread && thread.thread_id === route.thread ? thread.thread_id : null;
  const addShapeReply = useCallback((selection: ShapeBoxSelection, text: string) => {
    const threadId = shapeReplyThread.current;
    if (threadId) void shapeReplyPart(selection, text).then((part) => setShapeReply({ ...part, threadId }));
  }, []);
  const ask = useInboxAsk({
    on: inboxAskOn(settings, tourOn),
    codeReview: settings?.code_review?.on === true,
    threadId: route.thread && !machineOf(route.thread) ? route.thread : null,
    phone,
    openThread: (threadId) => writeRoute({ page: 'inbox', project: null, thread: threadId }),
    replyInThread: (threadId, words) => setAskReply({ threadId, words }),
  });
  // Floating reply drafts in the corner, beside this thread's Ask chat (approval "inbox-reply-floaters").
  const floaters = useReplyFloaters({
    rows: replyDrafts,
    rowsRead: drafts !== null,
    threadId: route.page === 'inbox' ? route.thread : null,
    phone,
    off: tourOn || settings?.guest === true,
    // Off by default (the owner, 2026-11-08): Settings → Capabilities → Experimental → "Float reply drafts".
    floatDrafts: settings ? settings.float_drafts?.on === true : null,
    ask: ask.corner,
    openThread: (threadId) => writeRoute({ page: 'inbox', project: null, thread: threadId }),
    openDrafts: () => writeRoute({ page: 'drafts', project: null, thread: null }),
    refreshDrafts,
    toast: (next) => showToast(next),
    dismissToast,
  });
  const reducedMotion = useReducedMotion();
  const [tourState, dispatchTourRaw] = useReducer(tourReducer, TOUR_START);
  const tourContent = useTourFixture(tourOn);
  const tourFixture = tourContent.fixture;
  /**
   * The tour's content cannot be had on this load (the fixture did not come, three tries): the tour is never
   * shown, and never an error (the owner: the tour is all positive). The entry screen and the first-run screen's
   * tour line stand down, so the first-run screen shows; Settings → Getting started keeps the tour for later.
   */
  const [tourUnavailable, setTourUnavailable] = useState(false);
  /**
   * The tour's first card (the owner, for 0.28.31: "a fresh reminder"): how the Inbox fits with your agents,
   * then Show me. Shown when the tour is started from a screen, over step 1; never on a reload or a link to a step.
   */
  const [tourIntro, setTourIntro] = useState(false);
  const tourReal = tourFixture?.threads.find((t) => t.id === TOUR_THREAD)?.real_answer ?? '';
  /** Raised when the person acted and the coach card changed: focus goes to its title. */
  const [coachFocus, setCoachFocus] = useState(0);
  const dispatchTour = useCallback((action: TourAction, options?: { focusCoach?: boolean }) => {
    dispatchTourRaw(action);
    if (options?.focusCoach) setCoachFocus((n) => n + 1);
  }, []);
  useTourReplay(tourState, dispatchTour, reducedMotion, say);
  const saveTour = (change: Parameters<typeof inboxApi.saveTour>[0]) => {
    // Kept here at once, so the entry screen leaves without waiting; the server's answer replaces it.
    const now = new Date().toISOString();
    setSettings((current) =>
      current?.tour
        ? {
            ...current,
            tour: {
              ...current.tour,
              seen_at: change.seen ? now : current.tour.seen_at,
              finished_at: change.finished ? now : current.tour.finished_at,
              skipped_at: change.skipped ? now : current.tour.skipped_at,
              notify_again: change.notify_again ?? current.tour.notify_again,
            },
          }
        : current,
    );
    // The server's answer replaces the local state, a stamp never going back to null: an earlier save's answer
    // that lands after a later one (seen, then skipped) never brings Two paths back.
    const adopt = (tour: InboxTourState) =>
      setSettings((current) => {
        if (!current) return current;
        const local = current.tour;
        return {
          ...current,
          tour: local
            ? { ...tour, seen_at: tour.seen_at ?? local.seen_at, finished_at: tour.finished_at ?? local.finished_at, skipped_at: tour.skipped_at ?? local.skipped_at }
            : tour,
        };
      });
    const decision = change.finished ? 'finished' : change.skipped ? 'skipped' : null;
    // A failed save is tried again (the server restarting, a busy moment); one the server refuses for good
    // (a 4xx) is not. A decision that still did not reach config.json is remembered in this browser and said,
    // quietly: the tour never pretends it was saved, and Two paths does not come back here.
    const attempt = (tries: number) => {
      void inboxApi.saveTour(change).then(
        ({ tour }) => adopt(tour),
        (cause: unknown) => {
          const status = cause instanceof InboxApiError ? cause.status : 0;
          if (tries < TOUR_SAVE_RETRY_MS.length && !(status >= 400 && status < 500)) {
            setTimeout(() => attempt(tries + 1), TOUR_SAVE_RETRY_MS[tries]);
            return;
          }
          if (!decision) return;
          storage.setItem(TOUR_DECIDED_COOKIE, decision);
          const why = cause instanceof Error ? cause.message : String(cause);
          showToast(
            {
              icon: 'warn',
              lead: 'Not saved',
              detail: 'This browser remembers the tour',
              speech: `The tour could not be saved: ${why} This browser remembers that you ${decision === 'finished' ? 'finished' : 'left'} it, so it will not offer itself again here.`,
            },
            6000,
          );
        },
      );
    };
    attempt(0);
  };
  // The step rides the address (`#tour=N`): a reload or a link opens that step with the walk's state up to it,
  // and each step the person reaches replaces the entry, so one Back leaves the tour.
  const tourSynced = useRef<number | null>(null);
  useEffect(() => {
    if (!tourOn || !tourFixture) return;
    const want = route.step ?? 1;
    if (want !== tourSynced.current) {
      tourSynced.current = want;
      if (want !== tourState.step) dispatchTourRaw({ type: 'goto', step: want, realAnswer: tourReal, fixture: tourFixture });
      return;
    }
    if (tourState.step !== want) {
      tourSynced.current = tourState.step;
      writeRoute({ page: 'tour', project: null, thread: null, step: tourState.step }, { replace: true });
    }
  }, [tourOn, tourFixture, route.step, tourState.step, tourReal]);
  /** The tour is ending through its own controls (Exit, Finish, the chip), not the browser's Back. */
  const tourEnding = useRef(false);
  /** The screen the tour was started from: Exit and Finish go back to it (the browser's Back when it is the entry under this one). */
  const tourReturn = useRef('');
  /** The tour was started from a screen of this page (Start, Take the tour); not set for a link or a reload. */
  const tourStartedHere = useRef(false);
  const tourWasOn = useRef(false);
  useEffect(() => {
    if (tourOn) {
      tourWasOn.current = true;
      // Reached by a link or a reload, not from a screen: no start point to go back to (never an earlier tour's).
      if (!tourStartedHere.current) tourReturn.current = '';
      // A toast from the Inbox underneath (its Undo writes there) never stays over the tour.
      dismissToast();
      return;
    }
    if (!tourWasOn.current) return;
    tourWasOn.current = false;
    // The tour ended: its start point is forgotten with it.
    tourReturn.current = '';
    tourStartedHere.current = false;
    // Left by the browser's Back (or anything else not through endTour): the same as Exit there, finished from
    // step 10, "Make it yours", once the replay is over (the entry screen does not come back).
    if (!tourEnding.current) {
      saveTour(tourEndRecord(tourState.step >= TOUR_SETTINGS_STEP));
      // The browser's Back took the tour's screen with the focus in it: focus lands on the Inbox, never the page.
      landFocusAfterTour();
    }
    tourEnding.current = false;
    tourSynced.current = null;
    setTourIntro(false);
    dispatchTourRaw({ type: 'goto', step: 1, realAnswer: tourReal });
    setTourArrivals({ count: 0, thread: null });
    // Notifications resume: the list the tour hid is read again, and what it brings is known, not news.
    void refreshList(false).then((next) => next && flushNotifications(next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourOn]);
  const startTour = () => {
    // A toast's Undo (and Z) belongs to the Inbox under the tour: it never acts while the tour is up.
    dismissToast();
    tourReturn.current = routeRef.current.page === 'tour' ? '' : hashOf(routeRef.current);
    tourStartedHere.current = true;
    dispatchTourRaw({ type: 'goto', step: 1, realAnswer: tourReal });
    tourSynced.current = 1;
    setTourArrivals({ count: 0, thread: null });
    setCoachFocus((n) => n + 1);
    setTourIntro(true);
    saveTour({ seen: true });
    go({ page: 'tour', project: null, thread: null, step: 1 });
  };
  /** What ending the tour records: finished once the person reached step 10 ("Make it yours", after the replay), skipped before. */
  const tourEndRecord = (finished: boolean): InboxTourChange =>
    finished
      ? { finished: true, notify_again: !(notifications.permission === 'granted' && settings?.notifications.enabled === true) }
      : { skipped: true };
  /**
   * Ends the tour: `kind` is what it records, `to` where it goes. A place named (the chip's thread, Settings, a
   * sidebar row on step 11) takes the tour's own entry. Without one it goes back to where the tour was started, as
   * the browser's Back when that is the entry under the tour's own; else (a link or a reload) to that place, again
   * in the tour's entry. Either way a later Back never reopens #tour=N.
   */
  const endTour = (kind: 'exit' | 'finish', to?: Route) => {
    tourEnding.current = true;
    saveTour(tourEndRecord(kind === 'finish' || tourState.step >= TOUR_SETTINGS_STEP));
    if (to) writeRoute(to, { replace: true });
    else {
      const back = tourReturn.current;
      const state = window.history.state as { ibFrom?: unknown } | null;
      // Going back leaves the tour's entry ahead in history: marked, so Forward (or a reload of it) settles it
      // to where the tour went back to instead of reopening the tour (settleTourEntry).
      if (state && state.ibFrom === back) window.history.replaceState({ ...state, [TOUR_ENDED_STATE]: back }, '', window.location.href);
      if (!backTo(back)) writeRoute(routeOf(back), { replace: true });
    }
    showToast(
      kind === 'finish'
        ? { icon: 'check', lead: 'Tour finished', detail: 'Your Inbox is as you left it', speech: 'Tour finished. Your Inbox is as you left it.' }
        : { icon: 'check', lead: 'You left the tour', detail: 'Your Inbox is as it was', speech: 'You left the tour. Your Inbox is back as it was.' },
      4200,
    );
    landFocusAfterTour();
  };
  /**
   * Focus never drops to the page once the Inbox is back. The browser's Back lands, and the screen redraws, some
   * frames later on a slow machine; until the tour's own screen is gone the control that was pressed still holds
   * focus and is about to go, so nothing counts as landed before then. Tried for up to 3 s.
   */
  function landFocusAfterTour() {
    const until = performance.now() + 3000;
    let settled = 0;
    const land = () => {
      if (performance.now() > until) return;
      if (document.querySelector('[data-tour-bar]')) {
        requestAnimationFrame(land);
        return;
      }
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) {
        // Back where it was started: its own Take the tour (Settings, What's new); else the thread, the first-run heading, the list.
        focusFirst(['[data-settings-take-tour]', '[data-whats-new-tour] button', 'section.ib-pane h2.ib-subject', '.ib-main .ib-empty h2', '.ib-main .ib-lbody [data-thread-id]', '.ib-main h1']);
      }
      const now = document.activeElement;
      // Landed: focus held over a few frames (a screen that is still drawing can take the element away again).
      settled = now && now !== document.body && now.isConnected ? settled + 1 : 0;
      if (settled < 5) requestAnimationFrame(land);
    };
    requestAnimationFrame(land);
  }
  // During the tour, focus that a control took with it (a screen redrawn by a step, a hash change, Try again)
  // lands on the tour's own place: the coach card, the loading screen, step 11's heading, else Exit. Only focus
  // that was LOST (the last focused element left the page): a click on empty space is left alone.
  useEffect(() => {
    if (!tourOn) return;
    let last: Element | null = document.activeElement;
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Element) last = event.target;
    };
    const check = () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      if (last && last.isConnected && last !== document.body) return;
      focusFirst(['[data-tour-viewer] [data-tour-viewer-close]', '[data-tour-intro] h2', '[data-tour-coach] h2', '[data-tour-loading] h2', '[data-tour-file-problem] h2', '.ib-main .ib-empty h2', '[data-tour-exit]']);
      last = document.activeElement;
    };
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('hashchange', check);
    const timer = setInterval(check, 250);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('hashchange', check);
      clearInterval(timer);
    };
  }, [tourOn]);
  /** What did not load in the tour (pictures, the mock): the coach says only what is on screen. */
  const [tourDegraded, setTourDegraded] = useState<TourDegraded>({});
  /** What is on screen in the tour that its state does not hold (a comment box open, a drawing, a moment pinned): the coach follows it. */
  const [tourUi, setTourUi] = useState<TourUi>({});
  const degradeTour = useCallback((change: TourDegraded) => setTourDegraded((current) => ({ ...current, ...change })), []);
  const tourIntroShown = tourOn && !!tourFixture && tourIntro && tourState.step === 1;
  useEffect(() => {
    if (tourOn && tourState.step !== 1) setTourIntro(false);
  }, [tourOn, tourState.step]);
  useEffect(() => {
    if (!tourIntroShown) return;
    say(`${TOUR_FIT_TITLE}. ${TOUR_FIT_LINES.join(' ')}`);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-tour-intro] h2')?.focus({ preventScroll: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourIntroShown]);
  /** Step 8's compose, opened from the tour's sidebar or list header: the real dialog over the tour's transport. */
  const tourComposeOpener = useRef<HTMLElement | null>(null);
  const openTourCompose = useCallback((opener: HTMLElement) => {
    tourComposeOpener.current = opener;
    dispatchTourRaw({ type: 'compose', open: true });
  }, []);
  const tourTransport = useMemo(() => (tourFixture ? tourComposeTransport(tourFixture, () => {}) : null), [tourFixture]);
  /**
   * The tour's answer to a click it cannot use (the owner, 2026-10-25: a card or button is never dead): one short
   * line on the coach card for a few seconds, said in the live region.
   */
  const [tourNudge, setTourNudge] = useState<string | null>(null);
  const tourNudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudgeTour = useCallback(
    (text: string) => {
      setTourNudge(text);
      say(text);
      if (tourNudgeTimer.current) clearTimeout(tourNudgeTimer.current);
      tourNudgeTimer.current = setTimeout(() => setTourNudge(null), 4500);
    },
    [say],
  );
  useEffect(() => () => void (tourNudgeTimer.current && clearTimeout(tourNudgeTimer.current)), []);
  /** A Fast-forward just happened: the next card's announcement starts with it. */
  const tourForwarded = useRef(false);
  /** Fast-forward (the owner, 2026-10-25): the end of this step, said once. */
  const forwardTour = useCallback(() => {
    if (!tourFixture) return;
    setTourNudge(null);
    // Said with the card it lands on (the next announcement), never apart from it, which the card would cut off.
    tourForwarded.current = true;
    dispatchTour({ type: 'forward', realAnswer: tourReal, fixture: tourFixture }, { focusCoach: true });
  }, [tourFixture, tourReal, dispatchTour]);
  /** New message in the tour's sidebar: live on step 9 until its Send; before it the coach says when, after it where the thread is. */
  const openTourComposeOrNudge = useCallback(
    (opener: HTMLElement) => {
      if (tourState.step === TOUR_COMPOSE_STEP && tourState.compose === 'sent') nudgeTour('Your thread is started; it’s in the list.');
      else if (tourState.step === TOUR_COMPOSE_STEP) openTourCompose(opener);
      else nudgeTour('New message comes later in the tour, at step 9.');
    },
    [tourState.step, tourState.compose, openTourCompose, nudgeTour],
  );
  const tourCoachCard =
    tourOn && tourFixture && tourState.step < TOUR_STEPS && !tourIntroShown
      ? tourCoach(tourState, { developer: tourFixture.developer, agent: 'Claude Code' }, tourDegraded, tourUi)
      : null;
  const tourCoachKey = tourCoachCard ? `${tourState.step}:${tourCoachCard.key}:${tourCoachCard.title}` : null;
  const lastTourCoach = useRef<string | null>(null);
  useEffect(() => {
    if (tourCoachKey === lastTourCoach.current) return;
    lastTourCoach.current = tourCoachKey;
    // A new card: the last one's answer to a click goes with it.
    setTourNudge(null);
    if (!tourCoachCard) return;
    // Each change is said once. The replay's own lines say Sending and Delivered; the second arrival leads the next card.
    const forwarded = tourForwarded.current ? 'Fast-forwarded. ' : '';
    tourForwarded.current = false;
    if (!tourCoachCard.wait) say(`${forwarded}${tourCoachSpeech(tourCoachCard, tourState.step)}`);
    else if (forwarded) say(forwarded.trim());
    // Focus never drops to the page: a card that changed under a control that went away takes it.
    requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body || !active.isConnected) setCoachFocus((n) => n + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourCoachKey]);
  // The last step (11) is real: Back in the tour bar has no step to go to, and Finish ends it.
  const tourRealStep = tourOn && tourState.step === TOUR_STEPS;
  /** A sidebar row: on step 11 (the real sidebar shows there) it ends the tour, finished, in the tour's own entry. */
  const leave = (to: Route) => (tourRealStep ? endTour('finish', to) : go(to));
  /** The last step’s notifications line: asked on the click only; hidden for the step by Not now (the first real thread asks once more). */
  const [tourAskHidden, setTourAskHidden] = useState(false);
  // The last step is the person’s own screen: its heading takes focus (the coach card is gone) and the change is said.
  const wasRealStep = useRef(false);
  useEffect(() => {
    if (tourRealStep && !wasRealStep.current) {
      // The tour's own toast (Sent to Claude Code) belongs to the replay: the person's own screen starts clean.
      dismissToast();
      say(`Step ${TOUR_STEPS} of ${TOUR_STEPS}: connect your agents. This is your own Inbox; what you connect here stays connected.`);
      requestAnimationFrame(() => requestAnimationFrame(() => focusFirst(['.ib-main .ib-empty h2'])));
    }
    if (!tourRealStep) setTourAskHidden(false);
    wasRealStep.current = tourRealStep;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourRealStep]);
  // The first real thread offers notifications once more, inline, when the tour ended without them (choice 6).
  // Like the ask above the list (askKind): never when notifications are off or the ask was dismissed.
  const notifyAgain = !tourOn && settings?.tour?.notify_again === true && notifications.ask !== null;
  const [notifyAgainThread, setNotifyAgainThread] = useState<string | null>(null);
  useEffect(() => {
    if (!notifyAgain) return;
    if (route.thread && notifyAgainThread === null) setNotifyAgainThread(route.thread);
    // Shown once: leaving the thread it showed in ends it.
    else if (notifyAgainThread !== null && route.thread !== notifyAgainThread) {
      setNotifyAgainThread(null);
      saveTour({ notify_again: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifyAgain, route.thread, notifyAgainThread]);
  // The first-run screen opens on the entry screen until the tour was started, finished or left (Two paths).
  const tourDecided =
    !!settings?.tour && (settings.tour.finished_at !== null || settings.tour.skipped_at !== null || storage.getItem(TOUR_DECIDED_COOKIE) !== null);
  // The first-run screen drew without the settings (their read failed or was late): it stays, and once the
  // settings come it gains its quiet "Take the tour" line rather than turning into the entry screen under the person.
  const firstRunDrawnBare = useRef(false);
  const showTourEntry = firstRun && !!settings?.tour && !tourDecided && !firstRunDrawnBare.current && !tourUnavailable;
  // The entry screen loads the tour while it shows, so Start is at once; content that cannot be had takes the
  // entry screen away before anyone presses Start (the first-run screen shows instead).
  useEffect(() => {
    if (!showTourEntry) return;
    let gone = false;
    void loadTour().then((fixture) => !gone && fixture === null && setTourUnavailable(true));
    return () => {
      gone = true;
    };
  }, [showTourEntry]);
  // Code review's one-time offer (approval "code-review-offer-card"; codeReviewOffer.ts): the line's day-0 slot, armed
  // from `reveal.next`, at once once the tour's screens are gone and the page is clear; the agent note waits for it.
  const codeReviewOffer = useCodeReviewOffer({
    due: lineLatch?.next === 'code_review',
    blocked: updatingThisLoad.current || (lineKept ? soundDialog === 'open' || typeof agentNote === 'object' : soundDialog !== 'none' || agentNote !== 'none') || oneTimeDialogShownThisLoad(),
    tourScreen: showTourEntry || tourIntroShown || tourOn,
    thread: route.page === 'inbox' ? (route.thread ?? null) : null,
    rows: snoozeIntroRows,
    clear: listIntroClear && updateDialog === null && !restarting,
    place: `${route.thread}|${route.project}|${route.machine}`,
    heldBack: revealHeldBack,
    toast: toast !== null,
    on: settings?.code_review?.on === true,
  });
  const offerLinesFree = linesFree && codeReviewOffer.stage !== 'open' && codeReviewOffer.stage !== 'claimed';
  // One of the line's dialogs is claimed or open now: the load arms nothing else meanwhile (`lineLatch`).
  const stagesBusy = [voiceIntro.stage, snoozeIntro.stage, boardReveal.stage, stepsReveal.stage, broReveal.stage, grillMeTipReveal.stage, listViewReveal.stage, tabIconChoice.stage, themeChooser.stage, starReveal.stage, codeReviewOffer.stage].some(
    (stage) => stage === 'claimed' || stage === 'open',
  );
  useEffect(() => setLineStagesBusy(stagesBusy), [stagesBusy]);
  // The agent-note dialog's moment (approval "inbox-one-time-dialogs": day 0 is setup, one after another): once the
  // tour's screens are gone (the entry screen, its intro, the tour itself), and only when the Inbox's line says this
  // load may (`reveal.setup`: never within the gap of another dialog). Then the
  // claim (`POST /api/inbox/reveal` `agent_note`) stamps the day, so two tabs never both show it; an older Inbox
  // without the line answers with an error, and the dialog shows as before.
  const agentNoteReady =
    agentsSettled &&
    latest !== null &&
    soundSettled &&
    soundDialog === 'none' &&
    updateDialog === null &&
    !restarting &&
    route.page !== 'settings' &&
    route.page !== 'tour' &&
    !showTourEntry &&
    !tourIntroShown &&
    // Code review's day-0 offer goes first (its claim then keeps the day, so the note waits for the next free one).
    codeReviewOffer.settled;
  useEffect(() => {
    if (!agentNoteReady || agentNoteDecided.current) return;
    let cancelled = false;
    const decide = () => {
      if (cancelled || agentNoteDecided.current || replyInProgress() || openQuestionHere()) return false;
      agentNoteDecided.current = true;
      const model = tailnetGuest(settings) ? null : agentsRef.current;
      const rows = model ? noteQuestionRows(model) : [];
      // Not on this load (the line's gap): decided, so the notification lines need not wait for it.
      if (rows.length === 0 || !model || settingsRef.current?.reveal?.setup === false) {
        setAgentNoteSettled(true);
        return true;
      }
      void inboxApi
        .claimReveal(
          'agent_note',
          undefined,
          rows.map((row) => row.id),
        )
        .then(
          (answer) => answer.show,
          (cause) => !(cause instanceof InboxApiError) || cause.status === 404 || cause.status === 422,
        )
        .then((show) => {
          if (show) setAgentNote({ rows });
          setAgentNoteSettled(true);
        });
      return true;
    };
    if (decide()) return;
    const timer = setInterval(() => {
      if (decide()) clearInterval(timer);
    }, 700);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agentNoteReady]);
  // The connect line (approval "inbox-agent-note-auto"; ConnectLine): once the agents are read (the run that
  // opened the window has finished connecting and writing notes), the news not said yet shows above the list and
  // on the first-run screen, quiet, never a dialog. Fixed for this load when it shows, and said at once
  // (`POST /api/inbox/agents/seen`). On this computer and on its owner's other devices; never a tailnet guest's page.
  useEffect(() => {
    if (connectLine !== null || !agentsSettled || !agents || !settings || tailnetGuest(settings)) return;
    const news = connectLineNews(agents);
    if (!news) return;
    setConnectLine(news);
    void inboxApi.agentsSeen(news.report?.at ?? null, news.notes).then(setAgents, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, agentsSettled, settings?.via, settings?.guest, connectLine]);
  const connectLineEl =
    connectLine && connectLine !== 'gone' ? (
      <ConnectLine
        report={connectLine.report}
        notes={connectLine.notes}
        onDismiss={() => setConnectLine('gone')}
        onSettings={() => {
          setConnectLine('gone');
          go({ page: 'settings', project: null, thread: null, section: 'agents' });
        }}
      />
    ) : null;
  // Started, and the content cannot be had: the tour leaves without a word, back where it was started (the
  // first-run screen, Settings), recording nothing.
  useEffect(() => {
    if (!tourOn || !tourContent.unavailable) return;
    setTourUnavailable(true);
    tourEnding.current = true;
    writeRoute(routeOf(tourReturn.current), { replace: true });
    landFocusAfterTour();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourOn, tourContent.unavailable]);
  // While there are no settings, they are read again (1 s, then doubling to 15 s): one failed or hung read
  // never leaves the window without them. A read late by 1.5 s draws the first-run screen anyway.
  const settingsMissing = settings === null && latest !== null;
  useEffect(() => {
    if (!settingsMissing) return;
    let gone = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout>;
    const late = setTimeout(() => !gone && setSettingsLate(true), SETTINGS_LATE_MS);
    const again = () => {
      timer = setTimeout(async () => {
        if (gone) return;
        await refreshSettings();
        delay = Math.min(delay * 2, 15000);
        if (!gone) again();
      }, delay);
    };
    again();
    return () => {
      gone = true;
      clearTimeout(timer);
      clearTimeout(late);
    };
  }, [settingsMissing, refreshSettings]);

  // A file beside the thread takes the list's and the sidebar's room (record 2.2).
  const fileOpen = route.page === 'inbox' && !!route.thread && !!route.file;
  // A thread opened from a Board card (`#thread=…&card=crd_…`): it takes the list's place, led by
  // "‹ Board" and a chip naming the card; both go back to the opened card.
  const fromCard = route.page === 'inbox' && route.thread && route.card ? route.card : null;
  // The thread in full screen: only on a desktop thread beside the list (not a phone, a stacked window or a card's).
  const full = threadFull && route.page === 'inbox' && !!route.thread && !phone && !fromCard && !stack.thread;
  // The Sidebar tip (sidebarTip.ts): once, beside the docked sidebar, at the reveals' calm moment. A desktop only.
  // Outside the line, and behind it: never on a load where the star ask is armed or another reveal showed, is
  // claiming or is open (it lets one that shares its moment go first, and stands down unclaimed).
  const sidebarDocked = !phone && route.page === 'inbox' && sidebarOpen && !fileOpen && !sidebarHeld && !full;
  const sidebarCustomizing = useSidebarCustomizerOpen();
  const sidebarTip = useSidebarTip({
    due: !phone && !tourOn && sidebarTipDue(settings) && lineLatch !== null && !lineLatch.aside.includes('star'),
    blocked: revealBlocked || otherRevealActive || starReveal.stage === 'open' || starReveal.stage === 'claimed' || sidebarCustomizing,
    sidebar: sidebarDocked,
    listLoaded: lineLatch !== null,
    firstRun,
    thread: route.page === 'inbox' ? (route.thread ?? null) : null,
    rows: snoozeIntroRows,
    clear: listIntroClear,
    place: `${route.thread}|${route.project}|${route.machine}`,
    heldBack: revealHeldBack,
    toast: toast !== null,
    idle: pageIdle,
  });
  if (sidebarTip.stage !== 'none') sidebarTipSpent.current = true;
  // The tip claimed or up: the load arms nothing else meanwhile and reads the line again (`lineBusy`), as a dialog's claim does.
  const sidebarTipBusy = sidebarTip.stage === 'claimed' || sidebarTip.stage === 'open';
  useEffect(() => setLineTipBusy(sidebarTipBusy), [sidebarTipBusy]);
  threadFullRef.current = full;
  // The list coming back beside the thread (‹ Inbox beside a file, leaving full screen) in a window with room for the
  // list and the thread but not for the sidebar too: the sidebar stays closed on screen (`sidebarHeld`), so the thread
  // does not stack over the list it was asked to show.
  const holdSidebarIfTight = () => {
    const root = rootRef.current;
    if (!root || !sidebarOpen) return;
    const width = root.getBoundingClientRect().width;
    const sidebar = root.querySelector('.ib-sb-inner')?.getBoundingClientRect().width ?? 0;
    const room = LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH + paneGutters();
    if (width >= room && width - sidebar < room) setSidebarHeld(true);
  };
  // Every way out of full screen (‹ Inbox, Escape, ⌘B): the sidebar and the list come back as the window has room.
  const leaveFull = () => {
    holdSidebarIfTight();
    setThreadFull(false);
  };
  leaveFullRef.current = leaveFull;
  const backToCard = () =>
    close({ page: 'board', project: route.boardProject ?? null, initiative: route.boardInitiative ?? null, thread: null, board: route.board ?? 'lanes', card: fromCard });
  // ⌘K's "Shape" group: the boards whose title or project the words find, newest change first.
  const searchShapes = useCallback(
    (q: string): SearchShape[] =>
      filterShapeItems(
        (shapeOn ? (shapes.shapes ?? []) : []).filter((s) => s.state === 'active').map((s) => ({ s, title: s.title, project: s.project.name })),
        q,
      )
        .slice(0, 5)
        .map(({ s }) => ({
          id: s.id,
          title: s.title,
          project: s.project.name,
          meta: s.thread ? (s.drawing ? 'drawing now' : shapeAgo(s.updated)) : 'no thread',
          hash: s.thread ? `#thread=${encodeURIComponent(s.thread)}&shape=${encodeURIComponent(s.id)}` : `#shapes&shape=${encodeURIComponent(s.id)}`,
          picture: s.preview?.picture ?? null,
          refs: s.preview?.refs ?? [],
        })),
    [shapes.shapes, shapeOn],
  );
  // The board open over its thread or over the grid. A review draws its own, over the review (ReviewPane).
  const shapeLayerId = boardsOn && route.shape && (route.page === 'shapes' || (route.page === 'inbox' && !!route.thread)) ? route.shape : null;
  const guideMessage =
    route.guide && thread && thread.thread_id === route.thread ? (thread.messages.find((m) => m.id === route.guide && m.guide) ?? null) : null;
  // Every guide or review opens the full-window review (ReviewPane, approval "inbox-one-review-screen").
  const reviewPaneOpen = !!guideMessage;
  // Show me from a thread's board, above the board: one closed while another draws keeps its wait and the presses
  // behind it, and the new board opens when it lands: over the grid or its own thread, else in its own thread.
  const showMeThreadRef = useRef<string | null>(null);
  const threadShowMe = useThreadShowMe({
    shapes,
    board: shapeLayerId && !reviewPaneOpen ? shapeLayerId : null,
    onBoard: (id) => {
      const now = routeRef.current;
      const home = showMeThreadRef.current;
      go(showMeBoardOpensIn(now, home) === 'here' ? { ...now, shape: id } : { page: 'inbox', project: null, thread: home, shape: id });
    },
    say,
  });
  showMeThreadRef.current = threadShowMe.threadId;
  reviewPaneOpenRef.current = reviewPaneOpen;
  // The review is at the place a board's link named: the address lets it go, so a reload opens it at the top.
  const landGuide = () => {
    const now = routeRef.current;
    if (now.guideAt) writeRoute({ ...now, guideAt: null }, { replace: true });
  };
  // Linked machines: the open thread's machine is away, so its read failed: "MacBook asleep since …", and the answers
  // held for it. A phone and a stacked window show this in the thread's place too, so a held answer is never out of sight.
  const openOwner = route.thread ? machines.linked.find((m) => m.id === machineOf(route.thread!)) : undefined;
  const threadAway = openOwner ? threadAwayLine(openOwner) : null;
  // Or two linked machines claim it, which the thread's place says plainly.
  const openWaits = !!route.thread && !(thread && thread.thread_id === route.thread) && threadLoad?.threadId === route.thread;
  const awayWait = openWaits && (((!!threadAway || !!threadLoad?.waiting) && threadLoad?.state === 'failed') || threadLoad?.state === 'refused');
  // The screen on top, which a phone shows alone (inbox.css): the list, a thread, a file.
  // A thread is on top once it has loaded, so a phone keeps the list until there is a thread to show (or its machine is away).
  // A link into a thread in Reviews waits for the rows: drawn before them, the whole thread would show and then fold.
  const reviewRowsPending = !!route.reviews && ((settings === null && !settingsReadFailed) || (pullsShown && !pulls.reviews && !pulls.error));
  const threadReady = !!thread && thread.thread_id === route.thread && !reviewRowsPending;
  const view =
    route.page === 'inbox'
      ? fileOpen
        ? 'file'
        : route.thread && (threadReady || awayWait)
          ? 'thread'
          : 'list'
      : route.page;
  // A screen pushed over a shallower one slides in on a phone (inbox.css `data-enter`); one uncovered by
  // closing what was over it (a file back to its thread) does not slide again.
  const viewDepth = (v: string) => (v === 'file' ? 2 : v === 'thread' ? 1 : 0);
  const lastView = useRef(view);
  const entered = useRef<string | null>(null);
  if (lastView.current !== view) {
    entered.current = viewDepth(view) > viewDepth(lastView.current) ? view : null;
    lastView.current = view;
  }

  // A thread that covers the list (stack.ts) takes the focus with it, and gives it back to
  // its row: the list is hidden under it, so focus left on the row clicked (or on the pane's Back) would
  // sit on something nobody can see.
  // The list row that last had focus, and the one to return to on Back (see the resize effect below).
  const listFocus = useRef<string | null>(null);
  const returnRow = useRef<string | null>(null);
  const focusFrom = useRef<{ view: string; thread: string | null }>({ view, thread: null });
  // `‹ Inbox` in the thread's header with a file beside it: the thread whose row takes focus once the file
  // has closed and the list is back (the list is not drawn while the file is open, so it waits for the view).
  const backFromFile = useRef<{ thread: string; name: string | null; label: string } | null>(null);
  useEffect(() => {
    const before = focusFrom.current;
    focusFrom.current = { view, thread: view === 'thread' ? route.thread : null };
    if (before.view === view) return;
    const fromFile = backFromFile.current;
    backFromFile.current = null;
    if (phone) return;
    if (fromFile && before.view === 'file' && view === 'thread' && route.thread === fromFile.thread) {
      // After the stack is measured for the new layout: say what actually happened.
      requestAnimationFrame(() => {
        const covered = rootRef.current?.dataset.stack?.split(' ').includes('thread') ?? false;
        if (!covered) {
          focusFirst([`.ib-listcol .ib-lbody [data-thread-id="${CSS.escape(fromFile.thread)}"]`, 'section.ib-pane h2.ib-subject']);
          say(`${fromFile.label} list shown.${fromFile.name ? ` ${fromFile.name} closed.` : ''}`);
        } else {
          // No room for the list beside the thread even without the sidebar: the thread covers it, as when stacked.
          focusFirst(['section.ib-pane [data-stack-back]', 'section.ib-pane h2.ib-subject']);
          say(`${fromFile.name ?? 'The file'} closed.`);
        }
      });
      return;
    }
    if (stack.thread && view === 'thread' && before.view === 'list') {
      focusFirst(['section.ib-pane [data-stack-back]', 'section.ib-pane h2.ib-subject']);
    } else if (stack.thread && view === 'list' && before.view === 'thread' && before.thread) {
      // The row that had focus when the window stacked (below), else the thread's own row.
      const row = returnRow.current ?? before.thread;
      returnRow.current = null;
      focusFirst([`.ib-listcol .ib-lbody [data-thread-id="${CSS.escape(row)}"]`, `.ib-listcol .ib-lbody [data-thread-id="${CSS.escape(before.thread)}"]`]);
    }
  }, [view, route.thread, stack.thread, phone]);

  // The window resized across the stacking width with a thread open. Into it: a list row that
  // had focus is now hidden under the pane (and redrawn), so focus would drop to the page; it goes to the
  // pane's `‹ Inbox` instead, and Back returns it to that row. Out of it: the pane's Back is
  // gone, so focus goes to the row the person came from, now beside the pane.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      // A row, or its hover action beside it (`.ib-rw[data-row]`).
      const row = target?.closest?.('.ib-listcol [data-thread-id], .ib-listcol [data-row]');
      listFocus.current = row ? (row.getAttribute('data-thread-id') ?? row.getAttribute('data-row')) : null;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  // The list on screen changed: play the slide when one was armed (settle.ts),
  // and, after a key, never leave focus on the page. A row that had focus and
  // left the rows on screen (for folded Quiet) hands it to the row now in its
  // slot; Show (whose line goes away) hands it to the first row it brought in.
  const listOrder = useRef<string[]>([]);
  // A compose send's thread, lit once (the Show light, no new motion) when its row is on screen in this commit. A row
  // that is not (another project or filter, a covered list) gets nothing, now or later.
  useLayoutEffect(() => {
    if (!sentLight) return;
    setSentLight(null);
    const body = listBody(rootRef.current);
    if (!body || !rowElement(body, sentLight.thread)) return;
    // A slide armed for this commit (below) plays first, as for Show.
    light(new Set([sentLight.thread]), slideFrom.current ? SHOW_LIT_AFTER_SLIDE_MS : 0);
  }, [sentLight, light]);
  // The last order that drew the open thread's row, kept when that row leaves the rows on screen: J / K step from its slot.
  const openSlot = useRef<{ thread: string; order: string[] } | null>(null);
  const focusAfterShow = useRef(false);
  /** The list's pill was pressed (Show, and "take me there"): the list's next draw goes to the rows it brought in past that edge. Show's own line never scrolls. */
  const goAfterShow = useRef<ListEdge | null>(null);
  /** The row Back over a covered list focused (a key, or a stacked window's mouse Back), which its settle redraws in another group. */
  const refocusRow = useRef<string | null>(null);
  useLayoutEffect(() => {
    const body = listBody(rootRef.current);
    const from = slideFrom.current;
    slideFrom.current = null;
    const order = from?.order ?? listOrder.current;
    if (body && from) playSettle(body, from);
    const showBefore = showFrom.current;
    showFrom.current = null;
    const pressedPill = goAfterShow.current;
    goAfterShow.current = null;
    // The rows Show (or a refresh) brought in, in the order they are drawn, their groups opened with the press.
    let brought: HTMLElement[] = [];
    if (showBefore && shown) {
      const ids = showBroughtIn(showBefore, shown);
      if (body) brought = [...body.querySelectorAll<HTMLElement>('[data-thread-id]')].filter((el) => ids.has(el.getAttribute('data-thread-id')!) && el.getClientRects().length > 0);
      // A read that brings nothing in (Show again, a second refresh) leaves the light already on as it is.
      // Each lights when it is in view in the list (showLight.ts): Show never scrolls, and the rows out of view
      // wait for the reader, counted by the list's pill. Only that pill's press goes to them.
      if (ids.size > 0) {
        light(ids, from ? SHOW_LIT_AFTER_SLIDE_MS : 0, body);
        if (pressedPill) goToNew(pressedPill);
      }
    }
    const shownAll = focusAfterShow.current;
    focusAfterShow.current = false;
    const gone = listFocus.current;
    const refocus = refocusRow.current;
    refocusRow.current = null;
    const active = document.activeElement;
    const lost = !active || active === document.body;
    const moved = body && refocus ? rowElement(body, refocus) : null;
    if (moved && lost) {
      moved.focus({ preventScroll: true });
    } else if (body && lost && shownAll) {
      // The first row Show brought in; else the first row that was not drawn before (a group it opened), else the top.
      const rows = [...body.querySelectorAll<HTMLElement>('[data-thread-id]')];
      (brought[0] ?? rows.find((row) => !order.includes(row.getAttribute('data-thread-id')!)) ?? rows[0])?.focus({ preventScroll: true });
    } else if (body && lastInput() === 'keyboard' && gone && lost && rowElement(body, gone)) {
      // The row is still on screen but was drawn again (its section changed under a held list): focus follows it.
      rowElement(body, gone)?.focus({ preventScroll: true });
    } else if (body && lastInput() === 'keyboard' && gone && lost && !rowElement(body, gone)) {
      const next = rowInSlot(order, gone, (id) => rowElement(body, id) !== null);
      const target = next ? rowElement(body, next) : ([...body.querySelectorAll<HTMLElement>('button.ib-band')].find((el) => el.getClientRects().length > 0) ?? null);
      target?.focus({ preventScroll: true });
    }
    listOrder.current = body ? [...body.querySelectorAll('[data-thread-id]')].map((el) => el.getAttribute('data-thread-id')!) : [];
    const open = routeRef.current.thread;
    if (open && order.includes(open) && !listOrder.current.includes(open)) openSlot.current = { thread: open, order };
  }, [shown]);
  const stackedBefore = useRef({ thread: stack.thread });
  useEffect(() => {
    const was = stackedBefore.current;
    stackedBefore.current = { thread: stack.thread };
    if (phone) return;
    const active = document.activeElement as HTMLElement | null;
    const lost = !active || active === document.body || active.getClientRects().length === 0 || getComputedStyle(active).visibility === 'hidden';
    if (view === 'thread' && was.thread !== stack.thread) {
      if (stack.thread) {
        if (listFocus.current && (lost || active?.closest('.ib-listcol'))) {
          returnRow.current = listFocus.current;
          focusFirst(['section.ib-pane [data-stack-back]', 'section.ib-pane h2.ib-subject']);
        }
      } else if (lost) {
        const row = returnRow.current ?? route.thread;
        returnRow.current = null;
        if (row) focusFirst([`.ib-listcol .ib-lbody [data-thread-id="${CSS.escape(row)}"]`]);
      }
    }
  }, [stack.thread, view, route.thread, phone]);

  // Remote launch: where the person last started an agent on each machine, from the merged list's launched rows.
  // The rows the window has: where the sidebar's Agents section finds each agent's thread, and the last agent started.
  const composeLastAgent = useMemo(() => lastLaunchAgent(windowRows), [windowRows]);
  useComposerOpener(openCompose, composeLastAgent);
  // "+" on project rows (F1-F7): on while launch is on and this is no guest's page. This computer's launch block says
  // which rows can start anything (agents, the folder still there): read when "+" comes on, when the tab is shown, and
  // when the projects change; never on a timer.
  const plusOn = projectPlusOn(settings?.launch?.enabled, guestPage);
  const [plusHere, setPlusHere] = useState<InboxComposeLaunch | null>(null);
  const projectCount = projects.length;
  useEffect(() => {
    if (!plusOn) return;
    let live = true;
    const read = () => {
      if (document.visibilityState === 'hidden') return;
      inboxApi.composeSessions(null, null).then(
        (got) => live && setPlusHere(got.launch ?? null),
        () => {},
      );
    };
    read();
    document.addEventListener('visibilitychange', read);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', read);
    };
  }, [plusOn, projectCount]);
  const composeLaunched = useMemo(() => launchHistory(latest ? [...latest.sections.flatMap((section) => section.threads), ...(latest.snoozed ?? [])] : []), [latest]);
  // The project compose treats as current: the list's filter, else the open thread's.
  const composeCurrent = (() => {
    const id = route.page === 'inbox' ? (route.project ?? thread?.project.id ?? null) : null;
    const folder = id ? projects.find((p) => p.id === id) : null;
    return folder ? { id: folder.id, root: folder.root, name: folder.name } : thread && route.thread ? { id: thread.project.id, root: thread.project.root, name: thread.project.name } : null;
  })();

  // The last step’s notifications line (choice 6): asked on the click, in the screen's "Try it".
  const tourAskKind = tourRealStep && !tourAskHidden && !guestPage && notifications.permission !== 'unsupported'
    ? notifications.permission === 'denied'
      ? 'blocked'
      : notifications.permission === 'granted' && settings?.notifications.enabled
        ? null
        : 'ask'
    : null;
  const firstRunScreen = (opts: { tour: boolean }) => (
    <EmptyState
      context={context}
      agents={agents}
      agentsUnavailable={guestPage ? 'tailnet' : agentsSettled && agents === null ? 'failed' : null}
      onRetry={() => void refreshAgents()}
      sessions={firstRunSessions}
      onAgents={setAgents}
      onMessage={(session, opener) => openCompose({ session }, opener)}
      heading={opts.tour ? 'Now, let’s connect your agents' : undefined}
      lead={opts.tour ? 'Back in your own Inbox. Nothing from the tour was kept.' : undefined}
      onTakeTour={opts.tour || !settings?.tour || tourUnavailable ? undefined : startTour}
      tryPrompt={opts.tour ? TOUR_FIRST_QUESTION_PROMPT : undefined}
      ask={
        opts.tour ? (
          tourAskKind ? (
            <NotificationAsk
              kind={tourAskKind}
              firstRun
              soundOn={sound.settings.enabled}
              movedFrom={null}
              onTurnOn={() => void notifications.turnOn()}
              onNotNow={() => setTourAskHidden(true)}
              // The last step: Settings → General, where notifications are, and the tour counts as finished.
              onSettings={() => endTour('finish', { page: 'settings', project: null, thread: null, section: 'general' })}
            />
          ) : notifications.permission === 'granted' && settings?.notifications.enabled ? (
            <div className="ib-tour-notified" data-tour-notified="">
              <Icon name="check" size={15} />
              <span>Notifications are on for this address.</span>
              <button type="button" className="ib-btn ib-ghost ib-sm" onClick={() => notifications.sendTest()}>
                Send a test notification
              </button>
            </div>
          ) : null
        ) : // On this computer and on the owner's other devices (owner ruling 2026-11-11); never a tailnet guest's page.
        connectLineEl || (notifications.firstRunAsk && askLinesFree && !guestPage) ? (
          <>
            {connectLineEl}
            {notifications.firstRunAsk && askLinesFree && !guestPage && (
              <NotificationAsk
                kind={notifications.firstRunAsk}
                firstRun
                soundOn={sound.settings.enabled}
                movedFrom={settings?.notifications.allowed_origin ?? null}
                onTurnOn={() => void notifications.turnOn()}
                onNotNow={notifications.notNow}
                onSettings={() => go({ page: 'settings', project: null, thread: null, section: 'general' })}
              />
            )}
          </>
        ) : null
      }
    />
  );

  // A thread opened from Reviews starts at its review (`reviewViewOf`); it is the same thread, and links back to the Inbox's view of it.
  const reviewRow = route.reviews && route.thread && pullsShown ? (pulls.reviews?.rows.find((row) => row.reviewed && row.thread_id === route.thread) ?? null) : null;
  const reviewView =
    reviewRow && thread && thread.thread_id === route.thread
      ? reviewViewOf(reviewRow, thread, {
          projectName: projectNames.get(reviewRowProject(reviewRow) ?? '') ?? null,
          onWholeThread: () => go({ page: 'inbox', project: null, thread: reviewRow.thread_id }),
          onOpenStack: (stackId) => go({ page: 'reviews', project: route.reviews?.project ?? null, view: route.reviews?.view, thread: null, stack: stackId }),
        })
      : null;
  // The Reviews list: on its own page, or beside a thread opened from it (the thread pane is the Inbox's own).
  const reviewsList = (project: string | null, view: PullFilter, threadId: string | null) => {
    // A PR opened from a project's drawing closes back to it (its own page only).
    const drawingKept = systemKept(route, systemOnHere && !threadId);
    return (
    <PullsPage
      state={pulls}
      stackId={route.stack ?? null}
      threadId={threadId}
      onHide={threadId && !stack.thread ? () => setThreadFull(true) : undefined}
      project={project}
      filter={view}
      projects={projects}
      projectNames={projectNames}
      phone={phone}
      onNew={() => openCompose({ review: {} })}
      onOpenStack={(id) => (id ? writeRoute({ page: 'reviews', project, view, thread: null, stack: id, layer: null, ...drawingKept }, { replace: !!route.stack && !phone }) : close({ page: 'reviews', project, view, thread: null, stack: null, layer: null, ...drawingKept }))}
      onScope={({ filter, project: next }) => go(threadId ? { ...route, reviews: { project: next, view: filter } } : { page: 'reviews', project: next, view: filter, thread: null, stack: null, ...drawingKept })}
      onReview={(stack, layer, scope) => go({ page: 'reviews', project, view, thread: null, stack, layer, scope, ...drawingKept })}
      system={
        systemOnHere && !threadId
          ? {
              projects: systemProjects.projects,
              open: route.system ?? null,
              sheet: route.sheet ?? null,
              full: route.full === true,
              // Picking a project opens its drawing in place of a PR's pane; the list keeps its filter.
              onOpen: (system) => (system ? go({ ...route, stack: null, layer: null, system, sheet: null, full: false }) : close({ ...route, system: null, sheet: null, full: false })),
              onSheet: (sheet) => writeRoute({ ...route, sheet }, { replace: true }),
              onFull: (full) => (full ? go({ ...route, full: true }) : close({ ...route, full: false })),
              onMenu: systemProjects.reload,
            }
          : null
      }
      onOpenThread={(id) => go({ page: 'inbox', reviews: { project, view }, project: null, thread: id })}
      onOpenCard={boardEnabled ? (cardId) => go({ page: 'board', project: null, thread: null, board: 'lanes', card: cardId }) : undefined}
      onNewReview={(pick, opener) => openCompose({ review: { pick } }, opener)}
      prsSummary={sheetHead}
      onPullRequests={() => go({ page: 'prs', project: null, thread: null })}
      prBoard={
        <SheetPage
          mode="pane"
          model={sheetPulls.model}
          error={sheetPulls.error}
          loading={sheetPulls.loading}
          phone={phone}
          view={paneView}
          onView={setPaneView}
          onOpenPull={(pull, stack) => go({ page: 'prs', project: null, thread: null, stack: stack.id, layer: pull.key, scope: 'layer', prsFrom: 'reviews' })}
          onOpenStack={(stack) => go({ page: 'prs', project: null, thread: null, stack: stack.id, layer: null })}
          onMerged={sheetPulls.refresh}
        />
      }
    />
    );
  };
  /** The Board's ⋮ Refresh (BoardPage's `onChanged` with no card), and Shift+R on the Board. */
  const refreshBoard = () => {
    void refreshCards();
    void refreshList(false);
  };
  /** Where the board is: its own page on a phone, Reviews' right pane on a desktop. */
  const prsHome = (from: Route): Route => (phone ? { page: 'prs', project: null, thread: null, prsView: from.prsView } : { page: 'reviews', project: null, thread: null });
  /** A PR's Back, opened from the board in Reviews, from the board, or from a stack's page. */
  const prsBack = (from: Route): Route =>
    from.prsFrom === 'reviews' ? { page: 'reviews', project: null, thread: null } : from.prsFrom === 'sheet' ? prsHome(from) : { ...from, layer: null, scope: 'layer', prsFrom: 'stack' };
  let main: ReactNode;
  if (tourOn && !tourFixture) {
    main = <TourLoading />;
  } else if (tourOn && tourFixture && tourState.step < TOUR_STEPS) {
    main = (
      <TourMain
        fixture={tourFixture}
        state={tourState}
        dispatch={dispatchTour}
        phone={phone}
        stacked={stack}
        reduced={reducedMotion}
        say={say}
        onDegraded={degradeTour}
        onUi={setTourUi}
        onCompose={openTourComposeOrNudge}
        onNudge={nudgeTour}
      />
    );
  } else if (tourOn) {
    main = firstRunScreen({ tour: true });
  } else if (route.page === 'settings') {
    main = (
      <SettingsPage
        settings={settings}
        onTakeTour={settings?.tour ? startTour : undefined}
        context={context}
        error={settingsError}
        onToggleTool={toggleTool}
        onToggleExperimental={(next) => void toggleExperimental(next)}
        onToggleCookieHost={(next) => void toggleCookieHost(next)}
        landOnExperimental={route.experimental === true}
        onToggleBoard={(next) => void toggleBoard(next)}
        onToggleSteps={(next) => void toggleSteps(next)}
        onToggleBro={(next) => void toggleBro(next)}
        onToggleFloatDrafts={(next) => void toggleFloatDrafts(next)}
        onToggleMarkReadWarning={(next) => void toggleMarkReadWarning(next)}
        onToggleCodeReview={(next) => void toggleCodeReview(next)}
        onToggleShape={(next) => void toggleShape(next)}
        onToggleSystem={(next) => void toggleSystem(next)}
        onToggleChapterDiagrams={(next) => void toggleChapterDiagrams(next)}
        systemProjects={systemProjects.projects}
        agents={agents}
        onAgents={setAgents}
        onPrompts={(prompts) => setSettings((current) => (current ? { ...current, prompts } : current))}
        machines={machineViews ?? undefined}
        onMachineUpdate={pageOffersUpdates(settings) ? (id) => setMachineUpdateOpen({ id, snooze: false }) : undefined}
        onMachinesChanged={() => {
          inboxApi.machines().then((next) => setMachineViews(next.machines), () => {});
          void refreshList(false);
        }}
        onToggleTailscale={(next, replaceExposed) => void toggleTailscale(next, replaceExposed)}
        tailscaleBusy={tailscaleBusy}
        permission={notifications.permission}
        onToggleNotifications={(next) => void notifications.setEnabled(next)}
        notifyReach={notifications.reach}
        onTestNotification={notifications.sendTest}
        onDeleteThread={deleteThread}
        onDeleteProject={deleteProject}
        store={store}
        storeError={storeError}
        onReadStore={readStore}
        sound={settings?.sound ? sound : undefined}
        archived={<ArchivedBlock refreshKey={latest?.cursor ?? null} onUnarchive={unarchiveFromSettings} />}
        activity={
          <ActivityChart
            projects={activityProjects}
            names={projectNames}
            project={routeOf(settingsReturn.current).project ?? null}
            phone={phone}
            refreshKey={latest?.cursor ?? null}
            onOpenThread={(thread, project) => go({ page: 'inbox', project, thread })}
          />
        }
        archivedTotal={archivedTotal}
        rowsPreview={rowsPagePreview}
        aboutDot={pageUpdate ? true : pageCheckFailing ? 'check-failing' : false}
        updateRow={
          settings && pageOffersUpdates(settings) ? (
            <GeneralUpdateRow
              version={latest?.version ?? settings.version ?? 'dev'}
              details={updateDetails}
              update={pageUpdate}
              restarting={restarting}
              checking={checking}
              failing={updateDetails?.check.failing ?? pageCheckFailing}
              onCheckNow={() => void checkNow()}
              onUpdate={pressUpdate}
              onWhatsNew={openWhatsNew}
            />
          ) : undefined
        }
        about={
          <AboutBlock
            version={latest?.version ?? settings?.version ?? 'dev'}
            details={updateDetails}
            switches={settings?.updates}
            checking={checking}
            error={null}
            onCheckNow={() => void checkNow()}
            onToggle={(change) => void saveUpdateSwitches(change)}
            update={pageUpdate}
            updates={pageOffersUpdates(settings)}
            whatsNewRunning={settings?.via === 'tailnet'}
            onUpdate={pressUpdate}
            onWhatsNew={pageWhatsNew ? openWhatsNew : undefined}
            where={
              settings
                ? { data: tildePath(settings.data_dir, settings.home), mcpUrl: settings.mcp_url, mcpCommand: shellLine(settings.mcp_command) }
                : null
            }
          />
        }
        section={route.section ?? null}
        pairing={route.pair === true}
        phone={phone}
        onSection={(section) =>
          section === null && phone ? close({ page: 'settings', project: null, thread: null, section: null }) : go({ page: 'settings', project: null, thread: null, section })
        }
        onPairing={(open) =>
          open
            ? go({ page: 'settings', project: null, thread: null, section: 'devices', pair: true })
            : close({ page: 'settings', project: null, thread: null, section: 'devices' })
        }
        onBack={() => pageBackRef.current()}
        onRetry={() => {
          setSettingsError(null);
          void refreshSettings();
        }}
      />
    );
  } else if (route.page === 'whats-new') {
    main = (
      <WhatsNewPage
        version={whatsNewVersion}
        model={whatsNew}
        error={whatsNewError}
        releases={whatsNewReleases}
        update={pageUpdate}
        onBack={() => pageBackRef.current()}
        onUpdate={pressUpdate}
        onOpenRelease={(version) => go({ page: 'whats-new', project: null, thread: null, version })}
        onRetry={() => {
          whatsNewRetryFor.current = whatsNewVersion;
          setWhatsNewRetry((n) => n + 1);
        }}
        onTakeTour={
          settings?.tour && !tourUnavailable && settings.tour.seen_at === null && settings.tour.skipped_at === null && settings.tour.finished_at === null ? startTour : undefined
        }
      />
    );
  } else if (route.page === 'board' && boardEnabled === false) {
    // The Board is off: a #board link says so, with the one way to turn it on (nothing else of it shows).
    main = <BoardOff guest={guestPage} onTurnOn={() => void toggleBoard(true)} error={settingsError} />;
  } else if (route.page === 'board' && boardEnabled === null) {
    main = <section className="ib-bpage" aria-busy="true" data-board-page="" />;
  } else if (route.page === 'board') {
    // The opened card's threads and a sent card's ticks read the list's rows (pins included).
    const rowById = new Map<string, InboxListRow>();
    for (const section of latestGroups) for (const row of section.threads) rowById.set(row.thread_id, row);
    for (const row of latest?.pins ?? []) if (!rowById.has(row.thread_id)) rowById.set(row.thread_id, row);
    // The cards' own answer names threads the list leaves out (archived): the opened card still names them.
    for (const [id, row] of Object.entries(cards?.threads ?? {})) if (row && !rowById.has(id)) rowById.set(id, row);
    main = (
      <BoardPage
        view={route.board ?? 'lanes'}
        model={cards}
        error={cardsError}
        visitLook={boardVisit ? boardVisit.look : (cards?.seen_seq ?? null)}
        handled={boardVisit?.handled ?? EMPTY_SET}
        projects={projects}
        // The filtered project, else the project of the card heard from last, else the first.
        defaultProject={newCardProject(boardFilter, projects, cards?.cards ?? [])}
        home={settings?.home ?? null}
        mcpCommand={settings?.mcp_command ?? null}
        phone={phone}
        openCard={route.card ?? null}
        onOpenCard={(id) => {
          if (id) handleCard(id);
          const next: Route = { page: 'board', project: route.project, initiative: boardInitiative, thread: null, board: route.board ?? 'lanes', card: id };
          // Another card replaces the open one's entry; opening the first and closing are entries of their own (a phone's Back closes it).
          if (id === null && route.card) close(next);
          else writeRoute(next, { replace: !!route.card && id !== null });
        }}
        rowOf={(threadId) => rowById.get(threadId) ?? null}
        onView={(next) => go({ page: 'board', project: route.project, initiative: boardInitiative, thread: null, board: next })}
        project={boardFilter}
        // The filter is a place, like the list's project: each pick is a history entry, and Back undoes it.
        onProject={(project) => {
          // An opened card stays open while the Board still shows it.
          const open = route.card ? cards?.cards.find((c) => c.id === route.card) : undefined;
          go({
            page: 'board',
            project,
            initiative: boardInitiative,
            thread: null,
            board: route.board ?? 'lanes',
            card: open && (project === null || open.project_id === project) ? open.id : null,
          });
        }}
        initiative={boardInitiative}
        onClearFilter={() => go({ page: 'board', project: null, initiative: null, thread: null, board: route.board ?? 'lanes', card: route.card ?? null })}
        // The other half of the one filter: a pick is a history entry too, and Back undoes it.
        onInitiative={(initiative) => {
          const open = route.card ? cards?.cards.find((c) => c.id === route.card) : undefined;
          const shows = open && cardsInInitiative([open], initiative, liveInitiatives(cards?.initiatives)).length > 0;
          go({ page: 'board', project: route.project, initiative, thread: null, board: route.board ?? 'lanes', card: shows ? open.id : null });
        }}
        onMove={moveCard}
        // A card that leaves the lanes from its right-click menu: the one toast, with Undo (`Z`).
        onToast={(next) => (next ? showToast(next) : dismissToast())}
        onChanged={(card) => {
          if (card) {
            handleCard(card.id);
            setCards((model) => (model ? { ...model, cards: [card, ...model.cards.filter((c) => c.id !== card.id)] } : model));
          }
          refreshBoard();
        }}
        onSeeDrops={seeDrops}
        tidy={boardTidy}
        onOpenThread={(card, threadId) =>
          go({ page: 'inbox', project: null, thread: threadId, card: card.id, board: route.board ?? 'lanes', boardProject: boardFilter, boardInitiative })
        }
        onCreateThread={(card, session, opener) => openCompose({ session, card: { id: card.id, title: card.title } }, opener)}
        // The lane marks run this computer's gh / glab: never asked from a tailnet guest's page.
        marks={settings !== null && !guestPage}
      />
    );
  } else if (route.page === 'prs' && pullsShown && route.stack && route.layer) {
    // A PR opened from the Sheet or a stack's page: the Inbox's own PR view, on the page's list.
    main = (
      <PullReview
        model={sheetPulls.model}
        modelError={sheetPulls.error}
        stackId={route.stack}
        layerKey={route.layer}
        scope={route.scope ?? 'layer'}
        onLayer={(layer, scope) => writeRoute({ ...route, layer, scope }, { replace: true })}
        onBack={() => close(prsBack(route))}
        onPosted={sheetPulls.refresh}
        onSent={() => {
          close(prsBack(route));
          showToast({ icon: 'check', lead: 'Verdict sent', detail: 'in the agent’s thread', speech: 'Your verdict was sent into the agent’s thread.' }, 5000);
        }}
      />
    );
  } else if (route.page === 'prs' && pullsShown && route.stack) {
    const stacks = sheetPulls.model ? inboxPullStacks(sheetPulls.model.pulls) : [];
    const stack = stacks.find((s) => s.id === route.stack || s.layers.some((l) => l.key === route.stack)) ?? null;
    main = (
      <StackPage
        stack={stack && stack.layers.some(inboxPullIsOpen) ? stack : null}
        loading={!sheetPulls.model}
        repoLabel={stack ? (repoLabels(stacks).get(`${stack.host}/${stack.repo}`.toLowerCase()) ?? stack.repo) : null}
        phone={phone}
        onBack={() => close(prsHome(route))}
        onOpenLayer={(pull) => go({ ...route, layer: pull.key, scope: 'layer', prsFrom: 'stack' })}
      />
    );
  } else if (route.page === 'prs' && pullsShown) {
    main = (
      <SheetPage
        model={sheetPulls.model}
        error={sheetPulls.error}
        loading={sheetPulls.loading}
        phone={phone}
        view={route.prsView ?? 'open'}
        onView={(prsView) => writeRoute({ ...route, prsView }, { replace: true })}
        onBack={() => close({ page: 'reviews', project: null, thread: null })}
        onOpenPull={(pull, stack) => go({ ...route, stack: stack.id, layer: pull.key, scope: 'layer', prsFrom: 'sheet' })}
        onOpenStack={(stack) => go({ ...route, stack: stack.id, layer: null })}
        onMerged={sheetPulls.refresh}
      />
    );
  } else if (route.page === 'prs') {
    main = <section className="ib-prs" aria-busy="true" data-prs-page="" />;
  } else if (route.page === 'reviews' && pullsShown && route.stack && route.layer) {
    main = (
      <PullReview
        model={pulls.model}
        modelError={pulls.error}
        stackId={route.stack}
        layerKey={route.layer}
        scope={route.scope ?? 'layer'}
        onLayer={(layer, scope) => writeRoute({ ...route, layer, scope }, { replace: true })}
        onBack={() => close({ ...route, layer: null, scope: 'layer' })}
        onPosted={pullsReloadRows}
        onSent={() => {
          close({ ...route, layer: null, scope: 'layer' });
          showToast({ icon: 'check', lead: 'Verdict sent', detail: 'in the agent’s thread', speech: 'Your verdict was sent into the agent’s thread.' }, 5000);
        }}
      />
    );
  } else if (route.page === 'reviews' && pullsShown) {
    main = reviewsList(route.project, route.view ?? 'all', null);
  } else if ((route.page === 'reviews' || route.reviews) && settings !== null && !guestPage && !codeReviewOn) {
    main = <ReviewsOff phone={phone} onSettings={() => go({ page: 'settings', project: null, thread: null, section: 'capabilities' })} />;
  } else if (route.page === 'reviews') {
    main = <div className="ib-listcol" aria-busy="true" />;
  } else if (route.page === 'shapes') {
    // The grid (the sidebar's Shape row). A board with a thread opens over its thread; one with none, over the grid.
    main = (
      <ShapeGridPage
        shapes={shapeOn ? shapes.shapes : null}
        onOpen={(s) => go(s.thread ? { page: 'inbox', project: null, thread: s.thread, shape: s.id } : { page: 'shapes', project: null, thread: null, shape: s.id })}
      />
    );
  } else if (route.page === 'artifacts') {
    // The Artifacts wall (approval "inbox-artifact-stars"): a tile opens its file or guided review in its thread; Back comes here.
    main = (
      <ArtifactsWall
        pinned={route.pinned === true}
        onPinned={(pinned) => writeRoute({ page: 'artifacts', project: null, thread: null, pinned }, { replace: true })}
        onOpen={(row) =>
          go(
            row.attachment
              ? { page: 'inbox', project: null, thread: row.thread_id, file: { id: row.attachment.id, version: 'current', focus: null } }
              : { page: 'inbox', project: null, thread: row.thread_id, guide: row.message_id },
          )
        }
        phone={phone}
      />
    );
  } else if (route.page === 'drafts') {
    main = (
      <DraftsPage
        replies={replyDrafts}
        onOpenReply={(row) => go({ page: 'inbox', project: null, thread: row.thread_id })}
        drafts={drafts}
        error={draftsError}
        phone={phone}
        onOpen={(draft, opener) => openCompose({ draft }, opener)}
        onDelete={(draft) => void deleteDraft(draft)}
        onCompose={(opener) => openCompose({}, opener)}
      />
    );
  } else if (!latest || !shown) {
    const loading = loadError && <div className="ib-error" style={{ padding: 22 }}>{loadError}</div>;
    // The thread panel view has its two panes from the first paint, so a reload never draws the wide list first. Blank:
    // whether a thread opens here, or the first-run screen takes the window, is not known yet. The column's edge sets
    // the width the person dragged, as it does for the list that takes its place.
    main =
      panelView && !fileOpen && !fromCard ? (
        <>
          <div className="ib-listcol ib-narrow ib-resizable">
            {loading}
            <ListColumnEdge />
          </div>
          <div className="ib-pane" data-thread-panel-loading="" />
        </>
      ) : (
        <div className="ib-listcol">{loading}</div>
      );
  } else if (showTourEntry) {
    main = (
      <TourEntry
        model={tourEntryModel(agents, guestPage ? 'tailnet' : agentsSettled && agents === null ? 'failed' : null, new Set(firstRunSessions?.projects.flatMap((g) => g.sessions.map((x) => x.host)) ?? []))}
        onStart={startTour}
        onConnect={() => {
          saveTour({ skipped: true });
          // The real first-run screen takes the place of the entry screen: focus goes to its heading.
          requestAnimationFrame(() => requestAnimationFrame(() => focusFirst(['.ib-main .ib-empty h2'])));
        }}
      />
    );
  } else if (firstRun && settings === null && !settingsReadFailed && !settingsLate) {
    // The settings say whether the entry screen shows: a moment's wait, never a flash of the wrong screen.
    main = <div className="ib-listcol" aria-busy="true" />;
  } else if (firstRun) {
    if (settings === null) firstRunDrawnBare.current = true;
    main = firstRunScreen({ tour: false });
  } else {
    main = (
      <>
        {/* In full screen the list stays drawn, hidden (inbox.css `data-thread-full`): J/K and G I read its order, and
            its scroll stays where it was. */}
        {!fileOpen && !fromCard && route.reviews && pullsShown && reviewsList(route.reviews.project, route.reviews.view, route.thread)}
        {!fileOpen && !fromCard && !route.reviews && (
        <InboxList
          columnId="ib-list"
          scope={route.project}
          // One project's list: its window name, the path beside it.
          title={listTitle}
          path={filterProject ? tildePath(filterProject.root, settings?.home) : null}
          sections={listSections ?? filterShown(listShown ?? shown)}
          listFilter={{ rows: listFilterRows, scoped: listFilterScoped, names: projectNames, filter: listFilterPicks, onChange: setListFilter }}
          sort={listSort}
          filtered={filterProject !== null}
          projectNames={projectNames}
          machines={machines}
          machineScope={filterMachine?.id ?? null}
          hideAway={hideAway}
          onHideAway={setHideAway}
          // A stacked thread covers the list, which keeps its own width (and scroll) under it.
          narrow={(route.thread !== null || panelView) && !stack.thread}
          onHide={route.thread !== null && !stack.thread ? () => setThreadFull(true) : undefined}
          threadPanel={phone ? undefined : { on: threadPanelOn, onChange: setThreadPanelOn }}
          onCustomizeRows={() => go({ page: 'settings', project: null, thread: null, section: 'rows' })}
          selectedThreadId={route.thread}
          lit={lit}
          notice={notice}
          covered={route.thread !== null && (phone || stack.thread || full)}
          unseenNew={unseenNew}
          onGoNew={goToNew}
          stale={staleNotice}
          ask={
            <>
              {/* What the last run connected and the notes written by themselves (ConnectLine), above the notification lines. */}
              {connectLineEl}
              {/* The first real thread's inline ask (the tour's, once) stands in for this line while it shows. */}
              {notifications.ask && offerLinesFree && !(notifyAgain && notifyAgainThread !== null) ? (
                <NotificationAsk
                  kind={notifications.ask}
                  soundOn={sound.settings.enabled}
                  movedFrom={settings?.notifications.allowed_origin ?? null}
                  onTurnOn={() => void notifications.turnOn()}
                  onNotNow={notifications.notNow}
                  onSettings={() => go({ page: 'settings', project: null, thread: null, section: 'general' })}
                />
              ) : notifications.slept && notifications.permission === 'granted' && offerLinesFree ? (
                <TabSleptLine slept={notifications.slept} onDismiss={notifications.dismissSlept} />
              ) : null}
            </>
          }
          // The title refreshes the list it names, the thread beside it staying open (the list adopts, as Show does).
          onRefresh={() => void refreshInbox(route.project, false)}
          // A phone's pull down from the list's top does the same, its ↻ spinning until the read lands (pullRefresh.ts).
          onPullRefresh={() => refreshInbox(route.project, false)}
          refreshSpin={refreshSpin && refreshSpin.scope === route.project ? refreshSpin.key : null}
          onShowNew={(fromPill) => {
            // Show's line goes away with the press: after a key, focus goes to the first row it brought in.
            focusAfterShow.current = lastInput() === 'keyboard';
            listOrder.current = [...(listBody(rootRef.current)?.querySelectorAll('[data-thread-id]') ?? [])].map((el) => el.getAttribute('data-thread-id')!);
            if (latestRef.current) {
              showFrom.current = shown;
              goAfterShow.current = fromPill ?? null;
            }
            settleList('all', true);
          }}
          onOpen={openRow}
          onMarkRead={(row) => void markRead(row.thread_id, true)}
          onMarkUnread={(row) => void markUnread(row.thread_id)}
          onSendNow={(row) => void sendNowFromRow(row)}
          onRowAction={rowAction}
          onSnooze={snoozeOn ? (row, until) => void snooze(row, until) : undefined}
          snoozesOf={(row) => rowSnoozes(row, machines)}
          snoozeBlockedOf={(row) => (pageOffersUpdates(settings) ? snoozeBlockedBy(row, machines) : null)}
          onSnoozeBlocked={(row) => {
            const blocked = snoozeBlockedBy(row, machines);
            if (blocked) setMachineUpdateOpen({ id: blocked.id, snooze: true });
          }}
          pinned={pinsOn ? pinnedIds : undefined}
          onUnstar={pinsOn ? unstarRow : undefined}
          // "Keep starred above the list" (starredPills.ts): the starred threads as pills, with the sidebar section's actions.
          starred={pinRows ? { rows: pinRows, onOpen: openPinned, onAction: (row, action) => void pinAction(row, action, true) } : undefined}
          tidy={{
            ...listTidy,
            combine: async (pairs) => {
              const failed = await combineProjects(pairs.map((pair) => ({ from: pair.from.id, into: pair.into.id, intoName: pair.into.name })));
              listTidy.refresh();
              return failed;
            },
          }}
          onSearch={(opener) => openSearch(opener)}
          onCompose={(opener) => openCompose({}, opener)}
          phone={phone}
          reconnecting={streamDead}
          empty={
            listFilterEmpty ? (
              <ListFilterEmpty onClear={() => setListFilter(clearedFrom(listFilterPicks, listFilterScoped))} />
            ) : projectAllArchived(filterProject) ? (
              <div className="ib-empty-list" data-project-archived="">
                <b dir="auto">Everything in {listTitle} is archived.</b>
                It leaves the sidebar when you go elsewhere, and comes back when an agent writes there.{' '}
                <a href="#settings/archived">See archived threads</a>
              </div>
            ) : null
          }
        />
        )}
        {panelView && !route.thread && (
          <div className="ib-pane ib-pempty" data-thread-panel-empty="">
            <EmptyThreadPanel />
          </div>
        )}
        {/* Beside the list, the thread's place says it is opening (or why not) until its read lands; a phone
            and a stacked window keep the list until there is a thread to show, or the thread's machine is away. */}
        {route.thread && !threadReady && ((!phone && !stack.thread) || awayWait) && (
          <ThreadWait
            key={route.thread}
            load={threadLoad?.threadId === route.thread ? threadLoad : null}
            away={threadAway}
            held={{ entries: threadOutbox(outbox, { thread_id: route.thread!, messages: [] }), machine: openOwner ?? null, onDismiss: dismissOutbox }}
            onFocusLeaving={() => {
              focusThreadSubject.current = true;
            }}
            onRetry={() => setThreadRetry((n) => n + 1)}
            onClose={fromCard ? backToCard : () => close({ ...route, thread: null, file: null })}
          />
        )}
        {route.thread && thread && threadReady && (
          <ThreadPane
            notice={
              <>
                {/* No list beside the thread (a phone, a stacked window, full screen, a card's thread, beside a file):
                    the stale page notice is here instead. */}
                {(phone || stack.thread || full || fromCard || fileOpen) && staleNotice}
                {notifyAgain && notifyAgainThread === thread.thread_id ? (
                <div className="ib-tour-notify-again" data-tour-notify-again="">
                  <NotificationAsk
                    kind={notifications.ask!}
                    soundOn={sound.settings.enabled}
                    movedFrom={settings?.notifications.allowed_origin ?? null}
                    onTurnOn={() => {
                      saveTour({ notify_again: false });
                      void notifications.turnOn();
                    }}
                    onNotNow={() => saveTour({ notify_again: false })}
                    onSettings={() => go({ page: 'settings', project: null, thread: null, section: 'general' })}
                  />
                </div>
                ) : null}
              </>
            }
            thread={thread}
            onNewMessageWith={(source) => openCompose({ reuse: [source] })}
            codeReview={settings?.code_review?.on === true}
            inReviews={!!route.reviews}
            reviewView={reviewView}
            onInReviews={pullsShown && !route.reviews ? () => go({ page: 'inbox', reviews: { project: null, view: 'all' }, project: null, thread: thread.thread_id }) : undefined}
            threadSteps={
              settings?.steps
                ? {
                    on: settings.steps.on,
                    subscribe: stepsBus.subscribe,
                    // The checklist head's Board icon (part 4): the card that links this thread, while the Board is on.
                    boardCard: (() => {
                      const card = boardEnabled === true && cards ? threadBoardCard(cards.cards, thread.thread_id) : null;
                      if (!card) return null;
                      return {
                        title: card.title,
                        onOpen: () =>
                          fromCard === card.id ? backToCard() : go({ page: 'board', project: null, thread: null, board: 'lanes', card: card.id }),
                      };
                    })(),
                  }
                : null
            }
            sent={openThreadRow?.sent ?? null}
            row={openThreadRow}
            snoozeBack={snoozeBack?.until ?? null}
            run={threadRun?.threadId === thread.thread_id ? threadRun.run : undefined}
            attachCommand={threadRun?.threadId === thread.thread_id ? threadRun.attach : null}
            onRunChanged={() => void refreshThread(thread.thread_id)}
            openedWith={openedWith?.threadId === thread.thread_id ? openedWith.ids : null}
            drawn={drawnSection(shown, thread.thread_id)}
            onMarkRead={(read) => void markRead(thread.thread_id, read)}
            onMarkUnread={() => void markUnread(thread.thread_id)}
            onAck={(messageId, on, agent, reaction, was) => void acknowledge(thread.thread_id, messageId, on, agent, reaction, was)}
            onAction={(messageId, key, mark) => markAction(messageId, key, mark)}
            onArchive={(next) => void archive(thread.thread_id, thread.messages[0]!.id, next)}
            pinned={pinnedIds.has(thread.thread_id)}
            // Pins are this Inbox's own: another machine's thread is pinned on that machine (PLAN Phase 2).
            onPin={pinsOn && !machineOf(thread.thread_id) ? (next) => setPin(thread, next) : undefined}
            onSnooze={snoozeOn && rowSnoozes({ machine: machineOf(thread.thread_id) ?? undefined }, machines) ? (until) => void snooze(thread, until) : undefined}
            onUnsnooze={snoozeOn && rowSnoozes({ machine: machineOf(thread.thread_id) ?? undefined }, machines) ? () => void unsnooze(thread) : undefined}
            snoozeBlocked={(() => {
              const blocked = snoozeOn && pageOffersUpdates(settings) ? snoozeBlockedBy({ machine: machineOf(thread.thread_id) ?? undefined }, machines) : null;
              return blocked ? { name: blocked.name, onPress: () => setMachineUpdateOpen({ id: blocked.id, snooze: true }) } : undefined;
            })()}
            machine={machines.linked.find((m) => m.id === machineOf(thread.thread_id)) ?? null}
            // A Delete refused by a machine too old to take one: the error line's Update opens that machine's update dialog.
            onMachineUpdate={pageOffersUpdates(settings) ? (id) => setMachineUpdateOpen({ id, snooze: false }) : undefined}
            outbox={threadOutbox(outbox, thread)}
            onDismissOutbox={dismissOutbox}
            replyRequest={replyFor}
            draftSignal={draftSignal}
            filesSignal={filesSignal}
            onReplyOpened={() => setReplyFor(null)}
            shapeButton={(() => {
              const board = boardsOn && thread ? shapes.byThread.get(thread.thread_id) : undefined;
              if (!board) return null;
              const open = !!route.shape;
              return <ShapePebbleButton shape={board} open={open} onToggle={() => (open ? close({ ...route, shape: null }) : go({ ...route, shape: board.id }))} />;
            })()}
            onSide={ask.side}
            onSideWords={ask.sideWords}
            replyWords={askReply?.threadId === thread.thread_id ? askReply.words : null}
            onReplyWordsTaken={() => setAskReply(null)}
            replyPart={shapeReply?.threadId === thread.thread_id ? shapeReply : null}
            onReplyPartTaken={() => setShapeReply(null)}
            onQuestions={patchQuestions}
            onPickSaves={onPickSaves}
            onChanged={afterWrite}
            onClose={fromCard ? backToCard : () => close({ ...route, thread: null, file: null })}
            file={route.file ?? null}
            onOpenFile={(file, options) => {
              if (!file) return closeTo({ ...routeRef.current, file });
              // A call that names no view keeps the one in the address (the pane names it for a step, a version, a linked page).
              const keepView = file.view === undefined ? (routeRef.current.file?.view ?? null) : file.view;
              const next = { ...routeRef.current, file: { ...file, view: keepView } };
              /** Show `next` the way fullScreenOrigin.ts names (the history is the stack of frames). */
              const show = (request: { move?: FrameMove; replace?: boolean }) => {
                const op = fileEntryOp({ hash: currentHash(), state: window.history.state }, hashOf(next), request);
                if (op.kind === 'back') {
                  // Back onto the entry beside the thread; where asked, it then shows the file on screen now (a step inside full screen kept).
                  const land = op.land;
                  const landThere =
                    land === null
                      ? undefined
                      : () => {
                          if (currentHash() !== land && readRoute().thread === next.thread) writeRoute(next, { replace: true });
                        };
                  if (backBy(op.steps, window.history, landThere)) return;
                  return writeRoute(next, { replace: true, fullMark: null });
                }
                if (op.kind === 'replace') writeRoute(next, op.keep ? { replace: true } : { replace: true, fullMark: op.mark });
                else writeRoute(next, { fullMark: op.mark });
              };
              if (options?.back) {
                // A linked page's Back in a full screen the switch entered on that page: back past the switch's entry and the
                // page beside the thread, then full screen again with the switch, so × and Back still come back beside the thread.
                if (
                  pageBackPastSwitch({ hash: currentHash(), state: window.history.state }, hashOf(next), sameScreenAnyView) &&
                  backBy(2, window.history, () => {
                    if (readRoute().thread === next.thread) show({ move: 'switch-full' });
                  })
                ) {
                  return;
                }
                // Back through a linked page's stack: the browser's Back when this entry was opened from there,
                // whatever view that entry names (a pick swapped only the entry on screen); once it lands,
                // the view the person is in now replaces the one it named.
                const view = next.file.view;
                const viewThere = view
                  ? () => {
                      const now = readRoute();
                      if (now.file && now.file.view !== view) writeRoute({ ...now, file: { ...now.file, view } }, { replace: true });
                    }
                  : undefined;
                if (backTo(hashOf(next), window.history, sameScreenAnyView, viewThere)) return;
              }
              show({ move: options?.move, replace: options?.replace });
            }}
            fullFromSide={fullFromSide(window.history.state)}
            fullExitFile={fullExitFile(window.history.state)}
            onOpenGuide={(messageId, at) => go({ ...route, guide: messageId, ...(at ? { guideAt: at } : {}) })}
            artifacts={route.artifacts === true}
            onArtifacts={(open) => (open ? go({ ...routeRef.current, artifacts: true, links: false, msg: null }) : close({ ...routeRef.current, artifacts: false, links: false }))}
            links={route.artifacts === true && route.links === true}
            // Between the view's two sides: the same screen, so Back still returns to the thread.
            onLinks={(on) => writeRoute({ ...routeRef.current, links: on }, { replace: true })}
            // Decision mode's one way in (thread only): from two of this thread's decisions up, and not while a
            // sitting is tucked into its pill (the pill's Resume is the way back to it).
            decide={decideInThread(thread.thread_id)}
            landing={
              route.msg && decideLanding.current?.messageId === route.msg
                ? { messageId: route.msg, terms: [], questionKey: decideLanding.current.questionKey, focus: 'prompt' }
                : route.msg
                ? {
                    messageId: route.msg,
                    terms: searchLanding.current?.messageId === route.msg ? searchLanding.current.terms : [],
                    questionKey: searchLanding.current?.messageId === route.msg ? searchLanding.current.questionKey : null,
                  }
                : null
            }
            onLanded={landed}
            lookSeq={look?.threadId === thread.thread_id ? look.seq : undefined}
            seenThrough={look?.threadId === thread.thread_id ? look.through : null}
            onSeen={(through) => seenOnSight(thread.thread_id, through)}
            covered={!!route.guide || updateDialog !== null || soundDialog === 'open' || agentNoteOpen || feedbackOpen || compose !== null}
            onScreenChange={(state) => {
              threadOnScreenRef.current = state;
              setOpenThreadCovered(state?.covered ?? false);
            }}
            backLabel={fromCard ? 'Board' : route.reviews ? 'Reviews' : listTitle}
            cardChip={fromCard ? <CardChip card={cards?.cards.find((c) => c.id === fromCard) ?? null} onOpen={backToCard} /> : undefined}
            phone={phone}
            stacked={stack.thread || !!fromCard}
            threadAlone={full}
            fullSidebar={sidebarOpen && !sidebarHeld}
            onFull={fromCard ? undefined : (on) => (on ? setThreadFull(true) : leaveFull())}
            fileStacked={stack.file}
            remote={settings ? (settings.via ?? 'local') === 'tailnet' : null}
            guest={guestPage}
            onToast={(t) => showToast(t)}
            onToastGone={(onUndo) => {
              if (toastNow.current?.onUndo === onUndo) dismissToast();
            }}
            linkOf={(messageId) => threadLink(thread.thread_id, settings, window.location.origin, messageId)}
            onInboxLink={inboxLink}
            onBackToList={(fileName) => {
              // The file's own close (its ×), then focus on this thread's row and one line for a screen reader.
              holdSidebarIfTight();
              // ‹ Inbox beside a file opened from full screen ends full screen too: the list comes back.
              setThreadFull(false);
              backFromFile.current = { thread: thread.thread_id, name: fileName, label: listTitle };
              closeTo({ ...routeRef.current, file: null });
            }}
          />
        )}
      </>
    );
  }
  // Shift+R: the refresh of the page on screen (keyboard/appKeys.ts `refreshKind` decides which).
  const refreshOpen = route.page === 'inbox' ? route.thread : null;
  refreshRef.current = refreshAction(
    refreshKind({
      page: route.page,
      thread: route.thread,
      fromReviews: !!route.reviews,
      fromCard: !!fromCard,
      pullReview: !!(route.stack && route.layer),
      fileOpen,
      tourOn,
      boardOn: boardEnabled === true,
      pullsShown,
      listReady: !!latest && !!shown && !showTourEntry && !firstRun,
    }),
    {
      inbox: () => void refreshInbox(route.project, false),
      board: refreshBoard,
      reviews: pulls.refresh,
      thread: () => {
        if (refreshOpen) void refreshThread(refreshOpen);
      },
    },
  );

  return (
    <InitiativeTagsContext.Provider value={initiativeTags}>
    <SideButtonContext.Provider value={ask.sideButton}>
    <div
      ref={rootRef}
      className="pn-inbox"
      // Tooltips (Tip, ui's HostTitle) portal here, so the window's tokens (the Soft switches) reach them.
      data-pn-tooltip-root=""
      data-view={tourOn ? (tourFixture && tourState.step < TOUR_STEPS ? tourView(tourState) : 'list') : view}
      data-enter={tourOn ? undefined : (entered.current ?? undefined)}
      // The tour draws its stacked layouts itself (tour/Tour.tsx): the window's stacking rules stay out of it.
      data-stack={!tourOn && (stack.thread || stack.file) ? [stack.thread && 'thread', stack.file && 'file'].filter(Boolean).join(' ') : undefined}
      // The thread in full screen: the list is hidden under it (inbox.css), not taken off the page.
      data-thread-full={full ? '' : undefined}
      data-tour={tourOn ? String(tourState.step) : undefined}
    >
      {/* The sidebar's Customize panel (approval "inbox-sidebar-customize"): one for the window, beside the sidebar or, on a phone, a bottom sheet. */}
      {!tourOn && (
        <SidebarCustomizer
          drawn={drawnSidebarItems({ board: Boolean(boardEnabled), reviews: Boolean(pullsShown), shape: Boolean(shapeOn && shapes.rowShown), usage: settings?.cswap === true, phone })}
          machines={machines.all.length > 0}
          // Opened from Settings on a desktop, where the sidebar is closed: it opens, so the person sees each change.
          onOpen={() => {
            if (!phone && routeRef.current.page === 'settings') setSettingsSidebar(true);
          }}
        />
      )}
      {tourOn && (
        <TourBar
          step={tourFixture ? tourState.step : (route.step ?? 1)}
          phone={phone}
          arrivals={tourArrivals.count}
          onArrivals={() => endTour(tourRealStep ? 'finish' : 'exit', { page: 'inbox', project: null, thread: tourArrivals.thread })}
          onExit={() => endTour(tourRealStep ? 'finish' : 'exit')}
        />
      )}
      {!tourOn && route.page === 'inbox' && !route.reviews && (
        // The page's first stop (not beside the Reviews list, where the Inbox's list is not drawn) (approval "inbox-keyboard-keys-2026-11-07", item 6; WCAG 2.4.1): hidden until a Tab
        // reaches it, it passes the sidebar's stops and lands on the list as G I does, Single-key shortcuts on or off.
        <a
          href="#ib-list"
          className="ib-skip"
          data-skip-to-list=""
          onClick={(event) => {
            event.preventDefault();
            focusTheList();
          }}
        >
          Skip to the list
        </a>
      )}
      {/* A file beside the thread takes the sidebar's room (record 2.2): it closes on the same spring, and the person's choice stays as it was. */}
      <SidebarShell
        className="ib-shell"
        toggleNotice={sidebarToggleNotice}
        open={route.page === 'settings' ? settingsSidebar : sidebarOpen && !fileOpen && !sidebarHeld && !full}
        onOpenChange={(next) => {
          if (routeRef.current.page === 'settings') {
            setSettingsSidebar(next);
            return;
          }
          // ⌘B in full screen leaves it (the sidebar and the list come back) and keeps the person's stored choice. Not
          // while a file is open from it: closing the file comes back to the thread in full screen.
          if (next && full && !fileOpen) {
            leaveFull();
            return;
          }
          setSidebarHeld(false);
          changeSidebar(next);
        }}
        navigation={
          tourOn && !tourRealStep ? (
            <TourNavigation
              fixture={tourFixture}
              state={tourState}
              dispatch={dispatchTour}
              say={nudgeTour}
              onCompose={openTourComposeOrNudge}
              onSettings={() => endTour('exit', { page: 'settings', project: null, thread: null })}
            />
          ) : (
          <Sidebar
            page={route.page === 'tour' ? 'inbox' : fromCard ? 'board' : route.reviews ? 'reviews' : route.page}
            projectId={route.project}
            machineId={route.page === 'inbox' ? (filterMachine?.id ?? null) : null}
            agentFilter={filterAgent ? { id: filterAgent.id, name: filterAgent.name } : null}
            inboxCount={waitingCount(latestSections)}
            // One machine's list: that machine's projects only.
            projects={filterMachine ? projects.filter((p) => (p.machine ?? machines.self) === filterMachine.id) : projects}
            machines={machines}
            machineCounts={sidebarMachineCounts}
            onMachineUpdate={pageOffersUpdates(settings) ? (id) => setMachineUpdateOpen({ id, snooze: false }) : undefined}
            onMachine={(machineId) =>
              route.page === 'inbox' && route.project === null && route.machine === machineId
                ? void refreshInbox(null, route.thread !== null)
                : leave({ page: 'inbox', project: null, machine: machineId, thread: null })
            }
            // The Agents section (approval "inbox-agents-section"): an agent filters the list to its threads, as a
            // machine does (a second click shows everything again); Add agent is New message with a new session chosen
            // (plain New message where nothing can be started from here), and Add machine is Settings → Machines.
            agentRows={windowRows}
            // Picked: its list, as a machine's (no thread open). Cleared: everything, the thread on screen kept.
            onAgentFilter={(agentId) =>
              agentId
                ? leave({ page: 'inbox', project: null, machine: null, agent: agentId, thread: null })
                : leave({ page: 'inbox', project: null, machine: null, agent: null, thread: route.page === 'inbox' ? route.thread : null })
            }
            onMessageAgent={(session, opener) => openCompose({ session }, opener)}
            onAddAgent={(opener) => openCompose(plusOn ? { launch: { agent: composeLastAgent } } : {}, opener)}
            onAddMachine={machines.self && !guestPage ? () => leave({ page: 'settings', project: null, thread: null, section: 'machines' }) : undefined}
            projectNames={projectNames}
            projectCounts={projectCounts}
            projectActivity={latestProjectActivity}
            projectsReadable={projectsReadable}
            onProjectAction={(projectId, action) => void projectAction(projectId, action)}
            onProjectRename={renameProject}
            onProjectPicture={setProjectPicture}
            onProjectCombine={async (pair) => (await combineProjects([pair])) === null}
            // "+" on a project row (F1-F7): while agents can be started from New message, and not on a guest's page.
            onProjectNewSession={plusOn ? (projectId, machine) => openCompose({ start: { projectId, machine, agent: composeLastAgent } }) : undefined}
            // Hidden on a row that can't start anything: no agent on that machine, launch off there, or its folder gone.
            projectCanStart={(project, machine, machineLaunch) => projectCanStart(project, machine ? machineLaunchesKept().get(machine)?.launch : plusHere, machineLaunch)}
            announce={say}
            // Not on a tailnet guest's page: the update routes answer it 403 local_only.
            update={pageUpdate}
            restarting={restarting}
            // The quiet "What's new in X" link: this computer's pages and the owner's over the tailnet, not a guest's.
            updated={pageWhatsNew ? updated : null}
            onSearch={(opener) => openSearch(opener)}
            onCompose={(opener) => openCompose({}, opener)}
            pins={pinRows}
            openThreadId={route.thread}
            onOpenPin={(row) => (tourRealStep ? endTour('finish', { page: 'inbox', project: null, thread: row.thread_id }) : openPinned(row))}
            onPinAction={(row, action) => void pinAction(row, action)}
            draftsCount={(drafts?.length ?? 0) + replyDrafts.length}
            onDrafts={() => leave({ page: 'drafts', project: null, thread: null })}
            onArtifacts={() => leave({ page: 'artifacts', project: null, thread: null })}
            // The Board (approval "inbox-board"): a row only while the person has it on; no count (the header has it).
            onBoard={boardEnabled ? () => leave({ page: 'board', project: null, thread: null }) : undefined}
            // Reviews: a row only while Code review is on; its count is the last read's "On you" (read at start and on focus).
            onPulls={pullsShown ? () => leave({ page: 'reviews', project: null, thread: null }) : undefined}
            pullsCount={pullsShown && pulls.reviews ? reviewsOnYou(pulls.reviews) : 0}
            onShape={shapeOn && shapes.rowShown ? () => leave({ page: 'shapes', project: null, thread: null }) : undefined}
            shapeChanged={shapes.changed}
            // On the list it shows, Inbox (or a project) refreshes; with a thread open it closes it as before, and refreshes.
            onInbox={() => (route.page === 'inbox' && route.project === null && !route.machine && !route.agent ? void refreshInbox(null, route.thread !== null) : leave({ page: 'inbox', project: null, thread: null }))}
            onProject={(projectId) =>
              route.page === 'inbox' && route.project === projectId ? void refreshInbox(projectId, route.thread !== null) : leave({ page: 'inbox', project: projectId, machine: filterMachine?.id ?? null, thread: null })
            }
            refreshes={route.page === 'inbox' && route.thread === null}
            refreshSpin={refreshSpin}
            onSettings={() => leave({ page: 'settings', project: null, thread: null })}
            onUpdate={pressUpdate}
            onWhatsNew={(version) => (tourRealStep ? endTour('finish', { page: 'whats-new', project: null, thread: null, version }) : openWhatsNew(version))}
            // Not on a tailnet guest's page: Settings → Agents is closed to it.
            restartAgents={settings && !guestPage ? restartAgents : NO_RESTART_AGENTS}
            checkFailing={pageCheckFailing}
            onCheckFailing={() => leave({ page: 'settings', project: null, thread: null, section: 'about' })}
            onRestartSessions={() => leave({ page: 'settings', project: null, thread: null, section: 'agents' })}
            mcpCommand={settings?.mcp_command ?? null}
            onShortcuts={() => setMapOpen(true)}
            onFeedback={() => setFeedbackOpen(true)}
            onUsage={(row) => {
              setUsageRow(usageRow ? null : row);
              if (!usageRow) void readAccounts();
            }}
            usageOpen={usageRow !== null}
            usageInstalled={settings?.cswap === true}
            footHeld={settings === null && !settingsReadFailed && !settingsLate}
          />
          )
        }
      >
        <main className="ib-main" data-shape-open={shapeLayerId ? '' : undefined}>
          {main}
          {shapeLayerId && !reviewPaneOpen && (
            <ThreadShapeLayer
              host={shapeHost}
              id={shapeLayerId}
              thread={route.page === 'inbox' && thread && thread.thread_id === route.thread ? thread : null}
              shapes={shapes}
              threadShowMe={threadShowMe}
              onClose={() => close({ ...routeRef.current, shape: null })}
              onBoard={(id) => go({ ...routeRef.current, shape: id })}
              // Its review opens at the place a link names: the full-window review (ReviewPane), the board its corner card.
              onOpenReview={(messageId, at) => {
                setBoardLink(messageId);
                boardPlaces.leave(shapeLayerId);
                go({ ...routeRef.current, guide: messageId, guideAt: at });
              }}
              covered={!!guideMessage}
              onAddToReply={addShapeReply}
              place={boardPlaces.placeOf(shapeLayerId)}
              onNavigate={(place) => boardPlaces.moved(shapeLayerId, place)}
            />
          )}
          {!reviewPaneOpen && <ThreadShowMeBox threadShowMe={threadShowMe} />}
        </main>
      </SidebarShell>
      <UsagePeek
        anchor={usageRow}
        phone={phone}
        onClose={() => setUsageRow(null)}
        onSettings={() => {
          setUsageRow(null);
          leave({ page: 'settings', project: null, thread: null, section: 'accounts' });
        }}
      />
      {mapOpen && (
        <ShortcutMap
          onClose={() => setMapOpen(false)}
          onSettings={() => {
            setMapOpen(false);
            leave({ page: 'settings', project: null, thread: null, section: 'general' });
          }}
        />
      )}
      {machineUpdateOpen && (() => {
        const target = machines.linked.find((m) => m.id === machineUpdateOpen.id);
        return target ? (
          <MachineUpdateDialog
            machine={target}
            snooze={machineUpdateOpen.snooze}
            onClose={() => setMachineUpdateOpen(null)}
            onStartAgent={
              plusOn
                ? (machine) => {
                    // A new agent there, in a scratch folder, with the ask as its first message: the person sends it.
                    const request: ComposeRequest = { body: ASK_AGENT_TO_UPDATE, threadName: ASK_AGENT_TO_UPDATE_THREAD, start: { projectId: SCRATCH_PICK, machine, agent: composeLastAgent } };
                    machineAskCompose.current = { request, machine };
                    setMachineUpdateOpen(null);
                    openCompose(request);
                  }
                : undefined
            }
          />
        ) : null;
      })()}
      {readWarning && (
        <MarkReadWarning
          count={readWarning.count}
          bulk={readWarning.bulk}
          onAnswer={(answer) => {
            setReadWarning(null);
            readWarning.answer(answer);
          }}
        />
      )}
      {updateDialog === 'update' && update && (
        <UpdateDialog
          details={updateDetails}
          update={update}
          error={updateError}
          busy={updateBusy}
          onUpdateNow={() => void updateNow()}
          onRemindTomorrow={() => void remindTomorrow()}
          onCancel={() => setUpdateDialog(null)}
          onWhatsNew={() => openWhatsNew(update.version)}
          onAutoUpdate={(next) => void saveUpdateSwitches({ auto_update: next })}
        />
      )}
      {updateDialog === 'restart' && update && (
        <RestartDialog
          update={update}
          subject={unsentReply()?.subject ?? 'this thread'}
          onRestart={() => {
            setUpdateDialog(null);
            void restart();
          }}
          onCancel={() => setUpdateDialog(null)}
        />
      )}
      {updateDialog === 'failed' && update && (
        <FailedDialog
          update={update}
          details={updateDetails}
          home={settings?.home ?? null}
          onRetry={() => void updateNow()}
          onClose={() => setUpdateDialog(null)}
        />
      )}
      {listIntro === 'open' && (
        <ListLookIntro
          groups={listIntroGroups}
          initial={readListLook()}
          awayMachines={machines.away}
          projectNames={projectNames}
          phone={phone}
          onDone={(look) => {
            void writeListLookOptions(look);
            setListIntro('shown');
          }}
          onKeep={() => setListIntro('shown')}
          onCustomize={() => {
            setListIntro('shown');
            go({ page: 'settings', project: null, thread: null, section: 'rows' });
          }}
        />
      )}
      {snoozeIntro.stage === 'open' && <SnoozeIntro rows={snoozeIntroPicture} projectNames={projectNames} phone={phone} onTry={trySnoozeIntro} onClose={snoozeIntro.close} />}
      {boardReveal.stage === 'open' && (
        <BoardIntro
          mcpCommand={settings?.mcp_command ?? null}
          phone={phone}
          onClose={() => {
            // Not now (Escape, a click outside): the line's next dialog waits three days.
            void inboxApi.revealNotNow('board');
            boardReveal.close();
          }}
          onTurnOn={() => turnOnFromReveal('board', boardReveal.close)}
        />
      )}
      {codeReviewOffer.stage === 'open' && (
        <CodeReviewOffer
          phone={phone}
          onClose={() => {
            // Not now (Escape, a click outside): final, and the line's next offer waits three days.
            void inboxApi.revealNotNow('code_review');
            codeReviewOffer.close();
          }}
          onTurnOn={() => turnOnFromReveal('code_review', codeReviewOffer.close)}
        />
      )}
      {stepsReveal.stage === 'open' && (
        <ChecklistIntro
          phone={phone}
          onClose={() => {
            void inboxApi.revealNotNow('steps');
            stepsReveal.close();
          }}
          onTurnOn={() => turnOnFromReveal('steps', stepsReveal.close)}
        />
      )}
      {broReveal.stage === 'open' && (
        <BroIntro
          phone={phone}
          onClose={() => {
            // Not now (Escape, a click outside): the line's next dialog waits three days.
            void inboxApi.revealNotNow('bro');
            broReveal.close();
          }}
          onTurnOn={() => turnOnFromReveal('bro', broReveal.close)}
        />
      )}
      {grillMeTipReveal.stage === 'open' && (
        // Got it, Escape or a click outside: closed for good (the claim stamped it). Not a Not now: no three-day wait.
        <GrillMeTip phone={phone} onClose={grillMeTipReveal.close} />
      )}
      {starReveal.stage === 'open' && (
        <StarAskCard
          shape="corner"
          canStar={starReveal.canStar}
          onStar={() => inboxApi.starAskStar().then((answer) => answer.starred === true)}
          onAnswer={(answer) => void inboxApi.starAskAnswer(answer)}
          onLeave={starReveal.close}
        />
      )}
      {sidebarTip.stage === 'open' && <SidebarTipCard gone={!sidebarDocked || !listIntroClear || sidebarCustomizing} onSay={say} onLeave={sidebarTip.close} />}
      {listViewChoiceOpen && (
        <ListViewIntro
          groups={listViewChoiceGroups}
          flat={listViewChoiceFlat}
          look={readListLook()}
          awayMachines={machines.away}
          projectNames={projectNames}
          phone={phone}
          current={listView}
          onSmart={listViewReveal.close}
          onDismiss={() => {
            // Escape or a click outside: Not now for the line (the next dialog waits three days).
            void inboxApi.revealNotNow('list_view');
            listViewReveal.close();
          }}
          onSimple={() => {
            setListView('list');
            listViewReveal.close();
          }}
        />
      )}
      {tabIconChoice.stage === 'open' && (
        <TabIconChoice
          phone={phone}
          current={faviconInUse ?? 'glass'}
          title={document.title}
          onUse={(style) => {
            // Settings' own save (config.json `favicon`): plan review, code review and annotate show it at their next load.
            void chooseFavicon(style);
            tabIconChoice.close();
          }}
          // Escape or a click outside: the tab's own icon is back (the dialog put it back), nothing saved. Final.
          onDismiss={tabIconChoice.close}
        />
      )}
      {themeChooser.stage === 'open' && (
        <ThemeChooser
          inUse={{ light: themeNow.lightTheme, dark: themeNow.darkTheme, mode: themeNow.mode }}
          onPick={(pick) => {
            // Settings' own writes (theme.ts): applied at once, and config.json `theme` for plan review and code review.
            pickTheme(pick);
            themeChooser.close();
          }}
          onOwn={() => {
            themeChooser.close();
            openThemeSettings();
          }}
          // The close button, Escape or a click outside: nothing changes. Final (the claim stamped it).
          onDismiss={themeChooser.close}
        />
      )}
      {voiceIntro.stage === 'open' && (
        <VoiceIntro
          phone={phone}
          onTurnOn={(phonesOnly) => {
            voiceIntro.close();
            void inboxApi
              .saveVoice({ on: true, phones_only: phonesOnly })
              .then((saved) => adoptVoiceSettings(saved.voice))
              // The dialog never comes back: Settings is the way on from here.
              .catch(() =>
                showToast(
                  {
                    icon: 'warn',
                    lead: 'Voice isn’t on',
                    detail: 'The setting wasn’t saved. You can turn it on in Settings.',
                    action: {
                      label: 'Voice settings',
                      onPress: () => {
                        dismissToast();
                        window.location.hash = '#settings/voice';
                      },
                    },
                  },
                  8000,
                ),
              );
          }}
          onKeep={voiceIntro.close}
        />
      )}
      {soundDialog === 'open' && settings && (
        <SoundIntroDialog
          line={notificationLine(settings.notifications.enabled, notifications.permission)}
          playing={sound.playing}
          onPlay={() => sound.preview()}
          onTurnOnNotifications={() => void notifications.setEnabled(true)}
          onKeep={() => setSoundDialog('shown')}
          onTurnOff={() => {
            setSoundDialog('shown');
            void sound.setEnabled(false).then((saved) => showToast(saved ? { icon: 'mute', lead: 'Sound off' } : { icon: 'warn', lead: 'Sound setting not saved' }, 4200));
          }}
        />
      )}
      {/* System → Set up a project: B2's System button and B1's Set up call `openSystemSetup()` (system/opener.ts). */}
      <SystemSetupHost settings={settings} phone={phone} showToast={showToast} />
      {feedbackOpen && (
        <FeedbackDialog
          version={latest?.version ?? settings?.version ?? 'dev'}
          phone={phone}
          onSend={async (input) => {
            await inboxApi.sendFeedback(input);
          }}
          onCopyPrompt={(draft) => {
            // The copy starts inside the click (the clipboard needs it); the dialog closes so the toast is in view.
            const copied = copyTextToClipboard(feedbackPrompt(settings?.mcp_command ?? null, draft));
            setFeedbackOpen(false);
            void copied.then((ok) => showToast(feedbackCopiedToast(ok), ok ? 6000 : 4200));
          }}
          simpleListOn={listView === 'list'}
          hiddenAnswers={hiddenKnownAnswers(settings)}
          onAction={(kind) => {
            // A known answer or a Common question (feedbackKnown.ts): the real setting, with the dialog closed so its result is in view.
            setFeedbackOpen(false);
            if (kind === 'simple-list') setListView('list');
            else if (kind === 'settings-experimental') {
              go({ page: 'settings', project: null, thread: null, section: 'capabilities' });
              // Lands on the Experimental group, as `#settings/experimental` does (the address never carries it).
              setRoute((current) => (current.page === 'settings' ? { ...current, experimental: true } : current));
            } else go({ page: 'settings', project: null, thread: null, section: kind.slice('settings-'.length) as SettingsSection });
          }}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
      {typeof agentNote === 'object' && agents && (
        <AgentNoteDialog rows={agentNote.rows} noteText={agents.note_text} onModel={setAgents} onClosed={() => setAgentNote('shown')} />
      )}
      {tourIntroShown && (
        <div className="ib-tour-layer">
          <TourIntro
            onGo={() => {
              setTourIntro(false);
              setCoachFocus((n) => n + 1);
            }}
          />
        </div>
      )}
      {tourOn && tourFixture && tourTransport && tourState.compose === 'open' && (
        <ComposeDialog
          request={{ body: tourComposeBody(tourFixture) }}
          phone={phone}
          current={{ id: TOUR_PROJECT_ID, root: '', name: tourFixture.project }}
          lastSent={null}
          home={null}
          transport={tourTransport}
          onSent={(sent) => {
            dispatchTour({ type: 'composeSend' }, { focusCoach: true });
            showToast(
              {
                icon: 'check',
                lead: `Sent to ${hostLabel(sent.host)}`,
                detail: `in ${sent.projectName}`,
                speech: `Sent to ${hostLabel(sent.host)} in ${sent.projectName}. It takes it as its next turn.`,
                action: {
                  label: 'Open',
                  onPress: () => {
                    dismissToast();
                    dispatchTour({ type: 'open', thread: sent.threadId }, { focusCoach: true });
                  },
                },
              },
              7000,
            );
          }}
          onSaved={() => {}}
          onDeleted={() => {}}
          onClose={() => {
            dispatchTourRaw({ type: 'compose', open: false });
            const opener = tourComposeOpener.current;
            requestAnimationFrame(() => (opener?.isConnected ? opener.focus() : setCoachFocus((n) => n + 1)));
          }}
          aside={
            <>
              {/* Compose is a modal dialog: the page under it, the tour bar included, is inert. Its own copy keeps Exit in reach. */}
              <TourBar
                over
                step={tourState.step}
                phone={phone}
                arrivals={tourArrivals.count}
                onArrivals={() => endTour('exit', { page: 'inbox', project: null, thread: tourArrivals.thread })}
                onExit={() => endTour('exit')}
              />
              {tourCoachCard ? (
                <div className="ib-tour-layer ib-tour-in-dialog">
                  <TourCoach
                    fixture={tourFixture}
                    coach={tourCoachCard}
                    step={tourState.step}
                    canBack={false}
                    phone={phone}
                    reduced={reducedMotion}
                    focusTick={0}
                    onBack={() => {}}
                    onNext={() => dispatchTour({ type: 'next' }, { focusCoach: true })}
                    canForward={tourCanForward(tourState, tourCoachCard)}
                    onForward={forwardTour}
                    nudge={tourNudge}
                  />
                </div>
              ) : null}
            </>
          }
        />
      )}
      {tourCoachCard && !(tourOn && tourState.compose === 'open') && (
        <div className="ib-tour-layer">
          <TourCoach
            fixture={tourFixture}
            coach={tourCoachCard}
            step={tourState.step}
            canBack={tourCanBack(tourState)}
            phone={phone}
            reduced={reducedMotion}
            focusTick={coachFocus}
            onBack={() => dispatchTour({ type: 'back' }, { focusCoach: true })}
            onNext={() => dispatchTour({ type: 'next' }, { focusCoach: true })}
            canForward={tourCanForward(tourState, tourCoachCard)}
            onForward={forwardTour}
            nudge={tourNudge}
            onSkip={() => dispatchTour({ type: 'next' }, { focusCoach: true })}
            onSettings={() => endTour('finish', { page: 'settings', project: null, thread: null, section: 'general' })}
            settingsReady={settings !== null || settingsReadFailed}
          />
        </div>
      )}
      {floaters.layer}
      {ask.layer}
      {toast && !toast.hidden && soundDialog !== 'open' && !agentNoteOpen && <InboxToast toast={toast} phone={phone} onDismiss={dismissToast} onHold={holdToast} />}
      <SearchHost
        mounted={searchMounted}
        open={searchOpen}
        phone={phone}
        currentProject={route.page === 'inbox' ? route.project : null}
        projects={projects}
        onClose={closeSearch}
        onOpenResult={openSearchResult}
        actions={paletteActions}
        onAction={(action) => {
          // New review opens over Reviews: its list is the box's pull requests, and the thread it starts opens beside it.
          if (action.kind === 'review') writeRoute({ page: 'reviews', project: null, thread: null, stack: null, new: true });
          else openCompose(action.kind === 'message' ? { session: action.target.session } : {}, searchOpener.current);
        }}
        shapes={shapeOn ? searchShapes : undefined}
      />
      {compose && (
        <ComposeDialog
          request={compose}
          phone={phone}
          current={composeCurrent}
          lastSent={lastSent}
          home={settings?.home ?? null}
          board={boardEnabled === true}
          localWindow={!!settings && (settings.via ?? 'local') === 'local'}
          launched={composeLaunched}
          onHeld={composeHeld}
          reviewPulls={compose.review ? reviewPulls : undefined}
          reviewPullsRead={!pulls.reviews ? (pulls.error ? 'failed' : 'reading') : pulls.reviews.hosts.length > 0 && pulls.reviews.hosts.some((host) => host.error) ? 'failed' : 'read'}
          onOpenReviewThread={(id) => writeRoute({ page: 'inbox', reviews: reviewsScope(), project: null, thread: id })}
          launchTip={!tourOn && !launchTipSpent.current && launchTipDue(settings) ? launchTip : null}
          onJoined={composeJoined}
          onSent={(sent) => {
            rememberSent(sent.session);
            composeSent(sent);
            // Sent from an older machine's "Start an agent on <machine>": that machine's row says Asked, then Updated.
            const asked = machineAskCompose.current;
            if (asked && asked.request === compose && sent.machine === asked.machine) {
              machineAskCompose.current = null;
              void inboxApi.machineUpdateAsked(asked.machine, sent.threadId, hostLabel(sent.host)).catch(() => {});
            }
            // A New review opens beside the list, where it shows as Curating.
            if (compose.review) {
              writeRoute({ page: 'inbox', reviews: reviewsScope(), project: null, thread: sent.threadId });
              pulls.reloadRows();
            }
            // Create thread from a Board card: the new thread is linked to the card, so its Open thread goes there.
            if (sent.cardId) {
              void inboxApi
                .editCard(sent.cardId, { op: 'link', thread_id: sent.threadId })
                .then(() => refreshCards())
                .catch(() => showToast({ icon: 'warn', lead: 'Sent, but not linked to the card', phoneLead: 'Not linked to the card', detail: 'Open the thread from the Inbox.' }, 7000));
            }
            // Launch an agent from Pull requests: the new thread is the PRs' agent's, so verdicts and Reply go there.
            if (sent.pullKeys && sent.pullKeys.length > 0) {
              void inboxApi
                .pullOwner(sent.pullKeys, sent.threadId, sent.pullAsk ?? undefined)
                .then(() => pulls.reload())
                .catch(() => showToast({ icon: 'warn', lead: 'Sent, but not tied to the pull request', phoneLead: 'Not tied to the pull request', detail: 'Open the thread from the Inbox.' }, 7000));
            }
          }}
          onSaved={composeSaved}
          onDeleted={(draft) => {
            closeCompose(draftNeighbour(draft.id));
            void deleteDraft(draft, true);
          }}
          onClose={() => closeCompose()}
        />
      )}
      {decisionModeOn && decide && (
        <DecisionMode
          open={!decide.tucked}
          decisions={sittingDecisions}
          scope={decide.title}
          rows={latestRows}
          start={decide.start}
          startNonce={decide.startNonce}
          phone={phone}
          refresh={refreshDecisions}
          subscribeQuestions={subscribeQuestions}
          onLeft={setDecideLeft}
          onPaused={setDecidePaused}
          onTuck={(threadId, fileId, question) => {
            setDecide((current) => (current ? { ...current, tucked: true } : current));
            if (question && !fileId) {
              // A card's "Open the thread" (approval "inbox-decide-thread-only"): the dialog closes into its pill and
              // the thread (already behind it) lands on that question, its prompt focused. The same thread replaces
              // the entry, as a search result's landing does, so Back never stops on the same thread twice.
              decideLanding.current = { messageId: question.messageId, questionKey: question.key };
              searchLanding.current = null;
              const now = routeRef.current;
              const same = now.page === 'inbox' && now.thread === threadId && !now.file && !now.guide;
              writeRoute({ page: 'inbox', project: same ? now.project : null, thread: threadId, msg: question.messageId }, same ? { replace: true } : {});
              return;
            }
            writeRoute({ page: 'inbox', project: null, thread: threadId, file: fileId ? { id: fileId, version: 'current', focus: null } : null });
          }}
          onClose={closeDecide}
        />
      )}
      {decisionModeOn && decide?.tucked && <DecisionPill left={decideLeft} paused={decidePaused} thread={route.page === 'inbox' && route.thread === decide.thread ? null : decide.title} onResume={() => setDecide((current) => (current ? { ...current, tucked: false } : current))} />}
      <div className="ib-sr" aria-live="polite" data-inbox-live="">
        {said}
      </div>
      {guideMessage && thread && (
        // Every guide or review an agent sends opens the full-window review (approval "inbox-one-review-screen");
        // what Code review brings shows only while it is on.
        <ReviewPane
          key={guideMessage.id}
          thread={thread}
          message={guideMessage}
          guest={tailnetGuest(settings)}
          codeReview={codeReviewOn}
          shape={shapeOn}
          chapterDiagrams={chapterDiagramsOn}
          // From the route as it is now (a verdict lands after the person moved on): only while it still shows this review.
          onBack={() => {
            const now = routeRef.current;
            if (now.guide === guideMessage.id) close({ ...now, guide: null, shape: null });
          }}
          onClose={() => close({ ...route, thread: null, guide: null, shape: null })}
          onSent={afterWrite}
          onPosted={pullsReloadRows}
          onAsk={ask.askWith}
          // No verdict: back to the thread, its reply box open (the comments ride its Send).
          onWriteReply={() => {
            const now = routeRef.current;
            if (now.guide === guideMessage.id) close({ ...now, guide: null, shape: null });
            setReplyFor(thread.thread_id);
          }}
          shapeHost={shapeHost}
          shapes={shapes}
          board={shapeLayerId}
          onBoard={(id) => {
            const now = routeRef.current;
            if (now.guide !== guideMessage.id) return;
            if (id) go({ ...now, shape: id });
            else close({ ...now, shape: null });
          }}
          boardShrunk={boardLink === guideMessage.id}
          boardPlace={shapeLayerId ? boardPlaces.placeOf(shapeLayerId) : null}
          onBoardNavigate={(place) => {
            if (shapeLayerId) boardPlaces.moved(shapeLayerId, place);
          }}
          at={route.guideAt ?? null}
          onLanded={landGuide}
          onSay={say}
        />
      )}
    </div>
    </SideButtonContext.Provider>
    </InitiativeTagsContext.Provider>
  );
}

export function InboxApp() {
  return (
    <ThemeProvider defaultTheme="system">
      <WarmCodeHighlight />
      <WarmWindowParts />
      {/* Every tooltip in the window (Tip): 150 ms to open, and the next one at once within 400 ms. */}
      <TooltipProvider delayDuration={TIP_DELAY_MS} skipDelayDuration={TOOLTIP_SKIP_DELAY_MS} disableHoverableContent>
        <AccountsProvider>
          <Inbox />
        </AccountsProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

/** The sidebar's Reviews count: the rows on the person in the last read. */
function reviewsOnYou(answer: import('@plannotator/core/inbox-types').InboxReviewsAnswer): number {
  return answer.rows.filter((row) => row.move === 'on_you').length;
}
