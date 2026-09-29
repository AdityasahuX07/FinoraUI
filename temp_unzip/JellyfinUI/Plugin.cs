using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.NetflixSkin.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.NetflixSkin
{
    /// <summary>
    /// Main plugin entry class. Jellyfin discovers this via <see cref="BasePlugin{TConfigurationType}"/>
    /// and uses <see cref="GetPages"/> to add the "Netflix Skin" page under
    /// Dashboard &gt; Plugins &gt; My Plugins.
    /// </summary>
    public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="Plugin"/> class.
        /// </summary>
        /// <param name="applicationPaths">Instance of <see cref="IApplicationPaths"/>.</param>
        /// <param name="xmlSerializer">Instance of <see cref="IXmlSerializer"/>.</param>
        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
        }

        /// <inheritdoc />
        public override string Name => "Netflix Skin";

        /// <inheritdoc />
        public override string Description =>
            "Restyles Jellyfin Web with a dark, cinematic, Netflix-inspired look " +
            "(navigation, home rails, hover previews, player OSD, search) without " +
            "modifying any core Jellyfin files by hand.";

        /// <inheritdoc />
        public override Guid Id => Guid.Parse("b7f5f3a2-2f0a-4b7a-9d0e-6a1d5c9e2f10");

        /// <summary>
        /// Gets the current plugin instance, used by the entry point / controller to
        /// read the saved <see cref="PluginConfiguration"/>.
        /// </summary>
        public static Plugin? Instance { get; private set; }

        /// <inheritdoc />
        public IEnumerable<PluginPageInfo> GetPages()
        {
            return new[]
            {
                new PluginPageInfo
                {
                    Name = "NetflixSkin",
                    EmbeddedResourcePath = string.Format(
                        CultureInfo.InvariantCulture,
                        "{0}.Configuration.configPage.html",
                        GetType().Namespace)
                }
            };
        }
    }
}
