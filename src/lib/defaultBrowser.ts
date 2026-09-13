// Detect default browser — so we know which channel to launch (chrome/msedge/firefox)
// Windows: reg query UserChoice\http ProgId
// macOS: defaults read com.apple.LaunchServices/com.apple.launchservices.secure
// Linux: xdg-settings get default-web-browser

import { execSync } from "node:child_process";

export type DefaultBrowser = "chrome" | "msedge" | "firefox" | "unknown";

export function getDefaultBrowser(): DefaultBrowser {
  const platform = process.platform;

  try {
    if (platform === "win32") {
      const out = execSync('reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId', { encoding: "utf-8", timeout: 2000 });
      const line = out.split("\n").find(l => l.includes("ProgId")) || "";
      if (line.includes("ChromeHTML")) return "chrome";
      if (line.includes("MSEdgeHTM") || line.includes("MSEdge")) return "msedge";
      if (line.includes("FirefoxURL") || line.includes("Firefox")) return "firefox";
      return "unknown";
    }

    if (platform === "darwin") {
      // macOS: LSCopyDefaultHandlerForURLScheme
      const out = execSync('defaults read com.apple.LaunchServices/com.apple.launchservices.secure 2>/dev/null | grep -i -A2 "http" | head', { encoding: "utf-8", timeout: 2000 });
      if (out.toLowerCase().includes("chrome")) return "chrome";
      if (out.toLowerCase().includes("edge") || out.toLowerCase().includes("msedge")) return "msedge";
      if (out.toLowerCase().includes("firefox")) return "firefox";
      // fallback via duti or plist
      try {
        const out2 = execSync('plutil -p ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist 2>/dev/null | grep -i chrome | head -1', { encoding: "utf-8", timeout: 2000 });
        if (out2.toLowerCase().includes("chrome")) return "chrome";
      } catch {}
      return "unknown";
    }

    // Linux
    const out = execSync('xdg-settings get default-web-browser 2>/dev/null', { encoding: "utf-8", timeout: 2000 });
    const s = out.toLowerCase();
    if (s.includes("chrome")) return "chrome";
    if (s.includes("chromium")) return "chrome";
    if (s.includes("edge") || s.includes("msedge")) return "msedge";
    if (s.includes("firefox")) return "firefox";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function channelFor(browser: DefaultBrowser): "chrome" | "msedge" | undefined {
  if (browser === "chrome") return "chrome";
  if (browser === "msedge") return "msedge";
  return undefined;
}
