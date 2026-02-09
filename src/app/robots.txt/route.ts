import { NextResponse } from "next/server";

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://triplypro.com";

  const robotsTxt = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin/
Disallow: /checkout/
Disallow: /confirmation/
Disallow: /account/
Disallow: /reservations/
Disallow: /auth/

Sitemap: ${baseUrl}/sitemap.xml

# AI Crawler Info
# See ${baseUrl}/llms.txt for structured information about this site
`;

  return new NextResponse(robotsTxt, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
