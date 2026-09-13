// Firecrawl - requires API key (no keyless) — get at https://firecrawl.dev/app/api-keys
// Docs: POST https://api.firecrawl.dev/v2/scrape { url, formats: ["markdown"] }

export async function extractJDFromPost(postCaption: string, geminiKey: string): Promise<string | null> {
  try {
    const prompt = `You are an ATS. Given this social post caption, extract the Job Description if present.

Post caption:
"""
${postCaption.slice(0, 4000)}
"""

If the post contains a hiring JD (role, stack, experience, location, requirements), return ONLY the JD text (clean, 2-8 lines). If no JD is present (just a meme, opinion, or unrelated post), return exactly: null

Return JSON only: {"jd": string|null}`;

    let model = "gemini-3.1-flash-lite";
    let res: Response | null = null;
    let lastTxt = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      if (res.ok) break;
      lastTxt = await res.text();
      const isQuota = lastTxt.includes("429") || lastTxt.includes("Quota exceeded");
      if (isQuota && model === "gemini-3.1-flash-lite") {
        model = "gemini-2.0-flash-lite";
        continue;
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 8000));
    }
    if (!res || !res.ok) return null;
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0];
    if (jsonStr) {
      const parsed = JSON.parse(jsonStr);
      if (parsed.jd && typeof parsed.jd === "string" && parsed.jd.trim().length > 20 && parsed.jd.toLowerCase() !== "null") {
        return parsed.jd.trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function scrapeUrl(url: string, apiKey?: string): Promise<{ markdown: string; html: string } | null> {
  if (!apiKey) return null; // key required — no keyless
  let res: Response;
  try {
    res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        url,
        formats: ["markdown", "html"],
        onlyMainContent: false,
        waitFor: 2000,
      }),
    });
  } catch (e: any) {
    throw new Error(`Firecrawl request failed (network/timeout) for ${url}: ${e?.message || String(e)}`);
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Firecrawl returned non-JSON (HTTP ${res.status}) for ${url}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Firecrawl key invalid (HTTP ${res.status}) — get a new one at https://firecrawl.dev/app/api-keys. Detail: ${(json?.error || "").toString().slice(0, 120)}`);
  }
  if (res.status === 402 || (json?.error || "").toString().toLowerCase().includes("credit")) {
    throw new Error(`Firecrawl out of credits (HTTP ${res.status}) for ${url} — top up at https://firecrawl.dev/app/api-keys`);
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const err = new Error(`Firecrawl 429 for ${url}: ${(json?.error || "rate limited").toString().slice(0, 200)}`) as any;
    err.retryable = true;
    err.retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 15000;
    throw err;
  }
  if (!res.ok || !json.success) {
    throw new Error(`Firecrawl ${res.status} for ${url}: ${(json?.error || JSON.stringify(json).slice(0, 200)).toString().slice(0, 200)}`);
  }
  if (!json.data?.markdown) {
    throw new Error(`Firecrawl empty markdown for ${url}: ${JSON.stringify(json.data).slice(0, 200)}`);
  }
  return { markdown: json.data.markdown || "", html: json.data.html || "" };
}

export async function scrapeUrlWithRetry(url: string, apiKey?: string, maxRetries = 3): Promise<{ markdown: string; html: string } | null> {
  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await scrapeUrl(url, apiKey);
    } catch (e: any) {
      lastErr = e;
      if (!e.retryable || attempt === maxRetries) throw e;
      await new Promise(r => setTimeout(r, e.retryAfterMs || 15000));
    }
  }
  throw lastErr;
}

