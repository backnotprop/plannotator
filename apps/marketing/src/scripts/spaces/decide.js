// The "Decide together, as a team." row (styles/spaces/decide.css). A copy of the Spaces app's
// decide scene: it waits unanswered until 45% of a scene is in view, plays the beats once and rests
// on the answered end state. Reduced motion (or no IntersectionObserver) shows the end state at once.
(function () {
	var WIDE_STEPS = [1000, 1800, 2700, 3500, 4400];
	var PHONE_STEPS = [1000];

	function prefersStill() {
		if (typeof window === "undefined") return true;
		if (typeof IntersectionObserver === "undefined") return true;
		return window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
	}

	function stepsOf(root) {
		return root.classList.contains("dsn-phone") ? PHONE_STEPS : WIDE_STEPS;
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
		var replies = root.querySelectorAll(".dsn-reply");
		for (var i = 0; i < replies.length; i++) mark(replies[i], step >= i + 2);
	}

	function play(root) {
		var steps = stepsOf(root);
		var io = new IntersectionObserver(
			function (entries) {
				var seen = false;
				for (var i = 0; i < entries.length; i++) if (entries[i].intersectionRatio >= 0.45) seen = true;
				if (!seen) return;
				io.disconnect();
				steps.forEach(function (at, index) {
					window.setTimeout(function () {
						show(root, index + 1);
					}, at);
				});
			},
			{ threshold: 0.45 },
		);
		io.observe(root);
	}

	function start(root) {
		if (prefersStill()) {
			show(root, stepsOf(root).length);
			return;
		}
		show(root, 0);
		play(root);
	}

	var roots = document.querySelectorAll(".dsn");
	for (var i = 0; i < roots.length; i++) start(roots[i]);
})();
