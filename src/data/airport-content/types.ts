import { SEOSection, FAQItem } from "@/lib/airport-page/content";

export interface AirportContent {
  /** ISO date (YYYY-MM-DD) this copy first went live. Article datePublished. */
  publishedOn: string;
  /**
   * ISO date of the last real edit to the words below. Drives Article
   * dateModified and the visible "Guide updated" line, so bump it when the
   * copy changes — never for a format/lint pass, and never to look fresh.
   * Not the sitemap lastModified: the page's live prices (title included)
   * change daily, and an old lastmod would slow the recrawl that picks them up.
   */
  updatedOn: string;
  /** Custom meta description (overrides template) */
  metaDescription: string;
  /** Custom SEO content sections */
  sections: SEOSection[];
  /** Custom FAQ Q&As */
  faqs: FAQItem[];
}
