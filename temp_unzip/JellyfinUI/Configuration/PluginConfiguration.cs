using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.NetflixSkin.Configuration
{
    /// <summary>
    /// User-editable settings for the Netflix Skin plugin, exposed on the
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
        /// Netflix-style "one expanded 16:9 landscape card per rail" behaviour:
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
        /// Gets or sets the OMDb API key (from https://www.omdbapi.com/apikey.aspx)
        /// used to look up each title's IMDb rating for the meta info row. Left
        /// empty, the IMDb rating badge is simply skipped - everything else in
        /// the skin works without it.
        /// </summary>
        public string OmdbApiKey { get; set; } = string.Empty;

        /// <summary>
        /// Gets or sets the TMDB v3 API key (from https://www.themoviedb.org/settings/api)
        /// used to look up each title's age/content rating for the meta info row's
        /// bordered badge. Jellyfin's own OfficialRating field only ever holds ONE
        /// certification - whichever country the server's metadata settings are
        /// configured for (e.g. "IN-U/A 13+" when set to India) - with no built-in
        /// way to prefer a different country per title. This key lets the plugin
        /// ask TMDB directly for every country's certification and pick US first,
        /// falling back to India (IN) only when no US certification exists. Left
        /// empty, the badge just falls back to Jellyfin's own OfficialRating value,
        /// same as before this setting existed.
        /// </summary>
        public string TmdbApiKey { get; set; } = string.Empty;
    }
}
