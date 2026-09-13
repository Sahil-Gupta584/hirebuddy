// Browser fallback for X/LinkedIn comments — no API key needed
// Opens headless Chromium (or system Chrome), scrolls, scrapes all comments
// No global chromium install required if user has Chrome installed (uses channel: 'chrome')

export async function fetchCommentsViaBrowser(postUrl: string, opts?: { show?: boolean; debug?: boolean; useProfile?: boolean }): Promise<Array<{ author: string; text: string; link?: string }>> {
  const show = opts?.show || process.env.SHOW_BROWSER === "1" || process.env.DEBUG === "1";
  const debug = opts?.debug || show;
  const useProfile = opts?.useProfile ?? true; // use real profile by default so X shows comments (no "Log in" wall)
  let browser: any = null;
  let context: any = null;
  try {
    const { chromium } = await import("playwright");
    const { getDefaultBrowser, channelFor } = await import("./defaultBrowser.js");
    const def = getDefaultBrowser();
    const preferred = channelFor(def);
    if (debug) console.log(`[browser] Default browser: ${def}${preferred ? ` → channel: ${preferred}` : " (will try chrome→edge→bundled)"} | useProfile: ${useProfile}`);

    // 1) Prefer storageState if exists — this is the reliable way (see explanation below)
    const path = await import("node:path");
    const fs = await import("node:fs");
    const possibleStates = ["hirebuddy-storage.json", "storageState.json", path.join(process.cwd(), "hirebuddy-output", "storage.json")];
    let storageStatePath: string | undefined;
    for (const p of possibleStates) if (fs.existsSync(p)) { storageStatePath = p; break; }

    // 2) Use persistent context with real User Data when possible — otherwise new profile = "Log in" wall + only 2-3 comments (your screenshot)
    // WHY COOKIES WERE MISSING even though profile was correct:
    // - Cookies in Default/Network/Cookies are DPAPI-encrypted; key is in Local State at User Data root. Copying only Default/ misses the key → can't decrypt.
    // - Even with Local State, the Cookies file is locked while Edge is running (SingletonLock) and copy is truncated / stale.
    // - X also sets HttpOnly, Secure, SameSite=None cookies that headless copy often misses.
    // Fix: copy Default + Local State + Network as we now do, AND fallback to storageState if copy still fails.
    if (useProfile && !storageStatePath) {
      const os = await import("node:os");
      const fse = await import("node:fs/promises");
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      const candidates = [
        { channel: "msedge" as const, dir: path.join(localAppData, "Microsoft", "Edge", "User Data") },
        { channel: "chrome" as const, dir: path.join(localAppData, "Google", "Chrome", "User Data") },
      ];
      const ordered = preferred ? candidates.sort((a,b) => a.channel===preferred ? -1 : 1) : candidates;
      for (const c of ordered) {
        if (!fs.existsSync(c.dir)) continue;
        let tmpDir = path.join(os.tmpdir(), `hirebuddy-${c.channel}-profile`);
        try {
          if (fs.existsSync(tmpDir)) await fse.rm(tmpDir, { recursive: true, force: true }).catch(()=>{});
          await fse.mkdir(tmpDir, { recursive: true });
          const srcDefault = path.join(c.dir, "Default");
          const dstDefault = path.join(tmpDir, "Default");
          if (fs.existsSync(srcDefault)) {
            await fse.cp(srcDefault, dstDefault, { recursive: true, force: true }).catch(()=>{});
            const localStateSrc = path.join(c.dir, "Local State");
            const localStateDst = path.join(tmpDir, "Local State");
            if (fs.existsSync(localStateSrc)) await fse.copyFile(localStateSrc, localStateDst).catch(()=>{});
            const netSrc = path.join(c.dir, "Default", "Network");
            const netDst = path.join(tmpDir, "Default", "Network");
            if (fs.existsSync(netSrc)) await fse.cp(netSrc, netDst, { recursive: true, force: true }).catch(()=>{});
            if (debug) console.log(`[browser] Copied profile ${srcDefault} + Local State → ${tmpDir} to avoid lock`);
          } else {
            await fse.cp(c.dir, tmpDir, { recursive: true, force: true }).catch(()=>{});
          }
          context = await chromium.launchPersistentContext(tmpDir, {
            headless: !show,
            channel: c.channel,
            slowMo: show ? 300 : 0,
            args: ["--profile-directory=Default"],
          } as any);
          if (debug) console.log(`[browser] Launched persistent context via ${c.channel} at ${tmpDir} (real profile copy)`);
          break;
        } catch (e: any) {
          if (debug) console.log(`[browser] Persistent ${c.channel} failed: ${e.message?.slice(0,150)}`);
        }
      }
    }
    if (!context) {
      // Fallback: ephemeral context (new profile) — will show "Log in or sign up" and restrict to 2-3 comments
      const channels: (string | undefined)[] = preferred ? [preferred, preferred === "chrome" ? "msedge" : "chrome", undefined] : ["chrome", "msedge", undefined];
      let lastErr: any;
      for (const ch of channels) {
        try {
          browser = await chromium.launch({ headless: !show, ...(ch ? { channel: ch } : {}), slowMo: show ? 300 : 0 } as any);
          if (debug) console.log(`[browser] Launched ephemeral via ${ch || "bundled chromium"} (new profile — may show login wall)`);
          break;
        } catch (e) { lastErr = e; }
      }
      if (!browser) throw lastErr;
    }
    const page = context ? await context.newPage() : await browser.newPage({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 hirebuddy/0.1 Chrome/120 Safari/537.36" } as any);
    // Reduce automation fingerprint — X blocks headless via navigator.webdriver
    await page.addInitScript(() => { (Object as any).defineProperty(navigator, 'webdriver', { get: () => undefined }); }).catch(()=>{});

    // For X, try to use publish workaround or direct; set extra headers
    if (debug) console.log(`[browser] Navigating to ${postUrl}...`);
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    // Handle X login wall — X shows "See all the replies → Continue to X" when not logged in (your screenshot)
    // Temp-copied profile still appears logged-out because Cookies are DPAPI-encrypted + X detects automation (navigator.webdriver)
    await page.waitForTimeout(2500);
    await page.waitForLoadState("networkidle").catch(()=>{});
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // X renders "Continue to X" as button with span text, not always role=button
        const btn = page.locator('button:has-text("Continue to X"), [role="button"]:has-text("Continue to X"), text="Continue to X"').first();
        if (await btn.isVisible({ timeout: 2500 }).catch(() => false)) {
          if (debug) console.log(`[browser] Clicking 'Continue to X' (attempt ${attempt+1})`);
          await btn.click({ force: true });
          await page.waitForTimeout(3000);
          await page.waitForSelector('article', { timeout: 4000 }).catch(()=>{});
          // Scroll again after dismiss
          for (let k=0;k<3;k++) { await page.evaluate(()=>window.scrollBy(0,1200)); await page.waitForTimeout(800); }
          break;
        }
        const seeAll = page.locator('text="See all the replies"').first();
        if (await seeAll.isVisible({ timeout: 1000 }).catch(()=>false)) {
          if (debug) console.log("[browser] Saw 'See all the replies' wall — trying Continue");
          const b2 = page.locator('text="Continue to X"').first();
          if (await b2.isVisible({ timeout: 1000 }).catch(()=>false)) { await b2.click({force:true}); await page.waitForTimeout(3000); break; }
        }
      } catch {}
      await page.waitForTimeout(800);
    }
    try {
      // Dismiss cookie banners
      const accept = page.locator('text="Accept"').first();
      if (await accept.isVisible({ timeout: 1500 }).catch(() => false)) await accept.click().catch(() => {});
    } catch {}
    if (debug) console.log(`[browser] Loaded, title: ${await page.title()} — scrolling to load comments...`);

    // Scroll to load comments — X/LinkedIn lazy-load
    for (let i = 0; i < 8; i++) {
      try {
        await page.evaluate(() => window.scrollBy(0, 1400));
        await page.waitForTimeout(1200);
        if (debug) console.log(`[browser] Scroll ${i + 1}/8 — found ${await (page as any).$$eval('article', (els: any) => els.length).catch(()=>0)} articles`);
      } catch (e) { if (debug) console.log(`[browser] Scroll ${i+1} failed: ${String(e).slice(0,100)}`); break; }
    }
    if (debug) {
      await page.screenshot({ path: "hirebuddy-output/browser-debug.png", fullPage: true }).catch(() => {});
      console.log(`[browser] Screenshot saved to hirebuddy-output/browser-debug.png`);
      console.log(`[browser] Page URL after scroll: ${page.url()}`);
    }

    // Try multiple selectors
    const selectors = [
      // X
      '[data-testid="tweetText"]',
      'article [lang]',
      // LinkedIn
      '.comments-comment-item__main-content',
      '.feed-shared-update-v2__commentary',
      // Generic
      '[data-testid="tweet"]',
    ];

    const comments: Array<{ author: string; text: string; link?: string }> = [];
    for (const sel of selectors) {
      try {
        const els = await page.$$(sel);
        for (const el of els.slice(0, 50)) {
          const text = (await el.innerText()).trim().slice(0, 500);
          if (text.length < 20 || text.length > 500) continue;
          // Skip main post (usually first)
          if (comments.some(c => c.text === text)) continue;
          // Skip if it's the original post text (check via URL)
          const handle = (await el.evaluate((n: any) => n.closest('[data-testid="User-Name"]')?.innerText || n.closest('article')?.querySelector('a[href*="/status/"]')?.href || "user")).slice(0, 30);
          const link = text.match(/https?:\/\/\S+/)?.[0];
          comments.push({ author: handle || `user${comments.length + 1}`, text, link });
        }
        if (comments.length >= 8) break;
      } catch {}
    }

    // Also try to extract from page text via evaluate
    if (comments.length < 5) {
      const pageTexts: string[] = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('article')).slice(1, 40).map(a => (a as HTMLElement).innerText.slice(0, 600));
      });
      if (debug) console.log(`[browser] Fallback: ${pageTexts.length} article texts, e.g.: ${pageTexts[0]?.slice(0,80) || "none"}`);
      for (const t of pageTexts) {
        const clean = t.replace(/\s+/g, " ").trim().slice(0, 500);
        if (clean.length > 30 && clean.length < 500 && !comments.some(c => c.text === clean)) {
          comments.push({ author: "browser_user", text: clean, link: clean.match(/https?:\/\/\S+/)?.[0] });
        }
      }
    }

    if (debug) console.log(`[browser] Done — scraped ${comments.length} comments via selectors`);
    return comments.slice(0, 40);
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (msg.includes("Executable doesn't exist")) {
      throw new Error(`Browser not found. Fix: 1) if you have Chrome/Edge installed, it should auto-use it, or 2) run once: npx playwright install chromium (~150MB). Original: ${msg.slice(0,200)}`);
    }
    if (msg.includes("already running") || msg.includes("SingletonLock")) {
      throw new Error(`Browser profile locked — close Edge/Chrome completely and try again, or run: npx playwright install chromium to use isolated profile. Original: ${msg.slice(0,200)}`);
    }
    throw new Error(`Browser scrape failed: ${msg}`);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}
