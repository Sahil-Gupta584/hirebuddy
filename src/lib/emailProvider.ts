// Detect email provider from domain via DNS MX — to show quick guide for token
// No extra dep: uses https://dns.google/resolve

export type EmailProvider = "gmail" | "outlook" | "zoho" | "proton" | "imap" | "unknown";

export async function detectEmailProvider(email: string): Promise<{ provider: EmailProvider; mx: string[]; guide: string }> {
  const domain = email.split("@")[1]?.toLowerCase() || "";
  if (!domain) return { provider: "unknown", mx: [], guide: guideFor("unknown") };

  // fast path for well-known
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return { provider: "gmail", mx: ["aspmx.l.google.com"], guide: guideFor("gmail") };
  }
  if (domain.endsWith("outlook.com") || domain.endsWith("hotmail.com") || domain.endsWith("live.com") || domain.endsWith("onmicrosoft.com")) {
    return { provider: "outlook", mx: ["outlook.protection.outlook.com"], guide: guideFor("outlook") };
  }

  try {
    const res = await fetch(`https://dns.google/resolve?name=${domain}&type=MX`);
    const data = await res.json();
    const mx: string[] = (data.Answer || []).map((a: any) => String(a.data).toLowerCase());
    const mxJoined = mx.join(" ");

    if (mxJoined.includes("google") || mxJoined.includes("aspmx") || mxJoined.includes("googlemail")) {
      return { provider: "gmail", mx, guide: guideFor("gmail") }; // Workspace on Google
    }
    if (mxJoined.includes("outlook") || mxJoined.includes("protection.outlook") || mxJoined.includes("office365") || mxJoined.includes("microsoft")) {
      return { provider: "outlook", mx, guide: guideFor("outlook") };
    }
    if (mxJoined.includes("zoho")) return { provider: "zoho", mx, guide: guideFor("zoho") };
    if (mxJoined.includes("proton")) return { provider: "proton", mx, guide: guideFor("proton") };
    if (mx.length === 0) return { provider: "unknown", mx, guide: guideFor("unknown") };
    return { provider: "imap", mx, guide: guideFor("imap", mx[0]) };
  } catch {
    return { provider: "unknown", mx: [], guide: guideFor("unknown") };
  }
}

function guideFor(provider: EmailProvider, mxExample?: string): string {
  switch (provider) {
    case "gmail":
      return `Detected: Google (Gmail/Workspace).
Get token free (2 min):
1) https://console.cloud.google.com/apis/library/gmail.googleapis.com → Enable
2) https://developers.google.com/oauthplayground → select https://www.googleapis.com/auth/gmail.readonly → Authorize as this email → Exchange → copy access_token
Or: npx gmail-token-cli`;
    case "outlook":
      return `Detected: Microsoft Outlook 365.
Get token free:
1) https://portal.azure.com → App registrations → New → API permissions → Microsoft Graph → Mail.Read → Grant
2) https://developer.microsoft.com/graph/graph-explorer → sign in as this email → copy token
Or use Outlook token in CLI.`;
    case "zoho":
      return `Detected: Zoho Mail.
Get token: https://api-console.zoho.com → Add Client → ZohoMail.messages.READ → Generate token.`;
    case "proton":
      return `Detected: ProtonMail (no Gmail/Graph API).
Use Bridge IMAP: Proton Bridge → IMAP host 127.0.0.1 + app password, or forward to Gmail and use Gmail token.`;
    case "imap":
      return `Detected: Custom mail (${mxExample || "custom MX"}).
Use IMAP: host = imap.${provider} (check cPanel), port 993, app password. Or forward last 20 mails from this address to a Gmail and use Gmail token.`;
    default:
      return `Custom domain — could not detect MX. If it's Google Workspace, use Gmail guide; if Outlook, use Outlook guide; else use IMAP host or forward to Gmail.`;
  }
}

// Quick helper to format time range into Gmail/Graph filters
export function timeRangeToQuery(range: string): { gmailQ: string; graphFilter: string; since: Date; until: Date } {
  const now = new Date();
  let since = new Date(now);
  let until = new Date(now);
  const r = range.toLowerCase().trim();
  if (r.includes("7")) since.setDate(now.getDate() - 7);
  else if (r.includes("14")) since.setDate(now.getDate() - 14);
  else if (r.includes("30")) since.setDate(now.getDate() - 30);
  else if (r.match(/\d+.*day/)) {
    const n = parseInt(r) || 7;
    since.setDate(now.getDate() - n);
  } else {
    since.setDate(now.getDate() - 7); // default 7 days
  }
  const fmt = (d: Date) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  const gmailQ = `after:${fmt(since)} before:${fmt(until)}`;
  const graphFilter = `receivedDateTime ge ${since.toISOString()} and receivedDateTime le ${until.toISOString()}`;
  return { gmailQ, graphFilter, since, until };
}
