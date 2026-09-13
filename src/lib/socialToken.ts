// Token-only API for X comments — LinkedIn removed
// X: Bearer token → GET https://api.twitter.com/2/tweets/:id + conversation

export async function fetchCommentsWithToken(
  postUrl: string,
  provider: "x",
  token: string
): Promise<Array<{ author: string; text: string; link?: string }>> {
  return fetchXComments(postUrl, token);
}

async function fetchXComments(postUrl: string, bearer: string): Promise<Array<{ author: string; text: string; link?: string }>> {
  const id = postUrl.match(/status\/(\d+)/)?.[1];
  if (!id) throw new Error("Invalid X URL — no status id");

  // Normalize token (allow pasting "Bearer xxx", "xxx", or URL-encoded xxx with %2B)
  let raw = bearer.trim().replace(/^["']|["']$/g, "");
  try { raw = decodeURIComponent(raw); } catch {}
  raw = raw.replace(/^Bearer\s+/i, "");
  const auth = `Bearer ${raw}`;

  // Use api.x.com (new host per https://docs.x.com/x-api/getting-started/make-your-first-request)
  // 1) Try X API v2 conversation search (needs tweet.read + Project attached)
  // GET /2/tweets/search/recent?query=conversation_id:ID&max_results=100
  const searchUrl = `https://api.x.com/2/tweets/search/recent?query=conversation_id:${id}&max_results=100&tweet.fields=author_id,created_at&expansions=author_id&user.fields=username`;

  const res = await fetch(searchUrl, { headers: { Authorization: auth } });
  if (!res.ok) {
    const txt = await res.text();
    if (txt.includes("client-not-enrolled") || txt.includes("Client Forbidden")) {
      throw new Error(`X API 403 client-not-enrolled: Token not attached to a Project. Fix: https://console.x.com → Project → Attach App → regenerate Bearer token. Docs: https://docs.x.com/x-api/getting-started/getting-access — raw: ${txt.slice(0,200)}`);
    }
    if (res.status === 403 || res.status === 401) throw new Error(`X API ${res.status}: ${txt.slice(0,400)} — check Bearer token is from a Project-attached App (https://docs.x.com/x-api/getting-started/make-your-first-request)`);
    throw new Error(`X API ${res.status}: ${txt.slice(0,400)}`);
  }
  const data = await res.json();
  const tweets = data.data || [];
  const users: Record<string, string> = {};
  for (const u of data.includes?.users || []) users[u.id] = u.username;

  return tweets.map((t: any) => ({
    author: users[t.author_id] || t.author_id || "x_user",
    text: t.text?.slice(0, 500) || "",
    link: (t.text?.match(/https?:\/\/\S+/) || [])[0],
  }));
}


