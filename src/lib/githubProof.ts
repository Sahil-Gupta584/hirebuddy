// Fetch structured proof-of-work for a candidate — GitHub stats + portfolio project count
// Uses public GitHub API (no key, 60 req/hr). If 403, falls back to portfolio markdown only.

export type ProofOfWork = {
  github?: string;
  githubStats?: { username?: string; public_repos?: number; followers?: number; totalStars?: number; topRepos?: string[]; prs?: number };
  portfolioProjects?: number;
  hasPortfolioContent: boolean;
  summary: string; // short text for LLM
};

export async function fetchProofOfWork(portfolioText: string, handleLinks: string[]): Promise<ProofOfWork> {
  const githubUrl = handleLinks.find(u => u.includes("github.com")) || portfolioText.match(/https?:\/\/github\.com\/[^\s"')\]]+/)?.[0];
  let githubStats: ProofOfWork["githubStats"] | undefined;
  let summaryParts: string[] = [];

  const hasPortfolioContent = portfolioText.trim().length > 80 && !portfolioText.includes("(no portfolio");

  // Try GitHub API for username
  if (githubUrl) {
    const m = githubUrl.match(/github\.com\/([a-zA-Z0-9-]+)/);
    const username = m?.[1];
    if (username) {
      try {
        const userRes = await fetch(`https://api.github.com/users/${username}`, { headers: { "User-Agent": "hirebuddy/0.1" } });
        if (userRes.ok) {
          const u = await userRes.json();
          // Fetch repos to compute stars
          const reposRes = await fetch(`https://api.github.com/users/${username}/repos?per_page=100&sort=updated`, { headers: { "User-Agent": "hirebuddy/0.1" } });
          let totalStars = 0;
          let topRepos: string[] = [];
          if (reposRes.ok) {
            const repos: any[] = await reposRes.json();
            for (const r of repos) totalStars += r.stargazers_count || 0;
            topRepos = repos.slice(0, 3).map(r => `${r.name} (${r.stargazers_count}★)`);
          }
          githubStats = { username, public_repos: u.public_repos, followers: u.followers, totalStars, topRepos };
          summaryParts.push(`GitHub @${username}: ${u.public_repos} repos, ${totalStars} total stars, ${u.followers} followers${topRepos.length ? ` — top: ${topRepos.join(", ")}` : ""}`);
        }
      } catch {}
    }
  }

  // Portfolio project count heuristic from markdown (count ##, ###, or "Project")
  let portfolioProjects = 0;
  if (hasPortfolioContent) {
    const headings = (portfolioText.match(/^#{1,3}\s+.+/gm) || []).length;
    const projects = (portfolioText.match(/project/gi) || []).length;
    portfolioProjects = Math.min(10, Math.max(0, headings + Math.floor(projects / 3)));
    if (portfolioProjects) summaryParts.push(`Portfolio: ~${portfolioProjects} projects/sections detected`);
    else if (hasPortfolioContent) summaryParts.push("Portfolio: content present but no clear projects");
  } else {
    summaryParts.push("Portfolio: empty / no link — no proof");
  }

  if (summaryParts.length === 0) summaryParts.push("No proof of work provided");

  return {
    github: githubUrl,
    githubStats,
    portfolioProjects,
    hasPortfolioContent,
    summary: summaryParts.join(" | "),
  };
}
