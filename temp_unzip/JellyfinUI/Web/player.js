// player.js
console.log("NetflixSkin: player.js loaded. Using CSS for player layout.");

/* ---- Player OSD title: Name / S&E • Ep name / Year ----
 * Finds the native one-line title by its text (no dependence on class names),
 * hides it, and inserts a 3-line block next to it. All styling is inline so it
 * works even if player.css hasn't been re-injected yet. */
(function () {
    "use strict";
    if (window.__nsOsdTitle) return;
    window.__nsOsdTitle = true;

    var BLOCK_ID = "ns-osd-title";
    var EP_RE = /^(.*?) - (S\d+:E\d+(?:-\d+)?)(?: - (.*))?$/;
    var YEAR_RE = /\s\((\d{4})\)$/;
    var nativeEl = null;
    var lastText = null;

    function looksLikeTitle(text) {
        if (!text || text.length > 300) return false;
        var dt = (document.title || "").trim();
        if (dt && text === dt) return true;
        if (dt && dt.indexOf(text) === 0 && text.length > 3) return true;
        return EP_RE.test(text) && YEAR_RE.test(text);
    }

    function findNative() {
        var lists = [
            document.querySelectorAll(".MuiTypography-root"),
            document.querySelectorAll(".skinHeader *")
        ];
        for (var l = 0; l < lists.length; l++) {
            var els = lists[l];
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (el.id === BLOCK_ID || el.closest("#" + BLOCK_ID)) continue;
                if (el.children.length) continue;
                var t = (el.textContent || "").trim();
                if (t && looksLikeTitle(t)) return el;
            }
        }
        return null;
    }

    function parse(raw) {
        var text = raw.trim(), year = "";
        var ym = text.match(YEAR_RE);
        if (ym) { year = ym[1]; text = text.slice(0, ym.index).trim(); }
        var name = text, ep = "";
        var em = text.match(EP_RE);
        if (em) {
            name = em[1];
            ep = em[3] ? em[2] + " \u2022 " + em[3] : em[2];
        }
        return { name: name, ep: ep, year: year };
    }

    function line(text, css) {
        var d = document.createElement("div");
        d.textContent = text;
        d.style.cssText = css + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        return d;
    }

    function tick() {
        var block = document.getElementById(BLOCK_ID);

        if (nativeEl && nativeEl.isConnected && block && block.isConnected &&
            (nativeEl.textContent || "") === lastText) {
            return;
        }

        var el = findNative();
        if (!el) {
            if (block && !(nativeEl && nativeEl.isConnected)) block.remove();
            return;
        }

        nativeEl = el;
        lastText = el.textContent || "";
        if (block) block.remove();

        var d = parse(lastText);
        block = document.createElement("div");
        block.id = BLOCK_ID;
        block.style.cssText = "display:flex;flex-direction:column;gap:.15rem;" +
            "padding:0 .5rem 0 .25rem;min-width:0;max-width:60vw;" +
            "text-shadow:0 1px 6px rgba(0,0,0,.6);text-align:left";
        block.appendChild(line(d.name, "font-size:1.9rem;font-weight:700"));
        if (d.ep) block.appendChild(line(d.ep, "font-size:1.15rem;font-weight:400;line-height:1.3;opacity:.75"));
        if (d.year) block.appendChild(line(d.year, "font-size:1.15rem;font-weight:400;line-height:1.3;opacity:.75"));

        el.parentNode.insertBefore(block, el);
        el.style.setProperty("display", "none", "important");

        var header = el.closest(".skinHeader");
        if (header) header.style.setProperty("height", "auto", "important");

        // Title name sits in the same row as the back button; other info hangs below.
        var bar = block.parentNode;
        bar.style.setProperty("align-items", "flex-start", "important");
        bar.style.setProperty("height", "auto", "important");
        bar.style.setProperty("padding-top", "8px", "important");
        bar.style.setProperty("padding-bottom", "18px", "important");
        var btn = bar.querySelector("button, a");
        var rowH = (btn && btn.offsetHeight) || 44;
        var nameEl = block.firstChild;
        nameEl.style.height = rowH + "px";
        nameEl.style.lineHeight = rowH + "px";

        console.log("NetflixSkin: OSD title applied ->", d);
    }

    setInterval(tick, 400);
    tick();
})();

/* ---- OSD progress bar: clear stale "buffered" indicator on seek ----
 * When seeking backward, the old buffered-ahead segment (.mdl-slider-
 * background-upper) can stay visible at its old position until playback
 * resumes and the player reports fresh buffered ranges. Hide it the instant
 * a seek starts, and only let it reappear once its style actually changes
 * (i.e. real data replaces the stale range). */
(function () {
    "use strict";
    if (window.__nsBufferSeekFix) return;
    window.__nsBufferSeekFix = true;

    var hiddenBar = null;
    var mo = null;

    function upperBar() {
        var box = document.querySelector(".osdControls .sliderContainer:not(.osdVolumeSliderContainer)");
        return box ? box.querySelector(".mdl-slider-background-upper") : null;
    }

    function onSeeking() {
        var bar = upperBar();
        if (!bar) return;
        bar.style.setProperty("opacity", "0", "important");
        hiddenBar = bar;

        if (mo) mo.disconnect();
        mo = new MutationObserver(function () {
            if (hiddenBar) hiddenBar.style.removeProperty("opacity");
            hiddenBar = null;
            if (mo) { mo.disconnect(); mo = null; }
        });
        mo.observe(bar, { attributes: true, attributeFilter: ["style"] });
    }

    function attach() {
        var video = document.querySelector(".htmlvideoplayer");
        if (video && video.__nsSeekBound !== true) {
            video.__nsSeekBound = true;
            video.addEventListener("seeking", onSeeking);
        }
    }

    setInterval(attach, 1000);
    attach();
})();

