// The first screen's third card, "Built as planned": the agent's name in "Codex built it." cycles through
// the names in data-names, starting on the first, while the card is in view. Only the name changes: it fades
// out while its box eases to the next name's width (styles/spaces/page.css .hn), is swapped, and fades in.
// With reduced motion, or without IntersectionObserver, it stays on the first name. The card sits in the
// first screen's aria-hidden art, so a screen reader never hears the names.
(function () {
	var SHOW = 2500;
	var FADE = 300;

	var box = document.querySelector(".hn[data-names]");
	if (!box) return;
	if (typeof IntersectionObserver === "undefined") return;
	if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

	var label = box.firstElementChild;
	var names = (box.getAttribute("data-names") || "").split("|");
	if (!label || names.length < 2) return;

	var index = 0;
	var timer = 0;
	var inView = false;

	// Widths in CSS pixels, unrounded (offsetWidth rounds, which would clip a fraction of the last letter), and
	// converted back from any zoom page.js sets on the first screen.
	function cssWidth(el) {
		var frame = box.closest(".frame");
		var zoom = (frame && parseFloat(frame.style.zoom)) || 1;
		return el.getBoundingClientRect().width / zoom;
	}

	function widthOf(name) {
		var probe = document.createElement("span");
		probe.textContent = name;
		probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
		box.appendChild(probe);
		var width = cssWidth(probe);
		box.removeChild(probe);
		return width;
	}

	function next() {
		timer = 0;
		if (!inView) return;
		var name = names[(index + 1) % names.length];
		box.style.width = cssWidth(box) + "px";
		void box.offsetWidth;
		box.classList.add("out");
		box.style.width = widthOf(name) + "px";
		timer = window.setTimeout(function () {
			index = (index + 1) % names.length;
			label.textContent = name;
			box.classList.remove("out");
			timer = window.setTimeout(next, FADE + SHOW);
		}, FADE);
	}

	new IntersectionObserver(function (entries) {
		inView = entries[entries.length - 1].isIntersecting;
		if (inView && !timer) timer = window.setTimeout(next, SHOW);
	}).observe(box.closest(".sheet") || box);
})();
