/**
 * Bridge script injected into the HTML viewer iframe.
 *
 * Handles text selection, annotation marks, theme updates, and resize
 * notifications. Communicates with the parent via postMessage using a
 * "plannotator-bridge-*" message protocol.
 *
 * This is a string constant — it gets prepended to the iframe's srcdoc.
 * No external dependencies.
 */

/**
 * Reads only viewer-namespaced \`--pn-*\` variables (with fallbacks): arbitrary
 * documents may define bare token names like \`--accent\` for themselves, and the
 * viewer must never depend on — or collide with — the author's namespace.
 */
export const ANNOTATION_HIGHLIGHT_CSS = `
/* Committed annotation visuals (highlight rectangles + numbered placed
 * markers) render inside a shadow-rooted fixed overlay host — see OVERLAY_CSS
 * in the bridge script. Nothing annotation-related is ever wrapped into or
 * styled onto the author's own elements. */
/* Vim pinpoint target tint. The MOUSE pinpoint path no longer mutates author
 * elements — it draws the dedicated overlay box below — but keyboard (vim)
 * navigation keeps this class-based visual. */
.plannotator-pinpoint-hover {
  background-color: oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.12) !important;
  border-radius: 3px;
  cursor: pointer !important;
}
/* SVG groups can't render a CSS background, so use a soft glow instead. */
.plannotator-pinpoint-hover:is(g, svg) {
  filter: drop-shadow(0 0 4px oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.55));
}
/* Mouse pinpoint hover: a fixed-position outline box sized to the hovered
 * element's rect. Never a class/style write on the page's own elements. */
[data-plannotator-pinpoint-box] {
  position: fixed;
  z-index: 2147483643;
  pointer-events: none;
  display: none;
  box-sizing: border-box;
  border: 2px solid oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.85);
  border-radius: 5px;
  background: oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.06);
}
[data-plannotator-pinpoint-box].pn-pin-enter {
  animation: pn-pinpoint-in 0.12s ease-out;
}
[data-plannotator-pinpoint-box][data-pinned] {
  border-color: var(--pn-accent, #d97757);
  background: oklch(from var(--pn-accent, #d97757) l c h / 0.08);
}
@keyframes pn-pinpoint-in {
  from { opacity: 0; transform: scale(0.985); }
  to { opacity: 1; transform: scale(1); }
}
/* Pinpoint mode affordance: crosshair everywhere. Placed markers live in the
 * shadow overlay and keep their own pointer cursor there. */
body[data-plannotator-pinpoint-cursor],
body[data-plannotator-pinpoint-cursor] * {
  cursor: crosshair !important;
}
@media (prefers-reduced-motion: reduce) {
  [data-plannotator-pinpoint-box].pn-pin-enter {
    animation: none;
  }
}
@media print {
  /* Viewer overlays are review chrome, not page content: never bake pinpoint
     boxes/labels or vim UI into a printed page. The outer app chrome is
     print-hidden by print.css, but this CSS lives inside the iframe's own
     document and must carry its own rule. The annotation overlay host carries
     its own print rule inside its shadow root. */
  [data-plannotator-pinpoint-box],
  [data-plannotator-pinpoint-label],
  [data-plannotator-vim-ui],
  [data-plannotator-vim-cursor] {
    display: none !important;
  }
}
/* Print-parity layer: committed highlight rects re-projected into an
 * absolute-positioned light-DOM layer built on beforeprint and torn down on
 * afterprint (the fixed overlay cannot paginate). Guarded here so it can
 * never flash on screen even if an afterprint teardown is missed. */
@media screen {
  [data-plannotator-print-layer] {
    display: none !important;
  }
}
body[data-plannotator-vim-focus-owner]:focus {
  outline: none !important;
}
[data-plannotator-vim-cursor] {
  position: fixed;
  z-index: 2147483646;
  width: 2px;
  min-height: 1em;
  border-radius: 2px;
  background: var(--pn-focus-highlight, #4493f8);
  pointer-events: none;
}
[data-plannotator-vim-reticle] {
  position: fixed;
  z-index: 2147483645;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}
[data-plannotator-vim-reticle] [data-vim-reticle-fill],
[data-plannotator-vim-reticle] [data-vim-reticle-corner],
[data-plannotator-vim-reticle] [data-vim-reticle-label] {
  position: absolute;
  top: 0;
  left: 0;
  will-change: transform;
  transition: transform 90ms cubic-bezier(.22,1,.36,1);
}
[data-plannotator-vim-reticle] [data-vim-reticle-fill] {
  width: 100px;
  height: 100px;
  transform-origin: 0 0;
  border-radius: 8px;
  background: rgba(167,139,250,.045);
  box-shadow:
    inset 0 0 0 1px rgba(196,181,253,.16),
    0 0 42px rgba(139,92,246,.12);
}
[data-plannotator-vim-reticle] [data-vim-reticle-corner] {
  width: 28px;
  height: 28px;
  border-color: #c4b5fd;
  filter:
    drop-shadow(0 0 6px rgba(167,139,250,.92))
    drop-shadow(0 0 18px rgba(124,58,237,.42));
}
[data-plannotator-vim-reticle] [data-vim-reticle-corner="top-left"] {
  border-top: 3px solid;
  border-left: 3px solid;
  border-top-left-radius: 8px;
}
[data-plannotator-vim-reticle] [data-vim-reticle-corner="top-right"] {
  border-top: 3px solid;
  border-right: 3px solid;
  border-top-right-radius: 8px;
}
[data-plannotator-vim-reticle] [data-vim-reticle-corner="bottom-left"] {
  border-bottom: 3px solid;
  border-left: 3px solid;
  border-bottom-left-radius: 8px;
}
[data-plannotator-vim-reticle] [data-vim-reticle-corner="bottom-right"] {
  border-right: 3px solid;
  border-bottom: 3px solid;
  border-bottom-right-radius: 8px;
}
[data-plannotator-vim-reticle] [data-vim-reticle-label] {
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 118px;
  height: 30px;
  max-width: min(280px, calc(100vw - 24px));
  padding: 0 11px;
  overflow: hidden;
  border: 1px solid rgba(216,206,255,.42);
  border-radius: 9px;
  color: #f6f2ff;
  background: rgba(18,14,28,.84);
  box-shadow:
    0 10px 28px rgba(0,0,0,.42),
    0 0 20px rgba(139,92,246,.18);
  backdrop-filter: blur(10px);
  font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .13em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-plannotator-vim-reticle] [data-vim-reticle-label]::before {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: #c4b5fd;
  box-shadow: 0 0 12px rgba(167,139,250,.94);
  content: "";
}
@media (prefers-reduced-motion: reduce) {
  [data-plannotator-vim-reticle] [data-vim-reticle-fill],
  [data-plannotator-vim-reticle] [data-vim-reticle-corner],
  [data-plannotator-vim-reticle] [data-vim-reticle-label] {
    transition: none;
  }
}
[data-plannotator-vim-badge] {
  position: fixed;
  z-index: 2147483647;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  padding: 4px 9px;
  border: 1px solid color-mix(in srgb, var(--pn-focus-highlight, #4493f8) 35%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--pn-background, #111) 94%, transparent);
  color: var(--pn-focus-highlight, #4493f8);
  box-shadow: 0 4px 18px rgba(0,0,0,.25);
  font: 700 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .04em;
  pointer-events: none;
}
`;

