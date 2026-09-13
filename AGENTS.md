# hirebuddy — Agent Instructions

Premium CLI: Social post (X) + work email → Gemini scoring → JSON (or Notion).

## 0. Operating rules (non-negotiable)

1. **Understand before code.** Phase 1 = restate inputs, edge cases, auth walls, and what "done" looks like with a real example link. Ask 3–5 questions. No code until confirmed.
2. **NEVER silently mock.** No demo/fake candidates, no fake Notion links, no heuristic scores when a key exists. If real fetch fails, abort with the exact error.
3. **Probe before integrate.** No integration code without a pasted live response (`curl` output) for: X comments, Gmail/Graph, Firecrawl scrape, Gemini model.
4. **Validate keys immediately.** Gemini / tokens are tested on entry (`gemini-3.1-flash-lite:generateContent` smoke call). Invalid → loop, never continue.
5. **Done = real run, not build.** `npm run build` + full `hirebuddy` run with a real X link + real Gemini key + CSV/JSON output. Attach output, don't claim `tsc ✓`.

## 1. Stack & commands

- TS + `@clack/prompts` + `picocolors` + `cli-table3` (removed from output — summary only) + `commander` (bare `hirebuddy`, no subcommands) + `playwright` (optional browser) + `pdf-parse`.
- `npm run build` → `tsc`; `npm link` exposes `hirebuddy`; `npm run dev --` via `tsx src/cli.ts`.
- Never edit `dist/` manually. Ctrl+C must exit via `p.isCancel` → `p.cancel` → `process.exit(0)` on every prompt.

## 2. Known reality (update when it changes)

- **Gemini model:** `gemini-3.1-flash-lite` (`v1beta`). `2.0-flash-lite` is 404. Verify with smoke call before assuming.
- **Firecrawl:** keyless often blocked (`IP looks suspicious`) → require key or fallback. X scrape returns only `Top Comments` (1–10 of 160). Use for post caption + portfolios, NOT as comment source.
- **X comments:** only 2 paths — Bearer token (`/2/tweets/search/recent?query=conversation_id:ID`, needs `tweet.read`) OR headless browser scroll. Fxtwitter gives caption text only, no comments. Nitter is unreliable — don't use.
- **Browser:** `playwright`, `channel: "chrome"` first (uses system Chrome, no download), else bundled Chromium. Default headless = invisible; `SHOW_BROWSER=1` / `DEBUG=1` for visible + scroll logs + `hirebuddy-output/browser-debug.png`.
- **Email:** detect provider from domain MX via `dns.google` (`gmail` = Gmail/Workspace, `outlook` = Graph, else IMAP/forward-to-Gmail guide). Time range → Gmail `after:/before:`, Graph `receivedDateTime ge/le`. No hardcoded `q=hiring, max 20`.
- **JD:** `scrape → fxtwitter fallback → gemini-3.1-flash-lite extractJDFromPost → JD|null`. Prefill editable `initialValue`, never placeholder-only.
- **Scoring:** proof-of-work prompt → `{score,reason,extra,breakdown,greenFlags[5],redFlags[5],handles}`. Penalize claims without links/code. Per-candidate `try/catch`, keep error rows (`score 0 + redFlag`), never drop silently.
- **Output:** no terminal table. Summary + `hirebuddy-output/rank-*.json`. No CSV/MD.

## 3. UX conventions

- TanStack-style: `clack` prompts, dim `[why: ...]` / guides with full URLs (`https://aistudio.google.com/api-keys`, `https://firecrawl.dev/app/api-keys`), `spinner.start` → single `spinner.stop` (no repeated `.message` — spams MINGW).
- Required fields have no `?` in message. Guides live in the prompt desc, not a separate disconnected log.
- Keep only spam filter (`len<15`, bare emoji). Never pre-filter to zero silently — abort with actionable tip (provide Gmail / token).
