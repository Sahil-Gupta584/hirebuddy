// Monid - unified tool router for scraping/fetching
// Docs: https://monid.ai/docs
const MONID_API = "https://api.monid.ai";

export async function monidDiscover(query: string, monidKey: string) {
  if (!monidKey) return null;
  try {
    const res = await fetch(`${MONID_API}/discover`, {
      method: "POST",
      headers: { Authorization: `Bearer ${monidKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.candidates?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function monidRun(toolId: string, input: Record<string, unknown>, monidKey: string) {
  if (!monidKey) return null;
  try {
    const res = await fetch(`${MONID_API}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${monidKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ toolId, input }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Fallback: direct fetch for portfolios when monid not configured
export async function fetchPortfolio(url: string, monidKey?: string): Promise<string> {
  if (monidKey) {
    const tool = await monidDiscover("web page fetch", monidKey);
    if (tool) {
      const out = await monidRun(tool.id, { url }, monidKey);
      if (out?.content) return String(out.content).slice(0, 8000);
    }
  }
  try {
    const res = await fetch(url, { headers: { "User-Agent": "hirebuddy/0.1" } });
    if (!res.ok) return "";
    const html = await res.text();
    // naive strip tags
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 8000);
  } catch {
    return "";
  }
}

export async function fetchSocialComments(
  postUrl: string,
  provider: "x",
  monidKey?: string
): Promise<Array<{ author: string; text: string; link?: string }>> {
  if (monidKey) {
    const q = "x twitter post comments scraper";
    const tool = await monidDiscover(q, monidKey);
    if (tool) {
      const out = await monidRun(tool.id, { url: postUrl }, monidKey);
      if (out?.comments) return out.comments;
    }
  }
  // Fallback mock for hackathon demo (Arga twin mode)
  return [];
}