// Fetch X/LinkedIn post content + comments — tries to get ALL comments, not just Top 3
export async function fetchPostWithComments(postUrl: string, firecrawlKey?: string): Promise<{ content: string; comments: Array<{ author: string; text: string; link?: string }> }> {
  const allComments: Array<{ author: string; text: string; link?: string }> = [];
  let mainContent = "";

  // 1) Firecrawl scrape — gets Post + Thread + Top Comments (usually 1-10)
  const scraped = await scrapeUrl(postUrl, firecrawlKey);
  if (scraped?.markdown) {
    const md = scraped.markdown;
    mainContent = md.slice(0, 4000);
    // Parse Firecrawl's structured "## Top Comments" / "### @handle" blocks
    const commentBlocks = md.split(/###\s+@/).slice(1); // split on comment headers
    for (const block of commentBlocks) {
      const handle = block.split("\n")[0]?.trim().split(" ")[0]?.replace(/\\/g, "") || "user";
      const textMatch = block.match(/>\s*(.+)/);
      const text = textMatch ? textMatch[1].trim().slice(0, 500) : block.split("\n").slice(1).join(" ").slice(0, 500);
      if (text.length > 15) allComments.push({ author: handle, text, link: text.match(/https?:\/\/\S+/)?.[0] });
    }
    // Fallback heuristic if no structured blocks
    if (allComments.length === 0) {
      const lines = md.split("\n").filter((l) => l.trim().length > 20);
      lines.slice(2, 30).filter(l => l.length > 30 && l.length < 500).slice(0, 15).forEach((text, i) => {
        allComments.push({ author: `User${i + 1}`, text: text.trim(), link: text.match(/https?:\/\/\S+/)?.[0] });
      });
    }
  }

  // 2) For X: try free public mirrors that often have MORE replies than Firecrawl
  if (postUrl.includes("x.com") || postUrl.includes("twitter.com")) {
    // 2a) Nitter instance scrape (no key, often has many replies)
    try {
      const id = postUrl.match(/status\/(\d+)/)?.[1];
      if (id) {
        const nitterHosts = ["nitter.net", "nitter.privacydev.net", "nitter.poast.org"];
        for (const host of nitterHosts) {
          try {
            const nres = await fetch(`https://${host}/i/status/${id}`, { headers: { "User-Agent": "hirebuddy/0.1" } });
            if (nres.ok) {
              const html = await nres.text();
              // naive extract reply texts
              const matches = [...html.matchAll(/class="tweet-content[^"]*">([^<]{20,500})</g)];
              for (const m of matches.slice(0, 40)) {
                const text = m[1].replace(/\s+/g, " ").trim();
                if (text.length > 20 && !allComments.some(c => c.text === text)) {
                  allComments.push({ author: "nitter_user", text, link: text.match(/https?:\/\/\S+/)?.[0] });
                }
              }
              if (allComments.length >= 15) break;
            }
          } catch {}
        }
      }
    } catch {}
  }

  if (mainContent) return { content: mainContent, comments: allComments };

  // Fallback for X: try free fxtwitter API (no key, public tweets)
  if (postUrl.includes("x.com") || postUrl.includes("twitter.com")) {
    try {
      const id = postUrl.match(/status\/(\d+)/)?.[1];
      if (id) {
        // fxtwitter / vxtwitter free API
        const res = await fetch(`https://api.fxtwitter.com/status/${id}`);
        if (res.ok) {
          const data = await res.json();
          const tweet = data.tweet ?? data;
          const content = tweet.text ?? tweet.content ?? "";
          // fxtwitter doesn't give all comments, return main content
          return { content, comments: [] };
        }
      }
    } catch {}
  }

  // Fallback direct fetch
  try {
    const res = await fetch(postUrl, { headers: { "User-Agent": "hirebuddy/0.1" } });
    const html = await res.text();
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000);
    return { content: text, comments: [] };
  } catch {
    return { content: "", comments: [] };
  }
}

export async function fetchPortfolioFree(url: string, firecrawlKey?: string): Promise<string> {
  if (!firecrawlKey) throw new Error("Firecrawl key required for portfolio scrape");
  const scraped = await scrapeUrlWithRetry(url, firecrawlKey);
  if (scraped?.markdown) return scraped.markdown.slice(0, 8000);
  throw new Error(`Firecrawl empty markdown for ${url}`);
}

// Classify URLs from comment + X bio — one Gemini call returns {valid, portfolio, others[]}
// Also gates validity: valid=false means not a genuine job application (spam/meme/chatter)
// "portfolio" = the root URL most likely to be the candidate's work showcase site
// "others" = everything else worth reading (Drive PDFs, work profiles, freelance profiles, etc.)
export async function classifyUrls(
  commentText: string,
  xBio: string,
  urls: string[],
  geminiKey: string,
  jd: string
): Promise<{ valid: boolean; portfolio: string | null; others: string[] }> {
  const candidates = [...new Set(urls)].filter(
    u => u.startsWith("http") && !u.includes("t.co")
  );

  const prompt = `You are a hiring filter. Given a candidate's comment, X bio, and JD, do two things:

1. Decide if this is a genuine job application.
Genuine = expressing interest in the job, sharing work/portfolio/resume, or asking to apply — even short ones like "Can I apply", "Interested", "DM'ed".
NOT genuine = spam, ads, memes, irrelevant chatter, trending news, zero application intent.
If NOT genuine, return exactly: {"valid": false}

2. If genuine, classify the URLs.
"portfolio" = index of URL that is the candidate's work/portfolio root site (personal site, carrd.co, notion work page, behance.net/user), or null.
"others" = indices of all other URLs worth reading (Drive PDFs, LinkedIn, GitHub profile, linktr.ee, Medium, etc.). Max 4. Exclude x.com/twitter.com.

JD: "${jd.slice(0, 400)}"
Comment: "${commentText.slice(0, 600)}"
X bio: "${xBio.slice(0, 300)}"
URLs: ${candidates.length > 0 ? candidates.map((u, i) => `${i}: ${u}`).join("\n") : "(none)"}

Return JSON only:
{"valid": true, "portfolio": number|null, "others": [numbers]}`;

  let res: Response | null = null;
  let model = "gemini-3.1-flash-lite";
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } }),
    });
    if (res.ok) break;
    const txt = await res.text();
    if ((txt.includes("429") || txt.includes("Quota")) && model === "gemini-3.1-flash-lite") {
      model = "gemini-2.0-flash-lite"; continue;
    }
    if (attempt === 2) return { valid: true, portfolio: null, others: candidates.slice(0, 4) }; // fallback: assume valid
    await new Promise(r => setTimeout(r, 8000));
  }
  if (!res?.ok) return { valid: true, portfolio: null, others: candidates.slice(0, 4) };

  try {
    const data: any = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonStr) return { valid: true, portfolio: null, others: candidates.slice(0, 4) };
    const parsed = JSON.parse(jsonStr);
    if (parsed.valid === false) return { valid: false, portfolio: null, others: [] };
    const portfolioIdx = parsed.portfolio !== null && parsed.portfolio !== undefined ? Number(parsed.portfolio) : null;
    const portfolio = portfolioIdx !== null && !isNaN(portfolioIdx) && candidates[portfolioIdx] ? candidates[portfolioIdx] : null;
    const others = (Array.isArray(parsed.others) ? parsed.others : [])
      .map((i: any) => candidates[Number(i)])
      .filter((u: string | undefined): u is string => !!u && u !== portfolio)
      .slice(0, 4);
    return { valid: true, portfolio, others };
  } catch {
    return { valid: true, portfolio: null, others: candidates.slice(0, 4) };
  }
}

