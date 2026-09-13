import * as p from "@clack/prompts";
import c from "picocolors";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const DEBUG_SAVE = true; // toggle: save candidates.json + llm-responses.json to cwd after each run
import { fetchEmails } from "../lib/gmail.js";
import { scrapeUrl, extractJDFromPost, classifyUrls, mapPortfolio, scrapeUrlWithRetry } from "../lib/firecrawl.js";
import { fetchCommentsWithToken } from "../lib/socialToken.js";
import { fetchXCommentsRapidAPI } from "../lib/rapidXComments.js";
import { scoreCandidate } from "../lib/scorer.js";
import { pushToNotion, type RankedCandidate } from "../lib/notion.js";
import { detectEmailProvider, timeRangeToQuery } from "../lib/emailProvider.js";
import { loadConfig, saveConfig } from "../lib/config.js";

type RankOpts = {
  demo?: boolean;
  post?: string;
  email?: string;
  from?: string;
  to?: string;
  geminiKey?: string;
  firecrawlKey?: string;
  notionToken?: string;
  xToken?: string;
  rapidApiKey?: string;
  jd?: string;
  source?: "social" | "email" | "both";
  resetKeys?: boolean;
};



function detectProvider(url: string): "x" | null {
  if (!url) return null;
  if (url.includes("x.com") || url.includes("twitter.com")) return "x";
  return null;
}

function checkCancel(value: unknown) {
  if (p.isCancel(value)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }
}

function formatDDMonthYear(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
}
function parseDateInput(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  // Try dd Month year, yyyy-mm-dd, dd/mm/yyyy
  const d = new Date(t);
  if (!isNaN(d.getTime())) return d;
  return null;
}

