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

export const ANNOTATION_HIGHLIGHT_CSS = `
.annotation-highlight {
  border-radius: 2px;
  padding: 0 2px;
  margin: 0 -2px;
  cursor: pointer;
}
.annotation-highlight.deletion {
  background: oklch(from var(--destructive, #c0392b) l c h / 0.35);
  text-decoration: line-through;
  text-decoration-color: var(--destructive, #c0392b);
  text-decoration-thickness: 2px;
}
.annotation-highlight.comment {
  background: oklch(0.70 0.18 60 / 0.3);
  border-bottom: 2px solid var(--accent, #d97757);
}
.annotation-highlight.focused {
  background: oklch(from var(--focus-highlight, #4493f8) l c h / 0.45) !important;
  box-shadow: 0 0 8px oklch(from var(--focus-highlight, #4493f8) l c h / 0.4);
  border-bottom: 2px solid var(--focus-highlight, #4493f8);
  filter: none;
}
.annotation-highlight:hover {
  filter: brightness(1.2);
}
.plannotator-pinpoint-hover {
  outline: 2px solid var(--focus-highlight, #4493f8) !important;
  outline-offset: 1px;
  cursor: crosshair !important;
}
/* SVG nodes can't take a CSS outline — stroke their shapes instead. */
.plannotator-pinpoint-hover rect, .plannotator-pinpoint-hover path,
.plannotator-pinpoint-hover circle, .plannotator-pinpoint-hover ellipse, .plannotator-pinpoint-hover polygon {
  stroke: var(--focus-highlight, #4493f8) !important; stroke-width: 2.5px !important;
}
`;

