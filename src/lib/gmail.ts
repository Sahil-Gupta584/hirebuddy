// Gmail + Drive - uses Arga Twin if env var set
// Set GMAIL_API_BASE_URL=https://gmail.run-xxx.twins.argalabs.com to use twin

export type EmailCandidate = {
  from: string;
  subject: string;
  body: string;
  attachments: Array<{ name: string; text: string }>;
};

export async function fetchEmails(opts: {
  gmailToken?: string;
  query?: string;
  max?: number;
}): Promise<EmailCandidate[]> {
  const baseUrl = process.env.GMAIL_API_BASE_URL || "https://gmail.googleapis.com";

  // Twin mode: no token needed, return mock for demo
  if (process.env.GMAIL_API_BASE_URL) {
    const res = await fetch(`${baseUrl}/gmail/v1/users/me/messages?q=${encodeURIComponent(opts.query || "hiring")}`);
    if (res.ok) {
      const data = await res.json();
      // Twin returns real shape; normalize below
      if (Array.isArray(data.messages)) {
        return data.messages.slice(0, opts.max ?? 20).map((m: any) => ({
          from: m.from ?? m.payload?.headers?.find((h: any) => h.name === "From")?.value ?? "candidate@example.com",
          subject: m.subject ?? "Application",
          body: m.snippet ?? m.body ?? "",
          attachments: [],
        }));
      }
    }
    // Fallback mock if twin empty
    return mockEmails(opts.max ?? 8);
  }

  if (!opts.gmailToken) {
    // No token but maybe Twin mock — already handled above; otherwise show hint
    return [];
  }

  // Real Gmail API (simplified)
  try {
    const list = await fetch(`${baseUrl}/gmail/v1/users/me/messages?q=${encodeURIComponent(opts.query || "hiring")}&maxResults=${opts.max ?? 20}`, {
      headers: { Authorization: `Bearer ${opts.gmailToken}` },
    });
    const data = await list.json();
    return (data.messages ?? []).slice(0, opts.max ?? 20).map((m: any) => ({
      from: m.from ?? "candidate@example.com",
      subject: m.subject ?? "",
      body: m.snippet ?? "",
      attachments: [],
    }));
  } catch {
    return [];
  }
}

function mockEmails(n: number): EmailCandidate[] {
  const names = ["Jane Doe", "Aman Singh", "Priya Patel", "Alex Chen", "Sara Kim", "Dev Mehta", "Riya Shah", "Omar L."];
  return Array.from({ length: n }, (_, i) => ({
    from: `${names[i % names.length].toLowerCase().replace(" ", ".")}${i}@example.com`,
    subject: `Application - Frontend Engineer ${i + 1}`,
    body: `Hi, I built ${["a design system", "a realtime dashboard", "an e-commerce app"][i % 3]} at ${["YC startup", "Razorpay", "Flipkart"][i % 3]}. Portfolio: https://example${i}.dev, GitHub: https://github.com/user${i}`,
    attachments: [{ name: "resume.pdf", text: `Resume of ${names[i % names.length]} - 4 years React, TypeScript, Tailwind` }],
  }));
}