export async function rankCommand(opts: RankOpts) {
  p.intro(c.bgCyan(c.black(" hirebuddy ")));

  // Load persisted config — prefill prompts (user can edit, saved again after)
  const cfg = loadConfig();

  // 0. Where are applications? — no unification (social OR email, not both)
  console.log(c.dim("── ") + c.bold(c.white("Step 1 · Source")) + c.dim(" ──"));
  const sourceChoice = (await p.select({
    message: `${c.white("Where are applications?")} ${c.dim("[pick one source]")}`,
    options: [
      { value: "social", label: "X post comments" },
      { value: "email", label: "Email inbox" },
    ],
    initialValue: "social",
  })) as unknown;
  checkCancel(sourceChoice);
  const wantSocial = sourceChoice === "social";
  const wantEmail = sourceChoice === "email";

  let postUrl = "";
  let provider: "x" | null = null;
  let socialToken: string | undefined;
  let rapidApiKey: string | undefined;

  if (wantSocial) {
    console.log(c.dim("── ") + c.bold(c.cyan("Step 2 · X post link")) + c.dim(" ──"));
    const postUrlRaw = (await p.text({
      message: `${c.cyan("Social post link?")} ${c.dim("(x.com)")}`,
      placeholder: "https://x.com/<username>/status/<post_id>",
      initialValue: cfg.lastPostUrl || undefined,
      validate: (v) => {
        if (!v) return "Social link is required for this source";
        if (!String(v).includes("x.com") && !String(v).includes("twitter.com"))
          return "Enter an X link";
      },
    })) as unknown;
    checkCancel(postUrlRaw);
    postUrl = postUrlRaw as string;
    saveConfig({ lastPostUrl: postUrl });
    provider = detectProvider(postUrl);
    if (!provider) {
      p.log.error(c.red("Only X posts are supported"));
      p.outro(c.red("Aborted"));
      process.exit(1);
    }
    // X comments — RapidAPI only — text prompt prefilled with saved key (visible, editable like JD)
    console.log(c.dim("── ") + c.bold(c.blue("Step 3 · RapidAPI key")) + c.dim(" ──"));
    p.note(
      `We need this to scrape all replies from the post — free tier is enough.\n1) Log in or sign up at https://rapidapi.com\n2) Visit https://rapidapi.com/alexanderxbx/api/twitter-api45/ → subscribe to free/basic plan \n3) Open https://rapidapi.com/alexanderxbx/api/twitter-api45/playground under the Apps tab → find "X-RapidAPI-Key" → copy it`,
      c.blue("Get a free key so we can scrape comments")
    );
    while (!rapidApiKey) {
      const rapidKeyRaw = await p.text({
        message: `${c.blue("RapidAPI key")} ${c.dim("[required — press Enter to keep saved]")}`,
        placeholder: "paste X-RapidAPI-Key",
        initialValue: opts.resetKeys ? undefined : cfg.rapidApiKey || undefined,
        validate: (v) => (!v || String(v).trim().length < 10) ? "RapidAPI key is required" : undefined,
      });
      checkCancel(rapidKeyRaw);
      const k = (rapidKeyRaw as string) || "";
      if (cfg.rapidApiKey && k === cfg.rapidApiKey && !opts.resetKeys) {
        p.log.info(c.dim("Using saved RapidAPI key ✓"));
        rapidApiKey = k;
        break;
      }
      const valSpin = p.spinner();
      valSpin.start("Validating RapidAPI key...");
      try {
        const r = await fetch("https://twitter-api45.p.rapidapi.com/trends.php?country=UnitedStates", {
          headers: { "X-RapidAPI-Key": k, "X-RapidAPI-Host": "twitter-api45.p.rapidapi.com" },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j: any = await r.json();
        if (!j.trends) throw new Error("Unexpected response — not a valid RapidAPI twitter-api45 key");
        valSpin.stop(c.green("RapidAPI key valid ✓"));
        rapidApiKey = k;
        saveConfig({ rapidApiKey: k });
      } catch (e: any) {
        valSpin.stop(c.red(`RapidAPI key invalid: ${e?.message?.slice(0,100)}`));
        p.log.error(c.red("Invalid key — get one at https://rapidapi.com/alexanderxbx/api/twitter-api45/"));
      }
    }
  }

  let gmailInput = "";
  let gmailToken: string | undefined;
  let timeRange = "last 7 days";
  let fromDate: Date | null = null;
  let toDate: Date | null = null;
  let emailMeta: { provider: string; timeRange: string; fromDate: Date | null; toDate: Date | null } = {
    provider: "gmail", timeRange: "last 7 days", fromDate: null, toDate: null,
  };

  if (wantEmail) {
    console.log(c.dim("── ") + c.bold(c.magenta("Step 4 · Email inbox")) + c.dim(" ──"));
    const gmailInputRaw = await p.text({
      message: `${c.magenta("Work email to read applications?")} ${c.dim("[e.g., careers@firecrawl.com]")}`,
      placeholder: "careers@firecrawl.com",
      validate: (v) => {
        if (!v) return "Email is required for this source";
        if (!String(v).includes("@")) return "Enter a valid email";
      },
    });
    checkCancel(gmailInputRaw);
    gmailInput = gmailInputRaw as string;

    const detectSpinner = p.spinner();
    detectSpinner.start(`Detecting provider for ${gmailInput}...`);
    const detected = await detectEmailProvider(gmailInput);
    detectSpinner.stop(`${c.dim(`Provider: ${detected.provider}`)}${detected.mx.length ? ` (${detected.mx[0].slice(0, 50)})` : ""}`);
    p.note(detected.guide, c.magenta(`How to get token for ${gmailInput}`));

    // From / To with dd Month year default for To = today
    const todayStr = formatDDMonthYear(new Date());
    const fromRaw = await p.text({
      message: `${c.magenta("From date?")} ${c.dim("[e.g., 01 September 2026 or 2025-09-01]")}`,
      placeholder: "01 September 2026",
      defaultValue: undefined,
    });
    checkCancel(fromRaw);
    const toRaw = await p.text({
      message: `${c.magenta("To date?")} ${c.dim(`[default: today ${todayStr}]`)}`,
      placeholder: todayStr,
      defaultValue: todayStr,
    });
    checkCancel(toRaw);
    const fromStr = (fromRaw as string) || "";
    const toStr = (toRaw as string) || todayStr;
    fromDate = parseDateInput(fromStr);
    toDate = parseDateInput(toStr) || new Date();
    if (fromDate && toDate) {
      timeRange = `${fromDate.toISOString().slice(0,10)} to ${toDate.toISOString().slice(0,10)}`;
    } else if (toDate) {
      // last 7 days fallback
      fromDate = new Date(toDate); fromDate.setDate(toDate.getDate()-7);
      timeRange = `${fromDate.toISOString().slice(0,10)} to ${toDate.toISOString().slice(0,10)}`;
    }

    const tokenLabel =
      detected.provider === "gmail"
        ? `${c.magenta("Gmail/Workspace token?")} ${c.dim("[paste access_token]")}`
        : detected.provider === "outlook"
          ? `${c.magenta("Outlook token?")} ${c.dim("[paste Graph access_token]")}`
          : `${c.magenta("Email token / app password?")} ${c.dim("[paste token]")}`;

    const gmailTokenRaw = await p.text({
      message: `${tokenLabel} ${c.dim("[press Enter to keep saved]")}`,
      placeholder: "paste token",
      initialValue: opts.resetKeys ? undefined : cfg.gmailToken || undefined,
    });
    checkCancel(gmailTokenRaw);
    const gtk = (gmailTokenRaw as string) || "";
    gmailToken = gtk === "" ? undefined : gtk;
    if (gmailToken) saveConfig({ gmailToken });
    if (gmailInput) saveConfig({ lastEmail: gmailInput });
    emailMeta = { provider: detected.provider, timeRange, fromDate, toDate };
  }

  if (!postUrl && !gmailInput) {
    p.log.error(c.red("No source selected"));
    p.outro(c.red("Aborted"));
    process.exit(1);
  }

  // 3. Gemini key — text prompt prefilled with saved key (visible, editable like JD)
  let geminiKey: string = "";
  console.log(c.dim("── ") + c.bold(c.green("Step 5 · Gemini key")) + c.dim(" ──"));
  p.note(
    `We need this to score candidates against the JD — free, no billing.\n1) Open https://aistudio.google.com/api-keys\n2) Click "Create API key" → copy it (starts AQ... or AIza...)\nFree tier: 15 req/min. If you hit the limit, hirebuddy waits and retries automatically.`,
    c.green("Get a free Gemini key so we can score candidates")
  );
  while (!geminiKey) {
    const geminiKeyRaw = await p.text({
      message: `${c.green("Gemini API key")} ${c.dim("[required — press Enter to keep saved]")}`,
      placeholder: "paste Gemini key",
      initialValue: opts.resetKeys ? undefined : cfg.geminiKey || undefined,
      validate: (v) => (!v || String(v).trim().length < 10 ? "Gemini API key is required" : undefined),
    });
    checkCancel(geminiKeyRaw);
    geminiKey = geminiKeyRaw as string;
    if (cfg.geminiKey && geminiKey === cfg.geminiKey && !opts.resetKeys) {
      p.log.info(c.dim("Using saved Gemini key ✓"));
      break;
    }
    const valSpin = p.spinner();
    valSpin.start("Validating Gemini key...");
    try {
      const testRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
      });
      const tdata: any = await testRes.json();
      if (!testRes.ok || tdata.error) throw new Error(tdata.error?.message || `HTTP ${testRes.status}`);
      if (!tdata.candidates?.[0]) throw new Error("Empty response");
      valSpin.stop(c.green("Gemini key valid ✓"));
      saveConfig({ geminiKey });
      break;
    } catch (e: any) {
      valSpin.stop(c.red(`Gemini key invalid: ${e?.message?.slice(0,120) || String(e).slice(0,120)}`));
      p.log.error(c.red("Invalid Gemini key — please paste a valid key from https://aistudio.google.com/api-keys"));
    }
  }

  // 4. Firecrawl key — text prompt prefilled with saved key (visible, editable like JD)
  let firecrawlKey = "";
  console.log(c.dim("── ") + c.bold(c.yellow("Step 6 · Firecrawl key")) + c.dim(" ──"));
  p.note(
    `We need this to scrape portfolios and GitHub pages for each candidate.\n1) Sign up at https://firecrawl.dev/app/api-keys\n2) Create a new API key (fc-...)\n3) Paste it below`,
    c.yellow("Get a free Firecrawl key so we can read portfolios")
  );
  while (!firecrawlKey) {
    const firecrawlKeyRaw = await p.text({
      message: `${c.yellow("Firecrawl API key")} ${c.dim("[required — press Enter to keep saved]")}`,
      placeholder: "paste Firecrawl key (fc-...)",
      initialValue: opts.resetKeys ? undefined : cfg.firecrawlKey || undefined,
      validate: (v) => (!v || String(v).trim().length < 10 ? "Firecrawl API key is required" : undefined),
    });
    checkCancel(firecrawlKeyRaw);
    firecrawlKey = (firecrawlKeyRaw as string) || "";
    if (!firecrawlKey) continue;
    if (cfg.firecrawlKey && firecrawlKey === cfg.firecrawlKey && !opts.resetKeys) {
      p.log.info(c.dim("Using saved Firecrawl key ✓"));
      break;
    }
    const fcSpin = p.spinner();
    fcSpin.start("Validating Firecrawl key...");
    try {
      const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { Authorization: `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com", formats: ["markdown"] }),
      });
      const j: any = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || `HTTP ${r.status}`);
      fcSpin.stop(c.green("Firecrawl key valid ✓"));
      saveConfig({ firecrawlKey });
      break;
    } catch (e: any) {
      fcSpin.stop(c.red(`Firecrawl key invalid: ${e?.message?.slice(0,100) || String(e).slice(0,100)}`));
      p.log.error(c.red("Invalid Firecrawl key — get one at https://firecrawl.dev/app/api-keys"));
      firecrawlKey = "";
    }
  }

  // 5. Notion token + parent page ID
  let notionToken = "";
  let notionParentPageId: string | undefined;
  console.log(c.dim("── ") + c.bold(c.red("Step 7 · Notion (optional)")) + c.dim(" ──"));
  let notionTokenRaw: string | symbol;
  while (true) {
    p.log.info(c.dim(`Get token: https://notion.so/profile/integrations → New integration (any name) → copy the Internal Integration Secret`));
    notionTokenRaw = await p.text({
      message: `${c.red("Notion token?")} ${c.dim("[provide to get research data in a sorted table — leave empty for JSON only]")}`,
      placeholder: "ntn_...",
      initialValue: opts.resetKeys ? undefined : cfg.notionToken || undefined,
    });
    checkCancel(notionTokenRaw);
    const candidate = (notionTokenRaw as string).trim();
    if (!candidate) { notionToken = ""; break; }
    // Validate immediately via GET /v1/users/me
    const valSpinner = p.spinner();
    valSpinner.start("Validating Notion token...");
    try {
      const vRes = await fetch("https://api.notion.com/v1/users/me", {
        headers: { Authorization: `Bearer ${candidate}`, "Notion-Version": "2022-06-28" },
      });
      if (vRes.ok) {
        const vData: any = await vRes.json();
        valSpinner.stop(c.green(`Notion token valid — bot: ${vData.name || vData.bot?.owner?.workspace_name || "ok"}`));
        notionToken = candidate;
        break;
      } else {
        const vData: any = await vRes.json().catch(() => ({}));
        valSpinner.stop(c.red(`Invalid Notion token (${vRes.status}: ${vData.message || "unauthorized"}) — try again or leave empty to skip`));
        opts.resetKeys = true;
      }
    } catch (e: any) {
      valSpinner.stop(c.red(`Notion validation error: ${e.message} — try again or leave empty`));
      opts.resetKeys = true;
    }
  }
  if (notionToken) {
    saveConfig({ notionToken });
    // Verify the saved page ID is accessible with this token before asking
    let pageIdVerified = false;
    if (!opts.resetKeys && cfg.notionParentPageId) {
      try {
        const chkRes = await fetch(`https://api.notion.com/v1/pages/${cfg.notionParentPageId}`, {
          headers: { Authorization: `Bearer ${notionToken}`, "Notion-Version": "2022-06-28" },
        });
        if (chkRes.ok) {
          notionParentPageId = cfg.notionParentPageId;
          pageIdVerified = true;
          p.log.info(c.dim(`Using saved page ID: ${notionParentPageId}`));
        }
      } catch {}
    }
    if (!pageIdVerified) {
      p.log.info(c.dim(`Create a new blank page in Notion → click ··· (top-right) → Connections → select your integration → then paste the page URL below`));
      const notionPageRaw = await p.text({
        message: `${c.red("Notion page URL or ID?")}`,
        placeholder: "https://notion.so/My-Page-abc123... or abc123...",
        initialValue: opts.resetKeys ? undefined : cfg.notionParentPageId || undefined,
        validate: (v) => (!v || String(v).trim().length < 10 ? "Page URL or ID required" : undefined),
      });
      checkCancel(notionPageRaw);
      const raw = (notionPageRaw as string).trim();
      const idMatch = raw.match(/\/p\/([a-f0-9]{32})/i) || raw.match(/([a-f0-9]{32})/i);
      notionParentPageId = idMatch ? idMatch[1] : raw.replace(/-/g, "");
      // Verify this page is accessible
      try {
        const chkRes = await fetch(`https://api.notion.com/v1/pages/${notionParentPageId}`, {
          headers: { Authorization: `Bearer ${notionToken}`, "Notion-Version": "2022-06-28" },
        });
        if (chkRes.ok) {
          p.log.info(c.green(`Page accessible ✓`));
        } else {
          p.log.warn(c.yellow(`Page not accessible (${chkRes.status}) — make sure you connected the integration via ··· → Connections`));
        }
      } catch {}
      saveConfig({ notionParentPageId });
    }
  }

  // 6. JD — LLM extraction from post caption (uses Gemini 3.1 Flash Lite, key asked above)
  let detectedJD = "";
  if (postUrl) {
    const spinner = p.spinner();
    spinner.start("Extracting JD from post via Gemini 3.1 Flash Lite...");
    try {
      let caption = "";
      const scraped = await scrapeUrl(postUrl, firecrawlKey);
      if (scraped?.markdown) caption = scraped.markdown;
      // Fallback for X when Firecrawl keyless fails (suspicious IP) → use free fxtwitter
      if (!caption && (postUrl.includes("x.com") || postUrl.includes("twitter.com"))) {
        try {
          const id = postUrl.match(/status\/(\d+)/)?.[1];
          if (id) {
            const fres = await fetch(`https://api.fxtwitter.com/status/${id}`);
            if (fres.ok) {
              const fdata: any = await fres.json();
              caption = fdata.tweet?.text || "";
            }
          }
        } catch {}
      }
      if (!caption) caption = postUrl; // last fallback: just URL (LLM will return null)
      const jdFromLLM = await extractJDFromPost(caption, geminiKey);
      if (jdFromLLM) {
        detectedJD = jdFromLLM;
        spinner.stop(`Detected JD in post: "${c.dim(detectedJD.slice(0, 80) + "...")}"`);
      } else {
        spinner.stop("No JD found in post — please paste JD");
      }
    } catch (e: any) {
      spinner.stop(`JD extraction failed: ${c.red(e?.message || String(e))} — please paste JD manually`);
    }
  }

  console.log(c.dim("── ") + c.bold(c.white("Step 8 · Job description")) + c.dim(" ──"));
  const jdMessage = detectedJD
    ? `${c.white("Paste JD / role expectations?")} ${c.dim(`[press Enter to use JD from post, or paste custom]`)}`
    : `${c.white("Paste JD / role expectations?")} ${c.dim("[what HR expects: stack, yoe, red flags]")}`;

  const jdRaw = await p.text({
    message: jdMessage,
    placeholder: "We need React + design system, 3yr+, TypeScript",
    initialValue: detectedJD || cfg.lastJd || undefined,
    validate: (v) => {
      const val = (v as string) || "";
      if (!val || val.length < 10) return "Paste at least 10 chars or press Enter to use post JD";
      return;
    },
  });
  checkCancel(jdRaw);
  const jd = ((jdRaw as string) || detectedJD) as string;
  saveConfig({ lastJd: jd });

  // --- Evaluation ---
  const s = p.spinner();
  s.start("Starting evaluation");

  // Fetch social comments — ONLY 2 options: token (API) or browser
  let socialCandidates: Array<{ author: string; text: string; link?: string }> = [];
  if (postUrl && provider) {
    // also log post caption via Firecrawl (for JD/context, not comments) — fallback to fxtwitter
    try {
      const postScrape = await scrapeUrl(postUrl, firecrawlKey);
      if (postScrape?.markdown) p.log.info(c.dim(`Post: "${postScrape.markdown.slice(0, 90).replace(/\n/g, " ")}..."`));
      else if (postUrl.includes("x.com")) {
        const id = postUrl.match(/status\/(\d+)/)?.[1];
        if (id) {
          const fres = await fetch(`https://api.fxtwitter.com/status/${id}`);
          if (fres.ok) { const j:any = await fres.json(); p.log.info(c.dim(`Post: "${(j.tweet?.text||"").slice(0,90).replace(/\n/g," ")}..."`)); }
        }
      }
    } catch {}

    // X comments via RapidAPI only
    if (rapidApiKey) {
      s.message("Fetching X comments via RapidAPI twitter-api45...");
      try {
        const fetched = await fetchXCommentsRapidAPI(postUrl, rapidApiKey);
        socialCandidates = fetched.map(f => ({ author: `${f.author} @${f.handle}`, text: f.text, link: f.link }));
        s.message(`Fetched ${socialCandidates.length} comments (t.co URLs resolved via entities)`);
      } catch (e: any) {
        p.log.error(c.red(`RapidAPI failed: ${e?.message || String(e)}`));
        p.outro(c.red("Aborted — RapidAPI key required. Get one at https://rapidapi.com/alexanderxbx/api/twitter-api45/"));
        process.exit(1);
      }
    }
  }

  // Fetch emails (with From/To + hiring filter like comments)
  let emailCandidates: Awaited<ReturnType<typeof fetchEmails>> = [];
  if (gmailInput) {
    const fromDate: Date | null = emailMeta.fromDate;
    const toDate: Date | null = emailMeta.toDate;
    let gmailQ = "hiring";
    if (fromDate && toDate) {
      const fmt = (d: Date) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
      gmailQ = `hiring after:${fmt(fromDate)} before:${fmt(toDate)}`;
    } else {
      const tr = timeRangeToQuery(emailMeta.timeRange || timeRange);
      gmailQ = `hiring ${tr.gmailQ}`;
    }
    s.message(`Fetching emails from ${gmailInput} (${gmailQ})...`);
    try {
      const fetched = await fetchEmails({ gmailToken, query: gmailQ, max: 50 });
      emailCandidates = fetched;
      s.message(`Fetched ${emailCandidates.length} hiring emails`);
    } catch (e: any) {
      p.log.error(c.red(`Email fetch failed for ${gmailInput}: ${e?.message || String(e)}`));
      p.log.info(c.dim("Tip: For custom emails, forward last 20 mails to a Gmail and use Gmail token, or use CSV upload"));
      emailCandidates = [];
    }
  }

  // No separate filter step — scoreCandidate returns null for non-applications (validity gate in system prompt)

  const totalRaw = socialCandidates.length + emailCandidates.length;
  s.message(`Deduping ${totalRaw} applications...`);
  if (totalRaw === 0) {
    s.stop(c.red("No applications found to rank"));
    p.log.error(c.red("No candidates after filtering — check that post has applicant comments with links, or provide Gmail"));
    p.outro(c.red("Aborted — no data"));
    process.exit(1);
  }

  // Normalize to unified list
  const unified: Array<{ name: string; handle?: string; email: string; resumeText: string; portfolioText: string; expandedUrls?: string[]; source: string }> = [];

  for (const sc of socialCandidates) {
    unified.push({
      name: sc.author,
      handle: (sc as any).handle || sc.author,
      email: "",
      resumeText: sc.text,
      portfolioText: "",
      expandedUrls: (sc as any).entities?.expandedUrls || [],
      source: provider ?? "social",
    });
  }
  for (const ec of emailCandidates) {
    unified.push({
      name: ec.from.split("@")[0].replace(".", " "),
      email: ec.from,
      resumeText: ec.body + " " + ec.attachments.map((a) => a.text).join(" "),
      portfolioText: ec.body.match(/https?:\/\/\S+/)?.[0] || "",
      source: "gmail",
    });
  }

  // Single per-candidate research loop: xBio → classify URLs → portfolio deep-scrape → others shallow → score
  const ranked: RankedCandidate[] = [];
  let evalErrors = 0;
  let filteredOut = 0;
  let lastScoreAt = 0;
  for (let i = 0; i < unified.length; i++) {
    const u = unified[i] as any;
    const tag = `${i + 1}/${unified.length} ${u.name}`;
    s.message(`Researching ${tag}...`);
    if (i > 0) await new Promise(r => setTimeout(r, 3000));

    // 1) Fetch X bio (fxtwitter, free, ~200ms) — needed before classify so model has context
    let xBio = "";
    let xWebsite = "";
    if (u.source === "x" || u.handle) {
      const handle = u.handle || u.name.split(" ")[0];
      try {
        const r = await fetch(`https://api.fxtwitter.com/${handle}`);
        if (r.ok) {
          const j: any = await r.json();
          const usr = j.user || j;
          xBio = (usr.description || usr.raw_description?.text || "").slice(0, 600);
          xWebsite = usr.website?.url || "";
          u.xDetails = {
            handle: usr.screen_name || handle,
            name: usr.name,
            bio: xBio,
            location: usr.location,
            followers: usr.followers,
            following: usr.following,
            website: xWebsite,
          };
        }
      } catch {}
    }

    // 2) Collect all URLs from comment expandedUrls + X bio website
    const commentUrls: string[] = u.expandedUrls || [];
    if (xWebsite) commentUrls.push(xWebsite);
    const allUrls = [...new Set([
      ...commentUrls,
      ...(u.resumeText.match(/https?:\/\/[^\s"')\]]+/g) || []),
    ])].filter(url => !url.includes("t.co") && !url.includes("x.com/") && !url.includes("twitter.com/"));

    // 3) Classify — one Gemini call decides which URL is portfolio root and which to shallow-scrape
    let portfolioRoot: string | null = null;
    let otherUrls: string[] = [];
    if (allUrls.length > 0) {
      try {
        const classified = await classifyUrls(u.resumeText, xBio, allUrls, geminiKey, jd);
        if (!classified.valid) {
          filteredOut++;
          s.message(`Skipped ${u.name} — not a genuine application`);
          continue;
        }
        portfolioRoot = classified.portfolio;
        otherUrls = classified.others;
      } catch {
        otherUrls = allUrls.slice(0, 4);
      }
    } else {
      // No URLs — still need validity check on comment text alone
      try {
        const classified = await classifyUrls(u.resumeText, xBio, [], geminiKey, jd);
        if (!classified.valid) {
          filteredOut++;
          s.message(`Skipped ${u.name} — not a genuine application`);
          continue;
        }
      } catch {}
    }

    // 4) Portfolio deep-scrape — map all internal pages of portfolio root
    const portfolioPages: { url: string; md: string }[] = [];
    if (portfolioRoot) {
      try {
        const pages = await mapPortfolio(portfolioRoot, firecrawlKey, 8);
        portfolioPages.push(...pages);
      } catch (e: any) {
        p.log.warn(c.yellow(`${tag} — portfolio map failed: ${e?.message?.slice(0, 80)}`));
      }
    }

    // 5) Others shallow-scrape — first page only of each remaining URL
    const otherPages: { url: string; md: string }[] = [];
    for (const url of otherUrls.slice(0, 4)) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const s2 = await scrapeUrlWithRetry(url, firecrawlKey);
        if (s2?.markdown) otherPages.push({ url, md: s2.markdown.slice(0, 3000) });
      } catch {}
    }

    // Combine all scraped pages for scorer
    const allPages = [...portfolioPages, ...otherPages];
    u.portfolioPages = allPages;
    u.portfolioText = allPages.map(p => `--- Source: ${p.url} ---\n${p.md}`).join("\n\n").slice(0, 12000);
    u.portfolioLinks = allUrls;

    // 3) Score — Gemini (throttled to stay under 15/min free tier)
    const sinceLastScore = Date.now() - lastScoreAt;
    if (lastScoreAt > 0 && sinceLastScore < 4000) await new Promise(r => setTimeout(r, 4000 - sinceLastScore));
    lastScoreAt = Date.now();
    try {
      const scored = await scoreCandidate(
        { name: u.name, email: u.email, resumeText: u.resumeText, portfolioText: u.portfolioText, portfolioLinks: u.portfolioLinks, portfolioPages: u.portfolioPages, source: u.source, jd, xDetails: u.xDetails },
        geminiKey
      );
      if (!scored) {
        filteredOut++;
        s.message(`Skipped ${u.name} — not a genuine application`);
        continue;
      }
      ranked.push({
        rank: 0,
        name: scored.resolvedName || u.name,
        email: scored.resolvedEmail || u.email,
        score: scored.score,
        reason: scored.reason,
        greenFlags: scored.greenFlags,
        redFlags: scored.redFlags,
        handles: scored.handles,
        links: scored.handles.links.length ? scored.handles.links : [u.portfolioText.slice(0, 60)].filter(Boolean) as any,
        source: u.source as any,
        comment: u.resumeText,
        commentLink: u.source === "x" ? `https://x.com/${u.handle || u.name}` : undefined,
        llmRaw: scored.llmRaw,
      });
    } catch (e: any) {
      const msg = e?.message || String(e);
      const is429 = msg.includes("429") || msg.includes("Quota exceeded");
      if (is429) {
        p.log.warn(c.yellow(`Quota hit at ${i+1}/${unified.length} — waiting 60s then retrying ${u.name}...`));
        await new Promise(r => setTimeout(r, 60000));
        try {
          const retryScored = await scoreCandidate(
        { name: u.name, email: u.email, resumeText: u.resumeText, portfolioText: u.portfolioText, portfolioLinks: u.portfolioLinks, portfolioPages: u.portfolioPages, source: u.source, jd, xDetails: u.xDetails },
            geminiKey
          );
          if (!retryScored) {
            filteredOut++;
            s.message(`Skipped ${u.name} on retry — not a genuine application`);
            continue;
          }
          ranked.push({
            rank: 0,
            name: retryScored.resolvedName || u.name,
            email: retryScored.resolvedEmail || u.email,
            score: retryScored.score,
            reason: retryScored.reason,
            greenFlags: retryScored.greenFlags,
            redFlags: retryScored.redFlags,
            handles: retryScored.handles,
            links: retryScored.handles.links.length ? retryScored.handles.links : [u.portfolioText.slice(0, 60)].filter(Boolean) as any,
            source: u.source as any,
            comment: u.resumeText,
            commentLink: u.source === "x" ? `https://x.com/${u.handle || u.name}` : undefined,
            llmRaw: retryScored.llmRaw,
          });
          s.message(`Retried & scored ${u.name} after quota wait`);
          continue;
        } catch (retryErr: any) {
          p.log.error(c.red(`Retry failed for ${u.name}: ${retryErr?.message?.slice(0,80) || String(retryErr).slice(0,80)} — marking as error`));
        }
      }
      evalErrors++;
      p.log.error(c.red(`Scoring failed for ${u.name} (${u.email}): ${msg}`));
      ranked.push({
        rank: 0,
        name: u.name,
        email: u.email,
        score: 0,
        reason: `Scoring error: ${msg.slice(0, 80)}`,
        greenFlags: [],
        redFlags: [`Scoring failed: ${msg.slice(0, 60)}`],
        handles: { links: [] },
        links: [],
        source: u.source as any,
      });
    }
  }
  if (evalErrors) p.log.warn(c.yellow(`${evalErrors} candidates had scoring errors`));
  if (filteredOut) p.log.info(c.dim(`Filtered ${filteredOut} candidates from ${unified.length} comments`));

  ranked.sort((a, b) => b.score - a.score);
  ranked.forEach((r, i) => (r.rank = i + 1));

  // if (DEBUG_SAVE) {
  //   const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  //   writeFileSync(join(process.cwd(), `candidates-${ts}.json`), JSON.stringify(ranked, null, 2));
  //   const llmResponses = ranked.map((r: any) => ({ name: r.name, score: r.score, llmRaw: (r as any).llmRaw }));
  //   writeFileSync(join(process.cwd(), `llm-responses-${ts}.json`), JSON.stringify(llmResponses, null, 2));
  // }

  s.stop(`Ranked ${ranked.length} candidates from ${unified.length} comments`);
  // No terminal table — results in JSON only (no CSV/MD per user request)
  p.log.success(c.green(`Ranked ${ranked.length} candidates — full report in JSON`));

  // Notion handoff — if no token, save local JSON and show path so user can open
  const notionSpinner = p.spinner();
  notionSpinner.start(notionToken ? "Pushing to Notion..." : "Saving local JSON...");
  try {
    const notionUrl = await pushToNotion(ranked, notionToken || undefined, notionParentPageId);
    if (notionToken) {
      notionSpinner.stop(`Notion ready → open: ${c.underline(c.cyan(notionUrl))}`);
      p.note(
        `For better view — click the ${c.bold("settings icon")} next to the ${c.bold(c.blue("New"))} button (top-right) → ${c.bold("Layout")} → toggle on ${c.bold("Wrap all content")}`,
        "Notion tip"
      );
    } else notionSpinner.stop(`Saved → open: ${c.underline(c.cyan(notionUrl))}`);
    p.outro(c.green("All done."));
  } catch (e: any) {
    notionSpinner.stop(c.red(`Save failed: ${e?.message?.slice(0,200) || String(e)}`));
    // Fallback: always save JSON locally even if Notion fails
    try {
      const { outputDir } = await import("../lib/config.js");
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const fallbackPath = join(outputDir(), `rank-${ts}.json`);
      writeFileSync(fallbackPath, JSON.stringify({ exportedAt: new Date().toISOString(), count: ranked.length, candidates: ranked }, null, 2));
      p.log.warn(c.yellow(`Notion failed — fallback saved locally: ${c.underline(c.cyan(fallbackPath))}`));
    } catch {}
    p.outro(c.yellow("Done with errors — see above for details."));
  }
}
