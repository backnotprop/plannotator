export type PluginUpdateState = 'general' | 'reload' | 'manual';

export const READ_PLUGIN_UPDATE_QUERY = `function (search) {
  var params;
  try { params = new URLSearchParams(search || ''); } catch (e) { params = new URLSearchParams(''); }
  var raw = params.get('state');
  var state = raw === 'reload' || raw === 'manual' ? raw : 'general';
  function version(value) {
    return typeof value === 'string' && value.length <= 32 && /^[0-9]{1,6}(\\.[0-9]{1,6}){1,3}$/.test(value) ? value : null;
  }
  return { state: state, from: version(params.get('from')), to: version(params.get('to')) };
}`;

export const PLUGIN_UPDATE_HEAD_SCRIPT = `(function () {
  var q = (${READ_PLUGIN_UPDATE_QUERY})(window.location.search);
  var root = document.documentElement;
  root.setAttribute('data-pu-state', q.state);
  if (q.from && q.to) {
    root.setAttribute('data-pu-from', q.from);
    root.setAttribute('data-pu-to', q.to);
  }
})();`;

export const PLUGIN_UPDATE_VERSIONS_SCRIPT = `(function () {
  var root = document.documentElement;
  var from = root.getAttribute('data-pu-from');
  var to = root.getAttribute('data-pu-to');
  if (!from || !to) return;
  document.querySelectorAll('[data-pu-version="from"]').forEach(function (el) { el.textContent = from; });
  document.querySelectorAll('[data-pu-version="to"]').forEach(function (el) { el.textContent = to; });
  document.querySelectorAll('.pu-versions').forEach(function (el) { el.removeAttribute('hidden'); });
})();`;

export const PLUGIN_UPDATE_COPY_SCRIPT = `(function () {
  var live = document.getElementById('pu-live');
  function say(text) {
    if (!live) return;
    live.textContent = '';
    setTimeout(function () { live.textContent = text; }, 30);
  }
  function selectText(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  }
  document.querySelectorAll('.pu-copy').forEach(function (btn) {
    var label = btn.querySelector('.pu-copy-label');
    var timer = null;
    function show(text, ms) {
      if (label) label.textContent = text;
      if (text === 'Copied') btn.setAttribute('data-copied', 'true'); else btn.removeAttribute('data-copied');
      if (timer) clearTimeout(timer);
      if (ms) timer = setTimeout(function () { show('Copy', 0); }, ms);
    }
    btn.addEventListener('click', function () {
      var code = btn.closest('.pu-cmd') && btn.closest('.pu-cmd').querySelector('code');
      if (!code) return;
      var text = code.textContent.trim();
      var done = function () { show('Copied', 2000); say('Copied'); };
      var failed = function () { selectText(code); show("Couldn't copy", 4000); say("Couldn't copy. The command is selected."); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, failed);
      } else {
        failed();
      }
    });
  });
})();`;