/* ---- Volume/Brightness OSD (top-right): show the percentage ----
 * Jellyfin's built-in volume/brightness popup (.iconOsd) only shows an
 * icon and a bar, no number. Add a percentage label under the bar. */
(function () {
    "use strict";
    if (window.__nsIconOsdPct) return;
    window.__nsIconOsdPct = true;

    var LABEL_CLASS = "ns-iconOsd-pct";

    function tick() {
        var bars = document.querySelectorAll(".iconOsd .iconOsdProgressOuter");
        for (var i = 0; i < bars.length; i++) {
            var outer = bars[i];
            var inner = outer.querySelector(".iconOsdProgressInner");
            if (!inner) continue;
            var pct = Math.round(parseFloat(inner.style.width) || 0);

            var label = outer.parentNode.querySelector("." + LABEL_CLASS);
            if (!label) {
                label = document.createElement("div");
                label.className = LABEL_CLASS;
                outer.parentNode.insertBefore(label, outer.nextSibling);
            }
            var text = pct + "%";
            if (label.textContent !== text) label.textContent = text;
        }
    }

    setInterval(tick, 200);
    tick();
})();

/* ---- OSD progress bar: chapter split ----
 * Puts a small physical gap in the seek bar at every chapter start.
 * Chapter positions come from the same getMarkerInfo() Jellyfin uses to draw
 * its chapter ticks (falls back to reading the rendered .sliderMarker
 * elements). They are turned into a hard-stop gradient stored in
 * --ns-chapter-mask on the slider's .sliderContainer; player.css applies it
 * as a mask on .mdl-slider-background-flex, which cuts the gaps through the
 * track, buffered range and played fill together. Gap width: --ns-chapter-gap. */
(function () {
    "use strict";
    if (window.__nsChapterSplit) return;
    window.__nsChapterSplit = true;

    var ACTIVE_CLASS = "ns-chapter-split";
    var MASK_VAR = "--ns-chapter-mask";
    var MIN_DISTANCE_PX = 12; // skip chapters this close to an end or to the previous chapter

    function chapterPercents(slider, box) {
        var out = [], i, p;
        if (typeof slider.getMarkerInfo === "function") {
            var info = null;
            try { info = slider.getMarkerInfo(); } catch (e) { info = null; }
            if (info && info.length) {
                for (i = 0; i < info.length; i++) {
                    p = Number(info[i] && info[i].progress) * 100;
                    if (isFinite(p)) out.push(p);
                }
            }
            return out;
        }
        var marks = box.querySelectorAll(".sliderMarker");
        for (i = 0; i < marks.length; i++) {
            var m = /^(?:calc\(\s*)?(-?[\d.]+)%/.exec(marks[i].style.left || "");
            if (m) out.push(parseFloat(m[1]));
        }
        return out;
    }

    function usable(percents, width) {
        var minPct = MIN_DISTANCE_PX / width * 100;
        var sorted = percents.slice().sort(function (a, b) { return a - b; });
        var kept = [];
        for (var i = 0; i < sorted.length; i++) {
            var p = sorted[i];
            if (p < minPct || p > 100 - minPct) continue;
            if (kept.length && p - kept[kept.length - 1] < minPct) continue;
            kept.push(p);
        }
        return kept;
    }

    function buildMask(percents, rtl) {
        var half = "var(--ns-chapter-gap, 2px) / 2";
        var stops = ["#000 0%"];
        for (var i = 0; i < percents.length; i++) {
            var p = percents[i].toFixed(3) + "%";
            var a = "calc(" + p + " - " + half + ")";
            var b = "calc(" + p + " + " + half + ")";
            stops.push("#000 " + a, "transparent " + a, "transparent " + b, "#000 " + b);
        }
        stops.push("#000 100%");
        return "linear-gradient(" + (rtl ? "270deg" : "90deg") + "," + stops.join(",") + ")";
    }

    function update(slider) {
        var box = slider.closest(".sliderContainer");
        var track = box && box.querySelector(".mdl-slider-background-flex");
        if (!track) return;

        var width = track.getBoundingClientRect().width;
        if (!width) return; // OSD not laid out yet - try again next tick

        var percents = usable(chapterPercents(slider, box), width);
        var sig = Math.round(width) + "|" + percents.map(function (p) { return p.toFixed(3); }).join(",");
        if (box.__nsChapterSig === sig) return;
        box.__nsChapterSig = sig;

        if (!percents.length) {
            box.classList.remove(ACTIVE_CLASS);
            box.style.removeProperty(MASK_VAR);
            return;
        }
        var rtl = window.getComputedStyle(box).direction === "rtl";
        box.style.setProperty(MASK_VAR, buildMask(percents, rtl));
        box.classList.add(ACTIVE_CLASS);
    }

    /* Handle every OSD position slider in the DOM, not just the first one:
     * right after closing a video Jellyfin can leave the previous (hidden)
     * player view around for a moment, and the new one is a later match. */
    function tick() {
        var sliders = document.querySelectorAll(".osdControls .osdPositionSlider");
        for (var i = 0; i < sliders.length; i++) update(sliders[i]);
    }

    setInterval(tick, 250);
    tick();
})();
