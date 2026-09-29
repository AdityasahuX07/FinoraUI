// player.js
console.log("FinoraUI: player.js loaded. Using CSS for player layout.");

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

    /* The OSD title only exists while the video player is on screen. Without
     * this guard the scan below matched ANY text equal to document.title - e.g.
     * the "Dashboard" row of the sidebar / profile menu while on the Dashboard
     * page - and blew it up to the 1.9rem bold title style. */
    function osdActive() {
        var pages = document.querySelectorAll("#videoOsdPage, .skinHeader.osdHeader");
        for (var i = 0; i < pages.length; i++) {
            if (!pages[i].classList.contains("hide") && pages[i].getClientRects().length > 0) return true;
        }
        return false;
    }

    /* Menus, popovers and drawers are never the player title. */
    var NOT_TITLE = ".MuiDrawer-root, .MuiPopover-root, .MuiMenu-root, .MuiModal-root, " +
        ".MuiList-root, .mainDrawer, [role='menu'], [role='menuitem'], nav";

    var touched = [];   // [element, property] pairs we set inline, so they can be undone
    function setImp(el, prop, val) {
        el.style.setProperty(prop, val, "important");
        touched.push([el, prop]);
    }

    /* Undo everything tick() did once the player is gone. */
    function cleanup() {
        var block = document.getElementById(BLOCK_ID);
        if (block) block.remove();
        if (nativeEl) {
            nativeEl.style.removeProperty("display");
            nativeEl = null;
        }
        lastText = null;
        while (touched.length) {
            var t = touched.pop();
            t[0].style.removeProperty(t[1]);
        }
    }

    function findNative() {
        var lists = [
            document.querySelectorAll(".skinHeader .MuiTypography-root, #videoOsdPage .MuiTypography-root"),
            document.querySelectorAll(".skinHeader *")
        ];
        for (var l = 0; l < lists.length; l++) {
            var els = lists[l];
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (el.getClientRects().length === 0) continue;
                if (el.id === BLOCK_ID || el.closest("#" + BLOCK_ID)) continue;
                if (el.closest(NOT_TITLE)) continue;
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
        if (!osdActive()) { cleanup(); return; }

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
        setImp(el, "display", "none");

        var header = el.closest(".skinHeader");
        if (header) setImp(header, "height", "auto");

        // Title name sits in the same row as the back button; other info hangs below.
        var bar = block.parentNode;
        setImp(bar, "align-items", "flex-start");
        setImp(bar, "height", "auto");
        setImp(bar, "padding-top", "8px");
        setImp(bar, "padding-bottom", "18px");
        var btn = bar.querySelector("button, a");
        var rowH = (btn && btn.offsetHeight) || 44;
        var nameEl = block.firstChild;
        nameEl.style.height = rowH + "px";
        nameEl.style.lineHeight = rowH + "px";

        console.log("FinoraUI: OSD title applied ->", d);
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
        var videos = document.querySelectorAll(".htmlvideoplayer, video");
        for (var i = 0; i < videos.length; i++) {
            var video = videos[i];
            if (video.getClientRects().length === 0 && videos.length > 1) continue;
            if (video.__nsSeekBound !== true) {
                video.__nsSeekBound = true;
                video.addEventListener("seeking", onSeeking);
            }
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

/* ---- Age Rating OSD (top-left, "| Rated {rating}") ----
 * Netflix-style splash: a short vertical line with the certification
 * text sliding out from behind it, shown once per playback start (a
 * fresh video AND a resume both count as "start" - only re-triggered
 * again once the underlying <video> src actually changes) and hidden
 * again 2s later. The animation itself lives in player.css
 * (.ns-age-rating-osd / .ns-age-rating-line / .ns-age-rating-text);
 * this just toggles the "show" class and fills in the text. While
 * shown, player.css also hides the OSD title block (#ns-osd-title)
 * and the native header title so the two don't overlap. */
(function () {
    "use strict";
    if (window.__nsAgeRatingOsd) return;
    window.__nsAgeRatingOsd = true;

    /* Deliberately NOT gated on "is the OSD/controls bar currently
     * visible" (mouse idle vs moved) - the splash must appear the
     * moment playback starts either way. Presence of the <video>
     * element is the only real signal that the player is on screen. */

    /* Same server-side lookup (Api/FinoraUIController.cs, proxies TMDB)
     * and US-first normalization main.js uses for the detail-page badge,
     * duplicated here since player.js and main.js run as separate,
     * self-contained scripts. */
    var ageRatingCache = {};
    function fetchAgeRating(tmdbId, type) {
        if (!tmdbId || !type) return Promise.resolve(null);

        var cacheKey = type + ":" + tmdbId;
        if (ageRatingCache.hasOwnProperty(cacheKey)) return ageRatingCache[cacheKey];

        var url;
        try {
            var params = { tmdbId: tmdbId, type: type };
            url = (window.ApiClient && typeof window.ApiClient.getUrl === "function")
                ? window.ApiClient.getUrl("FinoraUI/AgeRating", params)
                : "/FinoraUI/AgeRating?tmdbId=" + encodeURIComponent(tmdbId) + "&type=" + encodeURIComponent(type);
        } catch (err) {
            url = "/FinoraUI/AgeRating?tmdbId=" + encodeURIComponent(tmdbId) + "&type=" + encodeURIComponent(type);
        }

        var promise = fetch(url).then(function (res) {
            return res.ok ? res.json() : null;
        }).then(function (data) {
            return (data && data.rating) ? data.rating : null;
        }).catch(function () {
            return null;
        });

        ageRatingCache[cacheKey] = promise;
        return promise;
    }

    var US_RATING_CODES = ["G", "PG", "PG-13", "R", "NC-17", "NR", "UR",
        "TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
    var US_RATING_ALIASES = {
        "NOT RATED": "NR", "UNRATED": "NR",
        "US:G": "G", "US:PG": "PG", "US:PG-13": "PG-13", "US:R": "R", "US:NC-17": "NC-17", "US:NR": "NR",
        "USA:G": "G", "USA:PG": "PG", "USA:PG-13": "PG-13", "USA:R": "R", "USA:NC-17": "NC-17"
    };
    function normalizeAgeRating(raw) {
        if (!raw) return null;
        var val = ("" + raw).trim();
        var upper = val.toUpperCase();
        for (var i = 0; i < US_RATING_CODES.length; i++) {
            if (upper === US_RATING_CODES[i]) return US_RATING_CODES[i];
        }
        if (US_RATING_ALIASES[upper]) return US_RATING_ALIASES[upper];
        return val;
    }

    /* Getting the playing item's data. PlaybackManager (main.js's own
     * playHomeHeroItem() comment explains why: it isn't reliably a
     * window global on Jellyfin Web 12) is tried first as a cheap
     * fast path. Everything else here avoids depending on any
     * particular skin's DOM class names (this build is a heavily
     * customized MUI/React Jellyfin 12 client, so old jQuery-era
     * class names like ".osdPoster" may simply not exist), and
     * instead reads the item id straight out of network activity:
     * whatever request actually fetched the video - a direct file
     * ("/Videos/<id>/stream...") or an HLS manifest
     * ("/Videos/<id>/master.m3u8") - shows up in the Performance
     * Resource Timing API with that URL even when the <video>
     * element itself ends up playing an opaque "blob:" URL (which
     * is what MSE/hls.js playback normally looks like). */
    var itemCache = {};
    function getItemById(itemId) {
        if (!itemId) return Promise.resolve(null);
        if (itemCache.hasOwnProperty(itemId)) return itemCache[itemId];

        var promise;
        try {
            var api = window.ApiClient;
            var userId = api && typeof api.getCurrentUserId === "function" ? api.getCurrentUserId() : null;
            if (api && userId && typeof api.getItem === "function") {
                promise = api.getItem(userId, itemId).catch(function () { return null; });
            } else {
                promise = Promise.resolve(null);
            }
        } catch (err) {
            promise = Promise.resolve(null);
        }

        itemCache[itemId] = promise;
        return promise;
    }

    function itemIdFromVideoSrc(src) {
        var m = /\/videos\/([^\/?]+)/i.exec(src || "");
        return m ? m[1] : null;
    }

    function itemIdFromPerformanceEntries() {
        try {
            var entries = performance.getEntriesByType("resource");
            for (var i = entries.length - 1; i >= 0; i--) {
                var m = /\/videos\/([^\/?]+)/i.exec(entries[i].name || "");
                if (m) return m[1];
            }
        } catch (err) { /* ignore */ }
        return null;
    }

    function itemIdFromPoster() {
        var img = document.querySelector(".osdPoster img");
        if (!img) return null;
        var m = /\/Items\/([^\/?]+)\/Images/i.exec(img.currentSrc || img.src || "");
        return m ? m[1] : null;
    }

    function itemIdFromUrl() {
        var m = /[?&]id=([a-z0-9-]+)/i.exec(window.location.search || window.location.hash || "");
        if (!m) m = /[?&]itemId=([a-z0-9-]+)/i.exec(window.location.search || window.location.hash || "");
        return m ? m[1] : null;
    }

    function getCurrentItem(video) {
        try {
            var pm = window.PlaybackManager || window.playbackManager ||
                (window.Emby && window.Emby.playbackManager) || null;
            if (pm && typeof pm.getCurrentPlayer === "function" && typeof pm.currentItem === "function") {
                var player = pm.getCurrentPlayer();
                var item = player ? pm.currentItem(player) : null;
                if (item && item.Id) return Promise.resolve(item);
            }
        } catch (err) {
            /* fall through to the network/DOM-based lookup below */
        }

        var itemId = itemIdFromVideoSrc(video.currentSrc || video.src) ||
            itemIdFromPerformanceEntries() ||
            itemIdFromUrl() ||
            itemIdFromPoster();
        console.log("FinoraUI: age rating OSD - resolved item id ->", itemId);
        return getItemById(itemId);
    }

    function resolveAgeRating(item) {
        if (!item) return Promise.resolve(null);
        var official = normalizeAgeRating(item.OfficialRating);

        if (item.Type === "Episode" && item.SeriesId) {
            return getItemById(item.SeriesId).then(function (seriesItem) {
                if (!seriesItem) return official;
                var sIds = seriesItem.ProviderIds || {};
                var sTmdb = sIds.Tmdb || sIds.TMDB || sIds.tmdb;
                if (!sTmdb) return official;
                return fetchAgeRating(sTmdb, "tv").then(function (resolved) {
                    return resolved || official;
                });
            }).catch(function() { return official; });
        }

        var ids = item.ProviderIds || {};
        var tmdbId = ids.Tmdb || ids.TMDB || ids.tmdb;
        var type = item.Type === "Movie" ? "movie" : (item.Type === "Series" ? "tv" : null);
        if (!tmdbId || !type) return Promise.resolve(official);
        
        return fetchAgeRating(tmdbId, type).then(function (resolved) {
            return resolved || official;
        });
    }

    var BLOCK_ID = "ns-age-rating-osd";
    var osdEl = null;
    var textEl = null;
    var hideTimer = null;
    var lastSrc = null;
    var shownForSrc = null;
    var pending = false;

    function ensureEl() {
        if (osdEl && osdEl.isConnected) return osdEl;
        osdEl = document.createElement("div");
        osdEl.id = BLOCK_ID;
        osdEl.className = "ns-age-rating-osd";

        var line = document.createElement("div");
        line.className = "ns-age-rating-line";

        var textContainer = document.createElement("div");
        textContainer.className = "ns-age-rating-text-container";

        textEl = document.createElement("div");
        textEl.className = "ns-age-rating-text";
        textContainer.appendChild(textEl);

        osdEl.appendChild(line);
        osdEl.appendChild(textContainer);
        
        var container = null;
        var pages = document.querySelectorAll("#videoOsdPage");
        for (var i = 0; i < pages.length; i++) {
            if (!pages[i].classList.contains("hide") && pages[i].getClientRects().length > 0) {
                container = pages[i];
                break;
            }
        }
        if (!container) {
            var vpc = document.querySelectorAll(".videoPlayerContainer");
            for (var i = 0; i < vpc.length; i++) {
                if (vpc[i].getClientRects().length > 0) {
                    container = vpc[i];
                    break;
                }
            }
        }
        if (!container) container = document.body;
        
        container.appendChild(osdEl);
        return osdEl;
    }

    function showRating(rating) {
        var el = ensureEl();
        textEl.textContent = "Rated " + rating;

        // Drop and re-add "show" (with a forced reflow between) so the
        // slide-in restarts cleanly even if a previous splash is still
        // fading when the next item's rating comes back.
        el.classList.remove("show");
        void el.offsetWidth;
        el.classList.add("show");

        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            if (osdEl) osdEl.classList.remove("show");
        }, 2600);
    }

    function cleanup() {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (osdEl) { osdEl.remove(); osdEl = null; textEl = null; }
        lastSrc = null;
        shownForSrc = null;
        pending = false;
    }

    function tick() {
        var videos = document.querySelectorAll("video");
        var video = null;
        for (var i = 0; i < videos.length; i++) {
            if (videos[i].getClientRects().length > 0) { video = videos[i]; break; }
        }
        if (!video && videos.length) video = videos[0];
        
        if (!video) { if (osdEl) cleanup(); return; }

        var src = video.currentSrc || video.src || "";
        if (!src) return;

        if (src !== lastSrc) {
            lastSrc = src;
            shownForSrc = null;
        }

        if (video.paused || video.readyState < 2) {
            return;
        }

        if (shownForSrc === src || pending) return;

        pending = true;
        shownForSrc = src;
        getCurrentItem(video).then(resolveAgeRating).then(function (rating) {
            pending = false;
            if (lastSrc !== src) return; // a different item started while we were waiting
            if (!rating) {
                console.log("FinoraUI: age rating OSD - no rating resolved for this item, not showing");
                return;
            }
            console.log("FinoraUI: age rating OSD ->", rating);
            showRating(rating);
        });
    }

    setInterval(tick, 400);
    tick();
})();

/* ---- Suppress OSD on Start ----
 * Jellyfin shows the OSD (controls) automatically when playback begins.
 * Hide it via CSS (.ns-mouse-idle-start) until the user actually interacts.
 */
(function () {
    "use strict";
    if (window.__nsOsdStartHide) return;
    window.__nsOsdStartHide = true;

    var idle = false;
    var lastSrc = null;

    function wakeUp() {
        if (idle) {
            idle = false;
            document.body.classList.remove("ns-mouse-idle-start");
        }
    }

    document.addEventListener("mousemove", wakeUp, { passive: true });
    document.addEventListener("keydown", wakeUp, { passive: true });
    document.addEventListener("touchstart", wakeUp, { passive: true });
    document.addEventListener("click", wakeUp, { passive: true });
    document.addEventListener("wheel", wakeUp, { passive: true });

    function checkVideo() {
        var videos = document.querySelectorAll("video");
        var video = null;
        for (var i = 0; i < videos.length; i++) {
            if (videos[i].getClientRects().length > 0) { video = videos[i]; break; }
        }
        if (!video && videos.length) video = videos[0];
        
        if (!video) {
            lastSrc = null;
            return;
        }

        var src = video.currentSrc || video.src || "";
        if (src && src !== lastSrc) {
            lastSrc = src;
            idle = true;
            document.body.classList.add("ns-mouse-idle-start");
        }
    }

    var mo = new MutationObserver(checkVideo);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    setInterval(checkVideo, 250);
})();
