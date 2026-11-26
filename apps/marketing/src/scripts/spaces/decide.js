// The "Decide together, as a team." row (styles/spaces/decide.css). The Spaces app's decide scene:
// it waits unanswered until 45% of a scene is in view, then "Keep both" is picked once and the scene
// rests on the answered end state. The list of decisions beside it is a still. Reduced motion (or no
// IntersectionObserver) shows the end state at once.
(function () {
	var STEPS = [1000];

	function prefersStill() {
		if (typeof window === "undefined") return true;
		if (typeof IntersectionObserver === "undefined") return true;
		return window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
	}

	function mark(el, on) {
		if (!el) return;
		if (on) el.setAttribute("data-on", "");
		else el.removeAttribute("data-on");
	}

	function show(root, step) {
		var picked = step >= 1;
		mark(root.querySelector(".dsn-done"), picked);
		mark(root.querySelector(".dsn-opt"), picked);
		mark(root.querySelector(".dsn-by"), picked);
	}

	function play(root) {
		var io = new IntersectionObserver(
			function (entries) {
				var seen = false;
				for (var i = 0; i < entries.length; i++) if (entries[i].intersectionRatio >= 0.45) seen = true;
				if (!seen) return;
				io.disconnect();
				STEPS.forEach(function (at, index) {
					window.setTimeout(function () {
						show(root, index + 1);
					}, at);
				});
			},
			{ threshold: 0.45 },
		);
		// On the phone the scene is the question block with the list under it; the question block alone is what
		// must be in view, or a short screen would never show enough of the taller pair to play.
		io.observe(root.querySelector(".dsn-blk") || root);
	}

	function start(root) {
		if (prefersStill()) {
			show(root, STEPS.length);
			return;
		}
		show(root, 0);
		play(root);
	}

	var roots = document.querySelectorAll(".dsn");
	for (var i = 0; i < roots.length; i++) start(roots[i]);
})();
