import { NextResponse } from "next/server";

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://triplypro.com";

  const disallowRules = `Disallow: /api/
Disallow: /admin/
Disallow: /checkout/
Disallow: /confirmation/
Disallow: /account/
Disallow: /reservations/
Disallow: /auth/`;

  const robotsTxt = `User-agent: *
Allow: /
${disallowRules}

# AI Search Crawlers — explicitly welcomed
User-agent: OAI-SearchBot
Allow: /
${disallowRules}

User-agent: ClaudeBot
Allow: /
${disallowRules}

User-agent: PerplexityBot
Allow: /
${disallowRules}

User-agent: GoogleOther
Allow: /
${disallowRules}

User-agent: Amazonbot
Allow: /
${disallowRules}

Sitemap: ${baseUrl}/sitemap.xml

# See ${baseUrl}/llms.txt for structured information about this site
`;

  return new NextResponse(robotsTxt, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