export const BRIDGE_SCRIPT = `(function() {
  var PREFIX = 'plannotator-bridge-';

  // --- Theme ---
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== PREFIX + 'theme') return;
    var root = document.documentElement;
    var tokens = e.data.tokens;
    for (var key in tokens) {
      if (tokens.hasOwnProperty(key)) root.style.setProperty(key, tokens[key]);
    }
    root.classList.remove('light');
    if (e.data.isLight) root.classList.add('light');
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
  var currentInputMethod = 'drag'; // 'drag' = text selection, 'pinpoint' = click an element
  var pinpointHover = null;
  // A plain click on an element-annotation target opens the toolbar, but the same
  // click's mouseup schedules a handleSelection() that would see an empty selection
  // and immediately clear it. This flag suppresses that one trailing clear.
  var skipNextClear = false;

  document.addEventListener('mouseup', function(e) {
    if (currentInputMethod === 'pinpoint') return; // pinpoint uses click, not drag-select
    if (e.target && e.target.closest && e.target.closest('.annotation-highlight')) return;
    setTimeout(handleSelection, 10);
  });

  function handleSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      // Trailing clear from a plain-click element annotation — consume it once.
      if (skipNextClear) { skipNextClear = false; return; }
      if (pendingSelection) {
        parent.postMessage({ type: PREFIX + 'selection-clear' }, '*');
        pendingSelection = null;
        pendingRange = null;
      }
      return;
    }
    skipNextClear = false; // a real text selection happened
    var range = sel.getRangeAt(0);
    var text = sel.toString().trim();
    if (!text) return;

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
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    }, '*');
  }

  // Keep the toolbar/popover attached while the iframe content scrolls: re-post the
  // pending selection's live rect (parent has no way to see an in-iframe scroll).
  // Capture phase so inner scroll containers count too.
  var scrollRaf = 0;
  function postSelectionRect() {
    scrollRaf = 0;
    if (!pendingSelection || !pendingRange) return;
    var r = pendingRange.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      // Selection scrolled out of view — close the toolbar (matches markdown).
      parent.postMessage({ type: PREFIX + 'selection-clear' }, '*');
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
    if (!e.data || !e.data.type) return;
    var type = e.data.type;

    if (type === PREFIX + 'create-mark') {
      var id = e.data.id;
      var annType = e.data.annotationType || 'comment';
      if (pendingSelection) {
        // Text selections wrap a <mark>; element pinpoints (e.g. SVG nodes) carry
        // no range, so there's no inline mark to apply — the annotation is still
        // captured on the parent side from the posted text.
        if (pendingSelection.startContainerPath) applyMark(id, annType, pendingSelection);
        pendingSelection = null;
        pendingRange = null;
        window.getSelection().removeAllRanges();
      }
    }

    else if (type === PREFIX + 'find-and-mark') {
      var found = findTextAndMark(e.data.id, e.data.originalText, e.data.annotationType || 'comment');
      parent.postMessage({
        type: PREFIX + 'mark-applied',
        id: e.data.id,
        success: found
      }, '*');
    }

    else if (type === PREFIX + 'remove-mark') {
      removeMark(e.data.id);
    }

    else if (type === PREFIX + 'clear-marks') {
      var marks = document.querySelectorAll('.annotation-highlight[data-bind-id]');
      for (var i = marks.length - 1; i >= 0; i--) unwrapMark(marks[i]);
    }

    else if (type === PREFIX + 'scroll-to') {
      var mark = document.querySelector('[data-bind-id="' + e.data.id + '"]');
      if (mark) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        mark.classList.add('focused');
        setTimeout(function() { mark.classList.remove('focused'); }, 2000);
      }
    }

    else if (type === PREFIX + 'focus-mark') {
      var all = document.querySelectorAll('.annotation-highlight');
      for (var j = 0; j < all.length; j++) all[j].classList.remove('focused');
      if (e.data.id) {
        var target = document.querySelector('[data-bind-id="' + e.data.id + '"]');
        if (target) target.classList.add('focused');
      }
    }

    else if (type === PREFIX + 'set-input-method') {
      currentInputMethod = e.data.method === 'pinpoint' ? 'pinpoint' : 'drag';
      if (currentInputMethod !== 'pinpoint') {
        if (pinpointHover) { pinpointHover.classList.remove('plannotator-pinpoint-hover'); pinpointHover = null; }
        if (pinpointLabelEl) pinpointLabelEl.style.display = 'none';
      }
    }
  });

  // --- Pinpoint: hover to outline a whole element, click to select its text ---
  // Reuses the normal selection pipeline — a pinpoint click just sets the iframe
  // selection over the element's text, then runs handleSelection() like a drag.
  var PINPOINT_SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, HTML: 1, BODY: 1, HEAD: 1 };
  var PINPOINT_INLINE = { A: 1, SPAN: 1, EM: 1, STRONG: 1, B: 1, I: 1, CODE: 1, SMALL: 1, LABEL: 1, MARK: 1, SUP: 1, SUB: 1, U: 1, ABBR: 1, TIME: 1 };

  function resolvePinpointEl(node) {
    var el = node;
    while (el && el.nodeType === 3) el = el.parentNode; // text node -> parent
    if (!el || el.nodeType !== 1) return null;
    // SVG: a click on a shape/text leaf (rect, path, text) resolves to the whole
    // node group, so clicking anywhere on an SVG node — not just its label — picks it.
    if (el.ownerSVGElement && el.closest) {
      var g = el.closest('g');
      if (g && g.textContent && g.textContent.trim()) el = g;
    }
    if (PINPOINT_SKIP[el.tagName]) return null;
    // Climb out of inline elements to their containing block.
    while (el.parentElement && PINPOINT_INLINE[el.tagName] && !PINPOINT_SKIP[el.parentElement.tagName]) {
      el = el.parentElement;
    }
    if (PINPOINT_SKIP[el.tagName]) return null;
    if (!el.textContent || !el.textContent.trim()) return null; // need text to annotate
    return el;
  }

  // Floating label naming the element under the cursor (like the markdown overlay).
  var PINPOINT_LABELS = { H1:'Heading', H2:'Heading', H3:'Heading', H4:'Heading', H5:'Heading', H6:'Heading', P:'Paragraph', UL:'List', OL:'List', LI:'List item', A:'Link', BUTTON:'Button', IMG:'Image', TABLE:'Table', THEAD:'Table', TBODY:'Table', TR:'Row', TD:'Cell', TH:'Header cell', SECTION:'Section', NAV:'Navigation', HEADER:'Header', FOOTER:'Footer', ARTICLE:'Article', ASIDE:'Sidebar', BLOCKQUOTE:'Quote', PRE:'Code', CODE:'Code', FIGURE:'Figure', FIGCAPTION:'Caption', MAIN:'Main', FORM:'Form', INPUT:'Input', LABEL:'Label' };
  var pinpointLabelEl = null;
  function getPinpointLabelEl() {
    if (!pinpointLabelEl) {
      pinpointLabelEl = document.createElement('div');
      pinpointLabelEl.setAttribute('data-plannotator-pinpoint-label', '');
      pinpointLabelEl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;font:600 11px/1.3 system-ui,-apple-system,sans-serif;padding:2px 7px;border-radius:5px;background:var(--focus-highlight,#4493f8);color:#fff;white-space:nowrap;box-shadow:0 1px 5px rgba(0,0,0,.35);';
      document.body.appendChild(pinpointLabelEl);
    }
    return pinpointLabelEl;
  }
  function hidePinpointLabel() { if (pinpointLabelEl) pinpointLabelEl.style.display = 'none'; }

  document.addEventListener('mousemove', function(e) {
    if (currentInputMethod !== 'pinpoint') return;
    var el = resolvePinpointEl(e.target);
    if (el !== pinpointHover) {
      if (pinpointHover) pinpointHover.classList.remove('plannotator-pinpoint-hover');
      pinpointHover = el;
      if (el) el.classList.add('plannotator-pinpoint-hover');
    }
    if (!el) { hidePinpointLabel(); return; }
    var r = el.getBoundingClientRect();
    var lbl = getPinpointLabelEl();
    lbl.textContent = PINPOINT_LABELS[el.tagName] || el.tagName.toLowerCase();
    lbl.style.display = 'block';
    var top = r.top - 22;
    lbl.style.top = (top < 2 ? r.top + 2 : top) + 'px';
    lbl.style.left = Math.max(2, r.left) + 'px';
  });

  // Pop the toolbar for a whole element: select its text if possible (so a <mark>
  // can wrap it), else post its text + box directly so the toolbar still anchors
  // (e.g. an SVG node, whose <text> doesn't select like HTML text).
  function annotateElement(el) {
    if (!el) return;
    if (pinpointHover) { pinpointHover.classList.remove('plannotator-pinpoint-hover'); pinpointHover = null; }
    hidePinpointLabel();
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
    if (txt) { handleSelection(); return; }
    var elText = (el.textContent || '').trim();
    if (!elText) return;
    var r = el.getBoundingClientRect();
    pendingSelection = { element: true };
    pendingRange = null;
    skipNextClear = true; // don't let this click's mouseup clear the toolbar we just opened
    parent.postMessage({ type: PREFIX + 'selection', text: elText,
      rect: { top: r.top, left: r.left, width: r.width, height: r.height } }, '*');
  }

  document.addEventListener('click', function(e) {
    if (currentInputMethod !== 'pinpoint') return;
    // Existing marks are handled by the mark-click listener.
    if (e.target && e.target.closest && e.target.closest('.annotation-highlight[data-bind-id]')) return;
    var el = resolvePinpointEl(e.target);
    if (!el) return;
    // Suppress the page's own behavior (links, buttons) — we're annotating.
    e.preventDefault();
    e.stopPropagation();
    annotateElement(el);
  }, true);

  // Author opt-in: a plain click on any element tagged [data-annotate] pops the
  // toolbar — no pinpoint mode. Lets an HTML doc (e.g. a flow graph) wire its own
  // nodes to Plannotator's toolbar. Bubble phase so the page's own click handlers
  // run first; an active text selection is respected, not clobbered.
  document.addEventListener('click', function(e) {
    if (currentInputMethod === 'pinpoint') return; // pinpoint handler covers this
    var t = e.target && e.target.closest && e.target.closest('[data-annotate]');
    if (!t) return;
    if (e.target.closest('.annotation-highlight[data-bind-id]')) return;
    var s = window.getSelection();
    if (s && !s.isCollapsed && (s.toString() || '').trim()) return; // respect a drag-selection
    annotateElement(t);
  });

  // --- Mark Click ---
  document.addEventListener('click', function(e) {
    var mark = e.target.closest ? e.target.closest('.annotation-highlight[data-bind-id]') : null;
    if (mark) {
      e.stopPropagation();
      parent.postMessage({
        type: PREFIX + 'mark-click',
        id: mark.getAttribute('data-bind-id')
      }, '*');
    }
  });

  // --- Type-to-comment ---
  // While a selection is pending, focus is inside this iframe, so the parent's
  // toolbar keydown listener never sees the keystroke. Forward a single printable
  // char to the parent so it can open a comment pre-filled with it.
  document.addEventListener('keydown', function(e) {
    if (!pendingSelection) return;
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

  function applyMark(id, annType, selData) {
    try {
      var startNode = resolveNodePath(selData.startContainerPath);
      var endNode = resolveNodePath(selData.endContainerPath);
      if (!startNode || !endNode) return;

      var range = document.createRange();
      range.setStart(startNode, selData.startOffset);
      range.setEnd(endNode, selData.endOffset);
      wrapRangeInMarks(range, id, annType);
    } catch (ex) { /* range may be stale */ }
  }

  function wrapRangeInMarks(range, id, annType) {
    var walker = document.createTreeWalker(
      range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode,
      NodeFilter.SHOW_TEXT,
      null
    );

    var textNodes = [];
    while (walker.nextNode()) {
      if (range.intersectsNode(walker.currentNode)) {
        textNodes.push(walker.currentNode);
      }
    }

    for (var i = 0; i < textNodes.length; i++) {
      var tn = textNodes[i];
      var start = (tn === range.startContainer) ? range.startOffset : 0;
      var end = (tn === range.endContainer) ? range.endOffset : tn.length;
      if (start >= end) continue;

      var markRange = document.createRange();
      markRange.setStart(tn, start);
      markRange.setEnd(tn, end);

      var mark = document.createElement('mark');
      mark.className = 'annotation-highlight ' + annType;
      mark.setAttribute('data-bind-id', id);
      markRange.surroundContents(mark);
    }

    var rect = document.querySelector('[data-bind-id="' + id + '"]');
    if (rect) {
      var r = rect.getBoundingClientRect();
      parent.postMessage({
        type: PREFIX + 'mark-created',
        id: id,
        rect: { top: r.top, left: r.left, width: r.width, height: r.height }
      }, '*');
    }
  }

  function findTextAndMark(id, originalText, annType) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var buffer = '';
    var nodes = [];
    while (walker.nextNode()) {
      nodes.push({ node: walker.currentNode, start: buffer.length });
      buffer += walker.currentNode.textContent;
    }
    var idx = buffer.indexOf(originalText);
    if (idx === -1) return false;

    var endIdx = idx + originalText.length;
    var slices = [];
    for (var i = 0; i < nodes.length; i++) {
      var entry = nodes[i];
      var nodeEnd = entry.start + entry.node.length;
      if (nodeEnd <= idx) continue;
      if (entry.start >= endIdx) break;

      var start = Math.max(0, idx - entry.start);
      var end = Math.min(entry.node.length, endIdx - entry.start);
      if (start >= end) continue;
      slices.push({ node: entry.node, start: start, end: end });
    }
    for (var j = slices.length - 1; j >= 0; j--) {
      try {
        var s = slices[j];
        var markRange = document.createRange();
        markRange.setStart(s.node, s.start);
        markRange.setEnd(s.node, s.end);

        var mark = document.createElement('mark');
        mark.className = 'annotation-highlight ' + annType;
        mark.setAttribute('data-bind-id', id);
        markRange.surroundContents(mark);
      } catch (ex) { /* node may have been mutated by a prior wrap */ }
    }
    return slices.length > 0;
  }

  function removeMark(id) {
    var marks = document.querySelectorAll('[data-bind-id="' + id + '"]');
    for (var i = marks.length - 1; i >= 0; i--) unwrapMark(marks[i]);
  }

  function unwrapMark(mark) {
    var parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }

  function resolveNodePath(path) {
    var node = document.body;
    for (var i = 0; i < path.length; i++) {
      if (!node.childNodes[path[i]]) return null;
      node = node.childNodes[path[i]];
    }
    return node;
  }

  function onReady() {
    if (typeof ResizeObserver !== 'undefined' && document.body) {
      new ResizeObserver(postResize).observe(document.body);
    }
    parent.postMessage({ type: PREFIX + 'ready' }, '*');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();`;
