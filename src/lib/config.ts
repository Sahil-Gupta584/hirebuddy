// Persist user inputs across sessions — stored in ~/.config/hirebuddy/config.json (or OS equivalent)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export type HirebuddyConfig = {
  geminiKey?: string;
  firecrawlKey?: string;
  rapidApiKey?: string;
  gmailToken?: string;
  notionToken?: string;
  notionParentPageId?: string;
  lastPostUrl?: string;
  lastEmail?: string;
  lastJd?: string;
};

function configPath(): string {
  const dir = join(homedir(), ".config", "hirebuddy");
  return join(dir, "config.json");
}

export function loadConfig(): HirebuddyConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return {};
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as HirebuddyConfig;
  } catch {
    return {};
  }
}

export function saveConfig(updates: Partial<HirebuddyConfig>): void {
  try {
    const current = loadConfig();
    const merged = { ...current, ...updates };
    // Remove empty strings
    for (const k of Object.keys(merged) as (keyof HirebuddyConfig)[]) {
      if (merged[k] === "" || merged[k] === undefined) delete merged[k];
    }
    const dir = dirname(configPath());
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath(), JSON.stringify(merged, null, 2));
  } catch {
    // fail silently — config is optional
  }
}

// Output dir: save alongside config in ~/.config/hirebuddy/output/ — consistent regardless of cwd
export function outputDir(): string {
  const dir = join(homedir(), ".config", "hirebuddy", "output");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
