#!/usr/bin/env node
import { Command } from "commander";
import { showBanner } from "./utils/banner.js";
import { rankCommand } from "./commands/rank.js";

const program = new Command();

program
  .name("hirebuddy")
  .description("Premium CLI to evaluate hiring candidates from X posts + Gmail")
  .version("0.1.0")
  .option("--post <url>", "Social post link (x.com)")
  .option("--email <address>", "Work email to read applications (e.g., careers@firecrawl.com)")
  .option("--from <date>", "From date (dd Month year or YYYY-MM-DD)")
  .option("--to <date>", "To date (dd Month year)")
  .option("--gemini-key <key>", "Gemini API key")
  .option("--firecrawl-key <key>", "Firecrawl API key")
  .option("--notion-token <token>", "Notion token")
  .option("--x-token <token>", "X Bearer token (or leave empty for console gist)")
  .option("--reset-keys", "Forget saved keys and ask for all inputs again")
  .option("--jd <text>", "JD text (or path to file)")
  .option("--source <type>", 'Where are applications? "social" | "email"')
  .allowUnknownOption(false)
  .action(async (opts) => {
    showBanner();
    try {
      await rankCommand(opts);
    } catch (e: any) {
      console.error("\nFatal error:", e?.message || String(e));
      if (process.env.DEBUG) console.error(e);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
