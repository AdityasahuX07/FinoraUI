/*!
 * Netflix Skin - rail card expand-in-place
 * --------------------------------------------------------------------------
 * This is the ONE piece of the skin that could not be done with CSS alone:
 * on a home-screen rail, the first card is expanded into a large 16:9
 * "landscape" tile by default; clicking any other (still-portrait) card
 * expands IT instead (collapsing whichever card was expanded); and clicking
 * a card that is ALREADY the expanded/landscape one lets Jellyfin's normal
 * click-through happen, opening that item's details screen. Only one card
 * per rail is ever expanded at a time, matching the reference UI.
 *
 * Loaded because SkinEntryPoint.cs patched jellyfin-web's index.html with:
 *   <script defer src="/NetflixSkin/main.js"></script>
 * (served by Api/NetflixSkinController.cs). This file does not reimplement
 * playback, auth, library or search logic. It intercepts card-expansion /
 * navigation clicks and, for the custom home-hero Play button, delegates
 * playback back to Jellyfin's own shortcut system so the native
 * PlaybackManager remains responsible for playback. If something about it
 * misbehaves on your
 * Jellyfin Web version, disabling "Enable rail hover-preview" in the
 * plugin's config page removes it cleanly (and restores index.html)
 * without affecting anything else the skin does.
 *
 * Written defensively and dependency-free: Jellyfin Web is a single-page
 * app that re-renders rails on every navigation, so we use a
 * MutationObserver instead of a one-time querySelectorAll, and every DOM
 * read is guarded so a missing/renamed attribute just skips the
 * enhancement for that card instead of throwing.
 * --------------------------------------------------------------------------
 */
