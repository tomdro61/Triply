import { NextResponse } from "next/server";
import { getSitemapSegmentIds } from "@/lib/sitemap-config";

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://triplypro.com";
  const ids = await getSitemapSegmentIds();

  const sitemaps = ids
    .map(
      (id) =>
        `  <sitemap>\n    <loc>${baseUrl}/sitemap/${id}.xml</loc>\n  </sitemap>`
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemaps}
</sitemapindex>`;

  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
