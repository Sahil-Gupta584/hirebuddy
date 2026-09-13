// Fetch structured details for X / GitHub / LinkedIn — replaces old proof object
import { scrapeUrl } from "./firecrawl.js";

export type CandidateDetails = {
  xDetails?: { handle?: string; name?: string; bio?: string; location?: string; followers?: number; following?: number; website?: string; joined?: string };
  githubDetails?: { username?: string; name?: string; bio?: string; public_repos?: number; followers?: number; totalStars?: number; topRepos?: string[]; languages?: string[] };
};

export async function fetchCandidateDetails(
  handles: { github?: string; twitter?: string; portfolio?: string },
  firecrawlKey?: string
): Promise<CandidateDetails> {
  const out: CandidateDetails = {};

  // X details via fxtwitter (free, no key) + fallback Firecrawl
  if (handles.twitter) {
    const h = handles.twitter.match(/(?:x\.com|twitter\.com)\/([^/?#]+)/i)?.[1]?.replace("@","") || handles.twitter;
    try {
      const r = await fetch(`https://api.fxtwitter.com/${h}`);
      if (r.ok) {
        const j: any = await r.json();
        const u = j.user || j;
        out.xDetails = {
          handle: u.screen_name || h,
          name: u.name,
          bio: (u.description || u.raw_description?.text || "").slice(0, 600),
          location: u.location,
          followers: u.followers,
          following: u.following,
          website: u.website?.url,
          joined: u.joined,
        };
      }
    } catch {}
    if (!out.xDetails?.bio && handles.twitter) {
      try { const s = await scrapeUrl(handles.twitter, firecrawlKey); if (s?.markdown) out.xDetails = { ...out.xDetails, bio: s.markdown.slice(0,600) } as any; } catch {}
    }
  }

  // GitHub details via public API + profile md
  if (handles.github) {
    const m = handles.github.match(/github\.com\/([a-zA-Z0-9-]+)/);
    const user = m?.[1];
    if (user) {
      try {
        const ur = await fetch(`https://api.github.com/users/${user}`, { headers: { "User-Agent": "hirebuddy/0.1" } });
        if (ur.ok) {
          const u: any = await ur.json();
          const rr = await fetch(`https://api.github.com/users/${user}/repos?per_page=100&sort=updated`, { headers: { "User-Agent": "hirebuddy/0.1" } });
          let totalStars = 0; let topRepos: string[] = []; let langs = new Set<string>();
          if (rr.ok) {
            const repos: any[] = await rr.json();
            for (const r of repos) { totalStars += r.stargazers_count || 0; if (r.language) langs.add(r.language); }
            topRepos = repos.sort((a,b)=>b.stargazers_count-a.stargazers_count).slice(0,3).map(r=>`${r.name} (${r.stargazers_count}★)`);
          }
          out.githubDetails = {
            username: user,
            name: u.name,
            bio: (u.bio || "").slice(0,600),
            public_repos: u.public_repos,
            followers: u.followers,
            totalStars,
            topRepos,
            languages: Array.from(langs).slice(0,5),
          };
        }
      } catch {}
      if (!out.githubDetails) {
        try {
          const s = await scrapeUrl(`https://github.com/${user}`, firecrawlKey);
          if (s?.markdown) out.githubDetails = { username: user, bio: s.markdown.slice(0,800) } as any;
        } catch {}
      }
    }
  }

  return out;
}

// Fetch extra context from portfolio article links (Upwork/Fiverr/client blogs) — LLM can see them
export async function fetchExtraContext(links: string[], firecrawlKey?: string): Promise<string> {
  // Filter to interesting article/client links, not github/x which are already in details
  const allow = links.filter(u => {
    const l = u.toLowerCase();
    if (l.includes("github.com") || l.includes("x.com") || l.includes("twitter.com")) return false;
    return /^https?:\/\//.test(u);
  });
  // Dedupe, cap to 3 most relevant (to avoid credit burn)
  const unique = [...new Set(allow)].slice(0, 3);
  if (unique.length === 0) return "";
  const parts: string[] = [];
  for (const url of unique) {
    try {
      // onlyMainContent:true — drops nav/footer noise, gives clean article body
      const s = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { Authorization: `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, waitFor: 2000 }),
      }).then(r => r.json()).then(j => j.success ? { markdown: j.data?.markdown || "" } : null).catch(() => null);
      if (s?.markdown) {
        parts.push(`--- Link: ${url} ---\n${s.markdown.slice(0, 4000)}`);
      }
    } catch {}
  }
  return parts.join("\n\n");
}
