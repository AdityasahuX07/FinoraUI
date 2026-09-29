using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.FinoraUI.Api
{
    /// <summary>
    /// Serves the small static JS asset that index.html is patched to load,
    /// plus thin server-side proxies for MDBList ratings and TMDB age
    /// ratings. Jellyfin automatically
    /// discovers controllers shipped inside plugin assemblies (the same
    /// mechanism used by plugins like Playback Reporting to expose their own
    /// endpoints) - no manual route registration needed beyond this class and
    /// the FrameworkReference in the .csproj.
    /// </summary>
    [ApiController]
    [AllowAnonymous]
    [Route("FinoraUI")]
    public class FinoraUIController : ControllerBase
    {
        /// <summary>
        /// One shared, long-lived HttpClient for MDBList lookups (the
        /// documented .NET pattern - a fresh HttpClient per request risks
        /// socket exhaustion under load).
        /// </summary>
        private static readonly HttpClient MdblistClient = new HttpClient();

        /// <summary>
        /// In-memory id -> raw MDBList ratings cache. The same handful of
        /// titles get re-asked for by every client that opens the home
        /// screen or a detail page, so results are kept for a day before
        /// being re-fetched. Raw (unfiltered/unordered) results are cached
        /// so changes to which sources are enabled/ordered on the settings
        /// page take effect immediately instead of waiting on the cache.
        /// </summary>
        private static readonly ConcurrentDictionary<string, CachedMdblistRatings> MdblistRatingCache =
            new ConcurrentDictionary<string, CachedMdblistRatings>(StringComparer.OrdinalIgnoreCase);

        private static readonly TimeSpan CacheLifetime = TimeSpan.FromHours(24);

        /// <summary>
        /// Every rating source MDBList can return that this plugin knows how
        /// to format, keyed by MDBList's own "source" id. Drives both the
        /// value formatting below and the enable/reorder list on the
        /// settings page (see Configuration/configPage.html).
        /// </summary>
        private static readonly Dictionary<string, Func<double, string>> KnownRatingSources =
            new Dictionary<string, Func<double, string>>(StringComparer.OrdinalIgnoreCase)
            {
                { "imdb", v => v.ToString("0.0", CultureInfo.InvariantCulture) },
                { "tmdb", v => v.ToString("0.0", CultureInfo.InvariantCulture) },
                { "tomatoes", v => Math.Round(v).ToString(CultureInfo.InvariantCulture) + "%" },
                { "tomatoesaudience", v => Math.Round(v).ToString(CultureInfo.InvariantCulture) + "%" },
                { "metacritic", v => Math.Round(v).ToString(CultureInfo.InvariantCulture) },
                { "metacriticuser", v => v.ToString("0.0", CultureInfo.InvariantCulture) },
                { "trakt", v => Math.Round(v).ToString(CultureInfo.InvariantCulture) + "%" },
                { "letterboxd", v => v.ToString("0.0", CultureInfo.InvariantCulture) },
                { "rogerebert", v => v.ToString("0.0", CultureInfo.InvariantCulture) }
            };

        private readonly ILogger<FinoraUIController> _logger;

        /// <summary>
        /// Initializes a new instance of the <see cref="FinoraUIController"/> class.
        /// </summary>
        /// <param name="logger">Instance of <see cref="ILogger{FinoraUIController}"/>.</param>
        public FinoraUIController(ILogger<FinoraUIController> logger)
        {
            _logger = logger;
        }

        /// <summary>
        /// Returns the hover-preview script embedded in the plugin DLL.
        /// </summary>
        /// <returns>The javascript file contents.</returns>
        [HttpGet("main.js")]
        [Produces("application/javascript")]
        public ActionResult GetScript()
        {
            var asm = Assembly.GetExecutingAssembly();
            const string ResourceName = "Jellyfin.Plugin.FinoraUI.Web.main.js";
            var stream = asm.GetManifestResourceStream(ResourceName);

            if (stream is null)
            {
                return NotFound();
            }

            // No cache headers here meant the browser could keep running an
            // old cached copy of this script indefinitely after a plugin
            // rebuild/restart - a fix on the server side would silently not
            // take effect client-side until a hard-refresh happened to
            // clear it. Explicitly forbidding caching means every page
            // load always fetches whatever is currently embedded in the
            // DLL, so a rebuild always takes effect on the next reload.
            Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
            Response.Headers["Pragma"] = "no-cache";
            Response.Headers["Expires"] = "0";

            return File(stream, "application/javascript; charset=utf-8");
        }

        /// <summary>
        /// Returns the player script embedded in the plugin DLL.
        /// </summary>
        /// <returns>The javascript file contents.</returns>
        [HttpGet("player.js")]
        [Produces("application/javascript")]
        public ActionResult GetPlayerScript()
        {
            var asm = Assembly.GetExecutingAssembly();
            const string ResourceName = "Jellyfin.Plugin.FinoraUI.Web.player.js";
            var stream = asm.GetManifestResourceStream(ResourceName);

            if (stream is null)
            {
                return NotFound();
            }

            Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
            Response.Headers["Pragma"] = "no-cache";
            Response.Headers["Expires"] = "0";

            return File(stream, "application/javascript; charset=utf-8");
        }

        /// <summary>
        /// Returns the player stylesheet embedded in the plugin DLL.
        /// </summary>
        /// <returns>The css file contents.</returns>
        [HttpGet("player.css")]
        [Produces("text/css")]
        public ActionResult GetPlayerStyle()
        {
            var asm = Assembly.GetExecutingAssembly();
            const string ResourceName = "Jellyfin.Plugin.FinoraUI.Web.player.css";
            var stream = asm.GetManifestResourceStream(ResourceName);

            if (stream is null)
            {
                return NotFound();
            }

            Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
            Response.Headers["Pragma"] = "no-cache";
            Response.Headers["Expires"] = "0";

            return File(stream, "text/css; charset=utf-8");
        }

        /// <summary>
        /// Returns the plugin's cover/poster art embedded in the plugin DLL.
        /// Referenced from this plugin's own meta.json ("imageUrl") so it
        /// shows up as the tile artwork on Dashboard &gt; Plugins &gt; My Plugins,
        /// the same way repository-installed plugins (AudioDB, TMDb, etc.)
        /// get their tile art from their manifest's imageUrl.
        /// </summary>
        /// <returns>The cover image bytes.</returns>
        [HttpGet("cover.jpg")]
        [Produces("image/jpeg")]
        public ActionResult GetCoverImage()
        {
            var asm = Assembly.GetExecutingAssembly();
            const string ResourceName = "Jellyfin.Plugin.FinoraUI.Web.images.cover.jpg";
            var stream = asm.GetManifestResourceStream(ResourceName);

            if (stream is null)
            {
                return NotFound();
            }

            // Unlike the JS/CSS above, this is static artwork rather than
            // something iterated on every rebuild, so it's fine (and
            // friendlier to the dashboard) to let the browser cache it.
            Response.Headers["Cache-Control"] = "public, max-age=604800";

            return File(stream, "image/jpeg");
        }

        /// <summary>
        /// Serves this plugin's own plugin-repository manifest, so it can be
        /// added as a self-hosted Repository (Dashboard &gt; Plugins &gt;
        /// Repositories &gt; + &gt; e.g. http://&lt;this-server&gt;:8096/FinoraUI/manifest.json)
        /// without needing any external hosting (GitHub, etc.). Jellyfin then
        /// cross-references the already-installed plugin's GUID against this
        /// manifest entry to pick up real cover art / owner metadata for the
        /// "My Plugins" tile - the same mechanism used by every third-party
        /// repository, just served by the plugin itself instead of GitHub.
        /// </summary>
        /// <returns>A single-entry plugin repository manifest as JSON.</returns>
        [HttpGet("manifest.json")]
        [Produces("application/json")]
        public ActionResult GetManifest()
        {
            var asm = Assembly.GetExecutingAssembly();
            var version = asm.GetName().Version?.ToString() ?? "0.0.0.0";
            var description = Plugin.Instance?.Description ?? string.Empty;
            var baseUrl = $"{Request.Scheme}://{Request.Host}";

            var manifest = new[]
            {
                new
                {
                    guid = Plugin.Instance?.Id.ToString() ?? string.Empty,
                    name = "FinoraUI",
                    description,
                    overview = "Restyles Jellyfin Web with a dark, cinematic look.",
                    owner = "Aditya",
                    category = "General",
                    imageUrl = $"{baseUrl}/FinoraUI/cover.jpg",
                    versions = new[]
                    {
                        new
                        {
                            version,
                            changelog = "Self-hosted manifest entry, served by the plugin itself.",
                            targetAbi = "12.0.0.0",

                            // No download source: this manifest exists purely so an
                            // already manually-installed copy gets decorated with
                            // real metadata/artwork. Clicking Install/Update from
                            // the Catalog for THIS entry would fail (there is
                            // nothing to download) - keep using manual DLL drops
                            // to update the plugin itself.
                            sourceUrl = $"{baseUrl}/FinoraUI/manifest.json",
                            checksum = string.Empty,
                            timestamp = DateTime.UtcNow.ToString("o")
                        }
                    }
                }
            };

            // Same reasoning as the JS/CSS above: always reflect whatever
            // this running instance actually is, never a stale cached copy.
            Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
            Response.Headers["Pragma"] = "no-cache";
            Response.Headers["Expires"] = "0";

            return new JsonResult(manifest);
        }

        /// <summary>
        /// Looks up every rating MDBList has for an item, using the API key
        /// configured on the plugin's settings page, then filters/orders/
        /// formats them according to that same settings page's rating
        /// source list. Kept server-side (as opposed to having main.js call
        /// MDBList directly) so the API key never has to be shipped to the
        /// browser, and so the 24h cache below is shared across every
        /// client instead of re-fetched per browser tab. Returns an empty
        /// list (rather than an error status) when nothing is available -
        /// missing key, unknown id, or a lookup failure - since from the
        /// client's point of view that just means "skip the rating badges
        /// for this title".
        /// </summary>
        /// <param name="imdbId">An IMDb id, e.g. "tt0111161". Preferred when present.</param>
        /// <param name="tmdbId">A TMDB id, used when no IMDb id is available.</param>
        /// <param name="type">Either "movie" or "tv" - required when using <paramref name="tmdbId"/>.</param>
        /// <returns>The enabled ratings, already ordered and formatted for display.</returns>
        [HttpGet("Ratings")]
        [Produces("application/json")]
        public async Task<ActionResult<RatingsResponse>> GetRatings(
            [FromQuery] string? imdbId,
            [FromQuery] string? tmdbId,
            [FromQuery] string? type)
        {
            if (string.IsNullOrWhiteSpace(imdbId) && string.IsNullOrWhiteSpace(tmdbId))
            {
                return BadRequest();
            }

            var apiKey = Plugin.Instance?.Configuration.MdblistApiKey;
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                return new RatingsResponse();
            }

            var normalizedType = (type ?? string.Empty).Trim().ToLowerInvariant();
            var cacheKey = !string.IsNullOrWhiteSpace(imdbId)
                ? "id:" + imdbId!.Trim()
                : "tmdb:" + normalizedType + ":" + tmdbId!.Trim();

            List<MdblistRatingEntry>? ratings;
            if (MdblistRatingCache.TryGetValue(cacheKey, out var cached) && DateTime.UtcNow - cached.FetchedAt < CacheLifetime)
            {
                ratings = cached.Ratings;
            }
            else
            {
                try
                {
                    var url = !string.IsNullOrWhiteSpace(imdbId)
                        ? string.Format(
                            CultureInfo.InvariantCulture,
                            "https://mdblist.com/api/?apikey={0}&i={1}",
                            Uri.EscapeDataString(apiKey),
                            Uri.EscapeDataString(imdbId!.Trim()))
                        : string.Format(
                            CultureInfo.InvariantCulture,
                            "https://mdblist.com/api/?apikey={0}&tm={1}&m={2}",
                            Uri.EscapeDataString(apiKey),
                            Uri.EscapeDataString(tmdbId!.Trim()),
                            normalizedType == "tv" ? "show" : "movie");

                    var mdblist = await MdblistClient.GetFromJsonAsync<MdblistApiResponse>(url).ConfigureAwait(false);
                    ratings = mdblist?.Ratings;
                    MdblistRatingCache[cacheKey] = new CachedMdblistRatings { Ratings = ratings, FetchedAt = DateTime.UtcNow };
                }
                catch (Exception ex) when (ex is HttpRequestException || ex is TaskCanceledException || ex is System.Text.Json.JsonException)
                {
                    _logger.LogWarning(ex, "FinoraUI: MDBList lookup failed for {Lookup}", !string.IsNullOrWhiteSpace(imdbId) ? imdbId : tmdbId);
                    return new RatingsResponse();
                }
            }

            var response = new RatingsResponse();
            if (ratings is null || ratings.Count == 0)
            {
                return response;
            }

            var order = Plugin.Instance?.Configuration.RatingSourcesOrder ?? string.Empty;
            foreach (var (sourceId, enabled) in ParseRatingSourcesOrder(order))
            {
                if (!enabled || !KnownRatingSources.TryGetValue(sourceId, out var format))
                {
                    continue;
                }

                var match = ratings.Find(r => string.Equals(r.Source, sourceId, StringComparison.OrdinalIgnoreCase));
                if (match?.Value is null)
                {
                    continue;
                }

                response.Ratings.Add(new RatingEntry { Source = sourceId, Display = format(match.Value.Value), Value = match.Value.Value });
            }

            return response;
        }

        /// <summary>
        /// Parses the "sourceId:0|1,sourceId:0|1,..." string stored in
        /// <see cref="Configuration.PluginConfiguration.RatingSourcesOrder"/>
        /// into ordered (id, enabled) pairs. Malformed entries are skipped
        /// rather than failing the whole list.
        /// </summary>
        private static IEnumerable<(string SourceId, bool Enabled)> ParseRatingSourcesOrder(string order)
        {
            var entries = order.Split(',');
            foreach (var entry in entries)
            {
                var trimmed = entry.Trim();
                if (trimmed.Length == 0)
                {
                    continue;
                }

                var parts = trimmed.Split(':');
                if (parts.Length != 2)
                {
                    continue;
                }

                yield return (parts[0].Trim(), parts[1].Trim() == "1");
            }
        }

        /// <summary>
        /// One shared, long-lived HttpClient for TMDB lookups - same
        /// reasoning as <see cref="MdblistClient"/> above.
        /// </summary>
        private static readonly HttpClient TmdbClient = new HttpClient();

        /// <summary>
        /// In-memory "movie:12345" / "tv:12345" -> resolved age rating cache.
        /// Same 24h lifetime and same reasoning as <see cref="MdblistRatingCache"/>.
        /// </summary>
        private static readonly ConcurrentDictionary<string, CachedRating> AgeRatingCache =
            new ConcurrentDictionary<string, CachedRating>(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// Looks up an item's age/content rating through TMDB, preferring the
        /// configured <see cref="Configuration.PluginConfiguration.AgeRatingDefaultCountry"/>
        /// certification and falling back to
        /// <see cref="Configuration.PluginConfiguration.AgeRatingFallbackCountry"/> -
        /// formatted as "{code}-{rating}", matching the country-prefixed style
        /// Jellyfin itself uses for non-default-country ratings - when the
        /// default country has no certification. Kept server-side for the same
        /// reasons as <see cref="GetRatings"/>: the API key never reaches the
        /// browser, and the 24h cache is shared across every client. Returns 204
        /// (no rating available - missing key, unknown id, or neither country
        /// has a certification) rather than an error status; the client's own
        /// <c>item.OfficialRating</c> is left as the fallback for that case.
        /// </summary>
        /// <param name="tmdbId">The item's TMDB id.</param>
        /// <param name="type">Either "movie" or "tv".</param>
        /// <returns>The resolved rating, or 204 if none is available.</returns>
        [HttpGet("AgeRating")]
        [Produces("application/json")]
        public async Task<ActionResult<AgeRatingResponse>> GetAgeRating(
            [FromQuery] string? tmdbId,
            [FromQuery] string? type)
        {
            var normalizedType = (type ?? string.Empty).Trim().ToLowerInvariant();
            if (string.IsNullOrWhiteSpace(tmdbId) || (normalizedType != "movie" && normalizedType != "tv"))
            {
                return BadRequest();
            }

            var config = Plugin.Instance?.Configuration;
            var apiKey = config?.TmdbApiKey;
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                return NoContent();
            }

            var defaultCountry = string.IsNullOrWhiteSpace(config?.AgeRatingDefaultCountry) ? "US" : config!.AgeRatingDefaultCountry.Trim();
            var fallbackCountry = string.IsNullOrWhiteSpace(config?.AgeRatingFallbackCountry) ? "IN" : config!.AgeRatingFallbackCountry.Trim();

            var cacheKey = normalizedType + ":" + tmdbId.Trim() + ":" + defaultCountry + ":" + fallbackCountry;

            if (AgeRatingCache.TryGetValue(cacheKey, out var cached) && DateTime.UtcNow - cached.FetchedAt < CacheLifetime)
            {
                return cached.Rating is null ? NoContent() : new AgeRatingResponse { Rating = cached.Rating };
            }

            try
            {
                string? rating = normalizedType == "movie"
                    ? await GetMovieAgeRating(tmdbId.Trim(), apiKey, defaultCountry, fallbackCountry).ConfigureAwait(false)
                    : await GetTvAgeRating(tmdbId.Trim(), apiKey, defaultCountry, fallbackCountry).ConfigureAwait(false);

                AgeRatingCache[cacheKey] = new CachedRating { Rating = rating, FetchedAt = DateTime.UtcNow };

                return rating is null ? NoContent() : new AgeRatingResponse { Rating = rating };
            }
            catch (Exception ex) when (ex is HttpRequestException || ex is TaskCanceledException || ex is System.Text.Json.JsonException)
            {
                _logger.LogWarning(ex, "FinoraUI: TMDB age rating lookup failed for {Type} {TmdbId}", normalizedType, tmdbId);
                return NoContent();
            }
        }

        /// <summary>
        /// Default-country certification first (any non-empty entry from that
        /// country's block, preferring release type 3 = Theatrical since that's
        /// what most default-country certifications are attached to), then the
        /// fallback country prefixed "{code}-", then null.
        /// </summary>
        private static async Task<string?> GetMovieAgeRating(string tmdbId, string apiKey, string defaultCountry, string fallbackCountry)
        {
            var url = string.Format(
                CultureInfo.InvariantCulture,
                "https://api.themoviedb.org/3/movie/{0}/release_dates?api_key={1}",
                Uri.EscapeDataString(tmdbId),
                Uri.EscapeDataString(apiKey));

            var response = await TmdbClient.GetFromJsonAsync<TmdbReleaseDatesResponse>(url).ConfigureAwait(false);
            var countries = response?.Results;
            if (countries is null)
            {
                return null;
            }

            var preferred = FindCertification(countries, defaultCountry);
            if (!string.IsNullOrWhiteSpace(preferred))
            {
                return preferred;
            }

            var fallback = FindCertification(countries, fallbackCountry);
            return string.IsNullOrWhiteSpace(fallback) ? null : fallbackCountry + "-" + fallback;
        }

        private static string? FindCertification(System.Collections.Generic.List<TmdbReleaseDatesCountry> countries, string countryCode)
        {
            foreach (var country in countries)
            {
                if (!string.Equals(country.CountryCode, countryCode, StringComparison.OrdinalIgnoreCase) || country.ReleaseDates is null)
                {
                    continue;
                }

                /* Type 3 = Theatrical, the release type most US/IN
                   certifications are attached to. Fall back to the first
                   non-empty certification in the list if no Theatrical
                   entry has one (e.g. a straight-to-digital release). */
                string? theatrical = null;
                string? any = null;
                foreach (var entry in country.ReleaseDates)
                {
                    if (string.IsNullOrWhiteSpace(entry.Certification))
                    {
                        continue;
                    }

                    any ??= entry.Certification;
                    if (entry.Type == 3)
                    {
                        theatrical ??= entry.Certification;
                    }
                }

                return theatrical ?? any;
            }

            return null;
        }

        /// <summary>
        /// Same default-country-first, fallback-country-second logic as
        /// <see cref="GetMovieAgeRating"/>, against TMDB's TV content_ratings
        /// endpoint (one rating per country, no release-type distinction to
        /// worry about).
        /// </summary>
        private static async Task<string?> GetTvAgeRating(string tmdbId, string apiKey, string defaultCountry, string fallbackCountry)
        {
            var url = string.Format(
                CultureInfo.InvariantCulture,
                "https://api.themoviedb.org/3/tv/{0}/content_ratings?api_key={1}",
                Uri.EscapeDataString(tmdbId),
                Uri.EscapeDataString(apiKey));

            var response = await TmdbClient.GetFromJsonAsync<TmdbContentRatingsResponse>(url).ConfigureAwait(false);
            var results = response?.Results;
            if (results is null)
            {
                return null;
            }

            string? preferred = null;
            string? fallback = null;
            foreach (var entry in results)
            {
                if (string.IsNullOrWhiteSpace(entry.Rating))
                {
                    continue;
                }

                if (string.Equals(entry.CountryCode, defaultCountry, StringComparison.OrdinalIgnoreCase))
                {
                    preferred ??= entry.Rating;
                }
                else if (string.Equals(entry.CountryCode, fallbackCountry, StringComparison.OrdinalIgnoreCase))
                {
                    fallback ??= entry.Rating;
                }
            }

            if (!string.IsNullOrWhiteSpace(preferred))
            {
                return preferred;
            }

            return string.IsNullOrWhiteSpace(fallback) ? null : fallbackCountry + "-" + fallback;
        }

        private sealed class CachedRating
        {
            public string? Rating { get; set; }

            public DateTime FetchedAt { get; set; }
        }

        private sealed class CachedMdblistRatings
        {
            public List<MdblistRatingEntry>? Ratings { get; set; }

            public DateTime FetchedAt { get; set; }
        }

        private sealed class MdblistRatingEntry
        {
            [JsonPropertyName("source")]
            public string? Source { get; set; }

            [JsonPropertyName("value")]
            public double? Value { get; set; }
        }

        private sealed class MdblistApiResponse
        {
            [JsonPropertyName("ratings")]
            public List<MdblistRatingEntry>? Ratings { get; set; }
        }

        /// <summary>
        /// Response body for <see cref="GetRatings"/>.
        /// </summary>
        public sealed class RatingsResponse
        {
            /// <summary>
            /// Gets the enabled ratings, already ordered and formatted for
            /// display (e.g. source "tomatoes", display "91%").
            /// </summary>
            [JsonPropertyName("ratings")]
            public List<RatingEntry> Ratings { get; } = new List<RatingEntry>();
        }

        /// <summary>
        /// One formatted rating entry within a <see cref="RatingsResponse"/>.
        /// </summary>
        public sealed class RatingEntry
        {
            /// <summary>
            /// Gets or sets the MDBList source id, e.g. "imdb", "tomatoes".
            /// </summary>
            [JsonPropertyName("source")]
            public string Source { get; set; } = string.Empty;

            /// <summary>
            /// Gets or sets the already-formatted display value, e.g. "8.8" or "91%".
            /// </summary>
            [JsonPropertyName("display")]
            public string Display { get; set; } = string.Empty;

            /// <summary>
            /// Gets or sets the raw 0-100 score MDBList returned for this source,
            /// e.g. 91 for a 91% Tomatometer/Popcornmeter reading. Used client-side
            /// to pick which of RT's Certified Fresh/Fresh/Rotten (critics) or
            /// Upright/Spilled (audience) marks to render - see
            /// ratingSourceIconHtml() in main.js. Unused by every other source.
            /// </summary>
            [JsonPropertyName("value")]
            public double Value { get; set; }
        }

        /// <summary>
        /// Response body for <see cref="GetAgeRating"/>.
        /// </summary>
        public sealed class AgeRatingResponse
        {
            /// <summary>
            /// Gets or sets the resolved age rating, e.g. "PG-13" (default
            /// country) or "IN-U/A 13+" (fallback country).
            /// </summary>
            [JsonPropertyName("rating")]
            public string? Rating { get; set; }
        }

        private sealed class TmdbReleaseDatesResponse
        {
            [JsonPropertyName("results")]
            public System.Collections.Generic.List<TmdbReleaseDatesCountry>? Results { get; set; }
        }

        private sealed class TmdbReleaseDatesCountry
        {
            [JsonPropertyName("iso_3166_1")]
            public string? CountryCode { get; set; }

            [JsonPropertyName("release_dates")]
            public System.Collections.Generic.List<TmdbReleaseDateEntry>? ReleaseDates { get; set; }
        }

        private sealed class TmdbReleaseDateEntry
        {
            [JsonPropertyName("certification")]
            public string? Certification { get; set; }

            [JsonPropertyName("type")]
            public int Type { get; set; }
        }

        private sealed class TmdbContentRatingsResponse
        {
            [JsonPropertyName("results")]
            public System.Collections.Generic.List<TmdbContentRatingEntry>? Results { get; set; }
        }

        private sealed class TmdbContentRatingEntry
        {
            [JsonPropertyName("iso_3166_1")]
            public string? CountryCode { get; set; }

            [JsonPropertyName("rating")]
            public string? Rating { get; set; }
        }

        [HttpGet("ImdbId")]
        [Produces("application/json")]
        public async Task<ActionResult<ImdbIdResponse>> GetImdbId(
            [FromQuery] string? tmdbId,
            [FromQuery] string? type)
        {
            var normalizedType = (type ?? string.Empty).Trim().ToLowerInvariant();
            if (string.IsNullOrWhiteSpace(tmdbId) || (normalizedType != "movie" && normalizedType != "tv"))
            {
                return BadRequest();
            }

            var apiKey = Plugin.Instance?.Configuration.TmdbApiKey;
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                return NoContent();
            }

            try
            {
                var url = string.Format(
                    CultureInfo.InvariantCulture,
                    "https://api.themoviedb.org/3/{0}/{1}/external_ids?api_key={2}",
                    normalizedType,
                    Uri.EscapeDataString(tmdbId.Trim()),
                    Uri.EscapeDataString(apiKey));

                var response = await TmdbClient.GetFromJsonAsync<TmdbExternalIdsResponse>(url).ConfigureAwait(false);
                var imdbId = response?.ImdbId;
                if (string.IsNullOrWhiteSpace(imdbId))
                {
                    return NoContent();
                }

                return new ImdbIdResponse { ImdbId = imdbId };
            }
            catch (Exception ex) when (ex is HttpRequestException || ex is TaskCanceledException || ex is System.Text.Json.JsonException)
            {
                _logger.LogWarning(ex, "FinoraUI: TMDB external IDs lookup failed for {Type} {TmdbId}", normalizedType, tmdbId);
                return NoContent();
            }
        }

        public sealed class ImdbIdResponse
        {
            [JsonPropertyName("imdb_id")]
            public string? ImdbId { get; set; }
        }

        private sealed class TmdbExternalIdsResponse
        {
            [JsonPropertyName("imdb_id")]
            public string? ImdbId { get; set; }
        }
    }
}
