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

  document.addEventListener('mouseup', function(e) {
    if (e.target && e.target.closest && e.target.closest('.annotation-highlight')) return;
    setTimeout(handleSelection, 10);
  });

  function handleSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      if (pendingSelection) {
        parent.postMessage({ type: PREFIX + 'selection-clear' }, '*');
        pendingSelection = null;
      }
      return;
    }
    var range = sel.getRangeAt(0);
    var text = sel.toString().trim();
    if (!text) return;

    var rect = range.getBoundingClientRect();
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

  // --- Mark Creation ---
  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;
    var type = e.data.type;

    if (type === PREFIX + 'create-mark') {
      var id = e.data.id;
      var annType = e.data.annotationType || 'comment';
      if (pendingSelection) {
        applyMark(id, annType, pendingSelection);
        pendingSelection = null;
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
