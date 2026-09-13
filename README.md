# hirebuddy

CLI to rank hiring applicants from an X post vs a Job Description — deep portfolio research, Gemini scoring, Notion output.

```bash
npx hirebuddy
```

## What it does

1. Fetches all replies to an X hiring post via RapidAPI
2. For each applicant — fetches X bio, classifies all linked URLs (portfolio vs resume vs profiles), deep-scrapes the portfolio site (all internal pages via Firecrawl map), shallow-scrapes everything else (Drive PDFs, LinkedIn, Behance, etc.)
3. Scores each candidate 0-100 with Gemini — proof-of-work focused, role-agnostic (works for any role, not just tech), green/red flags with source URLs
4. Pushes ranked table to Notion (or saves local JSON)

## Keys required

| Key | Where to get |
|-----|-------------|
| RapidAPI (`X-RapidAPI-Key`) | [rapidapi.com](https://rapidapi.com) → subscribe to [twitter-api45](https://rapidapi.com/alexanderxbx/api/twitter-api45) free plan → Apps tab |
| Gemini API key | [aistudio.google.com/api-keys](https://aistudio.google.com/api-keys) |
| Firecrawl key (`fc-...`) | [firecrawl.dev/app/api-keys](https://firecrawl.dev/app/api-keys) |
| Notion token (`ntn_...`) | [notion.so/profile/integrations](https://notion.so/profile/integrations) → New integration → copy secret |

All keys are saved to `~/.config/hirebuddy/config.json` after first entry. Use `--reset-keys` to re-enter them.

## Install

```bash
git clone https://github.com/Sahil-Gupta584/hirebuddy.git
cd hirebuddy
npm install
npm run build
npm link
```

## Usage

```bash
hirebuddy              # start wizard
hirebuddy --reset-keys # re-enter all saved keys
```

## Wizard flow

```
Step 1  X post URL         — the hiring post to fetch replies from
Step 2  Source             — X (more sources coming)
Step 3  RapidAPI key       — to fetch all replies
Step 4  Gemini key         — for scoring + JD extraction
Step 5  Firecrawl key      — to scrape portfolios
Step 6  Notion token       — to push ranked table (skip for local JSON)
Step 7  JD                 — auto-extracted from post caption, editable

→ For each applicant:
   1. Fetch X bio (fxtwitter, free)
   2. Classify URLs in comment + bio — portfolio root vs others (one Gemini call, also gates spam/memes)
   3. Deep-scrape portfolio (Firecrawl /map + scrape all internal pages, max 8)
   4. Shallow-scrape everything else (Drive PDF, LinkedIn, Behance, etc.)
   5. Score vs JD (Gemini, 0-100, proof-of-work, role-agnostic)

→ Push to Notion as ranked table or save local JSON
```

## Output

Notion database with columns: `Candidate (#rank name — score/100)` · `Comment` · `Reason` · `Green Flags` · `Red Flags` · `Email` · `Links`

Local JSON also always saved to `~/.config/hirebuddy/output/rank-<timestamp>.json`.

## Dev

```bash
npm run dev -- rank     # run without build
npm run build           # tsc → dist/
```
