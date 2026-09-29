using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.FinoraUI.Configuration
{
    /// <summary>
    /// User-editable settings for the FinoraUI plugin, exposed on the
    /// dashboard configuration page (see Configuration/configPage.html).
    /// </summary>
    public class PluginConfiguration : BasePluginConfiguration
    {
        /// <summary>
        /// Gets or sets a value indicating whether the CSS skin should be written
        /// into the server's Branding &gt; Custom CSS setting. This is the fully
        /// supported half of the skin - turning it off removes all styling
        /// without touching any files.
        /// </summary>
        public bool EnableCss { get; set; } = true;

        /// <summary>
        /// Gets or sets a value indicating whether the plugin should patch
        /// jellyfin-web's index.html to load main.js, which adds the
        /// FinoraUI-style "one expanded 16:9 landscape card per rail" behaviour:
        /// the first card in each home-screen row is expanded by default,
        /// clicking any other card expands it instead (collapsing the previous
        /// one), and clicking the already-expanded card opens its details
        /// screen. There is no supported way to add this without a small,
        /// reversible index.html patch - see the README "Known limitations"
        /// section. Turning this off (and restarting Jellyfin) automatically
        /// restores the original index.html from the backup the plugin made.
        /// </summary>
        public bool EnableHoverPreviewScript { get; set; } = true;

        /// <summary>
        /// Gets or sets the accent color used for focus rings, the active nav
        /// pill, progress bars, etc. Any valid CSS color.
        /// </summary>
        public string AccentColor { get; set; } = "#ffffff";

        /// <summary>
        /// Gets or sets a value indicating whether the top navigation should be
        /// re-centered into a floating pill (as opposed to left aligned tabs).
        /// </summary>
        public bool CenterNavigation { get; set; } = true;

        /// <summary>
        /// Gets or sets the MDBList API key (from https://mdblist.com/preferences/)
        /// used to look up every rating source (IMDb, TMDB, Rotten Tomatoes
        /// critics/audience, Metacritic critics/users, Trakt, Letterboxd, Roger
        /// Ebert) MDBList has for a title, for the meta info row on the home
        /// hero and detail screen. Left empty, no rating badges are shown -
        /// everything else in the skin works without it.
        /// </summary>
        public string MdblistApiKey { get; set; } = string.Empty;

        /// <summary>
        /// Gets or sets which MDBList rating sources are shown, and in what
        /// order. A comma-separated list of "sourceId:0|1" pairs (1 = enabled),
        /// in display order - e.g. "imdb:1,tmdb:1,tomatoes:1,...". Edited via
        /// the reorderable list on the plugin's settings page rather than by
        /// hand. Unknown ids are ignored; missing ids are treated as disabled.
        /// </summary>
        public string RatingSourcesOrder { get; set; } =
            "imdb:1,tmdb:1,tomatoes:1,tomatoesaudience:0,metacritic:0,metacriticuser:0,trakt:0,letterboxd:0,rogerebert:0";

        /// <summary>
        /// Gets or sets the TMDB v3 API key (from https://www.themoviedb.org/settings/api)
        /// used to look up each title's age/content rating for the meta info row's
        /// bordered badge. Jellyfin's own OfficialRating field only ever holds ONE
        /// certification - whichever country the server's metadata settings are
        /// configured for (e.g. "IN-U/A 13+" when set to India) - with no built-in
        /// way to prefer a different country per title. This key lets the plugin
        /// ask TMDB directly for every country's certification and pick the
        /// <see cref="AgeRatingDefaultCountry"/> certification first, falling back
        /// to <see cref="AgeRatingFallbackCountry"/> only when the default country
        /// has none. Left empty, the badge just falls back to Jellyfin's own
        /// OfficialRating value, same as before this setting existed.
        /// </summary>
        public string TmdbApiKey { get; set; } = string.Empty;

        /// <summary>
        /// Gets or sets the ISO 3166-1 country code (e.g. "US", "IN", "GB") whose
        /// certification is preferred for the age-rating badge, returned without a
        /// country prefix. Edited via the country dropdown on the plugin's
        /// settings page. Defaults to "US".
        /// </summary>
        public string AgeRatingDefaultCountry { get; set; } = "US";

        /// <summary>
        /// Gets or sets the ISO 3166-1 country code used for the age-rating badge
        /// when the title has no certification for <see cref="AgeRatingDefaultCountry"/>.
        /// Returned prefixed as "{code}-{rating}", matching the country-prefixed
        /// style Jellyfin itself uses for non-default-country ratings. Edited via
        /// the country dropdown on the plugin's settings page. Defaults to "IN".
        /// </summary>
        public string AgeRatingFallbackCountry { get; set; } = "IN";

        /// <summary>
        /// Gets or sets a value indicating whether the SyncPlay button is shown in the video player.
        /// </summary>
        public bool ShowPlayerSyncPlay { get; set; } = false;

        /// <summary>
        /// Gets or sets a value indicating whether the picture-in-picture button is shown in the video player.
        /// </summary>
        public bool ShowPlayerPip { get; set; } = true;

        /// <summary>
        /// Gets or sets a value indicating whether the fullscreen button is shown in the video player.
        /// </summary>
        public bool ShowPlayerFullscreen { get; set; } = true;

        /// <summary>
        /// Gets or sets a value indicating whether the next / previous chapter buttons are shown in the video player.
        /// </summary>
        public bool ShowPlayerChapterButtons { get; set; } = false;

        /// <summary>
        /// Gets or sets a value indicating whether the seek forward / backward buttons are shown in the video player.
        /// </summary>
        public bool ShowPlayerSeekButtons { get; set; } = false;
    }
}
