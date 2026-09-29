using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NetflixSkin.Api
{
    /// <summary>
    /// Serves the small static JS asset that index.html is patched to load,
    /// plus a thin server-side proxy for IMDb ratings. Jellyfin automatically
    /// discovers controllers shipped inside plugin assemblies (the same
    /// mechanism used by plugins like Playback Reporting to expose their own
    /// endpoints) - no manual route registration needed beyond this class and
    /// the FrameworkReference in the .csproj.
    /// </summary>
    [ApiController]
    [AllowAnonymous]
    [Route("NetflixSkin")]
    public class NetflixSkinController : ControllerBase
    {
        /// <summary>
        /// One shared, long-lived HttpClient for the lifetime of the server
        /// process (the documented .NET pattern - a fresh HttpClient per
        /// request risks socket exhaustion under load).
        /// </summary>
        private static readonly HttpClient OmdbClient = new HttpClient();

        /// <summary>
        /// In-memory IMDb-id -> rating cache. OMDb's free tier is capped at
        /// 1,000 requests/day, and the same handful of titles get re-asked
        /// for by every client that opens the home screen or a detail page,
        /// so results are kept for a day before being re-fetched.
        /// </summary>
        private static readonly ConcurrentDictionary<string, CachedRating> RatingCache =
            new ConcurrentDictionary<string, CachedRating>(StringComparer.OrdinalIgnoreCase);

        private static readonly TimeSpan CacheLifetime = TimeSpan.FromHours(24);

        private readonly ILogger<NetflixSkinController> _logger;

        /// <summary>
        /// Initializes a new instance of the <see cref="NetflixSkinController"/> class.
        /// </summary>
        /// <param name="logger">Instance of <see cref="ILogger{NetflixSkinController}"/>.</param>
        public NetflixSkinController(ILogger<NetflixSkinController> logger)
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
            const string ResourceName = "Jellyfin.Plugin.NetflixSkin.Web.main.js";
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
            const string ResourceName = "Jellyfin.Plugin.NetflixSkin.Web.player.js";
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
            const string ResourceName = "Jellyfin.Plugin.NetflixSkin.Web.player.css";
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
        /// Looks up an item's IMDb rating through the OMDb API, using the API
        /// key configured on the plugin's settings page. Kept server-side (as
        /// opposed to having main.js call OMDb directly) so the API key never
        /// has to be shipped to the browser, and so the 24h cache below is
        /// shared across every client instead of re-fetched per browser tab.
        /// Returns 204 (no rating available - missing key, unknown id, "N/A"
        /// from OMDb, or a lookup failure) rather than an error status, since
        /// from the client's point of view all of those just mean "skip the
        /// IMDb badge for this title".
        /// </summary>
        /// <param name="imdbId">An IMDb id, e.g. "tt0111161".</param>
        /// <returns>The rating, or 204 if none is available.</returns>
        [HttpGet("ImdbRating")]
        [Produces("application/json")]
        public async Task<ActionResult<ImdbRatingResponse>> GetImdbRating(
            [FromQuery] string? imdbId,
            [FromQuery] string? title,
            [FromQuery] int? year)
        {
            if (string.IsNullOrWhiteSpace(imdbId) && string.IsNullOrWhiteSpace(title))
            {
                return BadRequest();
            }

            /* IMDb ProviderId is the most reliable lookup. For media where
               Jellyfin has no IMDb ProviderId, fall back to OMDb's title/year
               lookup. This covers titles imported with only TMDB/TVDB IDs. */
            var cacheKey = !string.IsNullOrWhiteSpace(imdbId)
                ? "id:" + imdbId.Trim()
                : "title:" + title!.Trim().ToLowerInvariant() + ":" + (year?.ToString(CultureInfo.InvariantCulture) ?? "");

            if (RatingCache.TryGetValue(cacheKey, out var cached) && DateTime.UtcNow - cached.FetchedAt < CacheLifetime)
            {
                return cached.Rating is null ? NoContent() : new ImdbRatingResponse { ImdbRating = cached.Rating };
            }

            var apiKey = Plugin.Instance?.Configuration.OmdbApiKey;
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                return NoContent();
            }

            try
            {
                var url = !string.IsNullOrWhiteSpace(imdbId)
                    ? string.Format(
                        CultureInfo.InvariantCulture,
                        "https://www.omdbapi.com/?i={0}&apikey={1}",
                        Uri.EscapeDataString(imdbId.Trim()),
                        Uri.EscapeDataString(apiKey))
                    : string.Format(
                        CultureInfo.InvariantCulture,
                        "https://www.omdbapi.com/?t={0}&y={1}&apikey={2}",
                        Uri.EscapeDataString(title!.Trim()),
                        year?.ToString(CultureInfo.InvariantCulture) ?? "",
                        Uri.EscapeDataString(apiKey));

                var omdb = await OmdbClient.GetFromJsonAsync<OmdbResponse>(url).ConfigureAwait(false);
                var rating = omdb?.ImdbRating;
                if (string.IsNullOrWhiteSpace(rating) || string.Equals(rating, "N/A", StringComparison.OrdinalIgnoreCase))
                {
                    rating = null;
                }

                RatingCache[cacheKey] = new CachedRating { Rating = rating, FetchedAt = DateTime.UtcNow };

                return rating is null ? NoContent() : new ImdbRatingResponse { ImdbRating = rating };
            }
            catch (Exception ex) when (ex is HttpRequestException || ex is TaskCanceledException || ex is System.Text.Json.JsonException)
            {
                _logger.LogWarning(ex, "NetflixSkin: OMDb lookup failed for IMDb lookup {Lookup}", !string.IsNullOrWhiteSpace(imdbId) ? imdbId : title);
                return NoContent();
            }
        }

        /// <summary>
        /// One shared, long-lived HttpClient for TMDB lookups - same
        /// reasoning as <see cref="OmdbClient"/> above.
        /// </summary>
        private static readonly HttpClient TmdbClient = new HttpClient();

        /// <summary>
        /// In-memory "movie:12345" / "tv:12345" -> resolved age rating cache.
        /// Same 24h lifetime and same reasoning as <see cref="RatingCache"/>.
        /// </summary>
        private static readonly ConcurrentDictionary<string, CachedRating> AgeRatingCache =
            new ConcurrentDictionary<string, CachedRating>(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// Looks up an item's age/content rating through TMDB, preferring the
        /// US certification and falling back to India (IN) - formatted as
        /// "IN-{rating}", matching the country-prefixed style Jellyfin itself
        /// uses for non-US ratings - when no US certification exists. Kept
        /// server-side for the same reasons as <see cref="GetImdbRating"/>:
        /// the API key never reaches the browser, and the 24h cache is shared
        /// across every client. Returns 204 (no rating available - missing
        /// key, unknown id, or neither country has a certification) rather
        /// than an error status; the client's own <c>item.OfficialRating</c>
        /// is left as the fallback for that case.
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

            var cacheKey = normalizedType + ":" + tmdbId.Trim();

            if (AgeRatingCache.TryGetValue(cacheKey, out var cached) && DateTime.UtcNow - cached.FetchedAt < CacheLifetime)
            {
                return cached.Rating is null ? NoContent() : new AgeRatingResponse { Rating = cached.Rating };
            }

            var apiKey = Plugin.Instance?.Configuration.TmdbApiKey;
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                return NoContent();
            }

            try
            {
                string? rating = normalizedType == "movie"
                    ? await GetMovieAgeRating(tmdbId.Trim(), apiKey).ConfigureAwait(false)
                    : await GetTvAgeRating(tmdbId.Trim(), apiKey).ConfigureAwait(false);

                AgeRatingCache[cacheKey] = new CachedRating { Rating = rating, FetchedAt = DateTime.UtcNow };

                return rating is null ? NoContent() : new AgeRatingResponse { Rating = rating };
            }
            catch (Exception ex) when (ex is HttpRequestException || ex is TaskCanceledException || ex is System.Text.Json.JsonException)
            {
                _logger.LogWarning(ex, "NetflixSkin: TMDB age rating lookup failed for {Type} {TmdbId}", normalizedType, tmdbId);
                return NoContent();
            }
        }

        /// <summary>
        /// US certification first (any non-empty entry from the "US" country
        /// block, preferring release type 3 = Theatrical since that's what
        /// most US certifications are attached to), then India (IN) prefixed
        /// "IN-", then null.
        /// </summary>
        private static async Task<string?> GetMovieAgeRating(string tmdbId, string apiKey)
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

            var us = FindCertification(countries, "US");
            if (!string.IsNullOrWhiteSpace(us))
            {
                return us;
            }

            var india = FindCertification(countries, "IN");
            return string.IsNullOrWhiteSpace(india) ? null : "IN-" + india;
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
        /// Same US-first, India-fallback logic as <see cref="GetMovieAgeRating"/>,
        /// against TMDB's TV content_ratings endpoint (one rating per country,
        /// no release-type distinction to worry about).
        /// </summary>
        private static async Task<string?> GetTvAgeRating(string tmdbId, string apiKey)
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

            string? us = null;
            string? india = null;
            foreach (var entry in results)
            {
                if (string.IsNullOrWhiteSpace(entry.Rating))
                {
                    continue;
                }

                if (string.Equals(entry.CountryCode, "US", StringComparison.OrdinalIgnoreCase))
                {
                    us ??= entry.Rating;
                }
                else if (string.Equals(entry.CountryCode, "IN", StringComparison.OrdinalIgnoreCase))
                {
                    india ??= entry.Rating;
                }
            }

            if (!string.IsNullOrWhiteSpace(us))
            {
                return us;
            }

            return string.IsNullOrWhiteSpace(india) ? null : "IN-" + india;
        }

        private sealed class CachedRating
        {
            public string? Rating { get; set; }

            public DateTime FetchedAt { get; set; }
        }

        private sealed class OmdbResponse
        {
            [JsonPropertyName("imdbRating")]
            public string? ImdbRating { get; set; }
        }

        /// <summary>
        /// Response body for <see cref="GetImdbRating"/>.
        /// </summary>
        public sealed class ImdbRatingResponse
        {
            /// <summary>
            /// Gets or sets the IMDb rating, e.g. "8.8".
            /// </summary>
            [JsonPropertyName("imdbRating")]
            public string? ImdbRating { get; set; }
        }

        /// <summary>
        /// Response body for <see cref="GetAgeRating"/>.
        /// </summary>
        public sealed class AgeRatingResponse
        {
            /// <summary>
            /// Gets or sets the resolved age rating, e.g. "PG-13" (US) or
            /// "IN-U/A 13+" (India fallback).
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
    }
}
