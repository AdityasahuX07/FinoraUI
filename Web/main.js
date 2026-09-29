/*!
 * FinoraUI - rail card expand-in-place
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
 *   <script defer src="/FinoraUI/main.js"></script>
 * (served by Api/FinoraUIController.cs). This file does not reimplement
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

    // React DOM heavily depends on exact parent-child relationships for unmounting/reordering.
    // FinoraUI moves elements around (e.g., in headers or footers), which breaks React's assumptions
    // and causes "NotFoundError: Failed to execute 'removeChild' on 'Node'". 
    // This patch intercepts those calls and prevents the crash.
    var originalRemoveChild = Node.prototype.removeChild;
    Node.prototype.removeChild = function(child) {
        if (child && child.parentNode !== this) {
            if (child.parentNode) {
                return originalRemoveChild.call(child.parentNode, child);
            }
            return child;
        }
        return originalRemoveChild.call(this, child);
    };

    var originalInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function(newNode, referenceNode) {
        if (referenceNode && referenceNode.parentNode !== this) {
            return this.appendChild(newNode);
        }
        return originalInsertBefore.call(this, newNode, referenceNode);
    };

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
     * Item detail screen (FinoraUI/Apple-TV-style hero)
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
     * from. TMDB, IMDb and Rotten Tomatoes all use the real logo artwork
     * (embedded inline/as base64 so the plugin stays a single
     * self-contained DLL with no separate image assets to ship/host).
     * RT ships FIVE marks, not one per side - the official Tomatometer
     * (critics) mark switches between Certified Fresh / Fresh / Rotten
     * and the Popcornmeter (audience) mark switches between Upright /
     * Spilled, matching RT's own rule (see rtCriticsIconHtml() and
     * rtAudienceIconHtml() below) instead of always showing one static
     * logo regardless of score.
     */
    var TMDB_LOGO_SRC = "data:image/webp;base64,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";
    var IMDB_LOGO_SRC = "data:image/webp;base64,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";

    var TMDB_ICON_HTML = '<img class="ns-badge-rating-logo ns-badge-rating-logo-tmdb" src="' + TMDB_LOGO_SRC + '" alt="TMDB" />';
    var IMDB_ICON_HTML = '<img class="ns-badge-rating-logo ns-badge-rating-logo-imdb" src="' + IMDB_LOGO_SRC + '" alt="IMDb" />';

    /**
     * Official Rotten Tomatoes badge artwork (Tomatometer critics seal x3,
     * Popcornmeter audience mark x2), bundled as raw SVG markup. Each is a
     * *template*: instantiateRtIconSvg() below gives every rendered copy
     * its own unique element ids before it is used, because these source
     * files reuse ids like "mask-2"/"path-1" internally and the page can
     * show the same badge (or two different ones that happen to reuse the
     * same id) many times over on a single row of posters - without this
     * step the browser would resolve every url(#mask-2)/xlink:href="#..."
     * reference to whichever copy happened to render first, breaking the
     * mask on every other copy.
     */
    var RT_CRITICS_FRESH_SVG_TEMPLATE = '<svg class="ns-rt-rating-logo ns-rt-critics-logo ns-rt-fresh-logo" aria-hidden="true" id="downloadable-svg" type="positive" viewBox="0 0 80 80" preserveAspectRatio="xMidYMid" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g transform="translate(1.33, 0)"><g transform="translate(0, 16.27)"><mask id="mask-2" fill="white"><polygon points="0.000109100102 0.246970954 77.0827837 0.246970954 77.0827837 63.7145228 0.000109100102 63.7145228"/></mask><path d="M77.0137759,27.0426556 C76.2423237,14.6741909 69.9521992,5.42041494 60.4876349,0.246970954 C60.5414108,0.548381743 60.273195,0.925145228 59.9678008,0.791701245 C53.7772614,-1.91634855 43.2753527,6.84780083 35.9365975,2.25825726 C35.9917012,3.90539419 35.6700415,11.940249 24.3515353,12.4063071 C24.0843154,12.4172614 23.9372614,12.1443983 24.1062241,11.9512033 C25.619917,10.2247303 27.1482158,5.85360996 24.9507054,3.5233195 C20.2446473,7.74041494 17.5117012,9.32746888 8.48829876,7.23319502 C2.71103734,13.2740249 -0.562655602,21.5419087 0.08,31.8413278 C1.39120332,52.86639 21.0848133,64.8846473 40.9165145,63.6471369 C60.746888,62.4106224 78.3253112,48.0677178 77.0137759,27.0426556" fill="#FA320A" mask="url(#mask-2)"/></g><path d="M40.8717012,11.4648963 C44.946722,10.49361 56.6678838,11.3702905 60.4232365,16.3518672 C60.6486307,16.6506224 60.3312863,17.2159336 59.9678008,17.0572614 C53.7772614,14.3492116 43.2753527,23.113361 35.9365975,18.5238174 C35.9917012,20.1709544 35.6700415,28.2058091 24.3515353,28.6718672 C24.0843154,28.6828216 23.9372614,28.4099585 24.1062241,28.2167635 C25.619917,26.4902905 27.1478838,22.1191701 24.9507054,19.7888797 C19.8243983,24.3827386 17.0453112,25.8589212 5.91900415,22.8514523 C5.55485477,22.753195 5.67900415,22.1679668 6.06639004,22.020249 C8.16929461,21.2165975 12.933444,17.6965975 17.4406639,16.1450622 C18.2987552,15.8499585 19.1541909,15.6209129 19.9890456,15.4878008 C15.02639,15.0443154 12.7893776,14.3541909 9.63286307,14.8302075 C9.28697095,14.8823237 9.05195021,14.479668 9.26639004,14.2034855 C13.5193361,8.7253112 21.3540249,7.07087137 26.1878838,9.98107884 C23.2082988,6.28912863 20.8743568,3.34473029 20.8743568,3.34473029 L26.4046473,0.203485477 C26.4046473,0.203485477 28.6894606,5.30821577 30.3518672,9.02340249 C34.4657261,2.94506224 42.119834,2.38406639 45.3536929,6.69676349 C45.5455602,6.95302905 45.3450622,7.31751037 45.0247303,7.30987552 C42.3926971,7.24580913 40.9434025,9.63983402 40.833527,11.4605809 L40.8717012,11.4648963" fill="#00912D"/></g></svg>';
    var RT_CRITICS_CERTIFIED_FRESH_SVG_TEMPLATE = '<svg class="ns-rt-rating-logo ns-rt-critics-logo ns-rt-certified-fresh-logo" aria-hidden="true" type="certified-text" viewBox="0 0 80 80" preserveAspectRatio="xMidYMid" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><polygon id="path-1" points="0.0156351792 0.00599348534 75.8047696 0.00599348534 75.8047696 15.619544 0.0156351792 15.619544"></polygon></defs><g id="Icons/Tomatometer-&amp;-AS/certified_fresh" stroke="none" stroke-width="1" fill="none" fill-rule="evenodd"><g id="Group-4"><rect id="Rectangle" fill="#000000" opacity="0" x="0" y="0" width="80" height="80"></rect><g id="RT_CertifiedFreshSeal_wTEXT_RGB" transform="translate(2.084691, 0.000000)"><g id="Group-3" transform="translate(0.000000, 64.364821)"><mask id="mask-2" fill="white"><use xlink:href="#path-1"></use></mask><g id="Clip-2"></g><path d="M75.705798,5.352443 C73.2779153,3.00325733 70.3517915,1.1676873 67.0944625,0.00599348534 C65.9692508,3.17863192 64.8669707,6.3562215 63.7878827,9.53824104 C63.7670358,9.59895765 63.6818241,9.63465798 63.5934853,9.61928339 C63.5794137,9.61667752 60.9052769,9.14892508 58.9451466,8.88156352 C58.8742671,9.66254072 58.784886,10.5550489 58.784886,10.5550489 C62.9149186,10.8164169 66.446645,12.8211075 68.5269055,15.5830619 C68.5915309,15.6557655 68.6926384,15.6518567 68.723127,15.574202 C69.4342671,12.7046254 69.6297068,9.64273616 69.2708795,6.55843648 C69.2734853,6.52560261 69.298241,6.50188925 69.3399349,6.49302932 C71.2815635,5.88273616 73.4290554,5.54892508 75.7138762,5.58306189 C75.8379153,5.59609121 75.8347883,5.47648208 75.705798,5.352443 M17.0199349,10.5550489 C12.8899023,10.8164169 9.3581759,12.8211075 7.27791531,15.5830619 C7.2132899,15.6557655 7.11192182,15.6518567 7.08143322,15.574202 C6.37029316,12.7046254 6.17511401,9.64273616 6.53394137,6.55843648 C6.5313355,6.52560261 6.5065798,6.50188925 6.46488599,6.49302932 C4.52299674,5.88273616 2.37576547,5.54892508 0.0909446254,5.58306189 C-0.0330944625,5.59609121 -0.0299674267,5.47648208 0.0990228013,5.352443 C2.52612378,3.00403909 5.45198697,1.16846906 8.70801303,0.0067752443 C9.83322476,3.17889251 10.934202,6.35648208 12.0132899,9.53824104 C12.0338762,9.59895765 12.1193485,9.63465798 12.2076873,9.61928339 C12.2222801,9.61667752 14.8674919,9.15309446 16.8596743,8.88104235 C16.9396743,9.7180456 17.0199349,10.5550489 17.0199349,10.5550489" id="Fill-1" fill="#3DAD55" mask="url(#mask-2)"></path></g><path d="M18.0307492,15.5460586 C18.1615635,16.3364169 18.0781759,16.8351792 17.5444951,17.379544 C17.1932248,17.7381107 16.7786319,17.9129642 16.2874267,17.9041042 C15.7959609,17.8957655 15.3500977,17.6885993 14.9573941,17.3034528 C14.5714658,16.925342 14.362215,16.490684 14.3437134,16 C14.3252117,15.5085342 14.4779153,15.0908143 14.8221498,14.7390228 C15.3086645,14.2428664 15.7104886,14.1771987 16.3932248,14.2115961 L16.3567427,12.6220195 C15.3047557,12.5506189 14.3874919,12.9078827 13.6242345,13.6867752 C12.9284691,14.3966124 12.5957003,15.2190228 12.605342,16.1607818 C12.6214984,17.0955049 12.9777199,17.9035831 13.687557,18.5993485 C14.3976547,19.2948534 15.2200651,19.6552443 16.1482736,19.6594545 C17.0762215,19.6638436 17.8848208,19.3073616 18.5803257,18.5975244 C19.4381759,17.722215 19.7829316,16.7223453 19.6148534,15.6117264 L18.0307492,15.5460586" id="Fill-4" fill="#0A0B09"></path><polyline id="Fill-5" fill="#0A0B09" points="21.9059283 13.7641694 21.2880782 12.7851466 23.8751792 11.1523127 23.082215 9.89550489 20.4948534 11.5278176 19.9437134 10.6548534 22.6697068 8.93446254 21.8457329 7.62892508 17.5364169 10.3481433 21.1468404 16.069316 25.4561564 13.3498371 24.6319218 12.0440391 21.9059283 13.7641694"></polyline><path d="M27.6763518,8.60820847 L26.8909446,8.87765472 L26.3749837,7.37094463 L27.1603909,7.10175896 C27.9270358,6.83882736 28.3309446,6.94540717 28.5063192,7.45667752 C28.6845603,7.9770684 28.4067752,8.3580456 27.6763518,8.60820847 Z M30.1740717,6.90553746 C29.6859935,5.48091205 28.4310098,5.03400651 26.7601303,5.60651466 L24.2126384,6.47921824 L26.4057329,12.8802606 L28.0677524,12.3103583 L27.3886645,10.3293811 L28.0461238,10.1037134 L29.9028013,11.6815635 L31.8110749,11.0274919 L29.6685342,9.2114658 C30.3163518,8.57120521 30.4839088,7.8095114 30.1740717,6.90553746 L30.1740717,6.90553746 Z" id="Fill-6" fill="#0A0B09"></path><polyline id="Fill-7" fill="#0A0B09" points="36.4114658 3.68677524 31.017329 4.33745928 31.2023453 5.87022801 33.0225407 5.65055375 33.6476873 10.8338762 35.4011726 10.6225407 34.7760261 5.43895765 36.5962215 5.21954397 36.4114658 3.68677524"></polyline><polyline id="Fill-8" fill="#0A0B09" points="38.5920521 10.5331596 40.3460586 10.6287948 40.7153094 3.87335505 38.9613029 3.77745928 38.5920521 10.5331596"></polyline><polyline id="Fill-9" fill="#0A0B09" points="47.9765472 6.81381107 48.3392834 5.31283388 43.7042345 4.19335505 42.1154397 10.7702932 43.8230619 11.1825407 44.4078176 8.7619544 47.1194788 9.41732899 47.4684039 7.97211726 44.7570033 7.31726384 45.0493811 6.10684039 47.9765472 6.81381107"></polyline><polyline id="Fill-10" fill="#0A0B09" points="50.7361564 6.26918567 48.025798 12.4682736 49.6351792 13.1718567 52.345798 6.97276873 50.7361564 6.26918567"></polyline><polyline id="Fill-11" fill="#0A0B09" points="53.5934853 13.6325733 54.2454723 12.6751792 56.7744625 14.3971336 57.6109446 13.1679479 55.0819544 11.4465147 55.6630619 10.5923127 58.3278176 12.4065147 59.1971336 11.1301629 54.9844951 8.26241042 51.1765472 13.855114 55.3891857 16.7233876 56.2585016 15.4465147 53.5934853 13.6325733"></polyline><path d="M61.6307492,18.2759609 C60.7007166,19.1179153 59.7623453,19.0170684 58.8169381,17.9721173 L58.499544,17.6213681 L61.225798,15.153355 L61.5366775,15.4970684 C62.4885993,16.5490554 62.5180456,17.4728339 61.6307492,18.2759609 Z M63.9919218,16.9584365 C63.8712704,16.0914658 63.4780456,15.3407166 62.830228,14.6254072 L61.1916612,12.8148534 L56.1758958,17.35557 L57.8144625,19.1658632 C59.0386971,20.5180456 60.9128339,21.3084039 62.8161564,19.5851466 C63.7248208,18.7627362 64.1130945,17.8254072 63.9919218,16.9584365 L63.9919218,16.9584365 Z" id="Fill-12" fill="#0A0B09"></path><line x1="41.5309446" y1="22.4484691" x2="41.1658632" y2="22.4247557" id="Fill-13" fill="#DB382A"></line><path d="M68.7674267,65.3708143 C68.727557,65.3443036 68.6874267,65.3177929 68.6472964,65.291672 C68.72443,65.3415746 68.7676873,65.3704245 68.7676873,65.3704245 M67.3951792,64.534557 C67.295114,64.4791964 67.1950489,64.4246155 67.0944625,64.3708143 C67.1958306,64.4246155 67.2964169,64.4795863 67.3951792,64.534557" id="Fill-14" fill="#79C08D"></path><path d="M63.7878827,73.9030619 C64.8291857,70.8364821 66.0099023,67.4285342 67.0944625,64.3708143 C67.1950489,64.4067752 67.295114,64.4432573 67.3951792,64.4802606 C67.9421498,64.6845603 68.4297068,64.8917264 68.6472964,64.9863192 C68.6874267,65.0037785 68.727557,65.0214984 68.7674267,65.0392182 L63.7878827,73.9030619" id="Fill-15" fill="#0EA248"></path><path d="M7.03791531,65.0389577 L7.03791531,65.0389577 C7.03791531,65.0389577 7.04990228,65.0334853 7.07283388,65.0235831 C7.06136808,65.0285342 7.04938111,65.0337459 7.03791531,65.0389577" id="Fill-16" fill="#79C08D"></path><path d="M12.0083388,73.8887296 L7.03791531,65.0389577 C7.04938111,65.0337459 7.06136808,65.0285342 7.07283388,65.0235831 C7.23335505,64.9532248 7.92703583,64.6540717 8.70540717,64.3726384 C9.78684039,67.4220195 10.9667752,70.8224104 12.0059935,73.8814332 C12.0067752,73.8837785 12.007557,73.8863844 12.0083388,73.8887296" id="Fill-17" fill="#0EA248"></path><path d="M58.784886,74.9198697 L58.9451466,73.2463844 C58.8745277,74.0247557 58.7856678,74.9138762 58.784886,74.9198697 M63.6143322,73.9867101 C63.6072964,73.9861889 63.6005212,73.9851466 63.5934853,73.9841042 C63.5851466,73.9825407 62.6319218,73.8157655 61.4480782,73.6247557 C62.1766775,73.7409772 62.9031922,73.8624104 63.6143322,73.9867101" id="Fill-18" fill="#309E53"></path><path d="M58.784886,74.9198697 L58.784886,74.9198697 C58.7856678,74.9138762 58.8745277,74.0247557 58.9451466,73.2463844 C59.7680782,73.3636482 60.6095114,73.4908143 61.4480782,73.6247557 C62.6319218,73.8157655 63.5851466,73.9825407 63.5934853,73.9841042 C63.6005212,73.9851466 63.6072964,73.9861889 63.6143322,73.9867101 C63.6158958,73.9869707 63.6177199,73.9872313 63.619544,73.9877524 L58.784886,74.9198697" id="Fill-19" fill="#129346"></path><path d="M12.1876221,73.9867101 C12.8531596,73.870228 13.5325081,73.7563518 14.214202,73.6469055 C13.0923779,73.8290554 12.2160261,73.9825407 12.2076873,73.9841042 C12.2009121,73.9851466 12.1943974,73.9859283 12.1876221,73.9867101" id="Fill-20" fill="#309E53"></path><path d="M17.0199349,74.9198697 L12.1821498,73.9877524 C12.1839739,73.9872313 12.185798,73.9869707 12.1876221,73.9867101 C12.1943974,73.9859283 12.2009121,73.9851466 12.2076873,73.9841042 C12.2160261,73.9825407 13.0923779,73.8290554 14.214202,73.6469055 C15.1001954,73.5046254 15.9903583,73.3696417 16.8596743,73.2458632 C16.8797394,73.455114 16.8998046,73.6643648 16.9185668,73.8605863 C16.937329,74.0568078 16.9547883,74.24 16.9699023,74.396873 C16.9847557,74.5537459 16.9972638,74.6845603 17.0061238,74.7760261 C17.0149837,74.8677524 17.0199349,74.9198697 17.0199349,74.9198697" id="Fill-21" fill="#129346"></path><path d="M63.3170033,59.0499023 C62.9482736,58.9943974 62.579544,58.9414984 62.2105537,58.8883388 C65.7592182,54.685342 67.980456,49.4113355 68.1550489,43.3412378 C68.3291205,49.3996091 66.4932899,54.7213029 63.3170033,59.0499023" id="Fill-22" fill="#ADADAA"></path><path d="M12.0786971,59.1114007 C9.53198697,55.5046254 7.90514658,51.1632573 7.59400651,46.1766775 C7.53250814,45.1887948 7.51166124,44.2069055 7.53537459,43.2343974 C7.54631922,43.6922476 7.56534202,44.1514007 7.59400651,44.6118567 C7.9465798,50.2647557 9.98905537,55.0892508 13.147101,58.9534853 C12.7908795,59.0056026 12.4343974,59.0569381 12.0786971,59.1114007" id="Fill-23" fill="#ADADAA"></path><path d="M43.2320521,68.4367427 C43.4618893,68.5018893 43.7167427,68.5401954 43.9953094,68.5511401 C43.7422801,68.5112704 43.4876873,68.4732248 43.2320521,68.4367427" id="Fill-24" fill="#E3662A"></path><path d="M9.84912052,59.4704886 C9.2570684,58.7447557 8.68925081,57.9958306 8.15061889,57.2208469 C3.93771987,51.1583062 1.71074919,44.0364821 1.71074919,36.624886 C1.71074919,27.0684039 5.45928339,18.2353094 12.265798,11.7529642 C19.0102932,5.32977199 28.0948534,1.7923127 37.8465147,1.7923127 C47.5981759,1.7923127 56.6829967,5.32977199 63.4274919,11.7529642 C70.2337459,18.2353094 73.9822801,27.0684039 73.9822801,36.624886 C73.9822801,44.0078176 71.7712052,51.1069707 67.588013,57.1551792 C67.0402606,57.9473616 66.4609772,58.7119218 65.8574593,59.4530293 C66.4792182,59.5562215 67.1001954,59.6633225 67.7206515,59.7735505 C72.6842997,53.3771987 75.6442997,45.3482736 75.6442997,36.624886 C75.6442997,15.7500977 58.7215635,0.13029316 37.8465147,0.13029316 C16.9714658,0.13029316 0.048990228,15.7500977 0.048990228,36.624886 C0.048990228,45.356873 3.01472313,53.3930945 7.98697068,59.7925733 C8.60716612,59.6818241 9.22762215,59.574202 9.84912052,59.4704886" id="Fill-25" fill="#E3662A"></path><path d="M64.2337459,62.9756352 L64.1284691,62.9756352 L64.1284691,62.7778502 L64.2337459,62.7778502 C64.3387622,62.7778502 64.3929642,62.8096417 64.3929642,62.8734853 C64.3929642,62.940456 64.3387622,62.9756352 64.2337459,62.9756352" id="Fill-26" fill="#E3662A"></path><path d="M64.2337459,62.7778502 L64.1284691,62.7778502 L64.1284691,62.9756352 L64.2337459,62.9756352 C64.3387622,62.9756352 64.3929642,62.940456 64.3929642,62.8734853 C64.3929642,62.8096417 64.3387622,62.7778502 64.2337459,62.7778502" id="Fill-27" fill="#128843"></path><path d="M21.2727036,64.5420195 C20.7210423,64.5420195 20.2300977,64.9641694 20.2300977,65.5455375 C20.2300977,66.1203909 20.7210423,66.5378502 21.2727036,66.5378502 C21.8418241,66.5378502 22.3153094,66.1388925 22.3153094,65.5455375 C22.3153094,64.9547883 21.8332248,64.5420195 21.2727036,64.5420195" id="Fill-28" fill="#128843"></path><path d="M55.1890554,64.2624104 C54.7020195,64.2624104 54.3598697,64.5649511 54.2676221,64.9993485 L56.0706189,64.9993485 C56.0312704,64.5779805 55.7284691,64.2624104 55.1890554,64.2624104" id="Fill-29" fill="#128843"></path><path d="M64.3898371,63.3897068 L64.236873,63.1700326 L64.1284691,63.1700326 L64.1284691,63.3897068 L63.9119218,63.3897068 L63.9119218,62.5899674 L64.2717915,62.5899674 C64.4630619,62.5899674 64.612899,62.6824756 64.612899,62.8734853 C64.612899,62.997785 64.5586971,63.0840391 64.4471661,63.1348534 L64.6353094,63.3897068 L64.3898371,63.3897068 Z M64.2337459,62.3572638 C64.0583713,62.3572638 63.9085342,62.4211075 63.7876221,62.5485342 C63.6664495,62.6728339 63.6059935,62.8291857 63.6059935,63.0105537 C63.6059935,63.1921824 63.6664495,63.3451466 63.7876221,63.4694463 C63.9085342,63.5937459 64.0583713,63.6544625 64.2337459,63.6544625 C64.4122476,63.6544625 64.5618241,63.5937459 64.6829967,63.4694463 C64.8072964,63.3451466 64.8677524,63.1921824 64.8677524,63.0105537 C64.8677524,62.8291857 64.8072964,62.6728339 64.6829967,62.5485342 C64.5618241,62.4211075 64.4122476,62.3572638 64.2337459,62.3572638 L64.2337459,62.3572638 Z" id="Fill-30" fill="#128843"></path><path d="M29.7581759,59.68443 C30.0711401,59.6779153 30.2340065,60.5904886 31.0314007,60.5485342 C31.3897068,60.529772 31.5801954,60.0849511 31.3980456,59.7761564 L31.3938762,59.7691205 C31.2351792,59.5082736 30.9878827,59.4092508 30.7067101,59.36 C30.5128339,59.3261238 30.3147883,59.3076221 30.1352443,59.2171987 C30.0401303,59.1689902 29.9812378,59.0952443 29.9812378,58.9824104 C29.9812378,58.8661889 30.027101,58.7799349 30.1323779,58.7267752 C30.2871661,58.6488599 30.4536808,58.6530293 30.620456,58.6517264 C30.7366775,58.6509446 30.8440391,58.6220195 30.9334202,58.5396743 C31.1325081,58.3562215 31.174202,58.0203257 31.04443,57.7761564 C30.8802606,57.4678827 30.5263844,57.4327036 30.2717915,57.5932248 C30.0943322,57.7050163 30.0312704,57.8824756 29.9833225,58.0737459 C29.9504886,58.2042997 29.8699674,58.4104235 29.6018241,58.4002606 C29.397785,58.392443 29.290684,58.190228 29.3279479,57.9895765 C29.36,57.8168078 29.421759,57.6638436 29.4446906,57.4895114 C29.4699674,57.2985016 29.4407818,57.1192182 29.290684,56.9852769 C29.1783713,56.8852117 29.0407818,56.8388274 28.8870358,56.8560261 C28.8870358,56.8560261 28.5000651,56.8682736 28.3682085,57.2109446 C28.2071661,57.6291857 28.4732248,57.7610423 28.6618893,57.9142671 C28.7676873,58.0005212 28.8763518,58.0883388 28.9172638,58.229316 C28.948013,58.3353746 28.9209121,58.4515961 28.8390879,58.5044951 C28.7283388,58.5761564 28.5586971,58.563127 28.4349186,58.4588925 C28.2910749,58.3377199 28.2462541,58.0469055 27.9656026,57.9374593 C27.7313355,57.8459935 27.4246254,57.9309446 27.3201303,58.1394137 C27.1812378,58.4174593 27.3586971,58.6767427 27.6591531,58.7979153 C27.8290554,58.8661889 28.3932248,58.8904235 28.3632573,59.1757655 C28.3371987,59.4235831 27.8287948,59.2281433 27.6005212,59.3128339 C27.2351792,59.4483388 27.2203257,59.8040391 27.3024104,59.9887948 C27.4191531,60.2514658 27.7477524,60.335114 27.9843648,60.2272313 C28.2459935,60.1081433 28.468013,59.5736808 28.7413681,59.7104886 C29.0019544,59.8407818 28.7478827,60.1472313 28.7348534,60.4469055 C28.723127,60.7140065 28.9107492,60.975114 29.3605212,60.9292508 C29.6312704,60.9018893 29.8624104,60.5774593 29.7060586,60.2905537 C29.661759,60.2092508 29.5911401,60.0781759 29.5658632,59.9890554 C29.5197394,59.8267101 29.6247557,59.6870358 29.7581759,59.68443" id="Fill-31" fill="#128843"></path><path d="M37.5593485,64.674658 C37.2672313,64.674658 37.0209772,64.7778502 36.8474267,64.9730293 C36.694202,65.1455375 36.609772,65.3764169 36.609772,65.6239739 C36.609772,66.2472964 37.0876873,66.5735505 37.5593485,66.5735505 C37.8514658,66.5735505 38.0977199,66.4703583 38.2712704,66.2749186 C38.4244951,66.102671 38.5089251,65.8715309 38.5089251,65.6239739 C38.5089251,65.0006515 38.0312704,64.674658 37.5593485,64.674658" id="Fill-32" fill="#128843"></path><path d="M64.8518567,63.6320521 C64.6829967,63.8009121 64.4758306,63.8869055 64.2337459,63.8869055 C63.9914007,63.8869055 63.7876221,63.8009121 63.6185016,63.6320521 C63.4530293,63.4598046 63.3701629,63.2526384 63.3701629,63.0105537 C63.3701629,62.7650814 63.4530293,62.5579153 63.6185016,62.3859283 C63.7876221,62.2139414 63.9914007,62.1279479 64.2337459,62.1279479 C64.4758306,62.1279479 64.6829967,62.2139414 64.8518567,62.3859283 C65.0207166,62.5579153 65.1069707,62.7650814 65.1069707,63.0105537 C65.1069707,63.2526384 65.0207166,63.4598046 64.8518567,63.6320521 Z M62.6241042,68.0899023 C62.1576547,68.4745277 61.5444951,68.6704886 60.8028664,68.6704886 C59.8413029,68.6704886 59.0616287,68.4687948 58.3637785,68.0114658 L58.2319218,67.9184365 L59.1418893,66.4169381 C60.1868404,67.0869055 60.7267752,66.9865798 60.9326384,66.970684 C61.3847557,66.9357655 61.4337459,66.4357003 61.0598046,66.4445603 C60.7723779,66.4510749 60.2048208,66.510228 59.363127,66.1183062 C58.7744625,65.7579153 58.3906189,65.3383713 58.3906189,64.6459935 C58.3906189,64.0482085 58.6389577,63.5588274 59.1288599,63.1914007 C59.5997394,62.8383062 60.0500326,62.6428664 60.7215635,62.6118567 C61.5921824,62.5717264 62.2228013,62.7611726 63.0045603,63.1635179 L63.1692508,63.2729642 L62.3390228,64.6407818 C61.4295765,64.2764821 60.9581759,64.1771987 60.6282736,64.2402606 C60.2418241,64.3137459 60.2975896,64.6887296 60.582671,64.7267752 C60.8677524,64.7645603 61.3229967,64.6420847 62.1805863,64.9464495 C62.9250814,65.2437785 63.3672964,65.7276873 63.3672964,66.5527036 C63.3672964,67.1760261 63.1171336,67.6930293 62.6241042,68.0899023 Z M58.068013,66.1008469 L54.2676221,66.1008469 C54.3734202,66.5592182 54.8810423,66.8179805 55.3514007,66.8179805 C55.9041042,66.8179805 56.3108795,66.7484039 56.6029967,66.3635179 L57.9908795,67.669316 C57.2281433,68.4813029 56.2738762,68.6407818 55.375114,68.6407818 C54.4813029,68.6407818 53.740456,68.3702932 53.1523127,67.8410423 C52.56443,67.3120521 52.2704886,66.5829316 52.2704886,65.6656678 C52.2704886,64.7601303 52.5409772,64.0310098 53.0936808,63.4665798 C53.6463844,62.8901629 54.3637785,62.6079479 55.2338762,62.6079479 C56.1394137,62.6079479 56.8450814,62.8901629 57.3388925,63.4665798 C57.8327036,64.0427362 58.0797394,64.7364169 58.0797394,65.5598697 L58.068013,66.1008469 Z M49.4499023,68.5089251 C47.828013,68.9003257 46.0239739,68.1936156 45.6088599,66.4740065 C45.3159609,65.260456 45.7563518,64.2767427 46.590228,63.6336156 C46.6699674,63.5684691 46.769772,63.5054072 46.8367427,63.482215 C46.4198046,63.5179153 46.1678176,63.497329 45.9137459,63.5828013 C45.8858632,63.5921824 45.8605863,63.562215 45.8743974,63.5361564 C46.1461889,63.0212378 46.7700326,62.7700326 47.211987,62.940456 C46.9117915,62.6783062 46.6759609,62.4690554 46.6759609,62.4690554 L47.0874267,62.1287296 C47.0874267,62.1287296 47.3508795,62.5175244 47.5424104,62.8005212 C47.7941368,62.2376547 48.4187622,62.0797394 48.7491857,62.389316 C48.7687296,62.407557 48.7575244,62.4406515 48.7309446,62.4448208 C48.5123127,62.4779153 48.4317915,62.7046254 48.4492508,62.8568078 L48.6389577,62.8330945 C50.1917915,62.6342671 51.5278176,63.4076873 51.9012378,64.9553094 C52.3163518,66.6749186 51.0717915,68.1172638 49.4499023,68.5089251 Z M45.1570033,68.5276873 L45.024886,68.5334202 C44.7937459,68.5433225 44.4849511,68.5566124 44.1641694,68.5566124 C42.6423453,68.5566124 41.7693811,67.7928339 41.7693811,66.3145277 L41.7693811,64.7312052 L41.1768078,64.7312052 L41.1768078,62.7572638 L41.7693811,62.7572638 L41.7693811,61.1958306 L44.0398697,61.1958306 L44.0398697,62.7572638 L44.9355049,62.7572638 L44.9355049,64.7312052 L44.0398697,64.7312052 L44.0398697,66.1662541 C44.0398697,66.4448208 44.1589577,66.5639088 44.4375244,66.5639088 L45.1570033,66.5639088 L45.1570033,68.5276873 Z M40.7403257,68.4841694 L38.541759,68.4841694 L38.541759,67.8410423 L38.3989577,67.9940065 C38.0036482,68.4171987 37.5067101,68.6407818 36.9610423,68.6407818 C36.570684,68.6407818 36.1615635,68.5235179 35.7777199,68.3014984 C34.9211726,67.8063844 34.4104235,66.803127 34.4109442,65.618241 C34.4114658,64.4385668 34.9224756,63.4397394 35.7777199,62.9464495 C36.1615635,62.7249511 36.5683388,62.6079479 36.9545277,62.6079479 C37.501759,62.6079479 38.0010423,62.8372638 38.3984365,63.2711401 L38.541759,63.4277524 L38.541759,62.769772 L40.7403257,62.769772 L40.7403257,68.4841694 Z M34.0291857,68.4914658 L31.7237785,68.4914658 L31.7237785,65.3792834 C31.7237785,64.8904235 31.5147883,64.6426059 31.1022801,64.6426059 C30.6918567,64.6426059 30.6095114,64.9000651 30.582671,64.9847557 C30.5117915,65.2385668 30.4998046,65.3834528 30.4998046,65.6912052 L30.4998046,68.4914658 L28.2277524,68.4914658 L28.2277524,65.3792834 C28.2277524,64.8904235 28.015114,64.6426059 27.5953094,64.6426059 C27.356873,64.6426059 27.2010423,64.7585668 27.1400651,64.8578502 C27.0970684,64.9224756 27.0647557,65.0394788 27.04443,65.1215635 C27.0037785,65.356873 27.0037785,65.4410423 27.0037785,65.6912052 L27.0037785,68.4914658 L24.7953094,68.4914658 L24.7953094,62.7572638 L26.9816287,62.7572638 L26.9800651,63.2961564 C27.135114,62.9800651 27.726645,62.6079479 28.5563518,62.6079479 C29.2393485,62.6079479 29.7837134,62.8427362 30.1300326,63.2867752 L30.1912704,63.3654723 L30.2574593,63.290684 C30.6704886,62.8231922 31.1439739,62.6235831 31.8410423,62.6235831 C32.4990228,62.6235831 34.0291857,62.8727036 34.0291857,65.1783713 L34.0291857,68.4914658 Z M21.3141368,68.6407818 C19.6484691,68.6407818 18.1315961,67.6036482 18.1315961,65.6244951 C18.1315961,64.0471661 19.0647557,63.0681433 20.3207818,62.7356352 C21.0186319,62.5831922 21.436873,62.5589577 22.1957003,62.708013 C23.5025407,63.0108143 24.4135505,64.0005212 24.4135505,65.6244951 C24.4135505,67.6036482 22.9800651,68.6407818 21.3141368,68.6407818 Z M16.9355049,68.4914658 L14.7226059,68.4914658 L14.7226059,63.1403257 L12.7734202,63.1403257 L12.7734202,60.9639088 L18.8849511,60.9639088 L18.8849511,63.1403257 L16.9355049,63.1403257 L16.9355049,68.4914658 Z M68.4810423,59.9077524 C63.3970033,58.9790228 58.2655375,58.2889902 53.1114007,57.829316 C53.1411075,58.0299674 53.1580456,58.2433876 53.1580456,58.4719218 L53.1580456,61.7779805 L50.8714007,61.7779805 L50.8714007,58.6613681 C50.8714007,58.1811075 50.6639739,57.9374593 50.255114,57.9374593 C49.8264495,57.9374593 49.5609121,58.1180456 49.5609121,59.0175896 L49.5609121,61.7779805 L47.2716612,61.7779805 L47.2716612,57.4063844 C47.1421498,57.3993485 47.012899,57.3915309 46.8833876,57.3847557 C46.8859935,57.4413029 46.8899023,57.4968078 46.8899023,57.5543974 L46.8781759,58.0953746 L43.077785,58.0953746 C43.1835831,58.5540065 43.6912052,58.8127687 44.1615635,58.8127687 C44.7142671,58.8127687 45.1210423,58.7431922 45.4131596,58.3580456 L46.8010423,59.6641042 C46.0383062,60.4760912 45.0840391,60.63557 44.1852769,60.63557 C43.2914658,60.63557 42.5506189,60.3650814 41.9624756,59.8358306 C41.3745928,59.3065798 41.0806515,58.5777199 41.0806515,57.660456 C41.0806515,57.4944625 41.092899,57.3368078 41.1111401,57.1828013 C40.9610423,57.1799349 40.8112052,57.1770684 40.6611075,57.1744625 L40.6611075,58.022671 L39.7662541,58.022671 L39.7662541,59.4564169 C39.7662541,59.7349837 39.8850814,59.8538111 40.1636482,59.8538111 L40.8823453,59.8538111 L40.8823453,61.8157655 L40.750228,61.8214984 C40.5196091,61.8311401 40.2110749,61.84443 39.8902932,61.84443 C38.369772,61.84443 37.4978502,61.0816938 37.4978502,59.60443 L37.4978502,58.022671 L36.9055375,58.022671 L36.9055375,57.1541368 C36.7590879,57.1549186 36.6126384,57.1572638 36.4661889,57.1585668 L36.4661889,58.0185016 L35.5715961,58.0185016 L35.5715961,59.4522476 C35.5715961,59.7305537 35.6904235,59.8493811 35.9689902,59.8493811 L36.6874267,59.8493811 L36.6874267,61.8115961 L36.55557,61.8170684 C36.3246906,61.8269707 36.0161564,61.8402606 35.6956352,61.8402606 C34.175114,61.8402606 33.3029316,61.0772638 33.3029316,59.6002606 L33.3029316,58.0185016 L32.7108795,58.0185016 L32.7108795,57.2278827 C32.5013681,57.2341368 32.2918567,57.2429967 32.0823453,57.2500326 C32.3486645,57.6966775 32.5011075,58.2499023 32.5011075,58.9097068 C32.5011075,60.8880782 31.1262541,61.9246906 29.3573941,61.9246906 C27.5887948,61.9246906 26.1308143,60.8880782 26.1308143,58.9097068 C26.1308143,58.3864495 26.2353094,57.9304235 26.4185016,57.5405863 C26.2801303,57.5497068 26.141759,57.5588274 26.0033876,57.5684691 C25.8621498,58.2170684 25.5009772,58.7218241 24.922215,59.0717915 L24.8508143,59.1150489 L26.4375244,61.7779805 L23.8707492,61.7779805 L22.4416938,59.3355049 L22.0622801,59.3355049 L22.0622801,61.7779805 L19.7829316,61.7779805 L19.7829316,58.1123127 C15.6062541,58.556873 11.447557,59.1538762 7.32013029,59.9077524 C7.2114658,59.927557 7.14032573,59.9992182 7.16403909,60.0643648 C8.82918567,64.667101 10.4456026,69.28 12.0132899,73.9030619 C12.0338762,73.9637785 12.1193485,73.9994788 12.2076873,73.9841042 C29.1460586,71.0155049 46.655114,71.0155049 63.5934853,73.9841042 C63.6818241,73.9994788 63.7670358,73.9637785 63.7878827,73.9030619 C65.35557,69.28 66.971987,64.667101 68.6371336,60.0643648 C68.6608469,59.9992182 68.5894463,59.927557 68.4810423,59.9077524 L68.4810423,59.9077524 Z" id="Fill-33" fill="#128843"></path><path d="M42.6157655,18.1912704 C44.8229316,17.9937459 49.6492508,18.1055375 52.0046906,20.4166775 C52.1461889,20.5553094 52.0244951,20.8760912 51.821759,20.8213681 C48.3708143,19.8908143 42.9850163,24.4719218 39.4939414,21.5095765 C39.3970033,22.3760261 38.6157655,26.5573941 32.6556352,25.9377199 C32.514658,25.923127 32.4586319,25.7688599 32.5618241,25.6807818 C33.4858632,24.8925081 34.6191531,22.7210423 33.6469055,21.3336808 C30.612899,23.3472313 29.0457329,23.4340065 23.4512052,21.0108143 C23.268013,20.9315961 23.3777199,20.6347883 23.5919218,20.5868404 C24.7538762,20.3265147 27.5160912,19.3214332 29.9940065,18.8534202 C30.4654072,18.7642997 30.9305537,18.7095765 31.3777199,18.7038436 C28.8140717,18.0930293 27.6958958,17.5609121 26.0072964,17.5692508 C25.8222801,17.5702932 25.729772,17.3414984 25.8631922,17.2132899 C28.5073616,14.670228 33.299544,14.5414984 35.607557,16.4338762 L33.5398046,12.1138762 L36.0531596,11.7355049 C36.0531596,11.7355049 36.7087948,14.0390879 37.2956352,16.1104886 C39.912443,13.2427362 43.9619544,13.5330293 45.3256026,16.0372638 C45.406645,16.1860586 45.2737459,16.3616938 45.1067101,16.3330293 C43.7339414,16.0987622 42.792443,17.2414332 42.5962215,18.1863192 L42.6157655,18.1912704" id="Fill-34" fill="#128843"></path><path d="M43.9992182,56.2569381 C43.5121824,56.2569381 43.1700326,56.5594788 43.077785,56.9938762 L44.8807818,56.9938762 C44.8414332,56.5727687 44.5386319,56.2569381 43.9992182,56.2569381" id="Fill-35" fill="#DB382A"></path><path d="M23.7532248,56.7710749 C23.7532248,56.3064495 23.3441042,56.0059935 22.7108795,56.0059935 L22.0570684,56.0059935 L22.0570684,57.5916612 L22.7108795,57.5916612 C23.3732899,57.5916612 23.7532248,57.2925081 23.7532248,56.7710749" id="Fill-36" fill="#DB382A"></path><path d="M11.1293811,33.5176547 L20.3220847,33.5176547 L20.3220847,36.8013029 L14.8020847,36.8013029 L14.8020847,38.6306189 L19.9150489,38.6306189 L19.9150489,41.8082085 L14.8020847,41.8082085 L14.8020847,46.3726384 L11.1293811,46.3726384 L11.1293811,33.5176547 Z M20.9613029,33.5176547 L26.1237785,33.5176547 C29.539544,33.5176547 31.4986319,35.1609121 31.4986319,38.0255375 C31.4986319,39.7672964 30.7739414,41.0407818 29.3435831,41.8147231 L32.0599349,46.3726384 L27.8350489,46.3726384 L25.5528339,42.5334202 L24.6342671,42.5334202 L24.6342671,46.3726384 L20.9613029,46.3726384 L20.9613029,33.5176547 Z M32.362215,33.5176547 L42.1563518,33.5176547 L42.1563518,36.8013029 L36.2472964,36.8013029 L36.2472964,38.2415635 L41.8553746,38.2415635 L41.8553746,41.4188925 L36.2472964,41.4188925 L36.2472964,43.0889902 L42.1563518,43.0889902 L42.1563518,46.3726384 L32.362215,46.3726384 L32.362215,33.5176547 Z M44.7525733,41.3620847 L44.9104886,41.5674267 C45.806645,42.7340717 46.8820847,43.3013681 48.1985668,43.3013681 C49.0191531,43.3013681 49.5291205,43.0220195 49.5291205,42.5725081 C49.5291205,42.4354397 49.5291205,42.0190228 48.4789577,41.8402606 L46.5667752,41.4861238 C45.4824756,41.3021498 44.567557,40.8531596 43.847557,40.1516612 C43.1317264,39.4168078 42.7708143,38.5185668 42.7708143,37.4770033 C42.7708143,36.2426059 43.2706189,35.2299674 44.2561564,34.4672313 C45.237785,33.7081433 46.4213681,33.3232573 47.7740717,33.3232573 C49.767557,33.3232573 51.4327036,34.0878176 52.7228664,35.5960912 L52.8544625,35.7500977 L50.5060586,38.2616287 L50.3418893,38.0641042 C49.5176547,37.0715309 48.6314007,36.5889251 47.6325733,36.5889251 C46.7559609,36.5889251 46.4435179,36.9289902 46.4435179,37.2471661 C46.4435179,37.3636482 46.4435179,37.7180456 47.3521824,37.8730945 L49.051987,38.1740717 C51.805342,38.6545928 53.2018241,40.0927687 53.2018241,42.4484691 C53.2018241,43.6729642 52.6829967,44.6803909 51.6599349,45.443127 C50.6452117,46.1993485 49.4261889,46.5670358 47.9332899,46.5670358 C45.6818241,46.5670358 43.654202,45.5645603 42.5091857,43.885342 L42.4041694,43.7308143 L44.7525733,41.3620847 Z M53.6549837,33.5176547 L57.3276873,33.5176547 L57.3276873,38.1529642 L60.8732248,38.1529642 L60.8732248,33.5176547 L64.5636482,33.5176547 L64.5636482,46.3726384 L60.8732248,46.3726384 L60.8732248,41.6310098 L57.3276873,41.6310098 L57.3276873,46.3726384 L53.6549837,46.3726384 L53.6549837,33.5176547 Z M19.7829316,58.1154397 L19.7829316,54.2504235 L22.9151792,54.2504235 C24.9214332,54.2504235 26.0719218,55.2187622 26.0719218,56.907101 C26.0719218,57.1408469 26.0482085,57.3597394 26.0039088,57.5648208 C26.1425407,57.5551792 26.2811726,57.547101 26.4200651,57.5377199 C26.7890554,56.7549186 27.4811726,56.2441694 28.3186971,56.0221498 C29.0162866,55.8697068 29.5259935,55.8457329 30.2842997,55.9945277 C31.0587622,56.1740717 31.691987,56.5967427 32.0810423,57.2479479 C32.2908143,57.2406515 32.5008469,57.2357003 32.7108795,57.2294463 L32.7108795,56.0461238 L33.3029316,56.0461238 L33.3029316,54.4862541 L35.5715961,54.4862541 L35.5715961,56.0461238 L36.4661889,56.0461238 L36.4661889,57.1562215 C36.6126384,57.1549186 36.7590879,57.1554397 36.9055375,57.1543974 L36.9055375,56.0502932 L37.4978502,56.0502932 L37.4978502,54.4904235 L39.7662541,54.4904235 L39.7662541,56.0502932 L40.6611075,56.0502932 L40.6611075,57.1736808 C40.8112052,57.1760261 40.9610423,57.1796743 41.1111401,57.1825407 C41.1921824,56.495114 41.4522476,55.9223453 41.9038436,55.4611075 C42.4565472,54.8849511 43.1739414,54.6027362 44.0440391,54.6027362 C44.9495765,54.6027362 45.6552443,54.8849511 46.1490554,55.4611075 C46.6092508,55.9979153 46.8521173,56.6381759 46.8836482,57.3886645 C47.012899,57.3954397 47.1424104,57.4027362 47.2716612,57.409772 L47.2716612,56.0565472 L49.538241,56.0565472 L49.538241,56.7194788 C49.690684,56.3731596 50.3603909,55.8947231 51.0225407,55.8947231 C52.1907492,55.8947231 52.9287296,56.5923127 53.1116612,57.8311401 C56.1547883,58.1029316 59.1898371,58.4536808 62.2118567,58.8885993 C66.2407818,54.1172638 68.5586971,47.9661238 68.1138762,40.8370033 C67.4183713,29.6901629 60.9224756,22.9800651 51.5512704,20.0216287 C51.7104886,20.1456678 51.8624104,20.2770033 52.0046906,20.4166775 C52.1461889,20.5550489 52.0244951,20.8758306 51.821759,20.8213681 C48.3708143,19.8908143 42.9850163,24.4719218 39.4939414,21.5095765 C39.3970033,22.3760261 38.6157655,26.5573941 32.6556352,25.9377199 C32.514658,25.923127 32.4586319,25.7688599 32.5618241,25.6807818 C33.4858632,24.8925081 34.6191531,22.7210423 33.6469055,21.3336808 C30.612899,23.3472313 29.0457329,23.4340065 23.4512052,21.0108143 C23.393355,20.9855375 23.367557,20.9381107 23.3620847,20.88443 C10.2981107,25.5327687 6.98136808,34.789316 7.59400651,44.6118567 C7.9465798,50.2647557 9.98905537,55.0892508 13.147101,58.9534853 C15.3527036,58.6303583 17.565342,58.3523127 19.7829316,58.1154397 L19.7829316,58.1154397 Z" id="Fill-37" fill="#DB382A"></path><path d="M27.8259283,37.9900977 C27.8259283,37.0035179 27.0676221,36.8013029 25.9293811,36.8013029 L24.6342671,36.8013029 L24.6342671,39.2674919 L25.9293811,39.2674919 C27.6291857,39.2674919 27.8259283,38.5386319 27.8259283,37.9900977" id="Fill-38" fill="#DB382A"></path><polyline id="Fill-39" fill="#FAD41F" points="27.2052117 56.5615635 27.1775896 56.5837134 27.2052117 56.5615635"></polyline><polyline id="Fill-40" fill="#FAD41F" points="26.9573941 56.7778502 26.9714658 56.7645603 26.9573941 56.7778502"></polyline><polyline id="Fill-41" fill="#FAD41F" points="26.5735505 57.2562866 26.5725081 57.2583713 26.5735505 57.2562866"></polyline><path d="M26.0039088,57.5648208 L26.0036482,57.5661238 C26.1422801,57.5562215 26.2809121,57.5478827 26.419544,57.5387622 L26.4200651,57.5377199 C26.2811726,57.547101 26.1425407,57.5551792 26.0039088,57.5648208" id="Fill-42" fill="#FAD41F"></path><path d="M26.0719218,56.907101 C26.0719218,57.0241042 26.0656678,57.1371987 26.0544625,57.2471661 C26.0659283,57.1374593 26.0719218,57.0241042 26.0719218,56.907101" id="Fill-43" fill="#FAD41F"></path><path d="M51.6805212,55.9814984 C51.6406515,55.9702932 51.6,55.9606515 51.5585668,55.9515309 C51.6,55.9606515 51.6406515,55.9702932 51.6805212,55.9814984" id="Fill-44" fill="#FAD41F"></path><path d="M51.254202,55.904886 C51.1788925,55.8983713 51.1020195,55.8947231 51.0225407,55.8947231 C51.1020195,55.8947231 51.1788925,55.8983713 51.254202,55.904886" id="Fill-45" fill="#FAD41F"></path><path d="M51.8741368,56.0471661 C51.8389577,56.0330945 51.8035179,56.0200651 51.7670358,56.0080782 C51.8035179,56.0200651 51.8389577,56.0330945 51.8741368,56.0471661" id="Fill-46" fill="#FAD41F"></path><path d="M51.473355,55.9340717 C51.4264495,55.9254723 51.3779805,55.9194788 51.3289902,55.9137459 C51.3779805,55.9194788 51.4264495,55.9254723 51.473355,55.9340717" id="Fill-47" fill="#FAD41F"></path><path d="M36.4661889,57.1570033 C36.4917264,57.1567427 36.5170033,57.1562215 36.5422801,57.1559609 C36.5170033,57.1562215 36.4917264,57.1559609 36.4661889,57.1562215 L36.4661889,57.1570033" id="Fill-48" fill="#FAD41F"></path><path d="M52.054202,56.1300326 C52.0231922,56.1136156 51.9921824,56.0974593 51.9598697,56.0826059 C51.9921824,56.0974593 52.0231922,56.1136156 52.054202,56.1300326" id="Fill-49" fill="#FAD41F"></path><path d="M30.6220195,56.0935505 C30.597785,56.0852117 30.5740717,56.0758306 30.549316,56.068013 C30.5740717,56.0758306 30.597785,56.0852117 30.6220195,56.0935505" id="Fill-50" fill="#FAD41F"></path><path d="M32.0807818,57.2476873 L32.0818241,57.2489902 C32.1282085,57.2476873 32.1745928,57.245342 32.2209772,57.2437785 C32.1743322,57.2450814 32.1276873,57.2463844 32.0810423,57.2479479 L32.0807818,57.2476873" id="Fill-51" fill="#FAD41F"></path><path d="M40.6611075,57.174202 C40.6921173,57.1747231 40.7233876,57.1749837 40.7543974,57.1755049 C40.7233876,57.1749837 40.6921173,57.174202 40.6611075,57.1736808 L40.6611075,57.174202" id="Fill-52" fill="#FAD41F"></path><polyline id="Fill-53" fill="#FAD41F" points="31.3331596 56.4489902 31.310228 56.4338762 31.3331596 56.4489902"></polyline><path d="M30.8792182,56.1951792 C30.8549837,56.1842345 30.8310098,56.1732899 30.8062541,56.1628664 C30.8310098,56.1732899 30.8549837,56.1842345 30.8792182,56.1951792" id="Fill-54" fill="#FAD41F"></path><path d="M28.0411726,56.1097068 C28.0161564,56.1185668 27.9919218,56.1284691 27.9671661,56.1378502 C27.9919218,56.1284691 28.0161564,56.1185668 28.0411726,56.1097068" id="Fill-55" fill="#FAD41F"></path><polyline id="Fill-56" fill="#FAD41F" points="27.7613029 56.2251466 27.6990228 56.2545928 27.7613029 56.2251466"></polyline><polyline id="Fill-57" fill="#FAD41F" points="31.1145277 56.3129642 31.0571987 56.2819544 31.1145277 56.3129642"></polyline><path d="M41.9038436,55.4611075 C41.8407818,55.5254723 41.782671,55.592443 41.7271661,55.6607166 C41.782671,55.592443 41.8407818,55.5254723 41.9038436,55.4611075" id="Fill-58" fill="#FAD41F"></path><polyline id="Fill-59" fill="#FAD41F" points="46.8620195 57.1158306 46.8612378 57.108013 46.8620195 57.1158306"></polyline><polyline id="Fill-60" fill="#FAD41F" points="41.3764169 56.2214984 41.3498371 56.2829967 41.3764169 56.2214984"></polyline><path d="M41.5059283,55.9791531 C41.4856026,56.0132899 41.4663192,56.0482085 41.4472964,56.083127 C41.4663192,56.0482085 41.4856026,56.0132899 41.5059283,55.9791531" id="Fill-61" fill="#FAD41F"></path><polyline id="Fill-62" fill="#FAD41F" points="46.7614332 56.602215 46.750228 56.5649511 46.7614332 56.602215"></polyline><polyline id="Fill-63" fill="#FAD41F" points="46.8213681 56.8544625 46.8171987 56.8336156 46.8213681 56.8544625"></polyline><path d="M41.6664495,55.7409772 C41.6349186,55.7831922 41.6039088,55.8259283 41.5747231,55.8694463 C41.6039088,55.8259283 41.6349186,55.7831922 41.6664495,55.7409772" id="Fill-64" fill="#FAD41F"></path><path d="M61.225798,15.153355 L58.499544,17.6213681 L58.8169381,17.9721173 C59.7623453,19.0170684 60.7007166,19.1179153 61.6307492,18.2759609 C62.5180456,17.4728339 62.4885993,16.5490554 61.5366775,15.4970684 L61.225798,15.153355" id="Fill-65" fill="#FAD41F"></path><path d="M27.1603909,7.10175896 L26.3749837,7.37094463 L26.8909446,8.87765472 L27.6763518,8.60820847 C28.4067752,8.3580456 28.6845603,7.9770684 28.5063192,7.45667752 C28.3309446,6.94540717 27.9270358,6.83882736 27.1603909,7.10175896" id="Fill-66" fill="#FAD41F"></path><path d="M62.8161564,19.5851466 C60.9128339,21.3084039 59.0386971,20.5180456 57.8144625,19.1658632 L56.1758958,17.35557 L61.1916612,12.8148534 L62.830228,14.6254072 C63.4780456,15.3407166 63.8712704,16.0914658 63.9919218,16.9584365 C64.1130945,17.8254072 63.7248208,18.7627362 62.8161564,19.5851466 Z M51.1765472,13.855114 L54.9844951,8.26241042 L59.1971336,11.1301629 L58.3278176,12.4065147 L55.6630619,10.5923127 L55.0819544,11.4465147 L57.6109446,13.1679479 L56.7744625,14.3971336 L54.2454723,12.6751792 L53.5934853,13.6325733 L56.2585016,15.4465147 L55.3891857,16.7233876 L51.1765472,13.855114 Z M48.025798,12.4682736 L50.7361564,6.26918567 L52.345798,6.97276873 L49.6351792,13.1718567 L48.025798,12.4682736 Z M47.4684039,7.97211726 L47.1194788,9.41732899 L44.4078176,8.7619544 L43.8230619,11.1825407 L42.1154397,10.7702932 L43.7042345,4.19335505 L48.3392834,5.31283388 L47.9765472,6.81381107 L45.0493811,6.10684039 L44.7570033,7.31726384 L47.4684039,7.97211726 Z M40.3460586,10.6287948 L38.5920521,10.5331596 L38.9613029,3.77745928 L40.7153094,3.87335505 L40.3460586,10.6287948 Z M34.7760261,5.43895765 L35.4011726,10.6225407 L33.6476873,10.8338762 L33.0225407,5.65055375 L31.2023453,5.87022801 L31.017329,4.33745928 L36.4114658,3.68677524 L36.5962215,5.21954397 L34.7760261,5.43895765 Z M29.9028013,11.6815635 L28.0461238,10.1037134 L27.3886645,10.3293811 L28.0677524,12.3103583 L26.4057329,12.8802606 L24.2126384,6.47921824 L26.7601303,5.60651466 C28.4310098,5.03400651 29.6859935,5.48091205 30.1740717,6.90553746 C30.4839088,7.8095114 30.3163518,8.57120521 29.6685342,9.2114658 L31.8110749,11.0274919 L29.9028013,11.6815635 Z M21.1468404,16.069316 L17.5364169,10.3481433 L21.8457329,7.62892508 L22.6697068,8.93446254 L19.9437134,10.6548534 L20.4948534,11.5278176 L23.082215,9.89550489 L23.8751792,11.1523127 L21.2880782,12.7851466 L21.9059283,13.7641694 L24.6319218,12.0440391 L25.4561564,13.3498371 L21.1468404,16.069316 Z M18.5803257,18.5975244 C17.8848208,19.3073616 17.0762215,19.6638436 16.1482736,19.6594545 C15.2200651,19.6552443 14.3976547,19.2948534 13.687557,18.5993485 C12.9777199,17.9035831 12.6214984,17.0955049 12.605342,16.1607818 C12.5957003,15.2190228 12.9284691,14.3966124 13.6242345,13.6867752 C14.3874919,12.9078827 15.3047557,12.5506189 16.3567427,12.6220195 L16.3932248,14.2115961 C15.7104886,14.1771987 15.3086645,14.2428664 14.8221498,14.7390228 C14.4779153,15.0908143 14.3252117,15.5085342 14.3437134,16 C14.362215,16.490684 14.5714658,16.925342 14.9573941,17.3034528 C15.3500977,17.6885993 15.7959609,17.8957655 16.2874267,17.9041042 C16.7786319,17.9129642 17.1932248,17.7381107 17.5444951,17.379544 C18.0781759,16.8351792 18.1615635,16.3364169 18.0307492,15.5460586 L19.6148534,15.6117264 C19.7829316,16.7223453 19.4381759,17.722215 18.5803257,18.5975244 Z M63.4274919,11.7529642 C56.6829967,5.32977199 47.5981759,1.7923127 37.8465147,1.7923127 C28.0948534,1.7923127 19.0102932,5.32977199 12.265798,11.7529642 C5.45928339,18.2353094 1.71074919,27.0684039 1.71074919,36.624886 C1.71074919,44.0364821 3.93771987,51.1583062 8.15061889,57.2208469 C8.68820847,57.9945277 9.25498371,58.7418893 9.84547231,59.4665798 C10.9438436,59.2833876 12.0448208,59.1145277 13.1468404,58.9529642 C9.98905537,55.0889902 7.9465798,50.2647557 7.59400651,44.6118567 C6.98136808,34.789316 10.2981107,25.5327687 23.3620847,20.88443 C23.3506189,20.7679479 23.4452117,20.6196743 23.5919218,20.5868404 C24.7538762,20.3265147 27.5160912,19.3214332 29.9940065,18.8534202 C30.4654072,18.7642997 30.9305537,18.7095765 31.3777199,18.7038436 C28.8140717,18.0930293 27.6958958,17.5609121 26.0072964,17.5692508 C25.8222801,17.5702932 25.729772,17.3414984 25.8631922,17.2132899 C28.5073616,14.670228 33.299544,14.5414984 35.607557,16.4338762 L33.5398046,12.1138762 L36.0531596,11.7355049 C36.0531596,11.7355049 36.7087948,14.0390879 37.2956352,16.1104886 C39.9127036,13.2427362 43.9619544,13.5332899 45.3256026,16.0372638 C45.406645,16.1860586 45.2737459,16.3616938 45.1067101,16.3330293 C43.7339414,16.0987622 42.792443,17.2414332 42.5962215,18.1863192 L42.6157655,18.1912704 C44.6895114,18.0057329 49.074658,18.0935505 51.5512704,20.0216287 C60.9224756,22.9800651 67.4183713,29.6901629 68.1138762,40.8370033 C68.5586971,47.9661238 66.2407818,54.1172638 62.2118567,58.8885993 C62.1738111,58.883127 62.1355049,58.8784365 62.0974593,58.8729642 C63.3532248,59.0527687 64.6074267,59.2437785 65.8585016,59.451987 C66.461759,58.7111401 67.0405212,57.9468404 67.588013,57.1551792 C71.7712052,51.1069707 73.9822801,44.0078176 73.9822801,36.624886 C73.9822801,27.0684039 70.2337459,18.2353094 63.4274919,11.7529642 L63.4274919,11.7529642 Z" id="Fill-67" fill="#F9D320"></path><path d="M46.3158306,55.6737459 C46.2637134,55.6013029 46.2084691,55.5301629 46.1490554,55.4611075 C46.2084691,55.5301629 46.2637134,55.6013029 46.3158306,55.6737459" id="Fill-68" fill="#FAD41F"></path><polyline id="Fill-69" fill="#FAD41F" points="52.6902932 56.6926384 52.6535505 56.6426059 52.6902932 56.6926384"></polyline><polyline id="Fill-70" fill="#FAD41F" points="52.570684 56.5386319 52.5279479 56.4925081 52.570684 56.5386319"></polyline><polyline id="Fill-71" fill="#FAD41F" points="52.7945277 56.8583713 52.766645 56.8104235 52.7945277 56.8583713"></polyline><polyline id="Fill-72" fill="#FAD41F" points="52.4052117 56.3721173 52.4372638 56.3992182 52.4052117 56.3721173"></polyline><polyline id="Fill-73" fill="#FAD41F" points="52.8826059 57.0308795 52.8661889 56.9941368 52.8826059 57.0308795"></polyline><path d="M46.4594137,55.894202 C46.4367427,55.8556352 46.4109446,55.8183713 46.3861889,55.7808469 C46.4109446,55.8183713 46.4364821,55.8556352 46.4594137,55.894202" id="Fill-74" fill="#FAD41F"></path><polyline id="Fill-75" fill="#FAD41F" points="46.6814332 56.3580456 46.6585016 56.301759 46.6814332 56.3580456"></polyline><path d="M46.5811075,56.122215 C46.5680782,56.095114 46.5532248,56.0690554 46.5391531,56.042215 C46.5532248,56.0687948 46.5680782,56.095114 46.5811075,56.122215" id="Fill-76" fill="#FAD41F"></path><path d="M52.2175896,56.2274919 C52.1912704,56.209772 52.1654723,56.1912704 52.1381107,56.1748534 C52.1654723,56.1912704 52.1912704,56.209772 52.2175896,56.2274919" id="Fill-77" fill="#FAD41F"></path><path d="M64.6829967,63.4694463 C64.5618241,63.5937459 64.4122476,63.6544625 64.2337459,63.6544625 C64.0583713,63.6544625 63.9085342,63.5937459 63.7876221,63.4694463 C63.6664495,63.3451466 63.6059935,63.1921824 63.6059935,63.0105537 C63.6059935,62.8291857 63.6664495,62.6728339 63.7876221,62.5485342 C63.9085342,62.4211075 64.0583713,62.3572638 64.2337459,62.3572638 C64.4122476,62.3572638 64.5618241,62.4211075 64.6829967,62.5485342 C64.8072964,62.6728339 64.8677524,62.8291857 64.8677524,63.0105537 C64.8677524,63.1921824 64.8072964,63.3451466 64.6829967,63.4694463 Z M64.8518567,62.3859283 C64.6829967,62.2139414 64.4758306,62.1279479 64.2337459,62.1279479 C63.9914007,62.1279479 63.7876221,62.2139414 63.6185016,62.3859283 C63.4530293,62.5579153 63.3701629,62.7650814 63.3701629,63.0105537 C63.3701629,63.2526384 63.4530293,63.4598046 63.6185016,63.6320521 C63.7876221,63.8009121 63.9914007,63.8869055 64.2337459,63.8869055 C64.4758306,63.8869055 64.6829967,63.8009121 64.8518567,63.6320521 C65.0207166,63.4598046 65.1069707,63.2526384 65.1069707,63.0105537 C65.1069707,62.7650814 65.0207166,62.5579153 64.8518567,62.3859283 Z M64.2337459,62.9756352 L64.1284691,62.9756352 L64.1284691,62.7778502 L64.2337459,62.7778502 C64.3387622,62.7778502 64.3929642,62.8096417 64.3929642,62.8734853 C64.3929642,62.940456 64.3387622,62.9756352 64.2337459,62.9756352 Z M64.612899,62.8734853 C64.612899,62.6824756 64.4630619,62.5899674 64.2717915,62.5899674 L63.9119218,62.5899674 L63.9119218,63.3897068 L64.1284691,63.3897068 L64.1284691,63.1700326 L64.236873,63.1700326 L64.3898371,63.3897068 L64.6353094,63.3897068 L64.4471661,63.1348534 C64.5586971,63.0840391 64.612899,62.997785 64.612899,62.8734853 Z M51.9012378,64.9553094 C52.3163518,66.6749186 51.0717915,68.1172638 49.4499023,68.5089251 C47.828013,68.9003257 46.0239739,68.1936156 45.6088599,66.4740065 C45.3159609,65.260456 45.7563518,64.2767427 46.590228,63.6336156 C46.6699674,63.5684691 46.769772,63.5054072 46.8367427,63.482215 C46.4198046,63.5179153 46.1678176,63.497329 45.9137459,63.5828013 C45.8858632,63.5921824 45.8605863,63.562215 45.8743974,63.5361564 C46.1461889,63.0212378 46.7700326,62.7700326 47.211987,62.940456 C46.9117915,62.6783062 46.6759609,62.4690554 46.6759609,62.4690554 L47.0874267,62.1287296 C47.0874267,62.1287296 47.3508795,62.5175244 47.5424104,62.8005212 C47.7941368,62.2376547 48.4187622,62.0797394 48.7491857,62.389316 C48.7687296,62.407557 48.7575244,62.4406515 48.7309446,62.4448208 C48.5123127,62.4779153 48.4317915,62.7046254 48.4492508,62.8568078 L48.6389577,62.8330945 C50.1917915,62.6342671 51.5278176,63.4076873 51.9012378,64.9553094 Z M27.6591531,58.7979153 C27.3586971,58.6767427 27.1812378,58.4174593 27.3201303,58.1394137 C27.4246254,57.9309446 27.7313355,57.8459935 27.9656026,57.9374593 C28.2462541,58.0469055 28.2910749,58.3377199 28.4349186,58.4588925 C28.5586971,58.563127 28.7283388,58.5761564 28.8390879,58.5044951 C28.9209121,58.4515961 28.948013,58.3353746 28.9172638,58.229316 C28.8763518,58.0883388 28.7676873,58.0005212 28.6618893,57.9142671 C28.4732248,57.7610423 28.2071661,57.6291857 28.3682085,57.2109446 C28.5000651,56.8682736 28.8870358,56.8560261 28.8870358,56.8560261 C29.0407818,56.8388274 29.1783713,56.8852117 29.290684,56.9852769 C29.4407818,57.1192182 29.4699674,57.2985016 29.4446906,57.4895114 C29.421759,57.6638436 29.36,57.8168078 29.3279479,57.9895765 C29.290684,58.190228 29.397785,58.392443 29.6018241,58.4002606 C29.8699674,58.4104235 29.9504886,58.2042997 29.9833225,58.0737459 C30.0312704,57.8824756 30.0943322,57.7050163 30.2717915,57.5932248 C30.5263844,57.4327036 30.8802606,57.4678827 31.04443,57.7761564 C31.174202,58.0203257 31.1325081,58.3562215 30.9334202,58.5396743 C30.8440391,58.6220195 30.7366775,58.6509446 30.620456,58.6517264 C30.4536808,58.6530293 30.2871661,58.6488599 30.1323779,58.7267752 C30.027101,58.7799349 29.9812378,58.8661889 29.9812378,58.9824104 C29.9812378,59.0952443 30.0401303,59.1689902 30.1352443,59.2171987 C30.3147883,59.3076221 30.5128339,59.3261238 30.7067101,59.36 C30.9878827,59.4092508 31.2351792,59.5082736 31.3938762,59.7691205 L31.3980456,59.7761564 C31.5801954,60.0849511 31.3897068,60.529772 31.0314007,60.5485342 C30.2340065,60.5904886 30.0711401,59.6779153 29.7581759,59.68443 C29.6247557,59.6870358 29.5197394,59.8267101 29.5658632,59.9890554 C29.5911401,60.0781759 29.661759,60.2092508 29.7060586,60.2905537 C29.8624104,60.5774593 29.6312704,60.9018893 29.3605212,60.9292508 C28.9107492,60.975114 28.723127,60.7140065 28.7348534,60.4469055 C28.7478827,60.1472313 29.0019544,59.8407818 28.7413681,59.7104886 C28.468013,59.5736808 28.2459935,60.1081433 27.9843648,60.2272313 C27.7477524,60.335114 27.4191531,60.2514658 27.3024104,59.9887948 C27.2203257,59.8040391 27.2351792,59.4483388 27.6005212,59.3128339 C27.8287948,59.2281433 28.3371987,59.4235831 28.3632573,59.1757655 C28.3932248,58.8904235 27.8290554,58.8661889 27.6591531,58.7979153 Z M29.3573941,61.9246906 C31.1262541,61.9246906 32.5011075,60.8880782 32.5011075,58.9097068 C32.5011075,57.2865147 31.5906189,56.297329 30.2842997,55.9945277 C29.5259935,55.8457329 29.0162866,55.8697068 28.3186971,56.0221498 C27.0634528,56.354658 26.1308143,57.3331596 26.1308143,58.9097068 C26.1308143,60.8880782 27.5887948,61.9246906 29.3573941,61.9246906 Z M63.3672964,66.5527036 C63.3672964,67.1760261 63.1171336,67.6930293 62.6241042,68.0899023 C62.1576547,68.4745277 61.5444951,68.6704886 60.8028664,68.6704886 C59.8413029,68.6704886 59.0616287,68.4687948 58.3637785,68.0114658 L58.2319218,67.9184365 L59.1418893,66.4169381 C60.1868404,67.0869055 60.7267752,66.9865798 60.9326384,66.970684 C61.3847557,66.9357655 61.4337459,66.4357003 61.0598046,66.4445603 C60.7723779,66.4510749 60.2048208,66.510228 59.363127,66.1183062 C58.7744625,65.7579153 58.3906189,65.3383713 58.3906189,64.6459935 C58.3906189,64.0482085 58.6389577,63.5588274 59.1288599,63.1914007 C59.5997394,62.8383062 60.0500326,62.6428664 60.7215635,62.6118567 C61.5921824,62.5717264 62.2228013,62.7611726 63.0045603,63.1635179 L63.1692508,63.2729642 L62.3390228,64.6407818 C61.4295765,64.2764821 60.9581759,64.1771987 60.6282736,64.2402606 C60.2418241,64.3137459 60.2975896,64.6887296 60.582671,64.7267752 C60.8677524,64.7645603 61.3229967,64.6420847 62.1805863,64.9464495 C62.9250814,65.2437785 63.3672964,65.7276873 63.3672964,66.5527036 Z M49.5609121,61.7779805 L47.2716612,61.7779805 L47.2716612,56.0565472 L49.538241,56.0565472 L49.538241,56.7194788 C49.690684,56.3731596 50.3603909,55.8947231 51.0225407,55.8947231 C52.3796743,55.8947231 53.1580456,56.8341368 53.1580456,58.4719218 L53.1580456,61.7779805 L50.8714007,61.7779805 L50.8714007,58.6613681 C50.8714007,58.1811075 50.6639739,57.9374593 50.255114,57.9374593 C49.8264495,57.9374593 49.5609121,58.1180456 49.5609121,59.0175896 L49.5609121,61.7779805 Z M38.2712704,66.2749186 C38.0977199,66.4703583 37.8514658,66.5735505 37.5593485,66.5735505 C37.0876873,66.5735505 36.609772,66.2472964 36.609772,65.6239739 C36.609772,65.3764169 36.694202,65.1455375 36.8474267,64.9730293 C37.0209772,64.7778502 37.2672313,64.674658 37.5593485,64.674658 C38.0312704,64.674658 38.5089251,65.0006515 38.5089251,65.6239739 C38.5089251,65.8715309 38.4244951,66.102671 38.2712704,66.2749186 Z M38.541759,63.4277524 L38.3984365,63.2711401 C38.0010423,62.8372638 37.501759,62.6079479 36.9545277,62.6079479 C36.5683388,62.6079479 36.1615635,62.7249511 35.7777199,62.9464495 C34.9224756,63.4397394 34.4114658,64.4385668 34.4109442,65.618241 C34.4104235,66.803127 34.9211726,67.8063844 35.7777199,68.3014984 C36.1615635,68.5235179 36.570684,68.6407818 36.9610423,68.6407818 C37.5067101,68.6407818 38.0036482,68.4171987 38.3989577,67.9940065 L38.541759,67.8410423 L38.541759,68.4841694 L40.7403257,68.4841694 L40.7403257,62.769772 L38.541759,62.769772 L38.541759,63.4277524 Z M33.3029316,58.0185016 L32.7108795,58.0185016 L32.7108795,56.0461238 L33.3029316,56.0461238 L33.3029316,54.4862541 L35.5715961,54.4862541 L35.5715961,56.0461238 L36.4661889,56.0461238 L36.4661889,58.0185016 L35.5715961,58.0185016 L35.5715961,59.4522476 C35.5715961,59.7305537 35.6904235,59.8493811 35.9689902,59.8493811 L36.6874267,59.8493811 L36.6874267,61.8115961 L36.55557,61.8170684 C36.3246906,61.8269707 36.0161564,61.8402606 35.6956352,61.8402606 C34.175114,61.8402606 33.3029316,61.0772638 33.3029316,59.6002606 L33.3029316,58.0185016 Z M40.1636482,59.8538111 L40.8823453,59.8538111 L40.8823453,61.8157655 L40.750228,61.8214984 C40.5196091,61.8311401 40.2110749,61.84443 39.8902932,61.84443 C38.369772,61.84443 37.4978502,61.0816938 37.4978502,59.60443 L37.4978502,58.022671 L36.9055375,58.022671 L36.9055375,56.0502932 L37.4978502,56.0502932 L37.4978502,54.4904235 L39.7662541,54.4904235 L39.7662541,56.0502932 L40.6611075,56.0502932 L40.6611075,58.022671 L39.7662541,58.022671 L39.7662541,59.4564169 C39.7662541,59.7349837 39.8850814,59.8538111 40.1636482,59.8538111 Z M18.8849511,63.1403257 L16.9355049,63.1403257 L16.9355049,68.4914658 L14.7226059,68.4914658 L14.7226059,63.1403257 L12.7734202,63.1403257 L12.7734202,60.9639088 L18.8849511,60.9639088 L18.8849511,63.1403257 Z M44.4375244,66.5639088 L45.1570033,66.5639088 L45.1570033,68.5276873 L45.024886,68.5334202 C44.7937459,68.5433225 44.4849511,68.5566124 44.1641694,68.5566124 C42.6423453,68.5566124 41.7693811,67.7928339 41.7693811,66.3145277 L41.7693811,64.7312052 L41.1768078,64.7312052 L41.1768078,62.7572638 L41.7693811,62.7572638 L41.7693811,61.1958306 L44.0398697,61.1958306 L44.0398697,62.7572638 L44.9355049,62.7572638 L44.9355049,64.7312052 L44.0398697,64.7312052 L44.0398697,66.1662541 C44.0398697,66.4448208 44.1589577,66.5639088 44.4375244,66.5639088 Z M34.0291857,65.1783713 L34.0291857,68.4914658 L31.7237785,68.4914658 L31.7237785,65.3792834 C31.7237785,64.8904235 31.5147883,64.6426059 31.1022801,64.6426059 C30.6918567,64.6426059 30.6095114,64.9000651 30.582671,64.9847557 C30.5117915,65.2385668 30.4998046,65.3834528 30.4998046,65.6912052 L30.4998046,68.4914658 L28.2277524,68.4914658 L28.2277524,65.3792834 C28.2277524,64.8904235 28.015114,64.6426059 27.5953094,64.6426059 C27.356873,64.6426059 27.2010423,64.7585668 27.1400651,64.8578502 C27.0970684,64.9224756 27.0647557,65.0394788 27.04443,65.1215635 C27.0037785,65.356873 27.0037785,65.4410423 27.0037785,65.6912052 L27.0037785,68.4914658 L24.7953094,68.4914658 L24.7953094,62.7572638 L26.9816287,62.7572638 L26.9800651,63.2961564 C27.135114,62.9800651 27.726645,62.6079479 28.5563518,62.6079479 C29.2393485,62.6079479 29.7837134,62.8427362 30.1300326,63.2867752 L30.1912704,63.3654723 L30.2574593,63.290684 C30.6704886,62.8231922 31.1439739,62.6235831 31.8410423,62.6235831 C32.4990228,62.6235831 34.0291857,62.8727036 34.0291857,65.1783713 Z M21.2727036,66.5378502 C20.7210423,66.5378502 20.2300977,66.1203909 20.2300977,65.5455375 C20.2300977,64.9641694 20.7210423,64.5420195 21.2727036,64.5420195 C21.8332248,64.5420195 22.3153094,64.9547883 22.3153094,65.5455375 C22.3153094,66.1388925 21.8418241,66.5378502 21.2727036,66.5378502 Z M22.1957003,62.708013 C21.436873,62.5589577 21.0186319,62.5831922 20.3207818,62.7356352 C19.0647557,63.0681433 18.1315961,64.0471661 18.1315961,65.6244951 C18.1315961,67.6036482 19.6484691,68.6407818 21.3141368,68.6407818 C22.9800651,68.6407818 24.4135505,67.6036482 24.4135505,65.6244951 C24.4135505,64.0005212 23.5025407,63.0108143 22.1957003,62.708013 Z M22.0570684,56.0059935 L22.7108795,56.0059935 C23.3441042,56.0059935 23.7532248,56.3064495 23.7532248,56.7710749 C23.7532248,57.2925081 23.3732899,57.5916612 22.7108795,57.5916612 L22.0570684,57.5916612 L22.0570684,56.0059935 Z M22.0622801,59.3355049 L22.4416938,59.3355049 L23.8707492,61.7779805 L26.4375244,61.7779805 L24.8508143,59.1150489 L24.922215,59.0717915 C25.6849511,58.6105537 26.0719218,57.882215 26.0719218,56.907101 C26.0719218,55.2187622 24.9214332,54.2504235 22.9151792,54.2504235 L19.7829316,54.2504235 L19.7829316,61.7779805 L22.0622801,61.7779805 L22.0622801,59.3355049 Z M54.2676221,64.9993485 C54.3598697,64.5649511 54.7020195,64.2624104 55.1890554,64.2624104 C55.7284691,64.2624104 56.0312704,64.5779805 56.0706189,64.9993485 L54.2676221,64.9993485 Z M55.2338762,62.6079479 C54.3637785,62.6079479 53.6463844,62.8901629 53.0936808,63.4665798 C52.5409772,64.0310098 52.2704886,64.7601303 52.2704886,65.6656678 C52.2704886,66.5829316 52.56443,67.3120521 53.1523127,67.8410423 C53.740456,68.3702932 54.4813029,68.6407818 55.375114,68.6407818 C56.2738762,68.6407818 57.2281433,68.4813029 57.9908795,67.669316 L56.6029967,66.3635179 C56.3108795,66.7484039 55.9041042,66.8179805 55.3514007,66.8179805 C54.8810423,66.8179805 54.3734202,66.5592182 54.2676221,66.1008469 L58.068013,66.1008469 L58.0797394,65.5598697 C58.0797394,64.7364169 57.8327036,64.0427362 57.3388925,63.4665798 C56.8450814,62.8901629 56.1394137,62.6079479 55.2338762,62.6079479 Z M43.9992182,56.2569381 C44.5386319,56.2569381 44.8414332,56.5727687 44.8807818,56.9938762 L43.077785,56.9938762 C43.1700326,56.5594788 43.5121824,56.2569381 43.9992182,56.2569381 Z M44.1852769,60.63557 C45.0840391,60.63557 46.0383062,60.4760912 46.8010423,59.6641042 L45.4131596,58.3580456 C45.1210423,58.7431922 44.7142671,58.8127687 44.1615635,58.8127687 C43.6912052,58.8127687 43.1835831,58.5540065 43.077785,58.0953746 L46.8781759,58.0953746 L46.8899023,57.5543974 C46.8899023,56.7312052 46.6428664,56.0375244 46.1490554,55.4611075 C45.6552443,54.8849511 44.9495765,54.6027362 44.0440391,54.6027362 C43.1739414,54.6027362 42.4565472,54.8849511 41.9038436,55.4611075 C41.3511401,56.025798 41.0806515,56.754658 41.0806515,57.660456 C41.0806515,58.5777199 41.3745928,59.3065798 41.9624756,59.8358306 C42.5506189,60.3650814 43.2914658,60.63557 44.1852769,60.63557 L44.1852769,60.63557 Z" id="Fill-78" fill="#F2E93C"></path><path d="M48.1985668,43.3013681 C46.8820847,43.3013681 45.806645,42.7340717 44.9104886,41.5674267 L44.7525733,41.3620847 L42.4041694,43.7308143 L42.5091857,43.885342 C43.654202,45.5645603 45.6818241,46.5670358 47.9332899,46.5670358 C49.4261889,46.5670358 50.6452117,46.1993485 51.6599349,45.443127 C52.6829967,44.6803909 53.2018241,43.6729642 53.2018241,42.4484691 C53.2018241,40.0927687 51.805342,38.6545928 49.051987,38.1740717 L47.3521824,37.8730945 C46.4435179,37.7180456 46.4435179,37.3636482 46.4435179,37.2471661 C46.4435179,36.9289902 46.7559609,36.5889251 47.6325733,36.5889251 C48.6314007,36.5889251 49.5176547,37.0715309 50.3418893,38.0641042 L50.5060586,38.2616287 L52.8544625,35.7500977 L52.7228664,35.5960912 C51.4327036,34.0878176 49.767557,33.3232573 47.7740717,33.3232573 C46.4213681,33.3232573 45.237785,33.7081433 44.2561564,34.4672313 C43.2706189,35.2299674 42.7708143,36.2426059 42.7708143,37.4770033 C42.7708143,38.5185668 43.1317264,39.4168078 43.847557,40.1516612 C44.567557,40.8531596 45.4824756,41.3021498 46.5667752,41.4861238 L48.4789577,41.8402606 C49.5291205,42.0190228 49.5291205,42.4354397 49.5291205,42.5725081 C49.5291205,43.0220195 49.0191531,43.3013681 48.1985668,43.3013681" id="Fill-79" fill="#FFFFFE"></path><polyline id="Fill-80" fill="#FFFFFE" points="64.5636482 46.3726384 64.5636482 33.5176547 60.8732248 33.5176547 60.8732248 38.1529642 57.3276873 38.1529642 57.3276873 33.5176547 53.6549837 33.5176547 53.6549837 46.3726384 57.3276873 46.3726384 57.3276873 41.6310098 60.8732248 41.6310098 60.8732248 46.3726384 64.5636482 46.3726384"></polyline><polyline id="Fill-81" fill="#FFFFFE" points="42.1563518 36.8013029 42.1563518 33.5176547 32.362215 33.5176547 32.362215 46.3726384 42.1563518 46.3726384 42.1563518 43.0889902 36.2472964 43.0889902 36.2472964 41.4188925 41.8553746 41.4188925 41.8553746 38.2415635 36.2472964 38.2415635 36.2472964 36.8013029 42.1563518 36.8013029"></polyline><polyline id="Fill-82" fill="#FFFFFE" points="20.3220847 36.8013029 20.3220847 33.5176547 11.1293811 33.5176547 11.1293811 46.3726384 14.8020847 46.3726384 14.8020847 41.8082085 19.9150489 41.8082085 19.9150489 38.6306189 14.8020847 38.6306189 14.8020847 36.8013029 20.3220847 36.8013029"></polyline><path d="M25.9293811,39.2674919 L24.6342671,39.2674919 L24.6342671,36.8013029 L25.9293811,36.8013029 C27.0676221,36.8013029 27.8259283,37.0035179 27.8259283,37.9900977 C27.8259283,38.5386319 27.6291857,39.2674919 25.9293811,39.2674919 Z M31.4986319,38.0255375 C31.4986319,35.1609121 29.539544,33.5176547 26.1237785,33.5176547 L20.9613029,33.5176547 L20.9613029,46.3726384 L24.6342671,46.3726384 L24.6342671,42.5334202 L25.5528339,42.5334202 L27.8350489,46.3726384 L32.0599349,46.3726384 L29.3435831,41.8147231 C30.7739414,41.0407818 31.4986319,39.7672964 31.4986319,38.0255375 L31.4986319,38.0255375 Z" id="Fill-83" fill="#FFFFFE"></path></g></g></g></svg>';
    var RT_CRITICS_ROTTEN_SVG_TEMPLATE = '<svg class="ns-rt-rating-logo ns-rt-critics-logo" aria-hidden="true" id="downloadable-svg" type="negative" viewBox="0 0 80 80" preserveAspectRatio="xMidYMid" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g transform="translate(0, 1.23)"><g><mask id="mask-2" fill="white"><polygon points="0 0.161950465 79.7417075 0.161950465 79.7417075 77.522807 0 77.522807"/></mask><path d="M71.4638596,70.225614 C56.3459649,71.0192982 53.2568421,53.7203509 47.325614,53.8435088 C44.7982456,53.8964912 42.8063158,56.5389474 43.6810526,59.6185965 C44.1621053,61.3115789 45.4964912,63.794386 46.337193,65.3350877 C49.302807,70.7719298 44.9185965,76.9245614 39.7880702,77.4449123 C31.2621053,78.3098246 27.705614,73.3638596 27.925614,68.3007018 C28.1729825,62.6168421 32.9922807,56.8091228 28.0494737,54.3378947 C22.8694737,51.7480702 18.6585965,61.8754386 13.7017544,64.1357895 C9.2154386,66.1817544 2.9877193,64.5954386 0.773684211,59.6136842 C-0.781403509,56.1129825 -0.498596491,49.3722807 6.42526316,46.8003509 C10.7501754,45.1940351 20.3880702,48.9010526 20.8824561,44.205614 C21.4522807,38.7929825 10.7575439,38.3364912 7.53754386,37.0385965 C1.84,34.7424561 -1.52280702,29.8291228 1.11192982,24.5582456 C3.08877193,20.6045614 8.90526316,18.9957895 13.3449123,20.7277193 C18.6635088,22.8024561 19.517193,28.3189474 22.2421053,30.6129825 C24.5894737,32.5901754 27.8021053,32.8375439 29.9031579,31.4782456 C31.4526316,30.4754386 31.9684211,28.2729825 31.3838596,26.2610526 C30.6084211,23.5901754 28.5505263,21.9235088 26.542807,20.2905263 C22.9698246,17.3859649 17.925614,14.8884211 20.9768421,6.96035088 C23.4778947,0.463157895 30.8133333,0.229122807 30.8133333,0.229122807 C33.7277193,-0.0985964912 36.3375439,0.781403509 38.4642105,2.68140351 C41.3073684,5.22140351 41.8610526,8.61649123 41.3852632,12.2385965 C40.9505263,15.5449123 39.7803509,18.4407018 39.1701754,21.7164912 C38.4621053,25.5196491 40.4947368,29.3519298 44.3603509,29.5010526 C49.4449123,29.6975439 50.9694737,25.7894737 51.5915789,23.3122807 C52.5024561,19.6877193 53.6978947,16.322807 57.0617544,14.2035088 C61.8894737,11.1617544 68.5954386,11.8284211 71.7066667,17.674386 C74.1677193,22.3 73.3775439,28.6677193 69.6024561,32.1449123 C67.9087719,33.7045614 65.8722807,34.254386 63.6694737,34.2698246 C60.5105263,34.2922807 57.3529825,34.2147368 54.4207018,35.6929825 C52.4245614,36.6989474 51.5547368,38.3382456 51.5550877,40.5354386 C51.5550877,42.6768421 52.6698246,44.0754386 54.4761404,44.985614 C57.8782456,46.7003509 61.6336842,47.0508772 65.3087719,47.694386 C70.6382456,48.6277193 75.3242105,50.5049123 78.3326316,55.4505263 C78.3596491,55.4940351 78.3859649,55.5378947 78.4115789,55.5821053 C81.8666667,61.4375439 78.2533333,69.8687719 71.4638596,70.225614" fill="#0AC855" mask="url(#mask-2)"/></g></g></svg>';
    var RT_AUDIENCE_UPRIGHT_SVG_TEMPLATE = '<svg class="ns-rt-rating-logo ns-audience-upright-logo" aria-hidden="true" viewBox="0 0 80 80" preserveAspectRatio="xMidYMid" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g transform="translate(10.1, 0)"><g><mask id="mask-2" fill="white"><polygon points="0.0178438662 0.124907063 59.6019307 0.124907063 59.6019307 79.9821561 0.0178438662 79.9821561"></polygon></mask><path d="M2.53115242,19.0988848 C2.76163569,23.9952416 14.8892193,27.8762825 29.8007435,27.7912268 C42.8237918,27.7168773 53.6874349,24.6411896 56.3485502,20.6004461 C55.7421561,19.9265428 54.904684,19.4643866 53.9613383,19.3391822 C53.9714498,19.220223 53.9779926,19.1003717 53.9773978,18.9787361 C53.9663941,17.0423792 52.5460223,15.4477323 50.695316,15.1503346 C50.7440892,14.8999257 50.7696654,14.6408922 50.7681784,14.3759108 C50.7559851,12.2194796 48.9977695,10.481487 46.8413383,10.4936803 C46.7925651,10.4939777 46.7449814,10.4999257 46.6965056,10.5020074 C46.8344981,10.0987361 46.9118216,9.66780669 46.9094424,9.21784387 C46.8969517,7.06141264 45.1390335,5.32342007 42.9826022,5.33561338 C42.4877323,5.33858736 42.0169517,5.43702602 41.5821561,5.60743494 C40.9653532,4.44639405 39.7811152,3.63717472 38.4002974,3.54379182 C38.1597026,1.60743494 36.5055762,0.113605948 34.506171,0.124843367 C33.247881,0.13204461 32.1350186,0.736356877 31.4263197,1.66453532 C30.7075093,0.882379182 29.6773234,0.391672862 28.5314498,0.398215613 C26.3750186,0.410408922 24.637026,2.16862454 24.6492193,4.32475836 C24.6515985,4.73665428 24.718513,5.13249071 24.8386617,5.50453532 C23.9586617,5.66780669 23.1848327,6.12520446 22.6191822,6.77144981 C22.1701115,5.09888476 20.642974,3.86973978 18.8297398,3.8798513 C17.1357621,3.88966543 15.7040892,4.97873606 15.172342,6.48981413 C13.7332342,7.07182156 12.7202974,8.48356877 12.7298141,10.1302602 C12.7318959,10.4960595 12.7878067,10.8481784 12.8838662,11.1836431 C12.398513,10.9713011 11.8634944,10.852342 11.2996283,10.8556134 C9.5994052,10.8654275 8.16327138,11.9622305 7.63598513,13.4822305 C7.13040892,13.2472862 6.56832714,13.1137546 5.973829,13.1173234 C3.81739777,13.1295167 2.07910781,14.8874349 2.09153162,17.0438662 C2.09546468,17.7549442 2.29263941,18.4187361 2.62810409,18.9909294 C2.59390335,19.0254275 2.56386617,19.063197 2.53115242,19.0988848" fill="#F9D320" mask="url(#mask-2)"></path><path d="M50.9736803,68.1576208 C49.8275093,69.89829 47.6002974,71.7008178 45.2692937,72.9026022 L49.2541264,32.4853532 C51.7894424,31.6707807 54.2634944,30.5915242 56.085948,29.0438662 L50.9736803,68.1576208 Z M41.3037918,74.5885502 C37.4450558,75.8655762 35.201487,76.2614126 31.9895911,76.5766543 L32.4901115,35.0432714 C36.0383643,34.9415613 40.6301859,34.4606691 44.5427509,33.6255762 L41.3037918,74.5885502 Z M18.29829,74.5885502 L15.0596283,33.6255762 C18.9718959,34.4606691 23.5637175,34.9415613 27.1119703,35.0432714 L27.6124907,76.5766543 C24.4005948,76.2614126 22.1573234,75.8655762 18.29829,74.5885502 Z M8.62869888,68.1576208 L3.51613383,29.0438662 C5.33858736,30.5915242 7.81263941,31.6707807 10.3479554,32.4853532 L14.3327881,72.9026022 C12.0017844,71.7008178 9.77457249,69.89829 8.62869888,68.1576208 Z M50.687881,13.6110037 C50.7384387,13.8578439 50.7666914,14.1130112 50.7681784,14.3750186 C50.7696654,14.64 50.7440892,14.8990335 50.6950186,15.1494424 C52.5460223,15.4465428 53.9663941,17.0411896 53.9773978,18.9778439 C53.9779926,19.0991822 53.9714498,19.2193309 53.9613383,19.3379926 C54.904684,19.463197 55.7421561,19.9253532 56.3485502,20.5992565 C53.6877323,24.6402974 42.8237918,27.7159851 29.8010409,27.790632 C14.8895167,27.8759851 2.76193309,23.9952416 2.53115242,19.0985874 C2.56386617,19.063197 2.59390335,19.0251301 2.62810409,18.9909294 C2.39791822,18.5983643 2.23910781,18.1608922 2.15702602,17.6966543 C0.729219331,19.0518959 -0.13472119,20.1445353 0.0172490706,21.7356134 C0.0318215613,21.9482528 6.3339777,67.0709294 6.3339777,67.0709294 C7.06111524,74.2173978 17.4388104,79.9292193 29.8010409,80 C42.1632714,79.9292193 52.5412639,74.2173978 53.2681041,67.0709294 C53.2681041,67.0709294 59.5702602,21.9482528 59.5848327,21.7356134 C59.8866914,18.5531599 56.162974,15.6642379 50.687881,13.6110037 L50.687881,13.6110037 Z" fill="#DB382A" mask="url(#mask-2)"></path></g><path d="M15.0596283,33.6255762 L18.29829,74.5885502 C22.1573234,75.8655762 24.4005948,76.2614126 27.6124907,76.5766543 L27.1119703,35.0432714 C23.5637175,34.9415613 18.9718959,34.4606691 15.0596283,33.6255762" fill="#FFFFFE"></path><path d="M31.9895911,76.5766543 C35.201487,76.2614126 37.4447584,75.8655762 41.3037918,74.5885502 L44.5424535,33.6255762 C40.6301859,34.4606691 36.0383643,34.9415613 32.4901115,35.0432714 L31.9895911,76.5766543" fill="#FFFFFE"></path><path d="M45.2692937,72.9026022 C47.6002974,71.7008178 49.8275093,69.89829 50.9733829,68.1576208 L56.085948,29.0438662 C54.2634944,30.5915242 51.7894424,31.6707807 49.2541264,32.4853532 L45.2692937,72.9026022" fill="#FFFFFE"></path><path d="M3.51613383,29.0438662 L8.62840149,68.1576208 C9.77457249,69.89829 12.0017844,71.7008178 14.3327881,72.9026022 L10.3479554,32.4853532 C7.81263941,31.6707807 5.33858736,30.5915242 3.51613383,29.0438662" fill="#FFFFFE"></path></g></svg>';
    var RT_AUDIENCE_SPILLED_SVG_TEMPLATE = '<svg class="ns-rt-rating-logo ns-audience-spilled-logo" aria-hidden="true" viewBox="0 0 80 80" preserveAspectRatio="xMidYMid" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g transform="translate(0, 12.46)"><g><path d="M45.4780328,39.6152131 C45.9506885,38.4445902 47.6259672,37.7314098 48.8288525,37.8148197 C50.114623,37.904 51.4803934,39.2556066 51.719082,40.584918 C51.7634098,40.5366557 51.8098361,40.4910164 51.8570492,40.4461639 C52.2699016,40.0516721 52.7871475,39.7899016 53.3531803,39.7177705 C53.266623,39.3342951 53.2459016,38.9238033 53.3051803,38.5025574 C53.5142295,37.0205902 54.7034754,35.9092459 56.0650492,35.9202623 C56.9437377,35.9273443 57.714623,36.376918 58.216918,37.067541 C58.2617705,37.0114098 58.3113443,36.96 58.3596066,36.907541 C58.9340328,33.9152787 59.2980984,30.5345574 59.3809836,26.9468852 C59.6655738,14.6103607 56.5356066,4.53193443 52.3902951,4.43645902 C48.2447213,4.34072131 44.653377,14.2638689 44.3687869,26.6003934 C44.3687869,26.6003934 44.1492459,31.1000656 45.4780328,39.6152131" id="Fill-1" fill="#185A30"></path><path d="M73.5446557,53.1058361 C73.7896393,52.696918 73.9265574,52.2066885 73.9171148,51.6857705 C73.9965902,50.002623 72.8411803,48.4768525 71.2335738,48.6457705 C71.28,48.4532459 71.3104262,48.2531148 71.3222295,48.0466885 C71.4184918,46.3606557 70.2557377,44.907541 68.7249836,44.8013115 C68.6914098,44.7992131 68.6583607,44.7981639 68.6250492,44.7971148 C68.7842623,44.3787541 68.8632131,43.9116066 68.8351475,43.4166557 C68.7559344,42.0139016 67.7885902,40.832 66.5300984,40.5993443 C66.075541,40.5154098 65.634623,40.5571148 65.2309508,40.696918 C64.8495738,39.757377 64.0487869,39.060459 63.074623,38.9133115 C62.9975082,37.3878033 61.8956066,36.1321967 60.4768525,36.0338361 C59.5847869,35.9719344 58.7651148,36.3816393 58.216918,37.067541 C57.714623,36.376918 56.9437377,35.9276066 56.0650492,35.9204395 C54.7034754,35.9092459 53.5142295,37.0205902 53.3051803,38.5028197 C53.2459016,38.9238033 53.266623,39.3342951 53.3531803,39.7180328 C52.7871475,39.7899016 52.2699016,40.0519344 51.8570492,40.4461639 C51.8098361,40.4910164 51.7634098,40.5366557 51.719082,40.584918 C51.4803934,39.2556066 50.114623,37.9042623 48.8288525,37.8148197 C47.6259672,37.7314098 45.928918,38.4621639 45.4780328,39.6152131 C45.6758033,41.6259672 46.9327213,47.1071475 51.4788197,52.0241311 L51.5192131,52.0270164 C51.9575082,52.4236066 52.5298361,52.6420984 53.1399344,52.5878033 C53.5181639,52.5539672 53.8664918,52.418623 54.1665574,52.2098361 L54.2397377,52.2148197 C54.6397377,52.4925902 55.1205246,52.6379016 55.6285902,52.5927869 C55.8226885,52.5754754 56.0078689,52.5287869 56.1838689,52.4621639 C56.6192787,53.3623607 57.5902951,53.9441311 58.6740984,53.8486557 C59.5134426,53.7746885 60.2268852,53.3104262 60.6462951,52.6570492 L60.7821639,52.6664918 C61.2010492,53.0817049 61.7579016,53.323541 62.3585574,53.3054426 C62.855082,54.0566557 63.767082,54.5188197 64.7735082,54.4304262 C65.1525246,54.3971148 65.5063607,54.2874754 65.8219016,54.1214426 C66.3483279,54.7690492 67.2123279,55.1540984 68.1602623,55.0706885 C69.0974426,54.9885902 69.8890492,54.4689836 70.3197377,53.7505574 C70.7428197,54.0902295 71.272918,54.2725246 71.8358033,54.2224262 C72.3819016,54.1736393 72.8671475,53.9158033 73.2317377,53.5257705 L73.2925902,53.5299672 C73.3754754,53.4098361 73.4462951,53.2868197 73.5121311,53.1627541 C73.5137049,53.1603934 73.5150164,53.1577705 73.5163279,53.1554098 C73.5252459,53.1388852 73.5362623,53.122623 73.5446557,53.1058361" fill="#F9D320"></path><path d="M42.2090492,9.21232787 L6.56209836,12.7268197 C7.62203279,10.6709508 9.21206557,8.70662295 10.7472787,7.6957377 L45.2440656,3.18662295 C43.8793443,4.79422951 42.9272131,6.9762623 42.2090492,9.21232787 Z M45.2440656,49.5517377 L10.7472787,45.042623 C9.21206557,44.032 7.62203279,42.0674098 6.56209836,40.0118033 L42.2090492,43.5262951 C42.9272131,45.7620984 43.8793443,47.9443934 45.2440656,49.5517377 Z M5.07514754,36.5143607 C3.94885246,33.1108197 3.6,31.1323279 3.32170492,28.2992787 L39.9527869,28.7409836 C40.0427541,31.8701639 40.4668852,35.9202623 41.2031475,39.3707541 L5.07514754,36.5143607 Z M5.07514754,16.224 L41.2031475,13.3676066 C40.4668852,16.8180984 40.0427541,20.8681967 39.9527869,23.9976393 L3.32170492,24.439082 C3.6,21.6062951 3.94885246,19.627541 5.07514754,16.224 Z M56.7186885,3.84865574 C54.4333115,1.18767213 52.7926557,-0.0616393443 51.3872787,0.100721311 C51.1252459,0.134032787 11.4032787,5.67213115 11.4032787,5.67213115 C5.10006557,6.31318033 0.0624262295,15.4659672 0,26.3693115 C0.0624262295,37.2723934 5.10006557,46.4251803 11.4032787,47.0664918 C11.4032787,47.0664918 51.1997377,52.6247869 51.3872787,52.6376393 C51.7196066,52.635541 52.0477377,52.5909508 52.3711475,52.5080656 C52.0563934,52.4144262 51.7660328,52.2504918 51.5192131,52.0270164 L51.4788197,52.0241311 C46.9327213,47.1074098 45.6758033,41.6259672 45.4780328,39.6152131 C45.4785574,39.6136393 45.4796066,39.6123279 45.4801311,39.6107541 C45.4796066,39.6123279 45.4785574,39.6136393 45.4780328,39.6152131 C44.1492459,31.1000656 44.3687869,26.6003934 44.3687869,26.6003934 C44.653377,14.2638689 48.2447213,4.34072131 52.3902951,4.43619672 C56.5356066,4.53193443 59.6655738,14.6103607 59.3809836,26.9468852 C59.2980984,30.5345574 58.9340328,33.9152787 58.3596066,36.907541 C58.9497705,36.2562623 59.741377,35.9819016 60.4768525,36.0338361 C60.6121967,36.043541 60.7438689,36.0663607 60.872918,36.096 C63.3904262,22.3210492 60.7512131,8.87029508 56.7186885,3.84865574 L56.7186885,3.84865574 Z" fill="#129B47"></path></g><path d="M41.2031475,13.3676066 L5.07514754,16.224 C3.94885246,19.627541 3.6,21.6062951 3.32170492,24.439082 L39.9527869,23.997377 C40.0427541,20.8681967 40.4668852,16.8180984 41.2031475,13.3676066" fill="#FFFFFE"></path><path d="M45.2440656,3.18662295 L10.7472787,7.6957377 C9.21206557,8.70662295 7.62203279,10.6709508 6.56209836,12.7268197 L42.2090492,9.21232787 C42.9272131,6.9762623 43.8793443,4.79422951 45.2440656,3.18662295" fill="#FFFFFE"></path><path d="M6.56209836,40.011541 C7.62203279,42.0674098 9.21206557,44.032 10.7472787,45.042623 L45.2440656,49.5517377 C43.8793443,47.9443934 42.9272131,45.7620984 42.2090492,43.5262951 L6.56209836,40.011541" fill="#FFFFFE"></path><g transform="translate(3.15, 28)"><path d="M36.8052459,0.675409836 L0.174163934,0.233704918 C0.452459016,3.0664918 0.801311475,5.0452459 1.92760656,8.44878689 L38.0556066,11.3051803 C37.3193443,7.85468852 36.8952131,3.80459016 36.8052459,0.675409836" fill="#FFFFFE"></path></g></g></svg>';

    var rtIconInstanceCounter = 0;
    function instantiateRtIconSvg(template) {
        rtIconInstanceCounter += 1;
        var suffix = "-rt" + rtIconInstanceCounter;
        return template
            .replace(/id="(mask-2|path-1)"/g, function (m, id) { return 'id="' + id + suffix + '"'; })
            .replace(/url\(#(mask-2|mask-4|path-1|path-3|trakt-grad-a)\)/g, function (m, id) { return 'url(#' + id + suffix + ')'; })
            .replace(/xlink:href="#(mask-2|mask-4|path-1|path-3|trakt-grad-a)"/g, function (m, id) { return 'xlink:href="#' + id + suffix + '"'; });
    }

    /* Critics ("Tomatometer") thresholds for this skin: 85%+ -> Certified
       Fresh seal, 60-84% -> plain Fresh tomato, under 60% -> Rotten splat.
       (RT's own official Certified Fresh rule is 75%+ *and* a minimum
       review count/Top Critics count, which MDBList's rating endpoint
       doesn't expose - just the bare percentage - so 85% is used here as
       a stricter score-only stand-in for that review-count requirement.) */
    var RT_CRITICS_CERTIFIED_THRESHOLD = 85;
    var RT_CRITICS_FRESH_THRESHOLD = 60;
    /* RT's audience ("Popcornmeter") rule: 60%+ is Upright, under 60% is Spilled. */
    var RT_AUDIENCE_UPRIGHT_THRESHOLD = 60;

    function rtCriticsIconHtml(value) {
        if (typeof value === "number" && value >= RT_CRITICS_CERTIFIED_THRESHOLD) {
            return instantiateRtIconSvg(RT_CRITICS_CERTIFIED_FRESH_SVG_TEMPLATE);
        }
        if (typeof value === "number" && value < RT_CRITICS_FRESH_THRESHOLD) {
            return instantiateRtIconSvg(RT_CRITICS_ROTTEN_SVG_TEMPLATE);
        }
        return instantiateRtIconSvg(RT_CRITICS_FRESH_SVG_TEMPLATE);
    }

    function rtAudienceIconHtml(value) {
        if (typeof value === "number" && value < RT_AUDIENCE_UPRIGHT_THRESHOLD) {
            return instantiateRtIconSvg(RT_AUDIENCE_SPILLED_SVG_TEMPLATE);
        }
        return instantiateRtIconSvg(RT_AUDIENCE_UPRIGHT_SVG_TEMPLATE);
    }

    var METACRITIC_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 88" class="ns-badge-rating-mark ns-mc-rating-logo" aria-hidden="true"> <circle fill="#001B36" stroke="#FC0" stroke-width="4.6" cx="44" cy="44" r="41.6"/> <path transform="translate(-10-961) matrix(1.2756629,-1.3487733,1.3685717,1.2634987,-267.04706,1066.0743)" fill="#FFF" d="m126.73438,92.087002 5.05859,0 0,2.832031 c 1.80989-2.200501 3.96483-3.30076 6.46484-3.300781 1.32811,2.1e-5 2.48045,.273458 3.45703,.820312 .97655,.546895 1.77733,1.373717 2.40235,2.480469 .91144-1.106752 1.89451-1.933574 2.94922-2.480469 1.05466-0.546854 2.18096-0.820291 3.3789-0.820312 1.52341,2.1e-5 2.81247,.309265 3.86719,.927734 1.05466,.618509 1.84242,1.526711 2.36328,2.724609 .37757,.885434 .56637,2.317724 .56641,4.296875 l 0,13.26172-5.48828,0 0-11.85547 c-3e-5-2.057277-0.18883-3.385401-0.56641-3.984375-0.50784-0.781233-1.28909-1.171858-2.34375-1.171875-0.76825,1.7e-5-1.49091,.234392-2.16797,.703125-0.6771,.468766-1.16538,1.155614-1.46484,2.060547-0.2995,.904961-0.44924,2.333998-0.44922,4.287108 l 0,9.96094-5.48828,0 0-11.36719 c-2e-5-2.018214-0.0977-3.320296-0.29297-3.906248-0.19533-0.585922-0.49806-1.02212-0.9082-1.308594-0.41017-0.286442-0.96681-0.429671-1.66993-0.429688-0.84636,1.7e-5-1.60808,.227882-2.28515,.683594-0.6771,.455745-1.16212,1.113297-1.45508,1.972656-0.29298,.859389-0.43946,2.28517-0.43945,4.27734 l 0,10.07813-5.48828,0z"/> </svg>';

    var METACRITIC_USER_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="88" height="118" xmlns:c2pa="http://c2pa.org/manifest" viewBox="0 0 88 118" style="overflow:visible" class="ns-badge-rating-mark ns-mc-rating-logo" aria-hidden="true"> <circle fill="#001B36" stroke="#FC0" stroke-width="4.6" cx="44" cy="44" r="41.6"/> <path transform="translate(-10-961) matrix(1.2756629,-1.3487733,1.3685717,1.2634987,-267.04706,1066.0743)" fill="#FFF" d="m126.73438,92.087002 5.05859,0 0,2.832031 c 1.80989-2.200501 3.96483-3.30076 6.46484-3.300781 1.32811,2.1e-5 2.48045,.273458 3.45703,.820312 .97655,.546895 1.77733,1.373717 2.40235,2.480469 .91144-1.106752 1.89451-1.933574 2.94922-2.480469 1.05466-0.546854 2.18096-0.820291 3.3789-0.820312 1.52341,2.1e-5 2.81247,.309265 3.86719,.927734 1.05466,.618509 1.84242,1.526711 2.36328,2.724609 .37757,.885434 .56637,2.317724 .56641,4.296875 l 0,13.26172-5.48828,0 0-11.85547 c-3e-5-2.057277-0.18883-3.385401-0.56641-3.984375-0.50784-0.781233-1.28909-1.171858-2.34375-1.171875-0.76825,1.7e-5-1.49091,.234392-2.16797,.703125-0.6771,.468766-1.16538,1.155614-1.46484,2.060547-0.2995,.904961-0.44924,2.333998-0.44922,4.287108 l 0,9.96094-5.48828,0 0-11.36719 c-2e-5-2.018214-0.0977-3.320296-0.29297-3.906248-0.19533-0.585922-0.49806-1.02212-0.9082-1.308594-0.41017-0.286442-0.96681-0.429671-1.66993-0.429688-0.84636,1.7e-5-1.60808,.227882-2.28515,.683594-0.6771,.455745-1.16212,1.113297-1.45508,1.972656-0.29298,.859389-0.43946,2.28517-0.43945,4.27734 l 0,10.07813-5.48828,0z"/> <text x="44" y="112" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="34" fill="#FFF">users</text> </svg>';

    var TRAKT_ICON_SVG = '<img class="ns-trakt-rating-logo" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+IDxkZWZzPiA8cmFkaWFsR3JhZGllbnQgaWQ9InRyYWt0LWdyYWQtYSIgY3g9IjQ4LjQ2IiBjeT0iLS45NSIgcj0iNjQuODQiIGZ4PSI0OC40NiIgZnk9Ii0uOTUiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4gPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjOWY0MmM2Ii8+IDxzdG9wIG9mZnNldD0iLjI3IiBzdG9wLWNvbG9yPSIjYTA0MWMzIi8+IDxzdG9wIG9mZnNldD0iLjQyIiBzdG9wLWNvbG9yPSIjYTQzZWJiIi8+IDxzdG9wIG9mZnNldD0iLjUzIiBzdG9wLWNvbG9yPSIjYWEzOWFkIi8+IDxzdG9wIG9mZnNldD0iLjY0IiBzdG9wLWNvbG9yPSIjYjQzMzlhIi8+IDxzdG9wIG9mZnNldD0iLjczIiBzdG9wLWNvbG9yPSIjYzAyYjgxIi8+IDxzdG9wIG9mZnNldD0iLjgyIiBzdG9wLWNvbG9yPSIjY2YyMDYxIi8+IDxzdG9wIG9mZnNldD0iLjkiIHN0b3AtY29sb3I9IiNlMTE0M2MiLz4gPHN0b3Agb2Zmc2V0PSIuOTciIHN0b3AtY29sb3I9IiNmNTA2MTMiLz4gPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSJyZWQiLz4gPC9yYWRpYWxHcmFkaWVudD4gPC9kZWZzPiA8cGF0aCBkPSJNNDggMTEuMjZ2MjUuNDdDNDggNDIuOTUgNDIuOTUgNDggMzYuNzMgNDhIMTEuMjZDNS4wNCA0OCAwIDQyLjk1IDAgMzYuNzNWMTEuMjZDMCA1LjA0IDUuMDQgMCAxMS4yNiAwaDI1LjQ3YTExLjI0IDExLjI0IDAgMCAxIDkuNjIgNS40Yy4xOC4yOS4zNC41OS41Ljg5LjMzLjY4LjYgMS4zOS43OSAyLjE0LjEuMzcuMTguNzYuMjMgMS4xNS4wOS41NC4xMyAxLjExLjEzIDEuNjhaIiBzdHlsZT0iZmlsbDp1cmwoI3RyYWt0LWdyYWQtYSkiLz4gPHBhdGggZD0ibTEzLjYyIDE3Ljk3IDcuOTIgNy45MiAxLjQ3LTEuNDctNy45Mi03LjkyLTEuNDcgMS40N1ptMTQuMzkgMTQuNCAxLjQ3LTEuNDYtMi4xNi0yLjE2TDQ3LjY0IDguNDNjLS4xOS0uNzUtLjQ2LTEuNDYtLjc5LTIuMTRMMjQuMzkgMjguNzVsMy42MiAzLjYyWm0tMTUuMDktMTMuNy0xLjQ2IDEuNDYgMTQuNCAxNC40IDEuNDYtMS40N0wyMyAyOC43NSA0Ni4zNSA1LjRjLS4zNi0uNi0uNzgtMS4xNi0xLjI1LTEuNjhMMjEuNTQgMjcuMjhsLTguNjItOC42MVptMzQuOTUtOS4wOUwyOC43IDI4Ljc1bDEuNDcgMS40Nkw0OCAxMi4zOHYtMS4xMmMwLS41Ny0uMDQtMS4xNC0uMTMtMS42OFpNMjUuMTYgMjIuMjdsLTcuOTItNy45Mi0xLjQ3IDEuNDcgNy45MiA3LjkyIDEuNDctMS40N1ptMTYuMTYgMTIuODVjMCAzLjQyLTIuNzggNi4yLTYuMiA2LjJIMTIuODhjLTMuNDIgMC02LjItMi43OC02LjItNi4yVjEyLjg4YzAtMy40MiAyLjc4LTYuMjEgNi4yLTYuMjFoMjAuNzhWNC42SDEyLjg4Yy00LjU2IDAtOC4yOCAzLjcxLTguMjggOC4yOHYyMi4yNGMwIDQuNTYgMy43MSA4LjI4IDguMjggOC4yOGgyMi4yNGM0LjU2IDAgOC4yOC0zLjcxIDguMjgtOC4yOHYtMy41MWgtMi4wN3YzLjUxWiIgc3R5bGU9ImZpbGw6I2ZmZiIvPiA8L3N2Zz4=" alt="Trakt" aria-hidden="true" />';

    var LETTERBOXD_ICON_SVG = '<svg width="500px" height="500px" viewBox="0 0 500 500" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="ns-badge-rating-mark ns-lb-rating-logo" aria-hidden="true"> <defs> <rect id="path-1" x="0" y="0" width="129.847328" height="141.389313"></rect> <rect id="path-3" x="0" y="0" width="129.847328" height="141.389313"></rect> </defs> <g id="letterboxd-decal-dots-pos-rgb" stroke="none" stroke-width="1" fill="none" fill-rule="evenodd"> <circle id="Circle" fill="#202830" cx="250" cy="250" r="250"></circle> <g id="dots-neg" transform="translate(61.000000, 180.000000)"> <g id="Dots"> <ellipse id="Green" fill="#00E054" cx="189" cy="69.9732824" rx="70.0786517" ry="69.9732824"></ellipse> <g id="Blue" transform="translate(248.152672, 0.000000)"> <mask id="mask-2" fill="white"> <use xlink:href="#path-1"></use> </mask> <g id="Mask"></g> <ellipse fill="#40BCF4" mask="url(#mask-2)" cx="59.7686766" cy="69.9732824" rx="70.0786517" ry="69.9732824"></ellipse> </g> <g id="Orange"> <mask id="mask-4" fill="white"> <use xlink:href="#path-3"></use> </mask> <g id="Mask"></g> <ellipse fill="#FF8000" mask="url(#mask-4)" cx="70.0786517" cy="69.9732824" rx="70.0786517" ry="69.9732824"></ellipse> </g> <path d="M129.539326,107.022244 C122.810493,96.2781677 118.921348,83.5792213 118.921348,69.9732824 C118.921348,56.3673435 122.810493,43.6683972 129.539326,32.9243209 C136.268159,43.6683972 140.157303,56.3673435 140.157303,69.9732824 C140.157303,83.5792213 136.268159,96.2781677 129.539326,107.022244 Z" id="Overlap" fill="#FFFFFF"></path> <path d="M248.460674,32.9243209 C255.189507,43.6683972 259.078652,56.3673435 259.078652,69.9732824 C259.078652,83.5792213 255.189507,96.2781677 248.460674,107.022244 C241.731841,96.2781677 237.842697,83.5792213 237.842697,69.9732824 C237.842697,56.3673435 241.731841,43.6683972 248.460674,32.9243209 Z" id="Overlap" fill="#FFFFFF"></path> </g> </g> </g> </svg>';

    var ROGER_EBERT_ICON_SVG = '<svg version="1.1" id="layer" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="136 136 380 380" style="enable-background:new 0 0 652 652;" xml:space="preserve" xmlns:c2pa="http://c2pa.org/manifest" class="ns-badge-rating-mark ns-re-rating-logo" aria-hidden="true"> <style type="text/css"> .st0{fill:#B99B68;} </style> <circle cx="326" cy="326" r="190" fill="#FFFFFF"/> <g transform="translate(319,341) scale(2.3) translate(-73.58367427741851,-332.7291144252343)"> <path class="st0" d="M124.9,315.6c-2.4-1.3-7.9-1.7-18.2-1.3h-0.6c-3.2,0-6.2,0.4-8.4,0.6h-0.2c-0.4,0-1.1,0-1.5,0.2 c0.4-1.7,1.1-4.1,1.9-7.1c1.5-6.4,0.9-9.9,0.4-13.1c-0.2-0.6-0.2-1.3-0.2-2.1c-0.4-4.3-2.6-10.1-4.1-12.9c-2.1-3.9-7.7-4.5-8.4-4.5 c-1.3-0.2-3.6-0.2-4.7,1.5c-0.4,0.6-0.6,1.9-0.9,5.1v0.4c-0.2,0-0.2,0.9-0.2,2.1v2.4c0,2.1-0.2,4.7-0.2,6.4 c-0.2,3.6-2.8,8.6-3.6,10.1c-0.9,1.5-3.4,5.1-5.1,7.7c-1.1,1.5-2.1,3-2.6,3.9c-1.7,2.8-5.4,3-5.8,3c-0.2,0-0.4,0.2-0.4,0.2 c-0.2,0.2-0.2,0.4-0.2,0.4l0.2,2.1c0,0,0,0.4,0.2,0.6c0,0,0.2,0.2,0.6,0.2c2.4-0.2,6.4-1.1,8.8-4.9c0.4-0.6,1.3-1.9,2.4-3.2l0.2-0.4 c1.9-2.8,4.3-6.2,5.4-7.9c1.5-2.6,3.9-7.5,4.1-11.6c0-1.7,0.2-4.1,0.2-6v-1.5c0-1.7,0.2-3.2,0.2-3.6v-0.4c0-1.5,0.2-2.6,0.2-3 c0.2,0,0.6,0,1.3,0c0.9,0,4.1,0.6,4.9,2.4c1.5,2.6,3.2,7.7,3.6,11.6c0,0.6,0.2,1.3,0.2,1.9v0.4c0.4,3,1.1,6-0.4,11.8 c-1.7,6.9-2.4,8.4-2.6,8.8c-0.2,0.6-0.2,1.5,0.2,1.9c0.9,1.3,1.9,1.1,6.2,0.6c2.4-0.2,5.1-0.4,8.1-0.6h0.6 c12.4-0.4,15.4,0.4,16.1,0.9c1.9,1.1,2.8,1.7,1.9,5.1l-0.6,2.1c-0.2,0.6-0.6,1.1-1.1,1.3c-0.6,0.4-1.7,0.4-3.6,0.4h-3.2 c-0.6,0-1.3,0.2-1.7,0.6c-0.4,0.4-0.4,0.9-0.6,1.5c0,0.2-0.2,0.2-0.2,0.4c-0.2,0.4-0.2,0.6,0,0.9c0.2,0.2,0.6,0.4,0.9,0.4 c1.1,0,3,0,4.9,0c2.4,0,4.1-0.2,5.4-0.9c0,0,0.4-0.2,1.3-0.9c0.6-0.6,1.5-2.1,2.1-3.9c0,0,0-0.2,0-0.4s0.2-0.6,0.2-0.6v-0.2 C129.7,319.4,127.9,317.3,124.9,315.6z M120.9,344.5c-0.4,0-1.5,0.4-2.1,0.6c-0.4,0.2-0.6,0.6-0.9,1.1c-0.2,0.4-0.2,0.6-0.2,0.9 s-0.2,0.6-0.2,1.1l0,0c0,0.2-0.2,0.4-0.2,0.6l-0.2,0.6c-0.6,1.5-1.3,1.9-4.7,1.9h-0.4c-0.9,0-1.9,0-2.8,0c-0.4,0-1.3,0-1.7,0.6 c-0.4,0.4-0.4,0.9-0.6,1.5c0,0.2-0.2,0.2-0.2,0.4c-0.2,0.4-0.2,0.6,0,0.9c0.2,0.2,0.6,0.4,0.9,0.4c1.1,0,3,0,4.9,0 c4.9,0,7.1-1.1,8.4-4.5l0,0c0.4-0.9,0.6-1.7,0.9-2.8c0.2-0.4,0.4-1.1,0.6-1.7c0-0.4,0.2-0.9,0-1.1 C121.7,344.3,121.3,344.3,120.9,344.5z M116.1,356.1v0.2V356.1C116.1,356.1,116.1,356.3,116.1,356.1h-0.4h-0.2h-0.2 c-0.6,0-1.1,0.2-1.5,0.4c-0.2,0.2-0.6,0.6-1.1,1.5v0.2c-2.4,4.3-3.6,4.9-4.9,5.4h-0.2c-3,1.3-9.9,1.5-15.2,0.4 c-1.1-0.2-2.4-0.4-3.6-0.6l0,0c-4.7-0.9-9.4-1.7-12.2-1.3l-11.4,1.7c0,0-0.2,0-0.4,0.2c-0.2,0.2-0.2,0.4-0.2,0.9c0,0,0,1.3,0.2,1.9 c0,0.2,0.2,0.4,0.2,0.6c0.2,0.2,0.6,0,0.6,0l11.6-1.7c2.4-0.4,7.1,0.4,11.1,1.3c1.3,0.2,2.4,0.4,3.6,0.6c2.4,0.4,5.1,0.6,7.7,0.6 c4.1,0,7.5-0.4,9.6-1.3c2.6-1.1,4.7-2.4,7.9-9.4c0.4-0.6,0.4-1.1,0.2-1.5C117.2,356.1,116.6,356.1,116.1,356.1z M124.7,333 c-0.4,0-1.5,0.4-2.1,0.6l0,0l0,0c-0.4,0.2-0.6,0.6-0.6,0.9c-0.2,0.4-0.2,0.6-0.2,0.9c0,0.2-0.2,0.6-0.2,1.1v0.2 c0,0.2-0.2,0.4-0.2,0.4l-0.6,0.6c-0.4,0.9-0.6,1.3-1.3,1.5c-0.6,0.2-1.9,0.4-3.4,0.4c-1.1,0-2.1,0-3.2,0c-0.4,0-0.9,0-1.3,0.4 c-0.2,0.2-0.4,0.2-0.4,0.4c-0.4,0.4-0.4,0.9-0.6,1.5c0,0.2-0.2,0.2-0.2,0.4c-0.2,0.4-0.2,0.6,0,0.9c0.2,0.2,0.6,0.4,0.9,0.4 c1.1,0,3,0,4.9,0c2.6,0,4.3-0.4,5.6-1.1c1.3-0.6,2.1-1.7,2.8-3.6l0,0c0.4-0.9,0.6-1.9,1.1-2.8c0.2-0.4,0.4-1.1,0.4-1.5 c0.2-0.4,0.2-0.9,0-1.1C125.4,332.7,124.9,332.7,124.7,333z"/> <path d="M57.8,319L57.8,319c0-1.1-0.9-1.7-1.9-1.7h-9.4c-0.2,0-0.6,0-0.9,0.2s0,0.6,0,0.9s0.2,0.2,0.2,0.4c0.2,0.4,0.4,0.9,0.6,1.3 c0.4,0.6,1.5,0.6,1.9,0.6h5.1c0.4,0,0.4,0,0.4,0.2l1.3,19.5c0,0.2,0,0.4,0,0.6c0,0.4,0,0.4-0.2,0.4h-6c-0.2,0-0.6,0-0.9,0.2 c-0.2,0.2,0,0.6,0,0.9s0.2,0.2,0.2,0.4c0.2,0.4,0.4,0.9,0.6,1.5c0.4,0.6,1.3,0.6,1.9,0.6H55c0.4,0,0.6,0,0.6,0.2l1.3,19.9 c0,0.4,0,0.4-0.2,0.4h-8.6c0,0-0.4,0-0.6,0c-0.4,0-2.4-0.2-2.8-1.9c-0.2-0.6-0.2-2.1-0.4-2.6c0,0-0.4-6.4-0.6-9.9 c0-0.6,0-1.1-0.2-1.7l0,0v-0.4l0,0l0,0V349l0,0c-0.2-2.1-0.9-3.4-2.1-4.7l0,0l0,0c-0.4-0.2-0.9-0.6-1.3-0.9l0,0 c1.5-1.3,2.1-2.4,2.6-3.9c0.4-1.5,0.2-5.1,0.2-5.4l-0.4-9.2c0-0.2-0.2-2.1-0.4-3.2c-0.9-3.9-4.9-4.7-6.4-4.7h-8.1 c-0.4,0-1.1,0.2-1.3,0.6c-0.4,0.4-0.6,0.9-0.4,1.3l2.8,49.1c0,1.1,0.9,1.7,1.9,1.7h6c0.2,0,0.6,0,0.9-0.2c0.2-0.2,0-0.6,0-0.9 c0-0.2,0-0.2-0.2-0.4c-0.2-0.4-0.4-0.9-0.6-1.5c-0.4-0.6-1.5-0.6-1.9-0.6h-1.7c-0.6,0-0.6,0-0.6-0.2l-2.8-44.8h5.8 c0,0,2.4,0,2.8,1.9c0.2,0.6,0.2,2.4,0.4,2.6c0,0,0.2,4.7,0.4,9c0.4,5.1-0.4,5.8-0.9,6.2c-0.9,0.9-1.5,1.5-1.9,1.7 c-0.4,0.2-0.9,0.4-1.1,0.6c-0.2,0-0.4,0.2-0.4,0.2s-0.2,0.2-0.2,0.4c0,0.2,0.2,0.4,1.1,0.9c0.6,0.2,1.3,0.6,2.6,1.5 c0.4,0.2,0.9,0.6,1.3,1.3c0,0,0,0.2,0.2,0.2c-0.2,0-0.2,0.2-0.2,0.4c0.4,1.1,0.6,2.1,0.6,3.4c0,0.2,0,0.6,0,0.9l0.6,9.4 c0,0.6,0.2,2.1,0.4,3.2c0.9,3.9,4.9,4.7,6.4,4.7h11.6c0.4,0,1.1-0.2,1.3-0.6c0.4-0.4,0.6-0.9,0.4-1.3L57.8,319z"/> </g> </svg>';

    /**
     * Small colored-square "monogram" mark used only as a last-resort
     * fallback, for any MDBList rating source with neither bundled brand
     * logo/SVG artwork above nor one of the pre-existing IMDb/TMDB/RT icons -
     * e.g. a source MDBList adds in the future that this skin doesn't
     * recognize yet. Kept as a plain shape/text rather than a real logo
     * asset so an unrecognized source still renders *something* instead of
     * silently disappearing.
     */
    function monogramIconSvg(letters, background) {
        return '<svg class="ns-badge-rating-mark" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<rect x="1" y="1" width="22" height="22" rx="5" fill="' + background + '"/>' +
            '<text x="12" y="16" text-anchor="middle" font-size="' + (letters.length > 1 ? "9" : "12") + '" ' +
            'font-weight="700" font-family="Arial, Helvetica, sans-serif" fill="#fff">' + letters + '</text>' +
            '</svg>';
    }

    /**
     * Maps an MDBList rating source id to the icon HTML used in front of
     * its score - real brand logo artwork for every source this skin ships
     * an SVG for (IMDb/TMDB/RT critics+audience/Metacritic critics+users/
     * Trakt/Letterboxd/Roger Ebert), a plain monogram mark as a last resort
     * for anything else. The RT critics/audience marks are dynamic - which
     * of the three critics seals or two audience marks comes back depends
     * on the raw score (see rtCriticsIconHtml()/rtAudienceIconHtml() above) -
     * so those two cases need the raw numeric value the other sources ignore.
     *
     * @param {string} source
     * @param {number} [value] raw 0-100 score; only read for tomatoes/tomatoesaudience.
     */
    function ratingSourceIconHtml(source, value) {
        switch (source) {
            case "imdb": return IMDB_ICON_HTML;
            case "tmdb": return TMDB_ICON_HTML;
            case "tomatoes": return rtCriticsIconHtml(value);
            case "tomatoesaudience": return rtAudienceIconHtml(value);
            case "metacritic": return METACRITIC_ICON_SVG;
            case "metacriticuser": return METACRITIC_USER_ICON_SVG;
            case "trakt": return TRAKT_ICON_SVG;
            case "letterboxd": return instantiateRtIconSvg(LETTERBOXD_ICON_SVG);
            case "rogerebert": return ROGER_EBERT_ICON_SVG;
            default: return monogramIconSvg((source || "?").slice(0, 2).toUpperCase(), "#3a3a3a");
        }
    }

    /**
     * All of an item's enabled rating-source scores in one call, via the
     * plugin's own server-side endpoint (which proxies MDBList using the
     * API key set on the plugin's config page, and applies that page's
     * enable/reorder list - see Api/FinoraUIController.cs). Kept as its
     * own small client so the same in-flight/settled request is reused
     * instead of re-fetched every time buildMetaRow() runs for the same
     * title in one page session.
     */
    var mdblistRatingsCache = {};
    function fetchMdblistRatings(imdbId, tmdbId, type) {
        if (!imdbId && !tmdbId) {
            return Promise.resolve([]);
        }

        var cacheKey = imdbId ? ("id:" + imdbId) : ("tmdb:" + type + ":" + tmdbId);

        if (mdblistRatingsCache.hasOwnProperty(cacheKey)) {
            return mdblistRatingsCache[cacheKey];
        }

        var params = {};
        if (imdbId) {
            params.imdbId = imdbId;
        } else {
            params.tmdbId = tmdbId;
            params.type = type;
        }

        var query = imdbId
            ? "imdbId=" + encodeURIComponent(imdbId)
            : "tmdbId=" + encodeURIComponent(tmdbId) + "&type=" + encodeURIComponent(type);

        var url;
        try {
            url = (window.ApiClient && typeof window.ApiClient.getUrl === "function")
                ? window.ApiClient.getUrl("FinoraUI/Ratings", params)
                : "/FinoraUI/Ratings?" + query;
        } catch (err) {
            url = "/FinoraUI/Ratings?" + query;
        }

        var promise = fetch(url).then(function (res) {
            if (!res.ok) {
                return [];
            }
            return res.json();
        }).then(function (data) {
            return (data && data.ratings) ? data.ratings : [];
        }).catch(function () {
            return [];
        });

        mdblistRatingsCache[cacheKey] = promise;
        return promise;
    }

    /**
     * Age/content rating lookup, via the plugin's own server-side endpoint
     * (which proxies TMDB using the API key set on the plugin's config page
     * - see Api/FinoraUIController.cs). Jellyfin's own OfficialRating
     * field only ever holds ONE certification - whichever country the
     * server's metadata settings are configured for - so this asks TMDB for
     * every country's certification and prefers US, falling back to India
     * (IN, prefixed "IN-") only when a title has no US certification.
     * Same in-flight/settled request caching as fetchMdblistRatings() above.
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
                url = window.ApiClient.getUrl("FinoraUI/AgeRating", params);
            } else {
                url = "/FinoraUI/AgeRating?tmdbId=" + encodeURIComponent(tmdbId) + "&type=" + encodeURIComponent(type);
            }
        } catch (err) {
            url = "/FinoraUI/AgeRating?tmdbId=" + encodeURIComponent(tmdbId) + "&type=" + encodeURIComponent(type);
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
            var hasAtmos = false;
            var hasTrueHD = false;
            var hasDTSX = false;
            var hasDTS = false;
            var bestAudio = null;
            var atmosStream = null;
            var trueHDStream = null;
            var dtsStream = null;
            var moreCh = function (a, c) { return !a || (c.Channels || 0) > (a.Channels || 0); };

            for (var i = 0; i < streams.length; i++) {
                var s = streams[i];
                if (s.Type === "Video" && !videoStream) {
                    videoStream = s;
                } else if (s.Type === "Audio" && !audioStream) {
                    audioStream = s;
                } else if (s.Type === "Subtitle") {
                    hasSubtitle = true;
                }

                /* Audio codec badges: scan EVERY audio track, not just the first. */
                if (s.Type === "Audio") {
                    var aText = ((s.Profile || "") + " " + (s.DisplayTitle || "") + " " + (s.Title || "")).toLowerCase();
                    var aCodec = (s.Codec || "").toLowerCase();
                    var aSpatial = (s.AudioSpatialFormat || "").toString().toLowerCase();
                    if (aSpatial === "dolbyatmos" || aText.indexOf("atmos") !== -1) {
                        hasAtmos = true;
                        if (moreCh(atmosStream, s)) { atmosStream = s; }
                    }
                    if (aCodec === "truehd") {
                        hasTrueHD = true;
                        if (moreCh(trueHDStream, s)) { trueHDStream = s; }
                    }
                    if (aSpatial === "dtsx" || /dts[\s:\-]?x\b/.test(aText)) {
                        hasDTSX = true;
                    }
                    if (aCodec === "dts" || aCodec === "dca" || aText.indexOf("dts") !== -1) {
                        hasDTS = true;
                        if (moreCh(dtsStream, s)) { dtsStream = s; }
                    }
                    if (moreCh(bestAudio, s)) { bestAudio = s; }
                }
            }

            /* Channel badge follows the highest badge codec (Atmos > TrueHD > DTS);
               with no codec badge it falls back to the track with the most channels. */
            var channelStream = atmosStream || trueHDStream || dtsStream || bestAudio;
            if (channelStream) { audioStream = channelStream; }

            if (videoStream) {
                var width = videoStream.Width || 0;
                if (width >= 3800) {
                    badges.push("4K");
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

            /* Only DTS:X / TrueHD / Atmos, lowest hierarchy first so the highest
               (Atmos) is always last. Any other audio codec shows nothing. */
            if (hasDTSX) { badges.push("DTS:X"); } else if (hasDTS) { badges.push("DTS"); }
            if (hasTrueHD) { badges.push("TrueHD"); }
            if (hasAtmos) { badges.push("Atmos"); }

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
     *   -> rating badges (unbordered, brand icon/monogram + score) - every
     *      MDBList source enabled on the plugin's config page, in the order
     *      configured there. Resolved BEFORE this row is built (see
     *      resolveItemRatings()), so the slot is reserved synchronously
     *      and the badges land in place instead of appearing a few hundred
     *      milliseconds after the rest of the metadata.
     *   -> quality/audio/CC badges (bordered, detail screen only)
     * Every piece is independently optional - an item with no ratings
     * (or no MDBList key configured) just doesn't get any rating chips,
     * nothing else shifts/breaks.
     *
     * @param {object} item
     * @param {{includeQualityBadges: boolean}} [opts] includeQualityBadges
     *   defaults to true (detail hero); pass false for the home hero so
     *   codec/audio badges only ever appear on the detail screen.
     */
    function buildMetaRow(item, opts) {
        var includeQualityBadges = !opts || opts.includeQualityBadges !== false;
        var ratings = (opts && Object.prototype.hasOwnProperty.call(opts, "ratings") && opts.ratings) || [];

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
           still what's used for the TmdbApiKey-not-configured case. Already
           a final display string either way, so it's used as-is rather
           than run back through normalizeAgeRating(). */
        var ageRatingOverride = opts && Object.prototype.hasOwnProperty.call(opts, "ageRating") ? opts.ageRating : null;
        var ageRating = ageRatingOverride || normalizeAgeRating(item.OfficialRating);
        if (ageRating) { row.appendChild(makeBadge(ageRating)); }

        for (var i = 0; i < ratings.length; i++) {
            row.appendChild(makeRatingBadge(ratingSourceIconHtml(ratings[i].source, ratings[i].value), ratings[i].display));
        }

        if (includeQualityBadges) {
            var qualityBadges = buildQualityBadges(item);
            for (var j = 0; j < qualityBadges.length; j++) {
                row.appendChild(makeBadge(qualityBadges[j]));
            }
        }
        return row;
    }

    /* Resolve every enabled MDBList rating before rendering a metadata
       row. The result is cached by fetchMdblistRatings(), including
       in-flight requests, so Home and Details can share the same
       request. Prefers the item's IMDb id (a single, simple MDBList
       lookup); falls back to its TMDB id + type when no IMDb id is
       present on the item. */
    function resolveItemRatings(item) {
        if (!item) {
            return Promise.resolve([]);
        }

        var imdbId = item.ProviderIds &&
            (item.ProviderIds.Imdb || item.ProviderIds.IMDB || item.ProviderIds.imdb);

        if (imdbId) {
            return fetchMdblistRatings(imdbId, null, null);
        }

        var tmdbId = item.ProviderIds &&
            (item.ProviderIds.Tmdb || item.ProviderIds.TMDB || item.ProviderIds.tmdb);
        var type = item.Type === "Movie" ? "movie" : (item.Type === "Series" ? "tv" : null);
        if (!tmdbId || !type) {
            return Promise.resolve([]);
        }

        return fetchMdblistRatings(null, tmdbId, type);
    }

    /* Resolve the US-first/India-fallback age rating before rendering a
       metadata row - same reasoning and caching as resolveItemRatings()
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
            return null;
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

        return row;
    }

    var parentsGuideCache = {};

    function fetchParentsGuide(imdbId) {
        if (!imdbId) return Promise.resolve([]);
        if (parentsGuideCache[imdbId]) return parentsGuideCache[imdbId];

        var promise = fetch("https://api.tiffara.com/titles/" + imdbId + "/parentsGuide")
            .then(function(res) {
                if (!res.ok) return [];
                return res.json();
            })
            .then(function(data) {
                var advisoriesArray = data && (data.parentsGuide || data.contentAdvisories || (Array.isArray(data) ? data : null));
                if (!advisoriesArray) return [];

                var advisories = [];
                var categoryMapping = {
                    "SEX_NUDITY": "Nudity",
                    "NUDITY": "Nudity",
                    "SEXUAL_CONTENT": "Nudity",
                    "VIOLENCE": "Violence",
                    "PROFANITY": "Language",
                    "ALCOHOL_DRUGS": "Alcohol",
                    "FRIGHTENING_INTENSE_SCENES": "Frightening"
                };
                for (var i = 0; i < advisoriesArray.length; i++) {
                    var ad = advisoriesArray[i];
                    if (ad && ad.category) {
                        var maxVotes = -1;
                        var maxSeverity = "none";
                        if (ad.severityBreakdowns) {
                            for (var j = 0; j < ad.severityBreakdowns.length; j++) {
                                var bd = ad.severityBreakdowns[j];
                                if (bd.voteCount > maxVotes) {
                                    maxVotes = bd.voteCount;
                                    maxSeverity = bd.severityLevel;
                                }
                            }
                        }
                        if (maxSeverity !== "none") {
                            var mapped = categoryMapping[ad.category] || categoryMapping[ad.category.replace(/&/g, "_").toUpperCase()];
                            if (mapped && advisories.indexOf(mapped) === -1) {
                                advisories.push(mapped);
                            }
                        }
                    }
                }
                return advisories;
            })
            .catch(function() {
                return [];
            });
        
        parentsGuideCache[imdbId] = promise;
        return promise;
    }

    function fetchImdbId(item) {
        var imdbId = item.ProviderIds && (item.ProviderIds.Imdb || item.ProviderIds.IMDB || item.ProviderIds.imdb);
        if (imdbId) {
            return Promise.resolve(imdbId);
        }

        var tmdbId = item.ProviderIds && (item.ProviderIds.Tmdb || item.ProviderIds.TMDB || item.ProviderIds.tmdb);
        var type = item.Type === "Movie" ? "movie" : (item.Type === "Series" ? "tv" : null);

        if (!tmdbId || !type) {
            return Promise.resolve(null);
        }

        var url;
        try {
            var params = { tmdbId: tmdbId, type: type };
            if (window.ApiClient && typeof window.ApiClient.getUrl === "function") {
                url = window.ApiClient.getUrl("FinoraUI/ImdbId", params);
            } else {
                url = "/FinoraUI/ImdbId?tmdbId=" + encodeURIComponent(tmdbId) + "&type=" + encodeURIComponent(type);
            }
        } catch (err) {
            url = "/FinoraUI/ImdbId?tmdbId=" + encodeURIComponent(tmdbId) + "&type=" + encodeURIComponent(type);
        }

        return fetch(url).then(function(res) {
            if (res.status === 204 || !res.ok) return null;
            return res.json();
        }).then(function(data) {
            return data && data.imdb_id ? data.imdb_id : null;
        }).catch(function() {
            return null;
        });
    }

    function appendAsyncContentAdvisoryRow(container, item, tagsRow) {
        var row = document.createElement("div");
        row.className = "ns-info-row ns-info-row-group-end";
        row.style.display = "none";
        
        var labelEl = document.createElement("div");
        labelEl.className = "ns-info-label";
        labelEl.textContent = "Content advisories";

        var valueEl = document.createElement("div");
        valueEl.className = "ns-info-value";

        row.appendChild(labelEl);
        row.appendChild(valueEl);
        container.appendChild(row);

        fetchImdbId(item).then(function(imdbId) {
            if (!imdbId) return [];
            return fetchParentsGuide(imdbId);
        }).then(function(advisories) {
            if (advisories && advisories.length > 0) {
                valueEl.textContent = advisories.join(", ");
                row.style.display = "";
                if (tagsRow) {
                    tagsRow.classList.remove("ns-info-row-group-end");
                }
            }
        });
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
        var tagsRow = appendInfoRow(content, "Tags", item.Tags && item.Tags.length ? item.Tags.join(", ") : "", true);
        appendAsyncContentAdvisoryRow(content, item, tagsRow);
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

            /* TV show (series) root page has no video/audio tracks, so the Video box
               would always be empty: show only the About box, full width. */
            if (item.Type === "Series") {
                grid.classList.add("ns-info-grid-single");
                heroContent.appendChild(grid);
                heroContent.dataset.nsInfoAttached = "1";
                return true;
            }

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

    function buildDetailHero(page, item, ratings, ageRating) {
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

        metaHighlights.appendChild(buildMetaRow(item, { includeQualityBadges: true, ratings: ratings, ageRating: ageRating }));

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
                setupClampedSynopsis(synopsisEl, item.Overview);
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
                    Promise.all([resolveItemRatings(item), resolveItemAgeRating(item)]).then(function (results) {
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
    /**
     * Detail-screen synopsis limited to 4 lines.
     * 1) Keeps the default paragraph width if the text fits in 4 lines.
     * 2) Only if it does NOT fit, widens the paragraph (smallest width that
     *    fits, capped at SYNOPSIS_MAX_WIDTH_PX / the viewport edge).
     * 3) If it still does not fit at the widest width, truncates it and shows
     *    the same inline "More" / "Less" button as the person detail screen.
     */
    var SYNOPSIS_MAX_LINES = 4;
    var SYNOPSIS_MAX_WIDTH_PX = 1200;

    function setupClampedSynopsis(synopsisEl, fullText) {
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
        var attempts = 0;
        var resizeTimer = null;

        toggleBtn.addEventListener("click", function (e) {
            e.preventDefault();
            isExpanded = !isExpanded;
            textEl.textContent = isExpanded ? fullText : truncatedText;
            toggleBtn.textContent = isExpanded ? "Less" : "More";
        });

        function fit() {
            if (!synopsisEl.isConnected) {
                if (attempts++ < 20) { setTimeout(fit, 100); }
                return;
            }

            isExpanded = false;
            truncatedText = fullText;
            textEl.textContent = fullText;
            toggleBtn.textContent = "More";
            toggleBtn.style.display = "none";
            synopsisEl.style.width = "";
            synopsisEl.style.maxWidth = "";

            var rect = synopsisEl.getBoundingClientRect();
            if (!rect.width) {
                if (attempts++ < 20) { setTimeout(fit, 100); }
                return;
            }

            var cs = window.getComputedStyle(synopsisEl);
            var lineHeight = parseFloat(cs.lineHeight);
            if (isNaN(lineHeight)) {
                lineHeight = (parseFloat(cs.fontSize) || 16) * 1.5;
            }
            var maxH = lineHeight * SYNOPSIS_MAX_LINES + 2;

            if (synopsisEl.scrollHeight <= maxH) {
                return;
            }

            var cap = Math.min(SYNOPSIS_MAX_WIDTH_PX, window.innerWidth - rect.left - window.innerWidth * 0.04);
            if (cap > rect.width) {
                synopsisEl.style.maxWidth = "none";
                synopsisEl.style.width = cap + "px";
                if (synopsisEl.scrollHeight <= maxH) {
                    var lo = rect.width;
                    var hi = cap;
                    while (hi - lo > 2) {
                        var midW = (lo + hi) / 2;
                        synopsisEl.style.width = midW + "px";
                        if (synopsisEl.scrollHeight <= maxH) { hi = midW; } else { lo = midW; }
                    }
                    synopsisEl.style.width = Math.ceil(hi) + "px";
                    return;
                }
            }

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
            var lastSpace = cutText.lastIndexOf(" ");
            if (lastSpace > 0) {
                cutText = cutText.substring(0, lastSpace);
            }
            truncatedText = cutText + "... ";
            textEl.textContent = truncatedText;
        }

        function onResize() {
            if (!synopsisEl.isConnected) {
                window.removeEventListener("resize", onResize);
                return;
            }
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(fit, 150);
        }

        setTimeout(fit, 50);
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(function () { if (!isExpanded) { fit(); } });
        }
        window.addEventListener("resize", onResize);
    }

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
            /* A widened synopsis can extend past the text column; keep the shade behind it. */
            var wideSyn = textEl.querySelector ? textEl.querySelector(".ns-synopsis") : null;
            if (wideSyn) {
                var synRect = wideSyn.getBoundingClientRect();
                if (synRect.right > textRect.right) {
                    textRect = { left: textRect.left, top: textRect.top, right: synRect.right, bottom: textRect.bottom };
                }
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
        var synObserved = textEl.querySelector ? textEl.querySelector(".ns-synopsis") : null;
        if (synObserved) { ro.observe(synObserved); }
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
                    console.error("FinoraUI: failed to trigger hero playback", err);
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
            var meta = buildMetaRow(item, { includeQualityBadges: false, ratings: item.__nsRatings, ageRating: item.__nsAgeRating });
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

                /* Resolve all MDBList ratings AND age ratings before the
                   hero is mounted so the first metadata paint is complete
                   instead of adding badges later. Requests are cached and
                   run in parallel, so this adds only the slowest single
                   lookup. */
                Promise.all(items.map(function (item) {
                    return Promise.all([resolveItemRatings(item), resolveItemAgeRating(item)]).then(function (results) {
                        item.__nsRatings = results[0];
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

        /* The arrow glyph comes from the keyboard_arrow_* class (::before).
           Writing the icon name as text as well drew a second ligature glyph = double arrow. */
        icon.textContent = '';
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
            var container = target && target.closest ? target.closest('.ns-video-selectors .selectContainer') : null;
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
            var container = target && target.closest ? target.closest('.ns-video-selectors .selectContainer') : null;
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

/* Player OSD title formatting lives only in player.js now. This file used to
 * carry a second copy of that IIFE, guarded by the same window.__nsOsdTitle
 * flag. Because main.js loads before player.js (see SkinEntryPoint's
 * <script defer> order), this copy always claimed the guard first and
 * player.js's copy silently no-opped for the whole session. That mattered
 * because the two copies had drifted: this one scanned the bare ".skinHeader"
 * class (which Jellyfin also uses for the persistent app/page header), while
 * player.js scans ".skinHeader.osdHeader" (the OSD only). On replay, once
 * you're back on the item's own page, that page's ".skinHeader" text can also
 * match document.title, so the old scan here would grab that (invisible)
 * element instead of the real OSD title, leaving the actual on-screen title
 * unformatted. Removed so player.js's ".osdHeader"-scoped version is the only
 * one that ever runs. */

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














