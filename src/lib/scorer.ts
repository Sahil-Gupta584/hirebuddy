// Gemini scorer - 3.1 Flash Lite, proof-of-work aware
// Returns dynamic redFlags/greenFlags + handles

export type CandidateInput = {
  name: string;
  email: string;
  resumeText: string;
  portfolioText: string;
  portfolioPages?: { url: string; md: string }[];
  portfolioLinks?: string[];
  source: string;
  jd: string;
  xDetails?: { handle?: string; name?: string; bio?: string; location?: string; followers?: number; following?: number; website?: string };
};

export type ScoreResult = {
  score: number;
  reason: string;
  breakdown?: string;
  greenFlags: string[];
  redFlags: string[];
  handles: { github?: string; portfolio?: string; twitter?: string; links: string[] };
  resolvedName?: string;
  resolvedEmail?: string;
  llmRaw?: string; // raw Gemini response text, captured when DEBUG_SAVE enabled
};

function extractHandles(resume: string, portfolio: string): ScoreResult["handles"] {
  const combined = `${resume} ${portfolio}`;
  const urls = [...combined.matchAll(/https?:\/\/[^\s"')\]]+/g)].map(m => m[0].replace(/[.,)]+$/, ""));
  const github = urls.find(u => u.includes("github.com"));
  const twitter = urls.find(u => u.includes("x.com") || u.includes("twitter.com"));
  const portfolioUrl = urls.find(u => !u.includes("github.com") && !u.includes("x.com") && !u.includes("twitter.com"));
  return { github, portfolio: portfolioUrl, twitter, links: urls.slice(0, 5) };
}

export async function scoreCandidate(input: CandidateInput, geminiKey?: string): Promise<ScoreResult | null> {
  const handles = extractHandles(input.resumeText, input.portfolioText);

  if (!geminiKey) {
    const h = heuristicScore(input);
    return { ...h, greenFlags: [], redFlags: ["No Gemini key — heuristic score only"], handles };
  }

  try {
    const xUrl = input.xDetails?.handle ? `https://x.com/${String(input.xDetails.handle).replace(/^@/, "")}` : null;
    const systemPrompt = `You are a senior hiring manager doing DETAILED research. Score candidates vs the JD with PROOF OF WORK, not claims.

Rules:
- This tool scores ANY role (engineering, design, marketing, sales, ops, ...). Derive what "good" means from the JD — never assume a tech role.
- Green flags MUST be evidence-based from the profile details, portfolio pages, or extraContext below — not from handles. Frame them as proof of work / projects / works. Examples (dynamic, use only if evidence): "Proof of work: 4 shipped projects with live links", "Projects backed by client feedback with verifiable names", "Work history confirmed by public profile". Do NOT invent — if all details are "(no ...)" or empty, list NO green flag for that source.
- IMPORTANT: every [API]/[scraped] section carries its source URL. When a green flag uses evidence from one, APPEND that URL in parentheses at the end, e.g., "Proof of work: 4 shipped projects (https://candidate.dev/work)". If no URL for that claim, omit the link — not every flag needs one.
- Red flags MUST be specific and cite missing proof: e.g. "Portfolio empty / 404 — no proof of work", "Claims skill X but portfolio shows no work demonstrating it", "No portfolio/proof link at all", "Only 'Interested' — no experience evidence vs JD asks 3yr". Dynamic per candidate.
- Penalize skill lists without proof ("10 skills listed, zero demonstrated work" → red flag).
- Reward proof ("portfolio + public profiles show shipped work with live links").
- Score 0-100: 85+ hire, 70-84 strong maybe, 50-69 weak, <50 reject. No proof caps at ~55.
- Breakdown: pick 5 scoring dimensions FROM THE JD (e.g. design: craft, tools, experience, portfolio, communication — never force tech labels like "stack" on non-tech roles). Report each as name: X/20.
- For name/email: the display name is an unverified social handle — resolve the real name from GitHub / X / portfolio data below. Resolve email ONLY from the data below (portfolio, GitHub, X bio) — never invent one. If no email is found, return null. If no better name is found, keep the display handle.

Return JSON only, no markdown:
{
  "score": number,
  "reason": "1-line verdict vs JD (specific)",
  "breakdown": "single string of 5 JD-derived dimensions, format 'Dim1: X/20, Dim2: X/20, ...'",
  "greenFlags": ["3-5 bullets, dynamic, evidence-based"],
  "redFlags": ["2-4 bullets, dynamic"],
  "resolvedName": "single best real name (prefer GitHub/X/portfolio over the display handle)",
  "resolvedEmail": "best real email found in the data below, or null if none found (never invent)"
}`;

    const userPrompt = `Score this candidate vs the JD below. Every section is tagged with its origin ([recruiter-provided], [candidate-provided], [API: url], [scraped]) so you know what is verified vs self-claimed.

[recruiter-provided] JD:
"""
${input.jd}
"""

[candidate-provided] Candidate refers to self as: ${input.name}${input.email ? ` <${input.email}>` : " (no email provided — find it in the data below, or return null)"} (source: ${input.source}). Treat the name as an unverified display handle.

[candidate-provided] Comment / email body:
"""
${input.resumeText.slice(0, 5000)}
"""

[API${xUrl ? ": " + xUrl : " — no data"}] X profile (bio, location, website, followers):
"""
${input.xDetails ? JSON.stringify(input.xDetails, null, 2) : "(no X details — bio empty or not fetched)"}
"""

[scraped — source URL labeled on each page] All scraped pages (portfolio pages + Drive PDFs + work profiles + any other links from comment/bio — each labeled with source URL):
${(input.portfolioPages && input.portfolioPages.length > 0
  ? input.portfolioPages.map(p => `--- Source: ${p.url} ---\n${p.md.slice(0, 3000)}`).join("\n\n")
  : input.portfolioText
    ? input.portfolioText.slice(0, 8000)
    : "(no pages scraped — candidate provided no links or all links failed to scrape)"
)}`;

    // Retry with backoff for 429 — if 3.1 hits per-day limit, switch to 3.5 Flash Lite
    let res: Response | null = null;
    let lastErr = "";
    let model = "gemini-3.1-flash-lite";
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents: [{ parts: [{ text: userPrompt }] }], generationConfig: { temperature: 0.3 } }),
      });
      if (res.ok) break;
      lastErr = await res.text();
      const is429 = res.status === 429 || lastErr.includes("429") || lastErr.includes("Quota exceeded") || lastErr.includes("limit: 15") || lastErr.includes("per day");
      if (!is429) throw new Error(`Gemini API ${res.status}: ${lastErr.slice(0, 400)}`);
      if (model === "gemini-3.1-flash-lite" && lastErr.includes("generate_content_free_tier_requests") && attempt === 1) {
        // Per-day limit hit on 3.1 — switch to 3.5 as requested
        model = "gemini-3.5-flash-lite";
        // quick test new model works
        continue;
      }
      if (attempt === 4) throw new Error(`Gemini API ${res.status} (model ${model}): ${lastErr.slice(0, 400)}`);
      const waitMs = (attempt + 1) * 15000; // 15s, 30s, 45s — stay under 15/min
      await new Promise(r => setTimeout(r, waitMs));
    }
    if (!res) throw new Error(`Gemini API failed: ${lastErr.slice(0, 400)}`);

    const data = await res.json();
    if (data.error) throw new Error(`Gemini error: ${JSON.stringify(data.error).slice(0, 400)}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) throw new Error("Gemini returned empty response");

    const clean = text.replace(/```json|```/g, "").trim();
    const jsonStr = clean.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonStr) throw new Error(`Gemini returned non-JSON: ${clean.slice(0, 300)}`);

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e: any) {
      // Repair: model sometimes emits raw fractions like "Dim": 19/20 (invalid JSON) — quote them and retry
      try {
        parsed = JSON.parse(jsonStr.replace(/:\s*(\d+)\s*\/\s*(\d+)/g, ': "$1/$2"'));
      } catch {
        throw new Error(`Gemini JSON parse failed: ${e.message} — raw: ${jsonStr.slice(0, 300)}`);
      }
    }

    if (parsed.valid === false) return null; // safety net — classifyUrls should have caught this

    return {
      score: Math.max(0, Math.min(100, Number(parsed.score) || 50)),
      reason: String(parsed.reason || "No reason"),
      breakdown: String(parsed.breakdown || ""),
      greenFlags: Array.isArray(parsed.greenFlags) ? parsed.greenFlags.map(String).slice(0, 5) : [],
      redFlags: Array.isArray(parsed.redFlags) ? parsed.redFlags.map(String).slice(0, 5) : [],
      handles,
      resolvedName: parsed.resolvedName ? String(parsed.resolvedName) : undefined,
      resolvedEmail: parsed.resolvedEmail ? String(parsed.resolvedEmail) : undefined,
      llmRaw: text,
    };
  } catch (e: any) {
    const msg = e?.message || String(e);
    // Surface error visibly — will be caught by caller and shown via p.log.error
    throw new Error(`Scoring failed for ${input.name}: ${msg}`);
  }
}

function heuristicScore(input: CandidateInput): ScoreResult {
  const STOP = new Set("with,from,that,this,have,will,your,role,team,work,years,year,join,looking,help,skills,able,plus,and,for,the,are,you,our,who,can,all,hiring,apply".split(","));
  const jdTerms = [...new Set((input.jd.toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w)))].slice(0, 40);
  const t = `${input.resumeText} ${input.portfolioText}`.toLowerCase();
  const hits = jdTerms.filter(w => t.includes(w)).length;
  const ratio = jdTerms.length ? hits / jdTerms.length : 0;
  const hasLink = /https?:\/\//.test(t);
  let score = Math.round(25 + ratio * 45 + (hasLink ? 10 : 0));
  score = Math.min(85, Math.max(10, score));
  const reason = score > 70 ? "Good JD keyword overlap with proof link" : score > 50 ? "Partial JD overlap, needs depth check" : "Weak JD overlap, needs review";
  return { score, reason, greenFlags: [], redFlags: [], handles: extractHandles(input.resumeText, input.portfolioText) };
}
