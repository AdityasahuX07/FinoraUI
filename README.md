<div align="center">
  <h1>FinoraUI for Jellyfin</h1>
  <p>A sleek, modern, and highly customizable UI plugin that transforms your Jellyfin media server experience.</p>
  <img src="assets/banner.png?v=2" alt="FinoraUI Banner" width="800"/>
</div>

---

## 📖 Overview

**FinoraUI** is a custom user interface plugin built specifically for Jellyfin. Rather than simply injecting custom CSS, this plugin deeply integrates with Jellyfin's web client to provide a redesigned media browsing layout, an overhauled video player, and a refined aesthetic—making your self-hosted media look and feel premium.

## ✨ Features

- **Redesigned Interface:** A fresh, modern, and clean aesthetic for the main dashboard and library views.
- **Enhanced Video Player:** A custom-styled HTML5 player interface (`player.css`, `player.js`) built for better usability.
- **Dedicated Plugin Configuration:** Includes a built-in configuration page directly accessible from the Jellyfin Admin Dashboard.
- **Easy Injection:** Automatically injects necessary scripts (`main.js`) and stylesheets (`main.css`) into the Jellyfin web client without requiring manual file modifications.

## 📸 Screenshots

<p align="center">
  <img src="screenshots/Screenshot%202026-09-29%20193628.png?v=2" width="98.5%" alt="Hero Screenshot"/>
  <br/>
  <img src="screenshots/Screenshot%202026-09-29%20193501.png?v=2" width="49%" alt="Screenshot 2"/>
  <img src="screenshots/Screenshot%202026-09-29%20193446.png?v=2" width="49%" alt="Screenshot 3"/>
  <br/>
  <img src="screenshots/new_screenshot_2.png?v=2" width="49%" alt="Screenshot 4"/>
  <img src="screenshots/Screenshot%202026-09-29%20193837.png?v=2" width="49%" alt="Screenshot 5"/>
  <br/>
  <img src="screenshots/Screenshot%202026-09-29%20193533.png?v=2" width="49%" alt="Screenshot 6"/>
  <img src="screenshots/new_screenshot_1.png?v=2" width="49%" alt="Screenshot 7"/>
</p>

---

## 🚀 Installation

### Option 1: Install via Plugin Repository (Recommended)
*(Note: Once you host this plugin as a zip file, you can provide a repository URL for users to easily add to Jellyfin.)*
1. Go to your Jellyfin **Dashboard**.
2. Navigate to **Plugins** > **Repositories**.
3. Add a new repository using this URL: `https://raw.githubusercontent.com/AdityasahuX07/FinoraUI/main/manifest.json` *(Example URL once manifest is created)*.
4. Go to the **Catalog** tab, find **FinoraUI**, and install it.
5. Restart your Jellyfin server.

### Option 2: Manual Installation
1. Download the latest `.zip` release from the [Releases page](https://github.com/AdityasahuX07/FinoraUI/releases).
2. Extract the contents into your Jellyfin server's `plugins` directory:
   - **Windows:** `%AppData%\jellyfin\plugins\FinoraUI`
   - **Linux:** `/var/lib/jellyfin/plugins/FinoraUI`
   - **Docker:** `/config/plugins/FinoraUI`
3. Restart your Jellyfin server.
4. Go to **Dashboard** -> **Plugins** and ensure **FinoraUI** is active.

---

## 🛠️ Configuration

Once installed, FinoraUI can be configured directly from the Jellyfin Admin Dashboard:
1. Go to **Dashboard** -> **Plugins**.
2. Click on **FinoraUI**.
3. Adjust the UI options and custom injection behaviors on the provided configuration page. 
4. Save your changes and refresh your Jellyfin client.

---

## 👨‍💻 Development & Building from Source

If you want to contribute or build the plugin from the source code, you'll need the [.NET SDK](https://dotnet.microsoft.com/download) installed (matching the version specified in the `.csproj`).

1. Clone the repository:
   ```bash
   git clone https://github.com/AdityasahuX07/FinoraUI.git
   cd FinoraUI
   ```
2. Build the project using the `.NET CLI`:
   ```bash
   dotnet build -c Release
   ```
3. The compiled `.dll` and required files will be output to the `bin/Release/...` folder. You can copy this folder into your local Jellyfin plugins directory for testing.

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! 
Feel free to check out the [issues page](https://github.com/AdityasahuX07/FinoraUI/issues) to report bugs or request new features.

---

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.
