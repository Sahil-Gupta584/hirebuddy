// Enrich candidate with X bio and GitHub profile markdown (LinkedIn removed)
import { scrapeUrl } from "./firecrawl.js";

export type EnrichedBio = {
  xBio?: string;
  githubMd?: string;
  summary: string;
};

export async function enrichCandidateBio(handles: { github?: string; twitter?: string }, firecrawlKey?: string): Promise<EnrichedBio> {
  const out: EnrichedBio = { summary: "" };
  const parts: string[] = [];

  // X bio via fxtwitter or Firecrawl
  if (handles.twitter) {
    try {
      const handle = handles.twitter.match(/(?:x\.com|twitter\.com)\/([^/?#]+)/i)?.[1] || handles.twitter;
      // Try fxtwitter user endpoint (free)
      const res = await fetch(`https://api.fxtwitter.com/${handle}`);
      if (res.ok) {
        const j: any = await res.json();
        const bio = j.user?.description || j.user?.raw_description?.text || "";
        if (bio) {
          out.xBio = bio.slice(0, 800);
          parts.push(`X @${handle}: ${bio.slice(0, 120)}`);
        }
      }
    } catch {}
    if (!out.xBio && handles.twitter) {
      try {
        const s = await scrapeUrl(handles.twitter, firecrawlKey);
        if (s?.markdown) out.xBio = s.markdown.slice(0, 800);
      } catch {}
    }
  }

  // GitHub profile md via Firecrawl (github.com/username)
  if (handles.github) {
    try {
      const m = handles.github.match(/github\.com\/([a-zA-Z0-9-]+)/);
      const user = m?.[1];
      if (user) {
        const s = await scrapeUrl(`https://github.com/${user}`, firecrawlKey);
        if (s?.markdown) out.githubMd = s.markdown.slice(0, 1500);
        // Also try readme
        if (!out.githubMd) {
          const r = await scrapeUrl(`https://raw.githubusercontent.com/${user}/${user}/main/README.md`, firecrawlKey);
          if (r?.markdown) out.githubMd = r.markdown.slice(0, 1500);
        }
        if (out.githubMd) parts.push(`GitHub ${user} md: ${out.githubMd.slice(0, 80).replace(/\n/g," ")}...`);
      }
    } catch {}
  }

  out.summary = parts.join(" | ") || "No extra bio";
  return out;
}