// Deep-scrape a portfolio: use /v1/map to get all internal links, then scrape each page (first-page only)
// same-domain filter prevents following external links
export async function mapPortfolio(
  rootUrl: string,
  firecrawlKey: string,
  maxPages = 8
): Promise<Array<{ url: string; md: string }>> {
  const rootDomain = (() => { try { return new URL(rootUrl).hostname; } catch { return ""; } })();
  if (!rootDomain) return [];

  // Step 1: scrape root page first (always include)
  const pages: Array<{ url: string; md: string }> = [];
  try {
    const root = await scrapeUrlWithRetry(rootUrl, firecrawlKey);
    if (root?.markdown) pages.push({ url: rootUrl, md: root.markdown.slice(0, 4000) });
  } catch { return pages; }

  // Step 2: /v1/map to get internal links
  let internalLinks: string[] = [];
  try {
    const mapRes = await fetch("https://api.firecrawl.dev/v1/map", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${firecrawlKey}` },
      body: JSON.stringify({ url: rootUrl, includeSubdomains: false, limit: 30 }),
    });
    if (mapRes.ok) {
      const mapData: any = await mapRes.json();
      internalLinks = (mapData.links || [])
        .filter((u: string) => {
          try { return new URL(u).hostname === rootDomain && u !== rootUrl; } catch { return false; }
        })
        .slice(0, maxPages - 1); // -1 because root already scraped
    }
  } catch {}

  // Step 3: scrape each internal link (throttled)
  for (const link of internalLinks) {
    if (pages.length >= maxPages) break;
    await new Promise(r => setTimeout(r, 2000));
    try {
      const s = await scrapeUrlWithRetry(link, firecrawlKey);
      if (s?.markdown) pages.push({ url: link, md: s.markdown.slice(0, 4000) });
    } catch {}
  }

  return pages;
}
