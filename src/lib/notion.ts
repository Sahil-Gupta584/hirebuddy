// Notion - writes ranked candidates as a database (table view)
// Strategy: find existing hirebuddy db on parent page → archive all rows → re-insert fresh.
// Falls back to creating a new db if none found.

export type RankedCandidate = {
  rank: number;
  name: string;
  email: string;
  score: number;
  reason: string;
  greenFlags: string[];
  redFlags: string[];
  handles: { github?: string; portfolio?: string; twitter?: string; links: string[] };
  links: string[];
  source: "x" | "gmail";
  comment?: string;      // raw comment caption
  commentLink?: string;  // direct link to the comment/tweet
  llmRaw?: string;
};

const t = (s: string, max = 1900) => (s || "—").slice(0, max);
const rt = (s: string, max = 1900) => [{ type: "text", text: { content: t(s, max) } }];

// Bullet points with a blank-paragraph gap between each
const flagBlocks = (flags: string[]) =>
  (flags || ["—"]).flatMap((f, i, arr) => [
    { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(f) } },
    ...(i < arr.length - 1
      ? [{ object: "block", type: "paragraph", paragraph: { rich_text: rt("") } }]
      : []),
  ]);

export async function pushToNotion(
  candidates: RankedCandidate[],
  notionToken?: string,
  parentPageId?: string
): Promise<string> {
  const baseUrl = process.env.NOTION_API_BASE_URL || "https://api.notion.com";

  if (!notionToken) {
    const { outputDir } = await import("./config.js");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const jsonPath = join(outputDir(), `rank-${ts}.json`);
    writeFileSync(
      jsonPath,
      JSON.stringify({ exportedAt: new Date().toISOString(), count: candidates.length, candidates }, null, 2)
    );
    return jsonPath;
  }

  if (!parentPageId) {
    throw new Error(
      `Notion parent page ID required.\nSteps:\n1) Open any Notion page\n2) Click "..." → "Add connections" → hirebuddy\n3) Copy the page ID from the URL`
    );
  }

  const cleanId = parentPageId.replace(/-/g, "").replace(/[^a-f0-9]/gi, "");
  const pageId =
    cleanId.length === 32
      ? `${cleanId.slice(0, 8)}-${cleanId.slice(8, 12)}-${cleanId.slice(12, 16)}-${cleanId.slice(16, 20)}-${cleanId.slice(20)}`
      : parentPageId;

  const headers = {
    Authorization: `Bearer ${notionToken}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  const notOk = async (res: Response, label: string) => {
    const d: any = await res.json().catch(() => ({}));
    const hint =
      res.status === 404
        ? " — Share the parent page with hirebuddy integration (page → ··· → Connections → Add connections)"
        : "";
    throw new Error(`Notion ${label} ${res.status}: ${d.message || JSON.stringify(d)}${hint}`);
  };

  const DB_TITLE = "Hirebuddy Rankings";

  const DB_PROPERTIES = {
    "Candidate":     { title: {} },
    "Comment":       { rich_text: {} },
    "Reason":        { rich_text: {} },
    "Green Flags":   { rich_text: {} },
    "Red Flags":     { rich_text: {} },
    "Email":         { email: {} },
    "Links":         { rich_text: {} },
  };

  // 1. Find existing hirebuddy db on parent page (search by title)
  let dbId: string | null = null;
  let dbUrl: string | null = null;

  const searchRes = await fetch(`${baseUrl}/v1/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: DB_TITLE, filter: { value: "database", property: "object" }, page_size: 10 }),
  });
  if (searchRes.ok) {
    const searchData: any = await searchRes.json();
    const match = (searchData.results || []).find(
      (r: any) =>
        r.parent?.page_id === pageId &&
        r.title?.[0]?.plain_text === DB_TITLE
    );
    if (match) {
      dbId = match.id;
      dbUrl = match.url;
    }
  }

  if (dbId) {
    // 2a. Archive all existing rows
    let cursor: string | undefined;
    do {
      const qRes = await fetch(`${baseUrl}/v1/databases/${dbId}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      });
      if (!qRes.ok) break;
      const qData: any = await qRes.json();
      for (const row of qData.results || []) {
        await fetch(`${baseUrl}/v1/pages/${row.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ archived: true }),
        });
      }
      cursor = qData.has_more ? qData.next_cursor : undefined;
    } while (cursor);

    // 2b. Update db title with fresh date + count
    await fetch(`${baseUrl}/v1/databases/${dbId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: rt(`${DB_TITLE} — ${candidates.length} candidates · ${new Date().toISOString().slice(0, 10)}`) }),
    });
  } else {
    // 3. Create fresh db
    const dbRes = await fetch(`${baseUrl}/v1/databases`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        parent: { type: "page_id", page_id: pageId },
        is_inline: true,
        title: rt(`${DB_TITLE} — ${candidates.length} candidates · ${new Date().toISOString().slice(0, 10)}`),
        properties: DB_PROPERTIES,
      }),
    });
    if (!dbRes.ok) await notOk(dbRes, "create-db");
    const db: any = await dbRes.json();
    dbId = db.id;
    dbUrl = db.url;
  }

  // 4. Insert rows in reverse order so Notion's default "newest first" shows rank 1 at top
  for (const c of [...candidates].reverse()) {
    const allLinks = [
      c.handles?.github,
      c.handles?.portfolio,
      ...(c.handles ? [c.handles.twitter] : []),
      ...(c.handles?.links || []),
      ...(c.links || []),
    ]
      .filter((l): l is string => typeof l === "string" && l.startsWith("http"))
      .filter((v, i, a) => a.indexOf(v) === i);

    const rowRes = await fetch(`${baseUrl}/v1/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties: {
          Candidate:     { title: rt(`#${c.rank} ${c.name || "Unknown"} — ${c.score}/100`) },
          Comment:       { rich_text: rt([(c.comment || "").slice(0, 400), c.commentLink || ""].filter(Boolean).join("\n\n")) },
          Reason:        { rich_text: rt(c.reason || "—") },
          "Green Flags": { rich_text: rt((c.greenFlags || []).map((f) => `• ${f}`).join("\n\n") || "—") },
          "Red Flags":   { rich_text: rt((c.redFlags || []).map((f) => `• ${f}`).join("\n\n") || "—") },
          Email:         { email: c.email || null },
          Links:         { rich_text: rt(allLinks.join("\n\n") || "—") },
        },
        children: [
          { object: "block", type: "heading_3", heading_3: { rich_text: rt("Green Flags") } },
          ...flagBlocks(c.greenFlags),
          { object: "block", type: "paragraph", paragraph: { rich_text: rt("") } },
          { object: "block", type: "heading_3", heading_3: { rich_text: rt("Red Flags") } },
          ...flagBlocks(c.redFlags),
        ],
      }),
    });
    if (!rowRes.ok) await notOk(rowRes, `insert-row(${c.name})`);
  }

  return dbUrl || `https://notion.so/${(dbId as string).replace(/-/g, "")}`;
}