export const BRIDGE_SCRIPT = `(function() {
  var PREFIX = 'plannotator-bridge-';

  // --- Theme ---
  // The author owns this document. Unless it opted in to host theming
  // (hostTheme), only viewer-namespaced --pn-* properties may be written to its
  // root, and its class list is never touched.
  window.addEventListener('message', function(e) {
    if (e.source !== parent) return;
    if (!e.data) return;
    if (e.data.type === PREFIX + 'set-vim-help') {
      vimHelpOpen = !!e.data.open;
      parent.postMessage({
        type: PREFIX + 'vim-help',
        open: vimHelpOpen
      }, '*');
      return;
    }
    if (e.data.type !== PREFIX + 'theme') return;
    var root = document.documentElement;
    var tokens = e.data.tokens || {};
    var hostTheme = !!e.data.hostTheme;
    for (var key in tokens) {
      if (!tokens.hasOwnProperty(key)) continue;
      if (!hostTheme && key.indexOf('--pn-') !== 0) continue;
      root.style.setProperty(key, tokens[key]);
    }
    if (hostTheme) {
      root.classList.remove('light');
      if (e.data.isLight) root.classList.add('light');
    }
  });

  // --- Resize ---
  var lastHeight = 0;
  function postResize() {
    if (!document.body) return;
    var h = document.body.scrollHeight;
    if (h !== lastHeight) {
      lastHeight = h;
      parent.postMessage({ type: PREFIX + 'resize', height: h }, '*');
    }
  }
  window.addEventListener('load', postResize);

  // --- Selection ---
  var pendingSelection = null;
  var pendingRange = null; // live range for the pending selection (scroll tracking)
  var pendingPinEl = null; // element pinned by a pinpoint click (outline + scroll tracking)
  var pendingPinAnchor = null; // serialized anchor for the pending pin
  var pendingPinKey = null; // target key for the primary pinpoint target (multi-select)
  var pendingPinLabel = null; // semantic label captured for the primary target
  var pendingPinPoint = null; // normalized {x,y} click point inside the pinned element's rect
  var pendingPinViaPinpoint = false; // pinpoint drafts survive scroll-out (see postSelectionRect)
  // Multi-select is ARMED EXPLICITLY by the parent (arm-multi-select), and only
  // when the comment composer owns the draft. The bridge must never accept a
  // shift-toggle the parent would not mirror (e.g. quickLabel-mode drafts):
  // what the user sees pinned and what the annotation saves must never diverge.
  var multiSelectArmed = false;
  // Shift-click multi-select: additional elements joined to the SAME draft
  // comment while the composer is open. Each entry owns a pinned outline box.
  var pendingMultiTargets = []; // { key, el, anchor, label, text, box }
  var multiTargetSeq = 0;
  var MAX_MULTI_TARGETS = 16;
  var currentInputMethod = 'drag'; // 'drag' = text selection, 'pinpoint' = click an element
  var pinpointHover = null;
  var vimEnabled = false;
  var vimHudEnabled = false;
  var vimPhase = 'inactive';
  var vimActiveMode = 'selection';
  var vimPinpointEl = null;
  var vimVisualBlockAnchorEl = null;
  var vimPendingG = false;
  var vimPendingGTimer = 0;
  var vimHelpOpen = false;
  var vimAddedBodyTabIndex = false;
  var vimActionReturn = null;
  var vimLastActionId = null;
  var vimLastActionContext = 'inactive';
  var vimLastPostedPhase = null;
  // A plain click on an element-annotation target opens the toolbar, but the same
  // click's mouseup schedules a handleSelection() that would see an empty selection
  // and immediately clear it. This flag suppresses that one trailing clear.
  var skipNextClear = false;

  document.addEventListener('mouseup', function(e) {
    if (currentInputMethod === 'pinpoint') return; // pinpoint uses click, not drag-select
    setTimeout(handleSelection, 10);
  });

  // The page fully controls element text, so everything posted as a selection
  // is bounded here before it crosses the bridge (the parent enforces the same
  // cap on its side of the trust boundary). One pinpoint click on a huge
  // <pre>/<table> must not ship megabytes into drafts, feedback, or share URLs.
  var MAX_SELECTION_TEXT = 10000;

  function capSelectionText(text) {
    if (text.length <= MAX_SELECTION_TEXT) return text;
    var cut = MAX_SELECTION_TEXT;
    var last = text.charCodeAt(cut - 1);
    // Never split a surrogate pair: a lone high surrogate at the cut point
    // becomes U+FFFD the moment the string is UTF-8 encoded downstream.
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    return text.slice(0, cut);
  }

  function handleSelection(modeOverride, extras) {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      // Trailing clear from a plain-click element annotation — consume it once.
      if (skipNextClear) { skipNextClear = false; return; }
      if (pendingSelection) {
        parent.postMessage({ type: PREFIX + 'selection-clear' }, '*');
        pendingSelection = null;
        pendingRange = null;
        clearMultiTargets();
        clearPendingPin();
        renderAnnotationOverlay();
      }
      return false;
    }
    skipNextClear = false; // a real text selection happened
    var range = sel.getRangeAt(0);
    var text = capSelectionText(sel.toString().trim());
    if (!text) return false;

    // A draft now owns the surface: kill the click-to-select hover
    // affordance, including any hit test already scheduled.
    clearHoverHighlight();

    var rect = range.getBoundingClientRect();
    pendingRange = range;
    pendingSelection = {
      text: text,
      startContainerPath: getNodePath(range.startContainer),
      startOffset: range.startOffset,
      endContainerPath: getNodePath(range.endContainer),
      endOffset: range.endOffset
    };

    parent.postMessage({
      type: PREFIX + 'selection',
      text: text,
      modeOverride: modeOverride || undefined,
      anchor: (extras && extras.anchor) || undefined,
      pinpoint: (extras && extras.pinpoint) || undefined,
      targetKey: (extras && extras.targetKey) || undefined,
      targetLabel: (extras && extras.targetLabel) || undefined,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    }, '*');
    renderAnnotationOverlay(); // draft selection highlight (overlay-projected)
    return true;
  }

  // Keep the toolbar/popover attached while the iframe content scrolls: re-post the
  // pending selection's live rect (parent has no way to see an in-iframe scroll).
  // Capture phase so inner scroll containers count too.
  var scrollRaf = 0;
  function postSelectionRect() {
    scrollRaf = 0;
    if (!pendingSelection) return;
    // Element pins carry no live range — track the pinned element's box instead.
    var tracked = pendingRange || (pendingPinEl && pendingPinEl.isConnected ? pendingPinEl : null);
    if (!tracked) return;
    var r = tracked.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      // Pinpoint drafts survive scrolling: the user is expected to roam the
      // page (especially to shift-click distant elements into the draft), so
      // the pinned primary leaving the viewport must not tear the draft down.
      // Drag selections keep the existing close-on-scroll-out behavior.
      if (pendingPinViaPinpoint || pendingMultiTargets.length > 0) return;
      // Selection scrolled out of view — close the toolbar (matches markdown).
      parent.postMessage({ type: PREFIX + 'selection-clear' }, '*');
      pendingSelection = null;
      pendingRange = null;
      clearPendingPin();
      renderAnnotationOverlay();
      return;
    }
    parent.postMessage({
      type: PREFIX + 'selection-rect',
      rect: { top: r.top, left: r.left, width: r.width, height: r.height }
    }, '*');
  }
  window.addEventListener('scroll', function() {
    if (!pendingSelection) return;
    if (!scrollRaf) scrollRaf = requestAnimationFrame(postSelectionRect);
  }, true);

  // --- Mark Creation ---
  window.addEventListener('message', function(e) {
    if (e.source !== parent) return;
    if (!e.data || !e.data.type) return;
    var type = e.data.type;

    if (type === PREFIX + 'create-mark') {
      var id = e.data.id;
      var annType = e.data.annotationType || 'comment';
      if (pendingSelection) {
        var record = null;
        // Text selections register a live range (overlay highlight); element
        // pinpoints (e.g. SVG nodes) carry no range and register the pinned
        // element with the user's selected point. The page DOM is untouched.
        if (pendingSelection.startContainerPath) {
          var committedRange = buildPendingRange(pendingSelection);
          if (pendingPinEl) {
            record = ensureAnnRecord(id, annType, {
              originalText: pendingSelection.text || '',
              anchor: pendingPinAnchor,
              additionalAnchors: null
            });
            addElementTarget(record, pendingPinEl, pendingPinAnchor, pendingPinPoint);
            if (committedRange) addRangeTarget(record, committedRange, pendingSelection.text || '', true);
          } else if (committedRange) {
            record = ensureAnnRecord(id, annType, {
              originalText: pendingSelection.text || '',
              anchor: null,
              additionalAnchors: null
            });
            addRangeTarget(record, committedRange, pendingSelection.text || '', false);
          }
          if (
            vimActionReturn
            && (vimActionReturn.phase === 'visual' || vimActionReturn.phase === 'visual-block')
          ) {
            vimActionReturn.range = committedRangeClone(id) || vimActionReturn.range;
          }
        } else if (pendingPinEl) {
          record = ensureAnnRecord(id, annType, {
            originalText: '',
            anchor: pendingPinAnchor,
            additionalAnchors: null
          });
          addElementTarget(record, pendingPinEl, pendingPinAnchor, pendingPinPoint);
        }
        // Every additional multi-select target registers under the SAME
        // annotation id — all of its markers share one comment number.
        if (pendingMultiTargets.length) {
          if (!record) {
            record = ensureAnnRecord(id, annType, {
              originalText: '',
              anchor: pendingPinAnchor,
              additionalAnchors: null
            });
          }
          var extraAnchorList = [];
          for (var mtIndex = 0; mtIndex < pendingMultiTargets.length; mtIndex++) {
            var mt = pendingMultiTargets[mtIndex];
            addElementTarget(record, mt.el, mt.anchor, mt.point);
            if (mt.anchor) extraAnchorList.push(mt.anchor);
          }
          if (record.params) {
            record.params.additionalAnchors = extraAnchorList.length ? extraAnchorList : null;
          }
        }
        pendingSelection = null;
        pendingRange = null;
        window.getSelection().removeAllRanges();
      }
      clearMultiTargets();
      clearPendingPin();
      restoreVimSemanticTarget();
      renderAnnotationOverlay();
    }

    else if (type === PREFIX + 'find-and-mark') {
      var found = restoreAnnotation(
        e.data.id,
        e.data.annotationType || 'comment',
        typeof e.data.originalText === 'string' ? e.data.originalText : '',
        e.data.anchor,
        e.data.additionalAnchors
      );
      parent.postMessage({
        type: PREFIX + 'mark-applied',
        id: e.data.id,
        success: found
      }, '*');
    }

    else if (type === PREFIX + 'remove-mark') {
      removeAnnRecord(e.data.id);
      renderAnnotationOverlay();
    }

    else if (type === PREFIX + 'clear-marks') {
      annRecords = [];
      annNumbers = null; // stale synced numbers must not leak onto future records
      focusedAnnotationId = null;
      restoreFailedIds.clear();
      renderAnnotationOverlay();
    }

    else if (type === PREFIX + 'sync-annotations') {
      // Parent-authoritative numbering: the ordered saved-annotation list
      // (index + 1 in the panel's collection). Bounded and shape-checked —
      // malformed entries are skipped, a malformed list is ignored outright.
      var syncList = e.data.annotations;
      if (syncList && typeof syncList.length === 'number') {
        var nextNumbers = new Map();
        var syncCount = Math.min(syncList.length, MAX_SYNC_ANNOTATIONS);
        for (var syncIndex = 0; syncIndex < syncCount; syncIndex++) {
          var syncEntry = syncList[syncIndex];
          if (!syncEntry || typeof syncEntry.id !== 'string' || !syncEntry.id || syncEntry.id.length > 256) continue;
          var syncNumber = syncEntry.number;
          if (
            typeof syncNumber !== 'number'
            || !isFinite(syncNumber)
            || syncNumber < 1
            || syncNumber > 100000
            || Math.floor(syncNumber) !== syncNumber
          ) continue;
          nextNumbers.set(syncEntry.id, syncNumber);
        }
        annNumbers = nextNumbers;
        renderAnnotationOverlay();
      }
    }

    else if (type === PREFIX + 'cancel-selection') {
      pendingSelection = null;
      pendingRange = null;
      skipNextClear = false;
      clearMultiTargets();
      clearPendingPin();
      window.getSelection().removeAllRanges();
      restoreVimSemanticTarget();
      renderAnnotationOverlay();
    }

    else if (type === PREFIX + 'arm-multi-select') {
      // Parent arms shift-multi-select for the draft it is mirroring in the
      // comment composer. The key must name the CURRENT primary so a stale
      // arm from a previous draft can never arm a new one.
      if (
        pendingPinEl
        && pendingPinViaPinpoint
        && typeof e.data.key === 'string'
        && e.data.key === pendingPinKey
      ) {
        multiSelectArmed = true;
      }
    }

    else if (type === PREFIX + 'remove-target') {
      // Parent-initiated removal (chip X button), or the parent's echo of a
      // bridge-side removal. Idempotent: an already-removed key is a no-op,
      // which also resyncs the two sides after a forged removal message.
      removeMultiTargetByKey(typeof e.data.key === 'string' ? e.data.key : '', false);
    }

    else if (type === PREFIX + 'flash-target') {
      flashMultiTarget(typeof e.data.key === 'string' ? e.data.key : '');
    }

    else if (type === PREFIX + 'scroll-to') {
      // Selecting an annotation scrolls its first resolved target into view
      // and flashes the overlay focus highlight over EVERY rect of EVERY
      // target — never a class write on page elements, and never only the
      // first fragment of a multi-paragraph selection.
      scrollToAnnotation(e.data.id);
    }

    else if (type === PREFIX + 'focus-mark') {
      focusAnnotationRecord(typeof e.data.id === 'string' ? e.data.id : null, false);
    }

    else if (type === PREFIX + 'set-input-method') {
      currentInputMethod = e.data.method === 'pinpoint' ? 'pinpoint' : 'drag';
      if (currentInputMethod === 'pinpoint') {
        clearHoverHighlight(); // pinpoint owns clicks; drop the select affordance (and any pending hit test)
        if (document.body) document.body.setAttribute('data-plannotator-pinpoint-cursor', '');
      } else {
        if (document.body) document.body.removeAttribute('data-plannotator-pinpoint-cursor');
        clearPinpointHover();
      }
      if (vimEnabled) updateVimUi();
    }

    else if (type === PREFIX + 'set-vim-mode') {
      var wasVimEnabled = vimEnabled;
      var wasVimHudEnabled = vimHudEnabled;
      vimEnabled = e.data.enabled === true;
      vimHudEnabled = e.data.hudEnabled === true;
      if (wasVimHudEnabled !== vimHudEnabled) vimLastPostedPhase = null;
      vimActiveMode = e.data.mode === 'comment'
        || e.data.mode === 'redline'
        || e.data.mode === 'quickLabel'
        ? e.data.mode
        : 'selection';
      if (!vimEnabled) {
        clearVimUi();
        vimPinpointEl = null;
        vimPhase = 'inactive';
      } else if (!wasVimEnabled) {
        prepareVimFocusOwner();
        vimPhase = 'inactive';
        updateVimUi();
      } else {
        updateVimUi();
      }
    }

    else if (type === PREFIX + 'focus-vim') {
      if (vimEnabled) {
        ensureVimFocus();
        if (vimPhase === 'inactive') resetVimSemanticNavigation();
        updateVimUi();
      }
    }
  });

  // --- Pinpoint: hover to outline the element under the cursor, click to pin ---
  // Hover is pure per-event hit-testing: deep elementFromPoint (piercing open
  // shadow roots) picks the REAL element under the pointer — no tag whitelist,
  // no has-text requirement — so styled div/span prototypes (chips, icon
  // buttons, cards) are individually targetable. Scope control is mouse-only
  // and geometric, matching the markdown pinpoint feel: the deepest element
  // directly under the pointer wins, and pointing at a container's padding or
  // any area not covered by a child selects the container. Elements under
  // 16px on both axes promote to the nearest ancestor at least 16px on one
  // axis (agentation's MIN_CAPTURE_SIZE pattern). The click reuses the normal
  // selection pipeline — select the element's text and run handleSelection()
  // like a drag — the hover visual is a dedicated fixed-position outline box
  // (never a class write on the page's own elements), the click serializes a
  // CSS anchor for later restoration, and element-only pins (SVG, icon
  // buttons) get a numbered badge. The semantic target graph below survives
  // as the vim-navigation vocabulary only; the pointer path never builds it.
  var PINPOINT_SKIP_SELECTOR = 'script,style,noscript,[data-plannotator-vim-ui]';

  // Identity set of every overlay node the viewer creates inside the page
  // (pin badges, pinpoint box/label, vim UI). Hit-testing excludes overlay
  // nodes by IDENTITY, never by selector match, so page markup carrying our
  // attribute names cannot spoof its way out of (or into) targeting.
  var overlayNodes = new Set();

  // Floor for hover targets (not a whitelist): a decorative dot or hairline
  // under 16px on BOTH axes promotes to the nearest ancestor that is at least
  // 16px on one axis, so tiny leaves stay clickable without precision-mousing.
  var MIN_CAPTURE_SIZE = 16;

  // Headless DOM test environments lay nothing out (every rect is 0x0); size
  // rules only apply when the body actually has a laid-out box.
  function layoutActive() {
    return !!document.body && document.body.getBoundingClientRect().width > 0;
  }

  function deepElementFromPoint(x, y) {
    var el = typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(x, y)
      : null;
    var guard = 0;
    while (
      el
      && el.shadowRoot
      && typeof el.shadowRoot.elementFromPoint === 'function'
      && guard++ < 24
    ) {
      var inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function isViewerOverlayNode(node) {
    var current = node;
    var guard = 0;
    while (current && guard++ < 200) {
      if (overlayNodes.has(current)) return true;
      current = current.parentElement
        || (current.getRootNode && current.getRootNode().host)
        || null;
    }
    return false;
  }

  function promoteTinyTarget(el) {
    if (!layoutActive()) return el;
    var r = el.getBoundingClientRect();
    if (r.width >= MIN_CAPTURE_SIZE || r.height >= MIN_CAPTURE_SIZE) return el;
    var current = el.parentElement;
    while (current && current !== document.body && current !== document.documentElement) {
      var cr = current.getBoundingClientRect();
      if (cr.width >= MIN_CAPTURE_SIZE || cr.height >= MIN_CAPTURE_SIZE) return current;
      current = current.parentElement;
    }
    return el;
  }

  // The placed-marker button the most recent raw (pre-yield) probe landed
  // on, if any. Hover uses it to advertise the MARKER's identity instead of
  // the page element beneath it — the marker owns the click, so the hover
  // label must never promise an annotate action the click won't perform.
  var lastRawHitMarker = null;

  function committedMarkerButtonFrom(node) {
    var current = node;
    var guard = 0;
    while (current && guard++ < 24) {
      if (
        current.nodeType === 1
        && overlayNodes.has(current)
        && current.hasAttribute
        && current.hasAttribute('data-plannotator-marker')
      ) return current;
      current = current.parentElement
        || (current.getRootNode && current.getRootNode().host)
        || null;
    }
    return null;
  }

  // Resolve the pinpoint target at a viewport point. The deepest rendered
  // element under the pointer wins; containers are selected by pointing at
  // their uncovered area (padding, gaps), exactly like the markdown surface.
  // fallbackNode covers engines without a real elementFromPoint (headless DOM
  // tests) and the scroll reconcile, which re-resolves under a still cursor.
  function resolvePinpointTargetAt(x, y, fallbackNode) {
    lastRawHitMarker = null;
    var node = deepElementFromPoint(x, y);
    if (node && isViewerOverlayNode(node)) {
      lastRawHitMarker = committedMarkerButtonFrom(node);
      // A placed marker owns its clicks, but hit-testing for a NEW selection
      // must reach the page beneath it: temporarily yield marker hit targets
      // and probe again (identity-gated, never selector-gated).
      node = withMarkersYielded(function() { return deepElementFromPoint(x, y); });
    }
    if (!node || node === document.documentElement || node === document.body) {
      node = fallbackNode || null;
    }
    while (node && node.nodeType === 3) node = node.parentNode;
    if (!node || node.nodeType !== 1) return null;
    if (node === document.documentElement || node === document.body) return null;
    if (isViewerOverlayNode(node)) return null;
    if (node.closest && node.closest('script,style,noscript')) return null;
    // SVG shape primitives promote to their nearest group: a <g> is the
    // authored unit of an SVG diagram, and its <path> fragments are not
    // individually meaningful annotation targets.
    if (node.ownerSVGElement && node.closest) {
      var svgGroup = node.closest('g');
      if (svgGroup) node = svgGroup;
    }
    node = promoteTinyTarget(node);
    if (node === document.body || node === document.documentElement) return null;
    return node;
  }

  // Last-position reuse: a pointer that moved under 2px within 16ms resolves
  // to the cached element instead of re-hit-testing. The scroll reconcile
  // invalidates this cache — same point, different element after a scroll.
  var lastPointerHit = null;
  function pinpointLeafAt(x, y, fallbackNode) {
    var now = typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
    if (
      lastPointerHit
      && Math.abs(x - lastPointerHit.x) <= 2
      && Math.abs(y - lastPointerHit.y) <= 2
      && now - lastPointerHit.t <= 16
      && (!lastPointerHit.el || lastPointerHit.el.isConnected)
    ) {
      lastRawHitMarker = lastPointerHit.marker || null;
      return lastPointerHit.el;
    }
    var el = resolvePinpointTargetAt(x, y, fallbackNode);
    lastPointerHit = { x: x, y: y, t: now, el: el, marker: lastRawHitMarker };
    return el;
  }
  function invalidatePointerHitCache() {
    lastPointerHit = null;
  }
  var SEMANTIC_BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,figcaption,table,button,[data-annotate],svg g';
  var SEMANTIC_GROUP_SELECTOR = 'section,article,aside,nav,header,footer,ul,ol,figure,main';
  var SEMANTIC_INLINE_SELECTOR = 'a,em,strong,b,i,code,small,label,mark,sup,sub,u,abbr,time';
  var semanticTargetKeys = new WeakMap();
  var semanticTargetKeyCounter = 0;

  function semanticTargetKey(el) {
    var existing = semanticTargetKeys.get(el);
    if (existing) return existing;
    semanticTargetKeyCounter += 1;
    var key = 'html-target-' + semanticTargetKeyCounter;
    semanticTargetKeys.set(el, key);
    return key;
  }

  function semanticLabel(el) {
    return PINPOINT_LABELS[el.tagName] || el.tagName.toLowerCase();
  }

  function buildSemanticTargetGraph() {
    var targets = [];
    var blocks = [];
    var byElement = new Map();

    function add(el, kind, parent) {
      if (!el || byElement.has(el) || el.closest(PINPOINT_SKIP_SELECTOR)) return null;
      if (!el.textContent || !el.textContent.trim()) return null;
      var target = {
        key: semanticTargetKey(el),
        element: el,
        kind: kind,
        parentKey: parent ? parent.key : null,
        label: semanticLabel(el)
      };
      targets.push(target);
      byElement.set(el, target);
      return target;
    }

    function addInlineDescendants(root, parent) {
      var inlineElements = Array.prototype.slice.call(root.querySelectorAll(SEMANTIC_INLINE_SELECTOR));
      for (var inlineIndex = 0; inlineIndex < inlineElements.length; inlineIndex++) {
        var inlineEl = inlineElements[inlineIndex];
        var ancestorEl = inlineEl.parentElement && inlineEl.parentElement.closest(SEMANTIC_INLINE_SELECTOR);
        var inlineParent = ancestorEl && root.contains(ancestorEl)
          ? byElement.get(ancestorEl) || parent
          : parent;
        add(inlineEl, 'inline', inlineParent);
      }
    }

    var groupElements = Array.prototype.slice.call(document.querySelectorAll(SEMANTIC_GROUP_SELECTOR));
    for (var groupIndex = 0; groupIndex < groupElements.length; groupIndex++) {
      var groupEl = groupElements[groupIndex];
      var containingGroupEl = groupEl.parentElement && groupEl.parentElement.closest(SEMANTIC_GROUP_SELECTOR);
      add(groupEl, 'group', containingGroupEl ? byElement.get(containingGroupEl) || null : null);
    }

    var blockElements = Array.prototype.slice.call(document.querySelectorAll(SEMANTIC_BLOCK_SELECTOR));
    for (var blockIndex = 0; blockIndex < blockElements.length; blockIndex++) {
      var blockEl = blockElements[blockIndex];
      if (blockEl.closest(PINPOINT_SKIP_SELECTOR)) continue;
      var containingBlock = blockEl.parentElement && blockEl.parentElement.closest(SEMANTIC_BLOCK_SELECTOR);
      if (containingBlock) continue;
      var parentGroupEl = blockEl.parentElement && blockEl.parentElement.closest(SEMANTIC_GROUP_SELECTOR);
      var parentGroup = parentGroupEl ? byElement.get(parentGroupEl) : null;
      var kind = blockEl.tagName === 'TABLE'
        ? 'table'
        : blockEl.tagName === 'PRE'
          ? 'code'
          : 'block';
      var blockTarget = add(blockEl, kind, parentGroup || null);
      if (!blockTarget) continue;
      blocks.push(blockTarget);

      if (blockEl.tagName === 'TABLE') {
        var rows = Array.prototype.slice.call(blockEl.rows || []);
        for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          var rowTarget = add(rows[rowIndex], 'row', blockTarget);
          if (!rowTarget) continue;
          var cells = Array.prototype.slice.call(rows[rowIndex].cells || []);
          for (var cellIndex = 0; cellIndex < cells.length; cellIndex++) {
            var cellTarget = add(cells[cellIndex], 'cell', rowTarget);
            if (cellTarget) {
              cellTarget.rowIndex = rowIndex;
              cellTarget.columnIndex = cellIndex;
              addInlineDescendants(cells[cellIndex], cellTarget);
            }
          }
        }
      } else {
        addInlineDescendants(blockEl, blockTarget);
      }
    }

    return {
      targets: targets,
      blocks: blocks,
      byElement: byElement
    };
  }

  function semanticChildren(graph, target) {
    return graph.targets.filter(function(candidate) {
      return candidate.parentKey === target.key;
    });
  }

  function semanticParent(graph, target) {
    if (!target || !target.parentKey) return null;
    for (var i = 0; i < graph.targets.length; i++) {
      if (graph.targets[i].key === target.parentKey) return graph.targets[i];
    }
    return null;
  }

  function semanticSibling(graph, target, delta) {
    var parent = semanticParent(graph, target);
    if (!parent) return target;
    var siblings = semanticChildren(graph, parent);
    var index = siblings.indexOf(target);
    if (index < 0) return target;
    var nextIndex = Math.max(0, Math.min(siblings.length - 1, index + delta));
    return siblings[nextIndex] || target;
  }

  function semanticOwningBlock(graph, target) {
    var current = target;
    while (current && graph.blocks.indexOf(current) < 0) {
      current = semanticParent(graph, current);
    }
    return current || target;
  }

  function resolveSemanticTarget(graph, node) {
    var el = node;
    while (el && el.nodeType === 3) el = el.parentNode;
    if (
      !el
      || el.nodeType !== 1
      || el === document.documentElement
      || el === document.body
      || el.closest(PINPOINT_SKIP_SELECTOR)
    ) return null;

    if (el.ownerSVGElement && el.closest) {
      var svgGroup = el.closest('g');
      if (svgGroup && graph.byElement.has(svgGroup)) return graph.byElement.get(svgGroup);
    }

    var inline = el.closest && el.closest(SEMANTIC_INLINE_SELECTOR);
    if (inline && graph.byElement.has(inline)) return graph.byElement.get(inline);
    var cell = el.closest && el.closest('td,th');
    if (cell && graph.byElement.has(cell)) return graph.byElement.get(cell);

    var current = el;
    while (current && current !== document.body) {
      if (graph.byElement.has(current)) return graph.byElement.get(current);
      current = current.parentElement;
    }
    return null;
  }

  // Floating label naming the element under the cursor (like the markdown overlay).
  var PINPOINT_LABELS = { H1:'Heading', H2:'Heading', H3:'Heading', H4:'Heading', H5:'Heading', H6:'Heading', P:'Paragraph', UL:'List', OL:'List', LI:'List item', A:'Link', BUTTON:'Button', IMG:'Image', TABLE:'Table', THEAD:'Table', TBODY:'Table', TR:'Row', TD:'Cell', TH:'Header cell', SECTION:'Section', NAV:'Navigation', HEADER:'Header', FOOTER:'Footer', ARTICLE:'Article', ASIDE:'Sidebar', BLOCKQUOTE:'Quote', PRE:'Code', CODE:'Code', FIGURE:'Figure', FIGCAPTION:'Caption', MAIN:'Main', FORM:'Form', INPUT:'Input', LABEL:'Label' };

  var MAX_HOVER_LABEL = 40;
  function truncateLabel(text) {
    return text.length > MAX_HOVER_LABEL ? text.slice(0, MAX_HOVER_LABEL) : text;
  }

  // First 1-2 meaningful class tokens: split on whitespace/underscore/hyphen,
  // drop tokens of 2 chars or fewer and CSS-module-hash-looking tokens, so a
  // div.rowchip labels "rowchip" and styles_Card_ab12f labels "Card".
  function meaningfulClassTokens(el) {
    var out = [];
    if (!el.classList || !el.classList.length) return out;
    for (var i = 0; i < el.classList.length && out.length < 2; i++) {
      var cls = el.classList[i];
      if (isLikelyGeneratedClass(cls)) continue;
      var parts = String(cls).split(/[\\s_-]+/);
      for (var j = 0; j < parts.length && out.length < 2; j++) {
        var token = parts[j];
        if (token.length <= 2) continue;
        if (/^[a-fA-F0-9]+$/.test(token) && token.length >= 5) continue;
        if (/[0-9]{4,}/.test(token)) continue;
        out.push(token);
      }
    }
    return out;
  }

  // Label cascade for generic containers (div/span/custom elements):
  // aria-label -> role -> meaningful class tokens -> own short text ->
  // "container". Known semantic tags keep their human names above.
  function pinpointHoverLabel(el) {
    var known = PINPOINT_LABELS[el.tagName];
    if (known) return known;
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.trim()) return truncateLabel(aria.trim());
    var role = el.getAttribute && el.getAttribute('role');
    if (role && role.trim()) return truncateLabel(role.trim());
    var tokens = meaningfulClassTokens(el);
    if (tokens.length) return truncateLabel(tokens.join(' '));
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text && text.length <= MAX_HOVER_LABEL) return text;
    return 'container';
  }

  var pinpointLabelEl = null;
  function getPinpointLabelEl() {
    if (!pinpointLabelEl) {
      pinpointLabelEl = document.createElement('div');
      pinpointLabelEl.setAttribute('data-plannotator-pinpoint-label', '');
      pinpointLabelEl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;font:600 11px/1.3 system-ui,-apple-system,sans-serif;padding:2px 7px;border-radius:5px;background:var(--pn-focus-highlight,#4493f8);color:#fff;white-space:nowrap;box-shadow:0 1px 5px rgba(0,0,0,.35);';
      overlayNodes.add(pinpointLabelEl);
    }
    // Paint order at equal z-index follows DOM order: the label must sit
    // AFTER the marker overlay host on the root element or marker bubbles
    // occlude it. Re-append whenever it is not the last child (appendChild
    // moves an already-connected node).
    var labelRoot = document.documentElement || document.body;
    if (labelRoot && (!pinpointLabelEl.isConnected || pinpointLabelEl.nextSibling)) {
      labelRoot.appendChild(pinpointLabelEl);
    }
    return pinpointLabelEl;
  }
  function hidePinpointLabel() { if (pinpointLabelEl) pinpointLabelEl.style.display = 'none'; }

  // Hover outline box: fixed-position, pointer-events none, sized to the
  // hovered element's live rect. The page DOM is never touched for hover.
  var pinpointBoxEl = null;
  function getPinpointBoxEl() {
    if (!pinpointBoxEl) {
      pinpointBoxEl = document.createElement('div');
      pinpointBoxEl.setAttribute('data-plannotator-pinpoint-box', '');
      pinpointBoxEl.setAttribute('data-plannotator-vim-ui', '');
      overlayNodes.add(pinpointBoxEl);
    }
    if (!pinpointBoxEl.isConnected) document.body.appendChild(pinpointBoxEl);
    return pinpointBoxEl;
  }
  function positionPinpointBox(el) {
    var r = el.getBoundingClientRect();
    var box = getPinpointBoxEl();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }
  function hidePinpointBox() {
    if (pinpointBoxEl) {
      pinpointBoxEl.style.display = 'none';
      pinpointBoxEl.removeAttribute('data-pinned');
      pinpointBoxEl.classList.remove('pn-pin-enter');
    }
  }
  function clearPinpointHover() {
    pinpointHover = null;
    if (!pendingPinEl) hidePinpointBox();
    hidePinpointLabel();
  }
  function positionPinpointLabel(el, labelText) {
    var r = el.getBoundingClientRect();
    var lbl = getPinpointLabelEl();
    lbl.textContent = labelText;
    lbl.style.display = 'block';
    // Flip below the element when the pill would leave the viewport top.
    var top = r.top - 22;
    if (top < 2) top = Math.min(r.bottom + 4, window.innerHeight - 24);
    lbl.style.top = top + 'px';
    lbl.style.left = Math.max(2, Math.min(r.left, window.innerWidth - 120)) + 'px';
  }

  // Identity-gated hover update (only restyle when the resolved element
  // changes); shared by mousemove and the scroll/resize reconcile pass.
  // Per-event hit-testing only — never builds the semantic graph.
  function updatePinpointHover(x, y, fallbackNode) {
    var el = pinpointLeafAt(x, y, fallbackNode);
    // The 25px marker bubble owns clicks over it (they select its comment),
    // so hover must advertise the MARKER's own identity — no annotate box,
    // label "Comment N" — never the element beneath. Moving off the bubble
    // restores normal element hover/annotate.
    if (lastRawHitMarker && !pendingPinEl) {
      var markerLabel = lastRawHitMarker.getAttribute('aria-label') || 'Comment';
      pinpointHover = null;
      hidePinpointBox();
      positionPinpointLabel(lastRawHitMarker, markerLabel);
      return;
    }
    if (el !== pinpointHover) {
      pinpointHover = el;
      if (el && !pendingPinEl) {
        var box = getPinpointBoxEl();
        box.classList.remove('pn-pin-enter');
        void box.offsetWidth; // restart the enter animation
        box.classList.add('pn-pin-enter');
        positionPinpointBox(el);
      } else if (!pendingPinEl) {
        hidePinpointBox();
      }
    } else if (el && !pendingPinEl) {
      positionPinpointBox(el); // same element — keep the box glued while scrolling
    }
    if (!el || pendingPinEl) { hidePinpointLabel(); return; }
    positionPinpointLabel(el, pinpointHoverLabel(el));
  }

  var lastPointer = null;
  document.addEventListener('mousemove', function(e) {
    lastPointer = { x: e.clientX, y: e.clientY };
    updateDragYield(e);
    if (currentInputMethod !== 'pinpoint') {
      // Click-to-select hover affordance (drag mode owns highlight clicks):
      // cheap cached-rect hit test, rAF-throttled, cleared while a draft or
      // pending selection owns the surface.
      if (!pendingPinEl && !pendingSelection && renderedCommittedRects.length) {
        scheduleHoverHitTest(e.clientX, e.clientY);
      } else {
        clearHoverHighlight();
      }
      return;
    }
    if (vimEnabled && vimPhase !== 'inactive') return;
    // Hit-test at the pointer (e.target only backstops engines without
    // elementFromPoint) so the same code path serves the scroll re-hit-test.
    updatePinpointHover(e.clientX, e.clientY, e.target);
    if (pendingPinEl && multiSelectArmed) {
      // Composer yield needs the pointer even while it is inside this iframe;
      // the shift state rides along because the parent cannot observe
      // modifiers held while focus/pointer live in the sandbox.
      schedulePointerRelay(e.clientX, e.clientY, e.shiftKey);
      // Shift-hover preview: outline what the next shift-click would toggle.
      if (e.shiftKey) updateMultiHover(e.clientX, e.clientY, e.target);
      else hideMultiHoverBox();
    }
  });

  // rAF-coalesced reconcile: keeps the hover box under a stationary cursor
  // while the page scrolls, tracks the pinned element, and repositions pin
  // badges. Capture-phase scroll so inner scroll containers count too.
  var pinpointReconcileRaf = 0;
  function schedulePinpointReconcile() {
    if (pinpointReconcileRaf) return;
    pinpointReconcileRaf = requestAnimationFrame(function() {
      pinpointReconcileRaf = 0;
      // Same point, possibly a different element after a scroll, resize, or
      // layout-changing mutation (the body ResizeObserver also lands here) —
      // the last-position cache must never answer the next probe.
      invalidatePointerHitCache();
      renderAnnotationOverlay();
      // Scroll under a stationary pointer moves the committed rects: re-run
      // the cached-rect hover test so the affordance tracks reality.
      if (currentInputMethod !== 'pinpoint' && lastPointer && !pendingPinEl && !pendingSelection) {
        setHoverHighlight(committedHighlightIdAtCached(lastPointer.x, lastPointer.y));
      }
      positionMultiTargetBoxes();
      if (pendingPinEl && pendingPinEl.isConnected) {
        positionPinpointBox(pendingPinEl);
        return;
      }
      if (currentInputMethod !== 'pinpoint') return;
      if (vimEnabled && vimPhase !== 'inactive') return;
      if (lastPointer) {
        updatePinpointHover(lastPointer.x, lastPointer.y, pinpointHover);
      }
    });
  }
  window.addEventListener('scroll', schedulePinpointReconcile, { passive: true, capture: true });
  window.addEventListener('resize', schedulePinpointReconcile, { passive: true });

  // --- Annotation overlay: anchors are data, markers are projections ---
  // Committed annotations never write into the visited page's DOM. Durable
  // data (anchor selectors, original text, normalized selected point) is
  // re-resolved to live targets on demand and projected as disposable
  // artifacts — highlight rectangles and numbered placed-marker buttons —
  // into a fixed, pointer-transparent, shadow-rooted overlay host appended
  // to the root element (outside <body>, outside page layout). Only marker
  // buttons accept pointer input; everything else is hit-transparent.
  var MARKER_EDGE_INSET = 29;      // full marker stays reachable at viewport edges
  var MARKER_SPREAD_STEP = 12.5;   // horizontal step for coincident markers
  var MARKER_SPREAD_EDGE = 28.5;   // effective edge clamp while spreading
  var MARKER_ASSOC_TOLERANCE = 16; // clamped point must stay this close to the visible target
  var MAX_HIGHLIGHT_RECTS = 48;    // highlight rects drawn per range target
  var MAX_SYNC_ANNOTATIONS = 512;  // parent-synced numbering entries

  // Style isolation only (not a security boundary): the shadow root keeps the
  // page's CSS off the overlay and the overlay's CSS off the page.
  var OVERLAY_CSS = [
    '.pn-layer { position: fixed; inset: 0; pointer-events: none; }',
    '.pn-hl { position: fixed; pointer-events: none; border-radius: 2px; box-sizing: border-box; }',
    '.pn-hl-comment { background: oklch(0.70 0.18 60 / 0.28); border-bottom: 2px solid var(--pn-accent, #d97757); }',
    '.pn-hl-deletion { background: oklch(from var(--pn-destructive, #c0392b) l c h / 0.28); background-image: linear-gradient(to bottom, transparent calc(50% - 1px), var(--pn-destructive, #c0392b) calc(50% - 1px), var(--pn-destructive, #c0392b) calc(50% + 1px), transparent calc(50% + 1px)); }',
    '.pn-hl-focus { background: oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.35); box-shadow: 0 0 8px oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.4); }',
    '.pn-hl-draft { background: oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.22); }',
    '.pn-hl-hover { filter: brightness(1.25) saturate(1.1); }',
    '.pn-marker { position: fixed; width: 25px; height: 25px; border: 0; padding: 0; margin: 0; background: transparent; transform: translate(-50%, -50%); pointer-events: auto; cursor: pointer; display: flex; align-items: center; justify-content: center; animation: pn-marker-in 0.2s ease-out both; }',
    '.pn-marker[data-selected="true"] { transform: translate(-50%, -50%) scale(1.08); }',
    '.pn-marker-icon { pointer-events: none; display: block; position: absolute; top: 0; left: 0; width: 100%; height: 100%; filter: drop-shadow(0 1px 3px rgba(0,0,0,.3)); }',
    '.pn-marker-icon path { fill: var(--pn-accent, #d97757); stroke: #fff; stroke-width: 1.65; }',
    '.pn-marker-num { pointer-events: none; position: relative; transform: translate(-0.5px, -1.5px); color: #fff; font: 700 10px/1 system-ui, -apple-system, sans-serif; user-select: none; }',
    '@keyframes pn-marker-in { from { opacity: 0; } to { opacity: 1; } }',
    '@media (prefers-reduced-motion: reduce) { .pn-marker { animation: none; } }',
    ':host([data-pn-hittest]) .pn-marker, [data-plannotator-overlay-host][data-pn-hittest] .pn-marker { pointer-events: none !important; }',
    '@media print { .pn-layer { display: none !important; } }'
  ].join('\\n');

  // Product-owned speech-bubble marker (26x25 box, accent fill, white stroke).
  var MARKER_SVG = '<svg class="pn-marker-icon" viewBox="0 0 26 25" aria-hidden="true" focusable="false"><path d="M13 1.1C6.55 1.1 1.4 5.83 1.4 11.62c0 3.62 2.02 6.8 5.08 8.68l-0.85 3.5 4.28-2.02c1.01 0.25 2.05 0.38 3.09 0.38 6.45 0 11.6-4.73 11.6-10.54C24.6 5.83 19.45 1.1 13 1.1Z"/></svg>';

  var overlayHostEl = null;
  var overlayRootEl = null; // shadow root, or the host itself when unavailable
  var highlightsLayerEl = null;
  var markersLayerEl = null;

  function ensureOverlayHost() {
    if (!overlayHostEl) {
      overlayHostEl = document.createElement('div');
      overlayHostEl.setAttribute('data-plannotator-overlay-host', '');
      var hostStyle = overlayHostEl.style;
      hostStyle.setProperty('position', 'fixed', 'important');
      hostStyle.setProperty('top', '0', 'important');
      hostStyle.setProperty('left', '0', 'important');
      hostStyle.setProperty('right', '0', 'important');
      hostStyle.setProperty('bottom', '0', 'important');
      hostStyle.setProperty('z-index', '2147483647', 'important');
      hostStyle.setProperty('pointer-events', 'none', 'important');
      overlayNodes.add(overlayHostEl);
      var root = overlayHostEl;
      if (overlayHostEl.attachShadow) {
        try { root = overlayHostEl.attachShadow({ mode: 'open' }); } catch (ex) {}
      }
      overlayRootEl = root;
      var style = document.createElement('style');
      style.textContent = OVERLAY_CSS;
      root.appendChild(style);
      highlightsLayerEl = document.createElement('div');
      highlightsLayerEl.className = 'pn-layer';
      highlightsLayerEl.setAttribute('data-pn-highlights', '');
      root.appendChild(highlightsLayerEl);
      markersLayerEl = document.createElement('div');
      markersLayerEl.className = 'pn-layer';
      markersLayerEl.setAttribute('data-pn-markers', '');
      root.appendChild(markersLayerEl);
    }
    // Host lives on the root element, not in <body>: the page's own layout
    // never contains or reflows around it, and the body MutationObserver
    // never sees overlay writes.
    if (!overlayHostEl.isConnected) {
      (document.documentElement || document.body).appendChild(overlayHostEl);
      // Keep the pinpoint hover label painting ABOVE markers: it must stay
      // after the host in DOM order (equal z-index resolves by paint order).
      if (pinpointLabelEl && pinpointLabelEl.isConnected) {
        (document.documentElement || document.body).appendChild(pinpointLabelEl);
      }
    }
    return overlayHostEl;
  }

  // Hit-test yielding: marker buttons accept pointer input, so a bare
  // elementFromPoint over one would resolve overlay chrome instead of the
  // page. Temporarily disable marker hit targets so probes reach beneath.
  // Restores (never clears) the attribute: the drag-selection yield below
  // holds the same attribute across events and must survive a probe.
  function withMarkersYielded(fn) {
    if (!overlayHostEl || !overlayHostEl.isConnected) return fn();
    var alreadyYielded = overlayHostEl.hasAttribute('data-pn-hittest');
    overlayHostEl.setAttribute('data-pn-hittest', '');
    try {
      return fn();
    } finally {
      if (!alreadyYielded) overlayHostEl.removeAttribute('data-pn-hittest');
    }
  }

  // Drag-selection marker yield: while a text drag is in progress in drag
  // mode, placed markers drop pointer input (the same data-pn-hittest CSS the
  // hit-test yield uses) so a 25px bubble sitting over the text cannot
  // capture the selection mid-drag. Armed only by a >4px move with the
  // primary button held from a non-overlay mousedown, so marker clicks
  // (mousedown ON the marker) and plain click-to-select (no drag) are
  // untouched; disarmed on mouseup or when the button is seen released.
  var dragYieldStart = null;
  var dragYieldActive = false;
  function endDragYield() {
    dragYieldStart = null;
    if (dragYieldActive) {
      dragYieldActive = false;
      if (overlayHostEl) overlayHostEl.removeAttribute('data-pn-hittest');
    }
  }
  function updateDragYield(e) {
    if (!dragYieldStart) return;
    if (typeof e.buttons === 'number' && !(e.buttons & 1)) {
      endDragYield(); // missed mouseup (released outside the iframe)
      return;
    }
    if (
      !dragYieldActive
      && (Math.abs(e.clientX - dragYieldStart.x) > 4 || Math.abs(e.clientY - dragYieldStart.y) > 4)
    ) {
      dragYieldActive = true;
      if (overlayHostEl && overlayHostEl.isConnected) {
        overlayHostEl.setAttribute('data-pn-hittest', '');
      }
    }
  }
  document.addEventListener('mousedown', function(e) {
    if (currentInputMethod === 'pinpoint') return;
    if (e.button !== 0) return;
    if (isViewerOverlayNode(e.target)) return;
    dragYieldStart = { x: e.clientX, y: e.clientY };
  }, true);
  document.addEventListener('mouseup', function() {
    endDragYield();
  }, true);

  // One record per committed annotation. Its targets are live projections;
  // its params are the durable data they re-resolve from after mutations.
  var annRecords = []; // { id, annType, params: { originalText, anchor, additionalAnchors }, targets }
  var annNumbers = null; // Map(id -> display number) synced from the parent's ordered collection
  var focusedAnnotationId = null;
  var focusFlashTimer = 0;
  var markerButtons = new Map(); // "id::targetIndex" -> <button>

  function findAnnRecord(id) {
    for (var i = 0; i < annRecords.length; i++) {
      if (annRecords[i].id === id) return annRecords[i];
    }
    return null;
  }

  function ensureAnnRecord(id, annType, params) {
    var existing = findAnnRecord(id);
    if (existing) return existing;
    var record = { id: id, annType: annType || 'comment', params: params || null, targets: [] };
    annRecords.push(record);
    return record;
  }

  function removeAnnRecord(id) {
    for (var i = annRecords.length - 1; i >= 0; i--) {
      if (annRecords[i].id === id) annRecords.splice(i, 1);
    }
    restoreFailedIds['delete'](id);
    if (focusedAnnotationId === id) focusedAnnotationId = null;
  }

  // Fail-closed transparency (host ask): markers for dead targets are
  // omitted, never guessed — this names WHICH annotations currently have no
  // live representation on the page (every target dead, or the restore never
  // resolved anything) so the host can tell the user instead of letting them
  // silently vanish. Emitted only when the set changes, and only from
  // complete overlay passes — budget-starved passes reschedule themselves
  // and would flap the set. restoreFailedIds carries total restore failures,
  // whose records are removed and therefore invisible to the per-pass scan.
  var lastUnanchoredKey = '[]';
  var restoreFailedIds = new Set();
  function emitUnanchored(deadRecordIds) {
    var seen = new Set();
    var combined = [];
    for (var deadIndex = 0; deadIndex < deadRecordIds.length; deadIndex++) {
      if (!seen.has(deadRecordIds[deadIndex])) {
        seen.add(deadRecordIds[deadIndex]);
        combined.push(deadRecordIds[deadIndex]);
      }
    }
    restoreFailedIds.forEach(function(failedId) {
      if (!seen.has(failedId)) {
        seen.add(failedId);
        combined.push(failedId);
      }
    });
    combined.sort();
    if (combined.length > 512) combined = combined.slice(0, 512);
    var key = JSON.stringify(combined);
    if (key === lastUnanchoredKey) return;
    lastUnanchoredKey = key;
    parent.postMessage({ type: PREFIX + 'unanchored', ids: combined }, '*');
  }

  function validNormalizedPoint(p) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
    if (!isFinite(p.x) || !isFinite(p.y)) return null;
    return { x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) };
  }

  function normalizedPointOf(anchor, point) {
    return validNormalizedPoint(point) || (anchor ? validNormalizedPoint(anchor.point) : null);
  }

  function addElementTarget(record, element, anchor, point) {
    if (!element) return false;
    // One annotation may cover several elements (multi-select): dedup by
    // (id, element) and (id, anchor) so a re-resolved anchor can't
    // double-mark the same logical target — never by id alone.
    for (var i = 0; i < record.targets.length; i++) {
      var t = record.targets[i];
      if (t.kind !== 'element') continue;
      if (t.element === element) return false;
      if (anchor && anchorsEqual(t.anchor, anchor)) return false;
    }
    record.targets.push({
      kind: 'element',
      element: element,
      anchor: anchor || null,
      point: normalizedPointOf(anchor, point)
    });
    return true;
  }

  function addRangeTarget(record, range, text, markerless) {
    if (!range) return false;
    record.targets.push({ kind: 'range', range: range, text: text || '', markerless: !!markerless });
    return true;
  }

  function rangeAlive(range) {
    if (!range) return false;
    try {
      var s = range.startContainer;
      var e = range.endContainer;
      if (!s || !e) return false;
      if (typeof s.isConnected === 'boolean' && !s.isConnected) return false;
      if (typeof e.isConnected === 'boolean' && !e.isConnected) return false;
      return true;
    } catch (ex) {
      return false;
    }
  }

  // Resolve one contiguous document Range for the first occurrence of text.
  // Overlay-owned text (labels, vim chrome) is skipped by IDENTITY so viewer
  // chrome can never satisfy a page-text search.
  function findTextRange(text, root) {
    var scope = root || document.body;
    if (!text || !scope) return null;
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    var buffer = '';
    var nodes = [];
    while (walker.nextNode()) {
      var current = walker.currentNode;
      if (current.parentElement && isViewerOverlayNode(current.parentElement)) continue;
      nodes.push({ node: current, start: buffer.length });
      buffer += current.textContent;
    }
    var idx = buffer.indexOf(text);
    if (idx === -1) return null;
    var endIdx = idx + text.length;
    var startEntry = null;
    var endEntry = null;
    for (var i = 0; i < nodes.length; i++) {
      var entry = nodes[i];
      var nodeEnd = entry.start + entry.node.length;
      if (!startEntry && idx < nodeEnd) startEntry = entry;
      if (endIdx <= nodeEnd) { endEntry = entry; break; }
    }
    if (!startEntry || !endEntry) return null;
    try {
      var range = document.createRange();
      range.setStart(startEntry.node, idx - startEntry.start);
      range.setEnd(endEntry.node, endIdx - endEntry.start);
      return range;
    } catch (ex) {
      return null;
    }
  }

  /**
   * Restore ladder (fail-closed, matches the old find-and-mark contract):
   * resolved SVG anchors are element targets; a resolved anchor scopes the
   * text search (element marker + markerless highlight range); the
   * document-wide text search runs BEFORE the element fallback so text that
   * moved elsewhere is followed rather than pinning a stale container; a
   * resolved element whose text is gone everywhere is the last resort.
   * Additional anchors restore anchor-only — a stale anchor simply doesn't
   * restore.
   */
  function restoreAnnotation(id, annType, originalText, anchor, additionalAnchors) {
    removeAnnRecord(id); // a fresh restore is authoritative for its id
    var record = ensureAnnRecord(id, annType, {
      originalText: originalText || '',
      anchor: anchor || null,
      additionalAnchors: additionalAnchors || null
    });
    var found = false;
    var anchorEl = resolveAnchorElement(anchor);
    var isSvgAnchor = anchorEl && (anchorEl.ownerSVGElement || anchorEl.tagName.toLowerCase() === 'svg');
    if (isSvgAnchor) {
      found = addElementTarget(record, anchorEl, anchor, null);
    } else if (anchorEl) {
      var scopedRange = findTextRange(originalText, anchorEl);
      if (scopedRange) {
        // Pinpoint-with-text: the element owns the placed marker (at the
        // stored selected point); the scoped range paints the highlight.
        found = addElementTarget(record, anchorEl, anchor, null);
        addRangeTarget(record, scopedRange, originalText, true);
      }
    }
    if (!found) {
      var docRange = findTextRange(originalText, null);
      if (docRange) {
        addRangeTarget(record, docRange, originalText, false);
        found = true;
      }
    }
    if (!found && anchorEl) {
      found = addElementTarget(record, anchorEl, anchor, null);
    }
    if (additionalAnchors && additionalAnchors.length) {
      var extraCount = Math.min(additionalAnchors.length, MAX_MULTI_TARGETS);
      for (var extraIndex = 0; extraIndex < extraCount; extraIndex++) {
        var extraEl = resolveAnchorElement(additionalAnchors[extraIndex]);
        if (extraEl && addElementTarget(record, extraEl, additionalAnchors[extraIndex], null)) {
          found = true;
        }
      }
    }
    if (!record.targets.length) {
      // The record is removed (nothing to retry), so the per-pass dead scan
      // cannot see this id: track it separately for the unanchored report.
      removeAnnRecord(id);
      restoreFailedIds.add(id);
    }
    // rAF-coalesced render (B3): restoring N annotations posts N
    // find-and-mark messages, and a synchronous render here made a batch
    // restore O(N^2) full overlay passes. The searches above stay
    // synchronous (the mark-applied reply depends on them); only the
    // projection is deferred, and one frame renders the whole batch.
    schedulePinpointReconcile();
    return found;
  }

  // Unresolvable-target re-search is GENERATION-gated: findTextRange is a
  // whole-document TreeWalker sweep (and anchor re-resolution a document
  // query + text snapshot), while refreshRecordTargets runs on every
  // scroll/resize rAF and every body mutation. A page with one stale
  // annotation plus scrolling must not do O(document-text) work per frame
  // forever. The counter advances only on signals that can change text
  // (page mutations, settle events, frame loads); scroll and resize alone
  // never unlock a re-search — geometry changes, text doesn't.
  var domGeneration = 1;

  function monotonicNow() {
    return typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
  }

  // Wall-clock backoff ON TOP of the generation gate: a page that mutates
  // styles/text once per frame advances domGeneration every frame, so the
  // generation gate alone would re-run the whole-document text search (or
  // anchor re-resolution) per frame forever for a permanently unresolvable
  // target. After each FAILED search a target waits for BOTH a new
  // generation AND its backoff (300ms, doubling to a 5s cap, reset on any
  // success) before it may search again.
  var DEAD_SEARCH_BACKOFF_MS = 300;
  var DEAD_SEARCH_BACKOFF_MAX_MS = 5000;
  // Per-reconcile-pass budget: at most this many dead-target searches run in
  // one pass, so many stale targets can never stack whole-document scans
  // into a single frame. When eligible targets are skipped for budget, a
  // follow-up pass is scheduled; each failure's >=300ms backoff then hands
  // the next pass's budget to different targets (round-robin by backoff).
  var MAX_DEAD_SEARCHES_PER_PASS = 2;
  var deadSearchBudget = MAX_DEAD_SEARCHES_PER_PASS;
  var deadSearchSkipped = false;

  // budget: dead searches this pass may run. Per-frame reconcile passes use
  // the default (they repeat, so skipped targets get follow-up frames);
  // user-initiated one-shot passes (print, scroll-to) pass Infinity — they
  // have no follow-up, and the backoff + generation gates still bound them.
  function beginDeadSearchPass(budget) {
    deadSearchBudget = typeof budget === 'number' ? budget : MAX_DEAD_SEARCHES_PER_PASS;
    deadSearchSkipped = false;
  }

  function deadSearchAllowed(target) {
    if (target.failedGeneration === domGeneration) return false;
    if (target.searchBackoffUntil && monotonicNow() < target.searchBackoffUntil) return false;
    if (deadSearchBudget <= 0) {
      deadSearchSkipped = true;
      return false;
    }
    return true;
  }

  function noteDeadSearchResult(target, found) {
    deadSearchBudget -= 1;
    if (found) {
      target.failedGeneration = 0;
      target.searchBackoffMs = 0;
      target.searchBackoffUntil = 0;
    } else {
      target.failedGeneration = domGeneration;
      target.searchBackoffMs = target.searchBackoffMs
        ? Math.min(target.searchBackoffMs * 2, DEAD_SEARCH_BACKOFF_MAX_MS)
        : DEAD_SEARCH_BACKOFF_MS;
      target.searchBackoffUntil = monotonicNow() + target.searchBackoffMs;
    }
  }

  // Re-resolve stale live targets from durable data. Element targets
  // re-acquire through their anchor; range targets re-run the text search
  // (anchor-scoped first). Unresolvable targets stay hidden — never guessed
  // — and each failed search is gated by the generation of its last attempt
  // PLUS the wall-clock backoff and per-pass budget above, so they retry
  // only after the document could actually have changed, and never per
  // frame.
  function refreshRecordTargets(record) {
    for (var i = 0; i < record.targets.length; i++) {
      var target = record.targets[i];
      if (target.kind === 'element') {
        if ((!target.element || !target.element.isConnected) && target.anchor) {
          if (!deadSearchAllowed(target)) continue;
          target.element = resolveAnchorElement(target.anchor);
          noteDeadSearchResult(target, !!target.element);
        }
      } else if (!rangeAlive(target.range)) {
        target.range = null;
        if (target.text) {
          if (!deadSearchAllowed(target)) continue;
          var scopeEl = record.params && record.params.anchor
            ? resolveAnchorElement(record.params.anchor)
            : null;
          target.range = (scopeEl && findTextRange(target.text, scopeEl))
            || findTextRange(target.text, null);
          noteDeadSearchResult(target, !!target.range);
        }
      }
    }
  }

  function committedRangeClone(id) {
    var record = findAnnRecord(id);
    if (!record) return null;
    for (var i = 0; i < record.targets.length; i++) {
      var target = record.targets[i];
      if (target.kind === 'range' && rangeAlive(target.range)) {
        try { return target.range.cloneRange(); } catch (ex) {}
      }
    }
    return null;
  }

  function buildPendingRange(selData) {
    try {
      var startNode = resolveNodePath(selData.startContainerPath);
      var endNode = resolveNodePath(selData.endContainerPath);
      if (!startNode || !endNode) return null;
      var range = document.createRange();
      range.setStart(startNode, selData.startOffset);
      range.setEnd(endNode, selData.endOffset);
      return range;
    } catch (ex) {
      return null;
    }
  }

  function rectRight(r) { return typeof r.right === 'number' ? r.right : r.left + (r.width || 0); }
  function rectBottom(r) { return typeof r.bottom === 'number' ? r.bottom : r.top + (r.height || 0); }

  // Ancestors that establish the containing block for FIXED-position
  // descendants (transform / perspective / filter / backdrop-filter /
  // will-change of those). Overflow clipping only applies to a fixed target
  // when the clipper is in its containing-block chain, so plain static
  // clippers must be skipped for fixed targets — a fully visible
  // position:fixed element inside an overflow:hidden ancestor would
  // otherwise be intersected away and omitted forever.
  function establishesFixedContainingBlock(style) {
    if (!style) return false;
    if (style.transform && style.transform !== 'none') return true;
    if (style.perspective && style.perspective !== 'none') return true;
    if (style.filter && style.filter !== 'none') return true;
    var backdrop = style.backdropFilter || style.webkitBackdropFilter || '';
    if (backdrop && backdrop !== 'none') return true;
    var willChange = style.willChange || '';
    if (
      willChange.indexOf('transform') >= 0
      || willChange.indexOf('perspective') >= 0
      || willChange.indexOf('filter') >= 0
    ) return true;
    var containValue = ' ' + (style.contain || '') + ' ';
    if (
      containValue.indexOf(' layout ') >= 0
      || containValue.indexOf(' paint ') >= 0
      || containValue.indexOf(' strict ') >= 0
      || containValue.indexOf(' content ') >= 0
    ) return true;
    var containerType = style.containerType || '';
    if (containerType === 'size' || containerType === 'inline-size') return true;
    return false;
  }

  // Viewport-space clip window from the element's clipping/scroll ancestor
  // chain, or null when nothing clips. Shared by marker projection AND every
  // painted highlight rect: content an inner scroll container has scrolled
  // away must never paint stripes over unrelated content outside its box.
  function clipBoundsFor(el) {
    if (!layoutActive() || !el) return null;
    var left = -Infinity;
    var top = -Infinity;
    var right = Infinity;
    var bottom = Infinity;
    var clipped = false;
    var fixedSkip = false;
    try {
      var ownStyle = window.getComputedStyle(el);
      fixedSkip = !!ownStyle && ownStyle.position === 'fixed';
    } catch (exOwn) {}
    var current = el.parentElement;
    var guard = 0;
    while (
      current
      && current !== document.body
      && current !== document.documentElement
      && guard++ < 200
    ) {
      var style = null;
      try { style = window.getComputedStyle(current); } catch (ex) { break; }
      // Once the fixed target's containing block is reached, that ancestor
      // and everything above it clip normally (the containing block itself
      // participates in ordinary flow).
      if (fixedSkip && establishesFixedContainingBlock(style)) fixedSkip = false;
      var overflowX = (style && (style.overflowX || style.overflow)) || '';
      var overflowY = (style && (style.overflowY || style.overflow)) || '';
      var clipsX = overflowX && overflowX !== 'visible';
      var clipsY = overflowY && overflowY !== 'visible';
      if ((clipsX || clipsY) && !fixedSkip) {
        var cr = current.getBoundingClientRect();
        if (clipsX) { left = Math.max(left, cr.left); right = Math.min(right, rectRight(cr)); clipped = true; }
        if (clipsY) { top = Math.max(top, cr.top); bottom = Math.min(bottom, rectBottom(cr)); clipped = true; }
      }
      current = current.parentElement;
    }
    return clipped ? { left: left, top: top, right: right, bottom: bottom } : null;
  }

  // Intersect one paintable rect with a clip window; null when nothing
  // visible survives (the rect is DROPPED, never painted degenerate).
  function clipRect(rect, bounds) {
    if (!bounds) return rect;
    var left = Math.max(rect.left, bounds.left);
    var top = Math.max(rect.top, bounds.top);
    var right = Math.min(rectRight(rect), bounds.right);
    var bottom = Math.min(rectBottom(rect), bounds.bottom);
    if (right <= left || bottom <= top) return null;
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }

  // Early viewport cull (small margin): a target wholly outside the viewport
  // paints nothing and places no marker, so the per-frame style/clip reads it
  // would otherwise cost (getComputedStyle, the clip-chain ancestor walk,
  // client-rect collection) are skipped outright. Never applies without
  // layout (headless DOM tests report every rect as 0x0 at the origin).
  var VIEWPORT_CULL_MARGIN = 64;
  function rectOutsideViewport(rect) {
    if (!rect || !layoutActive()) return false;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    return rectBottom(rect) < -VIEWPORT_CULL_MARGIN
      || rect.top > vh + VIEWPORT_CULL_MARGIN
      || rectRight(rect) < -VIEWPORT_CULL_MARGIN
      || rect.left > vw + VIEWPORT_CULL_MARGIN;
  }

  // Intersect a target rect with its clip chain for MARKER projection. May
  // return a degenerate rect — markerViewportPoint reads that as "no visible
  // intersection" and omits.
  function clippedTargetRect(el, rect) {
    var bounds = clipBoundsFor(el);
    if (!bounds) return rect;
    var left = Math.max(rect.left, bounds.left);
    var top = Math.max(rect.top, bounds.top);
    var right = Math.min(rectRight(rect), bounds.right);
    var bottom = Math.min(rectBottom(rect), bounds.bottom);
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }

  // Unresolved-for-display: a target whose box exists but is invisible
  // (visibility:hidden/collapse, display:none) keeps a full-size rect, so
  // without this gate markers, focus rects, and highlights would render over
  // whatever visible content stacks in the same box (e.g. carousel slides
  // toggled via visibility). display:none targets already report empty
  // client rects, but visibility does not. Checked per reconcile frame, only
  // for targets that passed the cheaper gates.
  //
  // Deliberately NO opacity:0 leg: computed opacity does not inherit, so a
  // container faded to opacity:0 leaves descendants at computed 1 and would
  // not be caught anyway — while the legitimate invisible-hit-target pattern
  // (<input type=file style="opacity:0;position:absolute;inset:0"> over a
  // styled control) SHOULD keep its marker exactly over the visible control.
  function targetStyleHidden(el) {
    if (!el || !layoutActive()) return false;
    var style = null;
    try { style = window.getComputedStyle(el); } catch (ex) { return false; }
    if (!style) return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
    if (style.display === 'none') return true;
    return false;
  }

  /**
   * Project a raw marker point against the target's visible geometry:
   * omit when the target has no visible intersection with the viewport,
   * clamp so the full marker stays reachable at viewport edges, and omit
   * when the point is no longer visibly associated with the target
   * (clipped/scrolled away). Never guesses a position.
   */
  function markerViewportPoint(visRect, rawX, rawY) {
    if (!layoutActive()) return { x: rawX, y: rawY };
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var visLeft = Math.max(visRect.left, 0);
    var visTop = Math.max(visRect.top, 0);
    var visRight = Math.min(rectRight(visRect), vw);
    var visBottom = Math.min(rectBottom(visRect), vh);
    if (visRight <= visLeft || visBottom <= visTop) return null;
    // Association is tested against the UNCLAMPED point: viewport edges CLAMP
    // (never omit — a fully visible element flush against the edge keeps its
    // marker even though the 29px inset moves it inward), while clip/scroll
    // detachment — a raw point no longer near the visible target geometry —
    // omits. The clamp below is rendering-only.
    var dx = rawX < visLeft ? visLeft - rawX : rawX > visRight ? rawX - visRight : 0;
    var dy = rawY < visTop ? visTop - rawY : rawY > visBottom ? rawY - visBottom : 0;
    if (dx > MARKER_ASSOC_TOLERANCE || dy > MARKER_ASSOC_TOLERANCE) return null;
    var x = Math.max(MARKER_EDGE_INSET, Math.min(rawX, vw - MARKER_EDGE_INSET));
    var y = Math.max(MARKER_EDGE_INSET, Math.min(rawY, vh - MARKER_EDGE_INSET));
    return { x: x, y: y };
  }

  // Containment filter: Range.getClientRects() returns BOTH a fully-contained
  // element's border box AND its line rects, so multi-paragraph selections
  // would double-paint stacked translucent rects (and redlines duplicate
  // strike lines). Drop any rect that strictly contains a smaller rect in
  // the same list.
  function dropContainerRects(rects) {
    if (rects.length < 2) return rects;
    return rects.filter(function(a) {
      var aArea = (a.width || 0) * (a.height || 0);
      for (var i = 0; i < rects.length; i++) {
        var b = rects[i];
        if (b === a) continue;
        var bArea = (b.width || 0) * (b.height || 0);
        if (bArea >= aArea) continue; // only a STRICTLY larger box is a container
        if (
          a.left <= b.left
          && a.top <= b.top
          && rectRight(a) >= rectRight(b)
          && rectBottom(a) >= rectBottom(b)
        ) return false;
      }
      return true;
    });
  }

  // Client rects for a range, BOUNDED at the source: a huge drag-selection or
  // redline can yield thousands of client rects (only the selection TEXT is
  // capped, never the Range extent), and this runs per range target per rAF
  // reconcile and per click hit-test. Only the paintable prefix (at most
  // MAX_HIGHLIGHT_RECTS) is ever materialized — so the zero-size and
  // containment filters below operate on at most 48 entries — and the
  // marker's TRUE last rect (m12) is read directly by index off the live
  // DOMRectList, never by collecting the whole list.
  function rangeClientRects(range) {
    var out = [];
    var lastRaw = null;
    if (!range) return { rects: out, last: null };
    if (typeof range.getClientRects === 'function') {
      try {
        var list = range.getClientRects();
        for (var i = 0; i < list.length && out.length < MAX_HIGHLIGHT_RECTS; i++) out.push(list[i]);
        if (list.length) lastRaw = list[list.length - 1];
      } catch (ex) {}
    }
    if (!out.length && typeof range.getBoundingClientRect === 'function') {
      try {
        var bounds = range.getBoundingClientRect();
        if (bounds) {
          out.push(bounds);
          if (!lastRaw) lastRaw = bounds;
        }
      } catch (ex2) {}
    }
    if (layoutActive()) {
      out = out.filter(function(rect) {
        return (rect.width || 0) > 0 || (rect.height || 0) > 0;
      });
      out = dropContainerRects(out);
    }
    return { rects: out, last: lastRaw };
  }

  // Range paint/projection geometry, shared by the overlay render, the print
  // layer, and highlight click hit-testing: clip-tested painted rects
  // (capped), the TRUE last client rect (marker anchor — never the capped
  // list's 48th rect), and the clipped union (marker association; extended
  // to the last rect so the tail of a cap-truncated selection still
  // associates its marker).
  function rangeVisualGeometry(range) {
    var rangeEl = range && range.startContainer
      ? (range.startContainer.nodeType === 1
        ? range.startContainer
        : range.startContainer.parentElement)
      : null;
    if (rangeEl && targetStyleHidden(rangeEl)) {
      return { paint: [], last: null, vis: null, hidden: true };
    }
    var collected = rangeClientRects(range);
    var all = collected.rects;
    if (!all.length) return { paint: [], last: null, vis: null, hidden: false };
    var bounds = clipBoundsFor(rangeEl);
    var paint = [];
    for (var i = 0; i < all.length && paint.length < MAX_HIGHLIGHT_RECTS; i++) {
      var clipped = clipRect(all[i], bounds);
      if (clipped) paint.push(clipped);
    }
    var last = collected.last;
    if (layoutActive() && last && !(last.width || 0) && !(last.height || 0)) {
      // A zero-size trailing rect (collapsed tail) has no visual anchor —
      // fall back to the last collected paintable rect.
      last = all[all.length - 1];
    }
    var union = unionOfRects(last ? all.concat([last]) : all);
    var vis = bounds
      ? {
        left: Math.max(union.left, bounds.left),
        top: Math.max(union.top, bounds.top),
        right: Math.min(union.right, bounds.right),
        bottom: Math.min(union.bottom, bounds.bottom)
      }
      : union;
    return { paint: paint, last: last, vis: vis, hidden: false };
  }

  function unionOfRects(rects) {
    var left = Infinity;
    var top = Infinity;
    var right = -Infinity;
    var bottom = -Infinity;
    for (var i = 0; i < rects.length; i++) {
      left = Math.min(left, rects[i].left);
      top = Math.min(top, rects[i].top);
      right = Math.max(right, rectRight(rects[i]));
      bottom = Math.max(bottom, rectBottom(rects[i]));
    }
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }

  var highlightPool = [];
  var highlightUsed = 0;
  // Read/write batching: the render pass QUEUES highlight rects while it
  // reads geometry, then flushes every pool write at once. Interleaving a
  // style write between one record's writes and the next record's
  // getBoundingClientRect would force a synchronous layout per record.
  var queuedHighlights = [];
  // Cached viewport rects of the committed highlights currently painted,
  // rebuilt on every flush. The hover affordance hit-tests the pointer
  // against THIS cache — never against live range geometry per mousemove.
  var renderedCommittedRects = [];
  function takeHighlightRect(className, rect, annId) {
    queuedHighlights.push({ className: className, rect: rect, annId: annId || '' });
  }
  function flushQueuedHighlights() {
    highlightUsed = 0;
    renderedCommittedRects.length = 0;
    for (var q = 0; q < queuedHighlights.length; q++) {
      var item = queuedHighlights[q];
      var div = highlightPool[highlightUsed];
      if (!div) {
        div = document.createElement('div');
        overlayNodes.add(div);
        highlightPool.push(div);
        highlightsLayerEl.appendChild(div);
      }
      highlightUsed += 1;
      var hoverClass = item.annId && item.annId === hoverHighlightId ? ' pn-hl-hover' : '';
      div.className = 'pn-hl ' + item.className + hoverClass;
      if (item.annId) {
        div.setAttribute('data-annotation-id', item.annId);
        renderedCommittedRects.push({
          id: item.annId,
          left: item.rect.left,
          top: item.rect.top,
          right: rectRight(item.rect),
          bottom: rectBottom(item.rect)
        });
      } else {
        div.removeAttribute('data-annotation-id');
      }
      div.style.display = 'block';
      div.style.left = item.rect.left + 'px';
      div.style.top = item.rect.top + 'px';
      div.style.width = (item.rect.width || 0) + 'px';
      div.style.height = (item.rect.height || 0) + 'px';
    }
    queuedHighlights.length = 0;
    hideUnusedHighlights();
  }
  function hideUnusedHighlights() {
    for (var i = highlightUsed; i < highlightPool.length; i++) {
      highlightPool[i].style.display = 'none';
    }
  }

  // --- Hover affordance for click-to-select ---
  // Pre-overlay, inline marks carried cursor:pointer + hover styling; overlay
  // rects are pointer-transparent, so hovering is detected by hit-testing the
  // rAF-throttled pointer against the CACHED rendered rects (bounding-box
  // checks only — no geometry reads) and toggling a class on that
  // annotation's rect divs inside the shadow root. Shadow-root writes are
  // unobserved by the page mutation observer, so no reconcile feedback loop,
  // and the rects stay pointer-events: none throughout.
  var hoverHighlightId = null;
  var hoverHitRaf = 0;
  var hoverHitPos = null;

  function committedHighlightIdAtCached(x, y) {
    var best = null;
    for (var i = 0; i < renderedCommittedRects.length; i++) {
      var r = renderedCommittedRects[i];
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      var area = (r.right - r.left) * (r.bottom - r.top);
      if (area <= 0) continue;
      // Smallest rect wins on overlap, matching the click hit-test.
      if (!best || area <= best.area) best = { id: r.id, area: area };
    }
    return best ? best.id : null;
  }

  function setHoverHighlight(id) {
    if (id === hoverHighlightId) return;
    hoverHighlightId = id;
    for (var i = 0; i < highlightUsed; i++) {
      var div = highlightPool[i];
      if (hoverHighlightId && div.getAttribute('data-annotation-id') === hoverHighlightId) {
        div.classList.add('pn-hl-hover');
      } else {
        div.classList.remove('pn-hl-hover');
      }
    }
  }

  function scheduleHoverHitTest(x, y) {
    hoverHitPos = { x: x, y: y };
    if (hoverHitRaf) return;
    hoverHitRaf = requestAnimationFrame(function() {
      hoverHitRaf = 0;
      if (!hoverHitPos) return;
      // Only drag mode without an open draft may paint the affordance: a
      // mode switch or draft opening between schedule and frame must not
      // resurrect a stale hover (flushQueuedHighlights re-applies whatever
      // hoverHighlightId holds on every render).
      if (currentInputMethod === 'pinpoint' || pendingPinEl || pendingSelection) return;
      setHoverHighlight(committedHighlightIdAtCached(hoverHitPos.x, hoverHitPos.y));
    });
  }

  // Full teardown for every "hover must die" transition (pinpoint switch,
  // draft open, pointer leave): cancels the pending rAF and clears the
  // tracked position so a scheduled hit test cannot re-apply the class.
  function clearHoverHighlight() {
    if (hoverHitRaf) {
      cancelAnimationFrame(hoverHitRaf);
      hoverHitRaf = 0;
    }
    hoverHitPos = null;
    setHoverHighlight(null);
  }

  document.addEventListener('mouseleave', function() {
    clearHoverHighlight();
  });

  function makeMarkerButton(annId) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pn-marker';
    btn.setAttribute('data-plannotator-marker', '');
    btn.setAttribute('data-annotation-id', annId);
    btn.innerHTML = MARKER_SVG + '<span class="pn-marker-num"></span>';
    btn.addEventListener('click', function(clickEvent) {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      parent.postMessage({ type: PREFIX + 'mark-click', id: annId }, '*');
    });
    overlayNodes.add(btn);
    return btn;
  }

  function placeMarkers(markers) {
    // Coincident markers (same rounded x:y) spread horizontally around the
    // shared point, ordered deterministically by (number, id). This is a
    // collision rule for coincident points only, not general label layout.
    var groups = new Map();
    var i;
    for (i = 0; i < markers.length; i++) {
      var m = markers[i];
      if (m.hidden) continue;
      var key = Math.round(m.x) + ':' + Math.round(m.y);
      var group = groups.get(key);
      if (!group) { group = []; groups.set(key, group); }
      group.push(m);
    }
    groups.forEach(function(group) {
      if (group.length < 2) return;
      group.sort(function(a, b) {
        if (a.number !== b.number) return a.number - b.number;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      var vw = layoutActive() ? window.innerWidth : 0;
      for (var gi = 0; gi < group.length; gi++) {
        var spreadX = group[gi].x + (gi - (group.length - 1) / 2) * MARKER_SPREAD_STEP;
        if (vw) spreadX = Math.max(MARKER_SPREAD_EDGE, Math.min(spreadX, vw - MARKER_SPREAD_EDGE));
        group[gi].x = spreadX;
      }
    });
    var usedKeys = {};
    for (i = 0; i < markers.length; i++) {
      var marker = markers[i];
      usedKeys[marker.key] = true;
      var btn = markerButtons.get(marker.key);
      if (marker.hidden) {
        // Unresolved or visually detached target: omit the marker rather
        // than leave a bubble floating over unrelated content.
        if (btn) btn.style.display = 'none';
        continue;
      }
      if (!btn) {
        btn = makeMarkerButton(marker.id);
        markerButtons.set(marker.key, btn);
        markersLayerEl.appendChild(btn);
      }
      btn.style.display = 'flex';
      btn.style.left = marker.x + 'px';
      btn.style.top = marker.y + 'px';
      btn.setAttribute('data-selected', focusedAnnotationId === marker.id ? 'true' : 'false');
      btn.setAttribute('aria-label', 'Comment ' + marker.number);
      var num = btn.querySelector('.pn-marker-num');
      if (num) num.textContent = String(marker.number);
    }
    markerButtons.forEach(function(btn, key) {
      if (usedKeys[key]) return;
      if (btn.parentNode) btn.parentNode.removeChild(btn);
      overlayNodes.delete(btn);
      markerButtons.delete(key);
    });
  }

  function renderAnnotationOverlay() {
    var hasDraftRange = !!(pendingSelection && pendingRange);
    if (!annRecords.length && !hasDraftRange && !overlayHostEl) {
      // Nothing to project, but total restore failures must still report:
      // a session whose only annotations failed to restore never builds the
      // overlay host, and silence here would hide exactly that case.
      emitUnanchored([]);
      return;
    }
    ensureOverlayHost();
    beginDeadSearchPass();
    queuedHighlights.length = 0;
    var unanchoredThisPass = [];
    var markers = [];
    // Fallback numbering by first-seen registration order — used only until
    // the parent's ordered sync arrives. Numbering NEVER derives from target
    // count: every target of one annotation shares one number.
    var fallbackNumbers = new Map();
    for (var f = 0; f < annRecords.length; f++) {
      if (!fallbackNumbers.has(annRecords[f].id)) {
        fallbackNumbers.set(annRecords[f].id, fallbackNumbers.size + 1);
      }
    }
    for (var recordIndex = 0; recordIndex < annRecords.length; recordIndex++) {
      var record = annRecords[recordIndex];
      refreshRecordTargets(record);
      // Live means connected/findable — clipped, offscreen, or style-hidden
      // targets are still anchored (their content exists; it just isn't
      // currently visible) and must not report as unanchored.
      var recordAnchored = false;
      for (var liveIndex = 0; liveIndex < record.targets.length; liveIndex++) {
        var liveTarget = record.targets[liveIndex];
        if (liveTarget.kind === 'element'
          ? (liveTarget.element && liveTarget.element.isConnected)
          : rangeAlive(liveTarget.range)) {
          recordAnchored = true;
          break;
        }
      }
      if (!recordAnchored) unanchoredThisPass.push(record.id);
      var number = annNumbers && annNumbers.has(record.id)
        ? annNumbers.get(record.id)
        : fallbackNumbers.get(record.id);
      var focused = focusedAnnotationId === record.id;
      // One PLACED marker per resolved element per record: two anchors of
      // one annotation re-resolving to the same element must not render two
      // coincident same-number markers that then spread apart. Dedup runs
      // among placed (visible) markers only — a target whose own point is
      // clipped away must not consume the element's slot and suppress a
      // sibling target whose point IS visible.
      var seenRecordElements = [];
      for (var targetIndex = 0; targetIndex < record.targets.length; targetIndex++) {
        var target = record.targets[targetIndex];
        var markerKey = record.id + '::' + targetIndex;
        if (target.kind === 'element') {
          var el = target.element;
          if (!el || !el.isConnected) {
            markers.push({ key: markerKey, id: record.id, number: number, hidden: true });
            continue;
          }
          var rect = el.getBoundingClientRect();
          if (rectOutsideViewport(rect)) {
            // Entirely off-viewport: the marker would be omitted and any
            // focus rect invisible — skip the style/clip reads outright.
            markers.push({ key: markerKey, id: record.id, number: number, hidden: true });
            continue;
          }
          var zeroSize = layoutActive() && !(rect.width || 0) && !(rect.height || 0);
          var styleHidden = !zeroSize && targetStyleHidden(el);
          var point = target.point || { x: 0.5, y: 0.5 };
          var placed = zeroSize || styleHidden ? null : markerViewportPoint(
            clippedTargetRect(el, rect),
            rect.left + point.x * (rect.width || 0),
            rect.top + point.y * (rect.height || 0)
          );
          if (placed && seenRecordElements.indexOf(el) >= 0) placed = null;
          if (placed) {
            seenRecordElements.push(el);
            markers.push({ key: markerKey, id: record.id, number: number, x: placed.x, y: placed.y });
            if (focused) {
              // The focus flash is a painted rect too: clip-test it like
              // every other highlight so it never flashes over content
              // outside the target's scroll container.
              var focusRect = clipRect(rect, clipBoundsFor(el));
              if (focusRect) takeHighlightRect('pn-hl-focus', focusRect, record.id);
            }
          } else {
            markers.push({ key: markerKey, id: record.id, number: number, hidden: true });
          }
        } else {
          if (rangeAlive(target.range)) {
            // Cull on the range's bounding rect BEFORE any per-rect work
            // (client-rect collection, clip-chain walks, computed styles).
            var rangeCullRect = null;
            try { rangeCullRect = target.range.getBoundingClientRect(); } catch (exCull) {}
            if (rangeCullRect && rectOutsideViewport(rangeCullRect)) {
              if (!target.markerless) {
                markers.push({ key: markerKey, id: record.id, number: number, hidden: true });
              }
              continue;
            }
          }
          var geometry = rangeVisualGeometry(target.range);
          for (var rectIndex = 0; rectIndex < geometry.paint.length; rectIndex++) {
            takeHighlightRect(
              record.annType === 'deletion' ? 'pn-hl-deletion' : 'pn-hl-comment',
              geometry.paint[rectIndex],
              record.id
            );
            if (focused) takeHighlightRect('pn-hl-focus', geometry.paint[rectIndex], record.id);
          }
          if (!target.markerless) {
            var rangePlaced = null;
            if (geometry.last && geometry.vis) {
              rangePlaced = markerViewportPoint(
                geometry.vis,
                rectRight(geometry.last),
                geometry.last.top + (geometry.last.height || 0) / 2
              );
            }
            if (rangePlaced) {
              markers.push({ key: markerKey, id: record.id, number: number, x: rangePlaced.x, y: rangePlaced.y });
            } else {
              markers.push({ key: markerKey, id: record.id, number: number, hidden: true });
            }
          }
        }
      }
    }
    // Draft selection highlight: overlay-projected rectangles from the live
    // pending range — the page's own DOM is never mutated for draft state.
    // Clip-tested like committed rects (M1): a draft inside a scrolled inner
    // container must not stripe content outside the container's box.
    if (hasDraftRange) {
      var draftCullRect = null;
      try { draftCullRect = pendingRange.getBoundingClientRect(); } catch (exDraftCull) {}
      if (!draftCullRect || !rectOutsideViewport(draftCullRect)) {
        var draftGeometry = rangeVisualGeometry(pendingRange);
        for (var draftIndex = 0; draftIndex < draftGeometry.paint.length; draftIndex++) {
          takeHighlightRect('pn-hl-draft', draftGeometry.paint[draftIndex], '');
        }
      }
    }
    // Write phase: every geometry read above is done before the first pool
    // style write lands (B2), so the pass costs one layout, not one per
    // record.
    flushQueuedHighlights();
    placeMarkers(markers);
    // Budget-starved passes reschedule below and may still revive targets,
    // so only a complete pass may update the unanchored report.
    if (!deadSearchSkipped) emitUnanchored(unanchoredThisPass);
    // Eligible dead-target searches skipped for budget get a follow-up pass;
    // the loop terminates once every eligible target has been attempted at
    // the current generation (its failedGeneration then blocks it).
    if (deadSearchSkipped) schedulePinpointReconcile();
  }

  function focusAnnotationRecord(id, flash) {
    if (focusFlashTimer) {
      clearTimeout(focusFlashTimer);
      focusFlashTimer = 0;
    }
    focusedAnnotationId = id || null;
    renderAnnotationOverlay();
    if (id && flash) {
      focusFlashTimer = setTimeout(function() {
        focusFlashTimer = 0;
        if (focusedAnnotationId === id) {
          focusedAnnotationId = null;
          renderAnnotationOverlay();
        }
      }, 2000);
    }
  }

  function scrollToAnnotation(id) {
    var record = findAnnRecord(id);
    if (!record) return;
    beginDeadSearchPass(Infinity); // user-initiated one-shot: never budget-starved
    refreshRecordTargets(record);
    var scrollEl = null;
    for (var i = 0; i < record.targets.length && !scrollEl; i++) {
      var target = record.targets[i];
      if (target.kind === 'element' && target.element && target.element.isConnected) {
        scrollEl = target.element;
      } else if (target.kind === 'range' && rangeAlive(target.range)) {
        var node = target.range.startContainer;
        scrollEl = node.nodeType === 1 ? node : node.parentElement;
      }
    }
    if (scrollEl) {
      try { scrollEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (ex) {}
    }
    focusAnnotationRecord(id, true);
  }

  // --- Element anchors: verified-unique CSS selectors for restoration ---
  // Semantic ladder (id → identity attribute → meaningful classes), each rung
  // proved unique with a real query before acceptance; positional
  // tag > tag:nth-of-type() path as the last resort. Restoration fails closed:
  // a weak (positional/class) selector must also match the captured text
  // snapshot, so a shifted list never mis-anchors an annotation.
  var ANCHOR_IDENTITY_ATTRS = ['data-annotate', 'data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa', 'aria-label', 'name', 'role', 'href', 'alt'];

  function anchorTextSnapshot(el) {
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return text.length > 180 ? text.slice(0, 180) : text;
  }

  function uniquelySelects(selector, el) {
    try {
      var matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === el;
    } catch (ex) {
      return false;
    }
  }

  function escapeAttrValue(value) {
    return '"' + value.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"';
  }

  function isLikelyGeneratedClass(name) {
    if (name.length > 36) return true;
    if (/^[a-f0-9]{8,}$/i.test(name)) return true;
    if (/[A-Za-z]+[_-][A-Za-z]*[0-9]{4,}/.test(name)) return true;
    return false;
  }

  function semanticSelectorFor(el) {
    var tag = el.tagName.toLowerCase();
    var canEscape = typeof CSS !== 'undefined' && CSS.escape;
    if (el.id && canEscape) {
      var idSel = '#' + CSS.escape(el.id);
      if (uniquelySelects(idSel, el)) return idSel;
    }
    for (var i = 0; i < ANCHOR_IDENTITY_ATTRS.length; i++) {
      var name = ANCHOR_IDENTITY_ATTRS[i];
      var value = el.getAttribute && el.getAttribute(name);
      if (!value) continue;
      value = value.trim();
      if (!value || value.length > 240 || value.indexOf('\\n') >= 0) continue;
      var attrSel = tag + '[' + name + '=' + escapeAttrValue(value) + ']';
      if (uniquelySelects(attrSel, el)) return attrSel;
    }
    if (canEscape && el.classList && el.classList.length) {
      var meaningful = [];
      for (var c = 0; c < el.classList.length && meaningful.length < 2; c++) {
        var cls = el.classList[c];
        if (isLikelyGeneratedClass(cls)) continue;
        meaningful.push('.' + CSS.escape(cls));
      }
      if (meaningful.length) {
        var classSel = tag + meaningful.join('');
        if (uniquelySelects(classSel, el)) return classSel;
      }
    }
    return null;
  }

  // Each ancestor step runs a document-wide uniqueness query against a
  // selector that grows with the path, so cost is quadratic in depth. Real
  // documents anchor within a few levels; a degenerate deeply-wrapped chain
  // (templated exports, generated markup) must not freeze the tab on a
  // single pinpoint click. Past the cap the anchor is abandoned (fail
  // closed): text-search restoration still works, and no anchor beats one
  // that costs seconds of synchronous main-thread time.
  var MAX_ANCHOR_PATH_DEPTH = 40;

  function buildAnchorSelector(el) {
    var path = [];
    var current = el;
    var depth = 0;
    while (current && current.nodeType === 1 && current !== document.body && current !== document.documentElement) {
      if (++depth > MAX_ANCHOR_PATH_DEPTH) return null;
      var semantic = semanticSelectorFor(current);
      if (semantic) {
        path.unshift(semantic);
        return path.join(' > ');
      }
      var segment = current.tagName.toLowerCase();
      var parentEl = current.parentElement;
      if (parentEl) {
        var sameTag = [];
        for (var i = 0; i < parentEl.children.length; i++) {
          if (parentEl.children[i].tagName === current.tagName) sameTag.push(parentEl.children[i]);
        }
        if (sameTag.length > 1) segment += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
      }
      path.unshift(segment);
      var candidate = path.join(' > ');
      if (uniquelySelects(candidate, el)) return candidate;
      current = parentEl;
    }
    // Reaching here means every candidate — including the full body-rooted
    // path — failed the uniqueness query. A known-ambiguous selector must not
    // ship as an anchor: no anchor (text-search restoration) beats one that
    // can bind to the wrong element after a re-render.
    return null;
  }

  function buildElementAnchor(el) {
    if (!el || el.nodeType !== 1) return null;
    var selector = buildAnchorSelector(el);
    if (!selector) return null;
    var snapshot = anchorTextSnapshot(el);
    // Text-less elements anchor ONLY through a stable-identity rung (#id or
    // an author-controlled data-* identity attribute). A weak (positional /
    // class) selector has nothing to verify against — identical siblings
    // share every structural trait, so any derived signature would validate
    // the WRONG element after a sibling is inserted or removed. A
    // wrong-binding anchor is worse than no anchor: ship none and fail
    // closed (the pin simply doesn't restore).
    if (!snapshot && !anchorHasStableIdentity(selector, el)) return null;
    return {
      selector: selector,
      tagName: el.tagName.toLowerCase(),
      text: snapshot
    };
  }

  // Stable identity: the selector IS the resolved element's own #id or data-*
  // rung, re-derived from the element itself and compared whole — never parsed
  // out of the selector string (an attribute value containing ' > ' or '#'
  // would fool a string parse). Behavioral attributes (role, href, aria-label,
  // name, alt) identify what an element does, not what it says, so they never
  // exempt an anchor from the text check: a regenerated page keeps its
  // role="button" while the button's meaning changes completely.
  var STABLE_IDENTITY_ATTRS = ['data-annotate', 'data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'];

  function anchorHasStableIdentity(selector, el) {
    var canEscape = typeof CSS !== 'undefined' && CSS.escape;
    if (el.id && canEscape && selector === '#' + CSS.escape(el.id)) return true;
    var tag = el.tagName.toLowerCase();
    for (var i = 0; i < STABLE_IDENTITY_ATTRS.length; i++) {
      var name = STABLE_IDENTITY_ATTRS[i];
      var value = el.getAttribute && el.getAttribute(name);
      if (!value) continue;
      if (selector === tag + '[' + name + '=' + escapeAttrValue(value.trim()) + ']') return true;
    }
    return false;
  }

  function resolveAnchorElement(anchor) {
    if (!anchor || typeof anchor.selector !== 'string' || !anchor.selector || typeof anchor.tagName !== 'string') return null;
    var matches;
    try {
      matches = document.querySelectorAll(anchor.selector);
    } catch (ex) {
      return null;
    }
    if (matches.length !== 1) return null;
    var el = matches[0];
    if (el.tagName.toLowerCase() !== anchor.tagName.toLowerCase()) return null;
    if (!anchorHasStableIdentity(anchor.selector, el)) {
      // Weak (positional / class / behavioral-attribute) anchor: the captured
      // text snapshot must exist and still match, or the anchor is rejected and
      // restoration falls back to text search. A missing or empty snapshot is a
      // rejection, not an exemption.
      if (typeof anchor.text !== 'string' || !anchor.text) return null;
      if (anchorTextSnapshot(el) !== anchor.text) return null;
    }
    return el;
  }

  function clearPendingPin() {
    pendingPinEl = null;
    pendingPinAnchor = null;
    pendingPinKey = null;
    pendingPinLabel = null;
    pendingPinPoint = null;
    pendingPinViaPinpoint = false;
    multiSelectArmed = false;
    hidePinpointBox();
  }

  /** Normalize a client-coordinate click into the element's rect (0..1 on
   *  each axis; zero-size axes read 0.5). This is the durable "selected
   *  point" a placed marker reprojects from after layout changes. */
  function normalizePointInElement(el, clientPoint) {
    if (!el || !clientPoint) return null;
    if (typeof clientPoint.x !== 'number' || typeof clientPoint.y !== 'number') return null;
    if (!isFinite(clientPoint.x) || !isFinite(clientPoint.y)) return null;
    if (!layoutActive()) return null; // no geometry to normalize against
    var r = el.getBoundingClientRect();
    var x = (r.width || 0) === 0 ? 0.5 : (clientPoint.x - r.left) / r.width;
    var y = (r.height || 0) === 0 ? 0.5 : (clientPoint.y - r.top) / r.height;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }

  // --- Multi-select (shift-click): several elements, ONE draft comment ---

  function makeTargetKey() {
    multiTargetSeq += 1;
    return 'ht-' + multiTargetSeq;
  }

  function anchorsEqual(a, b) {
    return !!a && !!b
      && a.selector === b.selector
      && a.tagName === b.tagName
      && (a.text || '') === (b.text || '');
  }

  // Per-target pinned outline boxes. The primary keeps the main pinpoint box;
  // each additional target gets its own (same attribute so the CSS applies,
  // identity-tracked in overlayNodes like every viewer overlay).
  function createMultiTargetBox(el) {
    var box = document.createElement('div');
    box.setAttribute('data-plannotator-pinpoint-box', '');
    box.setAttribute('data-plannotator-vim-ui', '');
    box.setAttribute('data-pinned', '');
    overlayNodes.add(box);
    document.body.appendChild(box);
    positionBoxToEl(box, el);
    return box;
  }

  function positionBoxToEl(box, el) {
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }

  function destroyMultiTargetBox(box) {
    if (!box) return;
    if (box.parentNode) box.parentNode.removeChild(box);
    overlayNodes.delete(box);
  }

  function clearMultiTargets() {
    for (var i = 0; i < pendingMultiTargets.length; i++) {
      destroyMultiTargetBox(pendingMultiTargets[i].box);
    }
    pendingMultiTargets = [];
    hideMultiHoverBox();
  }

  function positionMultiTargetBoxes() {
    for (var i = 0; i < pendingMultiTargets.length; i++) {
      var entry = pendingMultiTargets[i];
      if (entry.el && entry.el.isConnected) positionBoxToEl(entry.box, entry.el);
      else entry.box.style.display = 'none';
    }
  }

  // Element text for an additional target: same capping and text-less
  // description used by the primary element path in annotateElement.
  function elementTargetText(el, label) {
    var text = capSelectionText((el.textContent || '').trim());
    if (!text) text = capSelectionText('[element: ' + label + ']');
    return text;
  }

  /**
   * Remove one draft target by key. Removing the primary promotes the first
   * remaining additional target to primary (it commits as an element pin);
   * removing the final target cancels the whole draft. When echo is true
   * (bridge-initiated toggle-off) the removal is posted to the parent, which
   * performs the identical deterministic update on its chip list.
   */
  function removeMultiTargetByKey(key, echo) {
    if (!key) return;
    if (key === pendingPinKey) {
      if (!pendingMultiTargets.length) {
        // Last target gone — the draft is cancelled.
        pendingSelection = null;
        pendingRange = null;
        skipNextClear = false;
        clearMultiTargets();
        clearPendingPin();
        try { window.getSelection().removeAllRanges(); } catch (ex) {}
        renderAnnotationOverlay();
        if (echo) parent.postMessage({ type: PREFIX + 'multi-target-removed', key: key }, '*');
        return;
      }
      var next = pendingMultiTargets.shift();
      destroyMultiTargetBox(next.box);
      pendingPinEl = next.el;
      pendingPinAnchor = next.anchor;
      pendingPinKey = next.key;
      pendingPinLabel = next.label;
      pendingPinPoint = next.point || null;
      // A promoted primary commits as an element pin: the original text
      // selection belonged to the removed element and no longer applies.
      pendingSelection = { element: true };
      pendingRange = null;
      try { window.getSelection().removeAllRanges(); } catch (ex2) {}
      var mainBox = getPinpointBoxEl();
      mainBox.setAttribute('data-pinned', '');
      mainBox.classList.remove('pn-pin-enter');
      if (pendingPinEl && pendingPinEl.isConnected) positionPinpointBox(pendingPinEl);
      renderAnnotationOverlay();
      if (echo) parent.postMessage({ type: PREFIX + 'multi-target-removed', key: key }, '*');
      return;
    }
    for (var i = 0; i < pendingMultiTargets.length; i++) {
      if (pendingMultiTargets[i].key === key) {
        destroyMultiTargetBox(pendingMultiTargets[i].box);
        pendingMultiTargets.splice(i, 1);
        if (echo) parent.postMessage({ type: PREFIX + 'multi-target-removed', key: key }, '*');
        return;
      }
    }
  }

  /** Shift-click toggle: add the element to the draft, or remove it if it is
   *  already selected (dedup by DOM identity first, then by anchor equality
   *  so a re-rendered page cannot double-select the same logical element). */
  function toggleMultiTarget(el, clickPoint) {
    if (!el) return;
    if (el === pendingPinEl) {
      removeMultiTargetByKey(pendingPinKey, true);
      return;
    }
    for (var i = 0; i < pendingMultiTargets.length; i++) {
      if (pendingMultiTargets[i].el === el) {
        removeMultiTargetByKey(pendingMultiTargets[i].key, true);
        return;
      }
    }
    var anchor = buildElementAnchor(el);
    if (anchor) {
      if (anchorsEqual(anchor, pendingPinAnchor)) {
        removeMultiTargetByKey(pendingPinKey, true);
        return;
      }
      for (var j = 0; j < pendingMultiTargets.length; j++) {
        if (anchorsEqual(anchor, pendingMultiTargets[j].anchor)) {
          removeMultiTargetByKey(pendingMultiTargets[j].key, true);
          return;
        }
      }
    }
    // Cap at the source: never grow the draft past the parent-side DTO cap.
    if (pendingMultiTargets.length >= MAX_MULTI_TARGETS) return;
    var point = normalizePointInElement(el, clickPoint);
    if (anchor && point) anchor.point = point;
    var label = pinpointHoverLabel(el);
    var text = elementTargetText(el, label);
    var key = makeTargetKey();
    var box = createMultiTargetBox(el);
    pendingMultiTargets.push({ key: key, el: el, anchor: anchor, label: label, text: text, point: point, box: box });
    parent.postMessage({
      type: PREFIX + 'multi-target-added',
      key: key,
      label: label,
      text: text,
      anchor: anchor || undefined
    }, '*');
  }

  /** Chip hover in the composer: flash the corresponding pinned outline. */
  function flashMultiTarget(key) {
    var el = null;
    var box = null;
    if (key && key === pendingPinKey) {
      el = pendingPinEl;
      box = getPinpointBoxEl();
    } else {
      for (var i = 0; i < pendingMultiTargets.length; i++) {
        if (pendingMultiTargets[i].key === key) {
          el = pendingMultiTargets[i].el;
          box = pendingMultiTargets[i].box;
          break;
        }
      }
    }
    if (!el || !el.isConnected || !box) return;
    positionBoxToEl(box, el);
    box.classList.remove('pn-pin-enter');
    void box.offsetWidth; // restart the enter animation as the flash
    box.classList.add('pn-pin-enter');
    var r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (ex) {}
    }
  }

  // Shift-hover preview while a draft is pinned: shows what the next
  // shift-click would add. A separate box — the main one tracks the primary.
  var multiHoverBoxEl = null;
  function getMultiHoverBoxEl() {
    if (!multiHoverBoxEl) {
      multiHoverBoxEl = document.createElement('div');
      multiHoverBoxEl.setAttribute('data-plannotator-pinpoint-box', '');
      multiHoverBoxEl.setAttribute('data-plannotator-vim-ui', '');
      overlayNodes.add(multiHoverBoxEl);
    }
    if (!multiHoverBoxEl.isConnected) document.body.appendChild(multiHoverBoxEl);
    return multiHoverBoxEl;
  }
  function hideMultiHoverBox() {
    if (multiHoverBoxEl) multiHoverBoxEl.style.display = 'none';
  }
  function updateMultiHover(x, y, fallbackNode) {
    var el = pinpointLeafAt(x, y, fallbackNode);
    if (!el || el === pendingPinEl) { hideMultiHoverBox(); hidePinpointLabel(); return; }
    positionBoxToEl(getMultiHoverBoxEl(), el);
    positionPinpointLabel(el, pinpointHoverLabel(el));
  }

  // Composer-yield support: while a pinned draft is open the parent needs the
  // pointer position even though the pointer is inside this iframe (the
  // composer fades / becomes click-through as the pointer approaches it).
  var pointerRelayRaf = 0;
  var pointerRelayPos = null;
  function schedulePointerRelay(x, y, shift) {
    pointerRelayPos = { x: x, y: y, shift: !!shift };
    if (pointerRelayRaf) return;
    pointerRelayRaf = requestAnimationFrame(function() {
      pointerRelayRaf = 0;
      if (!pendingPinEl || !pointerRelayPos) return;
      parent.postMessage({
        type: PREFIX + 'pointer',
        x: pointerRelayPos.x,
        y: pointerRelayPos.y,
        shift: pointerRelayPos.shift
      }, '*');
    });
  }

  // Pin an element: select its text if possible (so a <mark> can wrap it), else
  // post its text + box directly so the toolbar still anchors (e.g. an SVG node,
  // whose <text> doesn't select like HTML text). Either way the element stays
  // outlined ("pinned") while the composer is open, and a serialized CSS anchor
  // rides along so the annotation can restore to this exact element later.
  function annotateElement(el, modeOverride, viaPinpoint, clickPoint) {
    if (!el) return false;
    pinpointHover = null;
    hidePinpointLabel();
    clearMultiTargets(); // a new primary starts a fresh draft
    // Arming is per-draft, never sticky: the parent re-arms via
    // arm-multi-select keyed to THIS draft's target key if (and only if) the
    // comment composer owns it. Without this reset, a mode switch between
    // drafts (comment -> quick label) leaves a stale arm and the bridge
    // accumulates pins the saved annotation will not carry.
    multiSelectArmed = false;
    pendingPinEl = el;
    pendingPinAnchor = buildElementAnchor(el);
    pendingPinKey = makeTargetKey();
    pendingPinLabel = pinpointHoverLabel(el);
    // The user's selected point, normalized inside the element's rect. It
    // rides the durable anchor so restoration reprojects the marker at the
    // same relative spot; keyboard entry (vim) has no pointer and defaults.
    pendingPinPoint = normalizePointInElement(el, clickPoint);
    if (pendingPinAnchor && pendingPinPoint) pendingPinAnchor.point = pendingPinPoint;
    pendingPinViaPinpoint = !!viaPinpoint;
    var extras = {
      anchor: pendingPinAnchor,
      pinpoint: !!viaPinpoint,
      targetKey: pendingPinKey,
      targetLabel: pendingPinLabel
    };
    // Pinned outline: stronger accent box that tracks the element until the
    // composer resolves (create-mark or cancel-selection).
    var box = getPinpointBoxEl();
    box.setAttribute('data-pinned', '');
    box.classList.remove('pn-pin-enter');
    positionPinpointBox(el);
    // SVG content can't hold an HTML <mark> wrapper — wrapping an SVG <text> in a
    // <mark> un-renders it (the text disappears). So never text-wrap SVG: treat it
    // as a whole-element annotation (post its text + box, no mark). HTML elements
    // still try a real text selection first so a <mark> can highlight the words.
    var txt = '';
    if (!el.ownerSVGElement) {
      try {
        var sel = window.getSelection();
        sel.removeAllRanges();
        var range = document.createRange();
        range.selectNodeContents(el);
        sel.addRange(range);
        txt = (sel.toString() || '').trim();
      } catch (ex) {}
    }
    if (txt) {
      var posted = handleSelection(modeOverride, extras);
      if (!posted) clearPendingPin();
      return posted;
    }
    var elText = capSelectionText((el.textContent || '').trim());
    // Text-less elements (icon buttons, decorative chips, empty containers)
    // are still annotatable: describe the element instead of quoting it.
    if (!elText) elText = capSelectionText('[element: ' + pinpointHoverLabel(el) + ']');
    var r = el.getBoundingClientRect();
    pendingSelection = { element: true };
    pendingRange = null;
    skipNextClear = true; // don't let this click's mouseup clear the toolbar we just opened
    parent.postMessage({ type: PREFIX + 'selection', text: elText,
      modeOverride: modeOverride || undefined,
      anchor: pendingPinAnchor || undefined,
      pinpoint: !!viaPinpoint || undefined,
      targetKey: pendingPinKey || undefined,
      targetLabel: pendingPinLabel || undefined,
      rect: { top: r.top, left: r.left, width: r.width, height: r.height } }, '*');
    return true;
  }

  document.addEventListener('click', function(e) {
    if (currentInputMethod !== 'pinpoint') return;
    // Real placed markers (and any other viewer overlay) own their clicks —
    // checked by IDENTITY, not selector, so a page element spoofing
    // [data-plannotator-marker] stays an ordinary annotatable target.
    if (isViewerOverlayNode(e.target)) return;
    // Shift-click while an ARMED pinpoint draft is open: toggle the element
    // in/out of the SAME draft comment instead of replacing the selection.
    // Unarmed drafts (modes the parent does not mirror, e.g. quickLabel)
    // treat shift-click exactly like a plain click.
    if (e.shiftKey && pendingPinEl && multiSelectArmed && pendingSelection) {
      e.preventDefault();
      e.stopPropagation();
      hideMultiHoverBox();
      hidePinpointLabel();
      var multiEl = resolvePinpointTargetAt(e.clientX, e.clientY, e.target);
      if (multiEl) toggleMultiTarget(multiEl, { x: e.clientX, y: e.clientY });
      return;
    }
    // Click what the hover box shows: the currently hovered element is the
    // target the user aimed at. Fall back to a fresh hit-test at the click
    // point (e.g. a click with no preceding mousemove).
    var el = pinpointHover && pinpointHover.isConnected
      ? pinpointHover
      : resolvePinpointTargetAt(e.clientX, e.clientY, e.target);
    if (!el) return;
    // Suppress the page's own behavior (links, buttons) — we're annotating.
    e.preventDefault();
    e.stopPropagation();
    annotateElement(el, undefined, true, { x: e.clientX, y: e.clientY });
  }, true);

  // Escape while pinpointing (outside vim, which has its own ladder): cancel a
  // pending pin, else just drop the hover outline.
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape' || vimEnabled) return;
    if (pendingSelection) {
      parent.postMessage({ type: PREFIX + 'selection-clear' }, '*');
      pendingSelection = null;
      pendingRange = null;
      skipNextClear = false;
      clearMultiTargets();
      clearPendingPin();
      window.getSelection().removeAllRanges();
      renderAnnotationOverlay();
    } else if (currentInputMethod === 'pinpoint') {
      clearPinpointHover();
    }
  });

  // Author opt-in: a plain click on any element tagged [data-annotate] pops the
  // toolbar — no pinpoint mode. Lets an HTML doc (e.g. a flow graph) wire its own
  // nodes to Plannotator's toolbar. Bubble phase so the page's own click handlers
  // run first; an active text selection is respected, not clobbered. A click on
  // a committed highlight selects the annotation instead (the pre-overlay
  // handler deferred to '.annotation-highlight' the same way).
  document.addEventListener('click', function(e) {
    if (currentInputMethod === 'pinpoint') return; // pinpoint handler covers this
    if (isViewerOverlayNode(e.target)) return; // placed markers own their clicks
    var t = e.target && e.target.closest && e.target.closest('[data-annotate]');
    if (!t) return;
    if (committedHighlightAt(e.clientX, e.clientY)) return; // mark-click handler owns it
    var s = window.getSelection();
    if (s && !s.isCollapsed && (s.toString() || '').trim()) return; // respect a drag-selection
    annotateElement(t, undefined, undefined, { x: e.clientX, y: e.clientY });
  });

  // --- Mark Click ---
  // Pre-overlay, committed highlights were inline marks with cursor:pointer
  // and their own click handler: clicking anywhere on a highlighted passage
  // posted mark-click and selected the annotation in the panel. Overlay
  // highlight rects are pointer-transparent (page pass-through must remain),
  // so the affordance is restored by hit-testing the click point against the
  // painted committed range rects. Bubble phase, exactly like the old
  // handler: the capture-phase pinpoint annotate click stopPropagation()s
  // first (pinpoint flows keep owning their clicks, as pre-overlay), and
  // marker buttons stop propagation before this can run.
  function committedHighlightAt(x, y) {
    var best = null;
    for (var recordIndex = 0; recordIndex < annRecords.length; recordIndex++) {
      var record = annRecords[recordIndex];
      for (var targetIndex = 0; targetIndex < record.targets.length; targetIndex++) {
        var target = record.targets[targetIndex];
        if (target.kind !== 'range' || !rangeAlive(target.range)) continue;
        var geometry = rangeVisualGeometry(target.range);
        for (var i = 0; i < geometry.paint.length; i++) {
          var rect = geometry.paint[i];
          if ((rect.width || 0) <= 0 || (rect.height || 0) <= 0) continue;
          if (x < rect.left || x > rectRight(rect) || y < rect.top || y > rectBottom(rect)) continue;
          var area = (rect.width || 0) * (rect.height || 0);
          // Smallest rect wins on overlap; ties go to the later-painted
          // (topmost) annotation.
          if (!best || area <= best.area) best = { id: record.id, area: area };
        }
      }
    }
    return best ? best.id : null;
  }

  document.addEventListener('click', function(e) {
    if (e.shiftKey) return; // shift belongs to multi-select
    if (isViewerOverlayNode(e.target)) return; // markers own their clicks
    if (pendingPinEl) return; // an open pinpoint draft owns the surface
    var s = window.getSelection();
    if (s && !s.isCollapsed && (s.toString() || '').trim()) return; // end of a drag-selection
    var hitId = committedHighlightAt(e.clientX, e.clientY);
    if (!hitId) return;
    e.stopPropagation();
    parent.postMessage({ type: PREFIX + 'mark-click', id: hitId }, '*');
  });

  // --- Optional Vim navigation ---
  // The bridge owns iframe-local ranges and focus. The parent only enables the
  // feature and receives the same selection messages used by pointer input.
  function isVimEditableTarget(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || !el.closest) return false;
    return !!el.closest('button,input,textarea,select,a[href],summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="textbox"],[role="dialog"],[data-plannotator-vim-ui]');
  }

  function prepareVimFocusOwner() {
    if (!document.body) return;
    document.body.setAttribute('data-plannotator-vim-focus-owner', '');
    if (!document.body.hasAttribute('tabindex')) {
      document.body.setAttribute('tabindex', '-1');
      vimAddedBodyTabIndex = true;
    }
  }

  function ensureVimFocus() {
    prepareVimFocusOwner();
    if (!document.body) return;
    try { document.body.focus({ preventScroll: true }); } catch (ex) {
      try { document.body.focus(); } catch (ignore) {}
    }
  }

  function getVimTextNodes(root) {
    var scope = root || document.body;
    if (!scope) return [];
    var nodes = [];
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        var parentEl = node.parentElement;
        if (!parentEl || !node.data || !node.data.length) return NodeFilter.FILTER_REJECT;
        if (parentEl.closest('script,style,noscript,input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[data-plannotator-vim-ui]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function nearestVisibleTextNode() {
    var nodes = getVimTextNodes();
    if (!nodes.length) return null;
    var centerY = window.innerHeight / 2;
    var best = nodes[0];
    var bestDistance = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var range = document.createRange();
      range.selectNodeContents(nodes[i]);
      var rect = range.getBoundingClientRect();
      if (!rect.height && !rect.width) continue;
      var distance = Math.abs((rect.top + rect.bottom) / 2 - centerY);
      if (distance < bestDistance) {
        best = nodes[i];
        bestDistance = distance;
      }
    }
    return best;
  }

  function setCollapsedSelection(node, offset) {
    if (!node) return false;
    var selection = window.getSelection();
    if (!selection) return false;
    var range = document.createRange();
    range.setStart(node, Math.max(0, Math.min(offset || 0, node.length || 0)));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function ensureVimTextCursor() {
    var selection = window.getSelection();
    if (selection && selection.rangeCount && selection.focusNode && document.body.contains(selection.focusNode)) {
      return true;
    }
    return setCollapsedSelection(nearestVisibleTextNode(), 0);
  }

  function currentVimPreciseTarget() {
    var graph = buildSemanticTargetGraph();
    var target = currentVimSemanticTarget(graph);
    return target && (target.kind === 'inline' || target.kind === 'row' || target.kind === 'cell')
      ? target.element
      : null;
  }

  function setVimSelectionFocus(selection, node, offset) {
    if (vimPhase === 'visual' && selection.anchorNode) {
      selection.setBaseAndExtent(
        selection.anchorNode,
        selection.anchorOffset,
        node,
        offset
      );
      return true;
    }
    return setCollapsedSelection(node, offset);
  }

  function clampVimSelectionToTarget(selection, target, direction) {
    if (!target || !selection) return false;
    if (selection.focusNode && target.contains(selection.focusNode)) return true;
    var nodes = getVimTextNodes(target);
    if (!nodes.length) return false;
    var boundaryNode = direction === 'backward' ? nodes[0] : nodes[nodes.length - 1];
    var boundaryOffset = direction === 'backward' ? 0 : boundaryNode.length;
    return setVimSelectionFocus(selection, boundaryNode, boundaryOffset);
  }

  function syncVimTargetToSelection(selection) {
    if (!selection || !selection.focusNode) return;
    var graph = buildSemanticTargetGraph();
    var resolved = resolveSemanticTarget(graph, selection.focusNode);
    if (resolved) vimPinpointEl = semanticOwningBlock(graph, resolved).element;
  }

  function modifyVimSelection(direction, granularity) {
    if (!ensureVimTextCursor()) return false;
    var selection = window.getSelection();
    if (!selection || typeof selection.modify !== 'function') return false;
    var preciseTarget = currentVimPreciseTarget();
    selection.modify(vimPhase === 'visual' ? 'extend' : 'move', direction, granularity);
    if (preciseTarget) clampVimSelectionToTarget(selection, preciseTarget, direction);
    else syncVimTargetToSelection(selection);
    updateVimUi();
    return true;
  }

  function vimTextPointForOffset(nodes, offset) {
    var remaining = Math.max(0, offset);
    for (var i = 0; i < nodes.length; i++) {
      if (remaining <= nodes[i].length) return { node: nodes[i], offset: remaining };
      remaining -= nodes[i].length;
    }
    var last = nodes[nodes.length - 1];
    return last ? { node: last, offset: last.length } : null;
  }

  function vimTextOffsetForPoint(nodes, node, offset) {
    var total = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] === node) return total + Math.max(0, Math.min(offset, nodes[i].length));
      total += nodes[i].length;
    }
    return null;
  }

  function moveVimWord(motion) {
    if (!ensureVimTextCursor()) return false;
    var selection = window.getSelection();
    var preciseTarget = currentVimPreciseTarget();
    var textTarget = preciseTarget || currentVimBlock();
    if (!selection || !selection.focusNode || !textTarget || !Intl.Segmenter) {
      return modifyVimSelection(motion === 'backward' ? 'backward' : 'forward', 'word');
    }
    var nodes = getVimTextNodes(textTarget);
    var focusOffset = vimTextOffsetForPoint(nodes, selection.focusNode, selection.focusOffset);
    if (focusOffset === null) return false;
    var text = nodes.map(function(node) { return node.data; }).join('');
    var words = Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text))
      .filter(function(segment) { return segment.isWordLike; });
    var targetOffset = null;
    if (motion === 'backward') {
      for (var i = words.length - 1; i >= 0; i--) {
        if (words[i].index < focusOffset) { targetOffset = words[i].index; break; }
      }
    } else if (motion === 'end') {
      for (var j = 0; j < words.length; j++) {
        var end = words[j].index + words[j].segment.length;
        if (end > focusOffset) { targetOffset = end; break; }
      }
    } else {
      for (var k = 0; k < words.length; k++) {
        if (words[k].index > focusOffset) { targetOffset = words[k].index; break; }
      }
    }
    if (targetOffset === null) {
      if (preciseTarget) {
        var boundaryNode = motion === 'backward' ? nodes[0] : nodes[nodes.length - 1];
        var boundaryOffset = motion === 'backward' ? 0 : boundaryNode.length;
        var movedToBoundary = setVimSelectionFocus(
          selection,
          boundaryNode,
          boundaryOffset
        );
        updateVimUi();
        return movedToBoundary;
      }
      return modifyVimSelection(motion === 'backward' ? 'backward' : 'forward', 'word');
    }
    var point = vimTextPointForOffset(nodes, targetOffset);
    if (!point) return false;
    setVimSelectionFocus(selection, point.node, point.offset);
    updateVimUi();
    return true;
  }

  function currentVimBlock() {
    var graph = buildSemanticTargetGraph();
    var selection = window.getSelection();
    var node = selection && selection.focusNode;
    var resolved = resolveSemanticTarget(graph, node);
    if (resolved && (vimPhase === 'text' || vimPhase === 'visual')) {
      return semanticOwningBlock(graph, resolved).element;
    }
    var semantic = currentVimSemanticTarget(graph);
    return semantic ? semanticOwningBlock(graph, semantic).element : null;
  }

  function selectVimBlock(block, resetAnchor) {
    if (!block) return false;
    if (resetAnchor !== false) vimVisualBlockAnchorEl = block;
    var range = document.createRange();
    range.selectNodeContents(block);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function vimBlocks() {
    return buildSemanticTargetGraph().blocks.map(function(target) {
      return target.element;
    });
  }

  function moveVimVisualBlock(delta) {
    var blocks = vimBlocks();
    if (!blocks.length) return false;
    var current = currentVimBlock();
    var index = blocks.indexOf(current);
    if (index < 0) index = 0;
    var nextIndex = Math.max(0, Math.min(blocks.length - 1, index + delta));
    var next = blocks[nextIndex];
    var anchor = vimVisualBlockAnchorEl || current || next;
    var anchorIndex = blocks.indexOf(anchor);
    if (anchorIndex < 0) {
      anchor = next;
      anchorIndex = nextIndex;
      vimVisualBlockAnchorEl = anchor;
    }
    var selection = window.getSelection();
    if (!selection) return false;
    var anchorTexts = getVimTextNodes(anchor);
    var nextTexts = getVimTextNodes(next);
    if (!anchorTexts.length || !nextTexts.length) return false;
    if (nextIndex >= anchorIndex) {
      selection.setBaseAndExtent(
        anchorTexts[0],
        0,
        nextTexts[nextTexts.length - 1],
        nextTexts[nextTexts.length - 1].length
      );
    } else {
      selection.setBaseAndExtent(
        anchorTexts[anchorTexts.length - 1],
        anchorTexts[anchorTexts.length - 1].length,
        nextTexts[0],
        0
      );
    }
    vimPinpointEl = next;
    next.scrollIntoView({ block: 'nearest' });
    updateVimUi();
    return true;
  }

  function moveVimDocumentBoundary(end) {
    var nodes = getVimTextNodes();
    if (!nodes.length) return false;
    var node = end ? nodes[nodes.length - 1] : nodes[0];
    var offset = end ? node.length : 0;
    var selection = window.getSelection();
    if (!selection) return false;
    if (vimPhase !== 'visual' || !selection.anchorNode) {
      setCollapsedSelection(node, offset);
    } else {
      selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, node, offset);
    }
    node.parentElement && node.parentElement.scrollIntoView({ block: 'nearest' });
    updateVimUi();
    return true;
  }

  function currentVimSemanticTarget(graph) {
    return vimPinpointEl ? graph.byElement.get(vimPinpointEl) || null : null;
  }

  function semanticVimPhase(target) {
    return target && (target.kind === 'inline' || target.kind === 'row' || target.kind === 'cell')
      ? 'inline'
      : 'block';
  }

  function setVimPinpointTarget(target) {
    clearPinpointHover();
    if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
    vimVisualBlockAnchorEl = null;
    vimPinpointEl = target ? target.element : null;
    if (vimPinpointEl) {
      vimPhase = semanticVimPhase(target);
      window.getSelection().removeAllRanges();
      vimPinpointEl.scrollIntoView({ block: 'nearest' });
      if (vimHudEnabled) {
        hidePinpointLabel();
      } else {
        vimPinpointEl.classList.add('plannotator-pinpoint-hover');
        var r = vimPinpointEl.getBoundingClientRect();
        var lbl = getPinpointLabelEl();
        lbl.textContent = target.label;
        lbl.style.display = 'block';
        lbl.style.top = Math.max(2, r.top - 22) + 'px';
        lbl.style.left = Math.max(2, r.left) + 'px';
      }
    } else {
      hidePinpointLabel();
    }
    updateVimUi();
  }

  function initialVimPinpointTarget() {
    var graph = buildSemanticTargetGraph();
    if (!graph.blocks.length) return null;
    var centerY = window.innerHeight / 2;
    var blocks = graph.blocks.slice();
    blocks.sort(function(a, b) {
      var ar = a.element.getBoundingClientRect();
      var br = b.element.getBoundingClientRect();
      return Math.abs((ar.top + ar.bottom) / 2 - centerY) - Math.abs((br.top + br.bottom) / 2 - centerY);
    });
    return blocks[0];
  }

  function moveVimPinpoint(delta, blocksOnly) {
    var graph = buildSemanticTargetGraph();
    if (!graph.blocks.length) return false;
    var current = currentVimSemanticTarget(graph) || initialVimPinpointTarget();
    if (!current) return false;

    if (vimPhase === 'inline' && !blocksOnly) {
      setVimPinpointTarget(semanticSibling(graph, current, delta));
      return true;
    }

    var block = semanticOwningBlock(graph, current);
    var index = graph.blocks.indexOf(block);
    if (index < 0) index = 0;
    var nextIndex = Math.max(0, Math.min(graph.blocks.length - 1, index + delta));
    setVimPinpointTarget(graph.blocks[nextIndex]);
    return true;
  }

  function refineVimPinpoint(inward) {
    var graph = buildSemanticTargetGraph();
    var current = currentVimSemanticTarget(graph);
    if (!current) {
      current = initialVimPinpointTarget();
      if (current) setVimPinpointTarget(current);
    }
    if (!current) return false;

    if (!inward) {
      var parent = semanticParent(graph, current);
      if (parent) {
        setVimPinpointTarget(parent);
        return true;
      }
      return true;
    }

    var child = semanticChildren(graph, current)[0];
    if (child) {
      setVimPinpointTarget(child);
      return true;
    }
    enterVimTextTarget(current);
    return true;
  }

  function enterVimTextTarget(target) {
    if (!target || !target.element) return false;
    var nodes = getVimTextNodes(target.element);
    if (!nodes.length) return false;
    if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
    hidePinpointLabel();
    vimVisualBlockAnchorEl = null;
    vimPinpointEl = target.element;
    vimPhase = 'text';
    setCollapsedSelection(nodes[0], 0);
    updateVimUi();
    return true;
  }

  function resetVimSemanticNavigation() {
    if (!vimEnabled) return;
    window.getSelection().removeAllRanges();
    setVimPinpointTarget(initialVimPinpointTarget());
  }

  function restoreVimSemanticTarget() {
    if (!vimEnabled) return;
    if (vimPhase === 'action' && restoreVimActionState()) return;
    var graph = buildSemanticTargetGraph();
    var target = currentVimSemanticTarget(graph) || initialVimPinpointTarget();
    if (target) setVimPinpointTarget(target);
    else {
      vimPinpointEl = null;
      vimPhase = 'inactive';
      hidePinpointLabel();
      updateVimUi();
    }
  }

  function rememberVimActionState() {
    var selection = window.getSelection();
    var range = selection && selection.rangeCount
      ? selection.getRangeAt(0).cloneRange()
      : null;
    vimActionReturn = {
      phase: vimPhase,
      pinpointEl: vimPinpointEl,
      visualBlockAnchorEl: vimVisualBlockAnchorEl,
      range: range
    };
  }

  function beginVimAction(mode) {
    if (mode === 'redline' && vimActionReturn) {
      if (vimActionReturn.phase === 'visual') {
        vimActionReturn.phase = 'text';
        if (vimActionReturn.range) vimActionReturn.range.collapse(false);
      } else if (vimActionReturn.phase === 'visual-block') {
        var graph = buildSemanticTargetGraph();
        var target = vimActionReturn.pinpointEl && graph.byElement.get(vimActionReturn.pinpointEl);
        vimActionReturn.phase = semanticVimPhase(target);
        vimActionReturn.visualBlockAnchorEl = null;
        vimActionReturn.range = null;
      }
    }
    vimPhase = 'action';
    updateVimUi();
  }

  function restoreVimActionState() {
    if (!vimActionReturn) return false;
    var saved = vimActionReturn;
    vimActionReturn = null;
    vimPinpointEl = saved.pinpointEl;
    vimVisualBlockAnchorEl = saved.visualBlockAnchorEl;

    if (saved.phase === 'block' || saved.phase === 'inline') {
      var graph = buildSemanticTargetGraph();
      var target = vimPinpointEl && graph.byElement.get(vimPinpointEl);
      if (target) {
        setVimPinpointTarget(target);
        return true;
      }
    }

    if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
    hidePinpointLabel();
    vimPhase = saved.phase;
    var selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      if (saved.range) {
        try { selection.addRange(saved.range); } catch (ex) {}
      }
    }
    updateVimUi();
    return true;
  }

  function getVimCursorEl() {
    var cursor = document.querySelector('[data-plannotator-vim-cursor]');
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.setAttribute('data-plannotator-vim-cursor', '');
      cursor.setAttribute('data-plannotator-vim-ui', '');
      overlayNodes.add(cursor);
      document.body.appendChild(cursor);
    }
    return cursor;
  }

  function getVimBadgeEl() {
    var badge = document.querySelector('[data-plannotator-vim-badge]');
    if (!badge) {
      badge = document.createElement('div');
      badge.setAttribute('data-plannotator-vim-badge', '');
      badge.setAttribute('data-plannotator-vim-ui', '');
      overlayNodes.add(badge);
      document.body.appendChild(badge);
    }
    return badge;
  }

  function getVimReticleEl() {
    var reticle = document.querySelector('[data-plannotator-vim-reticle]');
    if (reticle) return reticle;
    reticle = document.createElement('div');
    reticle.setAttribute('data-plannotator-vim-reticle', '');
    reticle.setAttribute('data-plannotator-vim-ui', '');
    reticle.innerHTML = [
      '<div data-vim-reticle-fill></div>',
      '<div data-vim-reticle-corner="top-left"></div>',
      '<div data-vim-reticle-corner="top-right"></div>',
      '<div data-vim-reticle-corner="bottom-left"></div>',
      '<div data-vim-reticle-corner="bottom-right"></div>',
      '<div data-vim-reticle-label></div>'
    ].join('');
    overlayNodes.add(reticle);
    document.body.appendChild(reticle);
    return reticle;
  }

  function hideVimReticle() {
    var reticle = document.querySelector('[data-plannotator-vim-reticle]');
    if (reticle) reticle.style.display = 'none';
  }

  function vimRangeRect(range) {
    if (!range) return null;
    var rects = [];
    if (typeof range.getClientRects === 'function') {
      try {
        var rangeRects = range.getClientRects();
        for (var rangeRectIndex = 0; rangeRectIndex < rangeRects.length; rangeRectIndex++) {
          rects.push(rangeRects[rangeRectIndex]);
        }
      } catch (ex) {}
    }
    var visible = rects.filter(function(rect) {
      return rect.width > 0 || rect.height > 0;
    });
    if (!visible.length) {
      if (typeof range.getBoundingClientRect !== 'function') return null;
      try {
        return range.getBoundingClientRect();
      } catch (ex) {
        return null;
      }
    }
    var left = Math.min.apply(null, visible.map(function(rect) { return rect.left; }));
    var top = Math.min.apply(null, visible.map(function(rect) { return rect.top; }));
    var right = Math.max.apply(null, visible.map(function(rect) { return rect.right; }));
    var bottom = Math.max.apply(null, visible.map(function(rect) { return rect.bottom; }));
    return { left: left, top: top, width: right - left, height: bottom - top };
  }

  function vimReticleSemanticDescriptor(target) {
    if (!target) return 'TARGET';
    if (target.kind === 'code') return 'CODE';
    if (target.kind === 'math') return 'FORMULA';
    if (target.kind === 'table') return 'TABLE';
    if (target.kind === 'row') return 'ROW';
    if (target.kind === 'cell') return 'CELL';
    return String(target.label || target.kind).split(':')[0].toUpperCase();
  }

  function vimReticleCursorDescriptor() {
    if (vimLastActionId === 'moveDown') return 'NEXT LINE';
    if (vimLastActionId === 'moveUp') return 'PREVIOUS LINE';
    if (vimLastActionId === 'previousTextBlock') return 'PREVIOUS BLOCK';
    if (vimLastActionId === 'nextTextBlock') return 'NEXT BLOCK';
    if (vimLastActionId === 'swapSelectionEnds') return 'SWAPPED ENDS';
    if (vimLastActionId === 'lineStart') return 'LINE START';
    if (vimLastActionId === 'lineEnd') return 'LINE END';
    if (vimLastActionId === 'wordForward') return 'NEXT WORD';
    if (vimLastActionId === 'wordBackward') return 'PREVIOUS WORD';
    if (vimLastActionId === 'wordEnd') return 'WORD END';
    if (vimLastActionId === 'previousTextBlock') return 'PREVIOUS TEXT';
    if (vimLastActionId === 'nextTextBlock') return 'NEXT TEXT';
    if (vimLastActionId === 'documentStart') return 'DOCUMENT START';
    if (vimLastActionId === 'documentEnd') return 'DOCUMENT END';
    if (vimLastActionId === 'moveOut') {
      return vimLastActionContext === 'text' || vimLastActionContext === 'visual'
        ? 'PREVIOUS CHARACTER'
        : 'TEXT';
    }
    if (vimLastActionId === 'refine') {
      return vimLastActionContext === 'text' || vimLastActionContext === 'visual'
        ? 'NEXT CHARACTER'
        : 'INLINE TEXT';
    }
    return 'TEXT';
  }

  function vimReticleVisualDescriptor(blockSelection) {
    if (blockSelection) return 'BLOCK RANGE';
    if (vimLastActionId === 'visual') return 'RANGE START';
    if (vimLastActionId === 'wordForward') return 'NEXT WORD';
    if (vimLastActionId === 'wordBackward') return 'PREVIOUS WORD';
    if (vimLastActionId === 'wordEnd') return 'EXACT TOKEN';
    if (vimLastActionId === 'lineStart') return 'TO LINE START';
    if (vimLastActionId === 'lineEnd') return 'TO LINE END';
    if (vimLastActionId === 'moveDown') return 'NEXT LINE';
    if (vimLastActionId === 'moveUp') return 'PREVIOUS LINE';
    return 'RANGE';
  }

  function vimReticleTarget() {
    var phase = vimPhase;
    var pinpointEl = vimPinpointEl;
    var savedRange = null;
    if (phase === 'action' && vimActionReturn) {
      phase = vimActionReturn.phase;
      pinpointEl = vimActionReturn.pinpointEl;
      savedRange = vimActionReturn.range;
    }

    if (phase === 'block' || phase === 'inline') {
      if (!pinpointEl) return null;
      var graph = buildSemanticTargetGraph();
      var target = graph.byElement.get(pinpointEl) || null;
      return {
        phase: phase,
        compact: false,
        rect: pinpointEl.getBoundingClientRect(),
        label: (phase === 'inline' ? 'INLINE' : 'BLOCK')
          + ' · ' + vimReticleSemanticDescriptor(target)
      };
    }

    var selection = window.getSelection();
    var range = savedRange;
    if (!range && selection && selection.rangeCount) {
      range = selection.getRangeAt(0);
    }
    if (!range) return null;

    if (phase === 'text') {
      var caretRange = range.cloneRange();
      caretRange.collapse(false);
      var caretRect = vimRangeRect(caretRange);
      if (!caretRect) return null;
      if (!caretRect.height) caretRect.height = 16;
      if (!caretRect.width) caretRect.width = 1;
      return {
        phase: phase,
        compact: true,
        rect: caretRect,
        label: 'CURSOR · ' + vimReticleCursorDescriptor()
      };
    }

    if (phase === 'visual' || phase === 'visual-block') {
      return {
        phase: phase,
        compact: false,
        rect: vimRangeRect(range),
        label: 'VISUAL · ' + vimReticleVisualDescriptor(phase === 'visual-block')
      };
    }
    return null;
  }

  function updateVimReticle() {
    if (!vimHudEnabled || vimPhase === 'inactive') {
      hideVimReticle();
      return;
    }
    var target = vimReticleTarget();
    if (!target || !target.rect) {
      hideVimReticle();
      return;
    }

    var rect = target.rect;
    var paddingX = target.compact ? 10 : 5;
    var paddingY = target.compact ? 6 : 4;
    var width = Math.max(44, rect.width + paddingX * 2);
    var height = Math.max(32, rect.height + paddingY * 2);
    var left = Math.max(0, rect.left + rect.width / 2 - width / 2);
    var top = Math.max(0, rect.top + rect.height / 2 - height / 2);
    var cornerSize = 28;
    var cornerRight = Math.max(0, width - cornerSize);
    var cornerBottom = Math.max(0, height - cornerSize);
    var labelTop = top - 36 >= 4 ? top - 36 : top + height + 6;
    var reticle = getVimReticleEl();
    var fill = reticle.querySelector('[data-vim-reticle-fill]');
    var label = reticle.querySelector('[data-vim-reticle-label]');
    var topLeft = reticle.querySelector('[data-vim-reticle-corner="top-left"]');
    var topRight = reticle.querySelector('[data-vim-reticle-corner="top-right"]');
    var bottomLeft = reticle.querySelector('[data-vim-reticle-corner="bottom-left"]');
    var bottomRight = reticle.querySelector('[data-vim-reticle-corner="bottom-right"]');

    reticle.style.display = 'block';
    reticle.setAttribute('data-vim-target-phase', target.phase);
    reticle.setAttribute('data-vim-target-label', target.label);
    fill.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0) scale('
      + (width / 100) + ',' + (height / 100) + ')';
    topLeft.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0)';
    topRight.style.transform = 'translate3d(' + (left + cornerRight) + 'px,' + top + 'px,0)';
    bottomLeft.style.transform = 'translate3d(' + left + 'px,' + (top + cornerBottom) + 'px,0)';
    bottomRight.style.transform = 'translate3d(' + (left + cornerRight) + 'px,'
      + (top + cornerBottom) + 'px,0)';
    label.textContent = target.label;
    label.style.transform = 'translate3d(' + left + 'px,' + labelTop + 'px,0)';
  }

  function updateVimUi() {
    if (!vimEnabled) return;
    if (vimHudEnabled && vimLastPostedPhase !== vimPhase) {
      vimLastPostedPhase = vimPhase;
      parent.postMessage({
        type: PREFIX + 'vim-state',
        phase: vimPhase
      }, '*');
    }
    var badge = document.querySelector('[data-plannotator-vim-badge]');
    if (!vimHudEnabled && !badge) badge = getVimBadgeEl();
    var cursor = getVimCursorEl();
    if (vimPhase === 'inactive') {
      if (badge) badge.style.display = 'none';
      cursor.style.display = 'none';
      hideVimReticle();
      return;
    }
    if (vimHudEnabled) {
      if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
      hidePinpointLabel();
      updateVimReticle();
    } else {
      hideVimReticle();
      if (vimPinpointEl && (vimPhase === 'block' || vimPhase === 'inline')) {
        vimPinpointEl.classList.add('plannotator-pinpoint-hover');
      }
    }
    if (badge) badge.style.display = vimHudEnabled ? 'none' : 'block';
    var phaseLabel = vimPhase === 'text' ? 'NORMAL' : vimPhase.toUpperCase().replace('-', ' ');
    if (badge) {
      badge.textContent = phaseLabel + ' · ' + (currentInputMethod === 'pinpoint' ? 'PINPOINT' : 'SELECT');
    }
    if (vimPhase !== 'text') {
      cursor.style.display = 'none';
      return;
    }
    var selection = window.getSelection();
    if (!selection || !selection.focusNode) {
      cursor.style.display = 'none';
      return;
    }
    var range = document.createRange();
    try {
      range.setStart(selection.focusNode, selection.focusOffset);
      range.collapse(true);
      var rect = range.getClientRects()[0] || range.getBoundingClientRect();
      cursor.style.display = 'block';
      cursor.style.left = rect.left + 'px';
      cursor.style.top = rect.top + 'px';
      cursor.style.height = (rect.height || 16) + 'px';
    } catch (ex) {
      cursor.style.display = 'none';
    }
  }

  var vimUiRaf = 0;
  function scheduleVimUiUpdate() {
    if (!vimEnabled || vimPhase === 'inactive' || vimUiRaf) return;
    vimUiRaf = requestAnimationFrame(function() {
      vimUiRaf = 0;
      updateVimUi();
    });
  }
  window.addEventListener('resize', scheduleVimUiUpdate, { passive: true });
  window.addEventListener('scroll', scheduleVimUiUpdate, { passive: true, capture: true });

  function toggleVimHelp() {
    vimHelpOpen = !vimHelpOpen;
    parent.postMessage({
      type: PREFIX + 'vim-help',
      open: vimHelpOpen
    }, '*');
  }

  function clearVimUi() {
    var nodes = document.querySelectorAll('[data-plannotator-vim-cursor],[data-plannotator-vim-badge],[data-plannotator-vim-reticle]');
    for (var i = 0; i < nodes.length; i++) nodes[i].remove();
    if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
    vimVisualBlockAnchorEl = null;
    vimActionReturn = null;
    hidePinpointLabel();
    vimHelpOpen = false;
    if (vimAddedBodyTabIndex && document.body) {
      document.body.removeAttribute('tabindex');
      vimAddedBodyTabIndex = false;
    }
    if (document.body) document.body.removeAttribute('data-plannotator-vim-focus-owner');
  }

  function copyVimText(text) {
    if (!text) return;
    parent.postMessage({
      type: PREFIX + 'vim-copy',
      text: text
    }, '*');
  }

  function vimActionMode(key) {
    // The iframe is an intentionally dependency-free sandbox. Keep these
    // command keys aligned with plan-review/vimSelection.shortcuts.ts, whose
    // scope owns the user-facing registry and parent-document dispatch.
    if (key === 'c') return 'comment';
    if (key === 'd') return 'redline';
    if (key === 't') return 'quickLabel';
    if (key === 'm' || key === ' ' || key === 'Space' || key === 'Spacebar') return 'selection';
    return null;
  }

  function vimActionIdForKey(key) {
    if (key === 'j') return 'moveDown';
    if (key === 'k') return 'moveUp';
    if (key === 'G') return 'documentEnd';
    if (key === 'h' || key === 'H') return 'moveOut';
    if (key === 'l') return 'refine';
    if (key === 'v') return 'visual';
    if (key === 'V') return 'visualBlock';
    if (key === 'w') return 'wordForward';
    if (key === 'b') return 'wordBackward';
    if (key === 'e') return 'wordEnd';
    if (key === '0') return 'lineStart';
    if (key === '$') return 'lineEnd';
    if (key === '{') return 'previousTextBlock';
    if (key === '}') return 'nextTextBlock';
    if (key === 'o') return 'swapSelectionEnds';
    if (key === 'Enter') return 'activeAnnotation';
    if (key === ' ' || key === 'Space' || key === 'Spacebar') return 'annotationMenu';
    if (key === 'c') return 'comment';
    if (key === 'd') return 'redline';
    if (key === 'm') return 'markup';
    if (key === 't') return 'label';
    if (key === 'y') return 'copy';
    if (key === 'Escape') return 'cancel';
    if (key === '?') return 'help';
    return null;
  }

  function handleVimKeydown(e) {
    if (!vimEnabled || isVimEditableTarget(e.target) || e.isComposing) return false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;

    var key = e.key;
    var handled = false;
    var hudKey = key;
    var vimCommandContext = vimPhase;
    var vimActionId = key === 'g' ? null : vimActionIdForKey(key);

    if (vimHelpOpen) {
      if (key === '?' || key === 'Escape') {
        toggleVimHelp();
        handled = true;
      }
    } else if (key === '?') {
      toggleVimHelp();
      handled = true;
    } else if (key === 'Escape') {
      if (pendingSelection) {
        parent.postMessage({ type: PREFIX + 'selection-clear' }, '*');
        pendingSelection = null;
        pendingRange = null;
        restoreVimSemanticTarget();
        renderAnnotationOverlay();
        handled = true;
      } else if (vimPhase === 'visual') {
        var visualSelection = window.getSelection();
        if (visualSelection && visualSelection.focusNode) {
          setCollapsedSelection(visualSelection.focusNode, visualSelection.focusOffset);
        }
        vimPhase = 'text';
        updateVimUi();
        handled = true;
      } else if (vimPhase === 'text' || vimPhase === 'visual-block' || vimPhase === 'action') {
        restoreVimSemanticTarget();
        handled = true;
      } else if (vimPhase === 'inline') {
        var escapeGraph = buildSemanticTargetGraph();
        var escapeTarget = currentVimSemanticTarget(escapeGraph);
        var escapeParent = escapeTarget && semanticParent(escapeGraph, escapeTarget);
        if (escapeParent) setVimPinpointTarget(escapeParent);
        else {
          if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
          vimPinpointEl = null;
          vimPhase = 'inactive';
          hidePinpointLabel();
          updateVimUi();
        }
        handled = true;
      } else if (vimPhase === 'block') {
        if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
        vimPinpointEl = null;
        vimPhase = 'inactive';
        hidePinpointLabel();
        window.getSelection().removeAllRanges();
        updateVimUi();
        handled = true;
      }
    } else if (pendingSelection) {
      // The parent toolbar/comment/label UI owns keys until it resolves.
      return false;
    } else if (key === 'g') {
      if (vimPendingG) {
        clearTimeout(vimPendingGTimer);
        vimPendingG = false;
        vimActionId = 'documentStart';
        hudKey = 'gg';
        if (vimPhase === 'text' || vimPhase === 'visual') moveVimDocumentBoundary(false);
        else {
          var firstGraph = buildSemanticTargetGraph();
          if (firstGraph.blocks.length) setVimPinpointTarget(firstGraph.blocks[0]);
        }
      } else {
        vimPendingG = true;
        vimPendingGTimer = setTimeout(function() { vimPendingG = false; }, 500);
      }
      handled = true;
    } else {
      if (vimPendingG) {
        clearTimeout(vimPendingGTimer);
        vimPendingG = false;
      }

      if (vimPhase === 'inactive') {
        setVimPinpointTarget(initialVimPinpointTarget());
      } else if (vimPhase === 'block' || vimPhase === 'inline') {
        var currentGraph = buildSemanticTargetGraph();
        if (!currentVimSemanticTarget(currentGraph)) {
          setVimPinpointTarget(initialVimPinpointTarget());
        }
      }

      if (vimPhase === 'block' || vimPhase === 'inline') {
        if (key === 'j') handled = moveVimPinpoint(1, false);
        else if (key === 'k') handled = moveVimPinpoint(-1, false);
        else if (key === '{') handled = moveVimPinpoint(-1, true);
        else if (key === '}') handled = moveVimPinpoint(1, true);
        else if (key === 'h' || key === 'H') handled = refineVimPinpoint(false);
        else if (key === 'l') handled = refineVimPinpoint(true);
        else if (key === 'G') {
          var lastGraph = buildSemanticTargetGraph();
          if (lastGraph.blocks.length) {
            setVimPinpointTarget(lastGraph.blocks[lastGraph.blocks.length - 1]);
            handled = true;
          }
        } else if (key === 'v') {
          var visualGraph = buildSemanticTargetGraph();
          var visualTarget = currentVimSemanticTarget(visualGraph);
          if (visualTarget && enterVimTextTarget(visualTarget)) {
            vimPhase = 'visual';
            updateVimUi();
            handled = true;
          }
        } else if (key === 'V') {
          var blockGraph = buildSemanticTargetGraph();
          var blockTarget = currentVimSemanticTarget(blockGraph);
          if (blockTarget) {
            var owningBlock = semanticOwningBlock(blockGraph, blockTarget);
            if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
            hidePinpointLabel();
            vimPinpointEl = owningBlock.element;
            vimPhase = 'visual-block';
            handled = selectVimBlock(owningBlock.element, true);
            updateVimUi();
          }
        } else if (key === 'y') {
          copyVimText(vimPinpointEl && vimPinpointEl.textContent || '');
          handled = !!vimPinpointEl;
        } else if (key === 'Enter' || vimActionMode(key)) {
          var semanticActionMode = key === 'Enter' ? vimActiveMode : vimActionMode(key);
          rememberVimActionState();
          var semanticActionStarted = vimPinpointEl
            ? annotateElement(vimPinpointEl, key === 'Enter' ? undefined : semanticActionMode)
            : false;
          if (semanticActionStarted) {
            beginVimAction(semanticActionMode);
          } else {
            vimActionReturn = null;
          }
          handled = semanticActionStarted;
        }
      } else if (vimPhase === 'text' || vimPhase === 'visual') {
        ensureVimTextCursor();
        var selection = window.getSelection();
        if (key === 'v') {
          vimPhase = vimPhase === 'visual' ? 'text' : 'visual';
          if (vimPhase === 'text' && selection && selection.focusNode) {
            setCollapsedSelection(selection.focusNode, selection.focusOffset);
          }
          updateVimUi();
          handled = true;
        } else if (key === 'V') {
          var currentBlock = currentVimBlock();
          if (currentBlock) {
            if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
            vimPinpointEl = currentBlock;
            vimPhase = 'visual-block';
            selectVimBlock(currentBlock, true);
            handled = true;
          }
          updateVimUi();
        } else if (key === 'o' && selection && !selection.isCollapsed) {
          selection.setBaseAndExtent(selection.focusNode, selection.focusOffset, selection.anchorNode, selection.anchorOffset);
          updateVimUi();
          handled = true;
        } else if (key === 'G') {
          handled = moveVimDocumentBoundary(true);
        } else if (key === 'h') handled = modifyVimSelection('backward', 'character');
        else if (key === 'l') handled = modifyVimSelection('forward', 'character');
        else if (key === 'j') handled = modifyVimSelection('forward', 'line');
        else if (key === 'k') handled = modifyVimSelection('backward', 'line');
        else if (key === 'w') handled = moveVimWord('forward');
        else if (key === 'b') handled = moveVimWord('backward');
        else if (key === 'e') handled = moveVimWord('end');
        else if (key === '0') handled = modifyVimSelection('backward', 'lineboundary');
        else if (key === '$') handled = modifyVimSelection('forward', 'lineboundary');
        else if (key === '{') handled = modifyVimSelection('backward', 'paragraph');
        else if (key === '}') handled = modifyVimSelection('forward', 'paragraph');
        else if (key === 'y' && selection && !selection.isCollapsed) {
          copyVimText(selection.toString());
          setCollapsedSelection(selection.focusNode, selection.focusOffset);
          vimPhase = 'text';
          updateVimUi();
          handled = true;
        } else if ((key === 'Enter' || vimActionMode(key)) && selection && !selection.isCollapsed) {
          var textActionMode = key === 'Enter' ? vimActiveMode : vimActionMode(key);
          rememberVimActionState();
          var textActionStarted = handleSelection(key === 'Enter' ? undefined : textActionMode);
          if (textActionStarted) {
            beginVimAction(textActionMode);
          } else {
            vimActionReturn = null;
          }
          handled = textActionStarted;
        }
      } else if (vimPhase === 'visual-block') {
        var blockSelection = window.getSelection();
        if (key === 'j' || key === 'k') {
          handled = moveVimVisualBlock(key === 'j' ? 1 : -1);
        } else if (key === 'V') {
          restoreVimSemanticTarget();
          handled = true;
        } else if (key === 'o' && blockSelection && !blockSelection.isCollapsed) {
          blockSelection.setBaseAndExtent(
            blockSelection.focusNode,
            blockSelection.focusOffset,
            blockSelection.anchorNode,
            blockSelection.anchorOffset
          );
          var previousBlockAnchor = vimVisualBlockAnchorEl;
          vimVisualBlockAnchorEl = vimPinpointEl;
          if (previousBlockAnchor) vimPinpointEl = previousBlockAnchor;
          handled = true;
        } else if (key === 'y' && blockSelection && !blockSelection.isCollapsed) {
          copyVimText(blockSelection.toString());
          restoreVimSemanticTarget();
          handled = true;
        } else if ((key === 'Enter' || vimActionMode(key)) && blockSelection && !blockSelection.isCollapsed) {
          var blockActionMode = key === 'Enter' ? vimActiveMode : vimActionMode(key);
          rememberVimActionState();
          var blockActionStarted = handleSelection(key === 'Enter' ? undefined : blockActionMode);
          if (blockActionStarted) {
            beginVimAction(blockActionMode);
          } else {
            vimActionReturn = null;
          }
          handled = blockActionStarted;
        }
      }
    }

    if (handled) {
      if (vimHudEnabled && vimActionId) {
        vimLastActionId = vimActionId;
        vimLastActionContext = vimCommandContext;
        updateVimReticle();
        parent.postMessage({
          type: PREFIX + 'vim-command',
          actionId: vimActionId,
          key: hudKey,
          context: vimCommandContext
        }, '*');
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    return handled;
  }

  document.addEventListener('keydown', handleVimKeydown, true);

  // Pointer input exits the keyboard-owned semantic state without synthesizing
  // focus or consuming the pointer event. Drag selection and Pinpoint clicking
  // then continue through their existing handlers.
  document.addEventListener('mousedown', function(e) {
    if (!vimEnabled || isVimEditableTarget(e.target)) return;
    clearPinpointHover();
    if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
    vimPinpointEl = null;
    vimVisualBlockAnchorEl = null;
    vimPhase = 'inactive';
    hidePinpointLabel();
    updateVimUi();
  }, true);

  // --- Type-to-comment ---
  // While a selection is pending, focus is inside this iframe, so the parent's
  // toolbar keydown listener never sees the keystroke. Forward a single printable
  // char to the parent so it can open a comment pre-filled with it.
  document.addEventListener('keydown', function(e) {
    if (!pendingSelection) return;
    if (isVimEditableTarget(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!e.key || e.key.length !== 1) return; // single printable char only
    e.preventDefault();
    parent.postMessage({ type: PREFIX + 'keytype', key: e.key }, '*');
    // Hand keyboard focus back to the parent window so the comment textarea can
    // take it. Blurring the <iframe> from the parent isn't enough — the inner
    // document keeps focus — so the iframe must relinquish it. parent.focus() is
    // allowed cross-origin (like postMessage); also drop the active element.
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (ex) {}
    try { parent.focus(); } catch (ex) {}
  });

  // --- Helpers ---

  function getNodePath(node) {
    var path = [];
    while (node && node !== document.body) {
      if (node.parentNode) {
        var siblings = node.parentNode.childNodes;
        var idx = 0;
        for (var i = 0; i < siblings.length; i++) {
          if (siblings[i] === node) { idx = i; break; }
        }
        path.unshift(idx);
      }
      node = node.parentNode;
    }
    return path;
  }

  function resolveNodePath(path) {
    var node = document.body;
    for (var i = 0; i < path.length; i++) {
      if (!node.childNodes[path[i]]) return null;
      node = node.childNodes[path[i]];
    }
    return node;
  }

  // Framework rerenders and inline edits invalidate resolved geometry.
  // Coalesced through the same rAF reconcile as scroll/resize — never polled.
  // Mutations whose targets are all viewer overlay nodes are ignored by
  // IDENTITY: our own light-DOM box/label style writes must never schedule
  // the frame that caused them (that would degenerate into a rAF loop).
  var pageMutationObserver = null;

  // A mutation is viewer-owned when its target is an overlay node OR it is a
  // childList change whose added/removed nodes are ALL overlay nodes (the
  // overlay host / hover label / print layer being appended to the root
  // element, pinned boxes entering <body>). Those writes must neither bump
  // the re-search generation nor schedule the reconcile frame that caused
  // them.
  function isOverlayOnlyMutation(mutation) {
    if (isViewerOverlayNode(mutation.target)) return true;
    if (mutation.type !== 'childList') return false;
    var added = mutation.addedNodes || [];
    var removed = mutation.removedNodes || [];
    if (!added.length && !removed.length) return false;
    for (var i = 0; i < added.length; i++) {
      if (!isViewerOverlayNode(added[i])) return false;
    }
    for (var j = 0; j < removed.length; j++) {
      if (!isViewerOverlayNode(removed[j])) return false;
    }
    return true;
  }

  // Zero-work observer gate (B4): with no committed records, no pending
  // draft, and pinpoint inactive there is nothing for the reconcile pass to
  // do, so a page mutation should not schedule one. The generation bump
  // still happens — a record registered later must see the mutations that
  // occurred while the overlay was idle.
  function reconcileHasWork() {
    return annRecords.length > 0
      || !!pendingSelection
      || !!pendingPinEl
      || pendingMultiTargets.length > 0
      || currentInputMethod === 'pinpoint';
  }

  function watchPageMutations() {
    if (pageMutationObserver || typeof MutationObserver === 'undefined' || !document.documentElement) return;
    pageMutationObserver = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (!isOverlayOnlyMutation(mutations[i])) {
          domGeneration += 1; // page text may have changed: unlock dead-target re-search
          if (reconcileHasWork()) schedulePinpointReconcile();
          return;
        }
      }
    });
    // Observe the ROOT element, not <body>: a page that swaps the <body>
    // element itself (documentElement.replaceChild) produces no record on a
    // body-scoped observer, permanently locking dead-target re-search behind
    // a generation that never advances.
    pageMutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  }

  // Animations/transitions move geometry without mutations or scroll events:
  // reconcile when they settle (end or cancel), matching the reference
  // invalidation set. Capture phase so non-bubbling targets still count.
  // Viewer-owned light-DOM chrome (pin-enter, vim reticle) settling is
  // identity-filtered out: our own overlay animations must never schedule
  // redundant reconciles of the frames they themselves caused.
  var settleEvents = ['animationend', 'animationcancel', 'transitionend', 'transitioncancel'];
  for (var settleIndex = 0; settleIndex < settleEvents.length; settleIndex++) {
    document.addEventListener(settleEvents[settleIndex], function(e) {
      if (e && e.target && isViewerOverlayNode(e.target)) return;
      domGeneration += 1; // a settled page animation can land text-affecting state
      schedulePinpointReconcile();
    }, { capture: true, passive: true });
  }

  // Reflow WITHOUT mutation/scroll/animation still moves geometry: a web-font
  // swap or an image loading into a fixed-height container reflows silently.
  // Both change GEOMETRY, not text — they schedule a reconcile but never bump
  // the re-search generation (a dead target stays dead through them).
  if (
    document.fonts
    && document.fonts.ready
    && typeof document.fonts.ready.then === 'function'
  ) {
    document.fonts.ready.then(function() { schedulePinpointReconcile(); }).catch(function() {});
  }
  document.addEventListener('load', function(e) {
    if (!e || !e.target || e.target === document || isViewerOverlayNode(e.target)) return;
    // A (same-origin) frame load is a text-capable invalidation; image and
    // media loads are geometry-only.
    var tag = e.target.tagName || '';
    if (tag === 'IFRAME' || tag === 'FRAME') domGeneration += 1;
    schedulePinpointReconcile();
  }, { capture: true, passive: true });

  // --- Print parity ---
  // Pre-overlay, inline annotation marks stayed visible in print ON PURPOSE
  // (matching markdown documents); only pin badges were print-hidden. The
  // fixed overlay cannot paginate (fixed-position layers repeat or clip per
  // printed page), so print parity is restored by re-projecting the
  // committed highlight rects into a temporary ABSOLUTE-positioned light-DOM
  // layer in document coordinates (viewport rect + scroll offset), appended
  // to <body> so it paginates with the content. Markers stay print-hidden —
  // badges were print-hidden pre-overlay too; parity is highlights-print,
  // markers-don't. Fail-safe: any error tears the layer down and printing
  // proceeds without annotation visuals.
  var PRINT_HL_COMMENT = 'background:oklch(0.70 0.18 60 / 0.28);border-bottom:2px solid var(--pn-accent, #d97757);';
  var PRINT_HL_DELETION = 'background:oklch(from var(--pn-destructive, #c0392b) l c h / 0.28);background-image:linear-gradient(to bottom, transparent calc(50% - 1px), var(--pn-destructive, #c0392b) calc(50% - 1px), var(--pn-destructive, #c0392b) calc(50% + 1px), transparent calc(50% + 1px));';
  var printLayerEl = null;
  var retiredPrintLayerEl = null;

  function teardownPrintLayer() {
    // Deregister the PREVIOUSLY retired layer now: its removal's mutation
    // record has long been delivered. The layer removed below must STAY
    // overlay-registered until then — the observer's overlay-only filter
    // sees removal records asynchronously and must still recognize the node.
    if (retiredPrintLayerEl) {
      overlayNodes.delete(retiredPrintLayerEl);
      retiredPrintLayerEl = null;
    }
    if (!printLayerEl) return;
    try {
      if (printLayerEl.parentNode) printLayerEl.parentNode.removeChild(printLayerEl);
    } catch (ex) {}
    retiredPrintLayerEl = printLayerEl;
    printLayerEl = null;
  }

  function buildPrintLayer() {
    teardownPrintLayer();
    try {
      if (!annRecords.length || !document.body) return;
      var layer = document.createElement('div');
      layer.setAttribute('data-plannotator-print-layer', '');
      layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;';
      var sx = window.scrollX || 0;
      var sy = window.scrollY || 0;
      // User-initiated one-shot: printing has no follow-up pass, so a budget
      // here would silently print fewer highlights with 3+ dead targets.
      beginDeadSearchPass(Infinity);
      for (var recordIndex = 0; recordIndex < annRecords.length; recordIndex++) {
        var record = annRecords[recordIndex];
        refreshRecordTargets(record);
        for (var targetIndex = 0; targetIndex < record.targets.length; targetIndex++) {
          var target = record.targets[targetIndex];
          if (target.kind !== 'range' || !rangeAlive(target.range)) continue;
          var geometry = rangeVisualGeometry(target.range);
          for (var i = 0; i < geometry.paint.length; i++) {
            var rect = geometry.paint[i];
            var div = document.createElement('div');
            div.style.cssText = 'position:absolute;pointer-events:none;border-radius:2px;box-sizing:border-box;'
              + (record.annType === 'deletion' ? PRINT_HL_DELETION : PRINT_HL_COMMENT);
            div.style.left = (rect.left + sx) + 'px';
            div.style.top = (rect.top + sy) + 'px';
            div.style.width = (rect.width || 0) + 'px';
            div.style.height = (rect.height || 0) + 'px';
            layer.appendChild(div);
          }
        }
      }
      if (!layer.childNodes.length) return;
      overlayNodes.add(layer);
      printLayerEl = layer;
      // Root element, NOT <body>: a page styling body { position: relative }
      // would make body's padding box the containing block and shift every
      // stripe by body's document offset. On <html> the containing block is
      // the initial containing block (matching the viewport+scroll
      // coordinates computed above) in the overwhelmingly common case where
      // html itself is not positioned; a positioned documentElement is
      // accepted as out of scope.
      (document.documentElement || document.body).appendChild(layer);
    } catch (exBuild) {
      try { teardownPrintLayer(); } catch (exDown) {}
    }
  }

  window.addEventListener('beforeprint', buildPrintLayer);
  window.addEventListener('afterprint', teardownPrintLayer);
  if (typeof window.matchMedia === 'function') {
    // Safari fires the print media-query transition without beforeprint in
    // some paths; mirror the layer lifecycle on it.
    try {
      var printMedia = window.matchMedia('print');
      var onPrintMediaChange = function(mediaEvent) {
        if (mediaEvent && mediaEvent.matches) buildPrintLayer();
        else teardownPrintLayer();
      };
      if (printMedia.addEventListener) printMedia.addEventListener('change', onPrintMediaChange);
      else if (printMedia.addListener) printMedia.addListener(onPrintMediaChange);
    } catch (exMedia) {}
  }

  function onReady() {
    if (typeof ResizeObserver !== 'undefined' && document.body) {
      new ResizeObserver(function() {
        postResize();
        scheduleVimUiUpdate();
        schedulePinpointReconcile();
      }).observe(document.body);
    }
    watchPageMutations();
    parent.postMessage({ type: PREFIX + 'ready' }, '*');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }

  // Test-only introspection: the DOM suites assert committed-range EXTENT
  // (which exact text a committed annotation's range binds), which has no
  // other observable in the overlay model. Exposes nothing the same-realm
  // page could not already derive — the overlay root is open, highlight
  // geometry mirrors the ranges, and the text is the page's own content.
  window.__plannotatorBridgeInternals = {
    committedRanges: function(id) {
      var record = findAnnRecord(id);
      if (!record) return [];
      var out = [];
      for (var i = 0; i < record.targets.length; i++) {
        var target = record.targets[i];
        if (target.kind === 'range' && target.range) {
          try { out.push(target.range.cloneRange()); } catch (ex) {}
        }
      }
      return out;
    }
  };
})();`;
