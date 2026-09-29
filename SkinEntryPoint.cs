using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.FinoraUI.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Branding;
using MediaBrowser.Model.Plugins;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.FinoraUI
{
    /// <summary>
    /// Runs once at server startup (and whenever the plugin configuration is saved,
    /// via <see cref="Plugin_ConfigurationChanged"/>) to apply the two supported
    /// pieces of the skin:
    ///  1. Writes the skin stylesheet into Branding &gt; Custom CSS
    ///     (<see cref="BrandingOptions"/>) - a fully supported Jellyfin server
    ///     feature, no files touched.
    ///  2. Optionally patches jellyfin-web's index.html with a single, idempotent,
    ///     backed-up &lt;script&gt; tag so the rail card expand-in-place behaviour
    ///     (which needs real DOM/click-interception logic, not just CSS) can
    ///     run. This part is the documented workaround for the one thing
    ///     Jellyfin's plugin system has no supported hook for: injecting
    ///     JavaScript into the main web client. See README "Known limitations".
    ///
    /// Implemented as a standard <see cref="IHostedService"/> (registered by
    /// <see cref="PluginServiceRegistrator"/>) rather than the older
    /// IServerEntryPoint interface, which current Jellyfin server versions
    /// (verified against the 10.10.3 source) no longer have - plugin startup
    /// hooks are plain ASP.NET Core hosted services now.
    /// </summary>
    public class SkinEntryPoint : IHostedService
    {
        private const string CssStartMarker = "/* FinoraUI:start */";
        private const string CssEndMarker = "/* FinoraUI:end */";
        private const string HeadFontStartMarker = "<!-- FinoraUI:font:start -->";
        private const string HeadFontEndMarker = "<!-- FinoraUI:font:end -->";
        private const string HtmlStartMarker = "<!-- FinoraUI:start -->";
        private const string HtmlEndMarker = "<!-- FinoraUI:end -->";
        private const string BackupSuffix = ".finoraui.bak";

        private readonly IServerApplicationPaths _appPaths;
        private readonly IServerConfigurationManager _configurationManager;
        private readonly ILogger<SkinEntryPoint> _logger;

        /// <summary>
        /// Initializes a new instance of the <see cref="SkinEntryPoint"/> class.
        /// </summary>
        /// <param name="appPaths">Provides the on-disk path to jellyfin-web's static files.</param>
        /// <param name="configurationManager">Used to read/write the server's Branding configuration.</param>
        /// <param name="logger">Logger.</param>
        public SkinEntryPoint(
            IServerApplicationPaths appPaths,
            IServerConfigurationManager configurationManager,
            ILogger<SkinEntryPoint> logger)
        {
            _appPaths = appPaths;
            _configurationManager = configurationManager;
            _logger = logger;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            Apply();

            if (Plugin.Instance is not null)
            {
                Plugin.Instance.ConfigurationChanged += Plugin_ConfigurationChanged;
            }

            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken)
        {
            if (Plugin.Instance is not null)
            {
                Plugin.Instance.ConfigurationChanged -= Plugin_ConfigurationChanged;
            }

            return Task.CompletedTask;
        }

        private void Plugin_ConfigurationChanged(object? sender, BasePluginConfiguration e)
        {
            Apply();
        }

        private void Apply()
        {
            ApplyBrandingCss();
            ApplyIndexHtmlPatches();
            ApplyPluginMetaJson();
        }

        /// <summary>
        /// Writes/refreshes a meta.json next to this plugin's own DLL so the
        /// Dashboard &gt; Plugins detail page shows a real Version/Developer instead
        /// of "Unknown", and so the plugin's tile in Dashboard &gt; Plugins &gt; My
        /// Plugins shows real cover art (via "imageUrl") instead of the generic
        /// puzzle-piece icon - the same manifest fields a repository-installed
        /// plugin (AudioDB, TMDb, etc.) would get from its own manifest.json
        /// entry. Jellyfin only generates this file automatically for plugins
        /// installed through a repository manifest - a manually sideloaded DLL
        /// (this plugin's normal distribution method) has no such file unless
        /// something writes one, so this plugin writes its own on every
        /// startup, always matching whatever version is actually compiled into
        /// the running assembly (avoids the file drifting out of sync with the
        /// DLL after a version bump, the way a hand-placed copy would).
        /// </summary>
        private void ApplyPluginMetaJson()
        {
            try
            {
                var asm = Assembly.GetExecutingAssembly();
                var asmLocation = asm.Location;
                if (string.IsNullOrEmpty(asmLocation))
                {
                    return;
                }

                var pluginDir = Path.GetDirectoryName(asmLocation);
                if (string.IsNullOrEmpty(pluginDir))
                {
                    return;
                }

                var version = asm.GetName().Version?.ToString() ?? "0.0.0.0";
                var metaPath = Path.Combine(pluginDir, "meta.json");
                var description = Plugin.Instance?.Description ?? string.Empty;

                var meta = new
                {
                    category = "General",
                    name = "FinoraUI",
                    guid = Plugin.Instance?.Id.ToString() ?? string.Empty,
                    version,
                    owner = PluginOwner,
                    overview = description,
                    description,
                    status = "Active",
                    autoUpdate = false,
                    imageUrl = "/FinoraUI/cover.jpg",
                    timestamp = DateTime.UtcNow.ToString("o")
                };

                var json = JsonSerializer.Serialize(meta, new JsonSerializerOptions { WriteIndented = true });

                // Only rewrite when the content actually changed, so this doesn't
                // touch the file's mtime on every single restart for no reason.
                if (!File.Exists(metaPath) || File.ReadAllText(metaPath) != json)
                {
                    File.WriteAllText(metaPath, json);
                    _logger.LogInformation("FinoraUI: wrote meta.json ({Path}), version {Version}", metaPath, version);
                }
            }
            catch (UnauthorizedAccessException ex)
            {
                _logger.LogError(ex, "FinoraUI: no write permission for meta.json in the plugin's own folder");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "FinoraUI: failed to write meta.json");
            }
        }

        /// <summary>
        /// The name shown as "Developer" on the plugin's Dashboard detail page.
        /// </summary>
        private const string PluginOwner = "Aditya";

        private void ApplyBrandingCss()
        {
            try
            {
                var config = Plugin.Instance?.Configuration;
                var branding = _configurationManager.GetConfiguration<BrandingOptions>("branding");
                var existing = branding.CustomCss ?? string.Empty;
                var withoutOurs = RemoveSkinCss(existing).TrimEnd();

                if (config is { EnableCss: true })
                {
                    var centerBlock = config.CenterNavigation
                        ? "/* Center the server-name + library/Favorites tab cluster.\n"
                          + "   NOTE: ServerButton and the nav Buttons are rendered as siblings\n"
                          + "   inside one MUI <Stack> with no separate wrapper around just the\n"
                          + "   tabs (verified against the real jellyfin-web source), so this\n"
                          + "   centers that whole cluster - server name included - rather than\n"
                          + "   the tabs alone. Search stays on the right: it lives in a\n"
                          + "   structurally separate container and pulling it out safely would\n"
                          + "   need DOM surgery on live React nodes, which risks breaking React's\n"
                          + "   reconciliation - not worth the fragility. */\n"
                          + ".MuiToolbar-root {\n"
                          + "    position: relative;\n"
                          + "}\n"
                          + ".MuiToolbar-root > .MuiStack-root {\n"
                          + "    position: absolute;\n"
                          + "    left: 50%;\n"
                          + "    transform: translateX(-50%);\n"
                          + "    z-index: 1;\n"
                          + "}"
                        : "/* Center the server-name + library/Favorites tab cluster (disabled in plugin settings) */";

                    var css = GetEmbeddedText("Web.main.css")
                        .Replace("__ACCENT_COLOR__", string.IsNullOrWhiteSpace(config.AccentColor) ? "#ffffff" : config.AccentColor, StringComparison.Ordinal)
                        .Replace("__NAV_CENTER_BLOCK__", centerBlock, StringComparison.Ordinal);

                    var playerCss = GetEmbeddedText("Web.player.css") + "\n\n" + BuildPlayerOptionsCss(config);

                    var wrapped = CssStartMarker + "\n" + css + "\n\n" + playerCss + "\n" + CssEndMarker;
                    branding.CustomCss = (withoutOurs + "\n\n" + wrapped).Trim();
                }
                else
                {
                    branding.CustomCss = withoutOurs;
                }

                _configurationManager.SaveConfiguration("branding", branding);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "FinoraUI: failed to apply branding CSS");
            }
        }

        /// <summary>
        /// Patches jellyfin-web's index.html with up to two independent, idempotent,
        /// marker-delimited blocks:
        ///  - a &lt;head&gt; block loading the Google Fonts "Inter" stylesheet (tied to
        ///    <see cref="PluginConfiguration.EnableCss"/>, since it exists purely to
        ///    back the card-title font-weight rules in main.css).
        ///  - a &lt;body&gt; block loading the hover-preview script (tied to
        ///    <see cref="PluginConfiguration.EnableHoverPreviewScript"/>, unchanged
        ///    from before).
        ///
        /// The font previously loaded via a CSS @import in main.css, but @import only
        /// takes effect when it is the very first rule in the WHOLE combined
        /// Branding &gt; Custom CSS stylesheet - including any other custom CSS a user
        /// already had in that field before this plugin appended its own block - which
        /// this plugin has no control over, so it was silently dropped by the browser
        /// in that (common) case. A &lt;head&gt; &lt;link&gt; is not order-dependent like that,
        /// so it always loads.
        ///
        /// Both blocks are applied/removed surgically via their own markers rather than
        /// a single whole-file backup-restore, specifically because they now share one
        /// file - restoring the whole file from a pristine backup when toggling OFF
        /// just one of the two would silently wipe out the other if it was still meant
        /// to be on. The on-disk backup is kept purely as a manual-recovery safety net
        /// and is only deleted once both blocks are confirmed absent.
        /// </summary>
        private void ApplyIndexHtmlPatches()
        {
            var config = Plugin.Instance?.Configuration;
            var wantFontLink = config is { EnableCss: true };
            var wantScript = config?.EnableHoverPreviewScript == true;

            string indexPath;
            try
            {
                indexPath = Path.Combine(_appPaths.WebPath, "index.html");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "FinoraUI: could not resolve jellyfin-web path");
                return;
            }

            var backupPath = indexPath + BackupSuffix;

            try
            {
                if (!File.Exists(indexPath))
                {
                    _logger.LogWarning("FinoraUI: index.html not found at {Path}; skipping head/body injection", indexPath);
                    return;
                }

                var content = File.ReadAllText(indexPath);
                var hasFontBlock = content.Contains(HeadFontStartMarker, StringComparison.Ordinal);
                var hasScriptBlock = content.Contains(HtmlStartMarker, StringComparison.Ordinal);

                if (!File.Exists(backupPath) && ((wantFontLink && !hasFontBlock) || (wantScript && !hasScriptBlock)))
                {
                    // First-ever modification of this file by the plugin - snapshot the
                    // pristine state once, before either block is inserted.
                    File.Copy(indexPath, backupPath);
                }

                var updated = content;

                var fontTag = HeadFontStartMarker + "\n"
                    + "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n"
                    + "<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n"
                    + "<link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\">\n"
                    + HeadFontEndMarker + "\n</head>";

                if (wantFontLink)
                {
                    if (hasFontBlock)
                    {
                        updated = RemoveBetweenMarkers(updated, HeadFontStartMarker, HeadFontEndMarker);
                    }
                    updated = ReplaceFirst(updated, "</head>", fontTag);
                }
                else if (hasFontBlock)
                {
                    updated = RemoveBetweenMarkers(updated, HeadFontStartMarker, HeadFontEndMarker);
                }

                var scriptTag = HtmlStartMarker + "\n<script defer src=\"/FinoraUI/main.js\"></script>\n<script defer src=\"/FinoraUI/player.js\"></script>\n" + HtmlEndMarker + "\n</body>";

                if (wantScript)
                {
                    if (hasScriptBlock)
                    {
                        updated = RemoveBetweenMarkers(updated, HtmlStartMarker, HtmlEndMarker);
                    }
                    updated = ReplaceLast(updated, "</body>", scriptTag);
                }
                else if (hasScriptBlock)
                {
                    updated = RemoveBetweenMarkers(updated, HtmlStartMarker, HtmlEndMarker);
                }

                if (!string.Equals(updated, content, StringComparison.Ordinal))
                {
                    File.WriteAllText(indexPath, updated);
                    _logger.LogInformation(
                        "FinoraUI: updated index.html injection (font link: {Font}, hover-preview script: {Script})",
                        wantFontLink,
                        wantScript);
                }

                if (!wantFontLink && !wantScript
                    && !updated.Contains(HeadFontStartMarker, StringComparison.Ordinal)
                    && !updated.Contains(HtmlStartMarker, StringComparison.Ordinal)
                    && File.Exists(backupPath))
                {
                    File.Delete(backupPath);
                    _logger.LogInformation("FinoraUI: both index.html injections are off; removed the backup file");
                }
            }
            catch (UnauthorizedAccessException ex)
            {
                _logger.LogError(
                    ex,
                    "FinoraUI: no write permission on {Path}. The hover-preview script and the Google Fonts " +
                    "<link> both need the Jellyfin service account to have write access to the jellyfin-web " +
                    "folder (this is common on package/container installs that mount web content read-only). " +
                    "The rest of the CSS skin still applies normally; card titles will just fall back to the " +
                    "server's default font weights without the <link>.",
                    indexPath);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "FinoraUI: failed while patching/restoring index.html");
            }
        }

        /// <summary>
        /// Builds the CSS that hides the video-player buttons switched off on the settings page.
        /// </summary>
        private static string BuildPlayerOptionsCss(PluginConfiguration config)
        {
            var hidden = new List<string>();

            if (!config.ShowPlayerSyncPlay)
            {
                hidden.Add("#videoOsdPage button[aria-label=\"SyncPlay\"]");
                hidden.Add(".videoOsdBottom button[aria-label=\"SyncPlay\"]");
                hidden.Add(".osdHeader button[aria-label=\"SyncPlay\"]");
                hidden.Add(".skinHeader.osdHeader button[aria-label=\"SyncPlay\"]");
            }

            if (!config.ShowPlayerPip)
            {
                hidden.Add(".videoOsdBottom .btnPip");
                hidden.Add(".videoOsdBottom button:has(.picture_in_picture_alt)");
            }

            if (!config.ShowPlayerFullscreen)
            {
                hidden.Add(".videoOsdBottom .btnToggleFullscreen");
                hidden.Add(".videoOsdBottom button:has(.fullscreen)");
                hidden.Add(".videoOsdBottom button:has(.fullscreen_exit)");
            }

            if (!config.ShowPlayerChapterButtons)
            {
                hidden.Add(".videoOsdBottom .btnPreviousChapter");
                hidden.Add(".videoOsdBottom .btnNextChapter");
            }

            if (!config.ShowPlayerSeekButtons)
            {
                hidden.Add(".videoOsdBottom .btnRewind");
                hidden.Add(".videoOsdBottom .btnFastForward");
            }

            if (hidden.Count == 0)
            {
                return "/* Video player buttons: none hidden (plugin settings) */";
            }

            return "/* Video player buttons hidden via plugin settings */\n"
                + string.Join(",\n", hidden)
                + " {\n    display: none !important;\n}";
        }

        private static string GetEmbeddedText(string relativeName)
        {
            var asm = typeof(SkinEntryPoint).Assembly;
            var fullName = typeof(SkinEntryPoint).Namespace + "." + relativeName;
            using var stream = asm.GetManifestResourceStream(fullName)
                ?? throw new InvalidOperationException("Embedded resource not found: " + fullName);
            using var reader = new StreamReader(stream);
            return reader.ReadToEnd();
        }

        /// <summary>
        /// Removes every block this plugin wrote into the custom CSS.
        /// Older builds shipped marker text inside main.css itself, so each re-apply only cut up to
        /// the first inner end marker and left a stale copy of the skin (including old player-button
        /// hide rules) behind. If an end marker appears before the first start marker, that leftover
        /// is present, so everything up to the last end marker is purged. CSS placed before the first
        /// start marker (clean case) or after the last end marker is kept.
        /// </summary>
        private static string RemoveSkinCss(string input)
        {
            var firstStart = input.IndexOf(CssStartMarker, StringComparison.Ordinal);
            var firstEnd = input.IndexOf(CssEndMarker, StringComparison.Ordinal);
            var lastEnd = input.LastIndexOf(CssEndMarker, StringComparison.Ordinal);
            if (lastEnd < 0)
            {
                return input;
            }

            var removeFrom = (firstStart < 0 || firstEnd < firstStart) ? 0 : firstStart;
            var removeTo = lastEnd + CssEndMarker.Length;
            return removeTo <= removeFrom ? input : input.Remove(removeFrom, removeTo - removeFrom);
        }

        private static string RemoveBetweenMarkers(string input, string start, string end)
        {
            var startIdx = input.IndexOf(start, StringComparison.Ordinal);
            if (startIdx < 0)
            {
                return input;
            }

            var endIdx = input.IndexOf(end, startIdx, StringComparison.Ordinal);
            if (endIdx < 0)
            {
                return input;
            }

            return input.Remove(startIdx, endIdx + end.Length - startIdx);
        }

        private static string ReplaceLast(string input, string search, string replacement)
        {
            var idx = input.LastIndexOf(search, StringComparison.Ordinal);
            return idx < 0 ? input : input.Substring(0, idx) + replacement + input.Substring(idx + search.Length);
        }

        private static string ReplaceFirst(string input, string search, string replacement)
        {
            var idx = input.IndexOf(search, StringComparison.Ordinal);
            return idx < 0 ? input : input.Substring(0, idx) + replacement + input.Substring(idx + search.Length);
        }
    }
}
