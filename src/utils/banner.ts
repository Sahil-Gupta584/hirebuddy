import c from "picocolors";

export function showBanner() {
  console.log(c.bold(c.cyan("hirebuddy")));
  console.log(c.dim("Rank candidates from X posts → Notion"));
  console.log();
}
