# hirebuddy

AI agent that ranks job applicants from an X hiring post or email inbox — deep portfolio research, Gemini scoring, Notion output.

> **Demo video (2 min)**
> https://github.com/user-attachments/assets/9e4b1c93-a9ef-4645-91aa-2c3473d82bf9

```bash
npx hirebuddy
```

---

## 1. Project overview

Hiring from an X post is painful — 100+ replies, most with no links, some with broken ones, almost none read properly. hirebuddy is a CLI agent that automates the full pipeline:

1. **Fetches all replies** to an X hiring post via RapidAPI (`twitter-api45`)
2. **Resolves each applicant's real identity** — X bio via fxtwitter, expanded URLs (no broken t.co links)
3. **Classifies every URL** (one Gemini call per candidate: portfolio root vs resume vs profiles vs spam)
4. **Deep-scrapes the portfolio** — Firecrawl `/map` walks all internal pages (up to 8), not just the homepage
5. **Shallow-scrapes everything else** — Drive PDFs, LinkedIn, Behance, GitHub profile pages
6. **Scores 0–100 with Gemini** — proof-of-work focused, role-agnostic, green/red flags with source URLs
7. **Pushes a ranked table to Notion** (or saves local JSON)

Also supports **email inbox** as a source — detects Gmail vs Outlook from MX records, fetches hiring emails by date range, same scoring pipeline.

---

## 2. External apps used

| App | How it's used |
|-----|--------------|
| **X / Twitter** (via RapidAPI `twitter-api45`) | Fetches all thread replies to a hiring post — handles, text, and expanded URLs |
| **Firecrawl** | Deep-scrapes portfolio sites (all internal pages via `/map`) and shallow-scrapes Drive PDFs, LinkedIn, Behance, etc. |
| **Google Gemini** (`gemini-3.1-flash-lite`, `v1beta`) | Three calls per candidate: (1) classify URLs + spam gate, (2) extract JD from post caption, (3) score candidate 0–100 with proof-of-work reasoning |
| **Notion** | Creates/updates a ranked database with green flags, red flags, links, and score for each candidate |
| **fxtwitter** (free, keyless) | Resolves X handles → bio, website, follower count — used as context for scoring |
| **Gmail API** *(email source)* | Reads hiring emails by date range when email inbox is selected as source |

---

## 3. Setup instructions

### Keys required

| Key | Where to get |
|-----|-------------|
| RapidAPI (`X-RapidAPI-Key`) | [rapidapi.com](https://rapidapi.com) → subscribe to [twitter-api45](https://rapidapi.com/alexanderxbx/api/twitter-api45) free plan |
| Gemini API key | [aistudio.google.com/api-keys](https://aistudio.google.com/api-keys) — free, no billing |
| Firecrawl key (`fc-...`) | [firecrawl.dev/app/api-keys](https://firecrawl.dev/app/api-keys) |
| Notion token (`ntn_...`) | [notion.so/profile/integrations](https://notion.so/profile/integrations) → New integration → copy secret |

All keys are validated on entry and saved to `~/.config/hirebuddy/config.json`. Use `--reset-keys` to re-enter them.

### Install

```bash
git clone https://github.com/Sahil-Gupta584/hirebuddy.git
cd hirebuddy
npm install
npm run build
npm link
```

### Run

```bash
hirebuddy              # interactive wizard
hirebuddy --reset-keys # re-enter all saved keys
```

### Wizard steps

```
Step 1  Source             — X post comments or email inbox
Step 2  X post URL         — the hiring post to process
Step 3  RapidAPI key       — validated live before continuing
Step 4  Gemini key         — validated live (smoke call) before continuing
Step 5  Firecrawl key      — validated live before continuing
Step 6  Notion token       — optional; skip for local JSON
Step 7  JD                 — auto-extracted from post caption via Gemini, editable

→ Per candidate:
   1. Fetch X bio + website (fxtwitter, free)
   2. Classify URLs — portfolio root vs others, spam gate (Gemini)
   3. Deep-scrape portfolio (Firecrawl /map + all internal pages, max 8)
   4. Shallow-scrape everything else (Drive PDF, LinkedIn, Behance, etc.)
   5. Score vs JD (Gemini, 0–100, proof-of-work, role-agnostic)

→ Push to Notion ranked table or save local JSON
```

---

## 4. Reliability & evaluation

### Live run — 22 candidates ranked (Sept 12, 2026)

Real X hiring post for a frontend intern role. All keys live, no mocks.

```
#1  Vansh Mehta          78/100  — Voice AI SaaS shipped for Tata Motors; React/TS/Next.js stack match
#2  Sujal Charati        78/100  — 3 live apps, 52 GitHub repos, frontend internships verified
#3  Saad Shaikh          68/100  — Full-stack Next.js + Tailwind, 51 repos, no design system evidence
#4  Raghvendra Dwivedi   62/100  — 108 GitHub repos, real-time WebSocket work, content-heavy history
#5  Singampalli Mahesh   55/100  — 8.87 CGPA, but 2nd/3rd year vs JD requirement of 4th year
...
#22 Mohit Maulekhi       10/100  — "Check dm" only, profile mismatch, no portfolio
```

Full output: [`hirebuddy-output/rank-2026-09-12-11-38-42.json`](hirebuddy-output/rank-2026-09-12-11-38-42.json)

### How correctness was verified

- **Green flags cite source URLs** — e.g. `"Proof of work: 4 shipped projects (https://mvansh.com)"`. Every claim is traceable to a scraped page or API response, not hallucinated.
- **Red flags are specific** — e.g. `"Portfolio project shows 0 papers found/loading state — poor production-grade reliability"`. Not generic.
- **Spam filtered correctly** — 22 genuine applications surfaced from the full reply thread; memes, "check DM" replies, and identity mismatches flagged with score ≤15 and a specific red flag explaining why.
- **No silent drops** — every candidate that errored during scoring gets a row with `score: 0` and a red flag showing the exact error message.
- **Key validation gates** — RapidAPI, Gemini, and Firecrawl keys are each tested with a live API call before the run starts. Invalid key = hard stop with the exact error, not a silent failure mid-run.
- **Gemini quota handling** — 429 triggers a 60s wait + retry. If the per-day free tier limit is hit, falls back to `gemini-2.0-flash-lite` automatically.

### Scoring consistency

The Gemini prompt uses `temperature: 0.3` and a structured system prompt that forces:
- 5 JD-derived scoring dimensions (not hardcoded — derived from what the JD actually asks for)
- Evidence-backed flags only (model is instructed to write no green flag if no evidence exists)
- A single JSON schema — parse errors trigger a JSON-repair pass before failing

---

## 5. Demo video

https://github.com/user-attachments/assets/9e4b1c93-a9ef-4645-91aa-2c3473d82bf9

---

## Output

**Notion:** ranked database — `Candidate (#rank name — score/100)` · `Comment` · `Reason` · `Green Flags` · `Red Flags` · `Email` · `Links`

**Local JSON:** always saved to `~/.config/hirebuddy/output/rank-<timestamp>.json` (even when Notion is used)

---

## Dev

```bash
npm run dev --   # run without build (tsx)
npm run build    # tsc → dist/
```
