using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.FinoraUI
{
    /// <summary>
    /// Registers this plugin's services with Jellyfin's dependency injection
    /// container. This is the current (post-IServerEntryPoint) way Jellyfin
    /// plugins hook into server startup: implement <see cref="SkinEntryPoint"/>
    /// as a standard ASP.NET Core <c>IHostedService</c> and add it here.
    /// </summary>
    public class PluginServiceRegistrator : IPluginServiceRegistrator
    {
        /// <inheritdoc />
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddHostedService<SkinEntryPoint>();
        }
    }
}
