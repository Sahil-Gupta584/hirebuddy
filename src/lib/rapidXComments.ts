// Fetch X post comments via twitter-api45 RapidAPI (no official X API needed)
// Endpoint: GET https://twitter-api45.p.rapidapi.com/tweet_thread.php?id=<tweet_id>
// Free tier: get key at https://rapidapi.com/alexanderxbx/api/twitter-api45/
// Key point: entities.urls[].expanded_url resolves t.co → real URL (fixes "https://por tfolio..." issue)

export type XComment = {
  author: string;
  handle: string;
  text: string;
  link?: string;
  entities?: { expandedUrls: string[] };
};

export async function fetchXCommentsRapidAPI(
  postUrl: string,
  rapidApiKey: string
): Promise<XComment[]> {
  const id = postUrl.match(/status\/(\d+)/)?.[1];
  if (!id) throw new Error("Invalid X URL — no tweet id");

  const res = await fetch(`https://twitter-api45.p.rapidapi.com/tweet_thread.php?id=${id}`, {
    headers: {
      "X-RapidAPI-Key": rapidApiKey,
      "X-RapidAPI-Host": "twitter-api45.p.rapidapi.com",
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 429) throw new Error(`RapidAPI rate limit hit — upgrade plan or wait. raw: ${txt.slice(0,200)}`);
    if (res.status === 403 || res.status === 401) throw new Error(`RapidAPI key invalid or expired — get one at https://rapidapi.com/alexanderxbx/api/twitter-api45/ raw: ${txt.slice(0,200)}`);
    throw new Error(`RapidAPI ${res.status}: ${txt.slice(0, 400)}`);
  }

  const data: any = await res.json();
  const thread: any[] = data.thread || [];

  if (!Array.isArray(thread)) throw new Error("Unexpected RapidAPI response shape (no thread array)");

  const postAuthorId = data.author?.rest_id;

  return thread
    .filter(t => {
      if (t.author?.rest_id === postAuthorId && t.text?.length < 20) return false;
      return true;
    })
    .map(t => {
      // Resolve t.co links via entities.urls.expanded_url — this is the proper fix for "https://por tfolio..."
      const expandedUrls: string[] = (t.entities?.urls || []).map((u: any) => u.expanded_url).filter(Boolean);
      let text: string = t.display_text || t.text || "";
      // Replace t.co short links in text with expanded_url (real link)
      for (const u of (t.entities?.urls || [])) {
        if (u.url && u.expanded_url) text = text.replace(u.url, u.expanded_url);
      }
      text = text.replace(/@\w+\s*/g, "").trim(); // strip @mention prefix

      // Best link = first portfolio/github link from expanded_urls, fallback to first url
      const link = expandedUrls.find(u => !u.includes("twitter.com") && !u.includes("x.com")) || expandedUrls[0];

      return {
        author: t.author?.name || t.author?.screen_name || "user",
        handle: t.author?.screen_name || "",
        text,
        link,
        entities: { expandedUrls },
      };
    })
    .filter(c => c.text.length > 0);
}