(function () {
    "use strict";

    var EXPANDED_CLASS = "ns-expanded";

    /**
     * Title truncation (collapsed/portrait cards only - see
     * updateCardTitleTruncation below). 28 characters, spaces included,
     * matches what was asked for; anything already at/under that length is
     * left completely alone (no "..." added just because it's close).
     */
    var TITLE_MAX_CHARS = 27;

    /**
     * Card-type classes that are landscape (16:9) BY DEFAULT, i.e. never
     * go through the portrait/expand-in-place dance at all - stock
     * Jellyfin already renders these full-width, so their title should
     * never be truncated. The "collapsed portrait card" vs "expanded/
     * landscape card" split this file already tracks via EXPANDED_CLASS
     * only covers the poster rail cards; this list covers the other,
     * always-landscape card shapes so they get the same "show full name"
     * treatment without needing to be clicked/expanded first.
     */
    var LANDSCAPE_CARD_TYPE_CLASSES = [
        "backdropCard",
        "mixedBackdropCard",
        "smallBackdropCard",
        "overflowBackdropCard",
        "overflowSmallBackdropCard"
    ];

    /**
     * Best-effort extraction of an item's id from a rendered card element.
     * Jellyfin cards carry the item id in a data attribute; the exact name
     * has been data-id / data-itemid across versions, so we check both.
     */
    function getItemId(cardEl) {
        return cardEl.getAttribute("data-id") || cardEl.getAttribute("data-itemid") || null;
    }

    /**
     * The rail (row) a card lives in. Only cards inside one of these are
     * eligible for expand-in-place - grid/library views (which don't match
     * this selector) are left completely untouched, exactly like the old
     * hover-preview feature scoped itself.
     */
    function findSection(cardEl) {
        // The item detail page's Cast & Crew row AND its "More Like This"
        // (similar items) row both sit inside the exact same
        // ".verticalSection" wrapper class a home-screen rail uses, which
        // would otherwise make this match and pull those cards into the
        // expand-in-place dance below (first click swaps the image/
        // metadata in place, second click navigates, and one card starts
        // pre-expanded with genre/year/overview text) instead of stock's
        // normal single-click-to-navigate, plain title+year card. This
        // feature is only meant for actual home-screen rails, so exclude
        // every card on the detail page up front rather than trying to
        // name each of its rows individually.
        if (cardEl.closest(DETAIL_SEL.page) || cardEl.classList.contains("personCard")) {
            return null;
        }
        return cardEl.closest(".verticalSection, .homeSection, [data-type='section']");
    }

    function getCards(section) {
        return Array.prototype.slice.call(section.querySelectorAll(".card"));
    }

    /**
     * One in-flight/resolved promise per item id, shared by every caller.
     * The detail page now has two independent consumers of the same item
     * (the backdrop and the hero text/logo), and without this each one
     * would fire its own network request on every page visit.
     */
    var itemFetchCache = {};

    /**
     * Fetches item details through Jellyfin Web's own already-authenticated
     * ApiClient (window.ApiClient), which is how every native Jellyfin Web
     * screen gets its data - we are not talking to the server any
     * differently than the stock UI already does.
     */
    function fetchItem(itemId) {
        if (itemFetchCache[itemId]) {
            return itemFetchCache[itemId];
        }

        var promise;
        try {
            if (window.ApiClient && typeof window.ApiClient.getItem === "function") {
                var userId = window.ApiClient.getCurrentUserId
                    ? window.ApiClient.getCurrentUserId()
                    : null;
                promise = window.ApiClient.getItem(userId, itemId);
            } else {
                promise = Promise.resolve(null);
            }
        } catch (err) {
            promise = Promise.resolve(null);
        }

        /* Don't let a failed or empty lookup poison future visits to this
           item - only cache the request while it might still succeed. */
        promise = promise.then(function (item) {
            if (!item) {
                delete itemFetchCache[itemId];
            }
            return item;
        }, function (err) {
            delete itemFetchCache[itemId];
            return null;
        });

        itemFetchCache[itemId] = promise;
        return promise;
    }

    /**
     * Prefer a real 16:9 backdrop image for the expanded tile; fall back to
     * a Thumb image (also landscape) if the item has no backdrop at all.
     * Never falls back to stretching the portrait poster itself - that's
     * what the CSS aspect-ratio override would otherwise do and it looks
     * wrong, so if neither image exists we simply leave the poster in
     * place (still enlarged/16:9-framed, just without a swapped image).
     */
    function landscapeImageUrl(item) {
        try {
            if (!window.ApiClient || !item) {
                return null;
            }

            if (item.BackdropImageTags && item.BackdropImageTags.length) {
                return window.ApiClient.getScaledImageUrl(item.Id, {
                    type: "Backdrop",
                    tag: item.BackdropImageTags[0],
                    maxWidth: 900
                });
            }

            if (item.ImageTags && item.ImageTags.Thumb) {
                return window.ApiClient.getScaledImageUrl(item.Id, {
                    type: "Thumb",
                    tag: item.ImageTags.Thumb,
                    maxWidth: 900
                });
            }

            if (item.Type === "Episode" && item.ImageTags && item.ImageTags.Primary) {
                return window.ApiClient.getScaledImageUrl(item.Id, {
                    type: "Primary",
                    tag: item.ImageTags.Primary,
                    maxWidth: 900
                });
            }
        } catch (err) {
            /* no landscape image available - keep the poster shown */
        }

        return null;
    }

    function portraitImageUrl(item) {
        try {
            if (!window.ApiClient || !item) {
                return null;
            }

            if (item.Type === "Episode" || item.SeriesId) {
                var seriesId = item.SeriesId;
                var tag = item.SeriesPrimaryImageTag;
                
                if (!seriesId && item.ParentPrimaryImageItemId) {
                    seriesId = item.ParentPrimaryImageItemId;
                    tag = item.ParentPrimaryImageTag;
                }
                
                if (seriesId && tag) {
                    return window.ApiClient.getScaledImageUrl(seriesId, {
                        type: "Primary",
                        tag: tag,
                        maxWidth: 600
                    });
                }
            }

            if (item.ImageTags && item.ImageTags.Primary) {
                return window.ApiClient.getScaledImageUrl(item.Id, {
                    type: "Primary",
                    tag: item.ImageTags.Primary,
                    maxWidth: 600
                });
            }
        } catch (err) {}
        return null;
    }

    function isResumableCard(cardEl) {
        return !!(cardEl.querySelector(".itemProgressBar") || cardEl.querySelector(".cardProgress") || cardEl.querySelector(".itemLinearProgress"));
    }

    /**
     * Creates (once) the two extra text elements the expanded/landscape
     * tile needs that stock Jellyfin's card markup doesn't have: a
     * "Genre • Year" line and an overview blurb. Both are inserted right
     * around the existing .cardText-first (title) element - genre/year
     * before it, overview after - so they inherit the same footer
     * positioning/padding stock Jellyfin already applies there. Hidden by
     * CSS until the card is both .ns-expanded and .ns-has-meta (see
     * updateExpandedMetadata).
     */
    function ensureExpandedMetaElements(cardEl) {
        var titleEl = cardEl.querySelector(".cardText-first");
        if (!titleEl || !titleEl.parentNode) {
            return null;
        }

        var footer = titleEl.parentNode;

        var genreYearEl = footer.querySelector(".ns-meta-genreyear");
        if (!genreYearEl) {
            genreYearEl = document.createElement("div");
            genreYearEl.className = "ns-meta-genreyear";
            footer.insertBefore(genreYearEl, titleEl);
        }

        var overviewEl = footer.querySelector(".ns-meta-overview");
        if (!overviewEl) {
            overviewEl = document.createElement("div");
            overviewEl.className = "ns-meta-overview";
            if (titleEl.nextSibling) {
                footer.insertBefore(overviewEl, titleEl.nextSibling);
            } else {
                footer.appendChild(overviewEl);
            }
        }

        return { genreYearEl: genreYearEl, overviewEl: overviewEl, titleEl: titleEl };
    }

    /**
     * Populates the genre/year + overview elements for an expanded tile.
     * Deliberately skipped for a Continue Watching card (isResumableCard)
     * so that row keeps its existing dim-title/bold-"Xh Ym left" expanded
     * look instead of getting genre/overview text overlaid on it - the
     * request this was built for only asked for the extra metadata on
     * ordinary Latest Movies/Latest Shows cards.
     */
    function updateExpandedMetadata(cardEl, item) {
        if (isResumableCard(cardEl)) {
            return;
        }

        var els = ensureExpandedMetaElements(cardEl);
        if (!els || !item) {
            return;
        }

        cardEl.classList.add("ns-has-meta");

        // Set the title directly from the item data we already have here,
        // instead of relying on stock Jellyfin having already written it
        // into .cardText-first by the time this runs. That title-writing
        // timing is independent of this function and isn't guaranteed to
        // have happened yet (e.g. on the automatic "expand the first card
        // on load" pass) - genre/year and overview never had this problem
        // because they're ALWAYS written from "item" right here, but the
        // title previously wasn't, so it could stay blank. This also
        // keeps updateCardTitleTruncation's cached nsFullTitle in sync so
        // collapsing back to portrait truncates the correct text.
        if (item.Name) {
            els.titleEl.textContent = item.Name;
            cardEl.dataset.nsFullTitle = item.Name;
        }

        var parts = [];
        if (item.Genres && item.Genres.length) {
            parts.push(item.Genres[0]);
        }
        if (item.ProductionYear) {
            parts.push(item.ProductionYear);
        }
        els.genreYearEl.textContent = parts.join(" \u2022 ");
        els.overviewEl.textContent = item.Overview || "";
    }

    function setPortraitBackground(cardEl, url) {
        var imageContainer = cardEl.querySelector(".cardImageContainer");
        if (!imageContainer || !url) return;
        
        imageContainer.dataset.nsPortraitBg = url;
        var newBg = "url(" + url + ")";
        if (imageContainer.dataset.nsOriginalBg !== undefined) {
            imageContainer.dataset.nsOriginalBg = newBg;
        } else {
            imageContainer.style.backgroundImage = newBg;
        }
    }

    function ensureBgObserver(cardEl, imageContainer) {
        if (!imageContainer.nsBgObserver) {
            imageContainer.nsBgObserver = new MutationObserver(function(mutations) {
                var current = imageContainer.style.backgroundImage;
                if (!current || current === "none") return;
                
                if (cardEl.classList.contains(EXPANDED_CLASS)) {
                    if (imageContainer.nsExpectedBg) {
                        if (current.indexOf(imageContainer.nsExpectedBg) === -1) {
                            imageContainer.dataset.nsOriginalBg = current;
                            imageContainer.style.backgroundImage = "url(" + imageContainer.nsExpectedBg + ")";
                        }
                    }
                } else if (imageContainer.dataset.nsPortraitBg) {
                    if (current.indexOf(imageContainer.dataset.nsPortraitBg) === -1) {
                        imageContainer.style.backgroundImage = "url(" + imageContainer.dataset.nsPortraitBg + ")";
                    }
                }
            });
            imageContainer.nsBgObserver.observe(imageContainer, { attributes: true, attributeFilter: ["style"] });
        }
    }

    function setCardBackground(cardEl, url) {
        var imageContainer = cardEl.querySelector(".cardImageContainer");
        if (!imageContainer) {
            return;
        }

        ensureBgObserver(cardEl, imageContainer);

        if (url) {
            imageContainer.nsExpectedBg = url;
            if (imageContainer.dataset.nsOriginalBg === undefined) {
                imageContainer.dataset.nsOriginalBg = imageContainer.style.backgroundImage || "";
            }

            imageContainer.style.backgroundImage = "url(" + url + ")";
        } else if (imageContainer.dataset.nsOriginalBg !== undefined) {
            imageContainer.nsExpectedBg = null;
            imageContainer.style.backgroundImage = imageContainer.dataset.nsOriginalBg;
            delete imageContainer.dataset.nsOriginalBg;
        }
    }

    function collapseCard(cardEl) {
        if (!cardEl) {
            return;
        }

        cardEl.classList.remove(EXPANDED_CLASS);
        cardEl.classList.remove("ns-has-meta");
        setCardBackground(cardEl, null);
        updateCardTitleTruncation(cardEl);
    }

    /**
     * Expands cardEl within its rail, collapsing whichever card on the
     * page was previously expanded (only one expanded card globally).
     * Safe to call on a card that's already expanded (no-op).
     *
     * isAutoDefault marks WHY this call happened: true when it's the
     * automatic "expand the top-left card on load" pick, false/omitted
     * for a real user click. Stamped onto the section (not the card,
     * which gets swapped out from under a rail on re-render) so
     * wireUp() can later tell "this row's expanded card is only here
     * because of the default logic, not because the user chose it" -
     * see the correction logic in wireUp() for why that distinction
     * matters.
     */
    function expandCard(section, cardEl, isAutoDefault) {
        if (!cardEl || cardEl.classList.contains(EXPANDED_CLASS)) {
            return;
        }

        var previouslyExpanded = document.querySelectorAll(".card." + EXPANDED_CLASS);
        for (var i = 0; i < previouslyExpanded.length; i++) {
            if (previouslyExpanded[i] !== cardEl) {
                collapseCard(previouslyExpanded[i]);
            }
        }

        cardEl.classList.add(EXPANDED_CLASS);
        window.nsLastExpandedCardId = cardEl.dataset.id || cardEl.getAttribute("data-id");
        if (section) {
            var allSectionsList = document.querySelectorAll(".verticalSection, .homeSection, [data-type='section']");
            for (var k = 0; k < allSectionsList.length; k++) {
                if (allSectionsList[k] === section) {
                    window.nsLastExpandedSectionIndex = k;
                    break;
                }
            }
        }
        updateCardTitleTruncation(cardEl);

        if (section) {
            if (isAutoDefault) {
                section.dataset.nsAutoDefault = "1";
            } else {
                delete section.dataset.nsAutoDefault;
            }
        }

        var itemId = getItemId(cardEl);
        if (!itemId) {
            return;
        }

        fetchItem(itemId).then(function (item) {
            // The user may have clicked elsewhere (or this card may have
            // been re-collapsed) by the time the request resolves - only
            // apply the swapped image if it's still the expanded card.
            if (!item || !cardEl.classList.contains(EXPANDED_CLASS)) {
                return;
            }

            // Save for synchronous restoration if the DOM mutates
            window.nsLastExpandedCardItem = item;

            var bg = landscapeImageUrl(item);
            if (bg) {
                setCardBackground(cardEl, bg);
            }

            updateExpandedMetadata(cardEl, item);
        });
    }

    /**
     * Delegated, capture-phase click handler (registered once on
     * `document` in start()). Capture phase runs before Jellyfin's own
     * click handling reaches the card, so calling preventDefault /
     * stopPropagation here reliably intercepts navigation - see the
     * comment in start() for why this has to be capture-phase and
     * document-level rather than bound per-card.
     */
    /**
     * Selectors for every kind of dismissible "menu/overlay" surface this
     * skin has to coexist with:
     *  - Jellyfin's legacy three-dot media-row action sheet
     *  - Jellyfin's legacy header/user dropdown (.dialog, .actionSheet)
     *  - Jellyfin Web 12's React+MUI header menus (the user/profile
     *    dropdown, etc.), which render as a MUI Popover/Menu instead of a
     *    legacy action sheet and have none of the classes above.
     *
     * Any of these can be positioned anywhere on screen (including directly
     * over the home hero banner or a poster that visually overlaps it), and
     * all of them are dismissed the same way: a click outside the menu
     * panel. That outside click is still a real, single click on whatever
     * element happens to be underneath the menu - which on the home screen
     * is very often the hero banner or an overlapping card - so nothing
     * about the click itself distinguishes "dismiss the menu" from "activate
     * whatever is behind it" unless we check for an open menu explicitly.
     */
    var OPEN_MENU_SELECTOR =
        ".dialog, .formDialog, .ns-track-menu, " +
        ".actionSheet, .actionSheetDialog, .actionSheetContainer, " +
        ".MuiPopover-root, .MuiPopover-paper, .MuiMenu-paper, [role='menu']";

    /**
     * True if some dismissible menu/overlay (see OPEN_MENU_SELECTOR above)
     * is currently open and visible, and `target` is NOT inside it - i.e.
     * this click's purpose is to close that menu, not to activate whatever
     * element happens to be underneath it.
     *
     * Any code in this plugin that reacts to a plain click on the hero
     * banner or a card (navigation, expansion, etc.) MUST consult this
     * first and bail out when it returns true. There is no single choke
     * point that all such clicks pass through - the hero banner has its own
     * independent click listener separate from the delegated card handler -
     * so this check has to be called from each of them individually rather
     * than solved once in one place.
     */
    function isOutsideClickForOpenMenu(target) {
        var menus = document.querySelectorAll(OPEN_MENU_SELECTOR);

        for (var i = 0; i < menus.length; i++) {
            var menu = menus[i];
            if (!menu || !document.documentElement.contains(menu)) {
                continue;
            }

            var style = window.getComputedStyle(menu);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
                continue;
            }

            if (menu.contains(target)) {
                // The click landed inside a currently-open menu - that's a
                // menu-item interaction, not an outside click.
                continue;
            }

            return true;
        }

        // Some Jellyfin builds only ever expose the menu's items, without a
        // recognizable container class. If those are present and visible,
        // treat their nearest dialog/menu ancestor as the open menu too.
        var menuItem = document.querySelector(".actionSheetMenuItem");
        if (menuItem) {
            var parent = menuItem.closest(
                ".actionSheet, .actionSheetDialog, .actionSheetContainer, .dialog, [role='menu']"
            );
            if (parent) {
                var parentStyle = window.getComputedStyle(parent);
                if (parentStyle.display !== "none" && parentStyle.visibility !== "hidden") {
                    return !parent.contains(target);
                }
            }
        }

        return false;
    }

    function onCardClick(ev) {
        // If the click lands INSIDE a menu (like clicking empty space in the 3-dot action sheet),
        // it shouldn't trigger the card navigation underneath it.
        if (ev.target.closest && ev.target.closest(OPEN_MENU_SELECTOR)) {
            return;
        }

        // If a three-dot/action-sheet/profile menu is open, an outside click
        // belongs to the menu's dismiss logic. Do not let the same click fall
        // through into the hero/card navigation handler. Jellyfin's own
        // bubble-phase handler will close the menu normally.
        //
        // preventDefault (but NOT stopPropagation) here also matters on its
        // own: a card's poster is a real <a href="#/details?..."> anchor, so
        // if the outside click happens to land on one, the browser will
        // navigate via that href natively - with no JS handler involved at
        // all - unless we stop that default action. stopPropagation is
        // deliberately left alone so the menu's own click-away listener
        // (Jellyfin's or MUI's) still receives this event and actually
        // closes the menu.
        if (isOutsideClickForOpenMenu(ev.target)) {
            ev.preventDefault();
            return;
        }

        var cardEl = ev.target.closest(".card");
        if (!cardEl) {
            return;
        }

        var section = findSection(cardEl);
        if (!section) {
            // Not a home-screen rail (e.g. a library grid) - leave stock
            // click-to-open behaviour completely alone.
            return;
        }

        /*
         * IMPORTANT: controls inside a collapsed poster must remain directly
         * actionable. Previously this card-level capture handler intercepted
         * the first click on a poster button, expanded the card to landscape,
         * and only the second click reached Jellyfin's button handler.
         *
         * Let genuine interactive controls pass through untouched. The card
         * itself (or its non-interactive content) still uses the first click
         * to expand, while Play / overlay / action buttons work immediately
         * in the collapsed portrait state.
         *
         * NOTE: Jellyfin's own poster anchor (.cardImageContainer) is itself
         * a data-action="link" element - that's the plain "navigate to
         * details" affordance, not a Play/Menu/etc. action button. It must
         * NOT be treated as a "genuine interactive control" here, or every
         * poster click matches this selector and the card navigates
         * straight to the details screen without ever expanding. Only
         * data-action values other than "link" (play, menu, resume, ...)
         * get the pass-through.
         */
        var control = ev.target.closest(
            "button, [role='button'], .cardOverlayButton, " +
            ".cardOverlayButton-hover, [data-action]:not([data-action='link']), " +
            "input, select, textarea"
        );
        if (control && cardEl.contains(control)) {
            return;
        }

        if (cardEl.classList.contains(EXPANDED_CLASS)) {
            // Already the rail's landscape tile - let the click go through
            // to Jellyfin's own handler and open the details screen.
            return;
        }

        ev.preventDefault();
        ev.stopPropagation();
        if (typeof ev.stopImmediatePropagation === "function") {
            ev.stopImmediatePropagation();
        }

        expandCard(section, cardEl);
    }

    /**
     * The first time a rail actually has cards rendered in it, expand the
     * first one by default (matching the reference UI's Continue Watching
     * row). Guarded by a data attribute so it only ever fires once per
     * rail element - after that, which card is expanded is entirely up to
     * the user's clicks, and we must never stomp on that during
     * re-renders/virtualized scrolling.
     */
    function initDefaultExpansion(section, shouldExpand) {
        if (section.dataset.nsRowInit) {
            return;
        }

        var cards = getCards(section);
        if (!cards.length) {
            // Rail hasn't rendered its cards yet - try again on the next
            // MutationObserver pass instead of marking this rail "done".
            return;
        }

        section.dataset.nsRowInit = "1";

        if (shouldExpand && !section.querySelector(".card." + EXPANDED_CLASS)) {
            var hasVisibleExpanded = false;
            var expandedCards = document.querySelectorAll(".card." + EXPANDED_CLASS);
            for (var j = 0; j < expandedCards.length; j++) {
                var ec = expandedCards[j];
                if (!ec.classList.contains('hide') && !(ec.closest && ec.closest('.hide')) && window.getComputedStyle(ec).display !== 'none') {
                    hasVisibleExpanded = true;
                    break;
                }
            }
            if (!hasVisibleExpanded) {
                expandCard(section, cards[0], true);
            }
        }
    }

    /**
     * True for a card that should show its FULL title: the currently
     * expanded (landscape) rail tile, or a card type that's landscape by
     * default and never collapses to portrait in the first place.
     */
    function isLandscapeCard(cardEl) {
        if (cardEl.classList.contains(EXPANDED_CLASS)) {
            return true;
        }

        for (var i = 0; i < LANDSCAPE_CARD_TYPE_CLASSES.length; i++) {
            if (cardEl.classList.contains(LANDSCAPE_CARD_TYPE_CLASSES[i])) {
                return true;
            }
        }

        return false;
    }

    function truncateTitle(text) {
        if (!text || text.length <= TITLE_MAX_CHARS) {
            return text;
        }

        return text.slice(0, TITLE_MAX_CHARS) + "...";
    }

    /**
     * Truncates (or restores) a card's title text depending on whether
     * it's currently portrait/collapsed or landscape. The untruncated
     * title is captured into a data attribute the FIRST time this runs
     * for a card - every later call (rail re-render, expand, collapse)
     * reads from that stored original instead of re-truncating a string
     * that may already have "..." on the end of it.
     */
    function updateCardTitleTruncation(cardEl) {
        var titleEl = cardEl.querySelector(".cardText-first");
        if (!titleEl) {
            return;
        }

        // Only lock in nsFullTitle once we've actually seen real text -
        // if this runs before Jellyfin has populated the title (e.g. the
        // automatic "expand first card on load" pass can fire before the
        // card's data has rendered), caching "" here would permanently
        // blank the title: every later call would keep forcing it back
        // to that empty cached value even after the real title showed up.
        if (!cardEl.dataset.nsFullTitle && titleEl.textContent) {
            cardEl.dataset.nsFullTitle = titleEl.textContent;
        }

        var fullTitle = cardEl.dataset.nsFullTitle || titleEl.textContent || "";
        if (!fullTitle) {
            return;
        }

        var nextText = isLandscapeCard(cardEl) ? fullTitle : truncateTitle(fullTitle);

        if (titleEl.textContent !== nextText) {
            titleEl.textContent = nextText;
        }
    }

    function updateCWText(cardEl) {
        if (!cardEl.querySelector('.itemProgressBar') && !cardEl.querySelector('.cardProgress') && !cardEl.querySelector('.itemLinearProgress')) {
            return;
        }
        
        var itemId = getItemId(cardEl);
        if (!itemId) {
            return;
        }

        var needsUpdate = false;
        var imgContainer = cardEl.querySelector(".cardImageContainer");
        var isExpanded = cardEl.classList.contains(EXPANDED_CLASS);
        
        if (cardEl.dataset.nsCwTextUpdated !== itemId) {
            needsUpdate = true;
        } else if (imgContainer && imgContainer.dataset.nsPortraitBg) {
            var currentBg = imgContainer.style.backgroundImage;
            if (isExpanded) {
                if (imgContainer.dataset.nsOriginalBg === undefined || imgContainer.dataset.nsOriginalBg.indexOf(imgContainer.dataset.nsPortraitBg) === -1) {
                    needsUpdate = true;
                } else if (imgContainer.dataset.nsLandscapeBg && currentBg && currentBg !== "none" && currentBg.indexOf(imgContainer.dataset.nsLandscapeBg) === -1) {
                    needsUpdate = true;
                }
            } else {
                if (imgContainer.dataset.nsOriginalBg !== undefined) {
                    needsUpdate = true; // Should not have nsOriginalBg if collapsed
                } else if (currentBg && currentBg !== "none" && currentBg.indexOf(imgContainer.dataset.nsPortraitBg) === -1) {
                    needsUpdate = true;
                }
            }
        }
        
        if (!needsUpdate) {
            return;
        }
        
        cardEl.dataset.nsCwTextUpdated = itemId;
        
        fetchItem(itemId).then(function (item) {
            if (!item) return;

            var portraitUrl = portraitImageUrl(item);
            if (portraitUrl) {
                var imageContainer = cardEl.querySelector(".cardImageContainer");
                if (imageContainer) {
                    ensureBgObserver(cardEl, imageContainer);
                    imageContainer.dataset.nsPortraitBg = portraitUrl;
                    var newBg = "url(" + portraitUrl + ")";
                    if (cardEl.classList.contains(EXPANDED_CLASS)) {
                        imageContainer.dataset.nsOriginalBg = newBg;
                        var landBg = landscapeImageUrl(item);
                        if (landBg) {
                            var landUrl = "url(" + landBg + ")";
                            imageContainer.dataset.nsLandscapeBg = landBg;
                            imageContainer.nsExpectedBg = landBg;
                            if (imageContainer.style.backgroundImage !== landUrl && imageContainer.style.backgroundImage !== 'url("' + landBg + '")') {
                                imageContainer.style.backgroundImage = landUrl;
                            }
                        }
                    } else {
                        imageContainer.nsExpectedBg = null;
                        if (imageContainer.dataset.nsOriginalBg !== undefined) {
                            delete imageContainer.dataset.nsOriginalBg;
                        }
                        if (imageContainer.style.backgroundImage !== newBg && imageContainer.style.backgroundImage !== 'url("' + portraitUrl + '")') {
                            imageContainer.style.backgroundImage = newBg;
                        }
                    }
                }
            }

            if (!item.UserData || !item.RunTimeTicks) {
                return;
            }
            
            var playedTicks = item.UserData.PlaybackPositionTicks || 0;
            var totalTicks = item.RunTimeTicks;
            var remainingTicks = totalTicks - playedTicks;
            
            if (remainingTicks > 0) {
                var remainingSeconds = Math.floor(remainingTicks / 10000000);
                var hours = Math.floor(remainingSeconds / 3600);
                var minutes = Math.floor((remainingSeconds % 3600) / 60);
                
                var text = "";
                if (hours > 0) {
                    text += hours + "h ";
                }
                if (minutes > 0 || hours === 0) {
                    text += minutes + "m ";
                }
                text += "left";
                
                var secondaryTextEl = cardEl.querySelector('.cardText-secondary');
                if (secondaryTextEl) {
                    secondaryTextEl.innerText = text;
                }
            }
        });
    }

    function wireUp(root) {
        var allSections = root.querySelectorAll(".verticalSection, .homeSection, [data-type='section']");

        // Every row on the item detail page - Cast & Crew AND "More Like
        // This" (similar items) - shares this same ".verticalSection"
        // wrapper class with a home-screen rail. Left in, both used to get
        // treated as an ordinary rail below: initDefaultExpansion would
        // auto-"expand" the first card exactly like a home rail's first
        // card, pulling in genre/year/overview text (a person's bio for
        // Cast & Crew, or a full synopsis card for a similar-items title)
        // that stock Jellyfin never shows there - it's meant to be a plain
        // title+year card like every other one in that row. So the whole
        // detail page is filtered out here up front rather than patched
        // section-by-section.
        var sections = Array.prototype.filter.call(allSections, function (s) {
            return !s.closest(DETAIL_SEL.page);
        });
        var firstVisibleSection = null;
        
        for (var i = 0; i < sections.length; i++) {
            var s = sections[i];
            
            if (s.classList.contains('hide') || (s.closest && s.closest('.hide'))) continue;
            if (window.getComputedStyle(s).display === 'none') continue;
            
            if (getCards(s).length > 0) {
                firstVisibleSection = s;
                break;
            }
        }

        /*
         * Continue Watching typically needs an extra "what's partially
         * watched" round-trip stock library rails don't, so it often
         * finishes rendering its cards AFTER the rails below it. The very
         * first wireUp() pass can then find CW's row still empty, pick a
         * lower rail (e.g. Movies) as "first visible section with cards",
         * and auto-expand THAT one. Once CW's cards do arrive, its row is
         * now the true first-visible-with-cards section, but the plain
         * "is anything already expanded" guard inside initDefaultExpansion
         * would leave the earlier wrong pick alone forever, since *some*
         * card is already expanded on the page.
         *
         * Fix: only a real auto-default expansion stamps
         * section.dataset.nsAutoDefault (see expandCard) - a user click
         * never does. So if the row currently holding the default
         * expansion got it automatically, and a section earlier in DOM
         * order than it has since gained cards, that earlier section is
         * the actual answer - swap the default over to it. This never
         * touches a card the user expanded themselves.
         */
        if (firstVisibleSection) {
            var currentDefaultCard = document.querySelector(".card." + EXPANDED_CLASS);
            var currentDefaultSection = currentDefaultCard ? findSection(currentDefaultCard) : null;

            if (currentDefaultSection &&
                currentDefaultSection !== firstVisibleSection &&
                currentDefaultSection.dataset.nsAutoDefault === "1" &&
                firstVisibleSection.compareDocumentPosition &&
                (firstVisibleSection.compareDocumentPosition(currentDefaultSection) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                var correctCards = getCards(firstVisibleSection);
                if (correctCards.length) {
                    expandCard(firstVisibleSection, correctCards[0], true);
                    firstVisibleSection.dataset.nsRowInit = "1";
                }
            }
        }

        if (!document.querySelector(".card." + EXPANDED_CLASS)) {
            var restored = false;
            if (window.nsLastExpandedCardId) {
                var possibleCards = document.querySelectorAll(".card[data-id='" + window.nsLastExpandedCardId + "']");
                var targetCard = possibleCards.length > 0 ? possibleCards[0] : null;

                if (window.nsLastExpandedSectionIndex !== undefined) {
                    var allSectionsList = document.querySelectorAll(".verticalSection, .homeSection, [data-type='section']");
                    var targetSection = allSectionsList[window.nsLastExpandedSectionIndex];
                    if (targetSection) {
                        var cardInSection = targetSection.querySelector(".card[data-id='" + window.nsLastExpandedCardId + "']");
                        if (cardInSection) {
                            targetCard = cardInSection;
                        }
                    }
                }

                if (targetCard) {
                    targetCard.style.transition = "none";
                    var scalable = targetCard.querySelector(".cardScalable");
                    if (scalable) scalable.style.transition = "none";
                    var texts = targetCard.querySelectorAll(".cardText, .cardText-first, .cardText-secondary");
                    for (var t = 0; t < texts.length; t++) texts[t].style.transition = "none";

                    // Apply image and metadata synchronously before reflow to prevent portrait stretch
                    if (window.nsLastExpandedCardItem && window.nsLastExpandedCardId === window.nsLastExpandedCardItem.Id) {
                        var bg = landscapeImageUrl(window.nsLastExpandedCardItem);
                        if (bg) setCardBackground(targetCard, bg);
                        updateExpandedMetadata(targetCard, window.nsLastExpandedCardItem);
                    }

                    expandCard(findSection(targetCard), targetCard, false);

                    // Force reflow so the expansion happens instantly without animation
                    void targetCard.offsetWidth;

                    targetCard.style.transition = "";
                    if (scalable) scalable.style.transition = "";
                    for (var t = 0; t < texts.length; t++) texts[t].style.transition = "";

                    restored = true;
                }
            }
            if (!restored && firstVisibleSection) {
                var fallbackCards = getCards(firstVisibleSection);
                if (fallbackCards.length) {
                    expandCard(firstVisibleSection, fallbackCards[0], true);
                    firstVisibleSection.dataset.nsRowInit = "1";
                }
            }
        }

        sections.forEach(function (section) {
            initDefaultExpansion(section, section === firstVisibleSection);
            
            var cards = getCards(section);
            for (var j = 0; j < cards.length; j++) {
                updateCWText(cards[j]);
                updateCardTitleTruncation(cards[j]);
            }
        });

        reorderHeader(root);
    }

    function reorderHeader(root) {
        function getDirectChildOf(element, parent) {
            while (element && element.parentElement !== parent && element.parentElement !== null) {
                element = element.parentElement;
            }
            return element;
        }

        // v12 Header (React + MUI)
        var toolbar = root.querySelector('.MuiToolbar-root');
        if (toolbar) {
            var stack = toolbar.querySelector('.MuiStack-root');
            var boxes = toolbar.querySelectorAll('.MuiBox-root');
            if (stack && boxes.length > 0) {
                
                // Tag Server Button to track it
                var serverBtn = toolbar.querySelector('[data-ns-server-btn="1"]');
                if (!serverBtn && stack.children.length > 0) {
                    serverBtn = stack.children[0];
                    serverBtn.dataset.nsServerBtn = "1";
                }
                
                // Move Server Button out of the centered stack to the top left
                if (serverBtn && serverBtn.parentElement === stack) {
                    toolbar.insertBefore(serverBtn, toolbar.firstChild);
                }

                // Give the top-left group (logo + server name) the same pill
                // treatment as the active center-tab indicator
                if (serverBtn) {
                    serverBtn.classList.add('ns-header-pill');
                }

                // Group the top-right cluster (SyncPlay, Cast, User Menu) into a
                // single wrapper so they share one pill background, matching the
                // active center-tab indicator. Only the two MuiBox-root icon
                // clusters are grouped - the center tab bar is left untouched.
                // NOTE: the User Menu box can mount slightly after the initial
                // header render (once user info/avatar is available), so this
                // keeps sweeping any stray MuiBox-root toolbar children into the
                // wrapper on every call instead of only creating it once.
                var rightGroup = toolbar.querySelector('.ns-header-right-group');
                var strayBoxes = Array.prototype.slice.call(toolbar.children).filter(function (child) {
                    return child.classList.contains('MuiBox-root') && child !== rightGroup;
                });
                if (strayBoxes.length > 0) {
                    if (!rightGroup) {
                        rightGroup = document.createElement('div');
                        rightGroup.className = 'ns-header-pill ns-header-right-group';
                        strayBoxes[0].parentElement.insertBefore(rightGroup, strayBoxes[0]);
                    }
                    strayBoxes.forEach(function (box) {
                        rightGroup.appendChild(box);
                    });
                }

                // Find Search across the ENTIRE toolbar so we don't lose it after moving it to stack
                var searchBtn = null;
                var allBtns = Array.prototype.slice.call(toolbar.querySelectorAll('button, a'));
                for (var j = 0; j < allBtns.length; j++) {
                    var btn = allBtns[j];
                    var svg = btn.querySelector('svg');
                    var aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                    if (aria.indexOf('search') !== -1 || (svg && svg.getAttribute('data-testid') === 'SearchIcon')) {
                        searchBtn = btn;
                        break;
                    }
                }
                
                // Move search left to library source
                if (searchBtn && searchBtn.parentElement !== stack) {
                    // Since serverBtn is moved, library tabs start at firstChild
                    stack.insertBefore(searchBtn, stack.firstChild);
                }
                
                // Move Favorites right of library source
                var favBtn = Array.prototype.slice.call(stack.querySelectorAll('button, a, .emby-tab-button')).filter(function (btn) {
                    var svg = btn.querySelector('svg');
                    var aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                    return (btn.textContent || '').toLowerCase().indexOf('favorite') !== -1 || 
                           aria.indexOf('favorite') !== -1 ||
                           (svg && svg.getAttribute('data-testid') === 'FavoriteIcon');
                })[0];
                
                var favContainer = null;
                if (favBtn) {
                    favContainer = getDirectChildOf(favBtn, stack);
                    if (favContainer && stack.lastElementChild !== favContainer) {
                        stack.appendChild(favContainer);
                    }
                }
                
                // Add Home button right of search button
                if (searchBtn && !stack.querySelector('[data-ns-home-btn="1"]')) {
                    var templateTab = null;
                    for (var k = 0; k < stack.children.length; k++) {
                        var child = stack.children[k];
                        if (child !== searchBtn && child !== favContainer && !child.dataset.nsServerBtn) {
                            templateTab = child;
                            break;
                        }
                    }
                    if (templateTab) {
                        var homeBtn = document.createElement('a');
                        homeBtn.className = templateTab.className;
                        homeBtn.dataset.nsHomeBtn = "1";
                        homeBtn.href = "#!/home.html";
                        homeBtn.innerHTML = '<span class="MuiTypography-root MuiTypography-button">Home</span>';
                        
                        homeBtn.addEventListener('click', function(e) {
                            e.preventDefault();
                            e.stopPropagation();
                            window.location.hash = "#!/home.html";
                        });
                        
                        if (searchBtn.nextSibling) {
                            stack.insertBefore(homeBtn, searchBtn.nextSibling);
                        } else {
                            stack.appendChild(homeBtn);
                        }
                    }
                }
                
                // Hide prefix icons from library tabs
                var allStackBtns = stack.querySelectorAll('button, a');
                for (var b = 0; b < allStackBtns.length; b++) {
                    var tBtn = allStackBtns[b];
                    if (tBtn.dataset.nsServerBtn === "1") continue;
                    
                    var tSvg = tBtn.querySelector('svg');
                    var tAria = (tBtn.getAttribute('aria-label') || '').toLowerCase();
                    var isSearch = tAria.indexOf('search') !== -1 || (tSvg && tSvg.getAttribute('data-testid') === 'SearchIcon');
                    
                    if (!isSearch && tSvg) {
                        tSvg.style.display = 'none';
                    }
                }
            }
        }
        
        // 10.9 Legacy Header
        var headerTop = root.querySelector('.headerTop');
        if (headerTop) {
            var headerTabs = headerTop.querySelector('.headerTabs');
            var headerRight = headerTop.querySelector('.headerRight');
            
            if (headerTabs && headerRight) {
                 var searchBtnLegacy = headerRight.querySelector('.btnSearch') || headerRight.querySelector('[data-id="search"]');
                 if (searchBtnLegacy && searchBtnLegacy.parentElement !== headerTabs) {
                     headerTabs.insertBefore(searchBtnLegacy, headerTabs.firstChild);
                 }
                 
                 var favBtnLegacy = headerTabs.querySelector('.btnFavorites') || Array.prototype.slice.call(headerTabs.querySelectorAll('button, a, .emby-tab-button')).filter(function(el) {
                     return (el.textContent || '').toLowerCase().indexOf('favorite') !== -1;
                 })[0];
                 
                 var favContLegacy = null;
                 if (favBtnLegacy) {
                     favContLegacy = getDirectChildOf(favBtnLegacy, headerTabs);
                     if (favContLegacy && headerTabs.lastElementChild !== favContLegacy) {
                         headerTabs.appendChild(favContLegacy);
                     }
                 }
                 
                 if (searchBtnLegacy && !headerTabs.querySelector('[data-ns-home-btn="1"]')) {
                     var templateLegacyTab = null;
                     for (var m = 0; m < headerTabs.children.length; m++) {
                         var c = headerTabs.children[m];
                         if (c !== searchBtnLegacy && c !== favContLegacy) {
                             templateLegacyTab = c;
                             break;
                         }
                     }
                     if (templateLegacyTab) {
                         var homeLegacy = document.createElement('a');
                         homeLegacy.className = templateLegacyTab.className;
                         homeLegacy.dataset.nsHomeBtn = "1";
                         homeLegacy.href = "#!/home.html";
                         homeLegacy.innerHTML = '<span>Home</span>';
                         
                         homeLegacy.addEventListener('click', function(e) {
                             e.preventDefault(); e.stopPropagation(); window.location.hash = "#!/home.html";
                         });
                         
                         if (searchBtnLegacy.nextSibling) {
                             headerTabs.insertBefore(homeLegacy, searchBtnLegacy.nextSibling);
                         } else {
                             headerTabs.appendChild(homeLegacy);
                         }
                     }
                 }
                 
                 // Hide prefix icons from legacy library tabs
                 var allLegacyBtns = headerTabs.querySelectorAll('button, a, .emby-tab-button');
                 for (var lb = 0; lb < allLegacyBtns.length; lb++) {
                     var ltBtn = allLegacyBtns[lb];
                     var ltIcon = ltBtn.querySelector('.material-icons') || ltBtn.querySelector('svg');
                     var isLSearch = ltBtn.classList.contains('btnSearch') || ltBtn.getAttribute('data-id') === 'search' || (ltBtn.getAttribute('aria-label') || '').toLowerCase().indexOf('search') !== -1;
                     if (!isLSearch && ltIcon) {
                         ltIcon.style.display = 'none';
                     }
                 }
            }
        }
    }

    /**
     * True when `hash` (already lower-cased) is the Home route itself -
     * not Favorites, not Search, not a library tab, not a details page.
     * jellyfin-web has used several shapes for this route across versions
     * ("", "#!", "#!/home.html", and a "tab=" query on top of it), so all
     * of them are accepted here.
     *
     * Extracted into its own function because two independent features now
     * need the exact same answer: the active-nav-pill highlight
     * (updateActivePill) and the home hero banner below - keeping one copy
     * means they can never disagree about what counts as "on Home".
     */
    function isHomeRouteHash(hash) {
        hash = (hash || '').toLowerCase();
        var pureHash = hash.split('?')[0].replace(/\/$/, '');
        return (pureHash === '' || pureHash === '#!' || pureHash === '#!/home.html' || pureHash.indexOf('home') !== -1) &&
               hash.indexOf('favorite') === -1 &&
               hash.indexOf('search') === -1 &&
               hash.indexOf('details') === -1 &&
               (hash.indexOf('tab=') === -1 || hash.indexOf('tab=0') !== -1 || hash.indexOf('tab=home') !== -1);
    }

    function updateActivePill() {
        var hash = (window.location.hash || '').toLowerCase();
        
        var stacks = document.querySelectorAll('.MuiStack-root, .headerTabs');
        for (var s = 0; s < stacks.length; s++) {
            var stack = stacks[s];
            var tabs = Array.prototype.slice.call(stack.querySelectorAll('button, a, .emby-tab-button'));
            
            var nativeActiveBtn = null;
            var homeCustomBtn = null;
            
            for (var i = 0; i < tabs.length; i++) {
                var btn = tabs[i];
                var svg = btn.querySelector('svg');
                var aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                var text = (btn.textContent || '').toLowerCase().trim();
                
                var isSearch = aria.indexOf('search') !== -1 || (svg && svg.getAttribute('data-testid') === 'SearchIcon') || btn.classList.contains('btnSearch') || btn.getAttribute('data-id') === 'search';
                var isHome = btn.dataset.nsHomeBtn === "1";
                
                btn.classList.remove('ns-active-pill');
                btn.classList.remove('ns-active-circle');
                
                var isNativeActive = btn.classList.contains('Mui-selected') || 
                                     btn.getAttribute('aria-current') === 'page' || 
                                     btn.getAttribute('aria-selected') === 'true' ||
                                     btn.classList.contains('active') ||
                                     btn.classList.contains('emby-tab-button-active') ||
                                     btn.classList.contains('MuiButton-textPrimary') ||
                                     btn.classList.contains('Mui-active');
                                     
                if (isSearch) {
                    if (isNativeActive || hash.indexOf('search') !== -1) nativeActiveBtn = btn;
                    continue;
                }
                
                if (isHome) {
                    homeCustomBtn = btn;
                } else if (isNativeActive) {
                    nativeActiveBtn = btn;
                }
            }
            
            var bestMatch = nativeActiveBtn;
            
            if (!bestMatch) {
                var isPureHome = isHomeRouteHash(hash);

                if (isPureHome) {
                    bestMatch = homeCustomBtn;
                } else {
                    for (var k = 0; k < tabs.length; k++) {
                        var cBtn = tabs[k];
                        if (cBtn.dataset.nsHomeBtn === "1") continue;
                        var cHref = (cBtn.getAttribute('href') || '').toLowerCase();
                        var cText = (cBtn.textContent || '').toLowerCase().trim();
                        if (cHref && hash.indexOf(cHref.split('?')[0]) !== -1 && cHref !== '#!/home.html') {
                            bestMatch = cBtn; break;
                        } else if (!cHref && cText && hash.indexOf(cText) !== -1 && cText !== 'home' && cText !== 'search') {
                            bestMatch = cBtn; break;
                        }
                    }
                }
            }
            
            if (!bestMatch && hash.indexOf('tab=1') !== -1) {
                for (var m = 0; m < tabs.length; m++) {
                    if ((tabs[m].textContent || '').toLowerCase().indexOf('favorite') !== -1) {
                        bestMatch = tabs[m]; break;
                    }
                }
            }
            
            if (bestMatch) {
                var bestSvg = bestMatch.querySelector('svg');
                var bestAria = (bestMatch.getAttribute('aria-label') || '').toLowerCase();
                var isBestSearch = bestAria.indexOf('search') !== -1 || (bestSvg && bestSvg.getAttribute('data-testid') === 'SearchIcon') || bestMatch.classList.contains('btnSearch') || bestMatch.getAttribute('data-id') === 'search';
                
                if (isBestSearch) {
                    bestMatch.classList.add('ns-active-circle');
                } else {
                    bestMatch.classList.add('ns-active-pill');
                }
            }
        }
    }

    /**
     * ------------------------------------------------------------------
     * Item detail screen (Netflix/Apple-TV-style hero)
     * ------------------------------------------------------------------
     * REWRITTEN from an earlier version that reparented stock text
     * elements (.detailLogo/.itemMiscInfo/.genres/.overview) into a new
     * hero block. That depended on those elements already being
     * populated by stock Jellyfin's OWN render functions by the time our
     * MutationObserver pass ran - a race that lost often enough in
     * practice to produce a hero missing its logo, meta row and/or
     * synopsis, while the stock originals were left behind un-hidden
     * (a CSS scoping bug on top of that made it worse - see main.css).
     *
     * This version builds every TEXT/IMAGE piece of the hero (logo,
     * genre/year/runtime, age rating, ratings, quality/audio/CC badges,
     * tagline, synopsis) directly from the full item DTO this file
     * already fetches via window.ApiClient - the same authenticated
     * client every stock screen uses, so no dependency on WHEN stock's
     * own render functions happen to run relative to ours.
     *
     * The one thing still REPARENTED (moved, not rebuilt) is
     * ".mainDetailButtons" - Play/Resume, mark-watched
     * (emby-playstatebutton), favourite (emby-ratingbutton), trailer,
     * and "more" (3-dot) are Custom Elements with real playback/API
     * logic behind them; reimplementing that from scratch would risk
     * silently-wrong behaviour (e.g. a fake favourite button that
     * doesn't actually call the API), whereas moving the real elements
     * keeps them 100% functionally identical to stock. That move is
     * now RETRIED on every observer pass (see attachActionButtons)
     * instead of being a one-shot attempt, so a late-appearing button
     * row still gets picked up instead of being permanently missed.
     *
     * All the stock selectors used anywhere below live in one place
     * (DETAIL_SEL) so a future jellyfin-web class rename is a one-line
     * fix. Every function here is defensive (try/catch, null checks) so
     * a lookup that doesn't match on your build can never throw and
     * interrupt the shared start()/MutationObserver loop this is wired
     * into alongside wireUp()/updateActivePill().
     */
    var DETAIL_SEL = {
        page: "#itemDetailPage",
        wrapper: ".detailPageWrapperContainer",
        mainButtons: ".mainDetailButtons",
        castContent: "#castContent"
    };

    /**
     * Pulls the item id out of the current hash for both URL shapes
     * jellyfin-web has used for this route (?id=xxx as a query param,
     * or /itemId/xxx as a path segment) - whichever one the running
     * version uses, one of these two will match.
     */
    function getDetailItemIdFromHash() {
        var hash = window.location.hash || "";
        var queryMatch = hash.match(/[?&]id=([^&]+)/);
        if (queryMatch) {
            return decodeURIComponent(queryMatch[1]);
        }
        var pathMatch = hash.match(/\/details\/([^/?&]+)/);
        if (pathMatch) {
            return decodeURIComponent(pathMatch[1]);
        }
        return null;
    }

    /**
     * True only while an item-detail page is the CURRENTLY VISIBLE page -
     * jellyfin-web keeps previously-visited pages in the DOM (hidden),
     * so a plain querySelector for "#itemDetailPage" could still match
     * a stale one. Checked via computed style (not just a class name)
     * since different jellyfin-web versions have used different
     * mechanisms (a "hide" class vs. inline style) to hide inactive
     * pages.
     */
    function getVisibleDetailPage() {
        try {
            var pages = document.querySelectorAll(DETAIL_SEL.page);
            for (var i = 0; i < pages.length; i++) {
                var p = pages[i];
                if (window.getComputedStyle(p).display !== "none") {
                    return p;
                }
            }
        } catch (err) {
            /* fall through to null below */
        }
        return null;
    }

    /**
     * Keeps <body class="ns-detail-page"> in sync with whether an
     * item-detail page is currently visible - the CSS file uses this
     * single class to hide the top header/tabs only on this screen.
     *
     * Deliberately does nothing else. The backdrop used to be shown/hidden
     * from in here too (keyed off this same "is a detail page visible"
     * check), which was the actual bug: jellyfin-web's page transition
     * legitimately reports display:none for the incoming/outgoing detail
     * page for a frame or two, and this function runs from a
     * MutationObserver that fires on nearly every DOM change - so it was
     * near-guaranteed to catch one of those frames and hide the backdrop
     * on it. The backdrop now has its own single owner, syncDetailBackdrop
     * (below), driven off the URL hash rather than transient layout state -
     * see that function's comment for the full reasoning.
     */
    function updateDetailPageBodyClass() {
        try {
            if (getVisibleDetailPage()) {
                document.body.classList.add("ns-detail-page");
            } else {
                document.body.classList.remove("ns-detail-page");
            }
        } catch (err) {
            /* non-fatal - header just won't hide/show this pass */
        }
    }

    /* --------------------------------------------------------------------
       Nuvio-style detail scroll darkening

       Nuvio switches state once the first hero item has been scrolled past:
       firstVisibleItemIndex > 0 OR the hero has moved more than 200 px.
       Its backdrop image then animates to 15% opacity over the dark theme
       background while the left gradient fades out.

       Jellyfin's detail page may scroll inside a nested container rather
       than window/document, so this helper walks upward from the visible
       detail page and uses the first real scrollable ancestor.
    -------------------------------------------------------------------- */
    var detailScrollWiringInstalled = false;
    var detailScrollRaf = 0;

    function getDetailScrollTop() {
        var page = getVisibleDetailPage();
        if (!page) {
            return 0;
        }

        try {
            var el = page.parentElement;
            while (el && el !== document.body && el !== document.documentElement) {
                var cs = window.getComputedStyle(el);
                var overflowY = cs.overflowY;
                if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1) {
                    return Math.max(0, el.scrollTop || 0);
                }
                el = el.parentElement;
            }

            var scrollingElement = document.scrollingElement || document.documentElement;
            return Math.max(0, scrollingElement.scrollTop || window.scrollY || 0);
        } catch (err) {
            return Math.max(0, window.scrollY || 0);
        }
    }

    function syncDetailScrollDarkening() {
        try {
            var body = document.body;
            var onDetail = !!getDetailItemIdFromHash() && !!getVisibleDetailPage();
            if (!onDetail) {
                body.classList.remove("ns-detail-scrolled");
                return;
            }

            /* Matches Nuvio's `firstVisibleItemScrollOffset > 200` hero
               threshold closely while remaining compatible with Jellyfin's
               DOM-based scrolling model. */
            var scrolledPastHero = getDetailScrollTop() > 200;
            body.classList.toggle("ns-detail-scrolled", scrolledPastHero);
        } catch (err) {
            /* Keep the visual state untouched on a transient layout pass. */
        }
    }

    function queueDetailScrollDarkening() {
        if (detailScrollRaf) {
            return;
        }
        detailScrollRaf = window.requestAnimationFrame(function () {
            detailScrollRaf = 0;
            syncDetailScrollDarkening();
        });
    }

    function wireDetailScrollDarkening() {
        if (detailScrollWiringInstalled) {
            return;
        }
        detailScrollWiringInstalled = true;

        /* Capture phase catches scroll events from Jellyfin's nested scroll
           containers as well as normal document scrolling. */
        window.addEventListener("scroll", queueDetailScrollDarkening, true);
        window.addEventListener("resize", queueDetailScrollDarkening);
        window.addEventListener("hashchange", queueDetailScrollDarkening);

        syncDetailScrollDarkening();
    }

    /**
     * Clear-logo image URL, built the same way stock Jellyfin's own
     * (private, not reachable from here) logoImageUrl() builds it - an
     * item's own Logo image tag, falling back to a parent's (e.g. a
     * movie with no logo of its own falling back to a collection logo).
     * Built independently instead of reparenting the stock .detailLogo
     * element so this never depends on stock's own render timing.
     */
    function detailLogoImageUrl(item) {
        try {
            if (!window.ApiClient) {
                return null;
            }
            if (item.ImageTags && item.ImageTags.Logo) {
                return window.ApiClient.getScaledImageUrl(item.Id, {
                    type: "Logo",
                    tag: item.ImageTags.Logo,
                    maxWidth: 800
                });
            }
            if (item.ParentLogoItemId && item.ParentLogoImageTag) {
                return window.ApiClient.getScaledImageUrl(item.ParentLogoItemId, {
                    type: "Logo",
                    tag: item.ParentLogoImageTag,
                    maxWidth: 800
                });
            }
        } catch (err) {
            /* no logo available - caller falls back to a text title */
        }
        return null;
    }

    /**
     * RunTimeTicks (100-nanosecond ticks) -> "Xh Ym" / "Xm" text.
     */
    function formatRuntime(ticks) {
        if (!ticks) {
            return null;
        }
        var totalMinutes = Math.round(ticks / 600000000);
        if (totalMinutes <= 0) {
            return null;
        }
        var hours = Math.floor(totalMinutes / 60);
        var minutes = totalMinutes % 60;
        if (hours > 0) {
            return hours + "h" + (minutes ? " " + minutes + "min" : "");
        }
        return minutes + "min";
    }

    function makeBadge(text) {
        var el = document.createElement("span");
        el.className = "ns-badge";
        el.textContent = text;
        return el;
    }

    /**
     * Small brand marks used to identify which source a rating badge is
     * from. TMDB and IMDb use the real logo artwork (embedded as base64
     * data URIs so the plugin stays a single self-contained DLL with no
     * separate image assets to ship/host); Rotten Tomatoes stays a small
     * hand-drawn SVG mark since no logo asset was supplied for it.
     */
    var TMDB_LOGO_SRC = "data:image/webp;base64,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";
    var IMDB_LOGO_SRC = "data:image/webp;base64,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";

    var TMDB_ICON_HTML = '<img class="ns-badge-rating-logo ns-badge-rating-logo-tmdb" src="' + TMDB_LOGO_SRC + '" alt="TMDB" />';
    var IMDB_ICON_HTML = '<img class="ns-badge-rating-logo ns-badge-rating-logo-imdb" src="' + IMDB_LOGO_SRC + '" alt="IMDb" />';

    var RT_ICON_SVG = '<svg class="ns-rt-rating-logo" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<circle cx="12" cy="14" r="8.2" fill="#fa320a"/>' +
        '<ellipse cx="12" cy="6.2" rx="2.6" ry="1.7" fill="#3aa655"/>' +
        '<path d="M7.8 8.2c1-2.2 2.6-3.4 4.2-3.4s3.2 1.2 4.2 3.4" stroke="#3aa655" stroke-width="1.8" fill="none" stroke-linecap="round"/>' +
        '</svg>';

    /**
     * IMDb rating lookup, via the plugin's own server-side endpoint (which
     * proxies OMDb using the API key set on the plugin's config page - see
     * Api/NetflixSkinController.cs). Kept as its own small client so the
     * same in-flight/settled request is reused instead of re-fetched every
     * time buildMetaRow() runs for the same title in one page session.
     */
    var imdbRatingCache = {};
    function fetchImdbRating(imdbId, title, year) {
        if (!imdbId && !title) {
            return Promise.resolve(null);
        }

        /* Use a stable cache key. IMDb id is preferred; titles without an
           IMDb ProviderId use title/year as the fallback key. */
        var cacheKey = imdbId
            ? ("id:" + imdbId)
            : ("title:" + String(title || "").toLowerCase() + ":" + String(year || ""));

        if (imdbRatingCache.hasOwnProperty(cacheKey)) {
            return imdbRatingCache[cacheKey];
        }

        var url;
        try {
            var params = {};
            if (imdbId) {
                params.imdbId = imdbId;
            } else {
                params.title = title;
                if (year) {
                    params.year = year;
                }
            }

            if (window.ApiClient && typeof window.ApiClient.getUrl === "function") {
                url = window.ApiClient.getUrl("NetflixSkin/ImdbRating", params);
            } else {
                url = "/NetflixSkin/ImdbRating?" +
                    (imdbId
                        ? "imdbId=" + encodeURIComponent(imdbId)
                        : "title=" + encodeURIComponent(title) +
                          (year ? "&year=" + encodeURIComponent(year) : ""));
            }
        } catch (err) {
            url = "/NetflixSkin/ImdbRating?" +
                (imdbId
                    ? "imdbId=" + encodeURIComponent(imdbId)
                    : "title=" + encodeURIComponent(title) +
                      (year ? "&year=" + encodeURIComponent(year) : ""));
        }

        var promise = fetch(url).then(function (res) {
            if (!res.ok) {
                return null;
            }
            return res.json();
        }).then(function (data) {
            return (data && data.imdbRating) ? data.imdbRating : null;
        }).catch(function () {
            return null;
        });

        imdbRatingCache[cacheKey] = promise;
        return promise;
    }

    /**
     * Age/content rating lookup, via the plugin's own server-side endpoint
     * (which proxies TMDB using the API key set on the plugin's config page
     * - see Api/NetflixSkinController.cs). Jellyfin's own OfficialRating
     * field only ever holds ONE certification - whichever country the
     * server's metadata settings are configured for - so this asks TMDB for
     * every country's certification and prefers US, falling back to India
     * (IN, prefixed "IN-") only when a title has no US certification.
     * Same in-flight/settled request caching as fetchImdbRating() above.
     */
    var ageRatingCache = {};
    function fetchAgeRating(tmdbId, type) {
        if (!tmdbId || !type) {
            return Promise.resolve(null);
        }

        var cacheKey = type + ":" + tmdbId;
        if (ageRatingCache.hasOwnProperty(cacheKey)) {
            return ageRatingCache[cacheKey];
        }

        var url;
        try {
            var params = { tmdbId: tmdbId, type: type };
            if (window.ApiClient && typeof window.ApiClient.getUrl === "function") {
                url = window.ApiClient.getUrl("NetflixSkin/AgeRating", params);
            } else {
                url = "/NetflixSkin/AgeRating?tmdbId=" + encodeURIComponent(tmdbId) + "&type=" + encodeURIComponent(type);
            }
        } catch (err) {
            url = "/NetflixSkin/AgeRating?tmdbId=" + encodeURIComponent(tmdbId) + "&type=" + encodeURIComponent(type);
        }

        var promise = fetch(url).then(function (res) {
            if (!res.ok) {
                return null;
            }
            return res.json();
        }).then(function (data) {
            return (data && data.rating) ? data.rating : null;
        }).catch(function () {
            return null;
        });

        ageRatingCache[cacheKey] = promise;
        return promise;
    }

    /**
     * Unbordered rating chip: brand icon, then the score (icon always
     * comes before the number, per the reference layout) - used for
     * TMDB / Rotten Tomatoes ratings so they read differently from the
     * bordered age-rating and quality badges.
     */
    function makeRatingBadge(iconSvg, text) {
        var el = document.createElement("span");
        el.className = "ns-badge ns-badge-rating";
        var iconSpan = document.createElement("span");
        iconSpan.className = "ns-badge-rating-icon";
        iconSpan.innerHTML = iconSvg;
        el.appendChild(iconSpan);
        var textSpan = document.createElement("span");
        textSpan.textContent = text;
        el.appendChild(textSpan);
        return el;
    }

    /**
     * US MPAA-style movie rating codes (G/PG/PG-13/R/NC-17/NR) plus the
     * TV Parental Guidelines codes Jellyfin also uses for shows. If
     * OfficialRating already comes through as one of these (normal when
     * the server's metadata country is set to US), it's used as-is.
     * A small alias table covers the alternate spellings some metadata
     * providers store for the same US ratings; anything unrecognized
     * still falls through unchanged rather than being dropped.
     */
    var US_RATING_CODES = ["G", "PG", "PG-13", "R", "NC-17", "NR", "UR",
        "TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
    var US_RATING_ALIASES = {
        "NOT RATED": "NR", "UNRATED": "NR",
        "US:G": "G", "US:PG": "PG", "US:PG-13": "PG-13", "US:R": "R", "US:NC-17": "NC-17", "US:NR": "NR",
        "USA:G": "G", "USA:PG": "PG", "USA:PG-13": "PG-13", "USA:R": "R", "USA:NC-17": "NC-17"
    };
    function normalizeAgeRating(raw) {
        if (!raw) {
            return null;
        }
        var val = ("" + raw).trim();
        var upper = val.toUpperCase();
        for (var i = 0; i < US_RATING_CODES.length; i++) {
            if (upper === US_RATING_CODES[i]) {
                return US_RATING_CODES[i];
            }
        }
        if (US_RATING_ALIASES[upper]) {
            return US_RATING_ALIASES[upper];
        }
        return val;
    }

    /**
     * Resolution/HDR/audio-channel/closed-caption badges - stock
     * Jellyfin does not render these on the detail page itself (only
     * inside the separate "Media info" dialog), so they're derived
     * here from the item's own MediaStreams, same source that dialog
     * itself reads from. Guarded field-by-field so a movie missing one
     * piece of stream metadata just skips that one badge instead of
     * losing the whole meta row.
     */
    function buildQualityBadges(item) {
        var badges = [];
        try {
            var streams = (item.MediaSources && item.MediaSources[0] && item.MediaSources[0].MediaStreams) || item.MediaStreams || [];
            var videoStream = null;
            var audioStream = null;
            var hasSubtitle = false;

            for (var i = 0; i < streams.length; i++) {
                var s = streams[i];
                if (s.Type === "Video" && !videoStream) {
                    videoStream = s;
                } else if (s.Type === "Audio" && !audioStream) {
                    audioStream = s;
                } else if (s.Type === "Subtitle") {
                    hasSubtitle = true;
                }
            }

            if (videoStream) {
                var width = videoStream.Width || 0;
                if (width >= 3800) {
                    badges.push("4K");
                } else if (width >= 1900) {
                    badges.push("1080p");
                } else if (width >= 1200) {
                    badges.push("720p");
                } else if (width > 0) {
                    badges.push("SD");
                }

                var range = ((videoStream.VideoRangeType || videoStream.VideoRange || "") + "").toUpperCase();
                if (range.indexOf("DOVI") !== -1 || range.indexOf("DOLBY") !== -1) {
                    badges.push("Dolby Vision");
                } else if (range.indexOf("HDR") !== -1 || range.indexOf("HLG") !== -1) {
                    badges.push("HDR");
                }
            }

            if (audioStream) {
                if (audioStream.ChannelLayout) {
                    var layout = audioStream.ChannelLayout;
                    if (layout.indexOf("(") !== -1) {
                        layout = layout.substring(0, layout.indexOf("("));
                    }
                    badges.push(layout);
                } else if (audioStream.Channels === 8) {
                    badges.push("7.1");
                } else if (audioStream.Channels === 6) {
                    badges.push("5.1");
                } else if (audioStream.Channels === 2) {
                    badges.push("2.0");
                }
            }

            if (hasSubtitle) {
                badges.push("CC");
            }
        } catch (err) {
            /* leave whatever badges were already collected */
        }

        return badges;
    }

    /**
     * Builds the meta row, in this order:
     *   Genre -> Year -> Runtime (one text group)
     *   -> age rating (bordered badge, US MPAA/TV Parental Guidelines code)
     *   -> IMDb rating (unbordered badge, logo + score out of 10 - fetched
     *      async from the plugin's own OMDb-backed endpoint using the
     *      item's IMDb id; the slot is reserved synchronously so it lands
     *      in the right position once the lookup resolves, and silently
     *      collapses away if no OMDb key is configured or the lookup fails)
     *   -> TMDB rating (unbordered badge, brand logo + score - this is
     *      what Jellyfin's own CommunityRating field normally is)
     *   -> RT Tomatometer (unbordered badge, brand icon + %  - this is
     *      what Jellyfin's own CriticRating field normally is)
     *   -> RT Popcornmeter (not wired up - no stock field for it either)
     *   -> quality/audio/CC badges (bordered, detail screen only)
     * Every piece is independently optional - an item missing e.g. a
     * critic rating just doesn't get that one chip, nothing shifts/breaks.
     *
     * @param {object} item
     * @param {{includeQualityBadges: boolean}} [opts] includeQualityBadges
     *   defaults to true (detail hero); pass false for the home hero so
     *   codec/audio badges only ever appear on the detail screen.
     */
    function buildMetaRow(item, opts) {
        var includeQualityBadges = !opts || opts.includeQualityBadges !== false;
        var imdbRating = opts && Object.prototype.hasOwnProperty.call(opts, "imdbRating")
            ? opts.imdbRating
            : null;

        var row = document.createElement("div");
        row.className = "ns-meta-row";

        var textParts = [];
        if (item.Genres && item.Genres.length) { textParts.push(item.Genres[0]); }
        if (item.ProductionYear) { textParts.push(String(item.ProductionYear)); }
        var runtimeText = formatRuntime(item.RunTimeTicks);
        if (runtimeText) { textParts.push(runtimeText); }
        if (textParts.length) {
            var textEl = document.createElement("span");
            textEl.className = "ns-meta-text";
            textEl.textContent = textParts.join(" \u00b7 ");
            row.appendChild(textEl);
        }

        /* ageRating (resolved via TMDB, US-first with an India fallback -
           see resolveItemAgeRating()) takes priority when available; falls
           back to Jellyfin's own single-country OfficialRating otherwise -
           this is what a title looked like before this lookup existed, and
           still what's used for the OmdbApiKey/TmdbApiKey-not-configured
           case. Already a final display string either way, so it's used
           as-is rather than run back through normalizeAgeRating(). */
        var ageRatingOverride = opts && Object.prototype.hasOwnProperty.call(opts, "ageRating") ? opts.ageRating : null;
        var ageRating = ageRatingOverride || normalizeAgeRating(item.OfficialRating);
        if (ageRating) { row.appendChild(makeBadge(ageRating)); }

        /* IMDb is resolved BEFORE this row is built. This prevents the
           badge from appearing several hundred milliseconds after the
           rest of the metadata. */
        if (imdbRating) {
            row.appendChild(makeRatingBadge(IMDB_ICON_HTML, imdbRating));
        }

        if (typeof item.CommunityRating === "number") {
            row.appendChild(makeRatingBadge(TMDB_ICON_HTML, item.CommunityRating.toFixed(1)));
        }
        if (typeof item.CriticRating === "number") {
            row.appendChild(makeRatingBadge(RT_ICON_SVG, Math.round(item.CriticRating) + "%"));
        }

        if (includeQualityBadges) {
            var qualityBadges = buildQualityBadges(item);
            for (var i = 0; i < qualityBadges.length; i++) {
                row.appendChild(makeBadge(qualityBadges[i]));
            }
        }
        return row;
    }

    /* Resolve IMDb before rendering a metadata row. The result is cached
       by fetchImdbRating(), including in-flight requests, so Home and
       Details can share the same request. */
    function resolveItemImdbRating(item) {
        if (!item) {
            return Promise.resolve(null);
        }

        var imdbId = item.ProviderIds &&
            (item.ProviderIds.Imdb || item.ProviderIds.IMDB || item.ProviderIds.imdb);

        /* Some Jellyfin items have TMDB/TVDB/etc. ProviderIds but no IMDb
           ProviderId. In that case OMDb can still resolve the title by name
           and year. This is why only some media were missing the IMDb badge. */
        var title = item.Name || "";
        var year = item.ProductionYear || "";

        return fetchImdbRating(imdbId, title, year);
    }

    /* Resolve the US-first/India-fallback age rating before rendering a
       metadata row - same reasoning and caching as resolveItemImdbRating()
       above. Only Movie/Series items are looked up (an Episode's own
       ProviderIds.Tmdb, when present, is an episode id on a different TMDB
       endpoint than release_dates/content_ratings, not the item this row
       is being built for) - anything else resolves to null immediately,
       so buildMetaRow() just falls back to item.OfficialRating for it. */
    function resolveItemAgeRating(item) {
        if (!item) {
            return Promise.resolve(null);
        }

        var tmdbId = item.ProviderIds &&
            (item.ProviderIds.Tmdb || item.ProviderIds.TMDB || item.ProviderIds.tmdb);
        if (!tmdbId) {
            return Promise.resolve(null);
        }

        var type = item.Type === "Movie" ? "movie" : (item.Type === "Series" ? "tv" : null);
        if (!type) {
            return Promise.resolve(null);
        }

        return fetchAgeRating(tmdbId, type);
    }

    /**
     * Moves the real, already-functional stock ".mainDetailButtons"
     * (Play/watched/favourite/trailer/more) into the hero. Returns true
     * once it has successfully done so (idempotent after that - checked
     * via a data attribute so this is cheap to call on every observer
     * pass); returns false if the element doesn't exist in the DOM YET,
     * so the caller knows to try again on a later pass instead of
     * treating "not found this time" as "never going to exist".
     */
    function attachActionButtons(page, heroContent, item) {
        if (!heroContent) {
            return false;
        }
        if (heroContent.dataset.nsButtonsAttached === "1") {
            return true;
        }
        var buttonsEl = page.querySelector(DETAIL_SEL.mainButtons);
        if (!buttonsEl) {
            return false;
        }
        
        if (item && item.Type === "Person") {
            var btnPlay = buttonsEl.querySelector(".btnPlay");
            if (btnPlay) {
                btnPlay.remove();
            }
        }
        
        heroContent.appendChild(buttonsEl);
        heroContent.dataset.nsButtonsAttached = "1";
        return true;
    }

    /**
     * ------------------------------------------------------------------
     * Play button dynamic label
     * ------------------------------------------------------------------
     * attachActionButtons (above) moves the real, fully-functional stock
     * .btnPlay/.btnReplay element into the hero and never touches it
     * again - reimplementing its click behaviour would risk silently-wrong
     * playback (see that function's comment). This block only ever
     * overwrites that untouched button's LABEL, on top of stock's own
     * click handling, never replacing it.
     *
     * Label by state:
     *   - Movie/Episode, never started         -> "Play" / "Play S1E1"
     *   - Movie/Episode, has a resume position -> "Resume 12:34"
     *   - Series, nothing watched yet          -> "Play S1E1"
     *   - Series, mid-episode (has resume pos) -> "Resume S2E4 12:34"
     *   - Series, last watched episode finished,
     *     another one queued up               -> "Up Next S2E5"
     *   - Series, everything watched           -> "Play S1E1" (restart)
     *
     * All three Series cases are resolved from ONE call to Jellyfin's own
     * NextUp endpoint (ApiClient.getNextUpEpisodes) - the same lookup
     * stock's Home screen "Next Up" row already uses. If a series hasn't
     * been started, NextUp returns S1E1; if the last episode played was
     * left mid-way (not marked Played), NextUp returns that SAME episode
     * with its resume position instead of advancing past it - so the
     * Resume/Up-Next split falls out of that one response, no separate
     * "have they started this show" lookup needed.
     */
    var lastPlayLabelVisit = { page: null, itemId: null };

    /**
     * PlaybackPositionTicks (100-nanosecond ticks) -> "12:34" / "1:02:34".
     * Deliberately separate from formatRuntime (above), which only goes
     * down to whole minutes - a resume position needs seconds too, or
     * "just started" and "almost done with this minute" would show the
     * same label.
     */
    function formatResumeTimestamp(ticks) {
        if (!ticks || ticks <= 0) {
            return null;
        }
        var totalSeconds = Math.floor(ticks / 10000000);
        var h = Math.floor(totalSeconds / 3600);
        var m = Math.floor((totalSeconds % 3600) / 60);
        var s = totalSeconds % 60;
        var mm = (h > 0 && m < 10 ? "0" : "") + m;
        var ss = (s < 10 ? "0" : "") + s;
        return h > 0 ? (h + ":" + mm + ":" + ss) : (m + ":" + ss);
    }

    /**
     * "S{season}E{episode}", or null if either number is missing (e.g. a
     * special with no ParentIndexNumber) - callers fall back to the
     * plain "Play"/"Resume" label in that case rather than printing a
     * broken "SE" fragment.
     */
    function episodeLabel(seasonNum, episodeNum) {
        if (seasonNum === null || seasonNum === undefined || episodeNum === null || episodeNum === undefined) {
            return null;
        }
        return "S" + seasonNum + "E" + episodeNum;
    }

    /**
     * Wraps the stock icon span and .button-text span in one inner row
     * element (.ns-btnplay-toprow) the first time a button's label is
     * set. Needed because .btnPlay is now a column (icon+label row on
     * top, "Ends at" line underneath) - without this wrapper the icon,
     * label and end-time span would just be three stacked rows instead
     * of the icon sitting beside the label. Idempotent via a dataset
     * flag; does nothing (and throws nothing) if the button doesn't
     * have the icon/text children it expects.
     */
    function ensureButtonLayout(btn) {
        if (!btn || btn.dataset.nsLayoutWrapped === "1") {
            return;
        }
        try {
            var icon = btn.querySelector(".material-icons");
            var textEl = btn.querySelector(".button-text");
            if (!icon && !textEl) {
                return;
            }
            var topRow = document.createElement("span");
            topRow.className = "ns-btnplay-toprow";
            // Keep the native Jellyfin icon and dynamic label together in
            // one horizontal row. The end-time is intentionally kept as a
            // separate sibling below this row.
            if (icon) {
                topRow.appendChild(icon);
            }
            if (textEl) {
                topRow.appendChild(textEl);
            }
            btn.insertBefore(topRow, btn.firstChild);
            btn.dataset.nsLayoutWrapped = "1";
        } catch (err) {
            /* leave button as stock rendered it */
        }
    }

    /**
     * RunTimeTicks-style remaining-duration (100-nanosecond ticks) ->
     * "Ends at 9:45 PM", or null if there's nothing left to compute
     * (no runtime known, or already finished). Wall-clock time, not
     * device player state - "if you start/resume right now, here's
     * about when you'd finish".
     */
    function formatEndsAt(remainingTicks) {
        if (!remainingTicks || remainingTicks <= 0) {
            return null;
        }
        try {
            var endDate = new Date(Date.now() + (remainingTicks / 10000));
            return "Ends at " + endDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
        } catch (err) {
            return null;
        }
    }

    /**
     * Writes (or clears, if text is falsy) the muted "Ends at" line
     * under the play button's label. Separate span from .button-text
     * so the two can be styled independently (bold label, thin
     * end-time) - see ensureButtonLayout above for why the label and
     * icon are wrapped together but this one is a sibling of that
     * wrapper, not inside it.
     */
    function setPlayButtonEndTime(page, text) {
        try {
            var btn = page.querySelector(DETAIL_SEL.mainButtons + " .btnPlay") ||
                page.querySelector(DETAIL_SEL.mainButtons + " .btnReplay");
            if (!btn) {
                return;
            }
            var endEl = btn.querySelector(".ns-btnplay-endtime");
            if (!text) {
                if (endEl) {
                    endEl.remove();
                }
                return;
            }
            if (!endEl) {
                endEl = document.createElement("span");
                endEl.className = "ns-btnplay-endtime";
                btn.appendChild(endEl);
            }
            endEl.textContent = text;
        } catch (err) {
            /* leave button without an end-time line */
        }
    }

    /**
     * Writes label text onto the real stock Play/Replay button without
     * touching anything else about it. Prefers the conventional
     * ".button-text" span stock's own emby-button markup uses; falls
     * back to locating a bare text node (older/newer markup), and only
     * as a last resort appends a brand-new span - never overwrites the
     * button's innerHTML wholesale, which would also delete its icon.
     */
    function setPlayButtonLabel(page, label) {
        if (!label) {
            return;
        }
        try {
            var btn = page.querySelector(DETAIL_SEL.mainButtons + " .btnPlay") ||
                page.querySelector(DETAIL_SEL.mainButtons + " .btnReplay");
            if (!btn) {
                return;
            }
            /* Find/create the label BEFORE wrapping the icon + label.
               On some Jellyfin builds the stock button has no .button-text
               span yet, so wrapping first would capture only the icon and
               the newly-created label would remain underneath it. */
            var textEl = btn.querySelector(".button-text");
            if (!textEl) {
                for (var i = 0; i < btn.childNodes.length; i++) {
                    var node = btn.childNodes[i];
                    if (node.nodeType === 3 && node.textContent && node.textContent.trim()) {
                        textEl = node;
                        break;
                    }
                }
            }
            if (!textEl) {
                textEl = document.createElement("span");
                textEl.className = "button-text";
                btn.appendChild(textEl);
            }
            textEl.textContent = label;

            /* Now both icon and label exist, so they are guaranteed to be
               placed in the same horizontal row. */
            ensureButtonLayout(btn);
        } catch (err) {
            /* leave stock's own "Play"/"Resume" text in place */
        }
    }

    /**
     * Fresh (uncached) item lookup, used only for the play label. Movie/
     * Episode UserData - unlike the logo/overview/etc. buildDetailHero
     * works from - is exactly the kind of thing that changes every time
     * the user actually watches something, so this deliberately bypasses
     * fetchItem()'s shared promise cache (built for the static hero text)
     * rather than risking a stale "Play" surviving a visit where the user
     * just watched part of it.
     */
    function fetchFreshItem(itemId, userId) {
        try {
            if (window.ApiClient && typeof window.ApiClient.getItem === "function") {
                return window.ApiClient.getItem(userId, itemId).catch(function () {
                    return null;
                });
            }
        } catch (err) {
            /* fall through */
        }
        return Promise.resolve(null);
    }

    function labelForMovieOrEpisode(item) {
        var ticks = item.UserData && item.UserData.PlaybackPositionTicks;
        var ts = formatResumeTimestamp(ticks);
        var ep = item.Type === "Episode" ? episodeLabel(item.ParentIndexNumber, item.IndexNumber) : null;
        if (ts) {
            return ep ? ("Resume " + ep + " " + ts) : ("Resume " + ts);
        }
        return ep ? ("Play " + ep) : "Play";
    }

    /**
     * Resolves and applies all three Series label cases from one NextUp
     * lookup - see the block comment above for why a single response is
     * enough. "started" (Play vs. Up Next, when there's no resume
     * position) is inferred from whether NextUp's own episode looks
     * untouched (no PlayCount/LastPlayedDate) AND is literally S1E1 -
     * a brand-new series' first episode fails both watched-signals AND
     * is S1E1, so it alone reads as "Play"; anything else with no resume
     * position reads as "Up Next".
     */
    function applySeriesNextUpLabel(page, seriesId, userId) {
        if (!window.ApiClient || typeof window.ApiClient.getNextUpEpisodes !== "function") {
            return;
        }
        window.ApiClient.getNextUpEpisodes({
            SeriesId: seriesId,
            UserId: userId,
            Limit: 1
        }).then(function (result) {
            var ep = result && result.Items && result.Items[0];
            if (!ep) {
                // Nothing left queued up - every episode has been watched.
                // Offer a restart rather than leaving stock's default text.
                setPlayButtonLabel(page, "Play S1E1");
                setPlayButtonEndTime(page, null);
                return;
            }
            var epLabel = episodeLabel(ep.ParentIndexNumber, ep.IndexNumber);
            var resumeTicks = ep.UserData && ep.UserData.PlaybackPositionTicks;
            var ts = formatResumeTimestamp(resumeTicks);
            var remaining = (ep.RunTimeTicks || 0) - (resumeTicks || 0);
            if (ts) {
                setPlayButtonLabel(page, epLabel ? ("Resume " + epLabel + " " + ts) : ("Resume " + ts));
                setPlayButtonEndTime(page, formatEndsAt(remaining));
                return;
            }
            if (!epLabel) {
                setPlayButtonEndTime(page, null);
                return;
            }
            var alreadyStarted = !!(ep.UserData && (ep.UserData.PlayCount || ep.UserData.LastPlayedDate)) ||
                !(ep.IndexNumber === 1 && ep.ParentIndexNumber === 1);
            setPlayButtonLabel(page, (alreadyStarted ? "Up Next " : "Play ") + epLabel);
            setPlayButtonEndTime(page, formatEndsAt(remaining));
        }).catch(function () {
            /* leave stock's own text in place */
        });
    }

    /**
     * Entry point, called from initDetailPage on every pass (cheap - see
     * below) like syncDetailBackdrop. Only does real work (a fetch) once
     * per genuine "visit": a new item id, or the same item id showing up
     * on a different page element (the user left and came back and
     * jellyfin-web built a fresh #itemDetailPage for it) - tracked in
     * lastPlayLabelVisit, set BEFORE the fetch starts so overlapping
     * MutationObserver passes during that async gap don't fire a second
     * one. Also retried like attachActionButtons if the button itself
     * isn't in the DOM yet on this pass.
     */
    function updatePlayButtonLabel(page, item) {
        if (!item) {
            return;
        }
        var btn = page.querySelector(DETAIL_SEL.mainButtons + " .btnPlay") ||
            page.querySelector(DETAIL_SEL.mainButtons + " .btnReplay");
        if (!btn) {
            return;
        }
        if (lastPlayLabelVisit.page === page && lastPlayLabelVisit.itemId === item.Id) {
            return;
        }
        lastPlayLabelVisit = { page: page, itemId: item.Id };

        try {
            var userId = window.ApiClient && window.ApiClient.getCurrentUserId
                ? window.ApiClient.getCurrentUserId()
                : null;
            if (item.Type === "Series") {
                applySeriesNextUpLabel(page, item.Id, userId);
            } else {
                fetchFreshItem(item.Id, userId).then(function (freshItem) {
                    var it = freshItem || item;
                    setPlayButtonLabel(page, labelForMovieOrEpisode(it));
                    var remaining = (it.RunTimeTicks || 0) -
                        ((it.UserData && it.UserData.PlaybackPositionTicks) || 0);
                    setPlayButtonEndTime(page, formatEndsAt(remaining));
                });
            }
        } catch (err) {
            /* leave stock's own "Play"/"Resume" text in place */
        }
    }

    /**
     * The backdrop lives as ONE persistent element appended directly to
     * document.body - not inside the hero, not inside #itemDetailPage
     * at all - so it's never a descendant of whatever ancestor
     * jellyfin-web applies its page-slide-transition transform to.
     * That's what actually guarantees it stays position:fixed to the
     * real viewport and keeps covering the full screen: a transform on
     * some ancestor of #itemDetailPage can hijack position:fixed for
     * anything living inside that ancestor, but has no effect on a
     * sibling element that was never inside it to begin with.
     * Created once and reused across every detail-page visit; only its
     * background-image and visibility change per item/page.
     */
    var fixedBackdropEl = null;

    /* The item id and image URL the shared backdrop is CURRENTLY pointed
       at, and whether that URL has actually been applied yet. All backdrop
       state lives in this one object with a single owner - syncDetailBackdrop
       below - instead of being set from multiple places (buildDetailHero,
       various "re-assert" call sites) that each raced to show/hide it
       independently. That fan-out was the actual bug behind two different
       symptoms: a transient layout pass hiding the backdrop with nothing
       left to restore it, and stock's own fixed-position #itemBackdrop
       banner mounting on top of ours after we'd already shown it (see
       neutralizeStockBanner below for that one). */
    var backdropState = { itemId: null, url: null, ready: false };

    function ensureFixedBackdrop() {
        if (!fixedBackdropEl) {
            fixedBackdropEl = document.createElement("div");
            fixedBackdropEl.id = "ns-fixed-backdrop";
        }
        /* Re-append if something detached it. jellyfin-web tears down and
           rebuilds page containers on navigation, and a body-level element
           can get swept up in that; a detached node keeps its classes and
           inline styles, so without this check it would look "set up
           correctly" in every respect except actually being on screen. */
        if (!fixedBackdropEl.parentNode) {
            document.body.appendChild(fixedBackdropEl);
        }
        return fixedBackdropEl;
    }

    /**
     * Stock's own optional "details banner" (#itemBackdrop, plus
     * .detailImageContainer) renders as a position:fixed, full-viewport
     * element - the CSS file hides both with display:none, but that only
     * works for whatever DOM location the CSS selector actually matches.
     * If a running jellyfin-web version appends either as a body-level
     * sibling rather than a descendant of #itemDetailPage (plausible: it's
     * the same reason our own backdrop lives outside #itemDetailPage - see
     * ensureFixedBackdrop above), the CSS rule silently never fires. This
     * is the JS-side backstop: find either element wherever it actually
     * lives in the document and force it off in a way CSS specificity
     * can't lose - an inline style with !important always wins over any
     * stylesheet rule regardless of selector. Idempotent and cheap
     * (two lookups, a style check) so it's safe to call on every pass.
     */
    /**
     * Cheap, cheap-but-fallible first pass: if stock's "details banner" is
     * still using the class/id names it has historically used, this hides
     * it before it ever gets a chance to paint - an inline style with
     * !important always wins over any stylesheet rule regardless of
     * selector, so it's a strict improvement over the CSS rule alone even
     * when it does match. But it is NOT the fix for the "Details Banner"
     * setting - that feature turned out to render something these
     * selectors never matched, so nothing here can be assumed to have
     * caught it. clearOversizedOpaqueBackgrounds (below) is the actual,
     * name-agnostic fix; this function is left in purely as a fast early
     * exit for the common case.
     */
    function neutralizeStockBanner() {
        var selectors = ["#itemBackdrop", ".detailImageContainer"];
        for (var i = 0; i < selectors.length; i++) {
            var els = document.querySelectorAll(selectors[i]);
            for (var j = 0; j < els.length; j++) {
                var el = els[j];
                if (el.style.display !== "none") {
                    el.style.setProperty("display", "none", "important");
                }
            }
        }
    }

    /**
     * True if `color` (a computed backgroundColor string, e.g.
     * "rgba(0, 0, 0, 0.9)" or "rgb(20, 20, 20)") paints something visible.
     * A plain "rgb(...)" has no alpha channel at all, which means fully
     * opaque - only an explicit rgba(...) with a near-zero alpha, or the
     * literal "transparent" keyword some browsers still return, counts as
     * see-through.
     */
    function isOpaqueColor(color) {
        if (!color || color === "transparent") {
            return false;
        }
        var match = color.match(/rgba?\(([^)]+)\)/i);
        if (!match) {
            return false;
        }
        var parts = match[1].split(",");
        var alpha = parts.length > 3 ? parseFloat(parts[3]) : 1;
        return alpha > 0.05;
    }

    /**
     * THE actual, general fix for "banner enabled -> backdrop goes black".
     *
     * neutralizeStockBanner (above) only helps if the covering element is
     * actually named #itemBackdrop/.detailImageContainer and actually
     * reachable by that selector - with the "Details Banner" setting on,
     * neither held: whatever stock renders for that feature stayed opaque
     * regardless. Rather than go on guessing selectors one jellyfin-web
     * release at a time, this stops caring what the element is called
     * entirely and goes by what it looks like instead: anything inside the
     * detail page that is both (a) big enough to plausibly be a full-width
     * banner/backdrop (not a poster thumbnail, avatar, or button) and (b)
     * has an opaque background-color or a background-image gets forced
     * transparent, unconditionally. That is a correct thing to do on this
     * page independent of any of this: main.js's own hero backdrop is the
     * only background image this screen is ever supposed to show, so nothing
     * else in #itemDetailPage legitimately needs an opaque background of
     * its own - there is no real feature this sweep could break here, only
     * a redundant stock element it's meant to remove.
     *
     * Size thresholds are fractions of the current viewport, not fixed
     * pixels, so this scales correctly across window sizes: 60% of width
     * and 22% of height comfortably excludes cast/crew avatars, poster
     * thumbnails, and the action-button row (capped at 900px wide by
     * .ns-hero-content), while catching any genuinely banner-sized block.
     */
    function clearOversizedOpaqueBackgrounds(root) {
        if (!root) {
            return;
        }

        var vw = window.innerWidth || document.documentElement.clientWidth || 0;
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;
        if (!vw || !vh) {
            return;
        }
        var minWidth = vw * 0.6;
        var minHeight = vh * 0.22;

        var els;
        try {
            els = root.querySelectorAll("*");
        } catch (err) {
            return;
        }

        for (var i = 0; i < els.length; i++) {
            var el = els[i];

            // Never touch our own backdrop or the hero we just built.
            if (el.id === "ns-fixed-backdrop") {
                continue;
            }
            if (el.closest && el.closest(".ns-detail-hero")) {
                continue;
            }

            var rect;
            try {
                rect = el.getBoundingClientRect();
            } catch (err) {
                continue;
            }
            if (rect.width < minWidth || rect.height < minHeight) {
                continue;
            }

            try {
                var cs = window.getComputedStyle(el);
                var hasOpaqueColor = isOpaqueColor(cs.backgroundColor);
                var hasImage = cs.backgroundImage && cs.backgroundImage !== "none";
                if (!hasOpaqueColor && !hasImage) {
                    continue;
                }
                if (hasOpaqueColor) {
                    el.style.setProperty("background-color", "transparent", "important");
                }
                if (hasImage) {
                    el.style.setProperty("background-image", "none", "important");
                }
            } catch (err) {
                /* skip this element, keep sweeping the rest */
            }
        }
    }

    /* Delays (ms) for the sweeps below, run once per item. A single
       synchronous pass (delay 0) isn't enough on its own: the banner
       feature can mount its element a little after the rest of the page,
       so this keeps checking for a few seconds and then stops - not an
       indefinite per-mutation cost, just enough passes to catch a late
       arrival. */
    var OVERSIZE_SWEEP_DELAYS_MS = [0, 150, 400, 900, 1800, 3000];

    function scheduleOversizeSweeps(itemId) {
        OVERSIZE_SWEEP_DELAYS_MS.forEach(function (delay) {
            window.setTimeout(function () {
                // Bail if the user has since moved to a different item or
                // away from the detail page entirely - a stale timer firing
                // late should never clear backgrounds on whatever screen
                // they're actually looking at now.
                if (getDetailItemIdFromHash() !== itemId) {
                    return;
                }
                var page = getVisibleDetailPage();
                if (!page) {
                    return;
                }
                clearOversizedOpaqueBackgrounds(page);
            }, delay);
        });
    }

    /**
     * Single owner of #ns-fixed-backdrop's image/visibility. Called on
     * every MutationObserver/hashchange pass from initDetailPage, and
     * decides everything purely from the current hash + fetch state -
     * never from transient layout signals (computed display, "is a page
     * visible right now") the way the old code did, since jellyfin-web's
     * own page-transition frames make those flicker independently of
     * whether the user has actually navigated away.
     */
    function syncDetailBackdrop() {
        neutralizeStockBanner();

        var itemId = getDetailItemIdFromHash();

        // Left the detail route entirely - hide and reset.
        if (!itemId) {
            if (backdropState.itemId !== null) {
                fixedBackdropEl && fixedBackdropEl.classList.remove("ns-visible");
                backdropState = { itemId: null, url: null, ready: false };
            }
            return;
        }

        // Navigated to a different item - drop the old image immediately
        // (no stale frame of the previous item's backdrop), kick off the
        // oversized-opaque-background sweep for this item, and fetch the
        // new one. ready stays false until the URL is actually known, so
        // nothing shows until there's a real image to show.
        if (itemId !== backdropState.itemId) {
            backdropState = { itemId: itemId, url: null, ready: false };
            var el = ensureFixedBackdrop();
            el.classList.remove("ns-visible");
            scheduleOversizeSweeps(itemId);

            fetchItem(itemId).then(function (item) {
                // A later navigation may have superseded this fetch by the
                // time it resolves - only apply it if we're still on it.
                if (backdropState.itemId !== itemId) {
                    return;
                }
                backdropState.url = item ? heroBackdropImageUrl(item) : null;
                backdropState.ready = true;
                syncDetailBackdrop();
            });
            return;
        }

        // Same item as last pass. Nothing to fetch; just make sure the
        // image we already resolved is actually applied and visible -
        // safe to repeat every pass since it's a no-op once already set.
        if (backdropState.ready && backdropState.url) {
            var target = ensureFixedBackdrop();
            var urlProp = "url(" + backdropState.url + ")";
            if (target.style.backgroundImage !== urlProp) {
                target.style.backgroundImage = urlProp;
            }
            target.classList.add("ns-visible");
        }
    }

    /**
     * Builds (once per page instance) the ".ns-detail-hero" block: an
     * empty top spacer, then logo/meta row/tagline/synopsis, all built
     * fresh from `item`. The backdrop image itself is NOT part of this
     * element - see ensureFixedBackdrop() above - this just points the
     * shared, persistent, body-level backdrop at this item's landscape
     * image and makes it visible. Guarded by a data attribute on the
     * page root so a MutationObserver churn mid-scroll never rebuilds/
     * duplicates the hero. Does NOT attach the button row itself - see
     * attachActionButtons/initDetailPage for why that part is retried
     * separately.
     */
    /**
     * Same fallback logic as landscapeImageUrl() (real Backdrop image,
     * falling back to a Thumb) but at a size actually suitable for a
     * full-viewport hero background - landscapeImageUrl() itself stays
     * capped at 900px wide, which is right for the small home-rail card
     * it was built for but too soft stretched across a whole screen.
     */
    function heroBackdropImageUrl(item) {
        try {
            if (!window.ApiClient || !item) {
                return null;
            }
            if (item.BackdropImageTags && item.BackdropImageTags.length) {
                return window.ApiClient.getScaledImageUrl(item.Id, {
                    type: "Backdrop",
                    tag: item.BackdropImageTags[0],
                    maxWidth: 1920
                });
            }
            if (item.ImageTags && item.ImageTags.Thumb) {
                return window.ApiClient.getScaledImageUrl(item.Id, {
                    type: "Thumb",
                    tag: item.ImageTags.Thumb,
                    maxWidth: 1920
                });
            }
            /* Episodes/seasons/etc. commonly have no Backdrop or Thumb of
               their own - fall back to the parent's (series') backdrop,
               same as stock Jellyfin does, instead of leaving the hero
               with no image at all. */
            if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags.length) {
                return window.ApiClient.getScaledImageUrl(item.ParentBackdropItemId, {
                    type: "Backdrop",
                    tag: item.ParentBackdropImageTags[0],
                    maxWidth: 1920
                });
            }
        } catch (err) {
            /* no landscape image available */
        }
        return null;
    }

    function getPeopleNames(item, type) {
        var names = [];
        if (!item || !item.People) {
            return names;
        }
        for (var i = 0; i < item.People.length; i++) {
            var person = item.People[i];
            if (person && person.Type === type && person.Name) {
                if (names.indexOf(person.Name) === -1) {
                    names.push(person.Name);
                }
            }
        }
        return names;
    }

    function getNamedValues(items) {
        var values = [];
        if (!items) {
            return values;
        }
        for (var i = 0; i < items.length; i++) {
            var value = items[i];
            var name = value && typeof value === "object" ? value.Name : value;
            if (name && values.indexOf(name) === -1) {
                values.push(String(name));
            }
        }
        return values;
    }

    function appendInfoRow(container, label, value, groupEnd) {
        if (!value) {
            return;
        }
        var row = document.createElement("div");
        row.className = groupEnd ? "ns-info-row ns-info-row-group-end" : "ns-info-row";

        var labelEl = document.createElement("div");
        labelEl.className = "ns-info-label";
        labelEl.textContent = label;

        var valueEl = document.createElement("div");
        valueEl.className = "ns-info-value";
        valueEl.textContent = Array.isArray(value) ? value.join(", ") : String(value);

        row.appendChild(labelEl);
        row.appendChild(valueEl);
        container.appendChild(row);
    }

    function getContentAdvisoryText(page) {
        if (!page) {
            return "";
        }

        var elements = page.querySelectorAll("*");
        for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            var label = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            if (label !== "content advisories" && label !== "content advisory") {
                continue;
            }

            var sibling = el.nextElementSibling;
            if (sibling) {
                var siblingText = (sibling.textContent || "").replace(/\s+/g, " ").trim();
                if (siblingText && siblingText.toLowerCase() !== label) {
                    return siblingText;
                }
            }

            var parent = el.parentElement;
            if (parent) {
                var children = parent.children;
                for (var j = 0; j < children.length; j++) {
                    var child = children[j];
                    if (child === el) {
                        continue;
                    }
                    var childText = (child.textContent || "").replace(/\s+/g, " ").trim();
                    if (childText && childText.toLowerCase() !== label) {
                        return childText;
                    }
                }

                var parentText = (parent.textContent || "").replace(/\s+/g, " ").trim();
                var labelPrefix = new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*", "i");
                parentText = parentText.replace(labelPrefix, "").trim();
                if (parentText && parentText.toLowerCase() !== label) {
                    return parentText;
                }
            }
        }

        return "";
    }

    function buildAboutBox(item, page) {
        var box = document.createElement("section");
        box.className = "ns-info-box ns-about-box";

        var heading = document.createElement("h2");
        heading.className = "ns-info-box-title";
        heading.textContent = "About";
        box.appendChild(heading);

        var content = document.createElement("div");
        content.className = "ns-info-content";
        box.appendChild(content);

        // Grouped in pairs with a separator after each pair: (Media title,
        // Genre) / (Director, Writer) / (Synopsis, Content advisories, Tags)
        // / (Region of origin, Studios) - the group-end flag is tied to the
        // field itself, not row position, so a skipped empty field never
        // shifts a separator onto the wrong row.
        appendInfoRow(content, "Media title", item.Name);
        appendInfoRow(content, "Genre", item.Genres && item.Genres.length ? item.Genres.join(", ") : "", true);
        appendInfoRow(content, "Director", getPeopleNames(item, "Director").join(", "));
        appendInfoRow(content, "Writer", getPeopleNames(item, "Writer").join(", "), true);
        appendInfoRow(content, "Synopsis", item.Overview || "");
        appendInfoRow(content, "Content advisories", getContentAdvisoryText(page));
        appendInfoRow(content, "Tags", item.Tags && item.Tags.length ? item.Tags.join(", ") : "", true);
        appendInfoRow(content, "Region of origin", item.ProductionLocations && item.ProductionLocations.length ? item.ProductionLocations.join(", ") : "");
        appendInfoRow(content, "Studios", getNamedValues(item.Studios).join(", "), true);

        return box;
    }

    function hideVersionSelector(page) {
        if (!page) {
            return;
        }

        /* Keep Jellyfin's real Version/source selector in the DOM. Removing
           it breaks the stock track-selection lifecycle, so this is strictly
           a presentation change. The global CSS rule is the primary guard;
           this inline assertion also wins if Jellyfin re-renders the control
           and replaces its classes/styles during navigation. */
        var selectors = page.querySelectorAll(
            ".selectContainer.selectSourceContainer.trackSelectionFieldContainer, " +
            ".selectSourceContainer.trackSelectionFieldContainer"
        );
        for (var i = 0; i < selectors.length; i++) {
            selectors[i].style.display = "none";
        }
    }

    function moveTrackSelectorsIntoVideoBox(page, box) {
        var form = page.querySelector(".trackSelections");
        if (!form) {
            hideVersionSelector(page);
            return false;
        }

        hideVersionSelector(page);
        box.appendChild(form);
        hideVersionSelector(page);
        return true;
    }

    function buildVideoBox(page) {
        var box = document.createElement("section");
        box.className = "ns-info-box ns-video-box";

        var heading = document.createElement("h2");
        heading.className = "ns-info-box-title";
        heading.textContent = "Video";
        box.appendChild(heading);

        var selectors = document.createElement("div");
        selectors.className = "ns-video-selectors";
        box.appendChild(selectors);

        moveTrackSelectorsIntoVideoBox(page, selectors);
        return box;
    }

    function attachInfoBoxes(page, heroContent, item) {
        if (!heroContent || !item) {
            return false;
        }

        if (item.Type === "Person") {
            heroContent.dataset.nsInfoAttached = "1";
            return false;
        }

        var grid = heroContent.querySelector(".ns-info-grid");
        if (!grid) {
            var castSection = heroContent.querySelector(".ns-cast-section");
            if (!castSection) {
                return false;
            }
            grid = document.createElement("div");
            grid.className = "ns-info-grid";
            grid.appendChild(buildAboutBox(item, page));

            var videoBox = document.createElement("section");
            videoBox.className = "ns-info-box ns-video-box";

            var heading = document.createElement("h2");
            heading.className = "ns-info-box-title";
            heading.textContent = "Video";
            videoBox.appendChild(heading);

            var selectors = document.createElement("div");
            selectors.className = "ns-video-selectors";
            videoBox.appendChild(selectors);
            grid.appendChild(videoBox);
            heroContent.appendChild(grid);
        }

        var selectorHost = grid.querySelector(".ns-video-selectors");
        var moved = !!(selectorHost && moveTrackSelectorsIntoVideoBox(page, selectorHost));
        if (moved) {
            heroContent.dataset.nsInfoAttached = "1";
        }
        return moved;
    }

    function buildDetailHero(page, item, imdbRating, ageRating) {
        if (page.dataset.nsHeroBuilt === item.Id) {
            return;
        }

        var wrapper = page.querySelector(DETAIL_SEL.wrapper) || page;

        var hero = document.createElement("div");
        hero.className = "ns-detail-hero";

        var spacer = document.createElement("div");
        spacer.className = "ns-hero-spacer";
        hero.appendChild(spacer);

        var content = document.createElement("div");
        content.className = "ns-hero-content";

        var appendTo = content;
        
        if (item.Type === "Person") {
            content.style.maxWidth = "none";

            var personHeaderContainer = document.createElement("div");
            personHeaderContainer.className = "ns-person-header-container";
            personHeaderContainer.style.maxWidth = "none";
            personHeaderContainer.style.width = "100%";

            var personImage = document.createElement("div");
            personImage.className = "ns-person-image";
            
            var imageUrl = "";
            if (item.ImageTags && item.ImageTags.Primary && window.ApiClient) {
                imageUrl = window.ApiClient.getScaledImageUrl(item.Id, {
                    type: "Primary",
                    tag: item.ImageTags.Primary,
                    maxWidth: 600
                });
            }
            if (imageUrl) {
                personImage.style.backgroundImage = "url('" + imageUrl + "')";
            }
            personHeaderContainer.appendChild(personImage);

            var personDetailsCol = document.createElement("div");
            personDetailsCol.className = "ns-person-details-col";
            personDetailsCol.style.maxWidth = "none";
            personDetailsCol.style.width = "100%";
            personDetailsCol.style.flex = "1 1 100%";
            personHeaderContainer.appendChild(personDetailsCol);
            
            content.appendChild(personHeaderContainer);
            appendTo = personDetailsCol;
        }

        var logoUrl = detailLogoImageUrl(item);
        if (logoUrl && item.Type !== "Person") {
            var logoEl = document.createElement("div");
            logoEl.className = "ns-hero-logo";
            logoEl.style.backgroundImage = "url(" + logoUrl + ")";
            appendTo.appendChild(logoEl);
        } else {
            var titleEl = document.createElement("h1");
            titleEl.className = "ns-hero-title";
            titleEl.textContent = item.Name || "";
            appendTo.appendChild(titleEl);
            
            if (item.Type === "Person") {
                var bioInfoContainer = document.createElement("div");
                bioInfoContainer.className = "ns-person-bio-info";
                
                var birthdayEl = page.querySelector("#itemBirthday");
                if (birthdayEl && birthdayEl.textContent) {
                    var bdClone = document.createElement("p");
                    bdClone.innerHTML = birthdayEl.innerHTML;
                    bioInfoContainer.appendChild(bdClone);
                }
                var deathDateEl = page.querySelector("#itemDeathDate");
                if (deathDateEl && deathDateEl.textContent && !deathDateEl.classList.contains("hide")) {
                    var ddClone = document.createElement("p");
                    ddClone.innerHTML = deathDateEl.innerHTML;
                    bioInfoContainer.appendChild(ddClone);
                }
                var birthLocEl = page.querySelector("#itemBirthLocation");
                if (birthLocEl && birthLocEl.textContent) {
                    var blClone = document.createElement("p");
                    blClone.innerHTML = birthLocEl.innerHTML;
                    bioInfoContainer.appendChild(blClone);
                }
                
                if (bioInfoContainer.childNodes.length > 0) {
                    appendTo.appendChild(bioInfoContainer);
                }
            }
        }

        /* Genre row, tagline, synopsis and (once attached below) the
           action buttons all live together as one "meta highlights"
           component, separate from the logo/title - see
           .ns-hero-meta-highlights in main.css for the darken wash
           this grouping lets sit behind all four as a unit. */
        var metaHighlights = document.createElement("div");
        metaHighlights.className = "ns-hero-meta-highlights";
        if (item.Type === "Person") {
            metaHighlights.style.width = "100%";
        }

        metaHighlights.appendChild(buildMetaRow(item, { includeQualityBadges: true, imdbRating: imdbRating, ageRating: ageRating }));

        if (item.Taglines && item.Taglines.length && item.Taglines[0]) {
            var taglineEl = document.createElement("div");
            taglineEl.className = "ns-tagline";
            taglineEl.textContent = item.Taglines[0];
            metaHighlights.appendChild(taglineEl);
        }

        if (item.Overview) {
            var synopsisEl = document.createElement("div");
            synopsisEl.className = "ns-synopsis";
            if (item.Type === "Person") {
                synopsisEl.style.maxWidth = "none";
                synopsisEl.style.width = "100%";
                
                var fullText = item.Overview;
                var textEl = document.createElement("span");
                textEl.className = "ns-synopsis-text";
                textEl.textContent = fullText;
                
                var toggleBtn = document.createElement("button");
                toggleBtn.className = "ns-synopsis-toggle-btn inline-btn";
                toggleBtn.textContent = "More";
                toggleBtn.style.display = "none";
                
                synopsisEl.appendChild(textEl);
                synopsisEl.appendChild(toggleBtn);
                
                var isExpanded = false;
                var truncatedText = fullText;
                
                toggleBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    isExpanded = !isExpanded;
                    if (isExpanded) {
                        textEl.textContent = fullText;
                        toggleBtn.textContent = "Less";
                    } else {
                        textEl.textContent = truncatedText;
                        toggleBtn.textContent = "More";
                    }
                });

                setTimeout(function() {
                    var lineHeight = parseFloat(window.getComputedStyle(synopsisEl).lineHeight);
                    if (isNaN(lineHeight)) {
                        var fontSize = parseFloat(window.getComputedStyle(synopsisEl).fontSize) || 16;
                        lineHeight = fontSize * 1.5;
                    }
                    var maxH = lineHeight * 9 + 2;
                    
                    if (synopsisEl.scrollHeight > maxH) {
                        toggleBtn.style.display = "inline-block";
                        
                        var min = 0;
                        var max = fullText.length;
                        var bestMax = 0;
                        
                        while (min <= max) {
                            var mid = Math.floor((min + max) / 2);
                            textEl.textContent = fullText.substring(0, mid) + "... ";
                            
                            if (synopsisEl.scrollHeight <= maxH) {
                                bestMax = mid;
                                min = mid + 1;
                            } else {
                                max = mid - 1;
                            }
                        }
                        
                        var cutText = fullText.substring(0, bestMax);
                        var lastSpace = cutText.lastIndexOf(' ');
                        if (lastSpace > 0) {
                            cutText = cutText.substring(0, lastSpace);
                        }
                        
                        truncatedText = cutText + "... ";
                        textEl.textContent = truncatedText;
                    }
                }, 50);
            } else {
                synopsisEl.textContent = item.Overview;
            }
            metaHighlights.appendChild(synopsisEl);
        }

        appendTo.appendChild(metaHighlights);

        hero.appendChild(content);
        wrapper.insertBefore(hero, wrapper.firstChild);

        watchShadeToTextBounds(ensureFixedBackdrop(), content, ensureFixedBackdrop());

        attachActionButtons(page, metaHighlights, item);
        var castAttached = attachCastSection(page, content);
        if (castAttached) {
            attachInfoBoxes(page, content, item);
        }

        page.dataset.nsHeroBuilt = item.Id;
    }

    /**
     * Finds the wrapping block around #castContent that also holds the
     * "Cast & Crew" heading (#peopleHeader), so the heading moves together
     * with the card row instead of being left behind in its old stock
     * position. Climbs a bounded number of levels (rather than assuming a
     * fixed class name for that wrapper) so a stock markup change doesn't
     * silently break this - falls back to the nearest ".verticalSection"
     * or, failing that, #castContent's immediate parent.
     */
    function findCastSection(page) {
        var castContent = page.querySelector(DETAIL_SEL.castContent);
        if (!castContent) {
            return null;
        }
        var el = castContent;
        for (var i = 0; i < 6 && el && el !== page; i++) {
            el = el.parentElement;
            if (el && el.querySelector("#peopleHeader")) {
                return el;
            }
        }
        return castContent.closest(".verticalSection") || castContent.parentElement;
    }

    /**
     * Moves the Cast & Crew section (heading + card row) into the hero
     * content column, directly after the action-button row - stock
     * Jellyfin renders it much further down #itemDetailPage, after several
     * other blocks this skin hides, which used to leave it sitting an
     * inconsistent distance below Play/etc. depending on what stock put in
     * between. Retried on every pass (like attachActionButtons) since the
     * cast row can render after this first runs; guarded by a dataset flag
     * so a no-op re-check doesn't keep re-appending on every mutation.
     */
    function attachEpisodeRow(page, heroContent, item) {
        if (!heroContent) return;
        if (heroContent.dataset.nsEpisodesAttached === "1") return;
        if (item.Type !== "Series" && item.Type !== "Episode") {
            heroContent.dataset.nsEpisodesAttached = "1";
            return;
        }

        heroContent.dataset.nsEpisodesAttached = "1";

        if (!window.ApiClient) return;
        var userId = window.ApiClient.getCurrentUserId();
        var querySeriesId = item.Type === "Series" ? item.Id : item.SeriesId;

        // Fetch seasons
        window.ApiClient.getSeasons(querySeriesId, { UserId: userId }).then(function(seasonsResult) {
            var seasons = seasonsResult.Items;
            if (!seasons || seasons.length === 0) return;

            var section = document.createElement("div");
            section.className = "ns-episode-section";

            var titleHeader = document.createElement("div");
            titleHeader.className = "sectionTitle";
            titleHeader.style.display = "flex";
            titleHeader.style.alignItems = "center";
            titleHeader.style.gap = "1rem";
            
            var activeSeasonId = (item.Type === "Episode" && item.SeasonId) ? item.SeasonId : seasons[0].Id;

                                    var tabsContainer = document.createElement("div");
            tabsContainer.className = "ns-season-tabs";
            tabsContainer.style.display = "flex";
            tabsContainer.style.gap = "10px";
            tabsContainer.style.overflowX = "auto";
            tabsContainer.style.padding = "5px 0";
            
            for (var i = 0; i < seasons.length; i++) {
                var opt = document.createElement("button");
                opt.type = "button";
                opt.className = "ns-season-tab emby-button";
                opt.innerText = seasons[i].Name || "Season 1";
                opt.dataset.seasonId = seasons[i].Id;
                
                if (seasons[i].Id === activeSeasonId) {
                    opt.classList.add("ns-season-tab-active");
                }
                
                opt.addEventListener("click", function(e) {
                    var tabs = tabsContainer.querySelectorAll(".ns-season-tab");
                    for(var t = 0; t < tabs.length; t++) {
                        tabs[t].classList.remove("ns-season-tab-active");
                    }
                    e.currentTarget.classList.add("ns-season-tab-active");
                    
                    loadEpisodes(e.currentTarget.dataset.seasonId);
                });
                tabsContainer.appendChild(opt);
            }
            titleHeader.appendChild(tabsContainer);
            
            section.appendChild(titleHeader);

            var row = document.createElement("div");
            row.className = "ns-episode-row";
            section.appendChild(row);

            var castSection = heroContent.querySelector(".ns-cast-section");
            if (castSection) {
                heroContent.insertBefore(section, castSection);
            } else {
                heroContent.appendChild(section);
            }

            // Drag to scroll logic
            var isDown = false;
            var startX;
            var scrollLeft;
            var didDrag = false;

            row.addEventListener("mousedown", function(e) {
                isDown = true;
                didDrag = false;
                startX = e.pageX - row.offsetLeft;
                scrollLeft = row.scrollLeft;
            });
            row.addEventListener("mouseleave", function() {
                isDown = false;
            });
            row.addEventListener("mouseup", function() {
                isDown = false;
            });
            row.addEventListener("mousemove", function(e) {
                if (!isDown) return;
                e.preventDefault();
                var x = e.pageX - row.offsetLeft;
                var walk = (x - startX) * 1.5;
                row.scrollLeft = scrollLeft - walk;
                if (Math.abs(walk) > 5) {
                    didDrag = true;
                }
            });
            
            row.addEventListener("click", function(e) {
                var card = e.target.closest(".ns-episode-card");
                if (!card) return;
                var actionBtn = e.target.closest(".itemAction[data-action='menu']");
                if (actionBtn) {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    var synMenu = document.createElement("button");
                    synMenu.type = "button";
                    synMenu.className = "itemAction";
                    synMenu.setAttribute("data-id", card.dataset.id);
                    synMenu.setAttribute("data-serverid", card.dataset.serverid);
                    synMenu.setAttribute("data-type", card.dataset.type || "Episode");
                    synMenu.setAttribute("data-mediatype", "Video");
                    synMenu.setAttribute("data-isfolder", "false");
                    synMenu.setAttribute("data-action", "menu");
                    synMenu.setAttribute("aria-hidden", "true");
                    synMenu.tabIndex = -1;
                    
                    synMenu.style.cssText = "position:fixed;top:50%;left:50%;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;";
                    synMenu.getBoundingClientRect = function() {
                        return actionBtn.getBoundingClientRect();
                    };
                    synMenu.focus = function() {}; // Prevent scroll jump
                    
                    var contMenu = document.querySelector(".itemsContainer") ||
                                   document.querySelector("#homeTab") ||
                                   document.querySelector(".homeSectionsContainer") ||
                                   document.body;
                    contMenu.appendChild(synMenu);
                    
                    window.setTimeout(function() {
                        try { synMenu.click(); } finally {
                            window.setTimeout(function() {
                                if (synMenu.parentNode) synMenu.parentNode.removeChild(synMenu);
                            }, 500);
                        }
                    }, 0);
                    return;
                }

                var watchActionBtn = e.target.closest(".ns-episode-card-watch");
                if (watchActionBtn) {
                    // Let the native emby-playstatebutton handler process this click.
                    // Do not preventDefault or stopPropagation.
                    return;
                }
                if (didDrag) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }

                e.preventDefault();
                e.stopPropagation();

                // Play the episode using synthetic itemAction button
                var syn = document.createElement("button");
                syn.type = "button";
                syn.className = "itemAction";
                syn.setAttribute("data-id", card.dataset.id);
                syn.setAttribute("data-serverid", card.dataset.serverid);
                syn.setAttribute("data-type", card.dataset.type || "Episode");
                syn.setAttribute("data-mediatype", "Video");
                syn.setAttribute("data-isfolder", "false");
                syn.setAttribute("data-action", "play");
                syn.setAttribute("aria-hidden", "true");
                syn.tabIndex = -1;
                syn.style.cssText = "position:fixed;top:-10000px;left:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;";
                var cont = document.querySelector(".itemsContainer") ||
                           document.querySelector("#homeTab") ||
                           document.querySelector(".homeSectionsContainer") ||
                           document.body;
                cont.appendChild(syn);
                window.setTimeout(function() {
                    try { syn.click(); } finally {
                        window.setTimeout(function() {
                            if (syn.parentNode) syn.parentNode.removeChild(syn);
                        }, 500);
                    }
                }, 0);
            }, true);

            function loadEpisodes(seasonId) {
                var queryOptions = {
                    UserId: userId,
                    Fields: "Overview,PrimaryImageAspectRatio",
                    Limit: 100
                };
                if (seasonId) queryOptions.SeasonId = seasonId;

                window.ApiClient.getEpisodes(querySeriesId, queryOptions).then(function (result) {
                    row.innerHTML = "";
                    var episodes = result.Items;
                    if (!episodes || episodes.length === 0) return;
                    
                    for (var i = 0; i < episodes.length; i++) {
                        var ep = episodes[i];
                        if (ep.LocationType === "Virtual" || ep.IsMissing || !ep.Id) continue;
                        var card = document.createElement("div");
                        card.className = "ns-episode-card";
                        card.dataset.id = ep.Id;
                        card.dataset.type = ep.Type;
                        card.dataset.serverid = ep.ServerId;
                        
                        var imgUrl = "";
                        if (ep.ImageTags && ep.ImageTags.Primary) {
                            imgUrl = window.ApiClient.getScaledImageUrl(ep.Id, {
                                type: "Primary",
                                maxWidth: 600,
                                tag: ep.ImageTags.Primary
                            });
                        } else if (ep.SeriesId && ep.SeriesPrimaryImageTag) {
                            imgUrl = window.ApiClient.getScaledImageUrl(ep.SeriesId, {
                                type: "Primary",
                                maxWidth: 600,
                                tag: ep.SeriesPrimaryImageTag
                            });
                        }
                        if (imgUrl) {
                            card.style.backgroundImage = "url('" + imgUrl + "')";
                        }

                        if (ep.UserData && ep.UserData.PlaybackPositionTicks) {
                            var runTimeTicks = ep.RunTimeTicks || 0;
                            if (runTimeTicks > 0) {
                                var progress = document.createElement("div");
                                progress.className = "ns-episode-card-progress";
                                var bar = document.createElement("div");
                                bar.className = "ns-episode-card-progress-bar";
                                bar.style.width = ((ep.UserData.PlaybackPositionTicks / runTimeTicks) * 100) + "%";
                                progress.appendChild(bar);
                                card.appendChild(progress);
                            }
                        }

                        var textWrapper = document.createElement("div");
                        textWrapper.className = "ns-episode-card-text";

                        var epNum = document.createElement("div");
                        epNum.className = "ns-episode-card-epnum";
                        epNum.innerText = "EPISODE " + (ep.IndexNumber || "");
                        textWrapper.appendChild(epNum);

                        var titleEl = document.createElement("div");
                        titleEl.className = "ns-episode-card-title";
                        titleEl.innerText = ep.Name || "Episode";
                        textWrapper.appendChild(titleEl);

                        if (ep.Overview) {
                            var overviewEl = document.createElement("div");
                            overviewEl.className = "ns-episode-card-overview";
                            overviewEl.innerText = ep.Overview;
                            textWrapper.appendChild(overviewEl);
                        }

                        var footer = document.createElement("div");
                        footer.className = "ns-episode-card-footer";
                        var dur = document.createElement("span");
                        if (ep.RunTimeTicks) {
                            dur.innerText = Math.round(ep.RunTimeTicks / 600000000) + "m";
                        }
                        footer.appendChild(dur);

                        var isPlayed = ep.UserData && ep.UserData.Played;
                        var playedTitle = isPlayed ? 'Mark unplayed' : 'Mark played';
                        var playedIconClass = isPlayed ? 'playstatebutton-icon-played' : 'playstatebutton-icon-unplayed';
                        var playedDataAttr = isPlayed ? 'true' : 'false';

                        var watchBtnWrapper = document.createElement("div");
                        watchBtnWrapper.innerHTML = '<button is="emby-playstatebutton" type="button" data-action="none" class="itemAction paper-icon-button-light emby-playstatebutton ns-episode-card-watch" data-id="' + ep.Id + '" data-itemid="' + ep.Id + '" data-serverid="' + ep.ServerId + '" data-itemtype="' + ep.Type + '" data-played="' + playedDataAttr + '" title="' + playedTitle + '"><span class="material-icons check ' + playedIconClass + '" aria-hidden="true"></span></button>';
                        var watchBtn = watchBtnWrapper.firstChild;

                        var moreBtn = document.createElement("button");
                        moreBtn.type = "button";
                        moreBtn.className = "itemAction paper-icon-button-light ns-episode-card-more";
                        moreBtn.setAttribute("data-action", "menu");
                        moreBtn.setAttribute("data-id", ep.Id);
                        moreBtn.setAttribute("data-type", ep.Type);
                        moreBtn.setAttribute("data-serverid", ep.ServerId);
                        moreBtn.innerHTML = '<span class="material-icons more_horiz" aria-hidden="true"></span>';

                        var buttonsDiv = document.createElement("div");
                        buttonsDiv.className = "ns-episode-card-buttons";
                        buttonsDiv.style.display = "flex";
                        buttonsDiv.style.alignItems = "center";
                        
                        buttonsDiv.appendChild(watchBtn);
                        buttonsDiv.appendChild(moreBtn);
                        footer.appendChild(buttonsDiv);
                        textWrapper.appendChild(footer);
                        card.appendChild(textWrapper);
                        row.appendChild(card);
                    }
                });
            }

            loadEpisodes(activeSeasonId);

        }).catch(function(err) {
            console.error("Failed to fetch seasons/episodes", err);
        });
    }
    function attachCastSection(page, heroContent) {
        if (!heroContent) {
            return false;
        }
        if (heroContent.dataset.nsCastAttached === "1" && heroContent.querySelector(".ns-cast-section")) {
            return true;
        }
        var section = findCastSection(page);
        if (!section) {
            // Cast section not rendered yet - try again on the next pass.
            return false;
        }
        section.classList.add("ns-cast-section");
        heroContent.appendChild(section);
        heroContent.dataset.nsCastAttached = "1";
        return true;
    }

    /**
     * Director(s) first, then writer(s), then everyone else in whatever
     * order stock peoplecardbuilder already rendered them - matched by
     * each card's data-id attribute against item.People (which carries
     * each person's Type), since that's the one identifier a card and a
     * People entry are guaranteed to share.
     */
    function reorderCastCrew(page, item) {
        var castContent = page.querySelector(DETAIL_SEL.castContent);
        if (!castContent || !item.People || !item.People.length) {
            return;
        }

        if (castContent.dataset.nsCastOrdered === item.Id) {
            return;
        }

        var cards = Array.prototype.slice.call(castContent.children);
        if (!cards.length) {
            // Cast cards haven't rendered yet - try again on the next
            // MutationObserver pass instead of marking this done.
            return;
        }

        var typeById = {};
        for (var i = 0; i < item.People.length; i++) {
            var person = item.People[i];
            if (person.Id) {
                typeById[person.Id] = person.Type;
            }
        }

        function priority(cardEl) {
            var id = cardEl.getAttribute("data-id") || cardEl.getAttribute("data-itemid");
            var type = id ? typeById[id] : null;
            if (type === "Director") {
                return 0;
            }
            if (type === "Writer") {
                return 1;
            }
            return 2;
        }

        var ordered = cards.slice().sort(function (a, b) {
            return priority(a) - priority(b);
        });

        var changed = false;
        for (var j = 0; j < ordered.length; j++) {
            if (cards[j] !== ordered[j]) {
                changed = true;
                break;
            }
        }

        if (changed) {
            for (var k = 0; k < ordered.length; k++) {
                castContent.appendChild(ordered[k]);
            }
        }

        castContent.dataset.nsCastOrdered = item.Id;
    }

    /**
     * Entry point called from the shared MutationObserver/hashchange
     * wiring in start(). Always runs syncDetailBackdrop() (cheap once
     * settled - see that function). The hero/buttons/cast work below it
     * is cheap (just re-checks a few dataset flags, no network call) once
     * all three are done for the current item - only re-fetches the item
     * while one of them is still outstanding, so this doesn't keep
     * hammering the API on every unrelated DOM mutation elsewhere in the
     * app.
     */
    function initDetailPage() {
        updateDetailPageBodyClass();
        wireDetailScrollDarkening();
        syncDetailScrollDarkening();

        /* Driven off the hash, not "is a detail page currently visible" -
           deliberately called before the page-visibility early-return below,
           so the backdrop's timing is never coupled to the same transient
           layout signal (computed display during a page-slide transition)
           that caused it to flicker off in the old code. */
        syncDetailBackdrop();

        var page = getVisibleDetailPage();
        if (!page) {
            return;
        }

        /* Re-assert the UI-only hide on every detail-page pass because
           jellyfin-web may recreate the selector after the initial render. */
        hideVersionSelector(page);

        var itemId = getDetailItemIdFromHash();
        if (!itemId) {
            return;
        }

        try {
            var heroBuilt = page.dataset.nsHeroBuilt === itemId;
            var heroContent = heroBuilt ? page.querySelector(".ns-hero-content") : null;
            /* Buttons now attach into the meta-highlights wrapper (see
               buildDetailHero/attachActionButtons), not straight onto
               .ns-hero-content, so their "done" flag is checked there. */
            var metaHighlightsEl = heroBuilt ? page.querySelector(".ns-hero-meta-highlights") : null;
            var buttonsDone = !!(metaHighlightsEl && metaHighlightsEl.dataset.nsButtonsAttached === "1");
            var castSectionDone = !!(heroContent && heroContent.dataset.nsCastAttached === "1");
            var infoBoxesDone = !!(heroContent && heroContent.dataset.nsInfoAttached === "1");
            var episodeRowDone = !!(heroContent && heroContent.dataset.nsEpisodesAttached === "1");
            var castContent = page.querySelector(DETAIL_SEL.castContent);
            var castOrderDone = !!(castContent && castContent.dataset.nsCastOrdered === itemId);
            /* Unlike the flags above (all keyed off "has this been built
               at least once for this item"), the play label needs to be
               refreshed on every genuine revisit - see updatePlayButtonLabel's
               comment for why. lastPlayLabelVisit is what actually gates
               the extra fetch; this just decides whether initDetailPage's
               early-return should be skipped so that fetch gets a chance
               to run at all. */
            var playLabelFresh = lastPlayLabelVisit.page === page && lastPlayLabelVisit.itemId === itemId;

            if (heroBuilt && buttonsDone && castSectionDone && infoBoxesDone && castOrderDone && playLabelFresh && episodeRowDone) {
                return;
            }

            fetchItem(itemId).then(function (item) {
                if (!item || getVisibleDetailPage() !== page) {
                    return;
                }
                
                if (item.Type === "Person") {
                    document.body.classList.add("ns-type-Person");
                } else {
                    document.body.classList.remove("ns-type-Person");
                }

                if (!heroBuilt) {
                    Promise.all([resolveItemImdbRating(item), resolveItemAgeRating(item)]).then(function (results) {
                        if (getVisibleDetailPage() !== page) {
                            return;
                        }
                        buildDetailHero(page, item, results[0], results[1]);
                    });
                } else {
                    if (!buttonsDone) {
                        attachActionButtons(page, page.querySelector(".ns-hero-meta-highlights"), item);
                    }
                    if (!episodeRowDone && page.querySelector(".ns-hero-content")) {
                        attachEpisodeRow(page, page.querySelector(".ns-hero-content"), item);
                    }
                    if (!castSectionDone) {
                        castSectionDone = attachCastSection(page, page.querySelector(".ns-hero-content"));
                    }
                    if (!infoBoxesDone && castSectionDone) {
                        attachInfoBoxes(page, page.querySelector(".ns-hero-content"), item);
                    }
                }
                updatePlayButtonLabel(page, item);
                reorderCastCrew(page, item);
            });
        } catch (err) {
            /* never let a detail-page hiccup interrupt the shared
               wireUp()/updateActivePill() pass this runs alongside */
        }
    }

    /**
     * ==================================================================
     * Home screen hero banner (Apple-TV-style)
     * ==================================================================
     * A full-viewport rotating banner pinned to the top of the Home
     * screen, above the existing rails: one item at a time, drawn from
     * the user's own libraries, auto-advancing on a timer and also
     * steerable by mouse (edge arrows, the dot strip, or a horizontal
     * drag across the banner).
     *
     * Design notes / why it's built this way:
     *
     * - ONE pair of layered image divs (ns-hhero-layer-a / -b) that
     *   cross-fade, NOT one slide element per item. The item list can be
     *   dozens of titles; mounting a full-viewport backdrop element for
     *   each would cost that many simultaneous image decodes for no
     *   visual gain, since only ever one and a half are on screen.
     *
     * - The item list comes from ApiClient with SortBy=Random, so the
     *   draw is from the WHOLE library rather than a fixed slice of it,
     *   and is re-drawn on each fresh page load. HOME_HERO_LIMIT caps how
     *   many are held in one rotation (see that constant).
     *
     * - Only items that actually have a Backdrop/Thumb image are kept -
     *   a hero frame with no landscape image behind it looks broken, so
     *   those titles are skipped rather than shown letterboxed.
     *
     * - Everything here is additive: the hero is inserted as an extra
     *   first child of .homeSectionsContainer and never modifies, hides
     *   or reorders any stock home rail. If any step fails (no ApiClient,
     *   no items, an API error), nothing is inserted and Home renders
     *   exactly like it did before.
     * ------------------------------------------------------------------
     */

    /* How many titles one rotation holds. Kept well under "the entire
       library" deliberately: each slide preloads a 1920px backdrop, and a
       viewer realistically never reaches the end of 25 before navigating
       away - while SortBy=Random means these 25 are drawn fresh from the
       full library on every page load, so over time every title can
       appear. Raise it if you'd rather have a longer single rotation. */
    var HOME_HERO_LIMIT = 25;

    /* Dwell time per slide. Also drives the dot-progress animation (the
       CSS reads it from the --ns-hhero-interval custom property, set on
       the hero element below), so changing it here keeps the indicator
       in sync automatically. */
    var HOME_HERO_INTERVAL_MS = 9000;

    /* Horizontal distance (px) a mouse/touch drag must cover before it
       counts as a deliberate swipe rather than a stray click. */
    var HOME_HERO_DRAG_THRESHOLD = 60;

    /* How many times a lookup that came back with nothing usable may be
       retried before the hero gives up for this session - see the comment
       at the call site in initHomeHero for why a cap is needed at all. */
    var HOME_HERO_MAX_ATTEMPTS = 3;

    var homeHero = {
        root: null,      /* the .ns-home-hero element, while mounted */
        skeleton: null,   /* immediate visual placeholder while hero data/images resolve */
        items: [],       /* the current rotation's items */
        index: 0,
        layers: [],      /* the two cross-fading image divs */
        activeLayer: 0,
        timer: null,
        paused: false,   /* pointer is over the text/controls, or dragging */
        suppressClick: false, /* swallow the click that ends a drag gesture */
        fetching: false,
        attempts: 0,     /* lookups spent, capped by HOME_HERO_MAX_ATTEMPTS */
        body: null,      /* text+buttons column, rebuilt per slide */
        dots: null
    };

    function prefersReducedMotion() {
        try {
            return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        } catch (err) {
            return false;
        }
    }

    /**
     * The .homeSectionsContainer of the page that is actually on screen.
     * Same reasoning as getVisibleDetailPage(): jellyfin-web keeps old
     * pages mounted but hidden, so a plain querySelector can hand back a
     * stale container that will never be seen - and mounting a
     * full-viewport hero into that one means it is never visible at all.
     *
     * Rendered-ness is tested with getClientRects(), NOT with this
     * element's own computed display. What jellyfin-web hides is the PAGE
     * wrapper, and the CSS `display` computed on a descendant of a
     * display:none element is still its own value ("block"), not "none" -
     * so a display check here would call every stale container visible.
     * An unrendered element generates no boxes, which getClientRects()
     * does report, however far up the tree the hiding happens.
     */
    function getVisibleHomeContainer() {
        try {
            var containers = document.querySelectorAll(".homeSectionsContainer");
            for (var i = 0; i < containers.length; i++) {
                var c = containers[i];
                if (c.closest && c.closest(".hide")) {
                    continue;
                }
                if (!c.getClientRects().length) {
                    continue;
                }
                return c;
            }
        } catch (err) {
            /* fall through */
        }
        return null;
    }

    /**
     * Library items for the rotation, via the same authenticated
     * window.ApiClient every stock screen uses. Two call shapes are tried
     * because getItems() is not present on every jellyfin-web build's
     * exposed client; getUrl()+getJSON() is the lower-level pair that has
     * been there throughout and hits the identical endpoint.
     */
    function fetchHomeHeroItems() {
        var query = {
            IncludeItemTypes: "Movie,Series",
            Recursive: true,
            SortBy: "Random",
            Limit: HOME_HERO_LIMIT,
            /* Server-side "must have a backdrop" filter. Client-side
               filtering below still runs, since this parameter is
               ignored by some server versions. */
            ImageTypes: "Backdrop",
            EnableImageTypes: "Backdrop,Logo,Thumb,Primary",
            ImageTypeLimit: 1,
            /* ProviderIds is needed here (in addition to the detail-hero's
               already-unrestricted getItem() calls) so the home hero's own
               meta row can resolve an IMDb id and show the IMDb rating
               badge too. */
            Fields: "Overview,Genres,Taglines,ProviderIds"
        };

        try {
            if (!window.ApiClient) {
                return Promise.resolve([]);
            }

            var userId = window.ApiClient.getCurrentUserId
                ? window.ApiClient.getCurrentUserId()
                : null;

            var request;
            if (typeof window.ApiClient.getItems === "function") {
                request = window.ApiClient.getItems(userId, query);
            } else if (typeof window.ApiClient.getUrl === "function" &&
                       typeof window.ApiClient.getJSON === "function") {
                if (userId) {
                    query.UserId = userId;
                }
                request = window.ApiClient.getJSON(window.ApiClient.getUrl("Items", query));
            } else {
                return Promise.resolve([]);
            }

            return request.then(function (result) {
                var items = (result && result.Items) || [];
                return items.filter(function (item) {
                    return !!heroBackdropImageUrl(item);
                });
            }, function () {
                return [];
            });
        } catch (err) {
            return Promise.resolve([]);
        }
    }

    function makeHeroButton(className, label, iconName) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = className;

        if (iconName) {
            var icon = document.createElement("span");
            /* Jellyfin's own Material Icons font - see the icon-font
               protection block in main.css; never draw these as text or
               CSS shapes. */
            icon.className = "material-icons";
            icon.setAttribute("aria-hidden", "true");
            icon.textContent = iconName;
            btn.appendChild(icon);
        }

        if (label) {
            var text = document.createElement("span");
            text.className = "ns-hhero-btn-text";
            text.textContent = label;
            btn.appendChild(text);
        }

        btn.setAttribute("aria-label", label || "");
        return btn;
    }

    function makeHeroLayerImage() {
        var img = document.createElement("div");
        img.className = "ns-hhero-layer-img";
        return img;
    }

    /**
     * Keeps a shade/backdrop element's darken-overlay reach tied to the
     * ACTUAL rendered size of the text block it sits behind, instead of
     * the fixed vw/vh guesses in main.css - so a longer synopsis (more
     * wrapped lines) or a taller title logo grows the dark region to
     * match it, rather than the overlay silently falling short of newly
     * wrapped text. Writes --ns-shade-w/--ns-shade-h (percentages of
     * boxEl's own box) onto shadeEl; the CSS radial-gradients read them
     * with a static fallback, so this is additive - nothing breaks if a
     * measurement comes back 0 (element not laid out yet) or this never
     * runs at all. A ResizeObserver (not a one-off measurement) is what
     * makes this keep up with text reflow on window resize, since main.js
     * has no other hook for "this element's rendered size changed".
     *
     * Also writes --ns-shade-left-w, which does the same job for the
     * left-to-right linear-gradient wash in main.css: how far right that
     * gradient has to run before going fully transparent, as a percentage
     * of boxEl's own width, so a wider meta row (more genre/rating chips)
     * or a title logo that runs wider than the synopsis text extends the
     * horizontal darkening to match, instead of the fixed fallback
     * leaving the edge of a wide row sitting on raw backdrop - the exact
     * failure mode --ns-shade-w/--ns-shade-h already solve for the
     * vertical/radial shade, just measured along the other axis. */
    function watchShadeToTextBounds(shadeEl, textEl, boxEl) {
        if (!shadeEl || !textEl || !boxEl || typeof ResizeObserver === "undefined") {
            return;
        }
        var apply = function () {
            var boxRect = boxEl.getBoundingClientRect();
            var textRect = textEl.getBoundingClientRect();
            if (!boxRect.width || !boxRect.height) {
                return;
            }
            /* Pad beyond the text's own box (not a 1:1 trace) so the fade
               still has room to blend gradually past the text edge rather
               than clipping flush against it - matches the hand-tuned
               static fallback's own margin. */
            var w = ((textRect.right - boxRect.left) / boxRect.width) * 100 + 14;
            var h = ((boxRect.bottom - textRect.top) / boxRect.height) * 100 + 12;
            shadeEl.style.setProperty("--ns-shade-w", Math.max(40, Math.min(160, w)) + "%");
            shadeEl.style.setProperty("--ns-shade-h", Math.max(40, Math.min(160, h)) + "%");

            /* Same right-edge measurement as `w` above, but used as a
               direct left-to-right reach rather than an ellipse diameter,
               so it needs its own (larger) pad and its own clamp range -
               74 is the hand-tuned static fallback in main.css, and the
               range is kept inside 50-100 so the wash can never shrink to
               nothing on a short title nor flood the entire banner and
               swallow the backdrop art on the right half. */
            var leftW = ((textRect.right - boxRect.left) / boxRect.width) * 100 + 20;
            shadeEl.style.setProperty("--ns-shade-left-w", Math.max(50, Math.min(100, leftW)) + "%");
        };
        apply();
        var ro = new ResizeObserver(apply);
        ro.observe(textEl);
        ro.observe(boxEl);
        return ro;
    }

    function navigateToHeroItem(item) {
        if (!item || !item.Id) {
            return;
        }
        var target = "#!/details?id=" + encodeURIComponent(item.Id);
        if (item.ServerId) {
            target += "&serverId=" + encodeURIComponent(item.ServerId);
        }
        window.location.hash = target;
    }

    /**
     * Starts playback through Jellyfin Web's own shortcuts/action system.
     *
     * Jellyfin Web 12 keeps PlaybackManager inside its application module
     * graph instead of exposing it as a reliable window global, so calling
     * window.playbackManager directly works only on some older builds. The
     * built-in shortcut handler already knows how to turn a normal
     * data-action="play" / data-action="resume" itemAction into the real
     * PlaybackManager.play() call. We use that path here instead of
     * reimplementing playback or navigating to the details screen.
     *
     * The synthetic element is inserted into a container watched by
     * Jellyfin's shortcut handler, clicked on the next task so the element
     * is fully attached before dispatch, and removed shortly afterwards.
     * This keeps device-profile selection, transcoding/direct-play
     * decisions, player selection and playback reporting inside Jellyfin.
     */
    function playHomeHeroItem(item) {
        if (!item || !item.Id) {
            return;
        }

        /* Keep compatibility with older Jellyfin Web builds / local
           integrations that do expose PlaybackManager globally. */
        try {
            var pm = window.PlaybackManager ||
                     window.playbackManager ||
                     (window.Emby && window.Emby.playbackManager) ||
                     null;
            if (pm && typeof pm.play === "function") {
                pm.play({
                    ids: [item.Id],
                    serverId: item.ServerId,
                    fullscreen: true
                });
                return;
            }
        } catch (err) {
            /* Use the native shortcut path below. */
        }

        try {
            var action = "play";
            var synthetic = document.createElement("button");
            synthetic.type = "button";
            synthetic.className = "itemAction";
            synthetic.setAttribute("data-id", item.Id);
            if (item.ServerId) {
                synthetic.setAttribute("data-serverid", item.ServerId);
            }
            synthetic.setAttribute("data-type", item.Type || "Movie");
            synthetic.setAttribute("data-mediatype", item.MediaType || "Video");
            synthetic.setAttribute("data-isfolder", "false");
            synthetic.setAttribute("data-action", action);
            synthetic.setAttribute("aria-hidden", "true");
            synthetic.tabIndex = -1;
            synthetic.style.cssText =
                "position:fixed;top:-10000px;left:-10000px;width:1px;height:1px;" +
                "opacity:0;pointer-events:none;z-index:-1;";

            /* Jellyfin 12's shortcuts listener is scoped to these containers
               rather than document.body. Prefer a currently-rendered home
               container, then fall back to a generic items container/body. */
            var container = document.querySelector(".itemsContainer") ||
                            document.querySelector("#homeTab") ||
                            document.querySelector(".homeSectionsContainer") ||
                            document.body;
            container.appendChild(synthetic);

            window.setTimeout(function () {
                try {
                    synthetic.click();
                } finally {
                    window.setTimeout(function () {
                        if (synthetic.parentNode) {
                            synthetic.parentNode.removeChild(synthetic);
                        }
                    }, 500);
                }
            }, 0);

            return;
        } catch (err) {
            /* Do not turn a failed play action into an unexpected details
               navigation. The user's explicit Play action must never open
               the item's details page as a fallback. */
            try {
                if (window.console && console.error) {
                    console.error("Netflix Skin: failed to trigger hero playback", err);
                }
            } catch (ignore) {
                /* no-op */
            }
        }
    }

    /**
     * Pulls the hero up under the header so it really is full-viewport.
     *
     * The gap above it is whatever padding jellyfin-web's own page/
     * container carries to clear the fixed header - a number this skin
     * doesn't control and shouldn't hard-code, so it's measured instead:
     * zero the pull, read where the hero's top edge actually lands, and
     * feed that back as a negative margin. Only measured while the page
     * is scrolled to the top, because the measurement is a viewport-
     * relative one; mid-scroll it would read a meaningless value, so it's
     * skipped and retried later rather than applied wrong.
     */
    function syncHomeHeroPull(hero) {
        if (!hero || !hero.isConnected) {
            return;
        }
        try {
            var scroller = hero.parentElement;
            while (scroller && scroller !== document.body) {
                var overflowY = window.getComputedStyle(scroller).overflowY;
                if (overflowY === "auto" || overflowY === "scroll") {
                    break;
                }
                scroller = scroller.parentElement;
            }

            var scrollTop;
            if (scroller && scroller !== document.body) {
                scrollTop = scroller.scrollTop;
            } else {
                scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
            }
            if (scrollTop > 4) {
                return;
            }

            hero.style.setProperty("--ns-hhero-pull", "0px");

            /* Only tuck the hero under the header if that header is
               actually lifted out of the document flow. If some
               jellyfin-web version renders it as ordinary in-flow
               content instead, pulling the hero up over it would cover
               the navigation with a full-viewport image - so in that
               case the hero simply starts below the header and is
               "full screen" from there down. */
            var appBar = document.querySelector(".MuiAppBar-root, .skinHeader");
            if (appBar) {
                var barPosition = window.getComputedStyle(appBar).position;
                if (barPosition !== "fixed" && barPosition !== "sticky" && barPosition !== "absolute") {
                    return;
                }
            }

            var top = hero.getBoundingClientRect().top;
            if (top > 0) {
                hero.style.setProperty("--ns-hhero-pull", Math.round(top) + "px");
            }
        } catch (err) {
            /* leave the hero where it sits - still usable, just not
               tucked under the header */
        }
    }

    function buildHomeHeroDots(count) {
        var strip = document.createElement("div");
        strip.className = "ns-hhero-dots";
        strip.setAttribute("role", "tablist");
        strip.setAttribute("aria-label", "Featured titles");

        for (var i = 0; i < count; i++) {
            var dot = document.createElement("button");
            dot.type = "button";
            dot.className = "ns-hhero-dot";
            dot.dataset.index = String(i);
            dot.setAttribute("role", "tab");
            dot.setAttribute("aria-label", "Show featured title " + (i + 1));

            /* Separate child, not a ::before: the progress sweep is
               restarted per slide by swapping a class on this element,
               which needs a real node to hang the animation on. */
            var fill = document.createElement("span");
            fill.className = "ns-hhero-dot-fill";
            dot.appendChild(fill);

            strip.appendChild(dot);
        }

        return strip;
    }

    function updateHomeHeroDots() {
        if (!homeHero.dots) {
            return;
        }
        var dots = homeHero.dots.querySelectorAll(".ns-hhero-dot");
        for (var i = 0; i < dots.length; i++) {
            var isActive = i === homeHero.index;
            dots[i].classList.toggle("ns-active", isActive);
            dots[i].setAttribute("aria-selected", isActive ? "true" : "false");

            if (isActive) {
                /* Restart the sweep from 0 by detaching and re-attaching
                   the animation - simply re-adding the class on an
                   element that already has it would not retrigger it. */
                var fill = dots[i].querySelector(".ns-hhero-dot-fill");
                if (fill) {
                    fill.classList.remove("ns-running");
                    /* Forced reflow: reading offsetWidth between the two
                       class changes is what makes the browser treat this
                       as a genuine restart rather than a no-op. */
                    void fill.offsetWidth;
                    fill.classList.add("ns-running");
                }
            }
        }
    }

    function preloadHomeHeroImage(item) {
        try {
            var url = item ? heroBackdropImageUrl(item) : null;
            if (url) {
                var img = new Image();
                img.src = url;
            }
        } catch (err) {
            /* preloading is an optimisation only */
        }
    }

    /**
     * Rebuilds the text column (logo/title, meta, synopsis, Play) for the
     * item at homeHero.index and slides the backdrop across to it.
     *
     * `direction` is +1 when moving forward through the rotation, -1 when
     * moving back, and 0 for the very first paint (which has nothing to
     * slide away from, so it just appears). Everything visual keys off it,
     * so a slide always travels the way the viewer's own action implied:
     * the next arrow pushes the new image in from the right, the previous
     * arrow from the left.
     */
    function renderHomeHeroSlide(direction) {
        var item = homeHero.items[homeHero.index];
        if (!item || !homeHero.root) {
            return;
        }

        var dir = direction || 0;

        /* --- backdrop slide ----------------------------------------- */
        var url = heroBackdropImageUrl(item);
        if (url && homeHero.layers.length === 2) {
            var incoming = homeHero.layers[1 - homeHero.activeLayer];
            var outgoing = homeHero.layers[homeHero.activeLayer];

            /* The image lives on an inner element, not on the layer
               itself, because the two are animating different transforms
               at the same time: the layer slides horizontally while the
               image inside it runs its slow zoom. One element can only
               hold one transform, so a single div would mean the zoom
               cancelling the slide (or vice versa). */
            var incomingImg = incoming.querySelector(".ns-hhero-layer-img");
            if (incomingImg) {
                incomingImg.style.backgroundImage = "url(" + url + ")";
                incomingImg.classList.remove("ns-kenburns");
                void incomingImg.offsetWidth;
                incomingImg.classList.add("ns-kenburns");
            }

            /* Push + dissolve. The incoming layer still travels in from
               the side the viewer's action implied (so it reads as a
               slide, not a flat cut), but it also fades up from opacity 0
               at the same time, and the outgoing layer fades down to 0 as
               it slides out. Both are therefore substantially transparent
               by the time they cross paths in the middle, so the seam
               between "current poster" and "next poster" is a soft
               dissolve rather than a hard, fully-opaque edge - that's what
               produced the old bug of a neighboring backdrop reading as
               clearly visible near the frame edge. */
            incoming.classList.add("ns-no-transition");
            incoming.classList.remove("ns-visible");
            incoming.style.transform = "translateX(" + (dir * 100) + "%)";
            void incoming.offsetWidth;
            incoming.classList.remove("ns-no-transition");
            incoming.classList.add("ns-visible");
            incoming.style.transform = "translateX(0)";

            if (dir === 0) {
                /* First paint: nothing meaningful underneath, so the
                   outgoing layer just stops being painted. */
                outgoing.classList.remove("ns-visible");
                outgoing.style.transform = "translateX(0)";
            } else {
                outgoing.classList.remove("ns-visible");
                outgoing.style.transform = "translateX(" + (-dir * 100) + "%)";
            }

            homeHero.activeLayer = 1 - homeHero.activeLayer;
        }

        /* --- text column -------------------------------------------- */
        var body = homeHero.body;
        if (body) {
            while (body.firstChild) {
                body.removeChild(body.firstChild);
            }

            var logoUrl = detailLogoImageUrl(item);
            if (logoUrl) {
                var logo = document.createElement("div");
                logo.className = "ns-hhero-logo";
                logo.style.backgroundImage = "url(" + logoUrl + ")";
                logo.setAttribute("role", "img");
                logo.setAttribute("aria-label", item.Name || "");
                body.appendChild(logo);
            } else {
                var title = document.createElement("h1");
                title.className = "ns-hhero-title";
                title.textContent = item.Name || "";
                body.appendChild(title);
            }

            /* Same builder the detail hero uses, so genre/year/runtime,
               age rating and the rating badges all look identical in both
               places. Codec/audio/CC badges are detail-screen only, so
               they're explicitly excluded here. */
            var meta = buildMetaRow(item, { includeQualityBadges: false, imdbRating: item.__nsImdbRating, ageRating: item.__nsAgeRating });
            meta.classList.add("ns-hhero-meta");
            body.appendChild(meta);

            if (item.Taglines && item.Taglines.length && item.Taglines[0]) {
                var tagline = document.createElement("div");
                tagline.className = "ns-hhero-tagline";
                tagline.textContent = item.Taglines[0];
                body.appendChild(tagline);
            }

            if (item.Overview) {
                var overview = document.createElement("p");
                overview.className = "ns-hhero-overview";
                overview.textContent = item.Overview;
                body.appendChild(overview);
            }

            var actions = document.createElement("div");
            actions.className = "ns-hhero-actions";

            /* Play is the only button here. Opening the details screen is
               the whole banner's job now (see the click handler in
               wireHomeHeroInteractions), so a separate More Info button
               would just be a second, smaller target for something the
               viewer can already do by clicking anywhere. */
            var playBtn = makeHeroButton("ns-hhero-btn ns-hhero-btn-play", "Play", "play_arrow");
            playBtn.addEventListener("click", function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                playHomeHeroItem(homeHero.items[homeHero.index]);
            });
            actions.appendChild(playBtn);

            body.appendChild(actions);

            /* Text travels the same way the image did, just a shorter
               distance - enough to read as one movement rather than two
               unrelated ones. */
            body.style.setProperty("--ns-hhero-enter-x", (dir * 60) + "px");
            body.classList.remove("ns-enter");
            void body.offsetWidth;
            body.classList.add("ns-enter");
        }

        updateHomeHeroDots();
        preloadHomeHeroImage(homeHero.items[(homeHero.index + 1) % homeHero.items.length]);
    }

    function clearHomeHeroTimer() {
        if (homeHero.timer) {
            window.clearTimeout(homeHero.timer);
            homeHero.timer = null;
        }
    }

    /**
     * Schedules the next auto-advance. Skipped entirely when the viewer
     * has asked for reduced motion (an unprompted rotating banner is
     * exactly the kind of motion that setting is about) - the arrows and
     * dots still work, so nothing becomes unreachable, it just doesn't
     * move on its own.
     */
    function scheduleHomeHeroAdvance() {
        clearHomeHeroTimer();

        if (prefersReducedMotion()) {
            return;
        }
        if (homeHero.paused || homeHero.items.length < 2) {
            return;
        }
        if (!homeHero.root || !homeHero.root.isConnected) {
            return;
        }

        homeHero.timer = window.setTimeout(function () {
            homeHero.timer = null;
            goToHomeHeroSlide(homeHero.index + 1, 1);
        }, HOME_HERO_INTERVAL_MS);
    }

    /**
     * The single entry point for changing slides - timer, arrows, dots
     * and drag all go through here, so restarting the dwell timer and
     * the dot progress can never be forgotten at one of the call sites.
     * Wraps around in both directions.
     *
     * `direction` (+1/-1) says which way the slide animation should
     * travel. Callers that mean "forward"/"back" pass it explicitly;
     * the dot strip, where the viewer jumps to an arbitrary position,
     * leaves it out and gets the direction inferred from where that
     * position sits relative to the current one - so a jump rightwards
     * along the strip moves the artwork rightwards too.
     */
    function goToHomeHeroSlide(nextIndex, direction) {
        var count = homeHero.items.length;
        if (!count) {
            return;
        }

        var previousIndex = homeHero.index;
        homeHero.index = ((nextIndex % count) + count) % count;

        var dir = direction;
        if (!dir) {
            if (homeHero.index === previousIndex) {
                /* Clicking the dot of the slide already showing: nothing
                   to animate, just leave it be (and let the dwell timer
                   restart below, so it doesn't change straight away). */
                dir = 0;
            } else {
                dir = homeHero.index > previousIndex ? 1 : -1;
            }
        }

        renderHomeHeroSlide(dir);
        scheduleHomeHeroAdvance();
    }

    function setHomeHeroPaused(paused) {
        homeHero.paused = paused;
        if (homeHero.root) {
            homeHero.root.classList.toggle("ns-paused", paused);
        }
        if (paused) {
            clearHomeHeroTimer();
        } else {
            scheduleHomeHeroAdvance();
        }
    }

    /**
     * Mouse/touch control: edge arrows, the dot strip, and a horizontal
     * drag anywhere across the banner. Hovering anywhere over the hero
     * pauses the rotation (and the dot's progress sweep) so a title being
     * read doesn't slide away mid-sentence.
     */
    function wireHomeHeroInteractions(hero) {
        /* Hover-pause is scoped to the text column and the controls - NOT
           to the banner as a whole. The banner is the entire viewport, so
           "pause while the pointer is over it" would mean pausing
           permanently the moment the viewer moves the mouse anywhere on
           the Home screen, and the rotation would effectively never run on
           a desktop. Pausing over the synopsis/buttons/dots still covers
           the case that matters: text being read, or a control being
           aimed at, shouldn't slide away underneath the pointer. */
        var PAUSE_ZONE = ".ns-hhero-body, .ns-hhero-arrow, .ns-hhero-dots";

        hero.addEventListener("mouseover", function (ev) {
            if (ev.target.closest && ev.target.closest(PAUSE_ZONE)) {
                setHomeHeroPaused(true);
            }
        });

        hero.addEventListener("mouseout", function (ev) {
            /* relatedTarget is where the pointer went. Moving between two
               children of the same zone must not count as leaving it, so
               only unpause when the destination is outside every zone. */
            var to = ev.relatedTarget;
            if (!to || !to.closest || !to.closest(PAUSE_ZONE)) {
                setHomeHeroPaused(false);
            }
        });

        /* Leaving the banner entirely always resumes, whatever the
           mouseout bookkeeping above concluded. */
        hero.addEventListener("mouseleave", function () {
            setHomeHeroPaused(false);
        });

        hero.querySelector(".ns-hhero-prev").addEventListener("click", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            goToHomeHeroSlide(homeHero.index - 1, -1);
        });

        hero.querySelector(".ns-hhero-next").addEventListener("click", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            goToHomeHeroSlide(homeHero.index + 1, 1);
        });

        homeHero.dots.addEventListener("click", function (ev) {
            var dot = ev.target.closest(".ns-hhero-dot");
            if (!dot) {
                return;
            }
            ev.preventDefault();
            ev.stopPropagation();
            goToHomeHeroSlide(parseInt(dot.dataset.index, 10) || 0);
        });

        /* Click anywhere on the artwork opens the title's details screen.
           The controls above all call stopPropagation, so a click on an
           arrow, a dot or Play never reaches this - and the drag guard
           below covers the other way a click could be unintended.
           
           IMPORTANT: this is a listener bound directly on `hero`, entirely
           separate from the delegated document-level onCardClick handler
           above. onCardClick's own open-menu guard does NOT protect this
           listener - it only skips onCardClick's own card-navigation logic
           for that one event, it does not stop the event from continuing
           to bubble here. Because the hero banner sits at the very top of
           the home screen (behind the header and often behind a poster row
           that visually overlaps it), a click meant to dismiss the profile
           dropdown or a card's three-dot menu frequently lands on the hero
           underneath it. Without checking here too, that dismiss click was
           being read as "open this hero item's details screen". */
        hero.addEventListener("click", function (ev) {
            if (ev.target.closest && ev.target.closest(OPEN_MENU_SELECTOR)) {
                return;
            }
            if (isOutsideClickForOpenMenu(ev.target)) {
                return;
            }
            if (homeHero.suppressClick) {
                /* The tail end of a drag. A pointerup that finishes a
                   swipe still fires a click, and without this the viewer
                   would be thrown onto a details screen every time they
                   dragged the banner. */
                homeHero.suppressClick = false;
                return;
            }
            if (ev.target.closest && ev.target.closest(".ns-hhero-btn, .ns-hhero-dot, .ns-hhero-dots, .ns-hhero-arrow")) {
                return;
            }
            navigateToHeroItem(homeHero.items[homeHero.index]);
        });

        /* Drag to change slide. Pointer events cover mouse, pen and touch
           in one path. The gesture is only claimed once it passes
           HOME_HERO_DRAG_THRESHOLD horizontally, so a plain click on Play
           is never swallowed, and a vertical scroll gesture started over
           the banner still scrolls the page. */
        var drag = null;

        hero.addEventListener("pointerdown", function (ev) {
            if (ev.button !== 0 && ev.pointerType === "mouse") {
                return;
            }
            if (ev.target.closest && ev.target.closest(OPEN_MENU_SELECTOR)) {
                return;
            }
            /* Stale guard from an earlier gesture must never survive into
               a fresh, genuine click. */
            homeHero.suppressClick = false;
            if (ev.target.closest && ev.target.closest(".ns-hhero-btn, .ns-hhero-dot, .ns-hhero-arrow")) {
                return;
            }
            drag = { x: ev.clientX, y: ev.clientY, claimed: false };
        });

        hero.addEventListener("pointermove", function (ev) {
            if (!drag) {
                return;
            }
            var dx = ev.clientX - drag.x;
            var dy = ev.clientY - drag.y;

            if (!drag.claimed && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > HOME_HERO_DRAG_THRESHOLD) {
                drag.claimed = true;
                homeHero.suppressClick = true;
                hero.classList.add("ns-dragging");
                /* Dragging left pulls the next slide in from the right,
                   the way the content would move under your finger. */
                var step = dx < 0 ? 1 : -1;
                goToHomeHeroSlide(homeHero.index + step, step);
            }
        });

        function endDrag() {
            drag = null;
            hero.classList.remove("ns-dragging");
        }

        hero.addEventListener("pointerup", endDrag);
        hero.addEventListener("pointercancel", endDrag);
        /* Do NOT end a drag on pointerleave. The first Home rail overlaps
           the lower part of the hero and paints above it; moving from the
           artwork into that rail therefore changes the event target from
           the hero to a sibling. Ending here used to make the lower part
           of the banner feel like it could not be grabbed. Pointerup /
           pointercancel are the actual gesture boundaries. */

        /* Keyboard parity, active only while focus is actually inside the
           hero - so this never steals these keys from the rails below it.
           Enter/Space on the banner itself is the keyboard equivalent of
           clicking the artwork; on a control inside it, the browser's own
           button handling takes over and this never sees the key. */
        hero.addEventListener("keydown", function (ev) {
            if (ev.key === "ArrowLeft") {
                ev.preventDefault();
                goToHomeHeroSlide(homeHero.index - 1, -1);
            } else if (ev.key === "ArrowRight") {
                ev.preventDefault();
                goToHomeHeroSlide(homeHero.index + 1, 1);
            } else if ((ev.key === "Enter" || ev.key === " ") && ev.target === hero) {
                ev.preventDefault();
                navigateToHeroItem(homeHero.items[homeHero.index]);
            }
        });

    }

    /**
     * Document/window-level listeners for the hero, registered exactly
     * once for the lifetime of the page (not per hero instance): the hero
     * element itself is rebuilt every time jellyfin-web tears down and
     * remounts the Home page, and binding these alongside it would stack
     * a fresh duplicate on every remount. They read the live homeHero
     * state object instead of closing over any one instance.
     */
    var homeHeroGlobalsWired = false;
    var homeHeroOverlapDrag = null;

    /* The first Home rail deliberately overlaps the lower portion of the
       hero and is painted above it. That means a pointer pressed there is
       targeted at the rail, not at .ns-home-hero, even though the visible
       pixels underneath belong to the hero artwork. Handle only that
       overlap case at document level so the entire visual hero remains a
       continuous grab/swipe surface without stealing normal clicks from
       the rail. A gesture is not claimed until it crosses the same
       horizontal threshold used by the hero's own drag handler. */
    function wireHomeHeroOverlapDrag() {
        document.addEventListener("pointerdown", function (ev) {
            var hero = homeHero.root;
            if (!hero || !hero.isConnected) {
                return;
            }
            if (ev.button !== 0 && ev.pointerType === "mouse") {
                return;
            }
            if (hero.contains(ev.target)) {
                return;
            }

            /* If the click lands INSIDE an open menu, ignore it. It's for the menu. */
            if (ev.target.closest && ev.target.closest(OPEN_MENU_SELECTOR)) {
                return;
            }

            /* A three-dot/action-sheet/profile menu can be positioned
               anywhere - including squarely inside the hero's bounding
               rect, since the hero spans the full top of the home screen
               (behind the header and behind the poster row that visually
               overlaps its lower edge). A press here whose target is
               outside such a menu is the user dismissing that menu, not
               pressing on the hero - it must never be tracked as a
               potential hero press/drag, or finishOverlapDrag below can
               misread the matching pointerup as a plain hero click and
               navigate to the hero item's details screen instead of
               simply letting the menu close. */
            if (isOutsideClickForOpenMenu(ev.target)) {
                return;
            }

            var rect = hero.getBoundingClientRect();
            if (ev.clientX < rect.left || ev.clientX > rect.right ||
                ev.clientY < rect.top || ev.clientY > rect.bottom) {
                return;
            }

            /* Interactive hero controls are already handled by the hero's
               own listeners and must never be treated as an overlap drag. */
            if (ev.target.closest && ev.target.closest(".ns-hhero-btn, .ns-hhero-dot, .ns-hhero-arrow")) {
                return;
            }

            homeHeroOverlapDrag = {
                x: ev.clientX,
                y: ev.clientY,
                claimed: false,
                pointerId: ev.pointerId,
                target: ev.target
            };
        }, true);

        document.addEventListener("pointermove", function (ev) {
            var drag = homeHeroOverlapDrag;
            if (!drag || ev.pointerId !== drag.pointerId) {
                return;
            }

            var dx = ev.clientX - drag.x;
            var dy = ev.clientY - drag.y;

            if (!drag.claimed && Math.abs(dx) > Math.abs(dy) &&
                Math.abs(dx) > HOME_HERO_DRAG_THRESHOLD) {
                drag.claimed = true;
                homeHero.suppressClick = true;
                if (homeHero.root) {
                    homeHero.root.classList.add("ns-dragging");
                }

                var step = dx < 0 ? 1 : -1;
                goToHomeHeroSlide(homeHero.index + step, step);
            }
        }, true);

        function finishOverlapDrag(ev) {
            var drag = homeHeroOverlapDrag;
            if (!drag || (ev && ev.pointerId !== drag.pointerId)) {
                return;
            }

            /* A press in the hero's visually-overlapped area is still part
               of the hero even though the rail painted above it owns the
               actual DOM hit target.  If the pointer never crossed the
               horizontal drag threshold, treat it as a hero click -- but
               never steal a genuine click on a poster/card or one of the
               rail's interactive controls. */
            if (!drag.claimed && ev && ev.type === "pointerup") {
                var target = drag.target;
                var isRailCard = target && target.closest && target.closest(
                    ".card, button, a, input, select, textarea, [role=button], [tabindex]"
                );

                /* Belt-and-suspenders re-check: the menu-open guard on
                   pointerdown above stops this tracking object from ever
                   being created for a menu-dismiss press, but a menu can in
                   principle open asynchronously between this gesture's
                   pointerdown and its pointerup (e.g. a long-press-opened
                   menu). Re-checking here against the *release* target
                   costs nothing and closes that gap. */
                if (!isRailCard && isOutsideClickForOpenMenu(target)) {
                    isRailCard = true;
                }

                if (!isRailCard) {
                    homeHero.suppressClick = true;
                    navigateToHeroItem(homeHero.items[homeHero.index]);
                }
            }

            homeHeroOverlapDrag = null;
            if (homeHero.root) {
                homeHero.root.classList.remove("ns-dragging");
            }
        }

        document.addEventListener("pointerup", finishOverlapDrag, true);
        document.addEventListener("pointercancel", finishOverlapDrag, true);
    }

    function wireHomeHeroGlobals() {
        if (homeHeroGlobalsWired) {
            return;
        }
        homeHeroGlobalsWired = true;
        wireHomeHeroOverlapDrag();

        /* Tab away / minimise: stop advancing through slides nobody is
           looking at (they'd all be spent by the time the viewer is
           back). */
        document.addEventListener("visibilitychange", function () {
            if (document.hidden) {
                clearHomeHeroTimer();
            } else if (homeHero.root && homeHero.root.isConnected && !homeHero.paused) {
                scheduleHomeHeroAdvance();
            }
        });

        window.addEventListener("resize", function () {
            if (homeHero.root) {
                syncHomeHeroPull(homeHero.root);
            }
        });
    }

    /**
     * Immediate Home hero placeholder.
     *
     * The hero data request (and the IMDb/age-rating lookups that follow it)
     * can take several frames on a cold Jellyfin load. Mount the same full-
     * viewport geometry immediately, with placeholders positioned exactly
     * where the real hero's logo/title, metadata, synopsis, Play button,
     * arrows and carousel dots will appear. This prevents the page from
     * looking empty while the real hero is being assembled.
     */
    function buildHomeHeroSkeleton(container) {
        if (!container || !container.isConnected) {
            return null;
        }
        if (container.querySelector(":scope > .ns-home-hero, :scope > .ns-home-hero-skeleton")) {
            return container.querySelector(":scope > .ns-home-hero-skeleton");
        }

        var hero = document.createElement("section");
        hero.className = "ns-home-hero ns-home-hero-skeleton";
        hero.setAttribute("aria-hidden", "true");
        hero.style.setProperty("--ns-hhero-pull", "0px");

        var media = document.createElement("div");
        media.className = "ns-hhero-media ns-skeleton-media";
        var layer = document.createElement("div");
        layer.className = "ns-hhero-layer ns-visible";
        var image = document.createElement("div");
        image.className = "ns-hhero-layer-img ns-skeleton-shimmer";
        layer.appendChild(image);
        media.appendChild(layer);

        var shade = document.createElement("div");
        shade.className = "ns-hhero-shade ns-skeleton-shade";
        media.appendChild(shade);
        hero.appendChild(media);

        var body = document.createElement("div");
        body.className = "ns-hhero-body ns-skeleton-body";

        var logo = document.createElement("div");
        logo.className = "ns-skeleton-block ns-skeleton-logo";
        body.appendChild(logo);

        var meta = document.createElement("div");
        meta.className = "ns-skeleton-block ns-skeleton-meta";
        body.appendChild(meta);

        var synopsis = document.createElement("div");
        synopsis.className = "ns-skeleton-overview";
        synopsis.innerHTML =
            '<span class="ns-skeleton-block"></span>' +
            '<span class="ns-skeleton-block"></span>';
        body.appendChild(synopsis);

        var actions = document.createElement("div");
        actions.className = "ns-hhero-actions";
        var play = document.createElement("div");
        play.className = "ns-skeleton-block ns-skeleton-play";
        actions.appendChild(play);
        body.appendChild(actions);

        hero.appendChild(body);

        var prev = document.createElement("div");
        prev.className = "ns-hhero-arrow ns-hhero-prev ns-skeleton-control";
        var next = document.createElement("div");
        next.className = "ns-hhero-arrow ns-hhero-next ns-skeleton-control";
        hero.appendChild(prev);
        hero.appendChild(next);

        var dots = document.createElement("div");
        dots.className = "ns-hhero-dots ns-skeleton-dots";
        for (var i = 0; i < 5; i++) {
            var dot = document.createElement("span");
            dot.className = "ns-hhero-dot ns-skeleton-dot";
            dots.appendChild(dot);
        }
        hero.appendChild(dots);

        container.insertBefore(hero, container.firstChild);
        document.body.classList.add("ns-home-hero-active");
        syncHomeHeroPull(hero);

        [50, 250, 800].forEach(function (delay) {
            window.setTimeout(function () {
                if (hero.isConnected) {
                    syncHomeHeroPull(hero);
                }
            }, delay);
        });

        return hero;
    }

    function buildHomeHero(container, items) {
        /* jellyfin-web can leave a previously visited Home page mounted
           but hidden. Its hero is unreachable but still holds a full-
           viewport backdrop image in memory, and only one hero is ever
           the live one (the state object below is shared), so drop any
           earlier instance before mounting this one. */
        clearHomeHeroTimer();
        var stale = document.querySelectorAll(".ns-home-hero, .ns-home-hero-skeleton");
        for (var i = 0; i < stale.length; i++) {
            if (stale[i].parentNode) {
                stale[i].parentNode.removeChild(stale[i]);
            }
        }

        homeHero.skeleton = null;

        var hero = document.createElement("section");
        hero.className = "ns-home-hero";
        hero.dataset.nsHomeHero = "1";
        /* The banner as a whole opens the details screen, so it needs to be
           reachable and activatable without a mouse too - hence tabindex and
           a label saying what activating it does. Deliberately NOT
           role="button": this element contains real buttons (Play, the
           arrows, the dots), and a button is not allowed to contain
           interactive children - claiming that role would break how a screen
           reader exposes them. */
        hero.setAttribute("tabindex", "0");
        hero.setAttribute("aria-label", "Featured title - opens details");
        hero.style.setProperty("--ns-hhero-interval", HOME_HERO_INTERVAL_MS + "ms");

        var media = document.createElement("div");
        media.className = "ns-hhero-media";

        var layerA = document.createElement("div");
        layerA.className = "ns-hhero-layer";
        layerA.appendChild(makeHeroLayerImage());
        var layerB = document.createElement("div");
        layerB.className = "ns-hhero-layer";
        layerB.appendChild(makeHeroLayerImage());
        media.appendChild(layerA);
        media.appendChild(layerB);

        var shade = document.createElement("div");
        shade.className = "ns-hhero-shade";
        media.appendChild(shade);

        hero.appendChild(media);

        var body = document.createElement("div");
        body.className = "ns-hhero-body";
        hero.appendChild(body);

        watchShadeToTextBounds(shade, body, media);

        var prev = makeHeroButton("ns-hhero-arrow ns-hhero-prev", "Previous featured title", "chevron_left");
        var next = makeHeroButton("ns-hhero-arrow ns-hhero-next", "Next featured title", "chevron_right");
        /* The visible control is the icon; the label is for assistive
           tech only, so drop the text node the shared builder added. */
        var prevText = prev.querySelector(".ns-hhero-btn-text");
        if (prevText) { prev.removeChild(prevText); }
        var nextText = next.querySelector(".ns-hhero-btn-text");
        if (nextText) { next.removeChild(nextText); }
        hero.appendChild(prev);
        hero.appendChild(next);

        var dots = buildHomeHeroDots(items.length);
        hero.appendChild(dots);

        homeHero.root = hero;
        homeHero.items = items;
        homeHero.index = 0;
        homeHero.layers = [layerA, layerB];
        homeHero.activeLayer = 1; /* so the first render lands on layerA */
        homeHero.body = body;
        homeHero.dots = dots;
        homeHero.paused = false;
        /* A build that got this far worked, so the retry budget starts
           over: jellyfin-web remounts the Home page on every visit back to
           it, and each of those remounts needs its own fresh lookup. The
           cap only exists to stop a lookup that keeps coming back empty
           from repeating forever. */
        homeHero.attempts = 0;

        container.insertBefore(hero, container.firstChild);
        document.body.classList.add("ns-home-hero-active");

        wireHomeHeroInteractions(hero);
        syncHomeHeroPull(hero);
        /* jellyfin-web is still laying the page out on the frame the hero
           mounts in, so one measurement is not enough - re-measure a few
           times as the rails settle, then stop. */
        [50, 250, 800].forEach(function (delay) {
            window.setTimeout(function () {
                syncHomeHeroPull(hero);
            }, delay);
        });

        /* 0 = first paint: no previous slide to travel away from, so the
           banner simply appears rather than sliding in from one side. */
        renderHomeHeroSlide(0);
        scheduleHomeHeroAdvance();
    }

    /**
     * Entry point, called from the same start()/MutationObserver/
     * hashchange wiring as initDetailPage. Cheap on every pass once the
     * hero is mounted: a route check, a couple of DOM checks, and an
     * early return.
     */
    function initHomeHero() {
        try {
            var onHome = isHomeRouteHash(window.location.hash || "");

            /* Left Home (or the page was torn down under us) - stop the
               timer so it isn't still advancing slides against a hero
               nobody can see, and forget the mounted instance. */
            if (!onHome || (homeHero.root && !homeHero.root.isConnected)) {
                clearHomeHeroTimer();
                if (!onHome) {
                    return;
                }
                if (homeHero.root && !homeHero.root.isConnected) {
                    homeHero.root = null;
                    document.body.classList.remove("ns-home-hero-active");
                }
            }

            var container = getVisibleHomeContainer();
            if (!container) {
                return;
            }

            /* Paint the loading skeleton immediately. It is deliberately
               independent of ApiClient so even a cold Jellyfin startup gets
               visual feedback before the first data request can begin. */
            if (!container.querySelector(":scope > .ns-home-hero")) {
                homeHero.attempts = 0;
                homeHero.skeleton = buildHomeHeroSkeleton(container);
            }

            /* Already mounted in the container currently on screen: make
               sure the rotation is running (it is stopped whenever the
               viewer navigates away) and otherwise leave it alone. */
            if (homeHero.root && container.contains(homeHero.root)) {
                if (!homeHero.timer && !homeHero.paused) {
                    scheduleHomeHeroAdvance();
                }
                return;
            }

            if (container.querySelector(":scope > .ns-home-hero:not(.ns-home-hero-skeleton)")) {
                return;
            }
            if (homeHero.fetching) {
                return;
            }

            /* ApiClient isn't ready this early in the app's own startup on
               a cold load. That's not a failed attempt, just a too-early
               one - return without spending one of the tries below, and
               the next observer pass will pick it up. */
            if (!window.ApiClient) {
                return;
            }

            /* This function runs on every MutationObserver pass, so an
               empty or failing lookup must NOT be retried each time - that
               would be an unbounded stream of identical API calls for the
               rest of the session. A small budget instead: enough for a
               transient network blip to recover from, then it gives up and
               Home stays exactly as stock renders it. */
            if (homeHero.attempts >= HOME_HERO_MAX_ATTEMPTS) {
                return;
            }
            homeHero.attempts++;

            homeHero.fetching = true;
            fetchHomeHeroItems().then(function (items) {
                homeHero.fetching = false;

                if (!items || !items.length) {
                    /* Nothing with a usable landscape image - leave Home
                       exactly as stock renders it and remove the placeholder. */
                    if (homeHero.skeleton && homeHero.skeleton.parentNode) {
                        homeHero.skeleton.parentNode.removeChild(homeHero.skeleton);
                    }
                    homeHero.skeleton = null;
                    document.body.classList.remove("ns-home-hero-active");
                    return;
                }

                var target = getVisibleHomeContainer();
                if (!target || !isHomeRouteHash(window.location.hash || "")) {
                    return;
                }
                if (target.querySelector(":scope > .ns-home-hero:not(.ns-home-hero-skeleton)")) {
                    return;
                }

                /* Resolve all IMDb ratings AND age ratings before the hero
                   is mounted so the first metadata paint is complete
                   instead of adding either badge later. Requests are
                   cached and run in parallel, so this adds only the
                   slowest single lookup. */
                Promise.all(items.map(function (item) {
                    return Promise.all([resolveItemImdbRating(item), resolveItemAgeRating(item)]).then(function (results) {
                        item.__nsImdbRating = results[0];
                        item.__nsAgeRating = results[1];
                    });
                })).then(function () {
                    if (!target.isConnected || !isHomeRouteHash(window.location.hash || "")) {
                        return;
                    }
                    buildHomeHero(target, items);
                }, function () {
                    if (homeHero.attempts >= HOME_HERO_MAX_ATTEMPTS &&
                        homeHero.skeleton && homeHero.skeleton.parentNode) {
                        homeHero.skeleton.parentNode.removeChild(homeHero.skeleton);
                        homeHero.skeleton = null;
                        document.body.classList.remove("ns-home-hero-active");
                    }
                });
            }, function () {
                homeHero.fetching = false;
                if (homeHero.attempts >= HOME_HERO_MAX_ATTEMPTS &&
                    homeHero.skeleton && homeHero.skeleton.parentNode) {
                    homeHero.skeleton.parentNode.removeChild(homeHero.skeleton);
                    homeHero.skeleton = null;
                    document.body.classList.remove("ns-home-hero-active");
                }
            });
        } catch (err) {
            /* never let a hero hiccup interrupt the shared observer pass */
        }
    }

    var nsOpenTrackMenu = null;
    var nsTrackMenuPointerHandled = false;

    function setTrackMenuArrow(container, open) {
        if (!container) return;

        var arrowContainer = container.querySelector('.selectArrowContainer');
        if (!arrowContainer) return;

        /* Jellyfin can recreate/duplicate the arrow span while the track
           selector is being enhanced. Keep exactly ONE native Material Icons
           element in this selector. Never create a second icon. */
        var icons = arrowContainer.querySelectorAll('.material-icons');
        var icon = icons.length ? icons[0] : null;

        for (var i = 1; i < icons.length; i++) {
            icons[i].remove();
        }

        if (!icon) {
            icon = document.createElement('span');
            icon.className = 'selectArrow material-icons keyboard_arrow_down';
            icon.setAttribute('aria-hidden', 'true');
            arrowContainer.appendChild(icon);
        }

        icon.textContent = open ? 'keyboard_arrow_up' : 'keyboard_arrow_down';
        icon.classList.remove('keyboard_arrow_down', 'keyboard_arrow_up');
        icon.classList.add(open ? 'keyboard_arrow_up' : 'keyboard_arrow_down');
    }

    function normalizeTrackArrows(root) {
        (root || document).querySelectorAll('.ns-video-selectors .selectContainer:not(.selectSourceContainer) .selectArrowContainer').forEach(function (arrowContainer) {
            var icons = arrowContainer.querySelectorAll('.material-icons');
            var icon = icons.length ? icons[0] : null;

            for (var i = 1; i < icons.length; i++) {
                icons[i].remove();
            }

            if (!icon) {
                icon = document.createElement('span');
                icon.className = 'selectArrow material-icons keyboard_arrow_down';
                icon.setAttribute('aria-hidden', 'true');
                arrowContainer.appendChild(icon);
            }
        });
    }

    function closeTrackMenu() {
        if (!nsOpenTrackMenu) return;

        var menu = nsOpenTrackMenu.menu;
        var container = nsOpenTrackMenu.container;

        if (menu && menu.parentNode) {
            menu.parentNode.removeChild(menu);
        }
        if (container) {
            container.classList.remove('ns-track-menu-open');
            setTrackMenuArrow(container, false);
        }

        nsOpenTrackMenu = null;
    }

    function positionTrackMenu(menu, container) {
        var rect = container.getBoundingClientRect();
        var margin = 8;
        var viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        var viewportHeight = document.documentElement.clientHeight || window.innerHeight;
        var width = Math.min(rect.width, viewportWidth - margin * 2);
        var left = Math.min(Math.max(rect.left, margin), viewportWidth - width - margin);

        menu.style.width = width + 'px';
        menu.style.left = left + 'px';

        var menuHeight = Math.min(menu.scrollHeight, 360);
        var below = viewportHeight - rect.bottom;
        var above = rect.top;

        if (below < Math.min(260, menuHeight) && above > below) {
            menu.style.top = Math.max(margin, rect.top - menuHeight - margin) + 'px';
            menu.classList.add('ns-track-menu-above');
        } else {
            menu.style.top = Math.min(viewportHeight - menuHeight - margin, rect.bottom + margin) + 'px';
            menu.classList.remove('ns-track-menu-above');
        }
    }

    function openTrackMenu(select, container) {
        if (!select || select.disabled || !select.options || !select.options.length) return;

        if (nsOpenTrackMenu && nsOpenTrackMenu.select === select) {
            closeTrackMenu();
            return;
        }
        closeTrackMenu();

        var menu = document.createElement('div');
        menu.className = 'ns-track-menu';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', select.getAttribute('aria-label') || container.querySelector('.selectLabel')?.textContent || 'Track options');

        for (var i = 0; i < select.options.length; i++) {
            var option = select.options[i];
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'ns-track-menu-option';
            row.setAttribute('role', 'option');
            row.dataset.value = option.value;
            row.dataset.index = String(i);
            row.setAttribute('aria-selected', option.selected ? 'true' : 'false');

            var check = document.createElement('span');
            check.className = 'ns-track-menu-check material-icons';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = 'check';

            var text = document.createElement('span');
            text.className = 'ns-track-menu-text';
            text.textContent = option.textContent || '';

            row.appendChild(check);
            row.appendChild(text);

            row.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();

                var value = this.dataset.value;
                var changed = select.value !== value;
                select.value = value;

                if (changed) {
                    select.dispatchEvent(new Event('input', { bubbles: true }));
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }

                closeTrackMenu();
                try { select.focus({ preventScroll: true }); } catch (err) { select.focus(); }
            });

            menu.appendChild(row);
        }

        document.body.appendChild(menu);
        container.classList.add('ns-track-menu-open');
        setTrackMenuArrow(container, true);
        nsOpenTrackMenu = { menu: menu, select: select, container: container };
        positionTrackMenu(menu, container);

        var selected = menu.querySelector('.ns-track-menu-option[aria-selected="true"]');
        if (selected) selected.scrollIntoView({ block: 'nearest' });
    }

    function wireVideoSelectorArrows() {
        if (document.documentElement.dataset.nsVideoArrowWired === '1') return;
        document.documentElement.dataset.nsVideoArrowWired = '1';

        normalizeTrackArrows();

        /* Pointerdown is the ONLY mouse/touch toggle path. This prevents the
           normal click event from toggling the menu a second time and
           immediately closing it after it opens. */
        document.addEventListener('pointerdown', function (event) {
            var target = event.target;
            var container = target && target.closest ? target.closest('.selectContainer') : null;
            if (!container || container.classList.contains('selectSourceContainer')) return;

            var select = container.querySelector('select');
            if (!select || select.disabled) return;

            event.preventDefault();
            event.stopPropagation();
            nsTrackMenuPointerHandled = true;
            openTrackMenu(select, container);
        }, true);

        /* Suppress only the synthetic click that follows our pointerdown.
           This listener intentionally NEVER toggles the track menu. */
        document.addEventListener('click', function (event) {
            if (nsTrackMenuPointerHandled) {
                nsTrackMenuPointerHandled = false;
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);

        document.addEventListener('keydown', function (event) {
            var target = event.target;
            var container = target && target.closest ? target.closest('.selectContainer') : null;
            if (!container || container.classList.contains('selectSourceContainer')) return;

            var select = container.querySelector('select');
            if (!select || select.disabled) return;

            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                openTrackMenu(select, container);
            } else if (event.key === 'Escape' && nsOpenTrackMenu) {
                event.preventDefault();
                closeTrackMenu();
            }
        }, true);

        /* Clicking anywhere outside closes the custom menu. Clicking the
           selector itself is handled exclusively by pointerdown above, so it
           never reaches this branch as an outside click. */
        document.addEventListener('click', function (event) {
            if (!nsOpenTrackMenu) return;
            if (!nsOpenTrackMenu.menu.contains(event.target) && !nsOpenTrackMenu.container.contains(event.target)) {
                closeTrackMenu();
            }
        });

        document.addEventListener('change', function (event) {
            if (nsOpenTrackMenu && event.target === nsOpenTrackMenu.select) closeTrackMenu();
        }, true);

        window.addEventListener('resize', function () {
            normalizeTrackArrows();
            if (nsOpenTrackMenu) positionTrackMenu(nsOpenTrackMenu.menu, nsOpenTrackMenu.container);
        });
        window.addEventListener('scroll', function () {
            if (nsOpenTrackMenu) positionTrackMenu(nsOpenTrackMenu.menu, nsOpenTrackMenu.container);
        }, true);

        /* Jellyfin can rebuild track controls after this listener is installed. */
        var observer = new MutationObserver(function () {
            normalizeTrackArrows();
            if (nsOpenTrackMenu && !document.body.contains(nsOpenTrackMenu.container)) {
                nsOpenTrackMenu = null;
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function start() {
        // Capture phase + document level is deliberate: Jellyfin's own card
        // click handling can be bound either directly on the card/anchor or
        // delegated on an ancestor, and capture always runs before a
        // bubble-phase listener and before any listener bound to a
        // descendant node. Registering here - once, not per-card/per-rail -
        // guarantees onCardClick gets first refusal on every card click
        // anywhere in the app, so preventDefault/stopPropagation reliably
        // stops navigation on a not-yet-expanded card without needing to
        // know exactly where/how Jellyfin wires its own handler.
        document.addEventListener("click", onCardClick, true);
        wireVideoSelectorArrows();
        wireHomeHeroGlobals();

        wireUp(document);
        updateActivePill();
        initDetailPage();
        initHomeHero();

        var observer = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                if (mutations[i].addedNodes.length) {
                    wireUp(document);
                    updateActivePill();
                    initDetailPage();
                    initHomeHero();
                    break;
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('hashchange', function () {
            updateActivePill();
            initDetailPage();
            initHomeHero();
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();

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
